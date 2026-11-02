#!/usr/bin/env bun

import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { $ } from 'bun'

type CliOptions = {
  minioOutput?: string
  observabilityOutput?: string
  controllerName?: string
  controllerNamespace?: string
  keepTemp?: boolean
  printValues?: boolean
}

const fatal = (message: string, error?: unknown): never => {
  if (error instanceof Error) {
    console.error(`${message}\n${error.message}`)
  } else if (error) {
    console.error(`${message}\n${error}`)
  } else {
    console.error(message)
  }
  process.exit(1)
}

const repoRoot = resolve(import.meta.dir, '..')
const defaultMinioOutput = resolve(repoRoot, 'argocd/applications/minio/observability-minio-secret.yaml')
const defaultObservabilityOutput = resolve(repoRoot, 'argocd/applications/observability/minio-secret.yaml')

const printUsage = (): never => {
  console.log(`Usage: bun run scripts/generate-observability-minio-secrets.ts [options]

Options:
  --minio-output <path>          Override output path for observability-minio-secret.yaml.
  --observability-output <path>  Override output path for observability/minio-secret.yaml.
  --controller-name <name>       Sealed Secrets controller name (default: sealed-secrets).
  --controller-namespace <ns>    Sealed Secrets controller namespace (default: sealed-secrets).
  --keep-temp                    Do not delete temporary files (for debugging).
  --print-values                 Echo generated credentials to stdout (handle with care).
  --help                         Show this help message.
`)
  process.exit(0)
}

const parseArgs = (): CliOptions => {
  const options: CliOptions = {}
  const args = process.argv.slice(2)

  for (let i = 0; i < args.length; i += 1) {
    const raw = args[i]
    if (!raw) continue

    if (raw === '--help' || raw === '-h') {
      printUsage()
    }

    const hasValue = raw.startsWith('--')
    const [flag, inline] = hasValue ? raw.split('=') : [raw, undefined]

    const nextValue = (): string => {
      if (inline !== undefined) return inline
      const value = args[i + 1]
      if (!value || value.startsWith('-')) {
        fatal(`Flag '${flag}' requires a value`)
      }
      i += 1
      return value
    }

    switch (flag) {
      case '--minio-output':
        options.minioOutput = nextValue()
        break
      case '--observability-output':
        options.observabilityOutput = nextValue()
        break
      case '--controller-name':
        options.controllerName = nextValue()
        break
      case '--controller-namespace':
        options.controllerNamespace = nextValue()
        break
      case '--keep-temp':
        options.keepTemp = true
        break
      case '--print-values':
        options.printValues = true
        break
      default:
        if (flag.startsWith('-')) {
          fatal(`Unknown flag '${flag}'. Use --help for usage.`)
        } else {
          fatal(`Unexpected argument '${flag}'. Use --help for usage.`)
        }
    }
  }

  return options
}

const ensureCli = (binary: string) => {
  if (!Bun.which(binary)) {
    fatal(`Required CLI '${binary}' is not available in PATH`)
  }
}

const randomString = (length: number, alphabet: string) => {
  const bytes = randomBytes(length * 2)
  const chars = []
  const base = alphabet.length
  for (let i = 0; chars.length < length && i < bytes.length; i += 1) {
    const idx = bytes[i] % base
    chars.push(alphabet[idx])
  }
  if (chars.length < length) {
    return chars.join('') + randomString(length - chars.length, alphabet)
  }
  return chars.join('')
}

const alphaUpper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const _alphaNumUpper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const accessKeyAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const secretKeyAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

const indentBlock = (value: string, spaces: number) => {
  const padding = ' '.repeat(spaces)
  return value
    .split('\n')
    .map((line) => (line.length ? `${padding}${line}` : ''))
    .join('\n')
}

const reflectorAnnotations = `  annotations:
    reflector.v1.k8s.emberstack.com/reflection-allowed: "true"
    reflector.v1.k8s.emberstack.com/reflection-allowed-namespaces: "argo-workflows,graf,flink,torghut,observability"
    reflector.v1.k8s.emberstack.com/reflection-auto-enabled: "true"
    reflector.v1.k8s.emberstack.com/reflection-auto-namespaces: "argo-workflows,graf,flink,torghut,observability"`

const options = parseArgs()

ensureCli('kubeseal')

const controllerName = options.controllerName ?? process.env.SEALED_SECRETS_CONTROLLER_NAME ?? 'sealed-secrets'
const controllerNamespace =
  options.controllerNamespace ?? process.env.SEALED_SECRETS_CONTROLLER_NAMESPACE ?? 'sealed-secrets'

