import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createOpenWebUiRenderBlob,
  getOpenWebUiRenderStore,
  resetOpenWebUiRenderStoreForTests,
} from '~/server/openwebui-render-store'
import { createSignedOpenWebUIRenderHref } from '~/server/openwebui-render-signing'

describe('getOpenWebUIRenderHandler', () => {
  const previousEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    previousEnv.JANGAR_CHAT_STATE_BACKEND = process.env.JANGAR_CHAT_STATE_BACKEND
    previousEnv.JANGAR_OPENWEBUI_RENDER_SIGNING_SECRET = process.env.JANGAR_OPENWEBUI_RENDER_SIGNING_SECRET
    process.env.JANGAR_CHAT_STATE_BACKEND = 'memory'
    process.env.JANGAR_OPENWEBUI_RENDER_SIGNING_SECRET = 'test-secret'
  })

  afterEach(async () => {
    await resetOpenWebUiRenderStoreForTests()

    if (previousEnv.JANGAR_CHAT_STATE_BACKEND === undefined) {
      delete process.env.JANGAR_CHAT_STATE_BACKEND
    } else {
      process.env.JANGAR_CHAT_STATE_BACKEND = previousEnv.JANGAR_CHAT_STATE_BACKEND
    }

    if (previousEnv.JANGAR_OPENWEBUI_RENDER_SIGNING_SECRET === undefined) {
      delete process.env.JANGAR_OPENWEBUI_RENDER_SIGNING_SECRET
    } else {
      process.env.JANGAR_OPENWEBUI_RENDER_SIGNING_SECRET = previousEnv.JANGAR_OPENWEBUI_RENDER_SIGNING_SECRET
    }
  })

  it('renders stored payloads when the signed URL is valid', async () => {
    const { getOpenWebUIRenderHandler } = await import('./$renderId')
    const store = getOpenWebUiRenderStore()
    const blob = createOpenWebUiRenderBlob({
      kind: 'message',
      logicalId: 'message:assistant',
      lane: 'message',
      payload: { text: 'full rich payload' },
      preview: { title: 'assistant', subtitle: 'message', badge: 'message' },
      messageBindingHash: 'binding-1',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })

    await store.setRenderBlob(blob)

    const href = createSignedOpenWebUIRenderHref({
      baseUrl: 'https://jangar.test',
      renderId: blob.renderId,
      kind: blob.kind,
      expiresAt: blob.expiresAt,
      messageBindingHash: blob.messageBindingHash,
      secret: 'test-secret',
    })

    const response = await getOpenWebUIRenderHandler(new Request(href), blob.renderId)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('content-disposition')).toBe('inline')
    expect(await response.text()).toContain('full rich payload')
  })

  it('rejects invalid signatures', async () => {
    const { getOpenWebUIRenderHandler } = await import('./$renderId')
    const store = getOpenWebUiRenderStore()
    const blob = createOpenWebUiRenderBlob({
      kind: 'tool',
      logicalId: 'tool:command-1',
      lane: 'tool',
      payload: { text: 'secret payload' },
      preview: { title: 'command', badge: 'command' },
      messageBindingHash: 'binding-2',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })

    await store.setRenderBlob(blob)

    const response = await getOpenWebUIRenderHandler(
      new Request(`https://jangar.test/api/openwebui/rich-ui/render/${blob.renderId}?e=9999999999&sig=bad`),
      blob.renderId,
    )

    expect(response.status).toBe(404)
    expect(await response.text()).toContain('Render Unavailable')
  })
})
