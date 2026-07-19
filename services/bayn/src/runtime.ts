import { Effect, Layer } from 'effect'

import { BaynConfig, BaynConfigLive } from './config'
import { DependencyRegistry, DependencyRegistryLive } from './dependencies'
import { Lifecycle, LifecycleLive } from './lifecycle'
import { startHttpServer } from './server'

export const BaynDependenciesLive = Layer.mergeAll(BaynConfigLive, DependencyRegistryLive, LifecycleLive)

export const runBayn = Effect.gen(function* () {
  const config = yield* BaynConfig
  const dependencies = yield* DependencyRegistry
  const lifecycle = yield* Lifecycle

  yield* startHttpServer(config, lifecycle, dependencies)
  yield* Effect.never
})

export const BaynMain = runBayn.pipe(Effect.scoped, Effect.provide(BaynDependenciesLive))
