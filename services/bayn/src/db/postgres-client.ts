import { Socket } from 'node:net'

import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, FileSystem, Layer, Redacted } from 'effect'

import type { RuntimeConfig } from '../config'
import { classifyDatabaseError, databaseError, runDatabase } from './database-error'

export const postgresHealthCheck = (sql: PgClient.PgClient) => runDatabase('health', sql`SELECT 1`.pipe(Effect.asVoid))

export const PostgresClientLive = (config: Pick<RuntimeConfig, 'operationTimeoutMs' | 'postgres' | 'alpaca'>) => {
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
  return Layer.unwrap(
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
          Effect.map(({ url, host, port }) =>
            PgClient.layerFrom(
              PgClient.make({
                url,
                ssl: ca === undefined ? undefined : { ca, rejectUnauthorized: true },
                applicationName: 'bayn',
                connectTimeout: statementTimeoutMs,
                stream: () => {
                  const socket = new Socket()
                  socket.setTimeout(socketTimeoutMs, () => {
                    socket.destroy(new Error('PostgreSQL connection exceeded its inactivity deadline'))
                  })
                  return socket.connect(host.startsWith('/') ? { path: `${host}/.s.PGSQL.${port}` } : { host, port })
                },
                idleTimeout: '30 seconds',
                maxConnections: 8,
                minConnections: 0,
                transformJson: false,
              }).pipe(
                Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
                Effect.mapError((cause) => classifyDatabaseError('connect', cause)),
              ),
            ),
          ),
        ),
      ),
    ),
  )
}
