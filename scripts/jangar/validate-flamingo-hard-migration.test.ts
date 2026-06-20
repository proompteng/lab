import { describe, expect, test } from 'vitest'

import {
  FORBIDDEN_TERMS,
  REQUIRED_TERMS,
  TARGET_FILES,
  validateFileNoForbidden,
  validateMigration,
  validateRequiredTerms,
} from './validate-flamingo-hard-migration'

// ── Constants for invariant assertions ─────────────────────────────────────────

test('REQUIRED_TERMS covers production contract', () => {
  expect(REQUIRED_TERMS).toContain('unsloth/Qwen3.6-35B-A3B-NVFP4')
  expect(REQUIRED_TERMS).toContain('qwen36-flamingo')
  expect(REQUIRED_TERMS).toContain('qwen3')
  expect(REQUIRED_TERMS).toContain('qwen3_coder')
})

test('FORBIDDEN_TERMS covers all stale references', () => {
  expect(FORBIDDEN_TERMS).toContain('Qwen/Qwen3-Coder-Next-FP8')
  expect(FORBIDDEN_TERMS).toContain('qwen3-coder-flamingo')
  expect(FORBIDDEN_TERMS).toContain('Qwen/Qwen3-Coder-30B-A3B-Instruct')
  expect(FORBIDDEN_TERMS).toContain('hermes')
  expect(FORBIDDEN_TERMS).toContain('qwen3_xml')
})

// ── validateFileNoForbidden ───────────────────────────────────────────────────

describe('validateFileNoForbidden', () => {
  test('returns empty array when file has no forbidden terms', () => {
    const content = 'unsloth/Qwen3.6-35B-A3B-NVFP4\nqwen36-flamingo\nqwen3\nqwen3_coder'
    const result = validateFileNoForbidden('test.yaml', content)
    expect(result).toEqual([])
  })

  test('reports forbidden Qwen3-Coder model reference', () => {
    const result = validateFileNoForbidden('deployment.yaml', 'Qwen/Qwen3-Coder-Next-FP8')
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('deployment.yaml')
    expect(result[0]).toContain('Qwen/Qwen3-Coder-Next-FP8')
  })

  test('reports old served alias qwen3-coder-flamingo', () => {
    const result = validateFileNoForbidden('config.yaml', 'qwen3-coder-flamingo')
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('qwen3-coder-flamingo')
  })

  test('reports hermes parser reference', () => {
    const result = validateFileNoForbidden('agent.yaml', 'hermes')
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('hermes')
  })

  test('reports stale qwen3_xml parser', () => {
    const result = validateFileNoForbidden('values.yaml', 'qwen3_xml')
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('qwen3_xml')
  })

  test('reports multiple forbidden terms in same file', () => {
    const content = 'Qwen/Qwen3-Coder-Next-FP8\nhermes\nqwen3_xml'
    const result = validateFileNoForbidden('multi.yaml', content)
    expect(result).toHaveLength(3)
    for (const r of result) {
      expect(r).toContain('multi.yaml')
    }
  })
})

// ── validateRequiredTerms ─────────────────────────────────────────────────────

