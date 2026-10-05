import { expect, test } from 'bun:test'
import { Deferred, Effect, Exit, Fiber } from 'effect'
import { TestClock } from 'effect/testing'

import { provideTestLayer } from '../effect-test-support'
import { makeCapacitySqlProbes } from './capture-capacity-sql-probes'

test('only successful probes begun after invalidation prove SQL recovery', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let invalidated = false
      const probes = makeCapacitySqlProbes(() => invalidated)
      expect(yield* probes.run(Effect.succeed([{ value: 1 }]))).toEqual([{ value: 1 }])
      expect(probes.progress).toEqual({ completed: 1, completedAfterInvalidation: 0 })
      const began = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<readonly { value: number }[]>()
      const pending = yield* probes
        .run(Deferred.succeed(began, undefined).pipe(Effect.andThen(Deferred.await(finish))))
        .pipe(Effect.forkChild)
      yield* Deferred.await(began)
      invalidated = true
      yield* Deferred.succeed(finish, [{ value: 1 }])
      expect(yield* Fiber.join(pending)).toEqual([{ value: 1 }])
      expect(probes.progress).toEqual({ completed: 2, completedAfterInvalidation: 0 })
      expect(yield* probes.run(Effect.succeed([{ value: 1 }]))).toEqual([{ value: 1 }])
      expect(probes.progress).toEqual({ completed: 3, completedAfterInvalidation: 1 })
    }),
  )
})

test('samples invalidation when a lazy query begins and excludes failed or interrupted queries', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let invalidated = false
      const probes = makeCapacitySqlProbes(() => invalidated)
      const delayed = probes.run(Effect.succeed([{ value: 1 }]))
      invalidated = true
      expect(yield* delayed).toEqual([{ value: 1 }])
      const failed = yield* Effect.exit(probes.run(Effect.fail('pool unavailable')))
      expect(Exit.isFailure(failed)).toBe(true)
      const began = yield* Deferred.make<void>()
      const pending = yield* probes
        .run(Deferred.succeed(began, undefined).pipe(Effect.andThen(Effect.never)))
        .pipe(Effect.forkChild)
      yield* Deferred.await(began)
      yield* Fiber.interrupt(pending)
      expect(probes.progress).toEqual({ completed: 1, completedAfterInvalidation: 1 })
    }),
  )
})

test('times out and cancels a stalled post-invalidation probe at the existing one-second bound', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const probes = makeCapacitySqlProbes(() => true)
      const began = yield* Deferred.make<void>()
      let cancelled = 0
      const pending = yield* probes
        .run(
          Deferred.succeed(began, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(() => cancelled++)),
          ),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(began)
      yield* TestClock.adjust(1000)
      expect(Exit.isFailure(yield* Fiber.await(pending))).toBe(true)
      expect(cancelled).toBe(1)
      expect(probes.progress).toEqual({ completed: 0, completedAfterInvalidation: 0 })
      expect(yield* probes.run(Effect.succeed([{ value: 1 }]))).toEqual([{ value: 1 }])
      expect(probes.progress).toEqual({ completed: 1, completedAfterInvalidation: 1 })
    }).pipe(provideTestLayer(TestClock.layer())),
  )
})
