import { expect, test } from 'bun:test'

import { Cause, Deferred, Effect, Exit, Fiber, Semaphore } from 'effect'
import { TestClock } from 'effect/testing'

import { operationalError } from '../errors'
import { IntradaySnapshotFailure } from '../market-data'
import { ObserveDecisionAwaitingSignal, decisionBuildError } from './decision-builder'
import { runRestateAdvanceWithinTimeout } from './recovery-driver'
import { shouldRestrictMutationLoopFailure } from './mutation-interpreter'
import { CycleRunnerError } from '../cycle/runner'

test('retries an oldest-unfinished preflight read without permanently restricting execution authority', () => {
  expect(
    shouldRestrictMutationLoopFailure(
      new CycleRunnerError({
        operation: 'read-oldest-unfinished',
        failure: 'store',
        message: 'oldest unfinished mutation cycle read failed',
      }),
    ),
  ).toBe(false)
  expect(
    shouldRestrictMutationLoopFailure(
      new CycleRunnerError({
        operation: 'recover-cycle',
        failure: 'store',
        message: 'durable submit recovery read failed',
      }),
    ),
  ).toBe(true)
})

test('maps an expected armed-entry wait to a non-terminal decision outcome', () => {
  const error = decisionBuildError(
    new ObserveDecisionAwaitingSignal({
      message: 'entry remains armed',
      observedAt: '2026-08-18T13:35:01.000Z',
      submissionCutoffAt: '2026-08-18T14:00:00.000Z',
    }),
  )

  expect(error).toMatchObject({ _tag: 'CycleDecisionBuildError', failure: 'not-ready' })
})

test('keeps an incomplete intraday archive retryable without weakening malformed-data failures', () => {
  const incomplete = decisionBuildError(
    operationalError({
      component: 'market-data',
      operation: 'load-intraday',
      message: 'intraday snapshot lacks a per-symbol range-completion bar',
      cause: new IntradaySnapshotFailure({
        reason: 'not-ready',
        message: 'intraday snapshot lacks a per-symbol range-completion bar',
        facts: { symbol: 'AMD', eventAt: '2026-08-27T13:34:00.000Z' },
      }),
    }),
  )
  const malformed = decisionBuildError(
    operationalError({
      component: 'market-data',
      operation: 'load-intraday',
      message: 'intraday snapshot duplicates a one-minute bar',
      cause: new IntradaySnapshotFailure({
        reason: 'coverage',
        message: 'intraday snapshot duplicates a one-minute bar',
      }),
    }),
  )

  expect(incomplete).toMatchObject({ _tag: 'CycleDecisionBuildError', failure: 'not-ready' })
  expect(malformed).toMatchObject({ _tag: 'CycleDecisionBuildError', failure: 'market-data' })
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
