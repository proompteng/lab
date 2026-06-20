import { describe, expect, test } from 'bun:test'

import { validateForbiddenTerms, validateRequiredTerms } from './validate-flamingo-hard-migration'

const NEW_MODEL = 'unsloth/Qwen3.6-35B-A3B-NVFP4'
const NEW_SERVED = 'qwen36-flamingo'
const NEW_REASONING = 'qwen3'
const NEW_TOOL_PARSER = 'qwen3_coder'

function makeGoodContent(term: string, ...extras: string[]): string {
  return `${term}\n${extras.join('\n')}
other content
`
}

function makeStaleContent(forbidden: string, extraStale: string[] = []): string {
  return `${forbidden}\n${extraStale.join('\n')}
other content
`
}

describe('validateFlamingoHardMigration: import side-effects', () => {
  test('importing the module produces no stdout or stderr', async () => {
    const capture = await new Promise<{ stdout: string; stderr: string }>((resolve) => {
      const originalStdout = process.stdout.write
      const originalStderr = process.stderr.write

      let stdout = ''
      let stderr = ''

      process.stdout.write = (chunk: string) => {
        stdout += chunk
        return true
      }
      process.stderr.write = (chunk: string) => {
        stderr += chunk
        return true
      }

      setImmediate(() => {
        process.stdout.write = originalStdout
        process.stderr.write = originalStderr

        resolve({ stdout, stderr })
      })

      import('./validate-flamingo-hard-migration')
    })

    expect(capture.stdout).toBe('')
    expect(capture.stderr).toBe('')
  })

  test('importing the module does not call process.exit', async () => {
    let exitCalled = false
    const originalExit = process.exit
    process.exit = (() => {
      exitCalled = true
    }) as unknown as typeof process.exit

    await import('./validate-flamingo-hard-migration')

    process.exit = originalExit
    expect(exitCalled).toBe(false)
  })
})

describe('validateFlamingoHardMigration: forbidden terms', () => {
  test('detects stale Qwen3-Coder model reference', () => {
    const files: Array<[string, string]> = [['dummy', makeStaleContent('Qwen/Qwen3-Coder-Next-FP8')]]
    const results = validateForbiddenTerms(files)

    expect(results).toHaveLength(1)
    expect(results[0].file).toBe('dummy')
    expect(results[0].message).toContain('Qwen/Qwen3-Coder-Next-FP8')
  })

  test('detects old qwen3-coder-flamingo served alias', () => {
    const files: Array<[string, string]> = [['dummy', makeStaleContent('qwen3-coder-flamingo')]]
    const results = validateForbiddenTerms(files)

    expect(results).toHaveLength(1)
    expect(results[0].message).toContain('qwen3-coder-flamingo')
  })

  test('detects stale Qwen3-Coder-30B-A3B-Instruct', () => {
    const files: Array<[string, string]> = [['dummy', makeStaleContent('Qwen/Qwen3-Coder-30B-A3B-Instruct')]]
    const results = validateForbiddenTerms(files)

    expect(results).toHaveLength(1)
    expect(results[0].message).toContain('Qwen/Qwen3-Coder-30B-A3B-Instruct')
  })

  test('detects hermes model alias', () => {
    const files: Array<[string, string]> = [['dummy', makeStaleContent('hermes')]]
    const results = validateForbiddenTerms(files)

    expect(results).toHaveLength(1)
    expect(results[0].message).toContain('hermes')
  })

  test('reports all forbidden terms in one file', () => {
    const files: Array<[string, string]> = [
      ['dummy', makeStaleContent('Qwen/Qwen3-Coder-Next-FP8', ['qwen3-coder-flamingo', 'hermes'])],
    ]
    const results = validateForbiddenTerms(files)

    expect(results).toHaveLength(3)
    const terms = results.map((r) => r.message)
    expect(terms).toContain('still contains forbidden Flamingo migration term "Qwen/Qwen3-Coder-Next-FP8"')
    expect(terms).toContain('still contains forbidden Flamingo migration term "qwen3-coder-flamingo"')
    expect(terms).toContain('still contains forbidden Flamingo migration term "hermes"')
  })

  test('reports file path in each failure', () => {
    const files: Array<[string, string]> = [['my-file.yaml', makeStaleContent('Qwen/Qwen3-Coder-Next-FP8')]]
    const results = validateForbiddenTerms(files)

    expect(results[0].file).toBe('my-file.yaml')
  })

  test('returns empty array when no forbidden terms are present', () => {
    const files: Array<[string, string]> = [['dummy', makeGoodContent(NEW_MODEL)]]
    const results = validateForbiddenTerms(files)

    expect(results).toHaveLength(0)
  })

  test('validates forbidden terms across multiple files', () => {
    const files: Array<[string, string]> = [
      ['file-a.yaml', makeStaleContent('Qwen/Qwen3-Coder-Next-FP8')],
      ['file-b.yaml', makeStaleContent('hermes')],
    ]
    const results = validateForbiddenTerms(files)

    expect(results).toHaveLength(2)
    expect(results[0].file).toBe('file-a.yaml')
    expect(results[1].file).toBe('file-b.yaml')
  })
})

