import { Context, Effect, Layer, Ref } from 'effect'

export type LifecyclePhase = 'starting' | 'ready' | 'stopping'

export interface LifecycleService {
  readonly phase: Effect.Effect<LifecyclePhase>
  readonly markReady: Effect.Effect<void>
  readonly markStopping: Effect.Effect<void>
}

export class Lifecycle extends Context.Tag('@bayn/Lifecycle')<Lifecycle, LifecycleService>() {}

export const makeLifecycle: Effect.Effect<LifecycleService> = Ref.make<LifecyclePhase>('starting').pipe(
  Effect.map((phase) => ({
    phase: Ref.get(phase),
    markReady: Ref.set(phase, 'ready'),
    markStopping: Ref.set(phase, 'stopping'),
  })),
)

export const LifecycleLive = Layer.effect(Lifecycle, makeLifecycle)
