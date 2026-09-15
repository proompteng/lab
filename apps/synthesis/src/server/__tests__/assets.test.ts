import { afterEach, describe, expect, test, vi } from 'vitest'

import { assetResponseForAttachment, materializeAttachments } from '../assets'

describe('synthesis assets', () => {
  afterEach(() => {
    delete process.env.SYNTHESIS_ASSET_ENDPOINT
    delete process.env.SYNTHESIS_ASSET_BUCKET
    delete process.env.SYNTHESIS_ASSET_ACCESS_KEY_ID
    delete process.env.SYNTHESIS_ASSET_SECRET_ACCESS_KEY
    delete process.env.SYNTHESIS_ASSET_REGION
    delete process.env.SYNTHESIS_ASSET_STORAGE_REQUIRED
  })

  test('downloads visible media and uploads it to object storage', async () => {
    process.env.SYNTHESIS_ASSET_ENDPOINT = 'http://object.local'
    process.env.SYNTHESIS_ASSET_BUCKET = 'synthesis-assets'
    process.env.SYNTHESIS_ASSET_ACCESS_KEY_ID = 'test-access'
    process.env.SYNTHESIS_ASSET_SECRET_ACCESS_KEY = 'test-secret'
    process.env.SYNTHESIS_ASSET_REGION = 'us-east-1'
    process.env.SYNTHESIS_ASSET_STORAGE_REQUIRED = 'true'

    const uploaded: Array<{ url: string; method: string | undefined; bodyLength: number; contentType: string | null }> =
      []
    const fetchImpl: typeof fetch = async (url, init) => {
      const resolvedUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      if (resolvedUrl.startsWith('https://pbs.twimg.com/media/')) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      }
      if (resolvedUrl.startsWith('http://object.local/synthesis-assets/')) {
        const headers = new Headers(init?.headers)
        uploaded.push({
          url: resolvedUrl,
          method: init?.method,
          bodyLength: init?.body instanceof Uint8Array ? init.body.length : 0,
          contentType: headers.get('content-type'),
        })
        return new Response(null, { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }

    const attachments = await materializeAttachments(
      [
        {
          kind: 'source_image',
          url: 'https://pbs.twimg.com/media/source-chart.jpg',
          sourceUrl: 'https://x.com/example/status/1',
          generated: false,
        },
      ],
      {
        fetch: fetchImpl,
        now: () => new Date('2026-05-26T00:00:00Z'),
      },
    )

    expect(uploaded).toEqual([
      {
        url: expect.stringContaining('/synthesis-assets/synthesis/2026-05-26/'),
        method: 'PUT',
        bodyLength: 3,
        contentType: 'image/png',
      },
    ])
    expect(attachments[0]).toMatchObject({
      assetUrl: `/api/assets/${attachments[0].id}`,
      objectKey: expect.stringMatching(/^synthesis\/2026-05-26\/.+\.png$/),
      mimeType: 'image/png',
      sizeBytes: 3,
      sourceUrl: 'https://pbs.twimg.com/media/source-chart.jpg',
    })
  })

  test('serves app-owned assets with the recorded image MIME type', async () => {
    process.env.SYNTHESIS_ASSET_ENDPOINT = 'http://object.local'
    process.env.SYNTHESIS_ASSET_BUCKET = 'synthesis-assets'
    process.env.SYNTHESIS_ASSET_ACCESS_KEY_ID = 'test-access'
    process.env.SYNTHESIS_ASSET_SECRET_ACCESS_KEY = 'test-secret'
    process.env.SYNTHESIS_ASSET_REGION = 'us-east-1'

    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(async () => {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'content-type': 'binary/octet-stream' },
      })
    })
    globalThis.fetch = fetchMock as typeof fetch

    try {
      const response = await assetResponseForAttachment({
        id: 'asset-1',
        kind: 'source_screenshot',
        sourceUrl: 'https://x.com/example/status/1',
        assetUrl: '/api/assets/asset-1',
        objectKey: 'synthesis/2026-05-26/asset-1.png',
        mimeType: 'image/png',
        sizeBytes: 4,
        alt: 'source chart',
        label: 'source chart',
        generated: false,
      })

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/png')
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]))
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
