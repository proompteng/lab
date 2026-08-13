import type { Http2Server, ServerHttp2Session } from 'node:http2'

import { Data, Effect, Scope } from 'effect'

export class RestateHttp2ServerError extends Data.TaggedError('RestateHttp2ServerError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

interface RestateHttp2ServerResource {
  readonly server: Http2Server
  readonly sessions: Set<ServerHttp2Session>
  readonly onSession: (session: ServerHttp2Session) => void
}

const listen = (
  server: Http2Server,
  port: number,
): Effect.Effect<RestateHttp2ServerResource, RestateHttp2ServerError> =>
  Effect.callback((resume) => {
    const sessions = new Set<ServerHttp2Session>()
    const onSession = (session: ServerHttp2Session): void => {
      sessions.add(session)
      session.once('close', () => sessions.delete(session))
    }
    const onError = (cause: Error) => {
      server.off('listening', onListening)
      server.off('session', onSession)
      resume(
        Effect.fail(
          new RestateHttp2ServerError({
            message: 'Restate endpoint failed to listen',
            cause,
          }),
        ),
      )
    }
    const onListening = () => {
      server.off('error', onError)
      resume(Effect.succeed({ server, sessions, onSession }))
    }
    server.on('session', onSession)
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port)
    return Effect.sync(() => {
      server.off('error', onError)
      server.off('listening', onListening)
      server.off('session', onSession)
      for (const session of sessions) session.destroy()
      server.close()
    })
  })

const close = (resource: RestateHttp2ServerResource): Effect.Effect<void> =>
  Effect.callback((resume) => {
    resource.server.off('session', resource.onSession)
    for (const session of resource.sessions) session.destroy()
    if (!resource.server.listening) {
      resume(Effect.void)
      return
    }
    resource.server.close(() => resume(Effect.void))
  })

export const acquireRestateHttp2Server = (
  server: Http2Server,
  port: number,
): Effect.Effect<void, RestateHttp2ServerError, Scope.Scope> =>
  Effect.acquireRelease(listen(server, port), close, { interruptible: true }).pipe(Effect.asVoid)
