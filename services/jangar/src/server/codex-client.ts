import { CodexAppServerClient } from '@proompteng/codex'
import { Effect } from 'effect'

import { MockCodexAppServerClient, shouldUseMockCodexClient } from './mock-codex-client'
import { resolveCodexClientConfig } from './runtime-tooling-config'

type Factory = (options?: { defaultModel?: string }) => CodexAppServerClient

const resolveMcpUrl = () => resolveCodexClientConfig(process.env).mcpUrl

const resolveCodexBinary = () => resolveCodexClientConfig(process.env).binaryPath

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
