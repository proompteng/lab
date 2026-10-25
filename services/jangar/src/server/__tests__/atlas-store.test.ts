import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createPostgresAtlasStore } from '../atlas-store'
import type { Database } from '../db'

type SqlCall = { sql: string; params: readonly unknown[] }

type FakeDbOptions = {
  extensions?: string[]
  embeddingType?: string | null
  selectRows?: unknown[]
  exactRows?: unknown[]
  lexicalRows?: unknown[]
  semanticRows?: unknown[]
  scopedSemanticCandidateCount?: number
  repositoryRows?: unknown[]
  onQuery?: (call: SqlCall) => void
}

const readyRepositoryRow = {
  repository_name: 'proompteng/lab',
  repository_default_ref: 'main',
  repository_metadata: {
    indexStatus: 'ready',
    indexedCommit: 'deadbeef',
    gitHead: 'deadbeef',
    treeHash: 'tree-hash',
    embeddingModel: 'test-embedding',
    embeddingDimension: 3,
    expectedFiles: 1,
    indexedFiles: 1,
    missingPaths: 0,
    stalePaths: 0,
    hashMismatches: 0,
    uncoveredLines: 0,
    indexedChunks: 1,
    embeddedChunks: 1,
  },
}

const makeCodeSearchRow = (overrides: Partial<Record<string, unknown>> = {}) => {
  const now = new Date('2020-01-01T00:00:00.000Z')
  return {
    chunk_id: 'chunk-1',
    chunk_file_version_id: 'file-version-1',
    chunk_index: 0,
    chunk_start_line: 10,
    chunk_end_line: 16,
    chunk_content: 'const flag = process.env.BUMBA_ATLAS_CHUNK_INDEXING',
    chunk_token_count: 12,
    chunk_metadata: {},
    chunk_created_at: now,
    file_version_id: 'file-version-1',
    file_version_file_key_id: 'file-key-1',
    file_version_repository_ref: 'main',
    file_version_repository_commit: 'deadbeef',
    file_version_content_hash: 'hash-1',
    file_version_language: 'typescript',
    file_version_byte_size: 128,
    file_version_line_count: 20,
    file_version_metadata: {},
    file_version_source_timestamp: now,
    file_version_created_at: now,
    file_version_updated_at: now,
    file_key_id: 'file-key-1',
    file_key_repository_id: 'repo-1',
    file_key_path: 'services/bumba/src/workflows/index.ts',
    file_key_created_at: now,
    repository_id: 'repo-1',
    repository_name: 'proompteng/lab',
    repository_default_ref: 'main',
    repository_metadata: {},
    repository_created_at: now,
    repository_updated_at: now,
    lexical_rank: 0.42,
    ...overrides,
  }
}

