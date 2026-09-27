import { NodeHttpClient, Undici } from '@effect/platform-node'
import { Effect, Layer, Redacted } from 'effect'

import { JevFailure } from '../jev/contract'
import { RuneError } from './client'

interface DispatcherDependencies {
  readonly create: () => Undici.Dispatcher
  readonly destroy: (dispatcher: Undici.Dispatcher) => Promise<void>
}

export const RuneHttpClientLive = (
  dependencies: DispatcherDependencies = {
    create: () => new Undici.Agent(),
    destroy: (dispatcher) => dispatcher.destroy(),
  },
) =>
  NodeHttpClient.layerUndiciNoDispatcher.pipe(
    Layer.provide(
      Layer.effect(
        NodeHttpClient.Dispatcher,
        Effect.acquireRelease(
          Effect.try({
            try: dependencies.create,
            catch: (cause) =>
              new RuneError({
                failure: JevFailure.Transport,
                message: 'Rune dispatcher acquisition failed',
                cause: Redacted.make(cause),
              }),
          }),
          (dispatcher) => Effect.promise(() => dependencies.destroy(dispatcher)),
        ),
      ),
    ),
  )
