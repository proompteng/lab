import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { describe, expect, test, afterAll, beforeEach } from 'vitest'

import {
  FORBIDDEN_TERMS,
  REQUIRED_TERMS,
  REQUIRED_MODEL,
  REQUIRED_SERVED_NAME,
  REQUIRED_REASONING_PARSER,
  REQUIRED_TOOL_CALL_PARSER,
  scanForForbidden,
  scanForMissingFromCombined,
  validateFile,
  validateAll,
  TARGET_FILES,
} from './validate-flamingo-hard-migration'

// ── Constants ───────────────────────────────────────────────────────────────

/** Temporary workspace used by tests. */
let tmpRoot = ''

afterAll(async () => {
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
    tmpRoot = ''
  }
})

beforeEach(() => {
  tmpRoot = join(tmpdir(), `flamingo-validator-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
})

// ── Pure helpers: scanForForbidden ──────────────────────────────────────────

describe('scanForForbidden', () => {
  test('rejects stale Qwen3-Coder model references', () => {
    const result = scanForForbidden('Qwen/Qwen3-Coder-Next-FP8')
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('Qwen/Qwen3-Coder-Next-FP8')
  })

  test('rejects old served alias qwen3-coder-flamingo', () => {
    const result = scanForForbidden('qwen3-coder-flamingo')
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('qwen3-coder-flamingo')
  })

  test('rejects the hermes parser', () => {
    const result = scanForForbidden('hermes')
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('hermes')
  })

  test('rejects the stale qwen3_xml parser', () => {
    const result = scanForForbidden('qwen3_xml')
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('qwen3_xml')
  })

  test('reports multiple forbidden terms in a single pass', () => {
    const result = scanForForbidden('hermes qwen3-coder-flamingo')
    expect(result).toHaveLength(2)
    expect(result).toContain('still contains forbidden term "hermes"')
    expect(result).toContain('still contains forbidden term "qwen3-coder-flamingo"')
  })

  test('returns empty array when content is clean', () => {
    expect(scanForForbidden('unsloth/Qwen3.6-35B-A3B-NVFP4 qwen36-flamingo')).toEqual([])
  })

  test('is case-sensitive', () => {
    // "Hermes" with capital H is NOT the forbidden term "hermes"
    expect(scanForForbidden('Hermes')).toEqual([])
    expect(scanForForbidden('QWEN3_XML')).toEqual([])
  })
})

// ── Pure helpers: scanForMissingFromCombined ─────────────────────────────────

describe('scanForMissingFromCombined', () => {
  test('reports when the model image is absent from combined content', () => {
    const result = scanForMissingFromCombined('some unrelated text')
    expect(result).toContain('active Flamingo surfaces do not contain required term "unsloth/Qwen3.6-35B-A3B-NVFP4"')
  })

  test('reports when the served name is absent from combined content', () => {
    const result = scanForMissingFromCombined('just plain text without the model name')
    expect(result).toContain('active Flamingo surfaces do not contain required term "qwen36-flamingo"')
  })

  test('reports when both parsers are missing from combined content', () => {
    const result = scanForMissingFromCombined('just plain text')
    expect(result).toContain('active Flamingo surfaces do not contain required term "qwen3"')
    expect(result).toContain('active Flamingo surfaces do not contain required term "qwen3_coder"')
  })

  test('passes when all required terms are present in combined content', () => {
    const combined = 'unsloth/Qwen3.6-35B-A3B-NVFP4 qwen36-flamingo qwen3 qwen3_coder'
    expect(scanForMissingFromCombined(combined)).toEqual([])
  })
})

// ── Pure helper: validateFile ──────────────────────────────────────────────

describe('validateFile', () => {
  test('includes file path in every diagnostic', () => {
    const results = validateFile('some/file.yaml', 'hermes')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatch(/^some\/file\.yaml:/)
    expect(results[0]).toContain('hermes')
  })

  test('reports multiple forbidden terms with path prefix', () => {
    const results = validateFile('path.yaml', 'Qwen/Qwen3-Coder-Next-FP8 hermes')
    expect(results.length).toBe(2)
    expect(results[0]).toContain('path.yaml')
    expect(results[0]).toContain('Qwen/Qwen3-Coder-Next-FP8')
    expect(results[1]).toContain('path.yaml')
    expect(results[1]).toContain('hermes')
  })

  test('empty array when a file is fully compliant', () => {
    const content = [
      'unsloth/Qwen3.6-35B-A3B-NVFP4',
      'qwen36-flamingo',
      'reasoning-parser qwen3',
      'tool-call-parser qwen3_coder',
    ].join('\n')
    expect(validateFile('compliant.yaml', content)).toEqual([])
  })
})

// ── Data-driven invariants ─────────────────────────────────────────────────

describe('exported invariants', () => {
  test('REQUIRED_TERMS includes all four contract tokens', () => {
    expect(REQUIRED_TERMS).toContain(REQUIRED_MODEL)
    expect(REQUIRED_TERMS).toContain(REQUIRED_SERVED_NAME)
    expect(REQUIRED_TERMS).toContain(REQUIRED_REASONING_PARSER)
    expect(REQUIRED_TERMS).toContain(REQUIRED_TOOL_CALL_PARSER)
  })

  test('REQUIRED_TERMS matches the model name and served name constants', () => {
    expect(REQUIRED_MODEL).toBe('unsloth/Qwen3.6-35B-A3B-NVFP4')
    expect(REQUIRED_SERVED_NAME).toBe('qwen36-flamingo')
    expect(REQUIRED_REASONING_PARSER).toBe('qwen3')
    expect(REQUIRED_TOOL_CALL_PARSER).toBe('qwen3_coder')
  })

  test('FORBIDDEN_TERMS rejects the specified stale terms', () => {
    expect(FORBIDDEN_TERMS).toContain('Qwen/Qwen3-Coder-Next-FP8')
    expect(FORBIDDEN_TERMS).toContain('qwen3-coder-flamingo')
    expect(FORBIDDEN_TERMS).toContain('hermes')
    expect(FORBIDDEN_TERMS).toContain('qwen3_xml')
    // old model variant
    expect(FORBIDDEN_TERMS).toContain('Qwen/Qwen3-Coder-30B-A3B-Instruct')
  })
})

// ── Integration: validateAll ────────────────────────────────────────────────

describe('validateAll', () => {
  test('rejects a temp file with forbidden terms', async () => {
    const stagingDir = join(tmpRoot, 'staging')
    await mkdir(stagingDir, { recursive: true })

    await writeFile(
      join(stagingDir, 'bad.yaml'),
      'model: Qwen/Qwen3-Coder-Next-FP8\nserved: qwen3-coder-flamingo',
      'utf8',
    )
    await writeFile(
      join(stagingDir, 'good.yaml'),
      ['unsloth/Qwen3.6-35B-A3B-NVFP4', 'qwen36-flamingo', 'qwen3', 'qwen3_coder'].join('\n'),
      'utf8',
    )

    const results = await validateAll([join(stagingDir, 'bad.yaml'), join(stagingDir, 'good.yaml')])

    // 2 forbidden terms in bad.yaml, no combined missing terms
    expect(results).toHaveLength(2)
    expect(results[0]).toContain('bad.yaml')
    expect(results[0]).toContain('forbidden term')
    expect(results[1]).toContain('bad.yaml')
    expect(results[1]).toContain('forbidden term')
  })

  test('rejects when combined content is missing required terms', async () => {
    const stagingDir = join(tmpRoot, 'staging-missing')
    await mkdir(stagingDir, { recursive: true })

    await writeFile(
      join(stagingDir, 'empty.yaml'),
      'no required terms here\njust stale\nQwen/Qwen3-Coder-Next-FP8',
      'utf8',
    )

    const results = await validateAll([join(stagingDir, 'empty.yaml')])
    expect(results.length).toBeGreaterThan(0)
    // Forbidden term + 4 missing required terms
    expect(results[0]).toContain('empty.yaml')
    expect(results[0]).toContain('forbidden term')
  })

  test('passes when all temp files are fully compliant', async () => {
    const stagingDir = join(tmpRoot, 'staging-ok')
    await mkdir(stagingDir, { recursive: true })

    const compliant = [
      'unsloth/Qwen3.6-35B-A3B-NVFP4',
      'qwen36-flamingo',
      'reasoning-parser qwen3',
      'tool-call-parser qwen3_coder',
    ].join('\n')

    await writeFile(join(stagingDir, 'a.yaml'), compliant, 'utf8')
    await writeFile(join(stagingDir, 'b.yaml'), compliant, 'utf8')

    const results = await validateAll([join(stagingDir, 'a.yaml'), join(stagingDir, 'b.yaml')])
    expect(results).toEqual([])
  })

  test('passes when the combined content has all required terms across files', async () => {
    const stagingDir = join(tmpRoot, 'staging-split')
    await mkdir(stagingDir, { recursive: true })

    // Term 1 and 2 in file a, term 3 and 4 in file b — combined, all present.
    await writeFile(join(stagingDir, 'a.yaml'), 'unsloth/Qwen3.6-35B-A3B-NVFP4\nqwen36-flamingo', 'utf8')
    await writeFile(join(stagingDir, 'b.yaml'), 'qwen3\nqwen3_coder', 'utf8')

    const results = await validateAll([join(stagingDir, 'a.yaml'), join(stagingDir, 'b.yaml')])
    expect(results).toEqual([])
  })

  test('fails with combined-required-term check when all files are individually clean but collectively missing one term', async () => {
    const stagingDir = join(tmpRoot, 'staging-collective')
    await mkdir(stagingDir, { recursive: true })

    // No file individually has qwen3_coder, so the combined check fails.
    await writeFile(join(stagingDir, 'a.yaml'), 'unsloth/Qwen3.6-35B-A3B-NVFP4\nqwen36-flamingo\nqwen3', 'utf8')
    await writeFile(join(stagingDir, 'b.yaml'), 'unsloth/Qwen3.6-35B-A3B-NVFP4\nqwen36-flamingo\nqwen3', 'utf8')

    const results = await validateAll([join(stagingDir, 'a.yaml'), join(stagingDir, 'b.yaml')])
    expect(results).toHaveLength(1)
    expect(results[0]).toContain('required term "qwen3_coder"')
    // Combined check does NOT include a file path
    expect(results[0]).not.toContain(':')
  })
})

// ── End-to-end: current repository surfaces pass ───────────────────────────

describe('repository surfaces', () => {
  test('TARGET_FILES is a non-empty array', () => {
    expect(TARGET_FILES.length).toBeGreaterThan(0)
  })

  test('all TARGET_FILES exist in the repository', async () => {
    for (const filePath of TARGET_FILES) {
      const content = await readFile(filePath, 'utf8')
      expect(content.length).toBeGreaterThan(0)
    }
  })

  test('current repository surfaces pass validation', async () => {
    const results = await validateAll()
    expect(results).toEqual([])
  })
})
