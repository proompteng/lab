import { expect, test } from 'bun:test'
import { Clock, Deferred, Effect, Fiber, Logger, Ref, References, Semaphore } from 'effect'
import { TestClock } from 'effect/testing'
import { runMutationPassWithinTimeout } from './observe-composition/decision-builder'
import { runRestateAdvanceWithinTimeout } from './observe-composition/recovery-driver'
import { OperationDeadlineClock, operationTimeoutOrElse } from './operation-timeout'
import { withObservedStage } from './telemetry'

test('operation failures and defects propagate without invoking deadline recovery', async () => {
  for (const [message, operation] of [
    ['typed failure', Effect.fail('typed failure')],
    ['defect', Effect.die('defect')],
  ] as const) {
    let finalized = 0
    let recovered = false
    let expired = false
    const exit = await Effect.runPromiseExit(
      operation.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            finalized += 1
          }),
        ),
        operationTimeoutOrElse({
          duration: '1 second',
          onDeadline: Effect.sync(() => {
            expired = true
          }),
          orElse: () =>
            Effect.sync(() => {
              recovered = true
            }),
        }),
      ),
    )
    expect(exit._tag).toBe('Failure')
    expect(JSON.stringify(exit)).toContain(message)
    expect(finalized).toBe(1)
    expect(recovered).toBe(false)
    expect(expired).toBe(false)
  }
})

test('parent interruption cancels the operation exactly once without starting recovery', async () => {
  let finalized = 0
  let recovered = false
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const child = yield* Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            finalized += 1
          }),
        ),
        operationTimeoutOrElse({
          duration: '1 hour',
          orElse: () =>
            Effect.sync(() => {
              recovered = true
            }),
        }),
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Deferred.await(started)
      yield* Fiber.interrupt(child)
    }),
  )
  expect(finalized).toBe(1)
  expect(recovered).toBe(false)
})

test('reports execution, cancellation and timeout recovery as separate durations', async () => {
  const logs: Readonly<Record<string, unknown>>[] = []
  const logger = Logger.make(({ fiber }) => logs.push(fiber.getRef(References.CurrentLogAnnotations)))
  await Effect.runPromise(
    Effect.gen(function* () {
      const permit = yield* Semaphore.make(1)
      const cancellation = yield* Deferred.make<void>()
      const releaseCancellation = yield* Deferred.make<void>()
      const recovery = yield* Deferred.make<void>()
      const releaseRecovery = yield* Deferred.make<void>()
      const run = yield* runRestateAdvanceWithinTimeout(
        permit,
        Effect.never.pipe(
          Effect.ensuring(
            Deferred.succeed(cancellation, undefined).pipe(Effect.andThen(Deferred.await(releaseCancellation))),
          ),
          withObservedStage('bayn.postgres.connection-acquire', { dependency: 'postgresql' }),
        ),
        100,
        () =>
          Deferred.succeed(recovery, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRecovery)),
            Effect.as('recovered'),
          ),
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust(100)
      yield* Deferred.await(cancellation)
      expect(logs).toContainEqual(expect.objectContaining({ executionElapsedMs: 100 }))
      expect(logs).toContainEqual(
        expect.objectContaining({
          activeStages: expect.arrayContaining([
            {
              stage: 'bayn.postgres.connection-acquire',
              dependency: 'postgresql',
              elapsedMs: 100,
            },
          ]),
        }),
      )
      yield* TestClock.adjust(250)
      yield* Deferred.succeed(releaseCancellation, undefined)
      yield* Deferred.await(recovery)
      yield* TestClock.adjust(500)
      yield* Deferred.succeed(releaseRecovery, undefined)
      expect(yield* Fiber.join(run)).toBe('recovered')
    }).pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([logger]))),
  )
  expect(logs).toContainEqual(
    expect.objectContaining({ executionElapsedMs: 100, cancellationElapsedMs: 250, elapsedMs: 350 }),
  )
  expect(logs).toContainEqual(
    expect.objectContaining({ stage: 'bayn.execution.timeout-recovery', elapsedMs: 500, outcome: 'succeeded' }),
  )
})

test('a live deadline interrupts a stalled native pass while market time remains frozen', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const live = yield* TestClock.withLive(Clock.clockWith(Effect.succeed))
      yield* TestClock.setTime(Date.parse('2026-09-11T14:00:00Z'))
      const before = yield* Clock.currentTimeMillis
      const interrupted = yield* Ref.make(false)
      const outcome = yield* Effect.exit(
        runMutationPassWithinTimeout(Effect.never.pipe(Effect.onInterrupt(() => Ref.set(interrupted, true))), 20).pipe(
          Effect.provideService(OperationDeadlineClock, live),
        ),
      )
      expect(outcome._tag).toBe('Failure')
      expect(JSON.stringify(outcome)).toContain('did not complete or reconcile within 20ms')
      expect(yield* Ref.get(interrupted)).toBe(true)
      expect(yield* Clock.currentTimeMillis).toBe(before)
      const permit = yield* Semaphore.make(0)
      const recoveredAt = yield* runRestateAdvanceWithinTimeout(
        permit,
        Effect.never,
        20,
        () => Clock.currentTimeMillis,
      ).pipe(Effect.provideService(OperationDeadlineClock, live))
      expect(recoveredAt).toBe(before)
    }).pipe(Effect.provide(TestClock.layer()), Effect.timeout('2 seconds')),
  )
})

test('the deadline override does not change successful operation timestamps', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const live = yield* TestClock.withLive(Clock.clockWith(Effect.succeed))
      yield* TestClock.setTime(1000)
      const observed = yield* Clock.currentTimeMillis.pipe(
        operationTimeoutOrElse({ duration: 100, orElse: () => Effect.succeed(-1) }),
        Effect.provideService(OperationDeadlineClock, live),
      )
      expect(observed).toBe(1000)
    }).pipe(Effect.provide(TestClock.layer()), Effect.timeout('2 seconds')),
  )
})