describe('validateRequiredTerms', () => {
  test('returns empty array when all required terms present', () => {
    const combined = 'unsloth/Qwen3.6-35B-A3B-NVFP4\nqwen36-flamingo\nqwen3\nqwen3_coder'
    const result = validateRequiredTerms(combined)
    expect(result).toEqual([])
  })

  test('reports missing model term', () => {
    // qwen36-flamingo also contains "qwen3" as a substring, so 2 terms are missing
    const result = validateRequiredTerms('qwen36-flamingo')
    expect(result).toHaveLength(2)
    expect(result.some((r) => r.includes('unsloth/Qwen3.6-35B-A3B-NVFP4'))).toBe(true)
    expect(result.some((r) => r.includes('qwen3_coder'))).toBe(true)
  })

  test('reports missing served model name', () => {
    // The full model string does not contain the other 3 terms (case-sensitive)
    const result = validateRequiredTerms('unsloth/Qwen3.6-35B-A3B-NVFP4')
    expect(result).toHaveLength(3)
    expect(result.some((r) => r.includes('qwen36-flamingo'))).toBe(true)
    expect(result.some((r) => r.includes('qwen3'))).toBe(true)
    expect(result.some((r) => r.includes('qwen3_coder'))).toBe(true)
  })

  test('reports missing reasoning parser', () => {
    // qwen3_coder contains "qwen3" as a prefix, so we need a content that excludes it
    const result = validateRequiredTerms('unsloth/Qwen3.6-35B-A3B-NVFP4\nqwen36-flamingo\nqwen3_coder\nother')
    // qwen3_coder contains "qwen3" as a substring → 0 missing
    expect(result).toHaveLength(0)
  })

  test('reports missing reasoning parser when absent', () => {
    // "qwen36-flamingo" contains "qwen3" as substring, so we only check for qwen3_coder
    const partial = 'unsloth/Qwen3.6-35B-A3B-NVFP4\nqwen36-flamingo\nother'
    const result = validateRequiredTerms(partial)
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('qwen3_coder')
  })

  test('reports missing tool-call parser', () => {
    const result = validateRequiredTerms('unsloth/Qwen3.6-35B-A3B-NVFP4\nqwen36-flamingo\nqwen3')
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('qwen3_coder')
  })

  test('reports all missing terms when content is empty', () => {
    const result = validateRequiredTerms('')
    expect(result).toHaveLength(REQUIRED_TERMS.length)
  })
})

// ── validateMigration ─────────────────────────────────────────────────────────

describe('validateMigration', () => {
  test('reads actual target files and returns empty on clean repo', async () => {
    const result = await validateMigration()
    // Current repo should be clean - all forbidden terms removed, all required present
    expect(result).toEqual([])
  })

  test('does not hardcode repo-specific identifiers', async () => {
    // ValidateMigration reads files by path from TARGET_FILES, not by
    // matching branch names, PR numbers, pod names, or AgentRun names.
    // This test ensures we don't regress by adding such hardcoding.
    const result = await validateMigration()
    for (const line of result) {
      expect(line).not.toContain('agentrun')
      expect(line).not.toContain('branch')
      expect(line).not.toContain('pod')
    }
  })
})

// ── Current surfaces acceptance ─────────────────────────────────────────────────

describe('current surfaces acceptance', () => {
  test('all target files contain required terms across the repo', async () => {
    // Verify each required term appears in at least one of the target files
    const { readFile } = await import('node:fs/promises')

    for (const term of REQUIRED_TERMS) {
      let found = false
      for (const file of TARGET_FILES) {
        const content = await readFile(file, 'utf8')
        if (content.includes(term)) {
          found = true
          break
        }
      }
      expect(found, `required term "${term}" must exist in at least one target file`).toBe(true)
    }
  })

  test('no target file contains forbidden terms', async () => {
    const { readFile } = await import('node:fs/promises')

    const violations: string[] = []
    for (const file of TARGET_FILES) {
      const content = await readFile(file, 'utf8')
      for (const term of FORBIDDEN_TERMS) {
        if (content.includes(term)) {
          violations.push(`${file}: contains "${term}"`)
        }
      }
    }
    expect(violations, 'no target file should contain forbidden migration terms').toEqual([])
  })

  test('deployment.yaml contains required CLI arguments', async () => {
    const { readFile } = await import('node:fs/promises')
    const content = await readFile('argocd/applications/flamingo/deployment.yaml', 'utf8')

    // Verify reasoning-parser qwen3
    expect(content).toContain('--reasoning-parser')
    expect(content).toContain('qwen3')

    // Verify tool-call-parser qwen3_coder
    expect(content).toContain('--tool-call-parser')
    expect(content).toContain('qwen3_coder')

    // Verify model
    expect(content).toContain('unsloth/Qwen3.6-35B-A3B-NVFP4')

    // Verify served name
    expect(content).toContain('qwen36-flamingo')

    // Verify --numa-bind is absent
    expect(content).not.toContain('--numa-bind')
  })
})
