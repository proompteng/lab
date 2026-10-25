import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createFileOpenWebUiRenderStore, createOpenWebUiRenderBlob } from '~/server/openwebui-render-store'

describe('openwebui render store', () => {
  let tempDirectory: string | null = null

  afterEach(async () => {
    if (!tempDirectory) return
    await rm(tempDirectory, { recursive: true, force: true })
    tempDirectory = null
  })

  it('shares staged blobs across file-backed store instances', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'jangar-openwebui-render-store-'))
    const writer = createFileOpenWebUiRenderStore({ directory: tempDirectory, prefix: 'render-test' })
    const reader = createFileOpenWebUiRenderStore({ directory: tempDirectory, prefix: 'render-test' })
    const blob = createOpenWebUiRenderBlob({
      kind: 'json',
      logicalId: 'tool:mcp-mcp-1',
      lane: 'tool',
      payload: {
        format: 'json',
        result: {
          items: ['catalog item 1', 'catalog item 2'],
        },
      },
      messageBindingHash: 'binding-hash',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })

    await writer.setRenderBlob(blob)

    await expect(reader.getRenderBlob(blob.renderId)).resolves.toEqual(blob)
  })
})
