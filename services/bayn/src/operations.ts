import { Duration, Effect, Layer, Schedule } from 'effect'
import { isSqlError } from 'effect/unstable/sql/SqlError'

import { CycleObservabilityError } from './db/cycle-observability'
import { DatabaseError } from './db/evidence-store'
import { operationalError, retryableOperationalError, type Component, type OperationalError } from './errors'
import { retryLayerAcquisition } from './resource-boundary'
import { Pipeable } from './pipeable'

type DatabaseOperationFailure = DatabaseError | CycleObservabilityError

const isRetryableSqlAcquisition = (error: unknown): boolean => {
  if (isSqlError(error)) return error.isRetryable
  if (!(error instanceof DatabaseError) || error.failure !== 'unavailable' || !isSqlError(error.cause)) return false
  if (error.cause.isRetryable) return true
  const reason = error.cause.reason
  return (
    reason._tag === 'UnknownError' &&
    reason.operation === 'connect' &&
    typeof reason.cause === 'object' &&
    reason.cause !== null &&
    'code' in reason.cause &&
    reason.cause.code === 'ECONNREFUSED'
  )
}

export const sqlResource = <A, E, R>(layer: Layer.Layer<A, E, R>): Layer.Layer<A, E, R> =>
  retryLayerAcquisition(layer, (acquisition) =>
    acquisition.pipe(
      Effect.retry({
        times: 2,
        schedule: Schedule.spaced(Duration.seconds(1)),
        while: isRetryableSqlAcquisition,
      }),
    ),
  )

const withinDeadlineDataFirst = <A, R>(
  effect: Effect.Effect<A, OperationalError, R>,
  timeoutMs: number,
  component: Component,
  operation: string,
): Effect.Effect<A, OperationalError, R> =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail(
          retryableOperationalError({
            component,
            operation,
            message: `${operation} timed out after ${timeoutMs}ms`,
          }),
        ),
    }),
  )

export const withinDeadline = Pipeable.generic<
  <A, R>(
    timeoutMs: number,
    component: Component,
    operation: string,
  ) => (effect: Effect.Effect<A, OperationalError, R>) => Effect.Effect<A, OperationalError, R>,
  typeof withinDeadlineDataFirst
>(4, withinDeadlineDataFirst)

const databaseOperationDataFirst = <A, R>(
  effect: Effect.Effect<A, DatabaseOperationFailure, R>,
  operation: string,
): Effect.Effect<A, OperationalError, R> =>
  effect.pipe(
    Effect.mapError((cause) => {
      const retryable =
        cause instanceof DatabaseError
          ? cause.failure === 'unavailable' && (!isSqlError(cause.cause) || cause.cause.isRetryable)
          : cause.failure === 'query' && isSqlError(cause.cause) && cause.cause.isRetryable
      const makeError = retryable ? retryableOperationalError : operationalError
      return makeError({ component: 'database', operation, message: `PostgreSQL ${operation} failed`, cause })
    }),
  )

export const databaseOperation = Pipeable.generic<
  <A, R>(
    operation: string,
  ) => (effect: Effect.Effect<A, DatabaseOperationFailure, R>) => Effect.Effect<A, OperationalError, R>,
  typeof databaseOperationDataFirst
>(2, databaseOperationDataFirst)
