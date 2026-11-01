import { expect, test } from 'bun:test'
import { Effect, Exit, Fiber, Logger, References } from 'effect'
import { TestClock } from 'effect/testing'
import { withLatencyCliPhase } from './latency-cli-progress.test-support'

test('phase diagnostics preserve values and failures without including their payloads', async () => {
  const records: Readonly<Record<string, unknown>>[] = []
  const logger = Logger.make(({ fiber }) => records.push(fiber.getRef(References.CurrentLogAnnotations)))
  const failure = { privatePayload: 'never-log-this' }
  await Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* TestClock.adjust(25).pipe(Effect.as(42), withLatencyCliPhase('economics'))).toBe(42)
      const exit = yield* TestClock.adjust(7).pipe(
        Effect.andThen(Effect.fail(failure)),
        withLatencyCliPhase('cost-binding'),
        Effect.exit,
      )
      expect(exit).toEqual(Exit.fail(failure))
    }).pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([logger]))),
  )
  expect(records).toEqual([
    { phase: 'economics', status: 'started', elapsedMs: 0 },
    { phase: 'economics', status: 'completed', elapsedMs: 25 },
    { phase: 'cost-binding', status: 'started', elapsedMs: 0 },
    { phase: 'cost-binding', status: 'failed', elapsedMs: 7 },
  ])
})

test('a pending phase is visible before timeout and interruption remains observable', async () => {
  const records: Readonly<Record<string, unknown>>[] = []
  const logger = Logger.make(({ fiber }) => records.push(fiber.getRef(References.CurrentLogAnnotations)))
  await Effect.runPromise(
    Effect.gen(function* () {
      const child = yield* Effect.never.pipe(
        withLatencyCliPhase('replay-child'),
        Effect.timeout(100),
        Effect.forkChild({ startImmediately: true }),
      )
      expect(records).toEqual([{ phase: 'replay-child', status: 'started', elapsedMs: 0 }])
      yield* TestClock.adjust(100)
      expect(Exit.isFailure(yield* Fiber.await(child))).toBe(true)
    }).pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([logger]))),
  )
  expect(records).toEqual([
    { phase: 'replay-child', status: 'started', elapsedMs: 0 },
    { phase: 'replay-child', status: 'interrupted', elapsedMs: 100 },
  ])
})
