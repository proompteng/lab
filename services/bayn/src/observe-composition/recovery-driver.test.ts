import { expect, test } from 'bun:test'

import { Cause, Deferred, Effect, Exit, Fiber } from 'effect'
import { TestClock } from 'effect/testing'

import { runExternalLifecycleAdvanceWithinTimeout } from './recovery-driver'

test('the aggregate lifecycle budget interrupts stalled maintenance before cycle work', async () => {
  let cycleRuns = 0
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const maintenanceEntered = yield* Deferred.make<void>()
      const maintenance = Deferred.succeed(maintenanceEntered, undefined).pipe(Effect.andThen(Effect.never))
      const cycle = Effect.sync(() => {
        cycleRuns += 1
        return 'CYCLE' as const
      })
      const advance = yield* runExternalLifecycleAdvanceWithinTimeout(
        maintenance,
        cycle,
        Effect.succeed('COMPLETED' as const),
        100,
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(maintenanceEntered)
      yield* TestClock.adjust(100)
      return yield* Fiber.await(advance)
    }).pipe(Effect.provide(TestClock.layer())),
  )

  expect(cycleRuns).toBe(0)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(Cause.pretty(exit.cause)).toContain(
      'mutation autonomous cycle pass did not complete or reconcile within 100ms',
    )
  }
})
