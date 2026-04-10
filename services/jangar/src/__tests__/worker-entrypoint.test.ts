import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('worker entrypoint', () => {
  it('uses a runtime-resolvable local import for worker config', () => {
    const workerUrl = new URL('../worker.ts', import.meta.url)
    const workerPath = fileURLToPath(workerUrl)
    const source = readFileSync(workerUrl, 'utf8')
    const importMatch = source.match(/from '(\.\/server\/runtime-entry-config(?:\.ts)?)'/)
    const importPath = importMatch?.[1]

    expect(importPath).toBe('./server/runtime-entry-config')
    expect(existsSync(resolve(dirname(workerPath), `${importPath!}.ts`))).toBe(true)
  })

  it('avoids tsconfig path aliases that bun cannot resolve at runtime', () => {
    const source = readFileSync(new URL('../worker.ts', import.meta.url), 'utf8')

    expect(source).not.toContain("from '~/")
    expect(source).not.toContain('from "~/')
    expect(source).not.toContain("from '@/")
    expect(source).not.toContain('from "@/')
  })

  it('copies worker runtime config into both runtime images', () => {
    const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8')
    const copyDirective =
      'COPY --from=jangar-build /app/services/jangar/src/server/runtime-entry-config.ts ./src/server/runtime-entry-config.ts'
    const matches = dockerfile.match(new RegExp(copyDirective.replaceAll('/', '\\/'), 'g')) ?? []

    expect(matches).toHaveLength(2)
  })
})
