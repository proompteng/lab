import { describe, expect, test } from 'bun:test'

import { Effect, Exit, Fiber, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import { AuthenticationError, ConnectionError, SqlError } from 'effect/unstable/sql/SqlError'

import { acquireSqlLayer } from './operations'

describe('Bayn SQL dependency acquisition', () => {
  test('retries only retryable SQL failures', async () => {
    let attempts = 0
    const retryable = new SqlError({
      reason: new ConnectionError({ cause: new Error('transient timeout'), operation: 'connect' }),
    })
    const dependencies = Layer.effectDiscard(
      Effect.suspend(() => {
        attempts += 1
        return attempts === 1 ? Effect.fail(retryable) : Effect.void
      }),
    )
    const program = Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* acquireSqlLayer(dependencies).pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Effect.yieldNow
        expect(attempts).toBe(1)
        yield* TestClock.adjust('1 second')
        yield* Fiber.join(fiber)
        expect(attempts).toBe(2)
      }),
    ).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)

    attempts = 0
    const nonRetryable = new SqlError({
      reason: new AuthenticationError({ cause: new Error('invalid credentials'), operation: 'connect' }),
    })
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        acquireSqlLayer(
          Layer.effectDiscard(
            Effect.sync(() => {
              attempts += 1
            }).pipe(Effect.andThen(Effect.fail(nonRetryable))),
          ),
        ),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(attempts).toBe(1)
  })

  test('interrupts a pending retry', async () => {
    let attempts = 0
    const retryable = new SqlError({
      reason: new ConnectionError({ cause: new Error('transient timeout'), operation: 'connect' }),
    })
    const program = Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* acquireSqlLayer(
          Layer.effectDiscard(
            Effect.sync(() => {
              attempts += 1
            }).pipe(Effect.andThen(Effect.fail(retryable))),
          ),
        ).pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Effect.yieldNow
        expect(attempts).toBe(1)
        yield* Fiber.interrupt(fiber)
        yield* TestClock.adjust('2 seconds')
        expect(attempts).toBe(1)
      }),
    ).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
  })

  test('releases an acquired layer exactly once', async () => {
    let releases = 0

    await Effect.runPromise(
      Effect.scoped(
        acquireSqlLayer(
          Layer.effectDiscard(
            Effect.acquireRelease(Effect.void, () =>
              Effect.sync(() => {
                releases += 1
              }),
            ),
          ),
        ),
      ),
    )

    expect(releases).toBe(1)
  })
})
