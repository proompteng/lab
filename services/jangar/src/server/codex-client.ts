import { CodexAppServerClient } from '@proompteng/codex'
import { Effect } from 'effect'

import { MockCodexAppServerClient, shouldUseMockCodexClient } from './mock-codex-client'
import { type CodexClientConfig, resolveCodexClientConfig } from './runtime-tooling-config'

type Factory = (options: { defaultModel: string }) => CodexAppServerClient
type JsonValue = number | string | boolean | JsonValue[] | { [key: string]: JsonValue | undefined } | null

const buildMcpServers = (config: CodexClientConfig) => {
  const servers: Record<string, { [key: string]: JsonValue | undefined }> = {
    memories: {
      url: config.agentsMcpUrl,
    },
    atlas: {
      url: config.atlasMcpUrl,
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

  const config = resolveCodexClientConfig()
  const flamingo = config.flamingo?.model === options.defaultModel ? config.flamingo : null
  const provider = flamingo ? 'flamingo' : 'openai'
  const cliConfigOverrides = ['mcp_servers={}', 'notify=[]', `model_provider=${JSON.stringify(provider)}`]
  if (flamingo) {
    cliConfigOverrides.push(
      'model_providers.flamingo.name="Flamingo"',
      `model_providers.flamingo.base_url=${JSON.stringify(flamingo.baseUrl)}`,
      'model_providers.flamingo.wire_api="responses"',
      'model_providers.flamingo.requires_openai_auth=false',
      `model_reasoning_effort=${JSON.stringify(flamingo.reasoningEffort)}`,
      'web_search="disabled"',
      'features.apps=false',
    )
  }
  return new CodexAppServerClient({
    binaryPath: config.binaryPath,
    cliConfigOverrides,
    defaultModel: options.defaultModel,
    defaultEffort: flamingo?.reasoningEffort,
    threadConfig: {
      model_provider: provider,
      'features.rmcp_client': true,
      web_search: flamingo ? 'disabled' : 'live',
      mcp_servers: buildMcpServers(config),
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

export const getCodexClient = (options: Parameters<Factory>[0]) =>
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
