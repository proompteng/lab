import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { __private, createPostgresAtlasStore } from '../atlas-store'
import { createTestDb } from './kysely-test-db'

const makeFakeDb = (options: { extensions?: string[]; embeddingType?: string | null; selectRows?: unknown[] } = {}) => {
  const { db, calls } = createTestDb((call) => {
    const query = call.sql
    const now = new Date('2020-01-01T00:00:00.000Z')

    if (query.includes('INSERT INTO atlas.repositories')) {
      return [
        {
          id: 'repo-1',
          name: 'acme',
          default_ref: 'main',
          metadata: {},
          created_at: now,
          updated_at: now,
        },
      ]
    }

    if (query.includes('INSERT INTO atlas.file_keys')) {
      return [
        {
          id: 'file-key-1',
          repository_id: 'repo-1',
          path: 'src/index.ts',
          created_at: now,
        },
      ]
    }

    if (query.includes('INSERT INTO atlas.file_versions')) {
      return [
        {
          id: 'file-version-1',
          file_key_id: 'file-key-1',
          repository_ref: 'main',
          repository_commit: 'abc',
          content_hash: '',
          language: null,
          byte_size: null,
          line_count: null,
          metadata: {},
          source_timestamp: null,
          created_at: now,
          updated_at: now,
        },
      ]
    }

    if (query.includes('INSERT INTO atlas.enrichments')) {
      return [
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
      ]
    }

    if (query.includes('INSERT INTO atlas.embeddings')) {
      return [
        {
          id: 'embed-1',
          enrichment_id: 'enrich-1',
          model: 'test',
          dimension: 3,
          created_at: now,
        },
      ]
    }

    if (query.includes('pg_catalog.pg_attribute') && query.includes("a.attname = 'embedding'")) {
      if (options.embeddingType) {
        return [{ embedding_type: options.embeddingType }]
      }
      return []
    }

    if (query.includes("SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pgcrypto')")) {
      const extensions = options.extensions ?? ['vector', 'pgcrypto']
      return extensions.map((ext) => ({ extname: ext }))
    }

    return options.selectRows ?? []
  })

  return { db, calls }
}

describe('atlas store', () => {
  const previousEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ['OPENAI_EMBEDDING_DIMENSION', 'PGSSLMODE', 'PGSSLROOTCERT']) {
      previousEnv[key] = process.env[key]
    }
    process.env.OPENAI_EMBEDDING_DIMENSION = '3'
    process.env.PGSSLMODE = 'require'
    process.env.PGSSLROOTCERT = '/etc/ssl/certs/example/ca.crt'
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  it('does not inject sslrootcert into DATABASE_URL', () => {
    const base = 'postgresql://user:pass@localhost:5432/db'
    const updated = __private.withDefaultSslMode(base)
    expect(updated).toContain('sslmode=require')
    expect(updated).not.toContain('sslrootcert')
  })

  it('does not attempt CREATE EXTENSION during schema bootstrap', async () => {
    const { db, calls } = makeFakeDb()
    const store = createPostgresAtlasStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await store.upsertRepository({ name: 'acme', defaultRef: 'main' })

    const unsafeQueries = calls.map((call) => call.sql)
    expect(unsafeQueries.some((query) => query.includes('CREATE EXTENSION'))).toBe(false)
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

    const textArrayCall = calls.find(
      (call) =>
        call.sql.includes('::text[]') && call.parameters.some((param) => Array.isArray(param) && param[0] === 'smoke'),
    )
    expect(textArrayCall).toBeTruthy()
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
})
