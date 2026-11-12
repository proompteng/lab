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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AgentsDatabase } from './db'
import { createPostgresMemoriesStore, rankMemoryNotes } from './memory-notes-store'

type SqlCall = { sql: string; params: readonly unknown[] }

type FakeDbOptions = { extensions?: string[]; selectRows?: unknown[]; failOnceOnExtensionsQuery?: boolean }

const makeFakeDb = (options: FakeDbOptions = {}) => {
  const calls: SqlCall[] = []
  let extensionQueryFailed = false

  class TestConnection implements DatabaseConnection {
    async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
      const params = (compiledQuery.parameters ?? []) as readonly unknown[]
      calls.push({ sql: compiledQuery.sql, params })

      const normalized = compiledQuery.sql.toLowerCase()

      if (normalized.includes('select extname from pg_extension')) {
        if (options.failOnceOnExtensionsQuery && !extensionQueryFailed) {
          extensionQueryFailed = true
          throw new Error('transient extension lookup failure')
        }
        const extensions = options.extensions ?? ['vector', 'pgcrypto']
        return { rows: extensions.map((ext) => ({ extname: ext })) as R[] }
      }

      if (normalized.includes('pg_catalog.pg_attribute') && normalized.includes("a.attname = 'embedding'")) {
        return { rows: [] as R[] }
      }

      if (normalized.includes('insert into "memories"."entries"')) {
        return {
          rows: [
            {
              id: 'mem-1',
              task_name: 'default',
              content: 'hello',
              summary: 'hi',
              tags: ['smoke'],
              metadata: {},
              created_at: new Date('2020-01-01T00:00:00.000Z'),
            },
          ] as R[],
        }
      }

      if (normalized.includes('from "memories"."entries"') && normalized.includes('embedding <=>')) {
        return {
          rows: (options.selectRows ?? [
            {
              id: 'mem-1',
              task_name: 'default',
              content: 'hello',
              summary: 'hi',
              tags: ['smoke'],
              metadata: {},
              created_at: new Date('2020-01-01T00:00:00.000Z'),
              distance: 0.123,
            },
          ]) as R[],
        }
      }

      if (normalized.includes('count(*)::bigint') && normalized.includes('from "memories"."entries"')) {
        return { rows: [{ count: '1' }] as R[] }
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

  const db = new Kysely<AgentsDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new TestDriver(),
      createIntrospector: (dbInstance) => new PostgresIntrospector(dbInstance),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  })

  return { db, calls }
}

