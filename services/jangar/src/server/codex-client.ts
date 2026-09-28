import { CodexAppServerClient } from '@proompteng/codex'
import { Effect } from 'effect'

import { MockCodexAppServerClient, shouldUseMockCodexClient } from './mock-codex-client'
import { resolveCodexClientConfig } from './runtime-tooling-config'

type Factory = (options?: { defaultModel?: string }) => CodexAppServerClient
type JsonValue = number | string | boolean | JsonValue[] | { [key: string]: JsonValue | undefined } | null

const resolveAgentsMcpUrl = () => resolveCodexClientConfig(process.env).agentsMcpUrl

const resolveAtlasMcpUrl = () => resolveCodexClientConfig(process.env).atlasMcpUrl

const resolveCodexBinary = () => resolveCodexClientConfig(process.env).binaryPath

const buildMcpServers = () => {
  const servers: Record<string, { [key: string]: JsonValue | undefined }> = {
    memories: {
      url: resolveAgentsMcpUrl(),
    },
    atlas: {
      url: resolveAtlasMcpUrl(),
    },
  }
  if (process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY) {
    servers.alpaca = {
      command: process.env.ALPACA_MCP_SERVER_COMMAND ?? '/usr/local/bin/alpaca-mcp-server',
      env: {
        ALPACA_API_KEY: process.env.ALPACA_API_KEY,
        ALPACA_SECRET_KEY: process.env.ALPACA_SECRET_KEY,
        ALPACA_PAPER_TRADE: process.env.ALPACA_PAPER_TRADE ?? 'true',
        ...(process.env.ALPACA_TOOLSETS ? { ALPACA_TOOLSETS: process.env.ALPACA_TOOLSETS } : {}),
      },
    }
  }
  return servers
}

const defaultFactory: Factory = (options) => {
  if (shouldUseMockCodexClient()) {
    return new MockCodexAppServerClient() as unknown as CodexAppServerClient
  }

  return new CodexAppServerClient({
    binaryPath: resolveCodexBinary(),
    cliConfigOverrides: ['mcp_servers={}', 'notify=[]'],
    defaultModel: options?.defaultModel,
    threadConfig: {
      'features.rmcp_client': true,
      web_search: 'live',
      mcp_servers: buildMcpServers(),
    },
  })
}

let factory: Factory = defaultFactory
const activeClients = new Set<CodexAppServerClient>()

const stopClient = (client: CodexAppServerClient) => {
  if (!activeClients.has(client)) return
  activeClients.delete(client)
  client.stop()
}

const stopAllClients = () => {
  const clients = Array.from(activeClients)
  activeClients.clear()
  for (const client of clients) {
    client.stop()
  }
}

export const getCodexClient = (options?: { defaultModel?: string }) =>
  Effect.sync(() => {
    const client = factory(options)
    activeClients.add(client)
    return client
  })

export const releaseCodexClient = (client: CodexAppServerClient) => {
  stopClient(client)
}

export const setCodexClientFactory = (next: Factory) => {
  stopAllClients()
  factory = next
}

export const resetCodexClient = () => {
  stopAllClients()
  factory = defaultFactory
}
