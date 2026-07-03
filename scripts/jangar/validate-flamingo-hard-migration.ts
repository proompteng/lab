import { readFile } from 'node:fs/promises'

export const requiredTerms = [
  'unsloth/Qwen3.6-35B-A3B-NVFP4',
  'qwen36-flamingo',
  'qwen3',
  'qwen3_coder',
  '262144',
  '229376',
  '32768',
  'fp8',
  'safetensors-load-strategy',
  'eager',
  'max-num-partial-prefills',
  'max-long-partial-prefills',
  'long-prefill-token-threshold',
  'enable-dbo',
  'dbo-decode-token-threshold',
  'dbo-prefill-token-threshold',
  'speculativeAcceptanceLength',
]

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
  'scripts/jangar/benchmark-flamingo-vllm.ts',
  'scripts/jangar/validate-pi-flamingo-compaction.ts',
  'services/anypi/src/config.ts',
  'services/anypi/src/config.test.ts',
]

export const activeSaigakMigrationFiles = [
  'argocd/applications/agents/values.yaml',
  'argocd/applications/bumba/deployment.yaml',
  'argocd/applications/jangar/deployment.yaml',
  'argocd/applications/jangar/openwebui-values.yaml',
  'argocd/applications/kubevirt/kustomization.yaml',
  'argocd/applicationsets/platform.yaml',
  'argocd/applications/saigak/kustomization.yaml',
  'argocd/applications/saigak/service.yaml',
  'argocd/applications/saigak/statefulset.yaml',
  'services/bumba/src/activities/index.ts',
]

export type FileContent = {
  path: string
  content: string
}

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

function hasSaigakCompletionUrl(content: string): boolean {
  return (
    /\bOPENAI_API_BASE_URL:\s*http:\/\/saigak\.saigak\.svc\.cluster\.local:11434\/v1\b/.test(content) ||
    /name:\s*OPENAI_API_BASE_URL\s*\n\s*value:\s*http:\/\/saigak\.saigak\.svc\.cluster\.local:11434\/v1\b/.test(content)
  )
}

export function validateActiveSaigakMigrationContent(files: FileContent[]): string[] {
  const failures: string[] = []
  const byPath = new Map(files.map((file) => [file.path, file.content]))

  for (const file of files) {
    if (hasSaigakCompletionUrl(file.content)) {
      failures.push(`${file.path}: active completion base URL must point to Flamingo, not Saigak`)
    }
  }

  for (const path of [
    'argocd/applications/agents/values.yaml',
    'argocd/applications/bumba/deployment.yaml',
    'argocd/applications/jangar/deployment.yaml',
    'services/bumba/src/activities/index.ts',
  ]) {
    const content = byPath.get(path)
    if (!content) continue
    for (const model of ['qwen3-main-saigak:30b-a3b', 'qwen3:30b-a3b']) {
      if (content.includes(model)) {
        failures.push(`${path}: active completion surface still references disabled Saigak model "${model}"`)
      }
    }
  }

  const openWebui = byPath.get('argocd/applications/jangar/openwebui-values.yaml')
  if (openWebui) {
    for (const term of ['OLLAMA_BASE_URLS', 'ollamaUrls', 'ENABLE_OLLAMA_API: "true"', 'ENABLE_OLLAMA_API: true']) {
      if (openWebui.includes(term)) {
        failures.push(
          `argocd/applications/jangar/openwebui-values.yaml: OpenWebUI must not expose Saigak as a chat backend via "${term}"`,
        )
      }
    }
  }

  const saigakKustomization = byPath.get('argocd/applications/saigak/kustomization.yaml')
  if (saigakKustomization) {
    for (const resource of ['virtualmachine.yaml', 'cloud-init-secret.yaml', 'cloud-init-network-secret.yaml']) {
      if (saigakKustomization.includes(resource)) {
        failures.push(
          `argocd/applications/saigak/kustomization.yaml: Saigak must not render retired KubeVirt resource "${resource}"`,
        )
      }
    }
  }

  const kubevirt = byPath.get('argocd/applications/kubevirt/kustomization.yaml')
  if (kubevirt) {
    for (const term of ['nvidia.com/GA102_GEFORCE_RTX_3090', 'permittedHostDevices']) {
      if (kubevirt.includes(term)) {
        failures.push(
          `argocd/applications/kubevirt/kustomization.yaml: 3090 passthrough must not remain active via "${term}"`,
        )
      }
    }
  }

  const platform = byPath.get('argocd/applicationsets/platform.yaml')
  if (platform?.includes('namespace: saigak\n          name: saigak')) {
    failures.push('argocd/applicationsets/platform.yaml: Saigak must not keep VirtualMachine diff-ignore desired state')
  }

  const saigakService = byPath.get('argocd/applications/saigak/service.yaml')
  if (saigakService?.includes('kubevirt.io/domain')) {
    failures.push(
      'argocd/applications/saigak/service.yaml: Saigak service must select the embeddings StatefulSet, not KubeVirt',
    )
  }

  const saigakStatefulSet = byPath.get('argocd/applications/saigak/statefulset.yaml')
  if (saigakStatefulSet) {
    for (const term of ['kubernetes.io/hostname: turin', 'RTX PRO 6000', 'Blackwell']) {
      if (saigakStatefulSet.includes(term)) {
        failures.push(
          `argocd/applications/saigak/statefulset.yaml: Saigak must stay on the Altra RTX 3090 path, found "${term}"`,
        )
      }
    }
    for (const term of ['ollama pull qwen3:30b-a3b', 'ollama create qwen3-main-saigak']) {
      if (saigakStatefulSet.includes(term)) {
        failures.push(
          `argocd/applications/saigak/statefulset.yaml: Saigak must not provision completion model via "${term}"`,
        )
      }
    }
  }

  return failures
}

export async function validateActiveSaigakMigration(paths: string[]): Promise<string[]> {
  const contents = await Promise.all(paths.map(async (path) => ({ path, content: await readFile(path, 'utf8') })))
  return validateActiveSaigakMigrationContent(contents)
}

async function main(): Promise<void> {
  const failures = [
    ...(await validateFiles(targetFiles, requiredTerms, forbiddenTerms)),
    ...(await validateActiveSaigakMigration(activeSaigakMigrationFiles)),
  ]
  if (failures.length > 0) {
    console.error(failures.join('\n'))
    process.exit(1)
  }
  console.log(`validated ${targetFiles.length} Flamingo hard-migration surfaces`)
}

if (import.meta.main) {
  await main()
}
