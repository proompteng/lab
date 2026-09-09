import { PgClient, PgMigrator } from '@effect/sql-pg'
import { Effect, Layer, Schema } from 'effect'
import { isSqlError } from 'effect/unstable/sql/SqlError'

import type { RuntimeConfig } from '../config'
import { classifyDatabaseError, databaseError, DatabaseError } from './database-error'
import { migrationLoader } from './migrations'

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const MigrationBoundaryRow = Schema.Struct({
  current_exists: Schema.Boolean,
  legacy_exists: Schema.Boolean,
})
const MigrationIdentityRow = Schema.Struct({ migration_id: PositiveInteger, name: Schema.String })
const StrictParseOptions = { onExcessProperty: 'error' } as const
const decodeMigrationBoundary = Schema.decodeUnknownEffect(Schema.Tuple([MigrationBoundaryRow]), StrictParseOptions)
const decodeMigrationIdentities = Schema.decodeUnknownEffect(Schema.Array(MigrationIdentityRow), StrictParseOptions)

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

export const postgresMigrations = migrate.pipe(
  Effect.mapError((cause) =>
    cause instanceof DatabaseError
      ? cause
      : isSqlError(cause)
        ? classifyDatabaseError('migrate', cause)
        : databaseError({ failure: 'migration', operation: 'migrate', message: 'PostgreSQL migration failed', cause }),
  ),
  Effect.asVoid,
)

export const withMigrationDeadline = <R>(
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

export const PostgresMigrationsLive = (config: Pick<RuntimeConfig, 'operationTimeoutMs'>) =>
  Layer.effectDiscard(withMigrationDeadline(postgresMigrations, config.operationTimeoutMs))
