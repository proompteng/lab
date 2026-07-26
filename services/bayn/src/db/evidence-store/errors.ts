import { Data, Effect, Match, Schema } from 'effect'
import { isSqlError, type SqlErrorReason } from 'effect/unstable/sql/SqlError'

export type DatabaseFailure = 'constraint' | 'decode' | 'invariant' | 'migration' | 'query' | 'unavailable'

export class DatabaseError extends Data.TaggedError('DatabaseError')<{
  readonly failure: DatabaseFailure
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const unavailable = (): DatabaseFailure => 'unavailable'
const constraint = (): DatabaseFailure => 'constraint'
const query = (): DatabaseFailure => 'query'

const classifySqlReason: (reason: SqlErrorReason) => DatabaseFailure = Match.type<SqlErrorReason>().pipe(
  Match.tagsExhaustive({
    AuthenticationError: unavailable,
    AuthorizationError: unavailable,
    ConnectionError: unavailable,
    ConstraintError: constraint,
    DeadlockError: unavailable,
    LockTimeoutError: unavailable,
    SerializationError: unavailable,
    SqlSyntaxError: query,
    StatementTimeoutError: unavailable,
    UniqueViolation: constraint,
    UnknownError: unavailable,
  }),
)

export const databaseError = (
  failure: DatabaseFailure,
  operation: string,
  message: string,
  cause?: unknown,
): DatabaseError =>
  new DatabaseError({
    failure,
    operation,
    message: cause === undefined ? message : `${message}: ${messageOf(cause)}`,
    cause,
  })

export const classifyDatabaseError = (operation: string, cause: unknown): DatabaseError => {
  if (cause instanceof DatabaseError) return cause
  if (Schema.isSchemaError(cause)) return databaseError('decode', operation, 'database row decoding failed', cause)
  if (isSqlError(cause)) {
    return databaseError(classifySqlReason(cause.reason), operation, 'PostgreSQL operation failed', cause)
  }
  return databaseError('invariant', operation, 'unexpected database result', cause)
}

export const runDatabase = <A, E, R>(
  operation: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, DatabaseError, R> =>
  effect.pipe(Effect.mapError((cause) => classifyDatabaseError(operation, cause)))

export const ensure = (condition: boolean, operation: string, message: string): Effect.Effect<void, DatabaseError> =>
  condition ? Effect.void : Effect.fail(databaseError('invariant', operation, message))
