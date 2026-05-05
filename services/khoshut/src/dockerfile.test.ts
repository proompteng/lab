import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

const dockerfilePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'Dockerfile')

describe('khoshut Dockerfile', () => {
  test('uses the mirrored Bun base image by default', async () => {
    const dockerfile = await readFile(dockerfilePath, 'utf8')

    expect(dockerfile).toContain('ARG BUN_BASE_IMAGE=mirror.gcr.io/oven/bun')
    expect(dockerfile).toContain('FROM ${BUN_BASE_IMAGE}:${BUN_VERSION} AS deps')
    expect(dockerfile).toContain('FROM ${BUN_BASE_IMAGE}:${BUN_VERSION} AS deps-prod')
    expect(dockerfile).toContain('FROM ${BUN_BASE_IMAGE}:${BUN_VERSION} AS runner')
    expect(dockerfile).not.toMatch(/^FROM oven\/bun:/m)
  })

  test('copies production dependencies after the service source', async () => {
    const dockerfile = await readFile(dockerfilePath, 'utf8')
    const sourceCopy = 'COPY --from=build /app/services/khoshut ./services/khoshut'
    const productionNodeModulesCopy =
      'COPY --from=deps-prod /app/services/khoshut/node_modules ./services/khoshut/node_modules'

    expect(dockerfile.indexOf(sourceCopy)).toBeGreaterThan(-1)
    expect(dockerfile.indexOf(productionNodeModulesCopy)).toBeGreaterThan(dockerfile.indexOf(sourceCopy))
  })
})