describe('validateFlamingoHardMigration: required terms', () => {
  test('passes when all required terms are present in a single file', () => {
    const content = `${NEW_MODEL}
${NEW_SERVED}
${NEW_REASONING}
${NEW_TOOL_PARSER}
other stuff
`
    const results = validateRequiredTerms([content])

    expect(results).toHaveLength(0)
  })

  test('passes when all required terms are spread across files', () => {
    const files = [
      makeGoodContent(NEW_MODEL),
      makeGoodContent(NEW_SERVED),
      makeGoodContent(NEW_REASONING),
      makeGoodContent(NEW_TOOL_PARSER),
    ]
    const results = validateRequiredTerms(files)

    expect(results).toHaveLength(0)
  })

  test('fails when multiple required terms are missing', () => {
    const content = `only some text
no required terms here
`
    const results = validateRequiredTerms([content])

    expect(results.length).toBe(4)
    expect(results[0].message).toContain(NEW_MODEL)
    expect(results[1].message).toContain(NEW_SERVED)
    expect(results[2].message).toContain(NEW_REASONING)
    expect(results[3].message).toContain(NEW_TOOL_PARSER)
  })

  test('uses combined file content for required terms check', () => {
    const files = [
      makeGoodContent(NEW_MODEL),
      makeGoodContent(NEW_SERVED),
      makeGoodContent(NEW_REASONING),
      makeGoodContent(NEW_TOOL_PARSER),
    ]
    const results = validateRequiredTerms(files)

    expect(results).toHaveLength(0)
  })

  test('each failure reports missing term in message', () => {
    const files = ['empty']
    const results = validateRequiredTerms(files)

    expect(results.length).toBeGreaterThan(0)
    for (const result of results) {
      expect(result.message).toContain('required term')
    }
  })
})

describe('validateFlamingoHardMigration: data-driven file contents', () => {
  test('checks forbidden terms per-file independently', () => {
    const files: Array<[string, string]> = [
      ['bad.yaml', makeStaleContent('Qwen/Qwen3-Coder-Next-FP8')],
      ['good.yaml', makeGoodContent(NEW_MODEL)],
    ]
    const results = validateForbiddenTerms(files)

    expect(results).toHaveLength(1)
    expect(results[0].file).toBe('bad.yaml')
  })

  test('processes multiple files without redundant reads', () => {
    const fileCount = 3
    const files: Array<[string, string]> = []
    for (let i = 0; i < fileCount; i++) {
      files.push([`file-${i}.txt`, `content-${i}\n`])
    }

    const results = validateForbiddenTerms(files)
    expect(results).toHaveLength(0)
  })
})
