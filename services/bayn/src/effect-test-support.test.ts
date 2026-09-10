import { describe, expect, test } from 'bun:test'

import { Deferred, Effect, Exit, Fiber, Layer, Ref } from 'effect'

import { provideTestLayer } from './effect-test-support'

describe('provideTestLayer', () => {
  test('preserves an acquisition failure without running the provided effect', async () => {
    let effectRuns = 0
    const acquisitionFailure = new Error('test layer acquisition failed')
    const layer = Layer.effectDiscard(Effect.fail(acquisitionFailure))

    const failure = await Effect.runPromise(
      Effect.sync(() => {
        effectRuns += 1
      }).pipe(provideTestLayer(layer), Effect.flip),
    )

    expect(failure).toBe(acquisitionFailure)
    expect(effectRuns).toBe(0)
  })

  test('finalizes an acquired layer once when the provided effect fails', async () => {
    let finalizations = 0
    const effectFailure = new Error('provided effect failed')
    const layer = Layer.effectDiscard(
      Effect.acquireRelease(Effect.void, () =>
        Effect.sync(() => {
          finalizations += 1
        }),
      ),
    )

    const failure = await Effect.runPromise(Effect.fail(effectFailure).pipe(provideTestLayer(layer), Effect.flip))

    expect(failure).toBe(effectFailure)
    expect(finalizations).toBe(1)
  })

  test('finalizes an acquired layer once when the provided effect is interrupted', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const acquired = yield* Deferred.make<void>()
          const finalizations = yield* Ref.make(0)
          const layer = Layer.effectDiscard(
            Effect.acquireRelease(Deferred.succeed(acquired, undefined), () =>
              Ref.update(finalizations, (count) => count + 1),
            ),
          )
          const fiber = yield* Effect.never.pipe(provideTestLayer(layer), Effect.forkChild({ startImmediately: true }))

          yield* Deferred.await(acquired)
          yield* Fiber.interrupt(fiber)

          expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
          expect(yield* Ref.get(finalizations)).toBe(1)
        }),
      ),
    ))
})