const makeFakeDb = (options: FakeDbOptions = {}) => {
  const calls: SqlCall[] = []

  class TestConnection implements DatabaseConnection {
    async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
      const params = (compiledQuery.parameters ?? []) as readonly unknown[]
      const call = { sql: compiledQuery.sql, params }
      calls.push(call)
      options.onQuery?.(call)

      const normalized = compiledQuery.sql.toLowerCase()
      const now = new Date('2020-01-01T00:00:00.000Z')

      if (normalized.includes('pg_backend_pid()')) {
        return { rows: [{ backend_pid: 4242 }] as R[] }
      }

      if (normalized.includes('select extname from pg_extension')) {
        const extensions = options.extensions ?? ['vector', 'pgcrypto', 'pg_trgm']
        return { rows: extensions.map((ext) => ({ extname: ext })) as R[] }
      }

      if (normalized.includes('pg_catalog.pg_attribute') && normalized.includes("a.attname = 'embedding'")) {
        if (options.embeddingType) {
          return { rows: [{ embedding_type: options.embeddingType }] as R[] }
        }
        return { rows: [] as R[] }
      }

      if (normalized.includes('insert into "atlas"."repositories"')) {
        return {
          rows: [
            {
              id: 'repo-1',
              name: 'acme',
              default_ref: 'main',
              metadata: {},
              created_at: now,
              updated_at: now,
            },
          ] as R[],
        }
      }

      if (normalized.includes('insert into "atlas"."file_versions"')) {
        const commit = (params[2] as string | null | undefined) ?? null
        const hash = (params[3] as string | null | undefined) ?? ''
        return {
          rows: [
            {
              id: 'file-version-1',
              file_key_id: 'file-key-1',
              repository_ref: 'main',
              repository_commit: commit,
              content_hash: hash,
              language: 'typescript',
              byte_size: 128,
              line_count: 4,
              metadata: {},
              source_timestamp: null,
              created_at: now,
              updated_at: now,
            },
          ] as R[],
        }
      }

      if (normalized.includes('insert into "atlas"."enrichments"')) {
        return {
          rows: [
            {
              id: 'enrich-1',
              file_version_id: 'file-version-1',
              chunk_id: null,
              kind: 'summary',
              source: 'test',
              content: 'hello',
              summary: null,
              tags: ['smoke'],
              metadata: {},
              created_at: now,
            },
          ] as R[],
        }
      }

      if (normalized.includes('insert into "atlas"."embeddings"')) {
        return {
          rows: [
            {
              id: 'embed-1',
              enrichment_id: 'enrich-1',
              model: 'test',
              dimension: 3,
              created_at: now,
            },
          ] as R[],
        }
      }

      if (normalized.includes('kysely_migration')) {
        return { rows: [] as R[] }
      }

      if (normalized.includes('from "atlas"."repositories"')) {
        return { rows: (options.repositoryRows ?? [readyRepositoryRow]) as R[] }
      }

      if (normalized.includes(' as exact_rank')) {
        return { rows: (options.exactRows ?? options.selectRows ?? []) as R[] }
      }

      if (normalized.includes(' as lexical_rank')) {
        return { rows: (options.lexicalRows ?? options.selectRows ?? []) as R[] }
      }

      if (normalized.includes(' as candidate_count') && normalized.includes('scoped_semantic_probe')) {
        return { rows: [{ candidate_count: options.scopedSemanticCandidateCount ?? 0 }] as R[] }
      }

      if (normalized.includes('from atlas.chunk_embeddings as chunk_embeddings')) {
        return { rows: (options.semanticRows ?? options.selectRows ?? []) as R[] }
      }

      if (normalized.includes('from "atlas"."file_chunks"')) {
        return { rows: (options.selectRows ?? []) as R[] }
      }

      return { rows: [] as R[] }
    }

    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      yield* []
    }
  }

  class TestDriver implements Driver {
    async init() {}

    async acquireConnection(): Promise<DatabaseConnection> {
      return new TestConnection()
    }

    async beginTransaction() {}

    async commitTransaction() {}

    async rollbackTransaction() {}

    async releaseConnection() {}

    async destroy() {}
  }

  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new TestDriver(),
      createIntrospector: (dbInstance) => new PostgresIntrospector(dbInstance),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  })

  return { db, calls }
}

