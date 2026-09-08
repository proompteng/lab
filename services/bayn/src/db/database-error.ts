import { Data, Effect, Match, Schema } from 'effect'
import { isSqlError, type SqlErrorReason } from 'effect/unstable/sql/SqlError'

import { Pipeable } from '../pipeable'

export type DatabaseFailure = 'constraint' | 'decode' | 'invariant' | 'migration' | 'query' | 'unavailable'
export type PersistenceFailure = 'connectivity' | 'constraint' | 'decode' | 'invariant' | 'query' | 'transaction'

export class DatabaseError extends Data.TaggedError('DatabaseError')<{
  readonly failure: DatabaseFailure
  readonly persistenceFailure?: PersistenceFailure
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

interface ClassifiedSqlFailure {
  readonly failure: DatabaseFailure
  readonly persistenceFailure: PersistenceFailure
}

const connectivity = (): ClassifiedSqlFailure => ({ failure: 'unavailable', persistenceFailure: 'connectivity' })
const constraint = (): ClassifiedSqlFailure => ({ failure: 'constraint', persistenceFailure: 'constraint' })
const query = (): ClassifiedSqlFailure => ({ failure: 'query', persistenceFailure: 'query' })
const transaction = (): ClassifiedSqlFailure => ({ failure: 'unavailable', persistenceFailure: 'transaction' })

const classifySqlReason: (reason: SqlErrorReason) => ClassifiedSqlFailure = Match.type<SqlErrorReason>().pipe(
  Match.tagsExhaustive({
    AuthenticationError: connectivity,
    AuthorizationError: connectivity,
    ConnectionError: connectivity,
    ConstraintError: constraint,
    DeadlockError: transaction,
    LockTimeoutError: transaction,
    SerializationError: transaction,
    SqlSyntaxError: query,
    StatementTimeoutError: transaction,
    UniqueViolation: constraint,
    UnknownError: connectivity,
  }),
)

const defaultPersistenceFailure = (failure: DatabaseFailure): PersistenceFailure => {
  switch (failure) {
    case 'constraint':
      return 'constraint'
    case 'decode':
      return 'decode'
    case 'query':
      return 'query'
    case 'unavailable':
      return 'connectivity'
    case 'invariant':
    case 'migration':
      return 'invariant'
  }
}

export interface DatabaseErrorInput {
  readonly failure: DatabaseFailure
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
  readonly persistenceFailure?: PersistenceFailure
}

export const databaseError = (input: DatabaseErrorInput): DatabaseError => {
  const { failure, operation, message, cause, persistenceFailure = defaultPersistenceFailure(failure) } = input
  return new DatabaseError({
    failure,
    persistenceFailure,
    operation,
    message: cause === undefined ? message : `${message}: ${messageOf(cause)}`,
    cause,
  })
}

const classifyDatabaseErrorDataFirst = (operation: string, cause: unknown): DatabaseError => {
  if (cause instanceof DatabaseError) return cause
  if (Schema.isSchemaError(cause)) {
    return databaseError({ failure: 'decode', operation, message: 'database row decoding failed', cause })
  }
  if (isSqlError(cause)) {
    const classified = classifySqlReason(cause.reason)
    return databaseError({
      failure: classified.failure,
      operation,
      message: 'PostgreSQL operation failed',
      cause,
      persistenceFailure: classified.persistenceFailure,
    })
  }
  return databaseError({ failure: 'invariant', operation, message: 'unexpected database result', cause })
}

export const classifyDatabaseError = Pipeable.dual(2, classifyDatabaseErrorDataFirst)

const runDatabaseDataFirst = <A, E, R>(
  operation: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, DatabaseError, R> =>
  effect.pipe(Effect.mapError((cause) => classifyDatabaseError(operation, cause)))

export const runDatabase = Pipeable.generic<
  <A, E, R>(effect: Effect.Effect<A, E, R>) => (operation: string) => Effect.Effect<A, DatabaseError, R>,
  typeof runDatabaseDataFirst
>(2, runDatabaseDataFirst)

const ensureDataFirst = (condition: boolean, operation: string, message: string): Effect.Effect<void, DatabaseError> =>
  condition ? Effect.void : Effect.fail(databaseError({ failure: 'invariant', operation, message }))

export const ensure = Pipeable.dual(3, ensureDataFirst)
