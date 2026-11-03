import { isNativeError } from 'node:util/types'
import { Effect, Exit, Layer, Schedule, Scope } from 'effect'
import type { RedisError } from 'effect/persistence/Redis'

const startupConnectionRefused = (error: RedisError) =>
  isNativeError(error.cause) && Object.getOwnPropertyDescriptor(error.cause, 'code')?.value === 'ECONNREFUSED'

export const withValkeyStartupRetry = <A, R>(layer: Layer.Layer<A, RedisError, R>) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const parent = yield* Effect.scope
      const attempt = Effect.gen(function* () {
        const scope = yield* Scope.fork(parent)
        return yield* Layer.buildWithScope(Layer.fresh(layer), scope).pipe(
          Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
        )
      })
      return yield* attempt.pipe(
        Effect.tapError((error) =>
          startupConnectionRefused(error)
            ? Effect.logWarning('Valkey startup connection refused').pipe(
                Effect.annotateLogs({ dependency: 'valkey', operation: 'connect', code: 'ECONNREFUSED' }),
              )
            : Effect.void,
        ),
        Effect.retry({ while: startupConnectionRefused, times: 2, schedule: Schedule.spaced('1 second') }),
      )
    }),
  )
