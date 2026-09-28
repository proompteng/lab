import { NodeHttpClient, Undici } from '@effect/platform-node'
import { Effect, Layer, Redacted } from 'effect'

import { decodeBrokerProxyUrl } from '../broker/connection'
import { JevError } from './client'
import { JevFailure } from './contract'

interface ProxyDependencies {
  readonly create: (url: string) => Undici.Dispatcher
  readonly destroy: (dispatcher: Undici.Dispatcher) => Promise<void>
}

export const JevHttpClientLive = (
  proxyUrl: string,
  dependencies: ProxyDependencies = {
    create: (uri) => new Undici.ProxyAgent({ uri }),
    destroy: (dispatcher) => dispatcher.destroy(),
  },
) =>
  NodeHttpClient.layerUndiciNoDispatcher.pipe(
    Layer.provide(
      Layer.effect(
        NodeHttpClient.Dispatcher,
        Effect.acquireRelease(
          Effect.fromResult(decodeBrokerProxyUrl(proxyUrl)).pipe(
            Effect.mapError(
              (cause) =>
                new JevError({
                  failure: JevFailure.Request,
                  message: 'Jev proxy must be an HTTP or HTTPS origin without credentials',
                  cause: Redacted.make(cause),
                }),
            ),
            Effect.flatMap((origin) =>
              Effect.try({
                try: () => dependencies.create(origin),
                catch: (cause) =>
                  new JevError({
                    failure: JevFailure.Transport,
                    message: 'Jev proxy dispatcher acquisition failed',
                    cause: Redacted.make(cause),
                  }),
              }),
            ),
          ),
          (dispatcher) => Effect.promise(() => dependencies.destroy(dispatcher)),
        ),
      ),
    ),
  )
