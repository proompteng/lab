import { Duration, Effect, Queue, Schedule } from 'effect'

import { marketChangedEventId, type MarketChangedWakeup } from '../../execution/events'

// These are retries of retained work, never discovery of new market inputs.
export const marketHintRecoverySchedule = Schedule.exponential('1 second').pipe(
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(30)))),
)

/** Private-wake completion releases one immutable hint; newer changes occupy one conflated slot. */
export const makeMarketHints = (sourceRevision: string, producerId: string) =>
  Effect.gen(function* () {
    const changed = yield* Queue.dropping<void>(1)
    let sequence = 0
    let latest: MarketChangedWakeup | undefined
    return {
      changed: (reason: MarketChangedWakeup['reason']) =>
        Effect.sync(() => {
          sequence += 1
          latest = Object.freeze({
            schemaVersion: 'bayn.execution-wakeup.v1',
            _tag: 'MarketChanged',
            sourceRevision,
            producerId,
            sequence,
            reason,
            eventId: marketChangedEventId(producerId, sequence),
          })
          Queue.offerUnsafe(changed, undefined)
        }),
      serve: <E>(deliver: (event: MarketChangedWakeup) => Effect.Effect<void, E>) =>
        Effect.forever(
          Queue.take(changed).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                while (latest !== undefined) {
                  const event = latest
                  latest = undefined
                  yield* deliver(event).pipe(Effect.retry({ schedule: marketHintRecoverySchedule }))
                }
              }),
            ),
          ),
        ),
    }
  })
