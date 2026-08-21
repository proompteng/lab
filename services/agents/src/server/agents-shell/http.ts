import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { resolve } from 'node:path'

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'

import {
  AuthVerifier,
  anonymousAuthContext,
  bearerTokenFromRequest,
  buildBearerChallenge,
  logOAuthFailure,
  oauthProtectedResourceMetadata,
  withNormalizedMcpAcceptHeader,
  type AuthContext,
} from './auth'
import { PROTECTED_RESOURCE_PATH } from './constants'
import { defaultAgentsShellConfigFromEnv, type AgentsShellConfig } from './config'
import { measureEffectToolSchemaBytes } from './mcp-adapter'
import { AgentsShellRunner } from './runner'
import { createAgentsShellServer } from './server'
import { createAgentsShellTools } from './tools'
import { sessionIdentityHash } from './workspace-leases'

type AuthVerifierLike = Pick<AuthVerifier, 'verify'>

type SessionEntry = {
  sessionId: string
  issuedAuth: AuthContext
  requestAuth: AsyncLocalStorage<AuthContext>
  server: ReturnType<typeof createAgentsShellServer>
  transport: WebStandardStreamableHTTPServerTransport
  closing: boolean
  expiryTimeout: ReturnType<typeof setTimeout> | null
  dispatchTail: Promise<void>
}

type AgentsShellRequestHandlerOptions = {
  beforeStatefulDispatch?: (auth: AuthContext, sessionId: string) => void | Promise<void>
}

const jsonResponse = (payload: unknown, init: ResponseInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json')
  return new Response(JSON.stringify(payload), { ...init, headers })
}

const mcpErrorResponse = (status: number, code: number, message: string, init: ResponseInit = {}) =>
  jsonResponse({ jsonrpc: '2.0', error: { code, message }, id: null }, { ...init, status })

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

