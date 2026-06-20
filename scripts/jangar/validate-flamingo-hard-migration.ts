import { readFile } from 'node:fs/promises'

export const requiredTerms = ['unsloth/Qwen3.6-35B-A3B-NVFP4', 'qwen36-flamingo', 'qwen3', 'qwen3_coder']

export const forbiddenTerms = [
  'Qwen/Qwen3-Coder-Next-FP8',
  'Qwen/Qwen3-Coder-30B-A3B-Instruct',
  'qwen3-coder-flamingo',
  'hermes',
  'qwen3_xml',
]

export const targetFiles = [
  'argocd/applications/flamingo/deployment.yaml',
  'argocd/applications/flamingo/README.md',
  'argocd/applications/flamingo/docs/large-model-multigpu.md',
  'argocd/applications/agents/anypi-agentprovider.yaml',
  'argocd/applications/agents/anypi-eval-agentprovider.yaml',
  'argocd/applications/jangar/openwebui-values.yaml',
  'docs/agents/anypi.md',
  'docs/jangar/pi-agent-flamingo-host-configuration.md',
  'docs/jangar/saigak-to-flamingo-gpu-pod-migration.md',
  'scripts/jangar/validate-pi-flamingo-compaction.ts',
  'services/anypi/src/config.ts',
  'services/anypi/src/config.test.ts',
]

export async function validateFiles(paths: string[], required: string[], forbidden: string[]): Promise<string[]> {
  const contents = await Promise.all(paths.map((f) => readFile(f, 'utf8')))
  const combined = contents.join('\n')
  const failures: string[] = []

  for (let i = 0; i < paths.length; i++) {
    const file = paths[i]
    const content = contents[i]
    for (const term of forbidden) {
      if (content.includes(term)) {
        failures.push(`${file}: still contains forbidden Flamingo migration term "${term}"`)
      }
    }
  }

  for (const term of required) {
    if (!combined.includes(term)) {
      failures.push(`active Flamingo surfaces do not contain required term "${term}"`)
    }
  }

  return failures
}

async function main(): Promise<void> {
  const failures = await validateFiles(targetFiles, requiredTerms, forbiddenTerms)
  if (failures.length > 0) {
    console.error(failures.join('\n'))
    process.exit(1)
  }
  console.log(`validated ${targetFiles.length} Flamingo hard-migration surfaces`)
}

if (import.meta.main) {
  await main()
}
