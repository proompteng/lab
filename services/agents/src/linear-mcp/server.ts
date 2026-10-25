import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { LINEAR_PUBLIC_TOOLS, parseLinearPublicToolArguments, type LinearPublicToolName } from './contract'
import { LinearMcpIdentityError, type LinearMcpIdentityVerifier } from './identity'
import { LinearMcpPolicyError, type LinearMcpPolicyService } from './policy'

type GatewayHandlerOptions = {
  verifier: LinearMcpIdentityVerifier
  policy: LinearMcpPolicyService
  maxRequestBytes: number
  checkReady: () => Promise<{ ok: boolean; reason?: string }>
  renderMetrics: () => string
  recordPolicyDenial?: (code: string, tool: string) => void
  recordRequestDurationMs?: (durationMs: number, attributes: Record<string, string>) => void
}

const json = (status: number, value: Record<string, unknown>, headers: HeadersInit = {}) => {
  const responseHeaders = new Headers(headers)
  responseHeaders.set('content-type', 'application/json')
  responseHeaders.set('cache-control', 'no-store')
  return new Response(JSON.stringify(value), { status, headers: responseHeaders })
}

const bearerToken = (request: Request) => {
  const authorization = request.headers.get('authorization')?.trim() ?? ''
  const match = authorization.match(/^Bearer ([^\s]+)$/i)
  if (!match?.[1]) throw new LinearMcpIdentityError('bearer token is required', 401, 'invalid_token')
  return match[1]
}

const readBoundedBody = async (request: Request, maxBytes: number) => {
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      totalBytes += result.value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel()
        throw json(413, { error: 'request_too_large' })
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

const boundedMcpRequest = async (request: Request, maxBytes: number) => {
  if (request.method !== 'POST') throw new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw json(415, { error: 'content_type_required' })
  }
  const contentLengthHeader = request.headers.get('content-length')
  if (contentLengthHeader !== null) {
    const normalized = contentLengthHeader.trim()
    const contentLength = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN
    if (!Number.isSafeInteger(contentLength)) throw json(400, { error: 'invalid_content_length' })
    if (contentLength > maxBytes) throw json(413, { error: 'request_too_large' })
  }
  const body = await readBoundedBody(request, maxBytes)
  return new Request(request.url, {
    method: 'POST',
    headers: request.headers,
    body,
    signal: request.signal,
  })
}

const toolError = (error: unknown): CallToolResult => {
  if (error instanceof LinearMcpPolicyError) {
    return {
      isError: true,
      content: [{ type: 'text', text: error.message }],
      structuredContent: { error: error.code },
    }
  }
  return {
    isError: true,
    content: [{ type: 'text', text: error instanceof Error ? error.message : 'Linear MCP request failed' }],
    structuredContent: { error: 'request_failed' },
  }
}

const isPublicToolName = (name: string): name is LinearPublicToolName =>
  LINEAR_PUBLIC_TOOLS.some((tool) => tool.name === name)

export const createLinearMcpGatewayHandler = (options: GatewayHandlerOptions) => async (request: Request) => {
  const startedAt = Date.now()
  const url = new URL(request.url)
  try {
    if (url.pathname === '/healthz') return json(200, { status: 'ok', service: 'agents-linear-mcp-gateway' })
    if (url.pathname === '/readyz') {
      const readiness = await options.checkReady()
      return json(readiness.ok ? 200 : 503, {
        status: readiness.ok ? 'ok' : 'degraded',
        service: 'agents-linear-mcp-gateway',
        ...(readiness.reason ? { reason: readiness.reason } : {}),
      })
    }
    if (url.pathname === '/metrics') {
      return new Response(options.renderMetrics(), {
        status: 200,
        headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    if (url.pathname !== '/mcp') return json(404, { error: 'not_found' })

    const token = bearerToken(request)
    const identity = await options.verifier.verify(token)
    const bounded = await boundedMcpRequest(request, options.maxRequestBytes)
    const server = new Server({ name: 'agents-linear-mcp-gateway', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: LINEAR_PUBLIC_TOOLS }))
    server.setRequestHandler(CallToolRequestSchema, async (message) => {
      const name = message.params.name
      if (!isPublicToolName(name)) {
        options.recordPolicyDenial?.('tool_not_exposed', 'unknown')
        return toolError(new LinearMcpPolicyError('requested tool is not exposed', 'argument_denied'))
      }
      try {
        let args: Record<string, unknown>
        try {
          args = parseLinearPublicToolArguments(name, message.params.arguments ?? {})
        } catch {
          options.recordPolicyDenial?.('argument_denied', name)
          throw new LinearMcpPolicyError('tool arguments are not allowed', 'argument_denied')
        }
        return await options.policy.call(name, args, {
          identity,
          revalidateIdentity: () => options.verifier.verify(token),
        })
      } catch (error) {
        return toolError(error)
      }
    })
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    try {
      await server.connect(transport)
      const response = await transport.handleRequest(bounded)
      response.headers.set('cache-control', 'no-store')
      response.headers.set('x-content-type-options', 'nosniff')
      return response
    } finally {
      await transport.close().catch(() => undefined)
      await server.close().catch(() => undefined)
    }
  } catch (error) {
    if (error instanceof Response) return error
    if (error instanceof LinearMcpIdentityError) {
      options.recordPolicyDenial?.(error.code, 'identity')
      return json(
        error.status,
        { error: error.code },
        error.status === 401 ? { 'www-authenticate': 'Bearer realm="agents-linear-mcp"' } : {},
      )
    }
    return json(500, { error: 'internal_error' })
  } finally {
    options.recordRequestDurationMs?.(Date.now() - startedAt, { path: url.pathname, method: request.method })
  }
}
