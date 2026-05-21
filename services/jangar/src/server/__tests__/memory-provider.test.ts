import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  closeMemoryProviderPools,
  queryMemory,
  resolveMemoryConnection,
  writeMemoryEmbedding,
  writeMemoryEvent,
  writeMemoryKv,
} from '~/server/memory-provider'

describe('memory-provider Agents service client', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env = {
      ...originalEnv,
      AGENTS_SERVICE_BASE_URL: 'http://agents.test',
      AGENTS_SERVICE_CLIENT_NAME: 'jangar-memory-provider-test',
    }
  })

  afterEach(async () => {
    process.env = { ...originalEnv }
    await closeMemoryProviderPools()
    vi.unstubAllGlobals()
  })

  it('resolves Memory metadata through Agents without reading backing Secrets locally', async () => {
    const getMemoryResource = vi.fn(async () => ({
      spec: {
        type: 'postgres',
        connection: {
          secretRef: {
            name: 'agents-db-app',
            key: 'uri',
          },
        },
      },
    }))

    await expect(resolveMemoryConnection('agent-memory', 'agents', undefined, { getMemoryResource })).resolves.toEqual({
      memoryRef: 'agent-memory',
      namespace: 'agents',
    })

    expect(getMemoryResource).toHaveBeenCalledWith('agent-memory', 'agents')
  })

  it('submits memory writes and queries through the Agents memory operation API', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            kind: 'Memory',
            namespace: 'agents',
            resource: { kind: 'Memory', metadata: { name: 'agent-memory' }, spec: { type: 'postgres' } },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, operation: 'event' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, operation: 'kv' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, operation: 'embedding' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            operation: 'query',
            results: [{ key: 'note-1', score: 0.91, metadata: { source: 'test' } }],
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    const connection = await resolveMemoryConnection('agent-memory', 'agents')
    await writeMemoryEvent(connection, 'sync-started', { ok: true })
    await writeMemoryKv(connection, 'last-run', { id: 'run-1' })
    await writeMemoryEmbedding(connection, 'note-1', 'hello world', { source: 'test' })
    await expect(queryMemory(connection, 'hello', 5)).resolves.toEqual([
      { key: 'note-1', score: 0.91, metadata: { source: 'test' } },
    ])

    const calls = fetchMock.mock.calls as unknown as [URL, RequestInit][]
    expect(calls[0]?.[0].toString()).toBe('http://agents.test/v1/memories/resources?name=agent-memory&namespace=agents')
    expect(calls.slice(1).map(([url]) => url.toString())).toEqual([
      'http://agents.test/v1/memory-operations',
      'http://agents.test/v1/memory-operations',
      'http://agents.test/v1/memory-operations',
      'http://agents.test/v1/memory-operations',
    ])
    expect(calls.slice(1).map(([, init]) => init.method)).toEqual(['POST', 'POST', 'POST', 'POST'])
    expect(calls.slice(1).map(([, init]) => (init.headers as Record<string, string>)['x-agents-client'])).toEqual([
      'jangar-memory-provider-test',
      'jangar-memory-provider-test',
      'jangar-memory-provider-test',
      'jangar-memory-provider-test',
    ])
    expect(
      calls.slice(1).every(([, init]) => Boolean((init.headers as Record<string, string>)['idempotency-key'])),
    ).toBe(true)
    expect(calls.slice(1).map(([, init]) => JSON.parse(String(init.body)))).toEqual([
      {
        memoryRef: 'agent-memory',
        namespace: 'agents',
        operation: 'event',
        eventType: 'sync-started',
        payload: { ok: true },
      },
      {
        memoryRef: 'agent-memory',
        namespace: 'agents',
        operation: 'kv',
        key: 'last-run',
        value: { id: 'run-1' },
      },
      {
        memoryRef: 'agent-memory',
        namespace: 'agents',
        operation: 'embedding',
        key: 'note-1',
        text: 'hello world',
        metadata: { source: 'test' },
      },
      {
        memoryRef: 'agent-memory',
        namespace: 'agents',
        operation: 'query',
        query: 'hello',
        limit: 5,
      },
    ])
  })
})
