import { Duration, Effect, Queue, Schedule } from 'effect'

import type { PendingMarketReady } from '../../db/market-ready-postgres'
import type { MarketReadyWakeup } from '../../execution/events'
import type { NativeArrivalCaptureError } from './native-arrival'

export interface MarketReadyOutbox {
  readonly next: Effect.Effect<PendingMarketReady | undefined, NativeArrivalCaptureError>
  readonly acknowledge: (pending: PendingMarketReady) => Effect.Effect<void, NativeArrivalCaptureError>
}

// These are retries of retained work, never discovery of new market inputs.
export const marketReadyRecoverySchedule = Schedule.exponential('1 second').pipe(
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(30)))),
)

/** Drains once at startup, then only after committed appends. Transport completion acknowledges a durable prefix. */
export const serveMarketReadyOutbox = <E>(
  outbox: MarketReadyOutbox,
  changed: Queue.Queue<void>,
  deliver: (event: MarketReadyWakeup) => Effect.Effect<void, E>,
) =>
  Effect.gen(function* () {
    Queue.offerUnsafe(changed, undefined)
    return yield* Effect.forever(
      Queue.take(changed).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            while (true) {
              const next = yield* outbox.next.pipe(Effect.retry({ schedule: marketReadyRecoverySchedule }))
              if (next === undefined) return
              yield* deliver(next.event).pipe(Effect.retry({ schedule: marketReadyRecoverySchedule }))
              yield* outbox.acknowledge(next).pipe(Effect.retry({ schedule: marketReadyRecoverySchedule }))
            }
          }),
        ),
      ),
    )
  })
