import { describe, expect, test } from 'bun:test'

import {
  checkForbiddenTerms,
  checkRequiredTerms,
  FORBIDDEN_TERMS,
  readTargetFiles,
  REQUIRED_TERMS,
  TARGET_FILES,
  validateFlamingoHardMigration,
} from './validate-flamingo-hard-migration'

// ── Forbidden-term rejection ─────────────────────────────────────────────────

describe('forbidden terms', () => {
  test('rejects old Qwen3-Coder model references', () => {
    const surface = { path: 'test.yaml', content: 'Qwen/Qwen3-Coder-Next-FP8' }
    const failures = checkForbiddenTerms(surface, FORBIDDEN_TERMS)
    expect(failures.length).toBeGreaterThan(0)
    expect(failures[0]).toContain('Qwen/Qwen3-Coder-Next-FP8')
    expect(failures[0]).toContain('test.yaml')
  })

  test('rejects the old served alias qwen3-coder-flamingo', () => {
    const surface = { path: 'deployment.yaml', content: '--served-model-name qwen3-coder-flamingo' }
    const failures = checkForbiddenTerms(surface, FORBIDDEN_TERMS)
    expect(failures).toContain(
      'deployment.yaml: still contains forbidden Flamingo migration term "qwen3-coder-flamingo"',
    )
  })

  test('rejects old Qwen3-Coder 30B model', () => {
    const surface = { path: 'config.yaml', content: 'Qwen/Qwen3-Coder-30B-A3B-Instruct' }
    const failures = checkForbiddenTerms(surface, FORBIDDEN_TERMS)
    expect(failures.length).toBeGreaterThan(0)
  })

  test('rejects hermes as a reasoning parser', () => {
    const surface = { path: 'openwebui-values.yaml', content: '--reasoning-parser hermes' }
    const failures = checkForbiddenTerms(surface, FORBIDDEN_TERMS)
    expect(failures).toContain('openwebui-values.yaml: still contains forbidden Flamingo migration term "hermes"')
  })
})

// ── Required-term enforcement ────────────────────────────────────────────────

describe('required terms', () => {
  test('requires unsloth/Qwen3.6-35B-A3B-NVFP4', () => {
    const surfaces: { path: string; content: string }[] = [{ path: 'a.yaml', content: 'nothing here' }]
    const failures = checkRequiredTerms(surfaces, REQUIRED_TERMS)
    expect(failures).toContain('active Flamingo surfaces do not contain required term "unsloth/Qwen3.6-35B-A3B-NVFP4"')
  })

  test('requires qwen36-flamingo served alias', () => {
    const surfaces = [{ path: 'a.yaml', content: 'other model name' }]
    const failures = checkRequiredTerms(surfaces, REQUIRED_TERMS)
    expect(failures).toContain('active Flamingo surfaces do not contain required term "qwen36-flamingo"')
  })

  test('requires qwen3 reasoning parser', () => {
    const surfaces = [{ path: 'a.yaml', content: 'no reasoning parser' }]
    const failures = checkRequiredTerms(surfaces, REQUIRED_TERMS)
    expect(failures).toContain('active Flamingo surfaces do not contain required term "qwen3"')
  })

  test('requires qwen3_coder tool-call parser', () => {
    const surfaces = [{ path: 'a.yaml', content: 'tool call parser' }]
    const failures = checkRequiredTerms(surfaces, REQUIRED_TERMS)
    expect(failures).toContain('active Flamingo surfaces do not contain required term "qwen3_coder"')
  })
})

// ── Composite validation ─────────────────────────────────────────────────────

describe('full validation', () => {
  test('rejects stale terms and missing required terms together', () => {
    const surfaces = [
      { path: 'deploy.yaml', content: 'hermes qwen3-coder-flamingo' },
      { path: 'other.yaml', content: 'no required terms at all' },
    ]
    const result = validateFlamingoHardMigration(surfaces)
    expect(result.failures.length).toBeGreaterThan(0)
    expect(result.failures.some((f) => f.includes('hermes'))).toBe(true)
    expect(result.failures.some((f) => f.includes('qwen3-coder-flamingo'))).toBe(true)
    expect(result.failures.some((f) => f.includes('unsloth/Qwen3.6-35B-A3B-NVFP4'))).toBe(true)
  })

  test('returns clean result when all invariants hold', () => {
    const surfaces = [
      {
        path: 'deployment.yaml',
        content: [
          'unsloth/Qwen3.6-35B-A3B-NVFP4',
          'qwen36-flamingo',
          '--reasoning-parser qwen3',
          '--tool-call-parser qwen3_coder',
        ].join('\n'),
      },
    ]
    const result = validateFlamingoHardMigration(surfaces)
    expect(result.failures).toEqual([])
  })

  test('reports file path in forbidden-term failures', () => {
    const surfaces = [{ path: 'argocd/applications/flamingo/deployment.yaml', content: 'qwen3-coder-flamingo' }]
    const result = validateFlamingoHardMigration(surfaces)
    // Forbidden term failures include file path and the term
    const forbiddenFailures = result.failures.filter((f) => f.includes('forbidden Flamingo migration term'))
    expect(forbiddenFailures.length).toBeGreaterThan(0)
    for (const failure of forbiddenFailures) {
      expect(failure).toContain('argocd/applications/flamingo/deployment.yaml')
      expect(failure).toContain('qwen3-coder-flamingo')
    }
  })
})

// ── Current repository surfaces acceptance ───────────────────────────────────

describe('current repository surfaces', () => {
  test('all target files are resolved', async () => {
    expect(TARGET_FILES.length).toBeGreaterThan(0)
  })

  test('reading target files from disk succeeds for every surface', async () => {
    const surfaces = await readTargetFiles(TARGET_FILES)
    expect(surfaces.length).toBe(TARGET_FILES.length)
    for (const surface of surfaces) {
      expect(surface.content.length).toBeGreaterThan(0)
      expect(surface.path.length).toBeGreaterThan(0)
    }
  })

  test('all target files pass the full validation', async () => {
    const surfaces = await readTargetFiles(TARGET_FILES)
    const result = validateFlamingoHardMigration(surfaces)
    expect(result.failures.length).toBe(0)
  })
})
