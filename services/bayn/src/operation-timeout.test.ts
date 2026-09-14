import { expect, test } from 'bun:test'
import { Clock, Effect, Ref, Semaphore } from 'effect'
import { TestClock } from 'effect/testing'
import { runMutationPassWithinTimeout } from './observe-composition/decision-builder'
import { runRestateAdvanceWithinTimeout } from './observe-composition/recovery-driver'
import { OperationDeadlineClock, operationTimeoutOrElse } from './operation-timeout'

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
