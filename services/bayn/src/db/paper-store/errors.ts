import { Effect, Result, Schema } from 'effect'
import { isSqlError } from 'effect/unstable/sql/SqlError'

import { paperAuthorityFailureDetails, type PaperAuthorityAlgebraFailure } from '../paper-authority-algebra'
import { ReconciliationStoreError } from '../reconciliation'
import { PaperStoreError } from './contract'
import type { PaperStoreDecisionFailure } from './decisions'

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

export const paperStoreError = (
  operation: PaperStoreError['operation'],
  failure: PaperStoreError['failure'],
  message: string,
  cause?: unknown,
): PaperStoreError =>
  new PaperStoreError({
    operation,
    failure,
    message: cause === undefined ? message : `${message}: ${messageOf(cause)}`,
    cause,
  })

export const failPaperStore = (
  operation: PaperStoreError['operation'],
  failure: PaperStoreError['failure'],
  message: string,
): Effect.Effect<never, PaperStoreError> => Effect.fail(paperStoreError(operation, failure, message))

export const runPaperOperation = <A, E, R>(
  operation: PaperStoreError['operation'],
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, PaperStoreError, R> =>
  effect.pipe(
    Effect.mapError((cause) => {
      if (cause instanceof PaperStoreError) return cause
      if (cause instanceof ReconciliationStoreError) {
        return paperStoreError(
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
        return paperStoreError(operation, 'decode', 'paper store contract decoding failed', cause)
      }
      if (isSqlError(cause)) {
        const failure =
          cause.reason._tag === 'ConstraintError' || cause.reason._tag === 'UniqueViolation' ? 'conflict' : 'query'
        return paperStoreError(operation, failure, 'paper store PostgreSQL operation failed', cause)
      }
      return paperStoreError(operation, 'invariant', 'paper store operation failed unexpectedly', cause)
    }),
  )

export const liftPaperDecision = <A>(
  operation: PaperStoreError['operation'],
  decision: Result.Result<A, PaperStoreDecisionFailure>,
): Effect.Effect<A, PaperStoreError> =>
  Effect.fromResult(decision).pipe(
    Effect.mapError((failure) => paperStoreError(operation, failure.failure, failure.message, failure.cause)),
  )

export const liftAuthorityDecision = <A>(
  decision: Result.Result<A, PaperAuthorityAlgebraFailure>,
): Effect.Effect<A, PaperStoreError> =>
  Effect.fromResult(decision).pipe(
    Effect.mapError((failure) => {
      const details = paperAuthorityFailureDetails(failure)
      return paperStoreError('authority', details.failure, details.message, details.cause)
    }),
  )
