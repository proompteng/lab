import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { AuthContext } from './auth'
import { SERVER_INSTRUCTIONS } from './constants'
import type { AgentsShellConfig } from './config'
import { installEffectToolHandlers } from './mcp-adapter'
import type { AgentsShellRunner } from './runner'
import { createAgentsShellTools } from './tools'

export const createAgentsShellServer = (
  config: AgentsShellConfig,
  runner: AgentsShellRunner,
  auth: AuthContext | (() => AuthContext),
  sessionId = `ephemeral:${crypto.randomUUID()}`,
) => {
  const server = new McpServer(
    {
      name: config.name,
      version: config.version,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
      capabilities: {
        tools: {},
      },
    },
  )

  installEffectToolHandlers(server, createAgentsShellTools(), { config, runner, auth, sessionId })

  return server
}
