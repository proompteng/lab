import { describe, expect, it, vi } from 'vitest'

import { parseMemoryOperationPayload, postMemoryOperationsHandler } from './memory-operations'

const request = (body: Record<string, unknown>) =>
  new Request('http://agents.local/v1/memory-operations', {
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'memory-op-1',
    },
    method: 'POST',
  })

const json = async (response: Response) => response.json() as Promise<Record<string, unknown>>

describe('memory operations API', () => {
  it('parses namespace-qualified memory refs for operation payloads', () => {
    expect(
      parseMemoryOperationPayload({
        memoryRef: 'research/agent-memory',
        operation: 'query',
        query: 'find notes',
        limit: 3,
      }),
    ).toEqual({
      memoryRef: 'agent-memory',
      namespace: 'research',
      operation: 'query',
      query: 'find notes',
      limit: 3,
    })
  })

  it('writes events through the Agents-owned memory provider', async () => {
    const connection = {
      dataset: 'agent-memory',
      schema: 'public',
      embeddingDimension: 1536,
      connectionString: 'postgresql://agents-memory',
    }
    const resolveMemoryConnection = vi.fn(async () => connection)
    const writeMemoryEvent = vi.fn(async () => undefined)

    const response = await postMemoryOperationsHandler(
      request({
        memoryRef: 'agent-memory',
        namespace: 'agents',
        operation: 'event',
        eventType: 'sync-started',
        payload: { ok: true },
      }),
      {
        kubeClient: {} as never,
        resolveMemoryConnection,
        writeMemoryEvent,
      },
    )

    await expect(json(response)).resolves.toMatchObject({
      ok: true,
      operation: 'event',
      memoryRef: 'agent-memory',
      namespace: 'agents',
    })
    expect(resolveMemoryConnection).toHaveBeenCalledWith('agent-memory', 'agents', {})
    expect(writeMemoryEvent).toHaveBeenCalledWith(connection, 'sync-started', { ok: true })
  })

  it('runs memory queries without requiring mutation leadership', async () => {
    const connection = {
      dataset: 'agent-memory',
      schema: 'public',
      embeddingDimension: 1536,
      connectionString: 'postgresql://agents-memory',
    }
    const requireLeaderForMutation = vi.fn(() => new Response('not leader', { status: 409 }))
    const queryMemory = vi.fn(async () => [{ key: 'note-1', score: 0.9, metadata: { source: 'test' } }])

    const response = await postMemoryOperationsHandler(
      request({
        memoryRef: 'agent-memory',
        namespace: 'agents',
        operation: 'query',
        query: 'find notes',
        limit: 5,
      }),
      {
        kubeClient: {} as never,
        requireLeaderForMutation,
        resolveMemoryConnection: vi.fn(async () => connection),
        queryMemory,
      },
    )

    await expect(json(response)).resolves.toMatchObject({
      ok: true,
      operation: 'query',
      results: [{ key: 'note-1', score: 0.9, metadata: { source: 'test' } }],
    })
    expect(requireLeaderForMutation).not.toHaveBeenCalled()
    expect(queryMemory).toHaveBeenCalledWith(connection, 'find notes', 5)
  })

  it('runs embedding index maintenance through the leader-gated operation path', async () => {
    const connection = {
      dataset: 'agent-memory',
      schema: 'public',
      embeddingDimension: 1536,
      connectionString: 'postgresql://agents-memory',
    }
    const requireLeaderForMutation = vi.fn(() => null)
    const createMemoryEmbeddingIndexIfReady = vi.fn(async () => true)

    const response = await postMemoryOperationsHandler(
      request({
        memoryRef: 'agent-memory',
        namespace: 'agents',
        operation: 'embedding-index',
      }),
      {
        kubeClient: {} as never,
        requireLeaderForMutation,
        resolveMemoryConnection: vi.fn(async () => connection),
        createMemoryEmbeddingIndexIfReady,
      },
    )

    await expect(json(response)).resolves.toMatchObject({
      ok: true,
      operation: 'embedding-index',
      created: true,
    })
    expect(requireLeaderForMutation).toHaveBeenCalled()
    expect(createMemoryEmbeddingIndexIfReady).toHaveBeenCalledWith(connection)
  })

  it('gates memory mutations on the elected Agents leader', async () => {
    const response = await postMemoryOperationsHandler(
      request({
        memoryRef: 'agent-memory',
        namespace: 'agents',
        operation: 'kv',
        key: 'last-run',
        value: { id: 'run-1' },
      }),
      {
        kubeClient: {} as never,
        requireLeaderForMutation: () => new Response('not leader', { status: 409 }),
        resolveMemoryConnection: vi.fn(async () => ({
          dataset: 'agent-memory',
          schema: 'public',
          embeddingDimension: 1536,
          connectionString: 'postgresql://agents-memory',
        })),
      },
    )

    expect(response.status).toBe(409)
  })
})
