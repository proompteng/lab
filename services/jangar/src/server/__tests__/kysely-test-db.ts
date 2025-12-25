import {
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from 'kysely'

import type { Database, Db } from '../db'

export type SqlCall = {
  sql: string
  parameters: unknown[]
}

type QueryHandler = (call: SqlCall) => unknown[] | undefined

const createTestDialect = (handleQuery: QueryHandler, calls: SqlCall[]): Dialect => {
  class TestConnection implements DatabaseConnection {
    async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
      const call = { sql: compiledQuery.sql, parameters: [...compiledQuery.parameters] }
      calls.push(call)
      const rows = (handleQuery(call) ?? []) as R[]
      return { rows }
    }

    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      yield { rows: [] as R[] }
    }
  }

  class TestDriver implements Driver {
    async init(): Promise<void> {}
    async acquireConnection(): Promise<DatabaseConnection> {
      return new TestConnection()
    }
    async beginTransaction(): Promise<void> {}
    async commitTransaction(): Promise<void> {}
    async rollbackTransaction(): Promise<void> {}
    async releaseConnection(): Promise<void> {}
    async destroy(): Promise<void> {}
  }

  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new TestDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  }
}

export const createTestDb = (handleQuery: QueryHandler) => {
  const calls: SqlCall[] = []
  const dialect = createTestDialect(handleQuery, calls)
  const db: Db = new Kysely<Database>({ dialect })

  return { db, calls }
}
