export type BackfilledAgentMessage = {
  content: string
  attrs: Record<string, unknown>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const readString = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : null)

const extractAgentMessageContent = (item: Record<string, unknown>) => {
  const direct =
    readString(item.text) ?? readString(item.message) ?? readString(item.output) ?? readString(item.content)
  if (direct) return direct

  const content = item.content
  if (!Array.isArray(content)) return null

  const parts = content
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return typeof entry === 'string' ? entry : null
      }
      const segment = entry as Record<string, unknown>
      return readString(segment.text) ?? readString(segment.delta)
    })
    .filter((segment): segment is string => Boolean(segment))

  return parts.length > 0 ? parts.join('') : null
}

export const parseAgentMessagesFromEvents = (text: string | null): BackfilledAgentMessage[] => {
  if (!text) return []
  const lines = text.split(/\r?\n/)
  const messages: BackfilledAgentMessage[] = []

  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return
    }
    if (!isRecord(parsed)) return
    if (parsed.type !== 'item.completed') return
    const item = parsed.item
    if (!isRecord(item)) return
    if (typeof item.type !== 'string' || item.type !== 'agent_message') return
    const content = extractAgentMessageContent(item)
    if (!content) return
    messages.push({
      content,
      attrs: {
        source: 'artifact-backfill',
        artifact: 'implementation-events',
        eventType: parsed.type,
        itemId: readString(item.id),
        line: index + 1,
      },
    })
  })

  return messages
}

export const parseAgentMessagesFromLog = (text: string | null): BackfilledAgentMessage[] => {
  if (!text) return []
  const lines = text.split(/\r?\n/)
  const messages: BackfilledAgentMessage[] = []

  lines.forEach((line, index) => {
    if (line.trim().length === 0) return
    messages.push({
      content: line,
      attrs: {
        source: 'artifact-backfill',
        artifact: 'implementation-agent-log',
        line: index + 1,
      },
    })
  })

  return messages
}

export const buildBackfillDedupeKey = (runId: string, attrs: Record<string, unknown>) => {
  const artifact = readString(attrs.artifact)
  const lineValue = attrs.line
  const line =
    typeof lineValue === 'number'
      ? lineValue
      : typeof lineValue === 'string'
        ? Number.parseInt(lineValue, 10)
        : Number.NaN
  if (!artifact || !Number.isFinite(line)) return null
  return `backfill:${runId}:${artifact}:${line}`
}
