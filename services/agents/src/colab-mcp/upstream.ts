import { randomUUID } from 'node:crypto'

import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolResultSchema, JSONRPCResponseSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { readBoundedText } from '../auto-ontology-mcp/body'
import { asRecord, asString } from '../server/primitives'
import { COLAB_DISCOVERY_TIMEOUT_MS, COLAB_TOOL_TIMEOUT_MS } from './config'
import { ColabError } from './errors'
import type { createColabTokenProvider } from './oauth'

const ENDPOINT = 'https://colaboratory.googleapis.com/mcp'
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export const COLAB_TOOLS = new Set([
  'list_runtime_specs',
  'get_subscription',
  'list_runtimes',
  'get_runtime',
  'create_runtime',
  'delete_runtime',
  'list_sessions',
  'create_session',
  'delete_session',
  'execute_code',
])

export const toolPayload = (result: CallToolResult): unknown => {
  if (result.structuredContent) return result.structuredContent
  const [content] = result.content
  if (result.content.length !== 1 || content?.type !== 'text') return undefined
  try {
    return JSON.parse(content.text) as unknown
  } catch {
    return undefined
  }
}

const rejectedStatuses = new Set([
  'INVALID_ARGUMENT',
  'UNAUTHENTICATED',
  'PERMISSION_DENIED',
  'FAILED_PRECONDITION',
  'RESOURCE_EXHAUSTED',
  'ALREADY_EXISTS',
])

export const creationRejected = (result: unknown) => {
  const status = asString(asRecord(asRecord(result)?.error)?.status) ?? asString(asRecord(result)?.status)
  return status !== null && rejectedStatuses.has(status)
}

const responseFor = (text: string, contentType: string | undefined, id: string) => {
  if (contentType === 'application/json') {
    const response = JSONRPCResponseSchema.parse(JSON.parse(text))
    if (response.id === id) return response
  }
  if (contentType === 'text/event-stream') {
    for (const frame of text.replace(/\r\n?/g, '\n').split('\n\n')) {
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (!data) continue
      const response = JSONRPCResponseSchema.safeParse(JSON.parse(data))
      if (response.success && response.data.id === id) return response.data
    }
  }
  throw new ColabError('colab_upstream_error', 'Colab did not return a matching MCP response.')
}

export const createColabUpstream = (options: {
  quotaProject: string
  tokens: ReturnType<typeof createColabTokenProvider>
  fetch?: FetchLike
}) => {
  const fetchImpl = options.fetch ?? fetch
  const metadataToken = async () => {
    try {
      return await options.tokens.getToken()
    } catch (error) {
      // The hosted server allows anonymous discovery. Tools always require working credentials.
      if (error instanceof ColabError && error.code === 'colab_credentials_unavailable') return undefined
      throw error
    }
  }

  const request = async (
    method: 'initialize' | 'tools/list' | 'tools/call',
    params: Record<string, unknown>,
    token: string | undefined,
    { signal, protocolVersion, timeoutMs = COLAB_DISCOVERY_TIMEOUT_MS }: UpstreamContext & { timeoutMs?: number },
  ) => {
    const id = randomUUID()
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    try {
      const headers = new Headers({
        'x-goog-user-project': options.quotaProject,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      })
      if (token) headers.set('authorization', `Bearer ${token}`)
      if (protocolVersion) headers.set('mcp-protocol-version', protocolVersion)
      // Let the operation deadline outlive Bun's default 300s response-header timeout.
      const init: RequestInit & { timeout: false } = {
        method: 'POST',
        headers,
        redirect: 'error',
        timeout: false,
        signal: deadline,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      }
      const response = await fetchImpl(ENDPOINT, init)
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined)
        if (token && response.status === 401) options.tokens.invalidate(token)
        const rejected = [400, 401, 403, 404, 429].includes(response.status)
        throw new ColabError('colab_upstream_error', `Colab returned HTTP ${response.status}.`, rejected)
      }
      const body = await readBoundedText(response, MAX_RESPONSE_BYTES, deadline)
      const result = responseFor(body, response.headers.get('content-type')?.split(';', 1)[0]?.trim(), id)
      if ('error' in result) {
        const rejected = [-32600, -32601, -32602].includes(result.error.code) || creationRejected(result.error.data)
        throw new ColabError('colab_upstream_error', 'Colab rejected the MCP request.', rejected)
      }
      return result.result
    } catch (error) {
      if (error instanceof ColabError) throw error
      if (deadline.aborted) {
        throw new ColabError('colab_upstream_timeout', 'Colab did not finish the request before the deadline.')
      }
      throw new ColabError('colab_upstream_error', 'Could not read a valid response from Colab.')
    }
  }

  return {
    initialize: async (params: Record<string, unknown>, context: UpstreamContext) =>
      request('initialize', params, await metadataToken(), context),
    listTools: async (params: Record<string, unknown>, context: UpstreamContext) =>
      request('tools/list', params, await metadataToken(), context),
    getToken: options.tokens.getToken,
    callTool: async (
      name: string,
      args: Record<string, unknown>,
      token: string,
      context: UpstreamContext,
      timeoutMs = COLAB_TOOL_TIMEOUT_MS,
    ) => {
      const result = await request('tools/call', { name, arguments: args }, token, { ...context, timeoutMs })
      const parsed = CallToolResultSchema.safeParse(result)
      if (!parsed.success) throw new ColabError('colab_upstream_error', 'Colab returned an invalid tool result.')
      return parsed.data
    },
  }
}

export type UpstreamContext = { signal: AbortSignal; protocolVersion?: string }
export type ColabUpstream = ReturnType<typeof createColabUpstream>
