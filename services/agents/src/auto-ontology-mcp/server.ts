import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { BodyTooLargeError, readBoundedText } from './body'
import { AUTO_ONTOLOGY_TOOLS, getAutoOntologyTool } from './contract'
import { AutoOntologyIdentityError } from './identity'
import { AutoOntologyUpstreamError, type AutoOntologyUpstream } from './upstream'

export const GATEWAY_NAME = 'agents-auto-ontology-mcp-gateway'

const json = (status: number, value: Record<string, unknown>, headers: Record<string, string> = {}) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store', ...headers } })

const toolError = (code: string, message: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
  structuredContent: { error: code },
})

export const createAutoOntologyGatewayHandler =
  (options: { verify: (token: string) => Promise<void>; upstream: AutoOntologyUpstream; maxRequestBytes: number }) =>
  async (request: Request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/healthz') return json(200, { status: 'ok' })
    if (request.method === 'GET' && path === '/readyz') {
      try {
        // Probe unauthenticated /api/health so kubelet readiness checks avoid Better Auth API-key row-lock contention.
        // Catalog readiness is reported by the check_readiness tool, not by the pod probe.
        await options.upstream.checkHealth(request.signal)
        return json(200, { status: 'ok' })
      } catch {
        return json(503, { status: 'degraded' })
      }
    }
    if (path !== '/mcp') return json(404, { error: 'not_found' })
    if (request.headers.has('origin')) return json(403, { error: 'origin_denied' })
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      return json(415, { error: 'content_type_required' })
    }

    const authenticate = { 'www-authenticate': `Bearer realm="${GATEWAY_NAME}"` }
    const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1]
    if (!token) return json(401, { error: 'invalid_token' }, authenticate)
    try {
      await options.verify(token)
    } catch (error) {
      if (error instanceof AutoOntologyIdentityError) {
        return json(error.status, { error: error.code }, error.status === 401 ? authenticate : {})
      }
      return json(503, { error: 'identity_unavailable' })
    }

    let parsedBody: unknown
    const bodyDeadline = AbortSignal.timeout(5000)
    try {
      parsedBody = JSON.parse(
        await readBoundedText(request, options.maxRequestBytes, AbortSignal.any([bodyDeadline, request.signal])),
      )
    } catch (error) {
      if (error instanceof BodyTooLargeError) return json(413, { error: 'request_too_large' })
      if (bodyDeadline.aborted) return json(408, { error: 'request_timeout' })
      return json(400, { error: 'invalid_json' })
    }

    const server = new Server({ name: GATEWAY_NAME, version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: AUTO_ONTOLOGY_TOOLS }))
    server.setRequestHandler(CallToolRequestSchema, async (message, { signal }) => {
      const tool = getAutoOntologyTool(message.params.name)
      if (!tool) return toolError('tool_not_exposed', 'Requested tool is not exposed')
      try {
        const result = await tool.call(
          message.params.arguments ?? {},
          options.upstream,
          AbortSignal.any([request.signal, signal]),
        )
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
      } catch (error) {
        if (error instanceof z.ZodError) return toolError('argument_denied', 'Tool arguments are not allowed')
        if (error instanceof AutoOntologyUpstreamError) return toolError(error.code, error.message)
        return toolError('request_failed', 'Auto Ontology MCP request failed')
      }
    })
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
    try {
      await server.connect(transport)
      const response = await transport.handleRequest(request, { parsedBody })
      response.headers.set('cache-control', 'no-store')
      response.headers.set('x-content-type-options', 'nosniff')
      return response
    } finally {
      await server.close()
    }
  }
