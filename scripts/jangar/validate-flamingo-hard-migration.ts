#!/usr/bin/env bun

import { readFile } from 'node:fs/promises'

const requiredTerms = ['unsloth/Qwen3.6-35B-A3B-NVFP4', 'qwen36-flamingo', 'qwen3', 'qwen3_coder']
const forbiddenTerms = [
  'Qwen/Qwen3-Coder-Next-FP8',
  'qwen3-coder-flamingo',
  'Qwen/Qwen3-Coder-30B-A3B-Instruct',
  'hermes',
]

const targetFiles = [
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

const failures: string[] = []

for (const file of targetFiles) {
  const content = await readFile(file, 'utf8')

  for (const term of forbiddenTerms) {
    if (content.includes(term)) {
      failures.push(`${file}: still contains forbidden Flamingo migration term "${term}"`)
    }
  }
}

const combined = await Promise.all(targetFiles.map(async (file) => await readFile(file, 'utf8'))).then((parts) =>
  parts.join('\n'),
)

for (const term of requiredTerms) {
  if (!combined.includes(term)) {
    failures.push(`active Flamingo surfaces do not contain required term "${term}"`)
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}

console.log(`validated ${targetFiles.length} Flamingo hard-migration surfaces`)
