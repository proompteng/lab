#!/usr/bin/env bun

import { readFile } from 'node:fs/promises'

const REQUIRED_TERMS = ['unsloth/Qwen3.6-35B-A3B-NVFP4', 'qwen36-flamingo', 'qwen3', 'qwen3_coder']

const FORBIDDEN_TERMS = [
  'Qwen/Qwen3-Coder-Next-FP8',
  'qwen3-coder-flamingo',
  'Qwen/Qwen3-Coder-30B-A3B-Instruct',
  'hermes',
  'qwen3_xml',
]

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
]

export function checkForbiddenTerms(content: string, filePath: string): string[] {
  const errors: string[] = []
  for (const term of FORBIDDEN_TERMS) {
    if (content.includes(term)) {
      errors.push(`${filePath}: still contains forbidden Flamingo migration term "${term}"`)
    }
  }
  return errors
}

export function checkRequiredTerms(filePaths: { path: string; content: string }[]): string[] {
  const combined = filePaths.map((f) => f.content).join('\n')
  const errors: string[] = []
  for (const term of REQUIRED_TERMS) {
    if (!combined.includes(term)) {
      errors.push(`active Flamingo surfaces do not contain required term "${term}"`)
    }
  }
  return errors
}

export async function validateMigration(files: { path: string; read: () => Promise<string> }[]): Promise<string[]> {
  const failures: string[] = []

  for (const file of files) {
    const content = await file.read()
    failures.push(...checkForbiddenTerms(content, file.path))
  }

  const filesWithContent = files.map((f) => ({
    path: f.path,
    content: null as string | null,
  }))

  // Read all content first
  for (const file of files) {
    const entry = filesWithContent.find((f) => f.path === file.path)
    if (entry) entry.content = await file.read()
  }

  const validEntries = filesWithContent.filter((f) => f.content !== null) as { path: string; content: string }[]
  failures.push(...checkRequiredTerms(validEntries))

  return failures
}

export async function main(): Promise<void> {
  const files = TARGET_FILES.map((path) => ({
    path,
    read: () => readFile(path, 'utf8'),
  }))

  const failures = await validateMigration(files)

  if (failures.length > 0) {
    console.error(failures.join('\n'))
    process.exit(1)
  }

  console.log(`validated ${TARGET_FILES.length} Flamingo hard-migration surfaces`)
}

if (import.meta.main) await main()
