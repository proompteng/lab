import { Effect, Result, Schema } from 'effect'
import { isSqlError } from 'effect/unstable/sql/SqlError'

import { capitalGrantFailureDetails, type CapitalGrantAlgebraFailure } from '../capital-grant-algebra'
import { ReconciliationStoreError } from '../reconciliation'
import { ExecutionStoreError } from './contract'
import type { ExecutionStoreDecisionFailure } from './decisions'
import { Pipeable } from '../../pipeable'

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

export const executionStoreError = (
  operation: ExecutionStoreError['operation'],
  failure: ExecutionStoreError['failure'],
  message: string,
  cause?: unknown,
): ExecutionStoreError =>
  new ExecutionStoreError({
    operation,
    failure,
    message: cause === undefined ? message : `${message}: ${messageOf(cause)}`,
    cause,
  })

const failExecutionStoreDataFirst = (
  operation: ExecutionStoreError['operation'],
  failure: ExecutionStoreError['failure'],
  message: string,
): Effect.Effect<never, ExecutionStoreError> => Effect.fail(executionStoreError(operation, failure, message))

export const failExecutionStore = Pipeable.dual(3, failExecutionStoreDataFirst)

const runExecutionOperationDataFirst = <A, E, R>(
  operation: ExecutionStoreError['operation'],
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, ExecutionStoreError, R> =>
  effect.pipe(
    Effect.mapError((cause) => {
      if (cause instanceof ExecutionStoreError) return cause
      if (cause instanceof ReconciliationStoreError) {
        return executionStoreError(
          operation,
          cause.failure === 'ledger'
            ? 'ledger'
            : cause.failure === 'decode'
              ? 'decode'
              : cause.failure === 'invariant'
                ? 'invariant'
                : 'query',
          'paper reconciliation operation failed',
          cause,
        )
      }
      if (Schema.isSchemaError(cause)) {
        return executionStoreError(operation, 'decode', 'paper store contract decoding failed', cause)
      }
      if (isSqlError(cause)) {
        const failure =
          cause.reason._tag === 'ConstraintError' || cause.reason._tag === 'UniqueViolation' ? 'conflict' : 'query'
        return executionStoreError(operation, failure, 'paper store PostgreSQL operation failed', cause)
      }
      return executionStoreError(operation, 'invariant', 'paper store operation failed unexpectedly', cause)
    }),
  )

export const runExecutionOperation = Pipeable.generic<
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => (operation: ExecutionStoreError['operation']) => Effect.Effect<A, ExecutionStoreError, R>,
  typeof runExecutionOperationDataFirst
>(2, runExecutionOperationDataFirst)

const liftStoreDecisionDataFirst = <A>(
  operation: ExecutionStoreError['operation'],
  decision: Result.Result<A, ExecutionStoreDecisionFailure>,
): Effect.Effect<A, ExecutionStoreError> =>
  Effect.fromResult(decision).pipe(
    Effect.mapError((failure) => executionStoreError(operation, failure.failure, failure.message, failure.cause)),
  )

export const liftStoreDecision = Pipeable.generic<
  <A>(
    decision: Result.Result<A, ExecutionStoreDecisionFailure>,
  ) => (operation: ExecutionStoreError['operation']) => Effect.Effect<A, ExecutionStoreError>,
  typeof liftStoreDecisionDataFirst
>(2, liftStoreDecisionDataFirst)

export const liftAuthorityDecision = <A>(
  decision: Result.Result<A, CapitalGrantAlgebraFailure>,
): Effect.Effect<A, ExecutionStoreError> =>
  Effect.fromResult(decision).pipe(
    Effect.mapError((failure) => {
      const details = capitalGrantFailureDetails(failure)
      return executionStoreError('authority', details.failure, details.message, details.cause)
    }),
  )
