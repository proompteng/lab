import { Effect, pipe } from 'effect'
import { describe, expect, it } from 'vitest'

import { Atlas, type AtlasService } from '../atlas'
import { handleMcpRequestEffect } from '../mcp'
import { Memories, type MemoriesService } from '../memories'
import type { MemoryRecord } from '../memories-store'

const makeService = (): { service: MemoriesService; saved: MemoryRecord[] } => {
  const saved: MemoryRecord[] = []

  const service: MemoriesService = {
    persist: ({ namespace, content, summary, tags }) =>
      Effect.sync(() => {
        const record: MemoryRecord = {
          id: `mem-${saved.length + 1}`,
          namespace: namespace ?? 'default',
          content,
          summary: summary ?? null,
          tags: tags ?? [],
          createdAt: new Date().toISOString(),
        }
        saved.push(record)
        return record
      }),
    retrieve: ({ namespace, query, limit }) =>
      Effect.sync(() =>
        saved
          .filter((mem) => mem.namespace === (namespace ?? 'default'))
          .filter((mem) => mem.content.includes(query) || (mem.summary ?? '').includes(query))
          .slice(0, limit ?? 10),
      ),
    count: ({ namespace } = {}) =>
      Effect.sync(() => saved.filter((mem) => (namespace ? mem.namespace === namespace : true)).length),
  }

  return { service, saved }
}

const makeAtlasService = (): AtlasService => {
  const fail = <T>() => Effect.fail(new Error('atlas unavailable')) as Effect.Effect<T, Error>
  return {
    upsertRepository: () => fail(),
    getRepositoryByName: () => fail(),
    upsertFileKey: () => fail(),
    getFileKeyByPath: () => fail(),
    upsertFileVersion: () => fail(),
    getFileVersionByKey: () => fail(),
    upsertFileChunk: () => fail(),
    upsertEnrichment: () => fail(),
    upsertEmbedding: () => fail(),
    upsertTreeSitterFact: () => fail(),
    upsertSymbol: () => fail(),
    upsertSymbolDef: () => fail(),
    upsertSymbolRef: () => fail(),
    upsertFileEdge: () => fail(),
    upsertGithubEvent: () => fail(),
    upsertIngestion: () => fail(),
    upsertEventFile: () => fail(),
    upsertIngestionTarget: () => fail(),
    listIndexedFiles: () => fail(),
    search: () => fail(),
    stats: () => fail(),
    close: () => Effect.void,
  }
}

const post = async (service: MemoriesService, body: unknown, headers: Record<string, string> = {}) => {
  const request = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

  const response = await Effect.runPromise(
    pipe(
      handleMcpRequestEffect(request),
      Effect.provideService(Memories, service),
      Effect.provideService(Atlas, makeAtlasService()),
    ),
  )
  const json = response.status === 202 || response.status === 204 ? null : await response.json()
  return { response, json }
}

describe('Memories MCP handler', () => {
  it('supports initialize + tools/list', async () => {
    const { service } = makeService()

    const init = await post(service, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(init.response.status).toBe(200)
    expect(init.json?.result?.serverInfo?.name).toBe('memories')

    const list = await post(service, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(list.response.status).toBe(200)
    expect(list.json?.result?.tools?.map((tool: { name: string }) => tool.name)).toEqual([
      'persist_memory',
      'retrieve_memory',
      'atlas.index',
      'atlas.search',
      'atlas.stats',
    ])
  })

  it('supports resources/list + resources/templates/list', async () => {
    const { service } = makeService()

    const resources = await post(service, { jsonrpc: '2.0', id: 1, method: 'resources/list' })
    expect(resources.response.status).toBe(200)
    expect(resources.json?.result?.resources?.[0]?.uri).toBe('memories://config')

    const templates = await post(service, { jsonrpc: '2.0', id: 2, method: 'resources/templates/list' })
    expect(templates.response.status).toBe(200)
    expect(templates.json?.result?.resourceTemplates).toEqual([])
  })

  it('supports resources/read for the config resource', async () => {
    const { service } = makeService()

    const resource = await post(service, {
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/read',
      params: { uri: 'memories://config' },
    })
    expect(resource.response.status).toBe(200)
    const text = resource.json?.result?.contents?.[0]?.text as string
    expect(text).toContain('"serverInfo"')
    expect(text).toContain('"memories"')
  })

  it('supports persist_memory + retrieve_memory', async () => {
    const { service } = makeService()

    const persist = await post(service, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'persist_memory', arguments: { namespace: 'n1', content: 'hello world', tags: ['a'] } },
    })
    expect(persist.response.status).toBe(200)
    expect(persist.json?.result?.content?.[0]?.type).toBe('text')

    const retrieve = await post(service, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'retrieve_memory', arguments: { namespace: 'n1', query: 'hello', limit: 5 } },
    })
    expect(retrieve.response.status).toBe(200)
    const text = retrieve.json?.result?.content?.[0]?.text as string
    expect(text).toContain('hello world')
  })

  it('returns JSON-RPC invalid params errors for missing required arguments', async () => {
    const { service } = makeService()

    const persist = await post(service, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'persist_memory', arguments: { namespace: 'n1' } },
    })
    expect(persist.response.status).toBe(200)
    expect(persist.json?.error?.code).toBe(-32602)

    const retrieve = await post(service, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'retrieve_memory', arguments: { namespace: 'n1' } },
    })
    expect(retrieve.response.status).toBe(200)
    expect(retrieve.json?.error?.code).toBe(-32602)
  })

  it('returns JSON-RPC tool errors when the underlying service fails', async () => {
    const failing: MemoriesService = {
      persist: () => Effect.fail(new Error('persist failed')),
      retrieve: () => Effect.fail(new Error('retrieve failed')),
      count: () => Effect.fail(new Error('count failed')),
    }

    const persist = await post(failing, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'persist_memory', arguments: { content: 'hello world' } },
    })
    expect(persist.response.status).toBe(200)
    expect(persist.json?.error?.code).toBe(-32000)
    expect(persist.json?.error?.message).toContain('persist failed')

    const retrieve = await post(failing, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'retrieve_memory', arguments: { query: 'hello' } },
    })
    expect(retrieve.response.status).toBe(200)
    expect(retrieve.json?.error?.code).toBe(-32000)
    expect(retrieve.json?.error?.message).toContain('retrieve failed')
  })

  it('handles batches with mixed successes and failures', async () => {
    const failing: MemoriesService = {
      persist: () => Effect.fail(new Error('persist failed')),
      retrieve: () => Effect.fail(new Error('retrieve failed')),
      count: () => Effect.fail(new Error('count failed')),
    }

    const batch = await post(
      failing,
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'persist_memory', arguments: { content: 'hello world' } },
        },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'retrieve_memory', arguments: { query: 'hello' } },
        },
      ],
      { 'Mcp-Session-Id': 'session-1' },
    )
    expect(batch.response.status).toBe(200)
    expect(batch.response.headers.get('Mcp-Session-Id')).toBe('session-1')
    expect(Array.isArray(batch.json)).toBe(true)
    expect(batch.json?.map((item: { id: number }) => item.id)).toEqual([1, 2, 3])
    expect(batch.json?.find((item: { id: number }) => item.id === 1)?.result?.serverInfo?.name).toBe('memories')
    expect(batch.json?.find((item: { id: number }) => item.id === 2)?.error?.code).toBe(-32000)
    expect(batch.json?.find((item: { id: number }) => item.id === 3)?.error?.code).toBe(-32000)
  })
})
