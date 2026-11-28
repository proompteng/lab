import { Effect, Layer } from 'effect'
import { TestClock } from 'effect/testing'

export const provideTestLayer = <A, E, R, ROut, E2, RIn>(
  effect: Effect.Effect<A, E, R>,
  layer: Layer.Layer<ROut, E2, RIn>,
): Effect.Effect<A, E | E2, RIn | Exclude<R, ROut>> =>
  Effect.scoped(Layer.build(layer).pipe(Effect.flatMap((services) => effect.pipe(Effect.provide(services)))))

export const atTestTime = <A, E, R>(now: number, exercise: () => Effect.Effect<A, E, R>) =>
  TestClock.setTime(now).pipe(Effect.andThen(Effect.suspend(exercise)))
