import { Clock, Context, Duration, Effect } from 'effect'

/** Replay overrides deadline timing without changing market timestamps inside operations or their fallback. */
export const OperationDeadlineClock = Context.Reference<Clock.Clock | undefined>('bayn/OperationDeadlineClock', {
  defaultValue: () => undefined,
})

export const operationCurrentTimeMillis = OperationDeadlineClock.pipe(
  Effect.flatMap((clock) => clock?.currentTimeMillis ?? Clock.currentTimeMillis),
)

export const operationTimeoutOrElse =
  <B, E2, R2>(options: { readonly duration: Duration.Input; readonly orElse: () => Effect.Effect<B, E2, R2> }) =>
  <A, E, R>(operation: Effect.Effect<A, E, R>): Effect.Effect<A | B, E | E2, R | R2> =>
    Effect.gen(function* () {
      const domainClock = yield* Clock.clockWith(Effect.succeed)
      const deadlineClock = (yield* OperationDeadlineClock) ?? domainClock
      return yield* operation.pipe(
        Effect.provideService(Clock.Clock, domainClock),
        Effect.timeoutOrElse({
          duration: options.duration,
          orElse: () => options.orElse().pipe(Effect.provideService(Clock.Clock, domainClock)),
        }),
        Effect.provideService(Clock.Clock, deadlineClock),
      )
    })
