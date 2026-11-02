import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

const dockerfilePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'Dockerfile')

describe('froussard Dockerfile', () => {
  test('uses mirrored base images by default', async () => {
    const dockerfile = await readFile(dockerfilePath, 'utf8')

    expect(dockerfile).toContain('ARG NODE_BASE_IMAGE=mirror.gcr.io/node')
    expect(dockerfile).toContain('ARG BUN_BASE_IMAGE=mirror.gcr.io/oven/bun')
    expect(dockerfile).toContain('FROM ${NODE_BASE_IMAGE}:${NODE_VERSION}-bookworm AS base')
    expect(dockerfile).toContain('FROM ${BUN_BASE_IMAGE}:${BUN_VERSION}-slim AS runtime')
    expect(dockerfile).not.toMatch(/^FROM node:/m)
    expect(dockerfile).not.toMatch(/^FROM oven\/bun:/m)
  })
})
