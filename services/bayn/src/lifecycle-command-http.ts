import { createServer } from 'node:http'
import type { Socket } from 'node:net'

import { NodeHttpServer } from '@effect/platform-node'
import { Cause, Data, Effect, Exit, FileSystem, Scope, Semaphore } from 'effect'
import { HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import type { ServeError } from 'effect/unstable/http/HttpServerError'

import type { LifecycleCommandStoreShape } from './db/lifecycle-command'
import type { WriterFenceService } from './execution/writer-fence'
import { bearerToken, type LifecycleCommandAuthenticator } from './lifecycle-command-auth'
import { decideLifecycleCommand } from './lifecycle-command-contract'
import type { AutonomousCyclePassObservation } from './runtime-state'
import { currentUtcInstant } from './time'
import type { CycleRunnerError } from './cycle/runner'

export interface LifecycleCommandServerConfig {
  readonly host: string
  readonly port: number
  readonly controllerKey: string
  readonly sourceRevision: string
  readonly previousSourceRevision: string | undefined
  readonly nextDelayMs: number
}

export interface LifecycleCommandExecutionReceipt {
  readonly observation: AutonomousCyclePassObservation
  readonly replayed: boolean
}

export interface LifecycleCommandAdvance {
  readonly observation: AutonomousCyclePassObservation
}

export const executeLifecycleCommand = <E, R>(
  store: LifecycleCommandStoreShape,
  fence: WriterFenceService,
  command: {
    readonly controllerKey: string
    readonly commandId: string
    readonly sequence: number
    readonly issuedAt: string
  },
  advance: Effect.Effect<LifecycleCommandAdvance, E, R>,
): Effect.Effect<
  LifecycleCommandExecutionReceipt,
  E | import('./db/lifecycle-command').LifecycleCommandStoreError | import('./execution/writer-fence').WriterFenceError,
  R
> =>
  fence.transaction(store.begin(command)).pipe(
    Effect.flatMap((receipt) => {
      if (receipt._tag === 'Completed') {
        const replayed: LifecycleCommandExecutionReceipt = {
          observation: receipt.observation,
          replayed: true,
        }
        return Effect.logInfo('Bayn lifecycle command replayed from durable completion').pipe(
          Effect.annotateLogs({
            controllerKey: command.controllerKey,
            commandId: command.commandId,
            commandSequence: command.sequence,
            commandResult: receipt.observation.result,
          }),
          Effect.as(replayed),
        )
      }
      return advance.pipe(
        Effect.flatMap((advanced) =>
          currentUtcInstant.pipe(
            Effect.flatMap((completedAt) =>
              fence.transaction(store.complete({ ...command, completedAt, observation: advanced.observation })),
            ),
          ),
        ),
        Effect.tap((observation) =>
          Effect.logInfo('Bayn lifecycle command completed').pipe(
            Effect.annotateLogs({
              controllerKey: command.controllerKey,
              commandId: command.commandId,
              commandSequence: command.sequence,
              commandResult: observation.result,
            }),
          ),
        ),
        Effect.map(
          (observation): LifecycleCommandExecutionReceipt => ({
            observation,
            replayed: false,
          }),
        ),
      )
    }),
  )

class LifecycleCommandHttpError extends Data.TaggedError('LifecycleCommandHttpError')<{
  readonly reason: 'INVALID_JSON'
  readonly message: string
  readonly cause?: unknown
}> {}

const maximumCommandBytes = 4_096

const jsonResponse = (status: number, body: unknown): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  HttpServerResponse.json(body, {
    status,
    headers: { 'cache-control': 'no-store', connection: 'close' },
  }).pipe(Effect.orDie)

const readJsonBody = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<unknown, LifecycleCommandHttpError> => {
  const declaredLength = Number.parseInt(request.headers['content-length'] ?? '0', 10)
  if (Number.isFinite(declaredLength) && declaredLength > maximumCommandBytes) {
    return Effect.fail(new LifecycleCommandHttpError({ reason: 'INVALID_JSON', message: 'command body exceeds limit' }))
  }
  return request.json.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(maximumCommandBytes)),
    Effect.mapError(
      (cause) =>
        new LifecycleCommandHttpError({
          reason: 'INVALID_JSON',
          message: 'command body is not valid bounded JSON',
          cause,
        }),
    ),
  )
}

const authenticateRequest = (
  authorization: string | undefined,
  authenticate: LifecycleCommandAuthenticator,
): Effect.Effect<
  | { readonly _tag: 'Authorized' }
  | { readonly _tag: 'Rejected'; readonly status: 401 | 403 | 503; readonly reason: string },
  never
> => {
  const token = bearerToken(authorization)
  if (token === null) {
    return Effect.succeed({ _tag: 'Rejected', status: 401, reason: 'AUTHENTICATION_REQUIRED' })
  }
  return authenticate(token).pipe(
    Effect.map((authorized) =>
      authorized
        ? ({ _tag: 'Authorized' } as const)
        : ({ _tag: 'Rejected', status: 403, reason: 'AUTHENTICATION_REJECTED' } as const),
    ),
    Effect.catch((cause) =>
      Effect.logError('Bayn lifecycle command authentication failed', cause).pipe(
        Effect.andThen(
          Effect.succeed({ _tag: 'Rejected', status: 503, reason: 'AUTHENTICATION_UNAVAILABLE' } as const),
        ),
      ),
    ),
  )
}

