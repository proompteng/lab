import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dump } from 'js-yaml'
import { z } from 'zod'

const secretSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  data: z.record(z.string(), z.string()),
})

type SecretInput = z.infer<typeof secretSchema>

export interface SealedSecret {
  apiVersion: string
  kind: string
  metadata: {
    name: string
    namespace: string
  }
  spec: {
    encryptedData: Record<string, string>
    template: {
      type: string
    }
  }
}

export function generatePlainSecret(input: SecretInput): string {
  const plainSecret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: input.name,
      namespace: input.namespace,
    },
    type: 'Opaque',
    data: Object.fromEntries(
      Object.entries(input.data).map(([key, value]) => [key, Buffer.from(value).toString('base64')]),
    ),
  }
  return dump(plainSecret)
}

export function sealSecret(
  plainSecretYaml: string,
  controllerName = 'sealed-secrets-controller',
  controllerNamespace = 'kube-system',
): string {
  try {
    console.log(`Using controller: ${controllerName} in namespace: ${controllerNamespace}`)
    const sealedSecretBuffer = execSync(
      `kubeseal --format yaml --controller-name=${controllerName} --controller-namespace=${controllerNamespace}`,
      { input: plainSecretYaml },
    )
    return sealedSecretBuffer.toString()
  } catch (error) {
    throw new Error(`kubeseal command failed: ${error}`)
  }
}

export function saveSealedSecret(sealedSecretYaml: string, filename: string, outputDir = 'dist'): string {
  // Ensure the output directory exists
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true })
  }

  const filePath = join(outputDir, filename)
  writeFileSync(filePath, sealedSecretYaml)
  console.log(`Sealed secret saved to: ${filePath}`)
  return filePath
}

if (require.main === module) {
  const input: SecretInput = {
    name: '',
    namespace: '',
    data: {},
  }

  try {
    const plainSecretYaml = generatePlainSecret(input)
    console.log('Plain Secret YAML:\n', plainSecretYaml)
    const sealedSecretYaml = sealSecret(plainSecretYaml, 'sealed-secrets', 'sealed-secrets')
    console.log('Sealed Secret YAML:\n', sealedSecretYaml)

    // Save the sealed secret to a file
    const filename = `${input.name}-${input.namespace}.yaml`
    saveSealedSecret(sealedSecretYaml, filename)
  } catch (error) {
    console.error('Failed to generate secrets:', error)
    process.exit(1)
  }
}
