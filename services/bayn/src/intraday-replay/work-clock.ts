import { Clock, Deferred, Duration, Effect } from 'effect'
import { ReplayBrokerFailure } from './broker'

export const makeReplayWorkClock = (provider: Clock.Clock) =>
  Effect.gen(function* () {
    let changed = yield* Deferred.make<void>()
    let sourceStarted: { readonly millis: number; readonly nanos: bigint; readonly monotonicNanos: bigint } | undefined
    let excludedMillis = 0
    let excludedNanos = 0n
    let excludedMonotonicNanos = 0n
    const signal = Effect.gen(function* () {
      const previous = changed
      changed = yield* Deferred.make<void>()
      yield* Deferred.succeed(previous, undefined)
    })
    const currentTimeMillisUnsafe = () => (sourceStarted?.millis ?? provider.currentTimeMillisUnsafe()) - excludedMillis
    const currentTimeNanosUnsafe = () => (sourceStarted?.nanos ?? provider.currentTimeNanosUnsafe()) - excludedNanos
    const monotonicTimeNanosUnsafe = () =>
      (sourceStarted?.monotonicNanos ?? provider.monotonicTimeNanosUnsafe()) - excludedMonotonicNanos
    const clock: Clock.Clock = {
      currentTimeMillisUnsafe,
      currentTimeMillis: Effect.sync(currentTimeMillisUnsafe),
      currentTimeNanosUnsafe,
      currentTimeNanos: Effect.sync(currentTimeNanosUnsafe),
      monotonicTimeNanosUnsafe,
      monotonicTimeNanos: Effect.sync(monotonicTimeNanosUnsafe),
      sleep: (duration) =>
        Effect.gen(function* () {
          if (!Duration.isFinite(duration)) return yield* Effect.never
          const deadline = monotonicTimeNanosUnsafe() + Duration.toNanosUnsafe(duration)
          while (true) {
            const nextChange = changed
            const remaining = deadline - monotonicTimeNanosUnsafe()
            if (remaining <= 0n) return
            if (sourceStarted !== undefined) yield* Deferred.await(nextChange)
            else yield* Effect.raceFirst(provider.sleep(Duration.nanos(remaining)), Deferred.await(nextChange))
          }
        }),
    }
    const excludeSourceTime = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          if (sourceStarted !== undefined)
            return yield* new ReplayBrokerFailure({ message: 'Replay source clock cannot pause twice' })
          sourceStarted = {
            millis: provider.currentTimeMillisUnsafe(),
            nanos: provider.currentTimeNanosUnsafe(),
            monotonicNanos: provider.monotonicTimeNanosUnsafe(),
          }
          yield* signal
          return sourceStarted
        }),
        () => operation,
        (started) =>
          Effect.gen(function* () {
            const elapsedMillis = provider.currentTimeMillisUnsafe() - started.millis
            const elapsedNanos = provider.currentTimeNanosUnsafe() - started.nanos
            const elapsedMonotonicNanos = provider.monotonicTimeNanosUnsafe() - started.monotonicNanos
            sourceStarted = undefined
            if (elapsedMillis < 0 || elapsedNanos < 0n || elapsedMonotonicNanos < 0n)
              return yield* signal.pipe(
                Effect.andThen(
                  Effect.fail(
                    new ReplayBrokerFailure({
                      message: 'Replay provider clock moved backwards during source work',
                    }),
                  ),
                ),
              )
            excludedMillis += elapsedMillis
            excludedNanos += elapsedNanos
            excludedMonotonicNanos += elapsedMonotonicNanos
            yield* signal
          }),
      )
    return { clock, excludeSourceTime, excludedSourceMillis: Effect.sync(() => excludedMillis) }
  })