const minioOutputPath = resolve(options.minioOutput ?? defaultMinioOutput)
const observabilityOutputPath = resolve(options.observabilityOutput ?? defaultObservabilityOutput)

const rootUser = randomString(16, alphaUpper)
const rootPassword = randomString(32, secretKeyAlphabet)

const lokiAccessKey = randomString(20, accessKeyAlphabet)
const lokiSecretKey = randomString(40, secretKeyAlphabet)

const tempoAccessKey = randomString(20, accessKeyAlphabet)
const tempoSecretKey = randomString(40, secretKeyAlphabet)

const mimirAccessKey = randomString(20, accessKeyAlphabet)
const mimirSecretKey = randomString(40, secretKeyAlphabet)

const configEnvLines = [`export MINIO_ROOT_USER=${rootUser}`, `export MINIO_ROOT_PASSWORD=${rootPassword}`]

const configEnv = `${configEnvLines.join('\n')}\n`

const minioSecretManifest = `apiVersion: v1
kind: Secret
metadata:
  name: observability-minio-creds
  namespace: minio
${reflectorAnnotations}
stringData:
  config.env: |
${indentBlock(configEnv, 4)}
  accesskey: ${rootUser}
  secretkey: ${rootPassword}
type: Opaque
`

const observabilitySecretManifest = `apiVersion: v1
kind: Secret
metadata:
  name: observability-minio-credentials
  namespace: observability
${reflectorAnnotations}
stringData:
  rootUser: ${rootUser}
  rootPassword: ${rootPassword}
  lokiAccessKey: ${lokiAccessKey}
  lokiSecretKey: ${lokiSecretKey}
  tempoAccessKey: ${tempoAccessKey}
  tempoSecretKey: ${tempoSecretKey}
  mimirAccessKey: ${mimirAccessKey}
  mimirSecretKey: ${mimirSecretKey}
type: Opaque
`

const shellEscape = (value: string) => value.replaceAll("'", "'\\''")
const quote = (value: string) => `'${shellEscape(value)}'`

const sealSecret = async (manifest: string, name: string, namespace: string) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'observability-minio-secret-'))
  const manifestPath = join(tempDir, 'secret.yaml')

  try {
    writeFileSync(manifestPath, manifest)
  } catch (error) {
    fatal('Failed to write temporary manifest for kubeseal', error)
  }

  const baseCommand = [
    'kubeseal',
    '--name',
    quote(name),
    '--namespace',
    quote(namespace),
    '--controller-name',
    quote(controllerName),
    '--controller-namespace',
    quote(controllerNamespace),
    '--format',
    'yaml',
  ].join(' ')

  const command = `${baseCommand} < ${quote(manifestPath)}`

  try {
    const sealed = await $`bash -lc ${command}`.text()
    return sealed.startsWith('---') ? sealed : `---\n${sealed}`
  } catch (error) {
    fatal('Failed to seal secret with kubeseal', error)
  } finally {
    if (!options.keepTemp) {
      try {
        rmSync(manifestPath, { force: true })
        rmSync(tempDir, { recursive: true, force: true })
      } catch {}
    }
  }
}

const sealedMinioSecret = await sealSecret(minioSecretManifest, 'observability-minio-creds', 'minio')
const sealedObservabilitySecret = await sealSecret(
  observabilitySecretManifest,
  'observability-minio-credentials',
  'observability',
)

const writeSealedSecret = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, { mode: 0o600 })
  chmodSync(path, 0o600)
  console.log(`SealedSecret written to ${path}`)
}

writeSealedSecret(minioOutputPath, sealedMinioSecret)
writeSealedSecret(observabilityOutputPath, sealedObservabilitySecret)

if (options.printValues) {
  console.log('\nGenerated credentials (treat as sensitive):')
  console.log(`  MINIO_ROOT_USER=${rootUser}`)
  console.log(`  MINIO_ROOT_PASSWORD=${rootPassword}`)
  console.log(`  LOKI_ACCESS_KEY=${lokiAccessKey}`)
  console.log(`  LOKI_SECRET_KEY=${lokiSecretKey}`)
  console.log(`  TEMPO_ACCESS_KEY=${tempoAccessKey}`)
  console.log(`  TEMPO_SECRET_KEY=${tempoSecretKey}`)
  console.log(`  MIMIR_ACCESS_KEY=${mimirAccessKey}`)
  console.log(`  MIMIR_SECRET_KEY=${mimirSecretKey}`)
} else {
  console.log('Generation complete. Re-run with --print-values to display the generated credentials if needed.')
}
