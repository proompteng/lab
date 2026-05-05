const MISSING_UPSTREAM_THREAD_MESSAGE_FRAGMENTS = ['conversation not found', 'thread not found'] as const

export class MissingUpstreamThreadError extends Error {
  readonly upstream: unknown

  constructor(upstream: unknown) {
    super('missing upstream thread')
    this.upstream = upstream
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const includesMissingUpstreamThreadMessage = (message: string) => {
  const normalized = message.toLowerCase()
  return MISSING_UPSTREAM_THREAD_MESSAGE_FRAGMENTS.some((fragment) => normalized.includes(fragment))
}

const collectErrorMessages = (error: unknown, maxDepth = 5): string[] => {
  const messages: string[] = []
  const seen = new WeakSet<object>()

  const visit = (value: unknown, depth: number) => {
    if (depth <= 0 || value == null) return
    if (typeof value === 'string') {
      messages.push(value)
      return
    }
    if (!isRecord(value)) return
    if (seen.has(value)) return
    seen.add(value)

    if (typeof value.message === 'string') messages.push(value.message)
    if (typeof value.error === 'string') messages.push(value.error)

    // JSON-RPC errors tend to nest under `.error` (and sometimes `.error.error`).
    if (value.error != null) visit(value.error, depth - 1)
  }

  visit(error, maxDepth)
  return messages
}

export const isMissingUpstreamThreadError = (error: unknown): boolean =>
  collectErrorMessages(error).some((message) => includesMissingUpstreamThreadMessage(message))
