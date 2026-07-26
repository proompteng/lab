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
        databaseError('unavailable', 'tls', 'failed to read PostgreSQL CA certificate', cause),
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
    return yield* Effect.fail(
      databaseError('migration', 'migrate', 'legacy migration tracker is unsupported after the hard cut'),
    )
  }
  if (boundary.current_exists) {
    const identities = yield* decodeMigrationIdentities(
      yield* sql`SELECT migration_id, name FROM schema_migrations WHERE migration_id = 1`,
    )
    const [initial] = identities
    if (identities.length !== 1 || initial?.name !== 'initial_schema') {
      return yield* Effect.fail(
        databaseError('migration', 'migrate', 'legacy migration history is unsupported after the hard cut'),
      )
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
        : databaseError('migration', 'migrate', 'PostgreSQL migration failed', cause),
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
          databaseError('migration', 'migrate', `PostgreSQL migration timed out after ${operationTimeoutMs}ms`),
        ),
    }),
  )

export const makeEvidenceStoreLayer = <RMigration, RStore>(
  config: Pick<RuntimeConfig, 'operationTimeoutMs'>,
  migration: Effect.Effect<void, DatabaseError, RMigration>,
  store: Effect.Effect<EvidenceStoreService, DatabaseError, RStore>,
) =>
  Layer.effect(
    EvidenceStore,
    Effect.gen(function* () {
      yield* withMigrationDeadline(migration, config.operationTimeoutMs)
      return yield* store
    }),
  )

export const EvidenceStoreFromPostgres = (config: Pick<RuntimeConfig, 'operationTimeoutMs'>) =>
  makeEvidenceStoreLayer(config, migrations, makeEvidenceStore)

export const EvidenceStoreLive = (config: RuntimeConfig) =>
  EvidenceStoreFromPostgres(config).pipe(Layer.provideMerge(PostgresClientLive(config)))
