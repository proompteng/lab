const IN_MEMORY_CHAT_STATE_BACKENDS = new Set(['memory', 'in-memory', 'mem'])

export const shouldUseInMemoryChatStateStore = () => {
  const backend = (process.env.JANGAR_CHAT_STATE_BACKEND ?? 'redis').trim().toLowerCase()
  return IN_MEMORY_CHAT_STATE_BACKENDS.has(backend)
}
