import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

const dockerfilePath = resolve(import.meta.dir, '..', 'Dockerfile')

describe('Bayn image contract', () => {
  test('pins Bun and installs from the lockfile reproducibly', async () => {
    const dockerfile = await readFile(dockerfilePath, 'utf8')

    expect(dockerfile).toContain(
      'mirror.gcr.io/oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4',
    )
    expect(dockerfile).toContain(
      'bun install --production --frozen-lockfile --ignore-scripts --filter @proompteng/bayn',
    )
    expect(dockerfile).toContain("process.env.BAYN_PORT ?? '8080'")
    expect(dockerfile).toContain('USER bun')
    expect(dockerfile).not.toMatch(/^FROM oven\/bun:/m)
  })
})
