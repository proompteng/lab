import { expect, test } from 'bun:test'
import { Effect, Fiber, Result } from 'effect'
import { AuthenticationError, ConnectionError, SqlError } from 'effect/sql/SqlError'
import { TestClock } from 'effect/testing'

import { connectPostgresWithStartupRetry } from './postgres-client'

const refused = new SqlError({
  reason: new ConnectionError({ cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }),
})

test.each([false, true])(
  'startup refusal releases failed acquisitions before retry; persistent=%s',
  async (persistent) => {
    let attempts = 0,
      active = 0,
      released = 0
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const open = Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              active++
              return undefined
            }),
            () =>
              Effect.sync(() => {
                active--
                released++
              }),
          )
          attempts++
          expect(active).toBe(1)
          if (persistent || attempts < 3) return yield* refused
          return 'connected'
        })
        const fiber = yield* open.pipe(
          connectPostgresWithStartupRetry,
          Effect.result,
          Effect.scoped,
          Effect.forkChild({ startImmediately: true }),
        )
        yield* TestClock.adjust('1 second')
        yield* TestClock.adjust('1 second')
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(attempts).toBe(3)
    expect(active).toBe(0)
    expect(released).toBe(3)
    if (persistent) {
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toBe(refused)
    } else expect(result).toEqual(Result.succeed('connected'))
  },
)

test('authentication and other connection failures are not retried', async () => {
  for (const reason of [
    new AuthenticationError({ cause: Object.assign(new Error('denied'), { code: 'ECONNREFUSED' }) }),
    new ConnectionError({ cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }),
  ]) {
    let attempts = 0
    const error = new SqlError({ reason })
    const result = await Effect.runPromise(
      Effect.suspend(() => {
        attempts++
        return Effect.fail(error)
      }).pipe(connectPostgresWithStartupRetry, Effect.result, Effect.scoped),
    )
    expect(attempts).toBe(1)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure).toBe(error)
  }
})

test('interruption during startup backoff closes the failed acquisition and prevents later attempts', async () => {
  let attempts = 0,
    active = 0
  await Effect.runPromise(
    Effect.gen(function* () {
      const open = Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            active++
            return undefined
          }),
          () =>
            Effect.sync(() => {
              active--
            }),
        )
        attempts++
        return yield* refused
      })
      const fiber = yield* open.pipe(
        connectPostgresWithStartupRetry,
        Effect.scoped,
        Effect.forkChild({ startImmediately: true }),
      )
      yield* TestClock.adjust('500 millis')
      yield* Fiber.interrupt(fiber)
      yield* TestClock.adjust('5 seconds')
    }).pipe(Effect.provide(TestClock.layer())),
  )
  expect(attempts).toBe(1)
  expect(active).toBe(0)
})