describe('atlas store', () => {
  const previousEnv: Record<string, string | undefined> = {}
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    for (const key of [
      'OPENAI_API_BASE_URL',
      'OPENAI_EMBEDDING_API_BASE_URL',
      'OPENAI_API_KEY',
      'OPENAI_EMBEDDING_MODEL',
      'OPENAI_EMBEDDING_DIMENSION',
      'OPENAI_EMBEDDING_TIMEOUT_MS',
      'ATLAS_CODE_SEARCH_EMBEDDING_MODEL',
      'ATLAS_CODE_SEARCH_EMBEDDING_DIMENSION',
      'ATLAS_CODE_SEARCH_SEMANTIC_TIMEOUT_MS',
      'ATLAS_CODE_SEARCH_STATEMENT_TIMEOUT_MS',
      'ATLAS_CODE_SEARCH_QUERY_EMBEDDING_CACHE_TTL_MS',
      'ATLAS_CODE_SEARCH_SEMANTIC_CANDIDATE_LIMIT',
      'ATLAS_CODE_SEARCH_HEALTH_SAMPLE_LIMIT',
    ]) {
      previousEnv[key] = process.env[key]
    }
    process.env.OPENAI_API_BASE_URL = 'http://chat.local/v1'
    process.env.OPENAI_EMBEDDING_API_BASE_URL = 'http://embedding.local/v1'
    process.env.OPENAI_EMBEDDING_MODEL = 'test-embedding'
    process.env.OPENAI_EMBEDDING_DIMENSION = '3'
    process.env.OPENAI_EMBEDDING_TIMEOUT_MS = '1000'
    process.env.ATLAS_CODE_SEARCH_EMBEDDING_MODEL = 'test-embedding'
    process.env.ATLAS_CODE_SEARCH_EMBEDDING_DIMENSION = '3'
    process.env.ATLAS_CODE_SEARCH_SEMANTIC_TIMEOUT_MS = '1000'
    process.env.ATLAS_CODE_SEARCH_STATEMENT_TIMEOUT_MS = '250'
    process.env.ATLAS_CODE_SEARCH_QUERY_EMBEDDING_CACHE_TTL_MS = '1'
    globalThis.fetch = vi.fn(async () =>
      Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    ) as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  it('bootstraps only the trusted pg_trgm extension during schema bootstrap', async () => {
    const { db, calls } = makeFakeDb()
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await store.upsertRepository({ name: 'acme', defaultRef: 'main' })

    const queries = calls.map((call) => call.sql.toLowerCase())
    const extensionQueries = queries.filter((query) => query.includes('create extension'))
    expect(extensionQueries).toEqual([expect.stringContaining('create extension if not exists pg_trgm')])
    expect(extensionQueries.some((query) => query.includes('vector') || query.includes('pgcrypto'))).toBe(false)
  })

  it('does not let incidental repository upserts replace the authoritative ref or readiness metadata', async () => {
    const { db, calls } = makeFakeDb()
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await store.upsertRepository({ name: 'acme', defaultRef: 'feature' })

    const upsert = calls.find((call) => call.sql.toLowerCase().includes('insert into "atlas"."repositories"'))
    expect(upsert?.sql).toContain('"default_ref" = atlas.repositories.default_ref')
    expect(upsert?.sql).toContain('"metadata" = atlas.repositories.metadata')
  })

  it('uses typed Postgres arrays for tags', async () => {
    const { db, calls } = makeFakeDb()
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await store.upsertEnrichment({
      fileVersionId: 'file-version-1',
      kind: 'summary',
      source: 'test',
      content: 'hello',
      tags: ['smoke'],
    })

    const sqlText = calls.map((call) => call.sql)
    expect(sqlText.some((query) => query.includes('::text[]'))).toBe(true)
  })

  it('fails fast when required extensions are missing', async () => {
    const { db } = makeFakeDb({ extensions: [] })
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await expect(store.upsertRepository({ name: 'acme' })).rejects.toThrow(/missing required Postgres extensions/i)
  })

  it('fails when embedding dimension mismatches schema', async () => {
    const { db } = makeFakeDb({ embeddingType: 'vector(9)' })
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await expect(store.upsertRepository({ name: 'acme' })).rejects.toThrow(/embedding dimension mismatch/i)
  })

  it('rejects embeddings with wrong length', async () => {
    const { db } = makeFakeDb()
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await expect(
      store.upsertEmbedding({
        enrichmentId: 'enrich-1',
        model: 'test',
        dimension: 3,
        embedding: [0, 1],
      }),
    ).rejects.toThrow(/embedding dimension mismatch/i)
  })

  it('replaces the one current file version when content changes', async () => {
    const { db, calls } = makeFakeDb()
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await store.upsertFileVersion({
      fileKeyId: 'file-key-1',
      repositoryRef: 'main',
      repositoryCommit: null,
      contentHash: 'abc123',
      language: 'typescript',
      byteSize: 42,
      lineCount: 3,
      metadata: {},
      sourceTimestamp: null,
    })

    const sql = calls.find((call) => call.sql.toLowerCase().includes('insert into "atlas"."file_versions"'))?.sql
    expect(sql).toBeTruthy()
    const normalized = String(sql).toLowerCase().replace(/\s+/g, ' ')
    expect(normalized).toContain('on conflict ("file_key_id") do update')
    expect(normalized).toContain('"repository_commit" = excluded.repository_commit')
    expect(normalized).toContain('"content_hash" = excluded.content_hash')
  })

  it('uses the embedding-specific base URL for semantic code-search query embeddings', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
      }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { db } = makeFakeDb({ selectRows: [] })
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await store.codeSearch({ query: 'where is source search implemented', limit: 5 })

    expect(fetchMock).toHaveBeenCalled()
    const firstCall = fetchMock.mock.calls.at(0)
    expect(firstCall).toBeDefined()
    if (!firstCall) throw new Error('expected fetch call')
    const requestUrl =
      typeof firstCall[0] === 'string'
        ? firstCall[0]
        : firstCall[0] instanceof URL
          ? firstCall[0].toString()
          : firstCall[0].url
    expect(requestUrl).toBe('http://embedding.local/v1/embeddings')
    const body = JSON.parse(String(firstCall[1]?.body)) as { input: string }
    expect(body.input).toBe(
      'Instruct: Given a query, retrieve relevant source-code chunks from the repository\nQuery: where is source search implemented',
    )
  })

  it('searches chunk embeddings directly through the full ANN index contract', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
      }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { db, calls } = makeFakeDb({ selectRows: [] })
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await store.codeSearch({ query: 'where is source search implemented', limit: 5 })

    const semanticSql = calls.find(
      (call) =>
        call.sql.toLowerCase().includes('from atlas.chunk_embeddings as chunk_embeddings') &&
        call.sql.toLowerCase().includes(' as semantic_distance'),
    )
    expect(semanticSql).toBeDefined()
    expect(semanticSql?.sql.toLowerCase()).not.toContain('candidate_chunks')
    expect(semanticSql?.sql.toLowerCase()).toContain('order by chunk_embeddings.embedding <=> $')
    expect(semanticSql?.params.at(-1)).toBe(50)
    const statementTimeouts = calls
      .filter((call) => call.sql.toLowerCase().includes("set_config('statement_timeout'"))
      .flatMap((call) => call.params)
    expect(statementTimeouts).toEqual(['250ms', '1000ms'])
    const hnswBudgetSql = calls.find((call) => call.sql.toLowerCase().includes("set_config('hnsw.ef_search'"))
    expect(hnswBudgetSql?.params).toContain('50')
    expect(calls.some((call) => call.sql.toLowerCase().includes("set_config('hnsw.iterative_scan'"))).toBe(false)
  })

  it('keeps the cold semantic statement budget below the request deadline', async () => {
    delete process.env.ATLAS_CODE_SEARCH_SEMANTIC_TIMEOUT_MS
    const { db, calls } = makeFakeDb({ selectRows: [] })
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await store.codeSearch({ query: 'where is source search implemented', limit: 5 })

    const statementTimeouts = calls
      .filter((call) => call.sql.toLowerCase().includes("set_config('statement_timeout'"))
      .flatMap((call) => call.params)
    expect(statementTimeouts).toEqual(['250ms', '20000ms'])
  })

  it('caps the exact and lexical cold-storage ceiling below the API deadline', async () => {
    process.env.ATLAS_CODE_SEARCH_STATEMENT_TIMEOUT_MS = '60000'
    const { db, calls } = makeFakeDb({ selectRows: [] })
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await store.codeSearch({ query: 'where is source search implemented', limit: 5 })

    const statementTimeouts = calls
      .filter((call) => call.sql.toLowerCase().includes("set_config('statement_timeout'"))
      .flatMap((call) => call.params)
    expect(statementTimeouts).toEqual(['5000ms', '1000ms'])
  })

  it('uses an exact materialized semantic scan for narrow caller scopes', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
      }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { db, calls } = makeFakeDb({ selectRows: [], scopedSemanticCandidateCount: 50 })
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await store.codeSearch({
      query: 'where is source search implemented',
      repository: 'proompteng/lab',
      pathPrefix: 'services/jangar',
      language: 'typescript',
      limit: 5,
    })

    const semanticSql = calls.find((call) =>
      call.sql.toLowerCase().includes('with scoped_semantic_candidates as materialized'),
    )
    const normalized = String(semanticSql?.sql).toLowerCase().replace(/\s+/g, ' ')
    expect(normalized).toContain('with scoped_semantic_candidates as materialized')
    expect(normalized).toContain('file_keys.path like')
    expect(normalized).toContain('file_versions.language =')
    expect(normalized).toContain('order by scoped_semantic_candidates.candidate_embedding <=> $')
    expect(normalized).not.toContain('order by chunk_embeddings.embedding <=> $')
    expect(calls.some((call) => call.sql.toLowerCase().includes("set_config('hnsw.ef_search'"))).toBe(false)
    expect(calls.some((call) => call.sql.toLowerCase().includes("set_config('hnsw.iterative_scan'"))).toBe(false)
  })

  it('keeps broad path-prefix semantic searches on HNSW', async () => {
    const { db, calls } = makeFakeDb({ selectRows: [], scopedSemanticCandidateCount: 10_001 })
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await store.codeSearch({
      query: 'where is source search implemented',
      repository: 'proompteng/lab',
      pathPrefix: 'services/',
      limit: 5,
    })

    const countSql = calls.find((call) => call.sql.toLowerCase().includes('scoped_semantic_probe'))
    expect(countSql?.params.at(-1)).toBe(10_001)
    const semanticSql = calls.find(
      (call) =>
        call.sql.toLowerCase().includes('from atlas.chunk_embeddings as chunk_embeddings') &&
        call.sql.toLowerCase().includes(' as semantic_distance'),
    )
    const normalized = String(semanticSql?.sql).toLowerCase().replace(/\s+/g, ' ')
    expect(normalized).not.toContain('with scoped_semantic_candidates as materialized')
    expect(normalized).toContain('order by chunk_embeddings.embedding <=> $')
    expect(calls.some((call) => call.sql.toLowerCase().includes("set_config('hnsw.ef_search'"))).toBe(true)
    const iterativeScanSql = calls.find((call) => call.sql.toLowerCase().includes("set_config('hnsw.iterative_scan'"))
    expect(iterativeScanSql?.sql.toLowerCase()).toContain("'strict_order'")
  })

  it('uses an exact semantic scan for selective language filters', async () => {
    const { db, calls } = makeFakeDb({ selectRows: [], scopedSemanticCandidateCount: 5_162 })
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await store.codeSearch({
      query: 'how Atlas verifies deleted files',
      repository: 'proompteng/lab',
      language: 'markdown',
      limit: 5,
    })

    const semanticSql = calls.find((call) =>
      call.sql.toLowerCase().includes('with scoped_semantic_candidates as materialized'),
    )
    const normalized = String(semanticSql?.sql).toLowerCase().replace(/\s+/g, ' ')
    expect(normalized).toContain('file_versions.language =')
    expect(normalized).toContain('order by scoped_semantic_candidates.candidate_embedding <=> $')
    expect(calls.some((call) => call.sql.toLowerCase().includes("set_config('hnsw.ef_search'"))).toBe(false)
    expect(calls.some((call) => call.sql.toLowerCase().includes("set_config('hnsw.iterative_scan'"))).toBe(false)
  })

  it('keeps broad language-only semantic searches on HNSW', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
      }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { db, calls } = makeFakeDb({ selectRows: [], scopedSemanticCandidateCount: 35_967 })
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await store.codeSearch({
      query: 'where is source search implemented',
      repository: 'proompteng/lab',
      language: 'typescript',
      limit: 5,
    })

    const semanticSql = calls.find(
      (call) =>
        call.sql.toLowerCase().includes('from atlas.chunk_embeddings as chunk_embeddings') &&
        call.sql.toLowerCase().includes(' as semantic_distance'),
    )
    const normalized = String(semanticSql?.sql).toLowerCase().replace(/\s+/g, ' ')
    expect(normalized).not.toContain('with scoped_semantic_candidates as materialized')
    expect(normalized).toContain('file_versions.language =')
    expect(normalized).toContain('order by chunk_embeddings.embedding <=> $')
    expect(calls.some((call) => call.sql.toLowerCase().includes("set_config('hnsw.ef_search'"))).toBe(true)
    const iterativeScanSql = calls.find((call) => call.sql.toLowerCase().includes("set_config('hnsw.iterative_scan'"))
    expect(iterativeScanSql?.sql.toLowerCase()).toContain("'strict_order'")
  })

  it('isolates exact-match candidates without whole-content similarity scans', async () => {
    const { db, calls } = makeFakeDb({ selectRows: [] })
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await store.codeSearch({ query: 'createAtlasCodeSearchHandlers', repository: 'proompteng/lab', ref: 'main' })

    const exactSql = calls.find((call) => call.sql.toLowerCase().includes(' as exact_rank'))
    expect(exactSql).toBeDefined()
    const normalized = String(exactSql?.sql).toLowerCase().replace(/\s+/g, ' ')
    const candidates = normalized.slice(normalized.indexOf('with exact_candidates'), normalized.indexOf(') select'))
    expect(normalized).toContain('with exact_candidates as materialized')
    expect(candidates).toContain("file_chunks.text_tsvector @@ plainto_tsquery('simple', $")
    expect(candidates).not.toContain('file_chunks.content ilike')
    expect(normalized).toContain('file_chunks.content ~ $')
    expect(normalized).not.toMatch(/file_chunks\.content\s+%\s+\$/)
  })

  it('keeps punctuation-bearing literals indexed without treating them as web-search operators', async () => {
    const { db, calls } = makeFakeDb({ selectRows: [] })
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await store.codeSearch({ query: 'docker:25.0-dind', repository: 'proompteng/lab', ref: 'main' })

    const exactSql = calls.find((call) => call.sql.toLowerCase().includes(' as exact_rank'))
    const normalized = String(exactSql?.sql).toLowerCase().replace(/\s+/g, ' ')
    const candidates = normalized.slice(normalized.indexOf('with exact_candidates'), normalized.indexOf(') select'))
    expect(candidates).toContain('union ( select file_chunks.id as chunk_id from atlas.file_chunks as file_chunks')
    expect(candidates).toContain("file_chunks.text_tsvector @@ plainto_tsquery('simple', $")
    expect(candidates).not.toContain('websearch_to_tsquery')
    expect(candidates).not.toContain('file_chunks.content ilike')
    expect(normalized).toContain('file_chunks.content ilike')
  })

  it.each(['=>', '$', '${', '_'])(
    'falls back to exact content scanning when %s has no searchable text terms',
    async (query) => {
      const { db, calls } = makeFakeDb({ selectRows: [] })
      const store = createPostgresAtlasStore({
        url: 'postgresql://user:pass@localhost:5432/db',
        createDb: () => db,
      })

      await store.codeSearch({ query, repository: 'proompteng/lab', ref: 'main' })

      const exactSql = calls.find((call) => call.sql.toLowerCase().includes(' as exact_rank'))
      const normalized = String(exactSql?.sql).toLowerCase().replace(/\s+/g, ' ')
      const candidates = normalized.slice(normalized.indexOf('with exact_candidates'), normalized.indexOf(') select'))
      expect(candidates).toContain('file_chunks.content ilike')
      expect(candidates).toContain('limit $')
      expect(candidates).not.toContain('file_chunks.text_tsvector')
      expect(calls.some((call) => call.sql.toLowerCase().includes(' as lexical_rank'))).toBe(false)
      expect(calls.some((call) => call.sql.toLowerCase().includes(' as semantic_distance'))).toBe(false)
      expect(globalThis.fetch).not.toHaveBeenCalled()
    },
  )

  it('pushes corpus and caller filters into every materialized exact-candidate scan', async () => {
    const { db, calls } = makeFakeDb({ selectRows: [] })
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await store.codeSearch({
      query: 'createAtlasCodeSearchHandlers',
      repository: 'proompteng/lab',
      ref: 'main',
      pathPrefix: 'services/jangar',
      language: 'typescript',
    })

    const exactSql = calls.find((call) => call.sql.toLowerCase().includes(' as exact_rank'))
    const normalized = String(exactSql?.sql).toLowerCase().replace(/\s+/g, ' ')
    const candidates = normalized.slice(normalized.indexOf('with exact_candidates'), normalized.indexOf(') select'))
    expect(candidates.match(/repositories\.name =/g)).toHaveLength(2)
    expect(candidates.match(/file_versions\.repository_ref =/g)).toHaveLength(4)
    expect(candidates.match(/file_keys\.path like/g)).toHaveLength(2)
    expect(candidates.match(/file_versions\.language =/g)).toHaveLength(2)
    expect(candidates.match(/repositories\.metadata->>'indexstatus' = 'ready'/g)).toHaveLength(2)
  })

  it('relaxes natural-language lexical queries by one content term', async () => {
    const { db, calls } = makeFakeDb({ selectRows: [] })
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await store.codeSearch({
      query: 'source preview verifies the indexed commit and content hash',
      repository: 'proompteng/lab',
      ref: 'main',
    })

    const lexicalSql = calls.find((call) => call.sql.toLowerCase().includes(' as lexical_rank'))
    expect(lexicalSql?.params).toContain(
      'preview verifies indexed commit content hash OR source verifies indexed commit content hash OR source preview indexed commit content hash OR source preview verifies commit content hash OR source preview verifies indexed content hash OR source preview verifies indexed commit hash OR source preview verifies indexed commit content',
    )
  })

  it('does not scan chunk content for path-shaped exact queries', async () => {
    const { db, calls } = makeFakeDb({ selectRows: [] })
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await store.codeSearch({
      query: 'services/deleted/old-atlas.ts',
      repository: 'proompteng/lab',
      ref: 'main',
    })

    const exactSql = calls.find((call) => call.sql.toLowerCase().includes(' as exact_rank'))
    const normalized = String(exactSql?.sql).toLowerCase().replace(/\s+/g, ' ')
    const candidates = normalized.slice(normalized.indexOf('with exact_candidates'), normalized.indexOf(') select'))
    expect(candidates).toContain('file_keys.path =')
    expect(candidates).not.toContain('file_keys.path ilike')
    expect(candidates).not.toContain('file_keys.path %')
    expect(candidates).not.toContain('union select file_chunks.id as chunk_id from atlas.file_chunks as file_chunks')
    expect(calls.some((call) => call.sql.toLowerCase().includes(' as lexical_rank'))).toBe(false)
    expect(calls.some((call) => call.sql.toLowerCase().includes('from atlas.chunk_embeddings'))).toBe(false)
  })

  it('rejects an already-aborted request before issuing SQL', async () => {
    const cancelBackend = vi.fn(async () => undefined)
    const { db, calls } = makeFakeDb({ selectRows: [] })
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
      cancelBackend,
    })
    const controller = new AbortController()
    controller.abort(new Error('client disconnected'))

    await expect(
      store.codeSearch({ query: 'where is source search implemented', limit: 5 }, controller.signal),
    ).rejects.toThrow('client disconnected')

    expect(calls).toEqual([])
    expect(cancelBackend).not.toHaveBeenCalled()
  })

  it('rechecks cancellation after transaction SQL before starting the next statement', async () => {
    const controller = new AbortController()
    const cancelBackend = vi.fn(async () => undefined)
    let aborted = false
    const { db, calls } = makeFakeDb({
      selectRows: [],
      onQuery: ({ sql: query }) => {
        if (aborted || !query.toLowerCase().includes("set_config('statement_timeout'")) return
        aborted = true
        controller.abort(new Error('client disconnected between statements'))
      },
    })
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
      cancelBackend,
    })

    await expect(
      store.codeSearch({ query: 'where is source search implemented', limit: 5 }, controller.signal),
    ).rejects.toThrow('client disconnected between statements')

    expect(cancelBackend).toHaveBeenCalledWith(4242)
    expect(calls.some((call) => call.sql.toLowerCase().includes(' as exact_rank'))).toBe(false)
  })

  it('keeps indexed content and semantic retrieval for natural-language queries containing a path', async () => {
    const { db, calls } = makeFakeDb({ selectRows: [] })
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await store.codeSearch({
      query: 'where is services/deleted/old-atlas.ts implemented',
      repository: 'proompteng/lab',
      ref: 'main',
    })

    const exactSql = calls.find((call) => call.sql.toLowerCase().includes(' as exact_rank'))
    const normalized = String(exactSql?.sql).toLowerCase().replace(/\s+/g, ' ')
    const candidates = normalized.slice(normalized.indexOf('with exact_candidates'), normalized.indexOf(') select'))
    expect(candidates).toContain('union ( select file_chunks.id as chunk_id from atlas.file_chunks as file_chunks')
    expect(candidates).toContain("file_chunks.text_tsvector @@ plainto_tsquery('simple', $")
    expect(candidates).not.toContain('file_chunks.content ilike')
    expect(calls.some((call) => call.sql.toLowerCase().includes('from atlas.chunk_embeddings'))).toBe(true)
  })

  it('reports complete reconciliation metadata without sampling rows', async () => {
    const { db, calls } = makeFakeDb({
      repositoryRows: [
        {
          ...readyRepositoryRow,
          repository_metadata: {
            ...readyRepositoryRow.repository_metadata,
            indexStatus: 'failed',
            expectedFiles: 12,
            indexedFiles: 11,
            missingPaths: 1,
            indexedChunks: 20,
            embeddedChunks: 19,
            lastError: 'missing path',
          },
        },
      ],
    })
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    const health = await store.codeSearchHealth({
      repository: 'proompteng/lab',
      ref: 'main',
      pathPrefix: 'services/jangar',
    })

    expect(health.status).toBe('critical')
    expect(health.indexStatus).toBe('failed')
    expect(health.corpus).toMatchObject({
      expectedFiles: 12,
      indexedFiles: 11,
      missingPaths: 1,
      chunks: 20,
      embeddedChunks: 19,
    })
    expect(health.lastError).toBe('missing path')
    expect(health.model).toBe('test-embedding')
    expect(health.dimension).toBe(3)
    expect(
      calls.some((call) => {
        const normalized = call.sql.toLowerCase()
        return normalized.includes('select') && normalized.includes('from atlas.file_chunks')
      }),
    ).toBe(false)
  })

  it('rejects search unless the complete corpus is ready', async () => {
    const { db } = makeFakeDb({
      repositoryRows: [
        {
          ...readyRepositoryRow,
          repository_metadata: { ...readyRepositoryRow.repository_metadata, indexStatus: 'building' },
        },
      ],
    })
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await expect(store.codeSearch({ query: 'source search', repository: 'proompteng/lab' })).rejects.toThrow(
      /not ready.*building/i,
    )
  })

  it('ranks exact identifier matches above weaker lexical-only matches', async () => {
    const weak = makeCodeSearchRow({
      chunk_id: 'weak-chunk',
      chunk_content: 'const flag = process.env.otherValue',
      lexical_rank: 0.9,
      file_key_path: 'weak.ts',
    })
    const exact = makeCodeSearchRow({
      chunk_id: 'exact-chunk',
      chunk_content: 'const flag = process.env.BUMBA_ATLAS_CHUNK_INDEXING',
      exact_rank: 0.95,
      lexical_rank: 0.1,
      file_key_path: 'exact.ts',
    })
    const { db } = makeFakeDb({
      exactRows: [exact],
      lexicalRows: [weak, exact],
      semanticRows: [],
    })
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    const matches = await store.codeSearch({
      query: 'BUMBA_ATLAS_CHUNK_INDEXING',
      repository: 'proompteng/lab',
      ref: 'main',
      limit: 2,
    })

    expect(matches.map((match) => match.chunk.id)).toEqual(['exact-chunk', 'weak-chunk'])
    expect(matches[0]?.signals.matchedIdentifiers).toEqual(['BUMBA_ATLAS_CHUNK_INDEXING'])
  })

  it('breaks top-result RRF ties in favor of the best semantic result', async () => {
    const lexicalRows = Array.from({ length: 10 }, (_, index) =>
      makeCodeSearchRow({
        chunk_id: `lexical-${index}`,
        file_key_path: `schemas/generated/lexical-${index}.json`,
        lexical_rank: 1 - index / 100,
      }),
    )
    const semantic = makeCodeSearchRow({
      chunk_id: 'semantic-target',
      file_key_path: 'services/bumba/src/atlas/file-eligibility.ts',
      semantic_distance: 0.18,
    })
    const { db } = makeFakeDb({ exactRows: [], lexicalRows, semanticRows: [semantic] })
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    const matches = await store.codeSearch({
      query: 'where are unsupported Git file modes and oversized files rejected before indexing',
      repository: 'proompteng/lab',
      ref: 'main',
      limit: 1,
    })

    expect(matches).toHaveLength(1)
    expect(matches[0]?.chunk.id).toBe('semantic-target')
    expect(matches[0]?.retrievalMode).toBe('semantic')
  })

  it('keeps literal content matches on the RRF scale and above semantic ties', async () => {
    const generic = makeCodeSearchRow({
      chunk_id: 'generic-content-chunk',
      chunk_content: 'FROM docker:25.0-dind',
      exact_rank: 0.75,
      file_key_path: 'z-generic.ts',
    })
    const semantic = makeCodeSearchRow({
      chunk_id: 'semantic-only',
      semantic_distance: 0.01,
      file_key_path: 'a-semantic.ts',
    })
    const { db } = makeFakeDb({ exactRows: [generic], lexicalRows: [], semanticRows: [semantic] })
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    const matches = await store.codeSearch({ query: 'docker:25.0-dind', repository: 'proompteng/lab', limit: 1 })

    expect(matches).toHaveLength(1)
    expect(matches[0]?.chunk.id).toBe('generic-content-chunk')
    expect(matches[0]?.retrievalMode).toBe('exact')
    expect(matches[0]?.signals.exactRank).toBe(0.75)
    expect(matches[0]?.score).toBeCloseTo(1 / 61)
    expect(matches[0]?.score).toBeLessThan(0.1)
  })

  it('queries only the ready current commit and requested filters', async () => {
    const now = new Date('2020-01-01T00:00:00.000Z')
    const lexicalRow = {
      chunk_id: 'chunk-1',
      chunk_file_version_id: 'file-version-1',
      chunk_index: 0,
      chunk_start_line: 10,
      chunk_end_line: 16,
      chunk_content: 'const flag = process.env.BUMBA_ATLAS_CHUNK_INDEXING',
      chunk_token_count: 12,
      chunk_metadata: {},
      chunk_created_at: now,
      file_version_id: 'file-version-1',
      file_version_file_key_id: 'file-key-1',
      file_version_repository_ref: 'main',
      file_version_repository_commit: 'deadbeef',
      file_version_content_hash: 'hash-1',
      file_version_language: 'typescript',
      file_version_byte_size: 128,
      file_version_line_count: 20,
      file_version_metadata: {},
      file_version_source_timestamp: now,
      file_version_created_at: now,
      file_version_updated_at: now,
      file_key_id: 'file-key-1',
      file_key_repository_id: 'repo-1',
      file_key_path: 'services/bumba/src/workflows/index.ts',
      file_key_created_at: now,
      repository_id: 'repo-1',
      repository_name: 'proompteng/lab',
      repository_default_ref: 'main',
      repository_metadata: {},
      repository_created_at: now,
      repository_updated_at: now,
      lexical_rank: 0.42,
    }

    const { db, calls } = makeFakeDb({ exactRows: [], lexicalRows: [lexicalRow], semanticRows: [] })
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    const matches = await store.codeSearch({
      query: 'BUMBA_ATLAS_CHUNK_INDEXING',
      repository: 'proompteng/lab',
      ref: 'main',
      pathPrefix: 'services/bumba',
      language: 'typescript',
      limit: 5,
    })

    expect(matches).toHaveLength(1)
    const lexicalSql = calls.find((call) => call.sql.toLowerCase().includes(' as lexical_rank'))?.sql
    expect(lexicalSql).toBeTruthy()

    const normalized = String(lexicalSql).toLowerCase().replace(/\s+/g, ' ')
    expect(normalized).not.toContain('newer_file_versions')
    expect(normalized).toContain("repositories.metadata->>'indexstatus' = 'ready'")
    expect(normalized).toContain("file_versions.repository_commit = repositories.metadata->>'indexedcommit'")
    expect(normalized).toContain('repositories.name =')
    expect(normalized).toContain('file_versions.repository_ref =')
    expect(normalized).toContain('file_keys.path like')
    expect(normalized).toContain('file_versions.language =')
  })
})
