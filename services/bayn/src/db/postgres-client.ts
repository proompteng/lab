import { Socket } from 'node:net'

import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Exit, FileSystem, Layer, Redacted, Schedule, Schema, Scope } from 'effect'
import { Statement } from 'effect/sql'
import { isSqlError, type SqlError } from 'effect/sql/SqlError'

import type { RuntimeConfig } from '../config/model'
import { classifyDatabaseError, databaseError, runDatabase } from './database-error'

export const postgresHealthCheck = (sql: PgClient.PgClient) => runDatabase('health', sql`SELECT 1`.pipe(Effect.asVoid))

const RefusedConnection = Schema.Struct({ code: Schema.Literal('ECONNREFUSED') })
const startupConnectionRefused = (cause: unknown): boolean =>
  isSqlError(cause) && cause.reason._tag === 'ConnectionError' && Schema.is(RefusedConnection)(cause.reason.cause)

export const connectPostgresWithStartupRetry = <A, R>(open: Effect.Effect<A, SqlError, R | Scope.Scope>) =>
  Effect.gen(function* () {
    const parent = yield* Effect.scope
    const attempt = Effect.gen(function* () {
      const scope = yield* Scope.fork(parent)
      return yield* open.pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
      )
    })
    return yield* attempt.pipe(
      Effect.tapError((cause) =>
        startupConnectionRefused(cause)
          ? Effect.logWarning('PostgreSQL startup connection refused').pipe(
              Effect.annotateLogs({ dependency: 'postgresql', operation: 'connect', code: 'ECONNREFUSED' }),
            )
          : Effect.void,
      ),
      Effect.retry({ while: startupConnectionRefused, times: 2, schedule: Schedule.spaced('1 second') }),
    )
  })

export const PostgresClientLive = (
  config: Pick<RuntimeConfig, 'operationTimeoutMs' | 'postgres' | 'alpaca'>,
  options: { readonly maxConnections: number; readonly applicationName: string } = {
    maxConnections: 8,
    applicationName: 'bayn',
  },
) => {
  const passBudgetMs = Math.min(
    config.operationTimeoutMs,
    config.alpaca?.reconciliationIntervalMs ?? config.operationTimeoutMs,
  )
  // The SQL adapter can spend five seconds canceling a query. Let the server abort first and leave rollback time.
  const statementTimeoutMs = Math.max(1, Math.floor(passBudgetMs - Math.min(5_000, passBudgetMs / 2)))
  const socketTimeoutMs = Math.max(1, Math.floor((statementTimeoutMs + passBudgetMs) / 2))
  const sessionConnection = Effect.try({
    try: () => {
      const url = new URL(Redacted.value(config.postgres.url))
      const options = url.searchParams.get('options')
      url.searchParams.set(
        'options',
        `${options === null ? '' : `${options} `}-c statement_timeout=${statementTimeoutMs}`,
      )
      return {
        url: Redacted.make(url.toString()),
        host:
          url.searchParams.getAll('host').at(-1) ??
          (decodeURIComponent(url.hostname.replace(/^\[|\]$/g, '')) || 'localhost'),
        port: Number(url.searchParams.getAll('port').at(-1) ?? (url.port || '5432')),
        username: url.searchParams.getAll('user').at(-1) ?? (decodeURIComponent(url.username) || undefined),
        database:
          url.searchParams.getAll('dbname').at(-1) ??
          (decodeURIComponent(url.pathname.replace(/^\//, '')) || undefined),
      }
    },
    catch: () =>
      databaseError({ failure: 'invariant', operation: 'connect', message: 'invalid PostgreSQL connection URL' }),
  })
  const readCertificate = Effect.gen(function* () {
    if (!config.postgres.tls) return undefined
    const fileSystem = yield* FileSystem.FileSystem
    return yield* fileSystem.readFileString(config.postgres.caPath)
  })
  return Layer.merge(
    Layer.succeed(Statement.SpanPropagationEnabled, true),
    Layer.unwrap(
      readCertificate.pipe(
        Effect.mapError((cause) =>
          databaseError({
            failure: 'unavailable',
            operation: 'tls',
            message: 'failed to read PostgreSQL CA certificate',
            cause,
          }),
        ),
        Effect.flatMap((ca) =>
          sessionConnection.pipe(
            Effect.map(({ url, host, port, username, database }) =>
              PgClient.layerFrom(
                PgClient.make({
                  url,
                  host,
                  port,
                  username,
                  database,
                  ssl: ca === undefined ? undefined : { ca, rejectUnauthorized: true },
                  applicationName: options.applicationName,
                  connectTimeout: statementTimeoutMs,
                  stream: () => {
                    const socket = new Socket()
                    socket.setNoDelay(true)
                    socket.setTimeout(socketTimeoutMs, () => {
                      socket.destroy(new Error('PostgreSQL connection exceeded its inactivity deadline'))
                    })
                    return socket.connect(host.startsWith('/') ? { path: `${host}/.s.PGSQL.${port}` } : { host, port })
                  },
                  idleTimeout: '30 seconds',
                  maxConnections: options.maxConnections,
                  minConnections: 0,
                  transformJson: false,
                }).pipe(
                  // Warm the connection before exposing the client. Only initialization is retried, never caller SQL.
                  Effect.tap((sql) => sql`SELECT 1`),
                  connectPostgresWithStartupRetry,
                  Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
                  Effect.mapError((cause) => classifyDatabaseError('connect', cause)),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  )
}
