import { describe, expect, test } from 'vitest'

import {
  validateForbiddenTerms,
  validateFlamingoHardMigration,
  validateRequiredTerms,
} from './validate-flamingo-hard-migration'

const FORBIDDEN_TERMS = [
  'Qwen/Qwen3-Coder-Next-FP8',
  'qwen3-coder-flamingo',
  'Qwen/Qwen3-Coder-30B-A3B-Instruct',
  'hermes',
  'qwen3_xml',
]

const REQUIRED_TERMS = ['unsloth/Qwen3.6-35B-A3B-NVFP4', 'qwen36-flamingo', 'qwen3', 'qwen3_coder']

describe('validateFlamingoHardMigration', () => {
  test('passes when all target files are clean', async () => {
    const result = await validateFlamingoHardMigration()
    expect(result.success).toBe(true)
    expect(result.errors).toEqual([])
  })
})

describe('validateRequiredTerms', () => {
  test('returns empty array when all terms are present', () => {
    const combined = REQUIRED_TERMS.join('\n')
    const results = validateRequiredTerms(combined, REQUIRED_TERMS)
    expect(results).toEqual([])
  })

  test('reports all terms as missing when none present', () => {
    const results = validateRequiredTerms('no match', REQUIRED_TERMS)
    expect(results.length).toBe(REQUIRED_TERMS.length)
    for (const r of results) {
      expect(r.type).toBe('missing')
    }
  })

  test('reports only missing terms', () => {
    const combined = REQUIRED_TERMS[0] + '\n' + REQUIRED_TERMS[2]
    const results = validateRequiredTerms(combined, REQUIRED_TERMS)
    expect(results.length).toBe(2)
    const missingTerms = results.map((r) => r.term)
    expect(missingTerms).toContain(REQUIRED_TERMS[1])
    expect(missingTerms).toContain(REQUIRED_TERMS[3])
  })
})

describe('validateForbiddenTerms', () => {
  test('returns empty array when no forbidden terms found in file contents', () => {
    const contents = new Map<string, string>([
      ['file1.txt', 'clean content here'],
      ['file2.txt', 'more clean text'],
    ])
    const results = validateForbiddenTerms(contents, FORBIDDEN_TERMS)
    expect(results).toEqual([])
  })

  test('reports each forbidden term found with file path', () => {
    const contents = new Map<string, string>([
      ['myfile.txt', 'contains hermes and qwen3-coder-flamingo terms'],
      ['other.txt', 'clean'],
    ])
    const results = validateForbiddenTerms(contents, ['hermes', 'qwen3-coder-flamingo'])
    expect(results.length).toBe(2)
    const terms = results.map((r) => r.term)
    expect(terms).toContain('hermes')
    expect(terms).toContain('qwen3-coder-flamingo')
    // Verify file path is attached
    for (const r of results) {
      expect(r.file).toBe('myfile.txt')
    }
  })

  test('handles empty file map', () => {
    const contents = new Map<string, string>()
    const results = validateForbiddenTerms(contents, FORBIDDEN_TERMS)
    expect(results).toEqual([])
  })
})

describe('stale term rejection', () => {
  test('rejects stale Qwen3-Coder model references', () => {
    expect(FORBIDDEN_TERMS).toContain('Qwen/Qwen3-Coder-Next-FP8')
    expect(FORBIDDEN_TERMS).toContain('Qwen/Qwen3-Coder-30B-A3B-Instruct')
  })

  test('rejects old qwen3-coder-flamingo served alias', () => {
    expect(FORBIDDEN_TERMS).toContain('qwen3-coder-flamingo')
  })

  test('rejects hermes as active desired state', () => {
    expect(FORBIDDEN_TERMS).toContain('hermes')
  })

  test('rejects stale qwen3_xml', () => {
    expect(FORBIDDEN_TERMS).toContain('qwen3_xml')
  })
})

describe('active state requirements', () => {
  test('requires qwen36-flamingo served alias', () => {
    expect(REQUIRED_TERMS).toContain('qwen36-flamingo')
  })

  test('requires qwen3 reasoning parser', () => {
    expect(REQUIRED_TERMS).toContain('qwen3')
  })

  test('requires qwen3_coder tool-call parser', () => {
    expect(REQUIRED_TERMS).toContain('qwen3_coder')
  })

  test('requires unsloth model', () => {
    expect(REQUIRED_TERMS).toContain('unsloth/Qwen3.6-35B-A3B-NVFP4')
  })
})
