import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { resolveAutoOntologyBridgeConfig } from '../../src/auto-ontology-mcp/config'
import { AUTO_ONTOLOGY_TOOLS, getAutoOntologyTool } from '../../src/auto-ontology-mcp/contract'
import { createProjectedIdentityFetch } from '../../src/linear-mcp/bridge-auth'

const config = resolveAutoOntologyBridgeConfig()
const name = 'agents-auto-ontology-mcp-bridge'
const gateway = new Client({ name, version: '1.0.0' })
const fetchIdentity = createProjectedIdentityFetch({ tokenPath: config.tokenPath })
const transport = new StreamableHTTPClientTransport(config.gatewayUrl, {
  fetch: (input, init) => fetchIdentity(input, { ...init, redirect: 'error' }),
})
await gateway.connect(transport, { timeout: config.timeoutMs })

const bridge = new Server({ name, version: '1.0.0' }, { capabilities: { tools: {} } })
bridge.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: AUTO_ONTOLOGY_TOOLS }))
bridge.setRequestHandler(CallToolRequestSchema, async (message, { signal }) => {
  const { name, arguments: args = {} } = message.params
  const tool = getAutoOntologyTool(name)
  if (!tool?.parse(args).success) {
    return { isError: true, content: [{ type: 'text', text: 'Tool or arguments are not allowed' }] }
  }
  try {
    return await gateway.callTool({ name, arguments: args }, CallToolResultSchema, {
      signal,
      timeout: config.timeoutMs,
      maxTotalTimeout: config.timeoutMs,
    })
  } catch {
    return { isError: true, content: [{ type: 'text', text: 'Auto Ontology MCP gateway request failed' }] }
  }
})

const stop = async () => {
  await Promise.allSettled([gateway.close(), bridge.close()])
}
await bridge.connect(new StdioServerTransport())
process.once('SIGTERM', () => void stop())
process.once('SIGINT', () => void stop())
