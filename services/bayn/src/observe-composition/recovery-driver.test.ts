import { expect, test } from 'bun:test'

import { Cause, Deferred, Effect, Exit, Fiber, Semaphore } from 'effect'
import { TestClock } from 'effect/testing'

import { runExternalLifecycleAdvanceWithinTimeout } from './recovery-driver'

test('the aggregate lifecycle budget interrupts stalled maintenance before cycle work', async () => {
  let cycleRuns = 0
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const operationPermit = yield* Semaphore.make(1)
      const maintenanceEntered = yield* Deferred.make<void>()
      const maintenance = Deferred.succeed(maintenanceEntered, undefined).pipe(Effect.andThen(Effect.never))
      const cycle = Effect.sync(() => {
        cycleRuns += 1
        return 'CYCLE' as const
      })
      const advance = yield* runExternalLifecycleAdvanceWithinTimeout(
        operationPermit,
        maintenance,
        cycle,
        Effect.succeed('COMPLETED' as const),
        100,
        Effect.fail,
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

test('the aggregate lifecycle budget includes time queued behind the reconciliation permit', async () => {
  let cycleRuns = 0
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const operationPermit = yield* Semaphore.make(1)
      const guardianEntered = yield* Deferred.make<void>()
      const releaseGuardian = yield* Deferred.make<void>()
      const guardian = yield* operationPermit
        .withPermit(Deferred.succeed(guardianEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseGuardian))))
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(guardianEntered)

      const advance = yield* runExternalLifecycleAdvanceWithinTimeout(
        operationPermit,
        undefined,
        Effect.sync(() => {
          cycleRuns += 1
          return 'CYCLE' as const
        }),
        Effect.succeed('COMPLETED' as const),
        100,
        Effect.fail,
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      yield* TestClock.adjust(100)
      const result = yield* Fiber.await(advance)
      yield* Deferred.succeed(releaseGuardian, undefined)
      yield* Fiber.interrupt(guardian)
      return result
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

test('the aggregate lifecycle timeout is handled before returning to the external controller', async () => {
  const handled: string[] = []
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const operationPermit = yield* Semaphore.make(1)
      const maintenanceEntered = yield* Deferred.make<void>()
      const advance = yield* runExternalLifecycleAdvanceWithinTimeout(
        operationPermit,
        Deferred.succeed(maintenanceEntered, undefined).pipe(Effect.andThen(Effect.never)),
        Effect.succeed('CYCLE' as const),
        Effect.succeed('COMPLETED' as const),
        100,
        (error) =>
          Effect.sync(() => {
            handled.push(error.message)
            return 'BLOCKED' as const
          }),
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(maintenanceEntered)
      yield* TestClock.adjust(100)
      return yield* Fiber.join(advance)
    }).pipe(Effect.provide(TestClock.layer())),
  )

  expect(result).toBe('BLOCKED')
  expect(handled).toEqual(['mutation autonomous cycle pass did not complete or reconcile within 100ms'])
})
