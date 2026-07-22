import { describe, expect, test } from 'bun:test'

import { Effect, Exit, Fiber, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import {
  AuthenticationError,
  AuthorizationError,
  ConnectionError,
  SqlError,
  UnknownError,
} from 'effect/unstable/sql/SqlError'

import { DatabaseError } from './db/evidence-store'
import { acquireSqlLayer, databaseOperation } from './operations'

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

  test('retries retryable SQL failures wrapped by the database layer', async () => {
    let attempts = 0
    const connection = new SqlError({
      reason: new ConnectionError({ cause: new Error('connection refused'), operation: 'connect' }),
    })
    const unavailable = new DatabaseError({
      failure: 'unavailable',
      operation: 'connect',
      message: 'PostgreSQL operation failed',
      cause: connection,
    })
    const dependencies = Layer.effectDiscard(
      Effect.suspend(() => {
        attempts += 1
        return attempts === 1 ? Effect.fail(unavailable) : Effect.void
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
  })

  test('retries a PostgreSQL connection refusal reported as an unknown SQL error', async () => {
    let attempts = 0
    const connectionRefused = new DatabaseError({
      failure: 'unavailable',
      operation: 'connect',
      message: 'PostgreSQL operation failed',
      cause: new SqlError({
        reason: new UnknownError({
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
          operation: 'connect',
        }),
      }),
    })
    const dependencies = Layer.effectDiscard(
      Effect.suspend(() => {
        attempts += 1
        return attempts === 1 ? Effect.fail(connectionRefused) : Effect.void
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
  })

  test('keeps unverified and non-PostgreSQL unknown connect errors terminal', async () => {
    const countAttempts = (failure: unknown) => {
      let attempts = 0
      return Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* acquireSqlLayer(
            Layer.effectDiscard(
              Effect.sync(() => {
                attempts += 1
              }).pipe(Effect.andThen(Effect.fail(failure))),
            ),
          ).pipe(Effect.forkScoped({ startImmediately: true }))
          yield* Effect.yieldNow
          yield* TestClock.adjust('3 seconds')
          const exit = yield* Fiber.await(fiber)
          return { attempts, exit }
        }),
      ).pipe(Effect.provide(TestClock.layer()))
    }
    const rawRefusal = new SqlError({
      reason: new UnknownError({
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        operation: 'connect',
      }),
    })
    const invalidTls = new DatabaseError({
      failure: 'unavailable',
      operation: 'connect',
      message: 'PostgreSQL operation failed',
      cause: new SqlError({
        reason: new UnknownError({
          cause: Object.assign(new Error('invalid certificate'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
          operation: 'connect',
        }),
      }),
    })

    const [raw, tls] = await Promise.all([
      Effect.runPromise(countAttempts(rawRefusal)),
      Effect.runPromise(countAttempts(invalidTls)),
    ])

    expect(Exit.isFailure(raw.exit)).toBe(true)
    expect(raw.attempts).toBe(1)
    expect(Exit.isFailure(tls.exit)).toBe(true)
    expect(tls.attempts).toBe(1)
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

describe('Bayn database operation failures', () => {
  test('keeps authentication and authorization terminal while retrying transient availability failures', async () => {
    const classify = (cause: SqlError) =>
      Effect.runPromise(
        Effect.flip(
          databaseOperation(
            Effect.fail(
              new DatabaseError({
                failure: 'unavailable',
                operation: 'recover-evaluation',
                message: cause.message,
                cause,
              }),
            ),
            'recover-evaluation',
          ),
        ),
      )

    const [authentication, authorization, connection] = await Promise.all([
      classify(
        new SqlError({
          reason: new AuthenticationError({ cause: new Error('invalid credentials'), operation: 'connect' }),
        }),
      ),
      classify(
        new SqlError({
          reason: new AuthorizationError({ cause: new Error('permission denied'), operation: 'query' }),
        }),
      ),
      classify(
        new SqlError({
          reason: new ConnectionError({ cause: new Error('connection reset'), operation: 'query' }),
        }),
      ),
    ])

    expect(authentication.retryable).toBe(false)
    expect(authorization.retryable).toBe(false)
    expect(connection.retryable).toBe(true)
  })
})
