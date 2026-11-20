import { Clock, Effect, Metric } from 'effect'

const schedulerDelay = Metric.histogram('bayn_scheduler_delay_seconds', {
  description: 'Monotonic excess delay resuming a one-second diagnostic sleep, including local scheduler contention.',
  boundaries: Metric.boundariesFromIterable([0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]),
})

// One completed wake-up is one sample. A stalled process never backfills missed ticks.
export const observeSchedulerDelay = Effect.gen(function* () {
  while (true) {
    const started = yield* Clock.monotonicTimeNanos
    yield* Effect.sleep('1 second')
    const completed = yield* Clock.monotonicTimeNanos
    yield* Metric.update(schedulerDelay, Math.max(0, Number(completed - started) / 1_000_000_000 - 1))
  }
}).pipe(Effect.catchDefect(() => Effect.logWarning('Bayn scheduler-delay diagnostics stopped')))
