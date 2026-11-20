import { Effect } from 'effect'

import { databaseError, type DatabaseError } from './database-error'

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

export const migrationTimeoutMs = 900_000
