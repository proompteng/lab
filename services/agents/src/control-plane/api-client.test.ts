import { afterEach, describe, expect, it, vi } from 'vitest'

import { createIdempotencyKey, createPrimitiveResource, fetchAgentRunLogs, fetchPrimitiveEvents } from './api-client'

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

  it('fetches AgentRun logs with namespace, name, and tail line controls', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://agents.test' } })
    const fetchCalls: URL[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      fetchCalls.push(input as URL)
      return new Response(
        JSON.stringify({
          ok: true,
          name: 'run-1',
          namespace: 'agents',
          pods: [],
          logs: '',
          pod: null,
          container: null,
          tailLines: 200,
        }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    await fetchAgentRunLogs({ namespace: 'agents', name: 'run-1', tailLines: 200 })

    const url = fetchCalls[0]
    expect(url.pathname).toBe('/v1/control-plane/logs')
    expect(url.searchParams.get('namespace')).toBe('agents')
    expect(url.searchParams.get('name')).toBe('run-1')
    expect(url.searchParams.get('tailLines')).toBe('200')
  })

  it('fetches AgentRun events with uid and limit filters', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://agents.test' } })
    const fetchCalls: URL[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      fetchCalls.push(input as URL)
      return new Response(JSON.stringify({ ok: true, kind: 'AgentRun', namespace: 'agents', name: 'run-1', items: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    await fetchPrimitiveEvents({ kind: 'AgentRun', namespace: 'agents', name: 'run-1', uid: 'uid-1', limit: 75 })

    const url = fetchCalls[0]
    expect(url.pathname).toBe('/v1/control-plane/events')
    expect(url.searchParams.get('kind')).toBe('AgentRun')
    expect(url.searchParams.get('namespace')).toBe('agents')
    expect(url.searchParams.get('name')).toBe('run-1')
    expect(url.searchParams.get('uid')).toBe('uid-1')
    expect(url.searchParams.get('limit')).toBe('75')
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
