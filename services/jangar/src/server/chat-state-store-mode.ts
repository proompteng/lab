import { resolveChatConfig } from './chat-config'

const IN_MEMORY_CHAT_STATE_BACKENDS = new Set(['memory', 'in-memory', 'mem'])

export const shouldUseInMemoryChatStateStore = () => {
  const backend = resolveChatConfig(process.env).chatStateBackend
  return IN_MEMORY_CHAT_STATE_BACKENDS.has(backend)
}
