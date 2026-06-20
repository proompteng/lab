import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { validateFiles, requiredTerms, forbiddenTerms } from './validate-flamingo-hard-migration'

async function mkfile(content: string): Promise<string> {
  const id = Math.random().toString(36).slice(2)
  const dir = join('/tmp', 'flamingo-test-' + id)
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'file.txt')
  await writeFile(path, content)
  return path
}

describe('validateFiles', () => {
  it('import safety: exports are defined without side effects', () => {
    expect(typeof validateFiles).toBe('function')
    expect(Array.isArray(requiredTerms)).toBe(true)
    expect(Array.isArray(forbiddenTerms)).toBe(true)
    expect(requiredTerms.length).toBeGreaterThan(0)
    expect(forbiddenTerms.length).toBeGreaterThan(0)
  })

  it('detects missing required term', async () => {
    const path = await mkfile('some content without any terms')
    const failures = await validateFiles([path], requiredTerms, forbiddenTerms)
    expect(failures).toContain('active Flamingo surfaces do not contain required term "unsloth/Qwen3.6-35B-A3B-NVFP4"')
    expect(failures.length).toBeGreaterThan(0)
  })

  it('detects stale forbidden term', async () => {
    const path = await mkfile('contains Qwen/Qwen3-Coder-Next-FP8 here')
    const failures = await validateFiles([path], requiredTerms, forbiddenTerms)
    expect(failures).toContain(`${path}: still contains forbidden Flamingo migration term "Qwen/Qwen3-Coder-Next-FP8"`)
  })

  it('passes when all terms are satisfied', async () => {
    const path = await mkfile(requiredTerms.join('\n'))
    const failures = await validateFiles([path], requiredTerms, forbiddenTerms)
    expect(failures).toEqual([])
  })

  it('detects multiple forbidden terms in one file', async () => {
    const path = await mkfile([forbiddenTerms[0], forbiddenTerms[1], forbiddenTerms[2]].join('\n'))
    const failures = await validateFiles([path], requiredTerms, forbiddenTerms)
    // 3 forbidden + 3 missing required (qwen3 is substring of qwen3-coder-flamingo)
    expect(failures.length).toBe(6)
    expect(failures).toContain(`${path}: still contains forbidden Flamingo migration term "${forbiddenTerms[0]}"`)
    expect(failures).toContain(`${path}: still contains forbidden Flamingo migration term "${forbiddenTerms[1]}"`)
    expect(failures).toContain(`${path}: still contains forbidden Flamingo migration term "${forbiddenTerms[2]}"`)
  })

  it('reports all missing required terms', async () => {
    const path = await mkfile(requiredTerms[0] + '\n' + forbiddenTerms[0])
    const failures = await validateFiles([path], requiredTerms, forbiddenTerms)
    expect(failures).toContain('active Flamingo surfaces do not contain required term "qwen36-flamingo"')
    expect(failures).toContain('active Flamingo surfaces do not contain required term "qwen3"')
    expect(failures).toContain('active Flamingo surfaces do not contain required term "qwen3_coder"')
    expect(failures).toContain(`${path}: still contains forbidden Flamingo migration term "Qwen/Qwen3-Coder-Next-FP8"`)
    expect(failures.length).toBe(4)
  })
})
