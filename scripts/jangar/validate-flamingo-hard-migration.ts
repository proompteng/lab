import { readFile } from 'node:fs/promises'

const REQUIRED_TERMS = ['unsloth/Qwen3.6-35B-A3B-NVFP4', 'qwen36-flamingo', 'qwen3', 'qwen3_coder'] as const

const FORBIDDEN_TERMS = [
  'Qwen/Qwen3-Coder-Next-FP8',
  'qwen3-coder-flamingo',
  'Qwen/Qwen3-Coder-30B-A3B-Instruct',
  'hermes',
] as const

const TARGET_FILES = [
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
] as const

export type ValidationFailure = {
  file: string
  message: string
}

export function validateForbiddenTerms(fileContents: ReadonlyArray<[string, string]>): ValidationFailure[] {
  const failures: ValidationFailure[] = []

  for (let fileIndex = 0; fileIndex < fileContents.length; fileIndex++) {
    const file = fileContents[fileIndex][0]
    const content = fileContents[fileIndex][1]

    for (let termIndex = 0; termIndex < FORBIDDEN_TERMS.length; termIndex++) {
      const term = FORBIDDEN_TERMS[termIndex]
      if (content.includes(term)) {
        failures.push({
          file,
          message: `still contains forbidden Flamingo migration term "${term}"`,
        })
      }
    }
  }

  return failures
}

export function validateRequiredTerms(fileContents: ReadonlyArray<string>): ValidationFailure[] {
  const combined = fileContents.join('\n')
  const failures: ValidationFailure[] = []

  for (let termIndex = 0; termIndex < REQUIRED_TERMS.length; termIndex++) {
    const term = REQUIRED_TERMS[termIndex]
    if (!combined.includes(term)) {
      failures.push({
        file: '(combined)',
        message: `active Flamingo surfaces do not contain required term "${term}"`,
      })
    }
  }

  return failures
}

export async function runValidation(): Promise<ValidationFailure[]> {
  const fileContents: [string, string][] = []
  for (let i = 0; i < TARGET_FILES.length; i++) {
    const content = await readFile(TARGET_FILES[i], 'utf8')
    fileContents.push([TARGET_FILES[i], content])
  }

  const failures: ValidationFailure[] = []

  const forbiddenFailures = validateForbiddenTerms(fileContents)
  for (const failure of forbiddenFailures) {
    failures.push(failure)
  }

  const requiredFailures = validateRequiredTerms(fileContents.map((entry) => entry[1]))
  for (const failure of requiredFailures) {
    failures.push(failure)
  }

  return failures
}

async function main(): Promise<void> {
  const failures = await runValidation()

  if (failures.length > 0) {
    console.error(failures.map((f) => `${f.file}: ${f.message}`).join('\n'))
    process.exit(1)
  }

  console.log(`validated ${TARGET_FILES.length} Flamingo hard-migration surfaces`)
}

if (import.meta.main) {
  await main()
}
