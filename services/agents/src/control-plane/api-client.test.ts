import { afterEach, describe, expect, it, vi } from 'vitest'

import { createIdempotencyKey, createPrimitiveResource } from './api-client'

describe('control-plane API client', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('uses crypto.randomUUID for idempotency keys when available', () => {
    vi.stubGlobal('crypto', {
      randomUUID: () => '11111111-2222-4333-8444-555555555555',
    })

    expect(createIdempotencyKey()).toBe('11111111-2222-4333-8444-555555555555')
  })

  it('creates an idempotency key when randomUUID is unavailable on non-secure origins', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
        return bytes
      },
    })

    expect(createIdempotencyKey()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f')
  })

  it('sends the fallback idempotency key when creating a primitive resource', async () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(7)
        return bytes
      },
    })

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, resource: {} })))
    vi.stubGlobal('fetch', fetchMock)

    await createPrimitiveResource('artifact', {
      apiVersion: 'artifacts.proompteng.ai/v1alpha1',
      kind: 'Artifact',
      metadata: { name: 'ui-proof', namespace: 'agents' },
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/primitives/artifact/resources',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'idempotency-key': '07070707-0707-4707-8707-070707070707',
        }),
      }),
    )
  })
})
