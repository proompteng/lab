import { expect, test } from 'bun:test'

import { Cause, Context, Deferred, Effect, Exit, Fiber, Semaphore } from 'effect'
import { TestClock } from 'effect/testing'

import type { AutonomousCycle } from '../cycle'
import { fixtureRuntime } from '../app-test-support'
import type { Policy } from '../risk'
import type { ObserveAutonomousCycleInput, ObserveDecisionRuntime, ObserveStartupPreparation } from './model'
import { mutationDecisionBuilder, runRestateAdvanceWithinTimeout } from './recovery-driver'

test('an every-session mutation rejects the multi-session strategy before reconciliation or decision I/O', async () => {
  let reconciled = false
  const input = {
    accountId: 'account-1',
    authorityGenerationHash: 'a'.repeat(64),
    pollIntervalMs: 30_000,
    reconciliationIntervalMs: 30_000,
    reconciliationPassTimeoutMs: 30_000,
    strategy: fixtureRuntime,
    cycleCadence: 'EVERY_SESSION',
  } satisfies ObserveAutonomousCycleInput

  const error = await Effect.runPromise(
    mutationDecisionBuilder(
      input,
      {} as ObserveStartupPreparation,
      {} as Policy,
    )(
      {} as AutonomousCycle,
      Effect.sync(() => {
        reconciled = true
        throw new Error('incompatible strategy must fail before reconciliation')
      }),
    ).pipe(Effect.flip, Effect.provide(Context.empty() as Context.Context<ObserveDecisionRuntime>)),
  )

  expect(error).toMatchObject({
    _tag: 'CycleDecisionBuildError',
    failure: 'contract',
    message: 'every-session mutation requires an INTRADAY strategy; risk-balanced-trend is MULTI_SESSION',
  })
  expect(reconciled).toBe(false)
})

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
      const advance = yield* runRestateAdvanceWithinTimeout(
        operationPermit,
        maintenance.pipe(Effect.andThen(cycle)),
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

test('the aggregate lifecycle budget includes time queued behind an already running advance', async () => {
  let cycleRuns = 0
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const operationPermit = yield* Semaphore.make(1)
      const priorAdvanceEntered = yield* Deferred.make<void>()
      const releasePriorAdvance = yield* Deferred.make<void>()
      const priorAdvance = yield* operationPermit
        .withPermit(
          Deferred.succeed(priorAdvanceEntered, undefined).pipe(Effect.andThen(Deferred.await(releasePriorAdvance))),
        )
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(priorAdvanceEntered)

      const advance = yield* runRestateAdvanceWithinTimeout(
        operationPermit,
        Effect.sync(() => {
          cycleRuns += 1
          return 'CYCLE' as const
        }),
        100,
        Effect.fail,
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      yield* TestClock.adjust(100)
      const result = yield* Fiber.await(advance)
      yield* Deferred.succeed(releasePriorAdvance, undefined)
      yield* Fiber.interrupt(priorAdvance)
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
      const advance = yield* runRestateAdvanceWithinTimeout(
        operationPermit,
        Deferred.succeed(maintenanceEntered, undefined).pipe(Effect.andThen(Effect.never)),
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

test('a timed-out Restate advance releases serialization for the next tick', async () => {
  let attempts = 0
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const operationPermit = yield* Semaphore.make(1)
      const firstEntered = yield* Deferred.make<void>()
      const runAdvance = runRestateAdvanceWithinTimeout(
        operationPermit,
        Effect.suspend(() => {
          attempts += 1
          return attempts === 1
            ? Deferred.succeed(firstEntered, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed('CYCLE' as const)
        }),
        100,
        Effect.fail,
      )
      const first = yield* runAdvance.pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(firstEntered)
      yield* TestClock.adjust(100)
      const firstExit = yield* Fiber.await(first)
      const second = yield* runAdvance
      return { firstExit, second }
    }).pipe(Effect.provide(TestClock.layer())),
  )

  expect(Exit.isFailure(result.firstExit)).toBe(true)
  expect(result.second).toBe('CYCLE')
  expect(attempts).toBe(2)
})
