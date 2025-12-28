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

import type { Database } from '../db'
import { createPostgresMemoriesStore } from '../memories-store'

type SqlCall = { sql: string; params: readonly unknown[] }

type FakeDbOptions = { extensions?: string[]; selectRows?: unknown[] }

const makeFakeDb = (options: FakeDbOptions = {}) => {
  const calls: SqlCall[] = []

  class TestConnection implements DatabaseConnection {
    async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
      const params = (compiledQuery.parameters ?? []) as readonly unknown[]
      calls.push({ sql: compiledQuery.sql, params })

      const normalized = compiledQuery.sql.toLowerCase()

      if (normalized.includes('select extname from pg_extension')) {
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
})
