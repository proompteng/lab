import { isNativeError } from 'node:util/types'
import { Effect, Exit, Fiber, Layer, Schedule, Scope } from 'effect'
import { RedisError } from 'effect/persistence/Redis'
import { ConnectionTimeoutError } from 'redis'

const startupConnectionRefused = (error: RedisError) =>
  isNativeError(error.cause) && Object.getOwnPropertyDescriptor(error.cause, 'code')?.value === 'ECONNREFUSED'

export const withValkeyStartupRetry = <A, R>(makeLayer: (signal: AbortSignal) => Layer.Layer<A, RedisError, R>) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const parent = yield* Effect.scope
      const attempt = Effect.gen(function* () {
        const controller = new AbortController()
        const scope = yield* Scope.fork(parent)
        return yield* Effect.acquireUseRelease(
          // Own the build in the attempt scope so cancellation can abort the socket before joining finalizers.
          Layer.buildWithScope(Layer.fresh(makeLayer(controller.signal)), scope).pipe(
            Effect.forkIn(scope, { startImmediately: true, uninterruptible: false }),
          ),
          (build) =>
            Fiber.join(build).pipe(
              // Bound the complete TCP/TLS/RESP acquisition without timing out healthy idle sockets.
              Effect.timeoutOrElse({
                duration: '2 seconds',
                orElse: () => Effect.fail(new RedisError({ cause: new ConnectionTimeoutError() })),
              }),
            ),
          (build, exit) =>
            Exit.isFailure(exit)
              ? Effect.sync(() => controller.abort()).pipe(
                  // Native abort must flush the handshake before NodeRedis's graceful finalizer runs.
                  Effect.andThen(Fiber.await(build)),
                  Effect.andThen(Scope.close(scope, exit)),
                )
              : Effect.void,
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
