import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

const dockerfilePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'Dockerfile')

describe('bumba Dockerfile', () => {
  test('uses the mirrored Bun base image by default', async () => {
    const dockerfile = await readFile(dockerfilePath, 'utf8')

    expect(dockerfile).toContain('ARG BUN_BASE_IMAGE=mirror.gcr.io/oven/bun')
    expect(dockerfile).toContain('FROM ${BUN_BASE_IMAGE}:${BUN_VERSION} AS deps')
    expect(dockerfile).toContain('FROM ${BUN_BASE_IMAGE}:${BUN_VERSION} AS deps-prod')
    expect(dockerfile).toContain('FROM ${BUN_BASE_IMAGE}:${BUN_VERSION} AS runner')
    expect(dockerfile).not.toMatch(/^FROM oven\/bun:/m)
  })
})

test('the Nix image runs Bumba under tini so orphaned subprocesses are reaped', async () => {
  const image = await readFile(resolve(import.meta.dir, '../../../nix/images/bumba.nix'), 'utf8')

  expect(image).toContain('pkgs.tini')
  expect(image).toMatch(/command = \[\s*"tini"\s*"-g"\s*"--"\s*"bun"/)
})
