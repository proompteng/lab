import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { __private } from './synth'

describe('transactional synthesis output', () => {
  it('replaces a complete generated directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'k8s-swap-'))
    const output = join(root, 'generated')
    const prepared = join(root, 'prepared')
    mkdirSync(output)
    mkdirSync(prepared)
    writeFileSync(join(output, 'old.yaml'), 'old')
    writeFileSync(join(prepared, 'new.yaml'), 'new')

    try {
      __private.swapPreparedDirectory(output, prepared)
      expect(readFileSync(join(output, 'new.yaml'), 'utf8')).toBe('new')
      expect(__private.listFiles(output)).toEqual(['new.yaml'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores the prior output when the replacement cannot be installed', () => {
    const root = mkdtempSync(join(tmpdir(), 'k8s-swap-'))
    const output = join(root, 'generated')
    mkdirSync(output)
    writeFileSync(join(output, 'stable.yaml'), 'stable')

    try {
      expect(() => __private.swapPreparedDirectory(output, join(root, 'missing'))).toThrow()
      expect(readFileSync(join(output, 'stable.yaml'), 'utf8')).toBe('stable')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
