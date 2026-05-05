import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

const dockerfilePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'Dockerfile')

describe('oirat Dockerfile', () => {
  test('uses the mirrored Bun base image by default', async () => {
    const dockerfile = await readFile(dockerfilePath, 'utf8')

    expect(dockerfile).toContain('ARG BUN_BASE_IMAGE=mirror.gcr.io/oven/bun')
    expect(dockerfile).toContain('FROM ${BUN_BASE_IMAGE}:${BUN_VERSION} AS deps')
    expect(dockerfile).toContain('FROM ${BUN_BASE_IMAGE}:${BUN_VERSION} AS deps-prod')
    expect(dockerfile).toContain('FROM ${BUN_BASE_IMAGE}:${BUN_VERSION} AS runner')
    expect(dockerfile).not.toMatch(/^FROM oven\/bun:/m)
  })

  test('copies Discord workspace production dependencies into the runtime image', async () => {
    const dockerfile = await readFile(dockerfilePath, 'utf8')
    const distCopy = 'COPY --from=build /app/packages/discord/dist ./packages/discord/dist'
    const depsCopy = 'COPY --from=deps-prod /app/packages/discord/node_modules ./packages/discord/node_modules'

    expect(dockerfile).toContain(distCopy)
    expect(dockerfile).toContain(depsCopy)
    expect(dockerfile.indexOf(depsCopy)).toBeGreaterThan(dockerfile.indexOf(distCopy))
  })
})
