#!/usr/bin/env bun

// ── Validation invariants ──────────────────────────────────────────────────────
//
// Current production contract (as of hard-migration):
//   - Model:     unsloth/Qwen3.6-35B-A3B-NVFP4
//   - Served:    qwen36-flamingo
//   - Reasoning: qwen3
//   - Tool-call: qwen3_coder
//
// Stale artifacts that must NOT appear in any active surface:
//   - Qwen3-Coder model IDs, old served alias, hermes parser, qwen3_xml parser
//   - --numa-bind remains absent unless topology values are validated separately

// ── Data-driven invariants ─────────────────────────────────────────────────────

/** Terms that must appear in at least one of the checked surfaces. */
export const REQUIRED_TERMS = [
  'unsloth/Qwen3.6-35B-A3B-NVFP4', // model id
  'qwen36-flamingo', // served name
  'qwen3', // reasoning parser
  'qwen3_coder', // tool-call parser
] as const

/** Terms that must NOT appear anywhere in checked surfaces. */
export const FORBIDDEN_TERMS = [
  'Qwen/Qwen3-Coder-Next-FP8',
  'qwen3-coder-flamingo',
  'Qwen/Qwen3-Coder-30B-A3B-Instruct',
  'hermes',
  'qwen3_xml',
] as const

/** File paths that belong to the Flamingo migration surface. */
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

// ── Pure validation helpers ────────────────────────────────────────────────────

/**
 * Check that a single file's content does not contain any forbidden terms.
 * Returns a list of human-readable failure strings.
 */
export function validateFileNoForbidden(file: string, content: string): string[] {
  const failures: string[] = []

  for (const term of FORBIDDEN_TERMS) {
    if (content.includes(term)) {
      failures.push(` ${file}: still contains forbidden Flamingo migration term "${term}"`)
    }
  }

  return failures
}

/**
 * Check that a combined content (all target files joined) contains every
 * required term. Returns a list of human-readable failure strings.
 */
export function validateRequiredTerms(combined: string): string[] {
  const failures: string[] = []

  for (const term of REQUIRED_TERMS) {
    if (!combined.includes(term)) {
      failures.push(` active Flamingo surfaces do not contain required term "${term}"`)
    }
  }

  return failures
}

/**
 * Main validation: reads all target files, checks forbidden terms per-file
 * and required terms across all files. Returns the full failure list.
 */
export async function validateMigration(): Promise<string[]> {
  const { readFile } = await import('node:fs/promises')

  const fileFailures: string[] = []

  for (const file of TARGET_FILES) {
    const content = await readFile(file, 'utf8')
    fileFailures.push(...validateFileNoForbidden(file, content))
  }

  const combined = await Promise.all(TARGET_FILES.map(async (file) => readFile(file, 'utf8'))).then((parts) =>
    parts.join('\n'),
  )
  fileFailures.push(...validateRequiredTerms(combined))

  return fileFailures
}

// ── CLI entry point ────────────────────────────────────────────────────────────

const failures = await validateMigration()

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}

console.log(`validated ${TARGET_FILES.length} Flamingo hard-migration surfaces`)
