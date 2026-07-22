import { Duration, Effect, Layer, Schedule } from 'effect'
import { isSqlError } from 'effect/unstable/sql/SqlError'

import { DatabaseError } from './db/evidence-store'
import { operationalError, retryableOperationalError, type Component, type OperationalError } from './errors'

const isRetryableSqlAcquisition = (error: unknown): boolean => {
  const cause = error instanceof DatabaseError && error.failure === 'unavailable' ? error.cause : error
  if (!isSqlError(cause)) return false
  return cause.isRetryable || (cause.reason._tag === 'UnknownError' && cause.reason.operation === 'connect')
}

export const acquireSqlLayer = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  Layer.build(layer).pipe(
    Effect.retry({
      times: 2,
      schedule: Schedule.spaced(Duration.seconds(1)),
      while: isRetryableSqlAcquisition,
    }),
  )

export const withinDeadline = <A, R>(
  effect: Effect.Effect<A, OperationalError, R>,
  timeoutMs: number,
  component: Component,
  operation: string,
): Effect.Effect<A, OperationalError, R> =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail(retryableOperationalError(component, operation, `${operation} timed out after ${timeoutMs}ms`)),
    }),
  )

export const databaseOperation = <A, R>(
  effect: Effect.Effect<A, { readonly message: string }, R>,
  operation: string,
): Effect.Effect<A, OperationalError, R> =>
  effect.pipe(
    Effect.mapError((cause) => {
      const retryable =
        cause instanceof DatabaseError &&
        cause.failure === 'unavailable' &&
        (!isSqlError(cause.cause) || cause.cause.isRetryable)
      const makeError = retryable ? retryableOperationalError : operationalError
      return makeError('database', operation, `PostgreSQL ${operation} failed`, cause)
    }),
  )
