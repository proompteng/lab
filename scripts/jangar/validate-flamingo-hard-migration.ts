#!/usr/bin/env bun

import { readFile } from 'node:fs/promises'

// ─────────────────────────────────────────────────────────────────────────────
// Shared invariants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Model/image terms that must be present in the active Flamingo profile.
 */
export const requiredTerms = ['unsloth/Qwen3.6-35B-A3B-NVFP4', 'qwen36-flamingo', 'qwen3_xml'] as const

/**
 * Stale or wrong-model terms that must NOT appear in any migration surface.
 */
export const forbiddenTerms = [
  'Qwen/Qwen3-Coder-Next-FP8',
  'qwen3-coder-flamingo',
  'Qwen/Qwen3-Coder-30B-A3B-Instruct',
  'hermes',
] as const

/**
 * Additional forbidden vLLM flags that must not be present in production.
 */
export const forbiddenFlags = ['--numa-bind'] as const

/**
 * Files scanned during the hard-migration validation sweep.
 */
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
] as const

/**
 * Files scanned for forbidden vLLM flags (e.g. `--numa-bind`).
 * Source files that DEFINE the flag name are excluded to avoid
 * self-matching (the string literal in the constant would otherwise
 * cause a false-positive on `checkForbiddenFlags`).
 */
export const configFilesForFlags = [
  'argocd/applications/flamingo/deployment.yaml',
  'argocd/applications/flamingo/docs/large-model-multigpu.md',
  'argocd/applications/agents/anypi-agentprovider.yaml',
  'argocd/applications/agents/anypi-eval-agentprovider.yaml',
  'argocd/applications/jangar/openwebui-values.yaml',
] as const

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (imported by tests)
// ─────────────────────────────────────────────────────────────────────────────

/** Read all target files and return `{ path, content }` pairs. */
export async function readTargetFiles(files: readonly string[]): Promise<Array<{ path: string; content: string }>> {
  const results: Array<{ path: string; content: string }> = []

  for (const file of files) {
    results.push({ path: file, content: await readFile(file, 'utf8') })
  }

  return results
}

/** Find forbidden-string violations across the target files. */
export function checkForbiddenTerms(
  files: ReadonlyArray<{ path: string; content: string }>,
  terms: readonly string[],
): string[] {
  const failures: string[] = []

  for (const { path, content } of files) {
    for (const term of terms) {
      if (content.includes(term)) {
        failures.push(`${path}: still contains forbidden term "${term}"`)
      }
    }
  }

  return failures
}

/**
 * Check that required terms appear in the combined content of all target
 * files.  Returns a failure string for every missing term.
 */
export function checkRequiredTerms(combined: string, terms: readonly string[]): string[] {
  const failures: string[] = []

  for (const term of terms) {
    if (!combined.includes(term)) {
      failures.push(`active Flamingo surfaces do not contain required term "${term}"`)
    }
  }

  return failures
}

/** Check that forbidden flags are absent from the combined content of the given files. */
export function checkForbiddenFlags(
  files: ReadonlyArray<{ path: string; content: string }>,
  flags: readonly string[],
): string[] {
  const failures: string[] = []

  for (const { path, content } of files) {
    for (const flag of flags) {
      if (content.includes(flag)) {
        failures.push(`${path}: still contains forbidden flag "${flag}"`)
      }
    }
  }

  return failures
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const files = await readTargetFiles(targetFiles)
  const combined = files.map(({ content }) => content).join('\n')
  const failures: string[] = []

  failures.push(...checkForbiddenTerms(files, forbiddenTerms))

  failures.push(...checkRequiredTerms(combined, requiredTerms))

  const configFiles = await readTargetFiles(configFilesForFlags)
  failures.push(...checkForbiddenFlags(configFiles, forbiddenFlags))

  if (failures.length > 0) {
    console.error(failures.join('\n'))
    process.exit(1)
  }

  console.log(`validated ${targetFiles.length} Flamingo hard-migration surfaces`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
