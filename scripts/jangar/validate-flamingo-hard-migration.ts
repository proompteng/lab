#!/usr/bin/env bun

/**
 * Hard-migration validator for the Flamingo Qwen3.6 service contract.
 *
 * Validates that all Git-referenced surfaces carry the correct model name,
 * served alias, reasoning parser, and tool-call parser while rejecting stale
 * Qwen3-Coder references, the old `hermes` parser, and the deprecated
 * `qwen3_xml` parser.
 *
 * Usage:
 *   bun run scripts/jangar/validate-flamingo-hard-migration.ts
 *
 * Exit code 0 when all surfaces satisfy the invariants.
 * Exit code 1 with actionable error messages when any invariant fails.
 */

import { readFile } from 'node:fs/promises'

// ── Data-driven invariants ──────────────────────────────────────────────────

/** The model image tag that must appear in every deployment surface. */
export const REQUIRED_MODEL = 'unsloth/Qwen3.6-35B-A3B-NVFP4'

/** The served model name the vLLM endpoint must advertise. */
export const REQUIRED_SERVED_NAME = 'qwen36-flamingo'

/** The reasoning parser argument value the vLLM container must use. */
export const REQUIRED_REASONING_PARSER = 'qwen3'

/** The tool-call parser argument value the vLLM container must use. */
export const REQUIRED_TOOL_CALL_PARSER = 'qwen3_coder'

/**
 * Terms that must appear across all target files combined.
 * Each entry is checked via `String.includes` so the test is fully data-driven
 * over actual file contents, not against any runtime or cluster state.
 */
export const REQUIRED_TERMS = [
  REQUIRED_MODEL,
  REQUIRED_SERVED_NAME,
  REQUIRED_REASONING_PARSER,
  REQUIRED_TOOL_CALL_PARSER,
]

/**
 * Forbidden model references, served aliases, and parsers that must NOT
 * appear in any target file. These block the hard migration when present.
 */
export const FORBIDDEN_TERMS = [
  'Qwen/Qwen3-Coder-Next-FP8',
  'Qwen/Qwen3-Coder-30B-A3B-Instruct',
  'qwen3-coder-flamingo',
  'hermes',
  'qwen3_xml',
]

// ── Target file surfaces ────────────────────────────────────────────────────

/**
 * File paths that participate in the Flamingo hard-migration contract.
 * Add or remove files here when the surface area changes.
 */
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
]

// ── Validation helpers ──────────────────────────────────────────────────────

/**
 * Scan a single file's content for forbidden terms.
 * Returns a list of diagnostic messages.
 */
export function scanForForbidden(content: string): string[] {
  const messages: string[] = []
  for (const term of FORBIDDEN_TERMS) {
    if (content.includes(term)) {
      messages.push(`still contains forbidden term "${term}"`)
    }
  }
  return messages
}

/**
 * Scan combined content for missing required terms.
 * Returns a list of diagnostic messages.
 */
export function scanForMissingFromCombined(combined: string): string[] {
  const messages: string[] = []
  for (const term of REQUIRED_TERMS) {
    if (!combined.includes(term)) {
      messages.push(`active Flamingo surfaces do not contain required term "${term}"`)
    }
  }
  return messages
}

/**
 * Validate a single file against forbidden terms.
 * Returns an array of human-readable failure messages. Each message includes
 * the file path so the operator can locate the problem immediately.
 *
 * @param filePath - Path relative to repository root.
 * @returns Diagnostic messages (empty when the file passes).
 */
export function validateFile(filePath: string, content: string): string[] {
  const diagnostics: string[] = []
  const forbidden = scanForForbidden(content)
  for (const msg of forbidden) {
    diagnostics.push(`${filePath}: ${msg}`)
  }
  return diagnostics
}

/**
 * Validate all target files. Reads each file from disk, applies the checks,
 * and returns a flat list of diagnostic strings.
 *
 * Forbidden terms are checked per-file (with path prefix).
 * Required terms are checked across all combined content.
 *
 * @param files - Override list of target file paths. Defaults to `TARGET_FILES`.
 * @returns Array of diagnostic messages (empty when everything passes).
 */
export async function validateAll(files?: string[]): Promise<string[]> {
  const targets = files ?? TARGET_FILES
  const results: string[] = []

  // Phase 1 — per-file: forbidden terms.
  for (const filePath of targets) {
    const content = await readFile(filePath, 'utf8')
    results.push(...validateFile(filePath, content))
  }

  // Phase 2 — combined: every required term must appear somewhere.
  const combined = await Promise.all(targets.map(async (filePath) => await readFile(filePath, 'utf8'))).then((parts) =>
    parts.join('\n'),
  )

  results.push(...scanForMissingFromCombined(combined))

  return results
}

// ── CLI entry point ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const diagnostics = await validateAll()

  if (diagnostics.length > 0) {
    console.error(diagnostics.join('\n'))
    process.exitCode = 1
    return
  }

  const targets = TARGET_FILES
  console.log(`validated ${targets.length} Flamingo hard-migration surfaces`)
}

// Allow importing for test-driven usage.
if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
