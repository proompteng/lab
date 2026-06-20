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

type CheckResult = {
  file?: string
  term: string
  type: 'missing' | 'found'
}

/**
 * Check which required terms are absent from the combined content.
 * Pure function: no I/O.
 */
export function validateRequiredTerms(combined: string, terms: readonly string[]): CheckResult[] {
  const results: CheckResult[] = []
  for (const term of terms) {
    if (!combined.includes(term)) {
      results.push({ term, type: 'missing' })
    }
  }
  return results
}

/**
 * Check which forbidden terms appear in file contents.
 * Pure function: takes a map of file paths to content strings. No I/O.
 */
export function validateForbiddenTerms(fileContents: Map<string, string>, terms: readonly string[]): CheckResult[] {
  const results: CheckResult[] = []
  for (const [file, content] of fileContents) {
    for (const term of terms) {
      if (content.includes(term)) {
        results.push({ file, term, type: 'found' })
      }
    }
  }
  return results
}

/**
 * Read all target files once, then run required and forbidden term checks.
 * Pure async I/O with no side effects beyond file reads.
 */
export async function validateFlamingoHardMigration(
  files: readonly string[] = TARGET_FILES,
  required: readonly string[] = REQUIRED_TERMS,
  forbidden: readonly string[] = FORBIDDEN_TERMS,
): Promise<{ success: boolean; errors: string[] }> {
  const fileContents = new Map<string, string>()
  for (const file of files) {
    fileContents.set(file, await readFile(file, 'utf8'))
  }
  const forbiddenResults = validateForbiddenTerms(fileContents, forbidden)
  const combined = [...fileContents.values()].join('\n')
  const requiredResults = validateRequiredTerms(combined, required)

  const errors: string[] = []
  for (const r of forbiddenResults) {
    errors.push(`${r.file}: still contains forbidden Flamingo migration term "${r.term}"`)
  }
  for (const r of requiredResults) {
    errors.push(`active Flamingo surfaces do not contain required term "${r.term}"`)
  }

  return {
    success: errors.length === 0,
    errors,
  }
}

if (import.meta.main) {
  await main()
}

async function main() {
  const result = await validateFlamingoHardMigration()
  if (!result.success) {
    console.error(result.errors.join('\n'))
    process.exit(1)
  }
  console.log(`validated ${TARGET_FILES.length} Flamingo hard-migration surfaces`)
}
