import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

import {
  AuthVerifier,
  anonymousAuthContext,
  bearerTokenFromRequest,
  logOAuthFailure,
  oauthProtectedResourceMetadata,
  withNormalizedMcpAcceptHeader,
} from './auth'
import { PROTECTED_RESOURCE_PATH } from './constants'
import { defaultAgentsShellConfigFromEnv, type AgentsShellConfig } from './config'
import { AgentsShellRunner } from './runner'
import { createAgentsShellServer } from './server'

const jsonResponse = (payload: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init.headers,
    },
  })

type HttpRequestPhase = 'routing' | 'authorization' | 'connect' | 'transport' | 'close'
type HttpRequestEvent = { event: 'started' | 'phase' | 'aborted' | 'failed' } | { event: 'completed'; status: number }

const observeAgentsShellRequest = (request: Request, startedAt: number, requestId: string) => {
  const { pathname } = new URL(request.url)
  const observed = pathname === '/mcp' || pathname === PROTECTED_RESOURCE_PATH
  const method = ['GET', 'POST', 'DELETE', 'HEAD', 'OPTIONS', 'PUT', 'PATCH'].includes(request.method)
    ? request.method
    : 'OTHER'
  let phase: HttpRequestPhase = 'routing'
  const record = (event: HttpRequestEvent) => {
    if (!observed) return
    console.info(
      JSON.stringify({
        msg: 'agents-shell http request',
        requestId,
        method,
        path: pathname,
        phase,
        ...event,
        aborted: request.signal.aborted,
        durationMs: Date.now() - startedAt,
      }),
    )
  }
  const onAbort = () => record({ event: 'aborted' })
  record({ event: 'started' })
  if (request.signal.aborted) onAbort()
  else if (observed) request.signal.addEventListener('abort', onAbort, { once: true })

  return {
    phase: (next: HttpRequestPhase) => {
      phase = next
      record({ event: 'phase' })
    },
    failed: () => record({ event: 'failed' }),
    completed: (status: number) => record({ event: 'completed', status }),
    dispose: () => request.signal.removeEventListener('abort', onAbort),
  }
}

export const createAgentsShellRequestHandler = (config: AgentsShellConfig, runner = new AgentsShellRunner(config)) => {
  const verifier = new AuthVerifier(config)

  const handleMcp = async (
    request: Request,
    requestId: string,
    observation: ReturnType<typeof observeAgentsShellRequest>,
  ): Promise<Response> => {
    observation.phase('authorization')
    const token = bearerTokenFromRequest(request)
    let auth = anonymousAuthContext()
    if (token) {
      try {
        auth = await verifier.verify(token)
      } catch (error) {
        logOAuthFailure(request, requestId, token, error)
        auth = anonymousAuthContext({
          error: 'invalid_token',
          description: 'The access token is invalid or expired.',
        })
      }
    }

    const server = createAgentsShellServer(config, runner, auth, requestId)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })

    try {
      observation.phase('connect')
      await server.connect(transport)
      observation.phase('transport')
      const response = await transport.handleRequest(withNormalizedMcpAcceptHeader(request))
      observation.phase('close')
      await transport.close()
      await server.close()
      return response
    } catch (error) {
      observation.failed()
      observation.phase('close')
      await transport.close().catch(() => undefined)
      await server.close().catch(() => undefined)
      return jsonResponse(
        { error: 'mcp_request_failed', detail: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      )
    }
  }

  return async (request: Request): Promise<Response> => {
    const startedAt = Date.now()
    const requestId = randomUUID()
    const observation = observeAgentsShellRequest(request, startedAt, requestId)
    const { pathname } = new URL(request.url)
    let response: Response

    try {
      if (pathname === '/healthz' && request.method === 'GET') {
        response = jsonResponse({ ok: true })
      } else if (pathname === '/readyz' && request.method === 'GET') {
        response = jsonResponse({
          ok: true,
          resource: config.resource,
          issuer: config.issuer,
          workspaceRoot: resolve(config.workspaceRoot),
          runningJobs: runner.runningJobs().length,
        })
      } else if (pathname === PROTECTED_RESOURCE_PATH && request.method === 'GET') {
        response = jsonResponse(oauthProtectedResourceMetadata(config))
      } else if (pathname === '/mcp' && ['DELETE', 'GET', 'POST'].includes(request.method)) {
        response = await handleMcp(request, requestId, observation)
      } else if (pathname === '/mcp') {
        response = new Response('Method Not Allowed', { status: 405 })
      } else {
        response = new Response('Not Found', { status: 404 })
      }

      if (pathname === '/mcp' || pathname === PROTECTED_RESOURCE_PATH) {
        const headers = new Headers(response.headers)
        headers.set('x-agents-shell-request-id', requestId)
        response = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        })
      }
      observation.completed(response.status)
      return response
    } catch (error) {
      observation.failed()
      throw error
    } finally {
      observation.dispose()
    }
  }
}

export const startAgentsShellServer = (config = defaultAgentsShellConfigFromEnv()) => {
  const runner = new AgentsShellRunner(config)
  const handleRequest = createAgentsShellRequestHandler(config, runner)

  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    fetch: handleRequest,
  })
  const shutdown = () => {
    runner.shutdown()
    void server.stop(true)
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)

  console.log(
    JSON.stringify({
      msg: 'agents-shell MCP listening',
      host: server.hostname,
      port: server.port,
      resource: config.resource,
      issuer: config.issuer,
    }),
  )

  return server
}
