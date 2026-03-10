import { CodexAppServerClient } from '@proompteng/codex'
import { Effect } from 'effect'

import { MockCodexAppServerClient, shouldUseMockCodexClient } from './mock-codex-client'

type Factory = (options?: { defaultModel?: string }) => CodexAppServerClient

const resolveMcpUrl = () => {
  const envUrl = process.env.JANGAR_MCP_URL?.trim()
  if (envUrl && envUrl.length > 0) return envUrl

  const port = (process.env.UI_PORT ?? process.env.PORT ?? '8080').trim()
  return `http://127.0.0.1:${port}/mcp`
}

const resolveCodexBinary = () => {
  const envPath = process.env.JANGAR_CODEX_BINARY?.trim()
  return envPath && envPath.length > 0 ? envPath : 'codex'
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
      mcp_servers: {
        memories: {
          url: resolveMcpUrl(),
        },
      },
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
