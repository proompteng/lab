import { describe, expect, test } from 'bun:test'

import { Deferred, Effect, Exit, Fiber } from 'effect'

import { WriterFence, type WriterFenceService, withWriterFence } from './writer-fence'

const service = (transaction: WriterFenceService['transaction']): WriterFenceService => ({
  backendPid: 42,
  check: Effect.void,
  transaction,
})

describe('WriterFence interpreter boundary', () => {
  test('requires and delegates through one explicit fence service', async () => {
    let transactions = 0
    const fence = service((effect) =>
      Effect.sync(() => {
        transactions += 1
      }).pipe(Effect.andThen(effect)),
    )

    const value = await Effect.runPromise(
      withWriterFence(Effect.succeed('committed')).pipe(Effect.provideService(WriterFence, fence)),
    )

    expect(value).toBe('committed')
    expect(transactions).toBe(1)
  })

  test('preserves interruption at the explicit transaction boundary', async () => {
    const started = await Effect.runPromise(Deferred.make<void>())
    let transactions = 0
    const fence = service((effect) =>
      Effect.sync(() => {
        transactions += 1
      }).pipe(Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(effect)),
    )

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* withWriterFence(Effect.never).pipe(
          Effect.provideService(WriterFence, fence),
          Effect.forkChild({ startImmediately: true }),
        )
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(transactions).toBe(1)
  })
})
