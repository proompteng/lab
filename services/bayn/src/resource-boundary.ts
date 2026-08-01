import { Cause, Context, Effect, Exit, Layer, Scope } from 'effect'

/**
 * Runs one acquisition in a child scope. Failed or interrupted attempts close immediately and retain both the
 * acquisition and cleanup causes; successful attempts leave the child scope attached to `scope` for the caller to own.
 */
export const scopedAcquisition = <A, E, R>(
  acquire: (scope: Scope.Scope) => Effect.Effect<A, E, R>,
  scope: Scope.Scope,
): Effect.Effect<A, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const attemptScope = yield* Scope.fork(scope)
      const result = yield* Effect.exit(restore(acquire(attemptScope)))

      if (Exit.isSuccess(result)) {
        return result.value
      }

      const closeExit = yield* Effect.exit(Scope.close(attemptScope, result))
      if (Exit.isFailure(closeExit)) {
        return yield* Effect.failCause(Cause.combine(result.cause, closeExit.cause))
      }
      return yield* Effect.failCause(result.cause)
    }),
  )

const acquireFreshLayer = <A, E, R>(
  layer: Layer.Layer<A, E, R>,
  scope: Scope.Scope,
): Effect.Effect<Context.Context<A>, E, R> =>
  scopedAcquisition(
    (attemptScope) => Layer.buildWithMemoMap(Layer.fresh(layer), Layer.makeMemoMapUnsafe(), attemptScope),
    scope,
  )

/**
 * Owns the scope used by a resource boundary while keeping acquisition as an ordinary Effect.
 */
const scopedLayer = <A, E, R>(
  acquire: (scope: Scope.Scope) => Effect.Effect<Context.Context<A>, E, R>,
): Layer.Layer<A, E, R> => Layer.fromBuildMemo((_, scope) => acquire(scope))

/**
 * Applies a retry policy to fresh, scoped layer acquisition. The retry callback receives an Effect rather than a
 * Layer, so retrying cannot accidentally rebuild a layer through a nested `Layer.build` conversion.
 */
export const retryLayerAcquisition = <A, E, R>(
  layer: Layer.Layer<A, E, R>,
  retry: (acquisition: Effect.Effect<Context.Context<A>, E, R>) => Effect.Effect<Context.Context<A>, E, R>,
): Layer.Layer<A, E, R> => scopedLayer((scope) => retry(Effect.suspend(() => acquireFreshLayer(layer, scope))))

/**
 * Maps errors from a scoped dependency layer at the resource boundary. The dependency is built once for the
 * boundary and its finalizers remain owned by the same scope as the layer that consumes it.
 */
export const mapLayerAcquisitionError = <A, E, E2, R>(
  layer: Layer.Layer<A, E, R>,
  mapError: (cause: E) => E2,
): Layer.Layer<A, E2, R> =>
  scopedLayer((scope) => Effect.suspend(() => acquireFreshLayer(layer, scope)).pipe(Effect.mapError(mapError)))
