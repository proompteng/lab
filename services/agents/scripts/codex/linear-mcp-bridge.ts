import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { createProjectedIdentityFetch } from '../../src/linear-mcp/bridge-auth'
import {
  LINEAR_PUBLIC_TOOLS,
  parseLinearPublicToolArguments,
  type LinearPublicToolName,
} from '../../src/linear-mcp/contract'
import { resolveLinearMcpBridgeConfig } from '../../src/linear-mcp/config'

const config = resolveLinearMcpBridgeConfig()
const authenticatedFetch = createProjectedIdentityFetch({ tokenPath: config.tokenPath })

const gatewayClient = new Client({ name: 'agents-linear-mcp-bridge', version: '1.0.0' })
const gatewayTransport = new StreamableHTTPClientTransport(config.gatewayUrl, {
  fetch: authenticatedFetch,
  reconnectionOptions: {
    maxReconnectionDelay: 5000,
    initialReconnectionDelay: 250,
    reconnectionDelayGrowFactor: 2,
    maxRetries: 1,
  },
})
await gatewayClient.connect(gatewayTransport, { timeout: config.timeoutMs })

const bridge = new Server({ name: 'agents-linear-mcp', version: '1.0.0' }, { capabilities: { tools: {} } })
bridge.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: LINEAR_PUBLIC_TOOLS }))
bridge.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const name = request.params.name
  if (!LINEAR_PUBLIC_TOOLS.some((tool) => tool.name === name)) {
    return { isError: true, content: [{ type: 'text', text: `tool ${name} is not exposed` }] }
  }
  try {
    const args = parseLinearPublicToolArguments(name as LinearPublicToolName, request.params.arguments ?? {})
    const result = await gatewayClient.callTool({ name, arguments: args }, undefined, {
      timeout: config.timeoutMs,
      maxTotalTimeout: config.timeoutMs,
    })
    if (!('content' in result)) {
      return { isError: true, content: [{ type: 'text', text: 'gateway returned an incompatible result' }] }
    }
    return result as CallToolResult
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: error instanceof Error ? error.message : 'Linear MCP bridge request failed' }],
    }
  }
})

const stdio = new StdioServerTransport()
await bridge.connect(stdio)

let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  await gatewayTransport.close().catch(() => undefined)
  await stdio.close().catch(() => undefined)
}
process.once('SIGTERM', () => void stop())
process.once('SIGINT', () => void stop())
