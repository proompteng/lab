import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('worker entrypoint', () => {
  it('avoids tsconfig path aliases that bun cannot resolve at runtime', () => {
    const source = readFileSync(new URL('../worker.ts', import.meta.url), 'utf8')

    expect(source).not.toContain("from '~/")
    expect(source).not.toContain('from "~/')
    expect(source).not.toContain("from '@/")
    expect(source).not.toContain('from "@/')
  })
})
