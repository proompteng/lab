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

const logAgentsShellRequest = (request: Request, status: number, startedAt: number, requestId: string) => {
  const { pathname } = new URL(request.url)
  if (pathname !== '/mcp' && pathname !== PROTECTED_RESOURCE_PATH) return

  console.log(
    JSON.stringify({
      msg: 'agents-shell http request',
      requestId,
      method: request.method,
      path: pathname,
      status,
      durationMs: Date.now() - startedAt,
      userAgent: request.headers.get('user-agent'),
    }),
  )
}

export const createAgentsShellRequestHandler = (config: AgentsShellConfig, runner = new AgentsShellRunner(config)) => {
  const verifier = new AuthVerifier(config)

  const handleMcp = async (request: Request, requestId: string): Promise<Response> => {
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

    const server = createAgentsShellServer(config, runner, auth)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })

    try {
      await server.connect(transport)
      const response = await transport.handleRequest(withNormalizedMcpAcceptHeader(request))
      await transport.close()
      await server.close()
      return response
    } catch (error) {
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
    const { pathname } = new URL(request.url)
    let response: Response

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
      response = await handleMcp(request, requestId)
    } else if (pathname === '/mcp') {
      response = new Response('Method Not Allowed', { status: 405 })
    } else {
      response = new Response('Not Found', { status: 404 })
    }

    logAgentsShellRequest(request, response.status, startedAt, requestId)
    return response
  }
}

export const startAgentsShellServer = (config = defaultAgentsShellConfigFromEnv()) => {
  const runner = new AgentsShellRunner(config)
  const handleRequest = createAgentsShellRequestHandler(config, runner)

  process.once('SIGTERM', () => runner.shutdown())
  process.once('SIGINT', () => runner.shutdown())

  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    fetch: handleRequest,
  })

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