const handleRequest = <R>(
  config: LifecycleCommandServerConfig,
  store: LifecycleCommandStoreShape,
  fence: WriterFenceService,
  commandPermit: Semaphore.Semaphore,
  authenticate: LifecycleCommandAuthenticator,
  advance: Effect.Effect<LifecycleCommandAdvance, CycleRunnerError, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest | R> =>
  HttpServerRequest.HttpServerRequest.pipe(
    Effect.flatMap((request) => {
      if (request.method === 'GET' && request.url === '/livez') {
        return jsonResponse(200, { service: 'bayn-lifecycle-command', live: true })
      }
      return authenticateRequest(request.headers['authorization'], authenticate).pipe(
        Effect.flatMap((authentication) => {
          if (authentication._tag === 'Rejected') {
            return jsonResponse(authentication.status, { accepted: false, reason: authentication.reason })
          }
          if (request.method === 'GET' && request.url === '/v1/lifecycle/cursor') {
            return store.readCursor(config.controllerKey).pipe(
              Effect.flatMap((cursor) =>
                jsonResponse(200, {
                  schemaVersion: 'bayn.lifecycle-command-cursor.v1',
                  controllerKey: config.controllerKey,
                  sourceRevision: config.sourceRevision,
                  cursor,
                }),
              ),
              Effect.catch((cause) =>
                Effect.logError('Bayn lifecycle command cursor failed', cause).pipe(
                  Effect.annotateLogs({ controllerKey: config.controllerKey }),
                  Effect.andThen(jsonResponse(503, { available: false, reason: 'CURSOR_FAILED' })),
                ),
              ),
            )
          }
          if (request.method !== 'POST' || request.url !== '/v1/lifecycle/advance') {
            return jsonResponse(404, { error: 'not found' })
          }
          return readJsonBody(request).pipe(
            Effect.map((candidate) =>
              decideLifecycleCommand(
                config.controllerKey,
                [
                  config.sourceRevision,
                  ...(config.previousSourceRevision === undefined ? [] : [config.previousSourceRevision]),
                ],
                candidate,
              ),
            ),
            Effect.orElseSucceed(() => ({
              _tag: 'Reject' as const,
              status: 400 as const,
              reason: 'INVALID_COMMAND' as const,
            })),
            Effect.flatMap((decision) => {
              if (decision._tag === 'Reject') {
                return jsonResponse(decision.status, { accepted: false, reason: decision.reason })
              }
              return commandPermit.withPermit(executeLifecycleCommand(store, fence, decision.command, advance)).pipe(
                Effect.interruptible,
                Effect.flatMap((receipt) =>
                  jsonResponse(200, {
                    schemaVersion: 'bayn.lifecycle-command-response.v1',
                    accepted: true,
                    commandId: decision.command.commandId,
                    sequence: decision.command.sequence,
                    sourceRevision: decision.sourceRevision,
                    replayed: receipt.replayed,
                    nextDelayMs: config.nextDelayMs,
                    observation: receipt.observation,
                  }),
                ),
                Effect.catch((cause) =>
                  Effect.logError('Bayn lifecycle command failed', cause).pipe(
                    Effect.annotateLogs({
                      controllerKey: decision.command.controllerKey,
                      commandId: decision.command.commandId,
                      commandSequence: decision.command.sequence,
                    }),
                    Effect.andThen(jsonResponse(503, { accepted: false, reason: 'COMMAND_FAILED' })),
                  ),
                ),
              )
            }),
          )
        }),
      )
    }),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logError('Bayn lifecycle command handler defect', cause).pipe(
            Effect.andThen(jsonResponse(500, { accepted: false, reason: 'INTERNAL_ERROR' })),
          ),
    ),
  )

export const serveLifecycleCommands = <R>(
  config: LifecycleCommandServerConfig,
  store: LifecycleCommandStoreShape,
  fence: WriterFenceService,
  authenticate: LifecycleCommandAuthenticator,
  advance: Effect.Effect<LifecycleCommandAdvance, CycleRunnerError, R>,
): Effect.Effect<never, ServeError, R> =>
  Effect.gen(function* () {
    const commandPermit = yield* Semaphore.make(1)
    const nodeServer = createServer()
    const sockets = new Set<Socket>()
    nodeServer.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    yield* NodeHttpServer.make(() => nodeServer, {
      host: config.host,
      port: config.port,
      disablePreemptiveShutdown: true,
      gracefulShutdownTimeout: '5 seconds',
    })
    const requestScope = yield* Scope.make('parallel')
    const handler = yield* NodeHttpServer.makeHandler(
      handleRequest(config, store, fence, commandPermit, authenticate, advance),
      { scope: requestScope },
    )
    nodeServer.on('request', handler)
    yield* Effect.logInfo('Bayn lifecycle command server is listening').pipe(
      Effect.annotateLogs({ controllerKey: config.controllerKey, host: config.host, port: config.port }),
    )
    // The official Effect handler owns every request in requestScope. Unwinding first detaches new work, then closes
    // that scope to interrupt and join active handlers before the official NodeHttpServer finalizer closes sockets.
    return yield* Effect.never.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          nodeServer.off('request', handler)
          for (const socket of sockets) socket.destroy()
          nodeServer.closeAllConnections()
        }).pipe(Effect.andThen(Scope.close(requestScope, Exit.void))),
      ),
    )
  }).pipe(Effect.scoped)
