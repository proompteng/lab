import { PgClient } from '@effect/sql-pg'
import { Effect, ManagedRuntime, Redacted } from 'effect'

export type PostgresTestDatabase = {
  readonly url: string
  readonly clone: () => Promise<PostgresTestDatabase>
  readonly dispose: () => Promise<void>
}

export type PostgresTestTemplate = {
  readonly clone: () => Promise<PostgresTestDatabase>
  readonly dispose: () => Promise<void>
}

export const prepareClonedPostgres = async (
  testUrl: string,
  initialize: (url: string) => Promise<unknown>,
): Promise<PostgresTestTemplate> => {
  const url = new URL(testUrl)
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !url.pathname.endsWith('_test') ||
    url.searchParams.has('host') ||
    url.searchParams.has('dbname')
  )
    throw new Error('Database clones require a local PostgreSQL _test database')

  const prefix = `bayn_${crypto.randomUUID().replaceAll('-', '')}`
  const template = `${prefix}_template_test`
  const admin = ManagedRuntime.make(PgClient.layer({ url: Redacted.make(testUrl), maxConnections: 1 }))
  const databaseUrl = (name: string) => {
    const clone = new URL(url)
    clone.pathname = `/${name}`
    return clone.toString()
  }
  const create = (name: string, source: string) =>
    admin.runPromise(
      Effect.flatMap(PgClient.PgClient, (sql) => sql`CREATE DATABASE ${sql(name)} TEMPLATE ${sql(source)}`),
    )
  const drop = (name: string) =>
    admin.runPromise(
      Effect.flatMap(PgClient.PgClient, (sql) => sql`DROP DATABASE IF EXISTS ${sql(name)} WITH (FORCE)`).pipe(
        Effect.asVoid,
      ),
    )
  const dispose = async () => {
    try {
      await drop(template)
    } finally {
      await admin.dispose()
    }
  }

  try {
    await create(template, 'template0')
    // PostgreSQL can clone the database after the initializer closes its pool.
    await initialize(databaseUrl(template))
  } catch (error) {
    try {
      await dispose()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Failed to initialize and remove PostgreSQL test template')
    }
    throw error
  }
  let next = 0
  const clone = async (source: string): Promise<PostgresTestDatabase> => {
    const database = `${prefix}_${next++}_test`
    await create(database, source)
    return {
      url: databaseUrl(database),
      clone: () => clone(database),
      dispose: () => drop(database),
    }
  }
  return {
    clone: () => clone(template),
    dispose,
  }
}
