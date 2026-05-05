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
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Database } from '../db'

type SqlCall = { sql: string; params: readonly unknown[] }

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}))

const migrationMocks = vi.hoisted(() => ({
  ensureMigrations: vi.fn(async () => {}),
}))

vi.mock('../db', () => ({
  getDb: dbMocks.getDb,
}))

vi.mock('../kysely-migrations', () => ({
  ensureMigrations: migrationMocks.ensureMigrations,
}))

const makeFakeDb = () => {
  const calls: SqlCall[] = []

  class TestConnection implements DatabaseConnection {
    async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
      calls.push({
        sql: compiledQuery.sql,
        params: (compiledQuery.parameters ?? []) as readonly unknown[],
      })
      return { rows: [] as R[] }
    }

    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      yield { rows: [] as R[] }
    }
  }

  class TestDriver implements Driver {
    private readonly connection = new TestConnection()

    async init(): Promise<void> {}

    async acquireConnection(): Promise<DatabaseConnection> {
      return this.connection
    }

    async beginTransaction(): Promise<void> {}

    async commitTransaction(): Promise<void> {}

    async rollbackTransaction(): Promise<void> {}

    async releaseConnection(): Promise<void> {}

    async destroy(): Promise<void> {}
  }

  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new TestDriver(),
      createIntrospector: (database) => new PostgresIntrospector(database),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  })

  return { db, calls }
}

describe('torghut quant metrics store', () => {
  beforeEach(() => {
    dbMocks.getDb.mockReset()
    migrationMocks.ensureMigrations.mockClear()
  })

  it('uses an indexable account/window latest-stage lookup', async () => {
    const { db, calls } = makeFakeDb()
    dbMocks.getDb.mockReturnValue(db)
    const { listLatestQuantPipelineHealth } = await import('../torghut-quant-metrics-store')

    await listLatestQuantPipelineHealth({ account: 'paper', window: '15m' })

    const pipelineHealthSql = calls.find((call) => call.sql.includes('quant_pipeline_health'))?.sql
    expect(pipelineHealthSql).toBeTruthy()
    const normalized = String(pipelineHealthSql).toLowerCase().replace(/\s+/g, ' ')

    expect(normalized).toContain("select distinct on (account, (details->>'window'), strategy_id, stage)")
    expect(normalized).toContain("where account = $1 and details->>'window' = $2")
    expect(normalized).toContain(
      "order by account asc, (details->>'window') asc, strategy_id asc, stage asc, as_of desc",
    )
    expect(normalized).not.toContain('row_number() over')
  })
})