describe('memories store', () => {
  const previousEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ['OPENAI_EMBEDDING_DIMENSION']) {
      previousEnv[key] = process.env[key]
    }
    process.env.OPENAI_EMBEDDING_DIMENSION = '3'
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

  it('does not attempt CREATE EXTENSION during schema bootstrap', async () => {
    const { db, calls } = makeFakeDb()
    const store = createPostgresMemoriesStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
      embedText: async () => [0, 0, 0],
    })

    await store.persist({ content: 'hello', summary: 'hi', tags: ['smoke'] })

    const unsafeQueries = calls.map((call) => call.sql.toLowerCase())
    expect(unsafeQueries.some((query) => query.includes('create extension'))).toBe(false)
  })

  it('uses typed Postgres arrays for tags and ids', async () => {
    const { db, calls } = makeFakeDb()
    const store = createPostgresMemoriesStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
      embedText: async () => [0, 0, 0],
    })

    await store.persist({ content: 'hello', summary: 'hi', tags: ['smoke'] })
    await store.retrieve({ query: 'hello', limit: 1 })

    const sqlText = calls.map((call) => call.sql)
    expect(sqlText.some((query) => query.includes('::text[]'))).toBe(true)
    expect(sqlText.some((query) => query.includes('::uuid[]'))).toBe(true)
  })

  it('fails fast when required extensions are missing', async () => {
    const { db } = makeFakeDb({ extensions: [] })
    const store = createPostgresMemoriesStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
      embedText: async () => [0, 0, 0],
    })

    await expect(store.retrieve({ query: 'hello', limit: 1 })).rejects.toThrow(/missing required Postgres extensions/i)
  })

  it('stores metadata and returns it on retrieval', async () => {
    const { db, calls } = makeFakeDb({
      selectRows: [
        {
          id: 'mem-1',
          task_name: 'default',
          content: 'hello',
          summary: 'hi',
          tags: ['smoke'],
          metadata: { foo: 'bar' },
          created_at: new Date('2020-01-01T00:00:00.000Z'),
          distance: 0.42,
        },
      ],
    })
    const store = createPostgresMemoriesStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
      embedText: async () => [0, 0, 0],
    })

    await store.persist({ content: 'hello', summary: 'hi', tags: ['smoke'], metadata: { foo: 'bar' } })

    const insertCall = calls.find((call) => call.sql.toLowerCase().includes('insert into "memories"."entries"'))
    const metadataParam = insertCall?.params.find(
      (param) => typeof param === 'string' && param.trim().startsWith('{') && param.includes('"namespace"'),
    )
    expect(metadataParam).toBeDefined()
    const parsedMetadata = JSON.parse(metadataParam as string) as Record<string, unknown>
    expect(parsedMetadata).toMatchObject({ namespace: 'default', foo: 'bar' })

    const records = await store.retrieve({ query: 'hello', limit: 1 })
    expect(records[0]?.metadata).toEqual({ foo: 'bar' })
  })

  it('filters out semantically distant rows when there is no lexical overlap', async () => {
    const { db } = makeFakeDb({
      selectRows: [
        {
          id: 'mem-1',
          task_name: 'default',
          content: 'Casual greeting from user.',
          summary: 'Greeting',
          tags: ['chat'],
          metadata: {},
          created_at: new Date('2020-01-01T00:00:00.000Z'),
          distance: 0.63,
        },
        {
          id: 'mem-2',
          task_name: 'default',
          content: 'Another short social exchange.',
          summary: 'Chat follow-up',
          tags: ['conversation'],
          metadata: {},
          created_at: new Date('2020-01-01T00:00:00.000Z'),
          distance: 0.64,
        },
      ],
    })
    const store = createPostgresMemoriesStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
      embedText: async () => [0, 0, 0],
    })

    const records = await store.retrieve({
      query: 'ivfflat probes tuning embedding dimension checks',
      limit: 5,
    })

    expect(records).toEqual([])
  })

  it('keeps lexical matches even when semantic distance is outside the strict cutoff', async () => {
    const { db } = makeFakeDb({
      selectRows: [
        {
          id: 'mem-1',
          task_name: 'default',
          content: 'Pulled latest main into bengaluru worktree branch.',
          summary: 'git pull result',
          tags: ['git', 'pull', 'bengaluru'],
          metadata: {},
          created_at: new Date('2020-01-01T00:00:00.000Z'),
          distance: 0.44,
        },
        {
          id: 'mem-2',
          task_name: 'default',
          content: 'Bengaluru branch pull notes and command history.',
          summary: 'branch notes',
          tags: ['bengaluru'],
          metadata: {},
          created_at: new Date('2020-01-01T00:00:00.000Z'),
          distance: 0.7,
        },
      ],
    })
    const store = createPostgresMemoriesStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
      embedText: async () => [0, 0, 0],
    })

    const records = await store.retrieve({ query: 'git pull bengaluru', limit: 5 })

    expect(records.map((record) => record.id)).toEqual(['mem-1', 'mem-2'])
  })

  it('retries schema bootstrap after transient failure', async () => {
    const { db, calls } = makeFakeDb({ failOnceOnExtensionsQuery: true })
    const store = createPostgresMemoriesStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
      embedText: async () => [0, 0, 0],
    })

    await expect(store.retrieve({ query: 'hello', limit: 1 })).rejects.toThrow(/transient extension lookup failure/i)
    const firstAttemptCalls = calls.length

    const records = await store.retrieve({ query: 'hello', limit: 1 })
    expect(records).toHaveLength(1)
    expect(calls.length).toBeGreaterThan(firstAttemptCalls)

    const extensionLookupCount = calls.filter((call) =>
      call.sql.toLowerCase().includes('select extname from pg_extension'),
    ).length
    expect(extensionLookupCount).toBeGreaterThanOrEqual(2)
  })

  it('rejects the unrelated tail observed in MCTS retrieval and unrelated queries', () => {
    const note = (id: string, content: string, distance: number) => ({
      id,
      content,
      distance,
      summary: content,
      namespace: 'test',
      tags: [],
      metadata: {},
      createdAt: '2026-11-10T00:00:00Z',
      retiredAt: null,
      retirementReason: null,
      replacementId: null,
    })
    const records = [
      note(
        'mcts',
        'MCTS nodes bind candidate expression, metrics, factor and evaluation references to one design.',
        0.324,
      ),
      note('synthesis', 'Synthesis mobile detail AgentRun submission succeeded.', 0.409),
      note('feed', 'Manual feed curation saved ten items using local embeddings.', 0.395),
    ]
    expect(
      rankMemoryNotes(records, 'MCTS selected expression wrong metrics multiple designs candidate evidence', 5).map(
        (row) => row.id,
      ),
    ).toEqual(['mcts'])
    expect(
      rankMemoryNotes(
        records.map((row) => ({ ...row, distance: 0.55 })),
        'kitchen faucet dishwasher filter replacement',
        5,
      ),
    ).toEqual([])
  })

  it('uses lexical evidence to rank the specific partial-output failure above generic verification', () => {
    const note = (id: string, content: string, distance: number) => ({
      id,
      content,
      distance,
      summary: content,
      namespace: 'test',
      tags: [],
      metadata: {},
      createdAt: '2026-11-10T00:00:00Z',
      retiredAt: null,
      retirementReason: null,
      replacementId: null,
    })
    const records = [
      note('audit', 'Independent qualification audit performs verification of evaluation inputs.', 0.406),
      note('copy', 'Copy verification must abort on partial database output and preserve the source.', 0.409),
    ]
    expect(
      rankMemoryNotes(records, 'copy verification returns partial database output', 5).map((row) => row.id),
    ).toEqual(['copy'])
  })
})
