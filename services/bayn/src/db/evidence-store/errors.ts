import { Data, Effect, Match, Schema } from 'effect'
import { isSqlError, type SqlErrorReason } from 'effect/unstable/sql/SqlError'

import { renderEvidenceRecoveryIssue, type EvidenceRecoveryIssue } from '../evidence-recovery'
import { renderPersistencePlanFailure } from './persistence-failures'
import type { PersistencePlanFailure } from './persistence-model'
import {
  renderQualificationDecisionFailure,
  renderStoredQualificationFailure,
  type QualificationDecisionFailure,
  type StoredQualificationFailure,
} from './qualification'

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

export const databaseError = (
  failure: DatabaseFailure,
  operation: string,
  message: string,
  cause?: unknown,
  persistenceFailure = defaultPersistenceFailure(failure),
): DatabaseError =>
  new DatabaseError({
    failure,
    persistenceFailure,
    operation,
    message: cause === undefined ? message : `${message}: ${messageOf(cause)}`,
    cause,
  })

export const classifyDatabaseError = (operation: string, cause: unknown): DatabaseError => {
  if (cause instanceof DatabaseError) return cause
  if (Schema.isSchemaError(cause)) return databaseError('decode', operation, 'database row decoding failed', cause)
  if (isSqlError(cause)) {
    const classified = classifySqlReason(cause.reason)
    return databaseError(
      classified.failure,
      operation,
      'PostgreSQL operation failed',
      cause,
      classified.persistenceFailure,
    )
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

export const persistencePlanDatabaseError = (operation: string, failure: PersistencePlanFailure): DatabaseError =>
  databaseError(
    'invariant',
    operation,
    renderPersistencePlanFailure(failure),
    failure._tag === 'SimulationReconciliationFailed' ? failure.issues : failure,
  )

export const qualificationDecisionDatabaseError = (
  operation: string,
  failure: QualificationDecisionFailure,
): DatabaseError => databaseError('invariant', operation, renderQualificationDecisionFailure(failure), failure)

export const storedQualificationDatabaseError = (
  operation: string,
  failure: StoredQualificationFailure,
): DatabaseError => databaseError('invariant', operation, renderStoredQualificationFailure(failure), failure)

export const evidenceRecoveryDatabaseError = (operation: string, issue: EvidenceRecoveryIssue): DatabaseError =>
  databaseError(
    issue._tag === 'DecodeFailure' ? 'decode' : 'invariant',
    operation,
    renderEvidenceRecoveryIssue(issue),
    issue._tag === 'SimulationFailure' ? issue.issues : issue,
  )
