import { CodexAppServerClient } from '@proompteng/codex'
import { Effect } from 'effect'

type Factory = (options?: { defaultModel?: string }) => CodexAppServerClient

const defaultFactory: Factory = (options) => new CodexAppServerClient({ defaultModel: options?.defaultModel })

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
