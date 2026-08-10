import { PgClient, PgMigrator } from '@effect/sql-pg'
import { Effect, FileSystem, Layer, Schema } from 'effect'
import { isSqlError } from 'effect/unstable/sql/SqlError'

import type { RuntimeConfig } from '../../config'
import { migrationLoader } from '../migrations'
import { classifyDatabaseError, databaseError, DatabaseError } from './errors'
import { EvidenceStore, type EvidenceStoreService } from './model'
import { makeEvidenceStore } from './postgres'

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const MigrationBoundaryRow = Schema.Struct({
  current_exists: Schema.Boolean,
  legacy_exists: Schema.Boolean,
})
const MigrationIdentityRow = Schema.Struct({ migration_id: PositiveInteger, name: Schema.String })
const StrictParseOptions = { onExcessProperty: 'error' } as const
const decodeMigrationBoundary = Schema.decodeUnknownEffect(Schema.Tuple([MigrationBoundaryRow]), StrictParseOptions)
const decodeMigrationIdentities = Schema.decodeUnknownEffect(Schema.Array(MigrationIdentityRow), StrictParseOptions)

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

const migrate = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const [boundary] = yield* decodeMigrationBoundary(
    yield* sql`
      SELECT
        to_regclass('public.schema_migrations') IS NOT NULL AS current_exists,
        to_regclass('public.bayn_schema_migrations') IS NOT NULL AS legacy_exists
    `,
  )
  if (boundary.legacy_exists) {
    return yield* databaseError({
      failure: 'migration',
      operation: 'migrate',
      message: 'legacy migration tracker is unsupported after the hard cut',
    })
  }
  if (boundary.current_exists) {
    const identities = yield* decodeMigrationIdentities(
      yield* sql`SELECT migration_id, name FROM schema_migrations WHERE migration_id = 1`,
    )
    const [initial] = identities
    if (identities.length !== 1 || initial?.name !== 'initial_schema') {
      return yield* databaseError({
        failure: 'migration',
        operation: 'migrate',
        message: 'legacy migration history is unsupported after the hard cut',
      })
    }
  }
  yield* PgMigrator.run({ loader: migrationLoader, table: 'schema_migrations' })
})

const migrations = migrate.pipe(
  Effect.mapError((cause) =>
    cause instanceof DatabaseError
      ? cause
      : isSqlError(cause)
        ? classifyDatabaseError('migrate', cause)
        : databaseError({ failure: 'migration', operation: 'migrate', message: 'PostgreSQL migration failed', cause }),
  ),
  Effect.asVoid,
)

const withMigrationDeadline = <R>(
  migration: Effect.Effect<void, DatabaseError, R>,
  operationTimeoutMs: number,
): Effect.Effect<void, DatabaseError, R> =>
  migration.pipe(
    Effect.timeoutOrElse({
      duration: operationTimeoutMs,
      orElse: () =>
        Effect.fail(
          databaseError({
            failure: 'migration',
            operation: 'migrate',
            message: `PostgreSQL migration timed out after ${operationTimeoutMs}ms`,
          }),
        ),
    }),
  )

export interface EvidenceStoreInitialization<RMigration, RStore> {
  readonly operationTimeoutMs: number
  readonly migration: Effect.Effect<void, DatabaseError, RMigration>
  readonly store: Effect.Effect<EvidenceStoreService, DatabaseError, RStore>
}

export const initializeEvidenceStore = <RMigration, RStore>(
  input: EvidenceStoreInitialization<RMigration, RStore>,
): Effect.Effect<EvidenceStoreService, DatabaseError, RMigration | RStore> =>
  withMigrationDeadline(input.migration, input.operationTimeoutMs).pipe(Effect.andThen(input.store))

export const EvidenceStoreFromPostgres = (config: Pick<RuntimeConfig, 'operationTimeoutMs'>) =>
  Layer.effect(
    EvidenceStore,
    initializeEvidenceStore({
      operationTimeoutMs: config.operationTimeoutMs,
      migration: migrations,
      store: Effect.map(PgClient.PgClient, makeEvidenceStore),
    }),
  )
