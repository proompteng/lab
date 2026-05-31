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

type FakeDbOptions = { extensions?: string[]; embeddingType?: string | null; selectRows?: unknown[] }

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
      calls.push({ sql: compiledQuery.sql, params })

      const normalized = compiledQuery.sql.toLowerCase()
      const now = new Date('2020-01-01T00:00:00.000Z')

      if (normalized.includes('select extname from pg_extension')) {
        const extensions = options.extensions ?? ['vector', 'pgcrypto']
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
      'ATLAS_CODE_SEARCH_SEMANTIC_TIMEOUT_MS',
      'ATLAS_CODE_SEARCH_QUERY_EMBEDDING_CACHE_TTL_MS',
    ]) {
      previousEnv[key] = process.env[key]
    }
    process.env.OPENAI_API_BASE_URL = 'http://chat.local/v1'
    process.env.OPENAI_EMBEDDING_API_BASE_URL = 'http://embedding.local/v1'
    process.env.OPENAI_EMBEDDING_MODEL = 'test-embedding'
    process.env.OPENAI_EMBEDDING_DIMENSION = '3'
    process.env.OPENAI_EMBEDDING_TIMEOUT_MS = '1000'
    process.env.ATLAS_CODE_SEARCH_SEMANTIC_TIMEOUT_MS = '1000'
    process.env.ATLAS_CODE_SEARCH_QUERY_EMBEDDING_CACHE_TTL_MS = '1'
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

  it('does not attempt CREATE EXTENSION during schema bootstrap', async () => {
    const { db, calls } = makeFakeDb()
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await store.upsertRepository({ name: 'acme', defaultRef: 'main' })

    const queries = calls.map((call) => call.sql.toLowerCase())
    expect(queries.some((query) => query.includes('create extension'))).toBe(false)
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

  it('uses partial null-commit conflict target for file version upserts', async () => {
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
    expect(normalized).toContain(
      'on conflict ("file_key_id", "repository_ref", "content_hash") where "repository_commit" is null do update',
    )
  })

  it('uses commit-aware conflict target for file version upserts with commit', async () => {
    const { db, calls } = makeFakeDb()
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await store.upsertFileVersion({
      fileKeyId: 'file-key-1',
      repositoryRef: 'main',
      repositoryCommit: 'deadbeef',
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
    expect(normalized).toContain(
      'on conflict ("file_key_id", "repository_ref", "repository_commit", "content_hash") do update',
    )
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
  })

  it('reports sampled semantic code-search coverage health', async () => {
    const { db } = makeFakeDb({
      selectRows: [
        { chunk_id: 'chunk-1', embedded_chunk_id: 'chunk-1' },
        { chunk_id: 'chunk-2', embedded_chunk_id: null },
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
      minSemanticCoverage: 0.75,
      healthSampleLimit: 2,
    })

    expect(health.status).toBe('degraded')
    expect(health.sample).toMatchObject({ chunks: 2, embedded: 1, missing: 1, coverage: 0.5 })
    expect(health.model).toBe('test-embedding')
    expect(health.dimension).toBe(3)
  })

  it('ranks exact identifier matches above weaker lexical-only matches', async () => {
    const { db } = makeFakeDb({
      selectRows: [
        makeCodeSearchRow({
          chunk_id: 'weak-chunk',
          chunk_content: 'const flag = process.env.otherValue',
          lexical_rank: 0.9,
          file_key_path: 'weak.ts',
        }),
        makeCodeSearchRow({
          chunk_id: 'exact-chunk',
          chunk_content: 'const flag = process.env.BUMBA_ATLAS_CHUNK_INDEXING',
          lexical_rank: 0.1,
          file_key_path: 'exact.ts',
        }),
      ],
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

  it('applies latest file version filter in code search queries', async () => {
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

    const { db, calls } = makeFakeDb({ selectRows: [lexicalRow] })
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
    const lexicalSql = calls.find((call) => call.sql.toLowerCase().includes('from "atlas"."file_chunks"'))?.sql
    expect(lexicalSql).toBeTruthy()

    const normalized = String(lexicalSql).toLowerCase().replace(/\s+/g, ' ')
    expect(normalized).toContain('file_versions.id in ( select ranked.id from ( select fv.id')
    expect(normalized).toContain('row_number() over ( partition by fv.file_key_id, fv.repository_ref')
    expect(normalized).toContain('order by fv.updated_at desc, fv.created_at desc, fv.id desc')
    expect(normalized).toContain('from atlas.file_versions as fv')
    expect(normalized).toContain('inner join atlas.file_keys as file_keys_scope on file_keys_scope.id = fv.file_key_id')
    expect(normalized).toContain(
      'inner join atlas.repositories as repositories_scope on repositories_scope.id = file_keys_scope.repository_id',
    )
    expect(normalized).toContain('where repositories_scope.name =')
    expect(normalized).toContain('fv.repository_ref =')
    expect(normalized).toContain('file_keys_scope.path like')
    expect(normalized).toContain('fv.language =')
    expect(normalized).toContain('where ranked.latest_rank = 1 )')
  })
})
