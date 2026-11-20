import { describe, expect, test } from 'bun:test'
import { Cause, Deferred, Effect, Exit, Fiber, Queue, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { provideTestLayer } from './effect-test-support'
import { InferenceCostError } from './inference-costs'
import { inferenceExpenseLoop } from './inference-expense-runtime'

const idle = { pending: false, nextWakeAt: null }

describe('committed inference expense wakeups', () => {
  test('drains once at startup and does no idle work discovery across two days', async () => {
    let starts = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const changed = yield* Queue.dropping<void>(1)
          const entered = yield* Deferred.make<void>()
          const pass = Effect.sync(() => {
            starts++
            if (starts === 2) Deferred.doneUnsafe(entered, Exit.void)
            return idle
          })
          const fiber = yield* inferenceExpenseLoop(changed, pass).pipe(Effect.forkScoped)
          yield* TestClock.adjust('2 days')
          expect(starts).toBe(1)
          yield* Queue.offer(changed, undefined)
          yield* Deferred.await(entered)
          expect(starts).toBe(2)
          yield* Fiber.interrupt(fiber)
        }),
      ).pipe((self) => provideTestLayer(self, TestClock.layer())),
    )
  })

  test('an unrelated commit does not renew the original microsecond expiry', async () => {
    let starts = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const changed = yield* Queue.dropping<void>(1)
          const entered = yield* Deferred.make<void>()
          const fiber = yield* inferenceExpenseLoop(
            changed,
            Effect.sync(() => {
              starts++
              if (starts === 3) Deferred.doneUnsafe(entered, Exit.void)
              return starts < 3 ? { pending: false, nextWakeAt: '1970-01-01T00:00:01.000123Z' } : idle
            }),
          ).pipe(Effect.forkScoped)
          yield* TestClock.adjust(250)
          yield* Queue.offer(changed, undefined)
          yield* TestClock.adjust(750)
          expect(starts).toBe(2)
          yield* TestClock.adjust(1)
          yield* Deferred.await(entered)
          expect(starts).toBe(3)
          yield* TestClock.adjust('2 days')
          expect(starts).toBe(3)
          yield* Fiber.interrupt(fiber)
        }),
      ).pipe((self) => provideTestLayer(self, TestClock.layer())),
    )
  })

  test('drains known paginated backlog immediately then waits for a commit', async () => {
    let starts = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const changed = yield* Queue.dropping<void>(1)
          const drained = yield* Deferred.make<void>()
          const fiber = yield* inferenceExpenseLoop(
            changed,
            Effect.sync(() => {
              if (++starts === 4) Deferred.doneUnsafe(drained, Exit.void)
              return { pending: starts < 4, nextWakeAt: null }
            }),
          ).pipe(Effect.forkScoped)
          yield* Deferred.await(drained)
          yield* TestClock.adjust('1 day')
          expect(starts).toBe(4)
          yield* Fiber.interrupt(fiber)
        }),
      ).pipe((self) => provideTestLayer(self, TestClock.layer())),
    )
  })

  test('retains a busy-owner obligation until takeover and then stops lock polling', async () => {
    let starts = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const changed = yield* Queue.dropping<void>(1)
          const fiber = yield* inferenceExpenseLoop(
            changed,
            Effect.sync(() => (++starts < 3 ? undefined : idle)),
          ).pipe(Effect.forkScoped)
          yield* TestClock.adjust(999)
          expect(starts).toBe(1)
          yield* TestClock.adjust(1001)
          expect(starts).toBe(3)
          yield* TestClock.adjust('2 days')
          expect(starts).toBe(3)
          yield* Fiber.interrupt(fiber)
        }),
      ).pipe((self) => provideTestLayer(self, TestClock.layer())),
    )
  })

  test('coalesces a burst during slow posting without losing the committed frontier', async () => {
    let starts = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const changed = yield* Queue.dropping<void>(1)
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const drained = yield* Deferred.make<void>()
          const fiber = yield* inferenceExpenseLoop(
            changed,
            Effect.gen(function* () {
              if (++starts === 1) {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
              } else yield* Deferred.succeed(drained, undefined)
              return idle
            }),
          ).pipe(Effect.forkScoped)
          yield* Deferred.await(entered)
          for (let i = 0; i < 10_000; i++) Queue.offerUnsafe(changed, undefined)
          expect(yield* Queue.size(changed)).toBe(1)
          yield* Deferred.succeed(release, undefined)
          yield* Deferred.await(drained)
          yield* TestClock.adjust('1 day')
          expect(starts).toBe(2)
          yield* Fiber.interrupt(fiber)
        }),
      ).pipe((self) => provideTestLayer(self, TestClock.layer())),
    )
  })

  test('retries only a known typed failure and finalizes a canceled pass once', async () => {
    let starts = 0
    let releases = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const changed = yield* Queue.dropping<void>(1)
          const entered = yield* Deferred.make<void>()
          const pass = Effect.gen(function* () {
            if (++starts === 1) return yield* new InferenceCostError({ message: 'synthetic unavailable' })
            yield* Deferred.succeed(entered, undefined)
            return yield* Effect.never.pipe(Effect.ensuring(Effect.sync(() => releases++)))
          })
          const fiber = yield* inferenceExpenseLoop(changed, pass).pipe(Effect.forkScoped)
          yield* TestClock.adjust(999)
          yield* Queue.offer(changed, undefined)
          expect(starts).toBe(1)
          yield* TestClock.adjust(1)
          yield* Deferred.await(entered)
          yield* Fiber.interrupt(fiber)
        }),
      ).pipe((self) => provideTestLayer(self, TestClock.layer())),
    )
    expect(starts).toBe(2)
    expect(releases).toBe(1)
  })

  test('propagates defects without retrying or inventing successful accounting', async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const changed = yield* Queue.dropping<void>(1)
        return yield* inferenceExpenseLoop(changed, Effect.die('synthetic accounting defect'))
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit))
      expect(Result.getOrThrow(Cause.findDie(exit.cause)).defect).toBe('synthetic accounting defect')
  })
})
