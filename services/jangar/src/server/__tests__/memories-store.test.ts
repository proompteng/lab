import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { __private, createPostgresMemoriesStore } from '../memories-store'

type SqlCall =
  | { kind: 'unsafe'; query: string; params: unknown[] | undefined }
  | { kind: 'tag'; query: string; values: unknown[] }
  | { kind: 'array'; values: unknown[]; elementType: string | undefined }

type FakeDb = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>
  unsafe: <T = unknown>(query: string, params?: unknown[]) => Promise<T>
  array: (values: unknown[], elementType?: string) => unknown
  close: () => Promise<void>
}

const makeFakeDb = (options: { extensions?: string[]; selectRows?: unknown[] } = {}) => {
  const calls: SqlCall[] = []

  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((acc, part, idx) => acc + part + (idx < values.length ? `$${idx + 1}` : ''), '')
    calls.push({ kind: 'tag', query, values })

    if (query.includes('INSERT INTO memories.entries')) {
      return [
        {
          id: 'mem-1',
          task_name: 'default',
          content: 'hello',
          summary: 'hi',
          tags: ['smoke'],
          created_at: new Date('2020-01-01T00:00:00.000Z'),
        },
      ]
    }

    if (query.includes('FROM memories.entries') && query.includes('embedding <=>')) {
      return (
        options.selectRows ?? [
          {
            id: 'mem-1',
            task_name: 'default',
            content: 'hello',
            summary: 'hi',
            tags: ['smoke'],
            created_at: new Date('2020-01-01T00:00:00.000Z'),
            distance: 0.123,
          },
        ]
      )
    }

    return []
  }) as FakeDb

  db.unsafe = async <T = unknown>(query: string, params?: unknown[]) => {
    calls.push({ kind: 'unsafe', query, params })
    if (query.includes("SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pgcrypto')")) {
      const extensions = options.extensions ?? ['vector', 'pgcrypto']
      return extensions.map((ext) => ({ extname: ext })) as unknown as T
    }
    if (query.includes('format_type') && query.includes('pg_catalog.pg_attribute')) {
      return [] as unknown as T
    }
    return [] as unknown as T
  }

  db.array = (values: unknown[], elementType?: string) => {
    calls.push({ kind: 'array', values, elementType })
    return { __kind: 'pg_array', values, elementType }
  }

  db.close = async () => {}

  return { db, calls }
}

describe('memories store', () => {
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
    const store = createPostgresMemoriesStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
      embedText: async () => [0, 0, 0],
    })

    await store.persist({ content: 'hello', summary: 'hi', tags: ['smoke'] })

    const unsafeQueries = calls.filter((call) => call.kind === 'unsafe').map((call) => call.query)
    expect(unsafeQueries.some((query) => query.includes('CREATE EXTENSION'))).toBe(false)
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

    const arrays = calls.filter((call) => call.kind === 'array') as Array<Extract<SqlCall, { kind: 'array' }>>
    expect(arrays).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ elementType: 'text', values: ['smoke'] }),
        expect.objectContaining({ elementType: 'uuid', values: ['mem-1'] }),
      ]),
    )
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
})