export const createAgentsShellRequestHandler = (
  config: AgentsShellConfig,
  runner = new AgentsShellRunner(config),
  verifier: AuthVerifierLike = new AuthVerifier(config),
  options: AgentsShellRequestHandlerOptions = {},
) => {
  const sessions = new Map<string, SessionEntry>()
  const toolSchemaBytes = measureEffectToolSchemaBytes(createAgentsShellTools())

  const authenticate = async (request: Request, requestId: string) => {
    const token = bearerTokenFromRequest(request)
    if (!token) return { auth: anonymousAuthContext(), tokenPresent: false }
    try {
      return { auth: await verifier.verify(token), tokenPresent: true }
    } catch (error) {
      logOAuthFailure(request, requestId, token, error)
      return {
        auth: anonymousAuthContext({
          error: 'invalid_token',
          description: 'The access token is invalid or expired.',
        }),
        tokenPresent: true,
      }
    }
  }

  const closeSession = async (entry: SessionEntry, reason: string, auth: AuthContext | null) => {
    if (entry.closing) return
    entry.closing = true
    sessions.delete(entry.sessionId)
    if (entry.expiryTimeout) clearTimeout(entry.expiryTimeout)
    entry.expiryTimeout = null
    let revokeError: unknown = null
    try {
      runner.revokeSession(entry.sessionId, auth, reason)
    } catch (error) {
      revokeError = error
    }
    await entry.transport.close().catch(() => undefined)
    await entry.server.close().catch(() => undefined)
    try {
      runner.audit('mcp_session_closed', auth, { sessionHash: sessionIdentityHash(entry.sessionId), reason }, true)
    } catch (error) {
      revokeError ??= error
    }
    if (revokeError) throw revokeError
  }

  const withSessionDispatch = async <A>(entry: SessionEntry, action: () => Promise<A>) => {
    const previous = entry.dispatchTail
    let release!: () => void
    entry.dispatchTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous.catch(() => undefined)
    try {
      return await action()
    } finally {
      release()
    }
  }

  const scheduleSessionExpiry = (entry: SessionEntry, auth: AuthContext) => {
    if (typeof auth.payload.exp !== 'number') return
    if (entry.expiryTimeout) clearTimeout(entry.expiryTimeout)
    entry.expiryTimeout = setTimeout(
      () =>
        void withSessionDispatch(entry, () => closeSession(entry, 'access_token_expired', entry.issuedAuth)).catch(
          () => undefined,
        ),
      Math.max(1, auth.payload.exp * 1000 - Date.now()),
    )
  }

  const createStatefulSession = async (auth: AuthContext) => {
    const sessionId = randomUUID()
    const requestAuth = new AsyncLocalStorage<AuthContext>()
    const server = createAgentsShellServer(
      config,
      runner,
      () => {
        const current = requestAuth.getStore()
        if (!current) throw new Error('stateful MCP request auth context is unavailable')
        return current
      },
      sessionId,
    )
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      enableJsonResponse: true,
    })
    const entry: SessionEntry = {
      sessionId,
      issuedAuth: auth,
      requestAuth,
      server,
      transport,
      closing: false,
      expiryTimeout: null,
      dispatchTail: Promise.resolve(),
    }
    sessions.set(sessionId, entry)
    try {
      await server.connect(transport)
      runner.audit('mcp_session_issued', auth, { sessionHash: sessionIdentityHash(sessionId) }, true)
      scheduleSessionExpiry(entry, auth)
      return entry
    } catch (error) {
      sessions.delete(sessionId)
      await transport.close().catch(() => undefined)
      await server.close().catch(() => undefined)
      throw error
    }
  }

  const handleStateless = async (request: Request, auth: AuthContext, parsedBody?: unknown) => {
    const sessionId = `ephemeral:${randomUUID()}`
    const server = createAgentsShellServer(config, runner, auth, sessionId)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    try {
      await server.connect(transport)
      return await transport.handleRequest(withNormalizedMcpAcceptHeader(request), { parsedBody })
    } finally {
      await transport.close().catch(() => undefined)
      await server.close().catch(() => undefined)
    }
  }

  const handleMcp = async (request: Request, requestId: string): Promise<Response> => {
    const { auth, tokenPresent } = await authenticate(request, requestId)
    const sessionId = request.headers.get('mcp-session-id')
    const parsedBody =
      request.method === 'POST'
        ? await request
            .clone()
            .json()
            .catch(() => undefined)
        : undefined

    if (!sessionId) {
      if (request.method === 'POST' && isInitializeRequest(parsedBody)) {
        if (!tokenPresent || auth.authError || auth.subject === 'unauthenticated') {
          return mcpErrorResponse(401, -32003, 'Authentication is required to create an MCP session', {
            headers: {
              'www-authenticate': buildBearerChallenge(config, auth.authError?.error, auth.authError?.description),
            },
          })
        }
        const entry = await createStatefulSession(auth)
        try {
          return await entry.requestAuth.run(auth, () =>
            entry.transport.handleRequest(withNormalizedMcpAcceptHeader(request), { parsedBody }),
          )
        } catch (error) {
          await closeSession(entry, 'initialization_failed', auth)
          throw error
        }
      }
      if (request.method !== 'POST') {
        return mcpErrorResponse(400, -32000, 'Bad Request: Mcp-Session-Id header is required')
      }
      return handleStateless(request, auth, parsedBody)
    }

    const entry = sessions.get(sessionId)
    if (!entry) return mcpErrorResponse(404, -32001, 'MCP session not found or expired')

    return withSessionDispatch(entry, async () => {
      if (sessions.get(sessionId) !== entry || entry.closing) {
        return mcpErrorResponse(404, -32001, 'MCP session not found or expired')
      }

      let revokeReason: string | null = null
      if (entry.issuedAuth.subject !== 'unauthenticated') {
        if (!tokenPresent || auth.authError) {
          revokeReason = 'token_revoked_or_missing'
        } else if (auth.subject !== entry.issuedAuth.subject) {
          await closeSession(entry, 'session_subject_changed', auth)
          return mcpErrorResponse(403, -32002, 'MCP session identity mismatch')
        }
      }
      if (tokenPresent && !auth.authError) scheduleSessionExpiry(entry, auth)

      try {
        await options.beforeStatefulDispatch?.(auth, entry.sessionId)
        const response = await entry.requestAuth.run(auth, () =>
          entry.transport.handleRequest(withNormalizedMcpAcceptHeader(request), { parsedBody }),
        )
        if (request.method === 'DELETE') {
          await closeSession(entry, 'client_session_closed', auth)
        } else if (revokeReason) {
          await closeSession(entry, revokeReason, auth)
        }
        return response
      } catch (error) {
        if (revokeReason) await closeSession(entry, revokeReason, auth)
        throw error
      }
    })
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
        workspaceSeedPath: resolve(config.workspaceSeedPath),
        workspaceLeaseRoot: resolve(config.workspaceLeaseRoot),
        runningJobs: runner.runningJobs().length,
        activeSessions: sessions.size,
        confinement: runner.confinementStatus,
        toolSchemaBytes,
        maxToolSchemaBytes: config.maxToolSchemaBytes,
      })
    } else if (pathname === PROTECTED_RESOURCE_PATH && request.method === 'GET') {
      response = jsonResponse(oauthProtectedResourceMetadata(config))
    } else if (pathname === '/mcp' && ['DELETE', 'GET', 'POST'].includes(request.method)) {
      try {
        response = await handleMcp(request, requestId)
      } catch (error) {
        response = jsonResponse(
          { error: 'mcp_request_failed', detail: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        )
      }
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
  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    fetch: handleRequest,
  })

  let stopping = false
  const stop = async (signal: NodeJS.Signals) => {
    if (stopping) return
    stopping = true
    process.off('SIGTERM', onSigterm)
    process.off('SIGINT', onSigint)
    let failure: unknown = null
    try {
      runner.shutdown()
    } catch (error) {
      failure = error
    }
    try {
      await server.stop(true)
    } catch (error) {
      failure ??= error
    }
    if (failure) {
      console.error('[agents-shell] failed to stop after termination signal', { signal, error: failure })
      process.exitCode = 1
    }
  }
  const onSigterm = () => void stop('SIGTERM')
  const onSigint = () => void stop('SIGINT')
  process.once('SIGTERM', onSigterm)
  process.once('SIGINT', onSigint)

  console.log(
    JSON.stringify({
      msg: 'agents-shell MCP listening',
      host: server.hostname,
      port: server.port,
      resource: config.resource,
      issuer: config.issuer,
      confinement: runner.confinementStatus,
    }),
  )

  return server
}
