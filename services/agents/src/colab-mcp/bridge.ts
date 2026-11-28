import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { createProjectedIdentityFetch } from '../linear-mcp/bridge-auth'
import { COLAB_TOOL_TIMEOUT_MS } from './config'

export const connectColabBridge = async (
  stdio: Transport,
  config: { gatewayUrl: URL; tokenPath: string; fetch?: FetchLike },
) => {
  const info = { name: 'agents-colab-mcp-bridge', version: '1.0.0' }
  const gateway = new Client(info)
  const authenticated = createProjectedIdentityFetch(config)
  const transport = new StreamableHTTPClientTransport(config.gatewayUrl, {
    fetch: (input, init) => {
      const request: RequestInit & { timeout: false } = { ...init, redirect: 'error', timeout: false }
      return authenticated(input, request)
    },
  })
  const bridge = new Server(info, { capabilities: { tools: {} } })
  bridge.setRequestHandler(ListToolsRequestSchema, (request) => gateway.listTools(request.params, { timeout: 25_000 }))
  bridge.setRequestHandler(CallToolRequestSchema, (request, { signal }) =>
    gateway.callTool(request.params, CallToolResultSchema, { signal, timeout: COLAB_TOOL_TIMEOUT_MS + 30_000 }),
  )
  bridge.onclose = () => void gateway.close().catch(() => undefined)
  const stop = () => Promise.allSettled([bridge.close(), gateway.close()])
  try {
    await gateway.connect(transport, { timeout: 25_000 })
    await bridge.connect(stdio)
    return stop
  } catch (error) {
    await stop()
    throw error
  }
}
