import { describe, expect, test } from 'bun:test'
import { Context, Effect, Exit, Fiber, Layer, Result } from 'effect'
import { RedisError } from 'effect/persistence/Redis'
import { TestClock } from 'effect/testing'

import { withValkeyStartupRetry } from './valkey-startup'

class Connection extends Context.Service<Connection, { readonly command: Effect.Effect<void, RedisError> }>()(
  'test/ValkeyStartupConnection',
) {}
const refused = new RedisError({ cause: Object.assign(new Error('fixture refused'), { code: 'ECONNREFUSED' }) })

describe('Valkey startup connection refusal', () => {
  test.each([false, true])(
    'startup refusal has two spaced retries with closed attempts; persistent=%s',
    async (persistent) => {
      let attempts = 0
      let active = 0
      let released = 0
      const layer = Layer.effect(
        Connection,
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              active++
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
          return { command: Effect.void }
        }),
      ).pipe(withValkeyStartupRetry)
      const result = await Effect.gen(function* () {
        const fiber = yield* Connection.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              expect(active).toBe(1)
            }),
          ),
          Effect.provide(layer),
          Effect.result,
          Effect.forkChild({ startImmediately: true }),
        )
        yield* TestClock.adjust('999 millis')
        expect(attempts).toBe(1)
        expect(active).toBe(0)
        yield* TestClock.adjust('1 millis')
        expect(attempts).toBe(2)
        expect(active).toBe(0)
        yield* TestClock.adjust('999 millis')
        expect(attempts).toBe(2)
        yield* TestClock.adjust('1 millis')
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise)
      expect(attempts).toBe(3)
      expect(active).toBe(0)
      expect(released).toBe(3)
      expect(Result.isFailure(result)).toBe(persistent)
      if (Result.isFailure(result)) expect(result.failure).toBe(refused)
    },
  )

  test('authentication, TLS, timeouts, other transport errors and untrusted causes are not retried', async () => {
    let codeReads = 0
    const accessor = Object.defineProperty(new Error('fixture accessor'), 'code', {
      get: () => {
        codeReads++
        return 'ECONNREFUSED'
      },
    })
    for (const cause of [
      ...['WRONGPASS', 'CERT_HAS_EXPIRED', 'ETIMEDOUT', 'ECONNRESET'].map((code) =>
        Object.assign(new Error('fixture'), { code }),
      ),
      { code: 'ECONNREFUSED' },
      accessor,
    ]) {
      let attempts = 0
      const failure = new RedisError({ cause })
      const layer = Layer.effect(
        Connection,
        Effect.suspend(() => {
          attempts++
          return Effect.fail(failure)
        }),
      ).pipe(withValkeyStartupRetry)
      const result = await Connection.pipe(Effect.provide(layer), Effect.result, Effect.runPromise)
      expect(attempts).toBe(1)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toBe(failure)
    }
    expect(codeReads).toBe(0)
  })

  test('a refused command after exposure cannot reacquire the service or replay the command', async () => {
    let attempts = 0
    let commands = 0
    const layer = Layer.effect(
      Connection,
      Effect.sync(() => {
        attempts++
        return {
          command: Effect.suspend(() => {
            commands++
            return Effect.fail(refused)
          }),
        }
      }),
    ).pipe(withValkeyStartupRetry)
    const result = await Effect.flatMap(Connection, (connection) => connection.command).pipe(
      Effect.provide(layer),
      Effect.result,
      Effect.runPromise,
    )
    expect(result).toEqual(Result.fail(refused))
    expect(attempts).toBe(1)
    expect(commands).toBe(1)
  })

  test.each(['acquisition', 'backoff'] as const)(
    'interruption during %s releases resources and stops retries',
    async (phase) => {
      let attempts = 0
      let active = 0
      let released = 0
      const layer = Layer.effect(
        Connection,
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              active++
            }),
            () =>
              Effect.sync(() => {
                active--
                released++
              }),
          )
          attempts++
          return yield* phase === 'acquisition' ? Effect.never : refused
        }),
      ).pipe(withValkeyStartupRetry)
      await Effect.gen(function* () {
        const fiber = yield* Connection.pipe(Effect.provide(layer), Effect.forkChild({ startImmediately: true }))
        yield* TestClock.adjust('500 millis')
        expect(active).toBe(phase === 'acquisition' ? 1 : 0)
        yield* Fiber.interrupt(fiber)
        yield* TestClock.adjust('5 seconds')
      }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise)
      expect(attempts).toBe(1)
      expect(active).toBe(0)
      expect(released).toBe(1)
    },
  )

  test('defects release the failed acquisition without retrying', async () => {
    let attempts = 0
    let released = 0
    const layer = Layer.effect(
      Connection,
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            released++
          }),
        )
        attempts++
        return yield* Effect.die('fixture defect')
      }),
    ).pipe(withValkeyStartupRetry)
    const exit = await Connection.pipe(Effect.provide(layer), Effect.exit, Effect.runPromise)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(attempts).toBe(1)
    expect(released).toBe(1)
  })
})
