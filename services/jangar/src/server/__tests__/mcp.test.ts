import { Effect, pipe } from 'effect'
import { describe, expect, it } from 'vitest'

import { Atlas, type AtlasService } from '../atlas'
import { handleMcpRequestEffect } from '../mcp'

const makeAtlasService = (): AtlasService => {
  const fail = <T>() => Effect.fail(new Error('atlas unavailable')) as Effect.Effect<T, Error>
  const repository = {
    id: 'repo-1',
    name: 'proompteng/lab',
    defaultRef: 'main',
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const fileKey = {
    id: 'file-key-1',
    repositoryId: 'repo-1',
    path: 'services/agents/src/server/mcp.ts',
    createdAt: new Date().toISOString(),
  }
  const fileVersion = {
    id: 'file-version-1',
    fileKeyId: 'file-key-1',
    repositoryRef: 'main',
    repositoryCommit: null,
    contentHash: 'sha256:test',
    language: 'typescript',
    byteSize: 128,
    lineCount: 10,
    metadata: {},
    sourceTimestamp: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const chunk = {
    id: 'chunk-1',
    fileVersionId: 'file-version-1',
    chunkIndex: 0,
    startLine: 1,
    endLine: 10,
    content: 'export const handleMcpRequest = ...',
    tokenCount: 12,
    metadata: {},
    createdAt: new Date().toISOString(),
  }
  const enrichment = {
    id: 'enrichment-1',
    fileVersionId: 'file-version-1',
    chunkId: 'chunk-1',
    kind: 'note',
    source: 'test',
    content: 'Agents owns memory MCP.',
    summary: null,
    tags: ['agents'],
    metadata: {},
    createdAt: new Date().toISOString(),
    distance: 0.1,
  }
  return {
    upsertRepository: () => Effect.succeed(repository),
    getRepositoryByName: () => fail(),
    upsertFileKey: () => Effect.succeed(fileKey),
    getFileKeyByPath: () => fail(),
    upsertFileVersion: () => Effect.succeed(fileVersion),
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
    getAstPreview: () => fail(),
    search: () => Effect.succeed([{ enrichment, fileVersion, fileKey, repository }]),
    codeSearch: () =>
      Effect.succeed([
        {
          repository,
          fileKey,
          fileVersion,
          chunk,
          score: 0.1,
          signals: { semanticDistance: 0.1, lexicalRank: null, matchedIdentifiers: ['handleMcpRequest'] },
        },
      ]),
    codeSearchHealth: () =>
      Effect.succeed({
        status: 'ok',
        checkedAt: new Date().toISOString(),
        model: 'test-embedding',
        dimension: 3,
        filters: { repository: null, ref: null, pathPrefix: null, language: null },
        sample: { limit: 500, chunks: 10, embedded: 10, missing: 0, coverage: 1 },
        thresholds: { minSemanticCoverage: 0.95 },
        message: 'semantic chunk coverage is healthy',
      }),
    searchCount: () => Effect.succeed(1),
    stats: () =>
      Effect.succeed({
        repositories: 1,
        fileKeys: 1,
        fileVersions: 1,
        fileChunks: 1,
        enrichments: 1,
        embeddings: 1,
        chunkEmbeddings: 1,
      }),
    close: () => Effect.void,
  }
}

const post = async (body: unknown, headers: Record<string, string> = {}) => {
  const request = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

  const response = await Effect.runPromise(
    pipe(handleMcpRequestEffect(request), Effect.provideService(Atlas, makeAtlasService())),
  )
  const json = response.status === 202 || response.status === 204 ? null : await response.json()
  return { response, json }
}

describe('Jangar Atlas MCP handler', () => {
  it('supports initialize + tools/list', async () => {
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(init.response.status).toBe(200)
    expect(init.json?.result?.serverInfo?.name).toBe('jangar-atlas')

    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(list.response.status).toBe(200)
    expect(list.json?.result?.tools?.map((tool: { name: string }) => tool.name)).toEqual([
      'atlas_index',
      'atlas_search',
      'atlas_code_search',
      'atlas_stats',
    ])
  })

  it('supports resources/list + resources/templates/list', async () => {
    const resources = await post({ jsonrpc: '2.0', id: 1, method: 'resources/list' })
    expect(resources.response.status).toBe(200)
    expect(resources.json?.result?.resources?.[0]?.uri).toBe('atlas://config')

    const templates = await post({ jsonrpc: '2.0', id: 2, method: 'resources/templates/list' })
    expect(templates.response.status).toBe(200)
    expect(templates.json?.result?.resourceTemplates).toEqual([])
  })

  it('supports resources/read for the Atlas config resource', async () => {
    const resource = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/read',
      params: { uri: 'atlas://config' },
    })
    expect(resource.response.status).toBe(200)
    const text = resource.json?.result?.contents?.[0]?.text as string
    expect(text).toContain('"serverInfo"')
    expect(text).toContain('"jangar-atlas"')
  })

  it('supports Atlas stats and search tools', async () => {
    const stats = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atlas_stats', arguments: {} },
    })
    expect(stats.response.status).toBe(200)
    expect(stats.json?.result?.content?.[0]?.text).toContain('"repositories": 1')

    const search = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'atlas.search', arguments: { query: 'agents', limit: 5 } },
    })
    expect(search.response.status).toBe(200)
    expect(search.json?.result?.content?.[0]?.text).toContain('Agents owns memory MCP')
  })

  it('returns Atlas code-search index health with matches', async () => {
    const codeSearch = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'atlas_code_search',
        arguments: { query: 'handleMcpRequest', requireSemanticCoverage: true },
      },
    })

    expect(codeSearch.response.status).toBe(200)
    const text = codeSearch.json?.result?.content?.[0]?.text as string
    expect(text).toContain('"indexHealth"')
    expect(text).toContain('"status": "ok"')
    expect(text).toContain('handleMcpRequest')
  })

  it('returns JSON-RPC invalid params errors for malformed Atlas calls', async () => {
    const search = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'atlas_search', arguments: {} },
    })
    expect(search.response.status).toBe(200)
    expect(search.json?.error?.code).toBe(-32602)
  })

  it('handles batches with mixed successes and failures', async () => {
    const batch = await post(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'atlas_stats', arguments: {} },
        },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'atlas_search', arguments: {} },
        },
      ],
      { 'Mcp-Session-Id': 'session-1' },
    )
    expect(batch.response.status).toBe(200)
    expect(batch.response.headers.get('Mcp-Session-Id')).toBe('session-1')
    expect(Array.isArray(batch.json)).toBe(true)
    expect(batch.json?.map((item: { id: number }) => item.id)).toEqual([1, 2, 3])
    expect(batch.json?.find((item: { id: number }) => item.id === 1)?.result?.serverInfo?.name).toBe('jangar-atlas')
    expect(batch.json?.find((item: { id: number }) => item.id === 2)?.result?.content?.[0]?.text).toContain(
      '"repositories": 1',
    )
    expect(batch.json?.find((item: { id: number }) => item.id === 3)?.error?.code).toBe(-32602)
  })
})
