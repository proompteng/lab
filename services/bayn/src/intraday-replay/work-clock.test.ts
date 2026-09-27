import { expect, test } from 'bun:test'
import { Clock, Deferred, Duration, Effect, Exit, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { OperationDeadlineClock, operationTimeoutOrElse } from '../operation-timeout'
import { makeReplayWorkClock } from './work-clock'

test('an operation timeout excludes source work and retains subsequent provider time', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* TestClock.make()
      yield* provider.setTime(0)
      const work = yield* makeReplayWorkClock(provider)
      const entered = yield* Deferred.make<void>()
      const released = yield* Deferred.make<void>()
      const operation = work
        .excludeSourceTime(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(released))))
        .pipe(Effect.andThen(Effect.never))
      const worker = yield* operation.pipe(
        operationTimeoutOrElse({ duration: 100, orElse: () => Effect.succeed('timed out') }),
        Effect.provideService(OperationDeadlineClock, work.clock),
        Effect.forkChild,
      )
      yield* Deferred.await(entered)
      yield* provider.adjust(5000)
      expect(yield* work.clock.currentTimeMillis).toBe(0)
      expect(yield* work.clock.currentTimeNanos).toBe(0n)
      expect(worker.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(released, undefined)
      yield* Effect.yieldNow
      yield* provider.adjust(99)
      expect(worker.pollUnsafe()).toBeUndefined()
      yield* provider.adjust(1)
      expect(yield* Fiber.join(worker)).toBe('timed out')
      expect(yield* work.excludedSourceMillis).toBe(5000)
    }).pipe(Effect.scoped),
  )
})

test('a running deadline cancels its old timer when parsing begins and resumes the remainder', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* TestClock.make()
      yield* provider.setTime(0)
      const work = yield* makeReplayWorkClock(provider)
      const sleeper = yield* work.clock.sleep(Duration.millis(100)).pipe(Effect.forkChild)
      yield* provider.adjust(20)
      const entered = yield* Deferred.make<void>()
      const released = yield* Deferred.make<void>()
      const source = yield* work
        .excludeSourceTime(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(released))))
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* provider.adjust(5000)
      expect(sleeper.pollUnsafe()).toBeUndefined()
      expect(yield* work.clock.currentTimeMillis).toBe(20)
      yield* Deferred.succeed(released, undefined)
      yield* Fiber.join(source)
      yield* provider.adjust(79)
      expect(sleeper.pollUnsafe()).toBeUndefined()
      yield* provider.adjust(1)
      yield* Fiber.join(sleeper)
      expect(yield* work.clock.currentTimeMillis).toBe(100)
    }).pipe(Effect.scoped),
  )
})

test.each(['failure', 'defect', 'interruption'] as const)(
  'source %s resumes the operation clock exactly once',
  async (outcome) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* TestClock.make()
        yield* provider.setTime(0)
        const work = yield* makeReplayWorkClock(provider)
        const entered = yield* Deferred.make<void>()
        const released = yield* Deferred.make<void>()
        const worker = yield* work
          .excludeSourceTime(
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(released)
              if (outcome === 'failure') return yield* Effect.fail('source failed')
              return yield* Effect.die('source defect')
            }),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* provider.adjust(5000)
        if (outcome === 'interruption') yield* Fiber.interrupt(worker)
        else {
          yield* Deferred.succeed(released, undefined)
          expect(Exit.isFailure(yield* Fiber.await(worker))).toBe(true)
        }
        yield* provider.adjust(50)
        expect(yield* work.clock.currentTimeMillis).toBe(50)
        expect(yield* work.clock.currentTimeNanos).toBe(50_000_000n)
        expect(yield* work.excludedSourceMillis).toBe(5000)
        yield* work.excludeSourceTime(Effect.void)
        expect(yield* work.excludedSourceMillis).toBe(5000)
      }).pipe(Effect.scoped),
    )
  },
)

test('source exclusion does not alter the provider request timeout', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* TestClock.make()
      yield* provider.setTime(0)
      const work = yield* makeReplayWorkClock(provider)
      const sleeper = yield* provider.sleep(Duration.millis(100)).pipe(Effect.forkChild)
      yield* work.excludeSourceTime(provider.adjust(100))
      yield* Fiber.join(sleeper)
      expect(yield* Clock.currentTimeMillis.pipe(Effect.provideService(Clock.Clock, work.clock))).toBe(0)
      expect(yield* provider.currentTimeMillis).toBe(100)
    }).pipe(Effect.scoped),
  )
})
