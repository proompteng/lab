import {
  CallToolRequestSchema,
  ErrorCode,
  InitializeRequestSchema,
  InitializeResultSchema,
  JSONRPCNotificationSchema,
  JSONRPCRequestSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js'

import { BodyTooLargeError, readBoundedText } from '../auto-ontology-mcp/body'
import { McpRunIdentityError, type McpRunIdentity } from '../server/mcp-run-identity'
import { COLAB_GATEWAY_NAME, COLAB_TOOL_TIMEOUT_MS } from './config'
import { ColabError } from './errors'
import { createColabRuntimePolicy } from './policy'
import { COLAB_TOOLS, type ColabUpstream } from './upstream'

export const COLAB_MAX_REQUEST_BYTES = 256 * 1024

type AuditEvent = McpRunIdentity & { tool: string; status: string; durationMs: number }

const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  })

const rpcError = (id: RequestId | null, code: number, message: string, reason?: string) =>
  json({ jsonrpc: '2.0', id, error: { code, message, ...(reason ? { data: { code: reason } } : {}) } })

export const createColabGatewayHandler = (options: {
  verify: (token: string) => Promise<McpRunIdentity>
  upstream: ColabUpstream
  credentialsReady: () => Promise<boolean>
  maxConcurrentRuntimes: number
  audit?: (event: AuditEvent) => void
}) => {
  const callTool = createColabRuntimePolicy(options.upstream, options.maxConcurrentRuntimes)
  const audit = options.audit ?? ((event) => console.info(JSON.stringify({ component: COLAB_GATEWAY_NAME, ...event })))
  const authenticate = { 'www-authenticate': `Bearer realm="${COLAB_GATEWAY_NAME}"` }
  return async (request: Request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/healthz') return json({ status: 'ok' })
    if (request.method === 'GET' && path === '/readyz') {
      const credentialsReady = await options.credentialsReady()
      return json({ credentialsReady }, credentialsReady ? 200 : 503)
    }
    if (path !== '/mcp') return json({ error: 'not_found' }, 404)
    if (request.headers.has('origin')) return json({ error: 'origin_denied' }, 403)
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      return json({ error: 'content_type_required' }, 415)
    }
    const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1]
    if (!token) return json({ error: 'invalid_token' }, 401, authenticate)
    let identity: McpRunIdentity
    try {
      identity = await options.verify(token)
    } catch (error) {
      if (error instanceof McpRunIdentityError) {
        return json({ error: error.code }, error.status, error.status === 401 ? authenticate : undefined)
      }
      return json({ error: 'identity_unavailable' }, 503)
    }

    let body: unknown
    const deadline = AbortSignal.timeout(5000)
    try {
      body = JSON.parse(
        await readBoundedText(request, COLAB_MAX_REQUEST_BYTES, AbortSignal.any([request.signal, deadline])),
      )
    } catch (error) {
      if (error instanceof BodyTooLargeError) return json({ error: 'request_too_large' }, 413)
      if (deadline.aborted) return json({ error: 'request_timeout' }, 408)
      return rpcError(null, ErrorCode.ParseError, 'Invalid JSON')
    }

    const notification = JSONRPCNotificationSchema.safeParse(body)
    if (notification.success) {
      // The hosted server is stateless. Don't relay cancellation that could interrupt another run's kernel.
      return new Response(null, { status: 202 })
    }
    const rpc = JSONRPCRequestSchema.safeParse(body)
    if (!rpc.success) return rpcError(null, ErrorCode.InvalidRequest, 'Expected one JSON-RPC request')

    const { id, method } = rpc.data
    const protocolVersion = request.headers.get('mcp-protocol-version') ?? undefined
    if (protocolVersion && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
      return json({ error: 'unsupported_protocol_version' }, 400)
    }
    const context = {
      signal:
        method === 'tools/call'
          ? AbortSignal.any([request.signal, AbortSignal.timeout(COLAB_TOOL_TIMEOUT_MS)])
          : request.signal,
      protocolVersion,
    }
    const reply = (result: unknown) => json({ jsonrpc: '2.0', id, result })
    if (method === 'ping') return reply({})
    if (method !== 'initialize' && method !== 'tools/list' && method !== 'tools/call') {
      return rpcError(id, ErrorCode.MethodNotFound, 'Method is not exposed by the Colab gateway')
    }

    let tool: string = method
    let status = 'ok'
    const started = performance.now()
    try {
      if (method === 'initialize') {
        const input = InitializeRequestSchema.safeParse(rpc.data)
        if (!input.success) {
          status = 'invalid_params'
          return rpcError(id, ErrorCode.InvalidParams, 'Invalid initialize parameters')
        }
        const result = InitializeResultSchema.parse(
          await options.upstream.initialize(
            {
              protocolVersion: input.data.params.protocolVersion,
              capabilities: {},
              clientInfo: { name: COLAB_GATEWAY_NAME, version: '1.0.0' },
            },
            context,
          ),
        )
        return reply({ ...result, capabilities: { tools: {} } })
      }
      if (method === 'tools/list') {
        const input = ListToolsRequestSchema.safeParse(rpc.data)
        if (!input.success) {
          status = 'invalid_params'
          return rpcError(id, ErrorCode.InvalidParams, 'Invalid tools/list parameters')
        }
        const result = ListToolsResultSchema.parse(
          await options.upstream.listTools({ cursor: input.data.params?.cursor }, context),
        )
        return reply({ ...result, tools: result.tools.filter((entry) => COLAB_TOOLS.has(entry.name)) })
      }

      const input = CallToolRequestSchema.safeParse(rpc.data)
      if (!input.success || input.data.params.task || !COLAB_TOOLS.has(input.data.params.name)) {
        status = 'invalid_params'
        return rpcError(id, ErrorCode.InvalidParams, 'Tool or parameters are not exposed by the Colab gateway')
      }
      tool = input.data.params.name
      const result = await callTool(
        tool,
        input.data.params.arguments ?? {},
        context,
        `${identity.namespace}/${identity.agentRun}`,
      )
      if (result.isError) status = 'tool_error'
      return reply(result)
    } catch (error) {
      if (error instanceof ColabError) {
        status = error.code
        return rpcError(id, -32000, error.message, error.code)
      }
      status = 'colab_request_failed'
      return rpcError(id, -32000, 'Colab MCP request failed.', status)
    } finally {
      audit({ ...identity, tool, status, durationMs: Math.round(performance.now() - started) })
    }
  }
}
