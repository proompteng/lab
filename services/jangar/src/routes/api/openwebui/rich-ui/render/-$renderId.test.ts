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
      kind: 'text',
      logicalId: 'message:assistant',
      lane: 'message',
      payload: { format: 'text', text: 'full rich payload' },
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

  it('renders image payloads as previews', async () => {
    const { getOpenWebUIRenderHandler } = await import('./$renderId')
    const store = getOpenWebUiRenderStore()
    const blob = createOpenWebUiRenderBlob({
      kind: 'image',
      logicalId: 'tool:image-1',
      lane: 'tool',
      payload: {
        format: 'image',
        prompt: 'paint a glacier',
        imageUrl: 'https://assets.example/glacier.png',
      },
      preview: { title: 'image generation', subtitle: 'completed', badge: 'image' },
      messageBindingHash: 'binding-image',
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
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('Open original asset')
    expect(body).toContain('glacier.png')
  })

  it('escapes payload HTML and renders diff payloads with changed paths', async () => {
    const { getOpenWebUIRenderHandler } = await import('./$renderId')
    const store = getOpenWebUiRenderStore()
    const blob = createOpenWebUiRenderBlob({
      kind: 'diff',
      logicalId: 'tool:file-1',
      lane: 'tool',
      payload: {
        format: 'diff',
        paths: ['src/<unsafe>.ts'],
        text: '@@ -1 +1 @@\n-const html = "<img src=x onerror=alert(1)>"\n+const html = "<safe>"',
      },
      preview: { title: 'file changes', subtitle: 'completed', badge: 'diff' },
      messageBindingHash: 'binding-diff',
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
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('Changed Paths')
    expect(body).toContain('Unified Diff')
    expect(body).toContain('&lt;unsafe&gt;.ts')
    expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(body).not.toContain('<img src=x onerror=alert(1)>')
  })

  it('rejects invalid signatures', async () => {
    const { getOpenWebUIRenderHandler } = await import('./$renderId')
    const store = getOpenWebUiRenderStore()
    const blob = createOpenWebUiRenderBlob({
      kind: 'json',
      logicalId: 'tool:command-1',
      lane: 'tool',
      payload: { format: 'json', value: 'secret payload' },
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

  it('returns 410 for expired links', async () => {
    const { getOpenWebUIRenderHandler } = await import('./$renderId')
    const store = getOpenWebUiRenderStore()
    const blob = createOpenWebUiRenderBlob({
      kind: 'text',
      logicalId: 'message:assistant',
      lane: 'message',
      payload: { format: 'text', text: 'expired payload' },
      preview: { title: 'assistant', badge: 'message' },
      messageBindingHash: 'binding-expired',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
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

    expect(response.status).toBe(410)
    expect(await response.text()).toContain('render link has expired')
  })

  it('returns 404 when the blob is missing', async () => {
    const { getOpenWebUIRenderHandler } = await import('./$renderId')

    const response = await getOpenWebUIRenderHandler(
      new Request('https://jangar.test/api/openwebui/rich-ui/render/missing?e=1&sig=bad'),
      'missing',
    )

    expect(response.status).toBe(404)
    expect(await response.text()).toContain('render payload not found')
  })
})
