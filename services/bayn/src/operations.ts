import { Duration, Effect, Layer, Schedule } from 'effect'
import { isSqlError } from 'effect/unstable/sql/SqlError'

import { DatabaseError } from './db/evidence-store'
import { operationalError, retryableOperationalError, type Component, type OperationalError } from './errors'

export const acquireSqlLayer = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  Layer.build(layer).pipe(
    Effect.retry({
      times: 2,
      schedule: Schedule.spaced(Duration.seconds(1)),
      while: (error) => isSqlError(error) && error.isRetryable,
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
      const makeError =
        cause instanceof DatabaseError && cause.failure === 'unavailable' ? retryableOperationalError : operationalError
      return makeError('database', operation, `PostgreSQL ${operation} failed`, cause)
    }),
  )
