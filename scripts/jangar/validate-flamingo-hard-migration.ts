#!/usr/bin/env bun

import { readFile } from 'node:fs/promises'

// ── Data-driven validation configuration ─────────────────────────────────────

export const REQUIRED_TERMS = ['unsloth/Qwen3.6-35B-A3B-NVFP4', 'qwen36-flamingo', 'qwen3', 'qwen3_coder'] as const

export const FORBIDDEN_TERMS = [
  'Qwen/Qwen3-Coder-Next-FP8',
  'qwen3-coder-flamingo',
  'Qwen/Qwen3-Coder-30B-A3B-Instruct',
  'hermes',
] as const

export const TARGET_FILES = [
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

// ── Pure validation helpers ──────────────────────────────────────────────────

export interface SurfaceFile {
  path: string
  content: string
}

export interface ValidationResult {
  failures: string[]
  surfaces: SurfaceFile[]
}

/**
 * Read all target files and return their contents for inspection.
 */
export async function readTargetFiles(files: readonly string[]): Promise<SurfaceFile[]> {
  const readOne = async (file: string): Promise<SurfaceFile> => ({
    path: file,
    content: await readFile(file, 'utf8'),
  })
  return Promise.all(files.map(readOne))
}

/**
 * Check forbidden terms against a single file's content.
 * Returns an array of failure strings; empty means clean.
 */
export function checkForbiddenTerms(file: SurfaceFile, forbiddenTerms: readonly string[]): string[] {
  return forbiddenTerms.reduce<string[]>((acc, term) => {
    if (file.content.includes(term)) {
      acc.push(`${file.path}: still contains forbidden Flamingo migration term "${term}"`)
    }
    return acc
  }, [])
}

/**
 * Check that the combined content of all surfaces contains every required term.
 * Returns an array of failure strings; empty means clean.
 */
export function checkRequiredTerms(surfaces: SurfaceFile[], requiredTerms: readonly string[]): string[] {
  const combined = surfaces.map((s) => s.content).join('\n')
  const missing: string[] = []
  for (const term of requiredTerms) {
    if (!combined.includes(term)) {
      missing.push(`active Flamingo surfaces do not contain required term "${term}"`)
    }
  }
  return missing
}

/**
 * Run the full hard-migration validation over a set of surfaces.
 * Returns `{ failures }` — empty means migration is clean.
 */
export function validateFlamingoHardMigration(surfaces: SurfaceFile[]): ValidationResult {
  const forbiddenFailures: string[] = []
  for (const surface of surfaces) {
    forbiddenFailures.push(...checkForbiddenTerms(surface, FORBIDDEN_TERMS))
  }
  const requiredFailures = checkRequiredTerms(surfaces, REQUIRED_TERMS)
  return {
    failures: [...forbiddenFailures, ...requiredFailures],
    surfaces,
  }
}

// ── CLI entry point ──────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const surfaces = await readTargetFiles(TARGET_FILES)
  const result = validateFlamingoHardMigration(surfaces)

  if (result.failures.length > 0) {
    console.error(result.failures.join('\n'))
    process.exit(1)
  }

  console.log(`validated ${TARGET_FILES.length} Flamingo hard-migration surfaces`)
}

await main()
