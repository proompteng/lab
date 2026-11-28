import { describe, expect, test } from 'bun:test'

import { Cause, Effect, Exit, Layer, Option, Result, Scope } from 'effect'

import { mapLayerAcquisitionError, scopedAcquisition } from './resource-boundary'

describe('scoped resource boundaries', () => {
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
