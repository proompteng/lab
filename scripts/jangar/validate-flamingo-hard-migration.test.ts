import { describe, expect, test } from 'bun:test'

import { checkForbiddenTerms, checkRequiredTerms, validateMigration } from './validate-flamingo-hard-migration'

describe('validate-flamingo-hard-migration', () => {
  test('importing the module produces no stdout or stderr output', async () => {
    let capturedStdout = ''
    let capturedStderr = ''
    let exitCode: number | undefined

    const originalExit = process.exit
    const originalWrite = process.stdout.write
    const originalWriteErr = process.stderr.write

    process.stdout.write = (chunk: string | Uint8Array | Buffer) => {
      capturedStdout += String(chunk)
      return true
    }
    process.stderr.write = (chunk: string | Uint8Array | Buffer) => {
      capturedStderr += String(chunk)
      return true
    }
    const _originalExit = process.exit
    process.exit = ((_code?: number) => {
      exitCode = _code
    }) as never

    await import('./validate-flamingo-hard-migration')

    process.stdout.write = originalWrite
    process.stderr.write = originalWriteErr
    process.exit = originalExit

    expect(capturedStdout).toBe('')
    expect(capturedStderr).toBe('')
    expect(exitCode).toBeUndefined()
  })

  test('checkForbiddenTerms catches stale Qwen3-Coder model reference', () => {
    const result = checkForbiddenTerms('Qwen/Qwen3-Coder-Next-FP8', 'test.yaml')
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('Qwen/Qwen3-Coder-Next-FP8')
    expect(result[0]).toContain('test.yaml')
  })

  test('checkForbiddenTerms catches old served alias qwen3-coder-flamingo', () => {
    const result = checkForbiddenTerms('qwen3-coder-flamingo', 'test.yaml')
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('qwen3-coder-flamingo')
  })

  test('checkForbiddenTerms catches stale hermes reference', () => {
    const result = checkForbiddenTerms('hermes', 'test.yaml')
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('hermes')
  })

  test('checkForbiddenTerms catches stale qwen3_xml reference', () => {
    const result = checkForbiddenTerms('qwen3_xml', 'test.yaml')
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('qwen3_xml')
  })

  test('checkForbiddenTerms catches Qwen/Qwen3-Coder-30B-A3B-Instruct', () => {
    const result = checkForbiddenTerms('Qwen/Qwen3-Coder-30B-A3B-Instruct', 'test.yaml')
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('Qwen/Qwen3-Coder-30B-A3B-Instruct')
  })

  test('checkForbiddenTerms returns empty for clean content', () => {
    const result = checkForbiddenTerms(
      'unsloth/Qwen3.6-35B-A3B-NVFP4\nqwen36-flamingo\nqwen3\nqwen3_coder',
      'test.yaml',
    )
    expect(result).toHaveLength(0)
  })

  test('checkForbiddenTerms catches all forbidden terms in one file', () => {
    const content = 'qwen3-coder-flamingo\nhermes\nqwen3_xml'
    const result = checkForbiddenTerms(content, 'test.yaml')
    expect(result.length).toBeGreaterThanOrEqual(3)
    expect(result).toEqual(
      expect.arrayContaining([expect.stringContaining('qwen3-coder-flamingo'), expect.stringContaining('hermes')]),
    )
  })

  test('checkRequiredTerms catches missing required terms', () => {
    // 'qwen36-flamingo' contains 'qwen3' as substring, so only 2 are truly missing
    const result = checkRequiredTerms([{ path: 'a', content: 'qwen36-flamingo' }])
    expect(result.length).toBe(2)
    expect(result).toEqual(
      expect.arrayContaining([
        expect.stringContaining('unsloth/Qwen3.6-35B-A3B-NVFP4'),
        expect.stringContaining('qwen3_coder'),
      ]),
    )
  })

  test('checkRequiredTerms passes when all required terms present', () => {
    const combined = 'unsloth/Qwen3.6-35B-A3B-NVFP4\nqwen36-flamingo\nqwen3\nqwen3_coder'
    const result = checkRequiredTerms([{ path: 'a', content: combined }])
    expect(result).toHaveLength(0)
  })

  test('validateMigration detects forbidden terms', async () => {
    const files = [
      { path: 'a.yaml', read: () => Promise.resolve('qwen3-coder-flamingo') },
      { path: 'b.yaml', read: () => Promise.resolve('unsloth/Qwen3.6-35B-A3B-NVFP4') },
    ]
    const errors = await validateMigration(files)
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(errors.some((e) => e.includes('qwen3-coder-flamingo'))).toBe(true)
  })

  test('validateMigration detects missing required terms', async () => {
    const files = [
      { path: 'a.yaml', read: () => Promise.resolve('hermes') },
      { path: 'b.yaml', read: () => Promise.resolve('qwen36-flamingo') },
    ]
    const errors = await validateMigration(files)
    expect(errors.length).toBeGreaterThanOrEqual(3)
    expect(errors.some((e) => e.includes('unsloth/Qwen3.6-35B-A3B-NVFP4'))).toBe(true)
  })

  test('validateMigration passes for fully compliant files', async () => {
    const model = 'unsloth/Qwen3.6-35B-A3B-NVFP4'
    const served = 'qwen36-flamingo'
    const reasoning = 'qwen3'
    const toolParser = 'qwen3_coder'
    const allContent = `${model}\n${served}\n${reasoning}\n${toolParser}`

    const files = [
      { path: 'a.yaml', read: () => Promise.resolve(allContent) },
      { path: 'b.yaml', read: () => Promise.resolve(allContent) },
      { path: 'c.yaml', read: () => Promise.resolve(allContent) },
    ]
    const errors = await validateMigration(files)
    expect(errors).toHaveLength(0)
  })
})
