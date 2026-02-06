import { CodexAppServerClient } from '@proompteng/codex'
import { Effect } from 'effect'

type Factory = (options?: { defaultModel?: string }) => CodexAppServerClient

const resolveMcpUrl = () => {
  const envUrl = process.env.JANGAR_MCP_URL?.trim()
  if (envUrl && envUrl.length > 0) return envUrl

  const port = (process.env.UI_PORT ?? process.env.PORT ?? '8080').trim()
  return `http://127.0.0.1:${port}/mcp`
}

const defaultFactory: Factory = (options) =>
  new CodexAppServerClient({
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

let activeClient: CodexAppServerClient | null = null
let factory: Factory = defaultFactory

export const getCodexClient = (options?: { defaultModel?: string }) =>
  Effect.sync(() => {
    if (activeClient) {
      return activeClient
    }
    activeClient = factory(options)
    return activeClient
  })

export const setCodexClientFactory = (next: Factory) => {
  if (activeClient) {
    activeClient.stop()
    activeClient = null
  }
  factory = next
}

export const resetCodexClient = () => {
  if (activeClient) {
    activeClient.stop()
    activeClient = null
  }
  factory = defaultFactory
}
