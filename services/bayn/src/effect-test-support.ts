import { Effect, Layer } from 'effect'
import { Pipeable } from './pipeable'

const provideTestLayerDataFirst = <A, E, R, ROut, E2, RIn>(
  effect: Effect.Effect<A, E, R>,
  layer: Layer.Layer<ROut, E2, RIn>,
): Effect.Effect<A, E | E2, RIn | Exclude<R, ROut>> =>
  Effect.scoped(Layer.build(layer).pipe(Effect.flatMap((services) => effect.pipe(Effect.provide(services)))))

export const provideTestLayer = Pipeable.generic<
  <ROut, E2, RIn>(
    layer: Layer.Layer<ROut, E2, RIn>,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | E2, RIn | Exclude<R, ROut>>,
  typeof provideTestLayerDataFirst
>(2, provideTestLayerDataFirst)
