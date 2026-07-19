import type { Server } from 'bun'
import { Effect, type Scope } from 'effect'

import type { BaynConfigShape } from './config'
import type { DependencyRegistryService } from './dependencies'
import { ServerStartError, ServerStopError } from './errors'
import { handleRequest } from './http'
import type { LifecycleService } from './lifecycle'

export interface BaynServer {
  readonly hostname: string
  readonly port: number
}

const messageFrom = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const stopServer = (server: Server<unknown>): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => Promise.resolve(server.stop()),
    catch: (cause) => new ServerStopError({ message: messageFrom(cause) }),
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logError('Bayn HTTP server shutdown failed').pipe(
        Effect.annotateLogs('errorTag', error._tag),
        Effect.asVoid,
      ),
    ),
  )

export const startHttpServer = (
  config: BaynConfigShape,
  lifecycle: LifecycleService,
  dependencies: DependencyRegistryService,
): Effect.Effect<BaynServer, ServerStartError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () =>
        Bun.serve({
          hostname: config.hostname,
          port: config.port,
          fetch: (request) => Effect.runPromise(handleRequest(request, lifecycle, dependencies)),
        }),
      catch: (cause) =>
        new ServerStartError({
          hostname: config.hostname,
          port: config.port,
          message: messageFrom(cause),
        }),
    }),
    (server) => lifecycle.markStopping.pipe(Effect.zipRight(stopServer(server))),
  ).pipe(
    Effect.tap(() => lifecycle.markReady),
    Effect.tap((server) =>
      Effect.logInfo('Bayn HTTP server started').pipe(
        Effect.annotateLogs({ hostname: server.hostname ?? config.hostname, port: server.port ?? config.port }),
      ),
    ),
    Effect.map((server) => ({
      hostname: server.hostname ?? config.hostname,
      port: server.port ?? config.port,
    })),
  )
