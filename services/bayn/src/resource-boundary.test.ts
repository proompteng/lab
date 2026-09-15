import { describe, expect, test } from 'bun:test'

import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Result, Scope } from 'effect'

import { mapLayerAcquisitionError, retryLayerAcquisition, scopedAcquisition } from './resource-boundary'

describe('scoped resource boundaries', () => {
  test('retries fresh acquisitions and finalizes every failed and successful attempt exactly once', async () => {
    let attempts = 0
    let finalizations = 0
    const retryable = new Error('transient acquisition failure')
    const dependency = Layer.effectDiscard(
      Effect.suspend(() => {
        attempts += 1
        const attempt = attempts
        if (attempt > 1) {
          expect(finalizations).toBe(attempt - 1)
        }
        return Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            finalizations += 1
          }),
        ).pipe(Effect.andThen(attempt < 3 ? Effect.fail(retryable) : Effect.void))
      }),
    )
    const resource = retryLayerAcquisition(dependency, (acquisition) =>
      acquisition.pipe(Effect.retry({ times: 2, while: (cause) => cause === retryable })),
    )

    await Effect.runPromise(Effect.scoped(Layer.build(resource)))

    expect(attempts).toBe(3)
    expect(finalizations).toBe(3)
  })

  test('closes an interrupted in-flight acquisition once without starting another attempt', async () => {
    let attempts = 0
    const started = await Effect.runPromise(Deferred.make<void>())
    const finalizations = await Effect.runPromise(Ref.make(0))
    const dependency = Layer.effectDiscard(
      Effect.suspend(() => {
        attempts += 1
        return Effect.acquireRelease(Deferred.succeed(started, undefined), () =>
          Ref.update(finalizations, (count) => count + 1),
        ).pipe(Effect.andThen(Effect.never))
      }),
    )
    const resource = retryLayerAcquisition(dependency, (acquisition) => acquisition)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Layer.build(resource).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(started)
          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber)
          expect(Exit.isFailure(exit)).toBe(true)
        }),
      ),
    )

    expect(attempts).toBe(1)
    expect(await Effect.runPromise(Ref.get(finalizations))).toBe(1)
  })

  test('preserves acquisition defects and finalizes the failed attempt once', async () => {
    let finalizations = 0
    const defect = new Error('defective acquisition')
    const dependency = Layer.effectDiscard(
      Effect.acquireRelease(Effect.void, () =>
        Effect.sync(() => {
          finalizations += 1
        }),
      ).pipe(Effect.andThen(Effect.die(defect))),
    )
    const resource = retryLayerAcquisition(dependency, (acquisition) => acquisition)

    const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(resource)))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBe(defect)
    }
    expect(finalizations).toBe(1)
  })

  test('retains an acquisition failure when its finalizer defects', async () => {
    let finalizations = 0
    const acquisitionFailure = new Error('acquisition failure')
    const cleanupDefect = new Error('cleanup defect')

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const parentScope = yield* Scope.Scope
          return yield* scopedAcquisition(
            (attemptScope) =>
              Scope.provide(
                Effect.acquireRelease(Effect.void, () =>
                  Effect.sync(() => {
                    finalizations += 1
                  }).pipe(Effect.andThen(Effect.die(cleanupDefect))),
                ).pipe(Effect.andThen(Effect.fail(acquisitionFailure))),
                attemptScope,
              ),
            parentScope,
          )
        }),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(failure)).toBe(true)
      if (Option.isSome(failure)) {
        expect(failure.value).toBe(acquisitionFailure)
      }
      const defect = Cause.findDie(exit.cause)
      expect(Result.isSuccess(defect)).toBe(true)
      if (Result.isSuccess(defect)) {
        expect(defect.success.defect).toBe(cleanupDefect)
      }
    }
    expect(finalizations).toBe(1)
  })

  test('maps acquisition errors at the resource boundary and releases the failed resource once', async () => {
    let finalizations = 0
    const cause = new Error('proxy acquisition failed')
    const dependency = Layer.effectDiscard(
      Effect.acquireRelease(Effect.void, () =>
        Effect.sync(() => {
          finalizations += 1
        }),
      ).pipe(Effect.andThen(Effect.fail(cause))),
    )
    const resource = mapLayerAcquisitionError(dependency, (error) => `mapped: ${error.message}`)

    const failure = await Effect.runPromise(Effect.flip(Effect.scoped(Layer.build(resource))))

    expect(failure).toBe('mapped: proxy acquisition failed')
    expect(finalizations).toBe(1)
  })
})
