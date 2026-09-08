import { PgClient } from '@effect/sql-pg'
import { Effect, FileSystem, Layer } from 'effect'

import type { RuntimeConfig } from '../config'
import { classifyDatabaseError, databaseError, runDatabase } from './database-error'

export const postgresHealthCheck = (sql: PgClient.PgClient) => runDatabase('health', sql`SELECT 1`.pipe(Effect.asVoid))

export const PostgresClientLive = (config: Pick<RuntimeConfig, 'operationTimeoutMs' | 'postgres'>) => {
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
      Effect.map((ca) =>
        PgClient.layerFrom(
          PgClient.make({
            url: config.postgres.url,
            ssl: ca === undefined ? undefined : { ca, rejectUnauthorized: true },
            applicationName: 'bayn',
            connectTimeout: config.operationTimeoutMs,
            idleTimeout: '30 seconds',
            maxConnections: 2,
            minConnections: 0,
            transformJson: false,
          }).pipe(Effect.mapError((cause) => classifyDatabaseError('connect', cause))),
        ),
      ),
    ),
  )
}
