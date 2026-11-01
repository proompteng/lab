import { createServer } from 'node:http'

import { NodeHttpClient, NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node'
import { Config, Context, Effect, Layer, Logger, Redacted } from 'effect'

import { JevHttpClientLive } from './jev/http'
import { HttpClient } from 'effect/http'
import { GitSourceRevisionSchema } from './schemas'
import { serveOpenCode } from './opencode/server'
import { ResearchError } from './research-inference/contract'

export const openCodeServerProgram = Effect.gen(function* () {
  const sourceRevision = yield* Config.schema(GitSourceRevisionSchema, 'OPENCODE_CODE_REVISION')
  const proxy = yield* Config.NonEmptyString('BAYN_PUBLIC_INFORMATION_PROXY')
  const binary = yield* Config.NonEmptyString('BAYN_OPENCODE_BINARY').pipe(Config.withDefault('/bin/opencode'))
  const upstream = Context.get(yield* Layer.build(JevHttpClientLive(proxy)), HttpClient.HttpClient)
  return yield* serveOpenCode({ sourceRevision, proxy, binary }, upstream)
}).pipe(Effect.scoped)

if (import.meta.main)
  NodeRuntime.runMain(
    openCodeServerProgram.pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- isolated NodeRuntime server composition root.
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeHttpClient.layerNodeHttp,
          NodeHttpServer.layer(createServer, { host: '0.0.0.0', port: 4096 }),
          Logger.layer([Logger.consoleJson]),
        ),
      ),
      Effect.mapError(
        (cause) => new ResearchError({ message: 'Bayn OpenCode server failed', cause: Redacted.make(cause) }),
      ),
    ),
  )
