import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { connectColabBridge } from '../../src/colab-mcp/bridge'
import { resolveColabBridgeConfig } from '../../src/colab-mcp/config'

try {
  const stop = await connectColabBridge(new StdioServerTransport(), resolveColabBridgeConfig())
  process.once('SIGTERM', () => void stop())
  process.once('SIGINT', () => void stop())
} catch {
  console.error('Could not connect the Colab MCP bridge to its gateway.')
  process.exitCode = 1
}
