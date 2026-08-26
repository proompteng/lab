import type { TengriCodexEvent, TengriCodexEventKind } from '@/lib/tengri/types'

const MAX_CODEX_EVENTS = 500
const MAX_EVENT_TEXT_BYTES = 512 << 10
const CODEX_EVENT_KINDS = new Set<TengriCodexEventKind>([
  'approval',
  'assistant-text',
  'error',
  'file-diff',
  'plan',
  'reasoning-summary',
  'thread-state',
  'tool-call',
  'tool-output',
  'usage',
  'user-message',
  'warning',
  'unknown',
])

export type CodexTranscriptItem = {
  id: string
  kind: Extract<
    TengriCodexEventKind,
    'assistant-text' | 'file-diff' | 'plan' | 'reasoning-summary' | 'tool-call' | 'tool-output' | 'user-message'
  >
  text: string
}

export function appendCodexEvent(current: TengriCodexEvent[], event: TengriCodexEvent) {
  const key = codexEventKey(event)
  if (current.some((candidate) => codexEventKey(candidate) === key)) return current

  const itemIndex = event.itemId
    ? current.findIndex(
        (candidate) =>
          candidate.itemId === event.itemId &&
          candidate.threadId === event.threadId &&
          candidate.kind === event.kind &&
          (isDeltaEvent(candidate) || isDeltaEvent(event)),
      )
    : -1

  if (itemIndex >= 0) {
    const previous = current[itemIndex]!
    const next = [...current]
    next[itemIndex] = {
      ...event,
      text: isDeltaEvent(event) ? `${previous.text}${event.text}` : event.text || previous.text,
    }
    return next
  }

  return [...current.slice(-(MAX_CODEX_EVENTS - 1)), event]
}

export function parseCodexEvent(data: string): TengriCodexEvent | null {
  try {
    const value = record(JSON.parse(data))
    const sequence = value.sequence
    const kind = value.kind
    const method = value.method
    if (
      !Number.isSafeInteger(sequence) ||
      Number(sequence) < 0 ||
      typeof kind !== 'string' ||
      !CODEX_EVENT_KINDS.has(kind as TengriCodexEventKind) ||
      typeof method !== 'string' ||
      !method ||
      method.length > 256
    ) {
      return null
    }

    return {
      sequence: Number(sequence),
      kind: kind as TengriCodexEventKind,
      method,
      threadId: boundedString(value.threadId, 256),
      turnId: boundedString(value.turnId, 256),
      itemId: boundedString(value.itemId, 256),
      text: boundedString(value.text, MAX_EVENT_TEXT_BYTES),
      approvalId: boundedString(value.approvalId, 256),
      rawJson: boundedString(value.rawJson, MAX_EVENT_TEXT_BYTES),
    }
  } catch {
    return null
  }
}

export function codexEventDisplayText(event: TengriCodexEvent) {
  const raw = parseRawEvent(event.rawJson)
  const params = record(raw.params)
  const item = record(params.item)

  if (event.kind === 'approval') {
    const command = string(params.command)
    const explicitReason = string(params.reason)
    const reason = explicitReason || (!command ? event.text : '')
    const cwd = string(params.cwd)
    const grantRoot = string(params.grantRoot)
    return [
      reason,
      command && `Command: ${command}`,
      cwd && `Working directory: ${cwd}`,
      grantRoot && `Requested write root: ${grantRoot}`,
    ]
      .filter(Boolean)
      .join('\n')
  }
  if (event.text) return event.text
  if (event.kind === 'tool-call') {
    const server = string(item.server)
    const namespace = string(item.namespace)
    const tool = string(item.tool)
    return [server || namespace, tool].filter(Boolean).join('/') || string(item.command)
  }
  if (event.kind === 'tool-output') {
    return string(item.aggregatedOutput) || string(record(item.error).message)
  }
  if (event.kind === 'usage') {
    const tokenUsage = record(params.tokenUsage || params.usage)
    const total = record(tokenUsage.total)
    const usage = Object.keys(total).length > 0 ? total : tokenUsage
    const input = finiteNumber(usage.inputTokens ?? usage.input_tokens)
    const output = finiteNumber(usage.outputTokens ?? usage.output_tokens)
    if (input !== null || output !== null) {
      return `Tokens: ${input ?? 0} input · ${output ?? 0} output`
    }
  }
  return ''
}

export function codexTranscriptFromThread(rawJson: string): CodexTranscriptItem[] {
  try {
    const response = record(JSON.parse(rawJson))
    const thread = record(response.thread)
    const turns = Array.isArray(thread.turns) ? thread.turns : []
    const transcript: CodexTranscriptItem[] = []
    const seen = new Set<string>()
    for (const turnValue of turns) {
      const turn = record(turnValue)
      const items = Array.isArray(turn.items) ? turn.items : []
      for (const itemValue of items) {
        const item = record(itemValue)
        const transcriptItem = transcriptItemFromCodex(string(item.id), string(item.type), item)
        if (transcriptItem && !seen.has(transcriptItem.id)) {
          seen.add(transcriptItem.id)
          transcript.push(transcriptItem)
        }
      }
    }
    return transcript
  } catch {
    return []
  }
}

function transcriptItemFromCodex(id: string, type: string, item: Record<string, unknown>): CodexTranscriptItem | null {
  if (!id) return null
  if (type === 'userMessage') {
    const content = Array.isArray(item.content) ? item.content : []
    const text = content
      .map((part) => string(record(part).text))
      .filter(Boolean)
      .join('\n')
    return transcript(id, 'user-message', text)
  }
  if (type === 'agentMessage') return transcript(id, 'assistant-text', string(item.text))
  if (type === 'plan') return transcript(id, 'plan', string(item.text))
  if (type === 'reasoning') {
    const summary = stringArray(item.summary).join('\n')
    const content = stringArray(item.content).join('\n')
    return transcript(id, 'reasoning-summary', summary || content)
  }
  if (type === 'commandExecution') {
    const output = string(item.aggregatedOutput)
    return transcript(id, output ? 'tool-output' : 'tool-call', output || string(item.command))
  }
  if (type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : []
    return transcript(
      id,
      'file-diff',
      changes
        .map((change) => {
          const value = record(change)
          return string(value.diff) || string(value.path)
        })
        .filter(Boolean)
        .join('\n'),
    )
  }
  if (type === 'mcpToolCall' || type === 'dynamicToolCall') {
    const output = toolResultText(item)
    if (output) return transcript(id, 'tool-output', output)
    return transcript(
      id,
      'tool-call',
      [string(item.server) || string(item.namespace), string(item.tool)].filter(Boolean).join('/'),
    )
  }
  return null
}

function toolResultText(item: Record<string, unknown>) {
  const error = string(record(item.error).message)
  if (error) return error
  const contentItems = Array.isArray(item.contentItems) ? item.contentItems : []
  const dynamicText = contentItems
    .map((part) => string(record(part).text))
    .filter(Boolean)
    .join('\n')
  if (dynamicText) return dynamicText
  const result = record(item.result)
  const content = Array.isArray(result.content) ? result.content : []
  return content
    .map((part) => string(record(part).text))
    .filter(Boolean)
    .join('\n')
}

function transcript(id: string, kind: CodexTranscriptItem['kind'], text: string): CodexTranscriptItem | null {
  return text ? { id, kind, text } : null
}

function parseRawEvent(rawJson: string) {
  try {
    return record(JSON.parse(rawJson))
  } catch {
    return {}
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function string(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(string).filter(Boolean) : []
}

function boundedString(value: unknown, maximumBytes: number) {
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > maximumBytes) return ''
  return value
}

function finiteNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function isDeltaEvent(event: TengriCodexEvent) {
  return event.method.toLowerCase().endsWith('delta')
}

function codexEventKey(event: TengriCodexEvent) {
  return `${event.sequence}:${event.method}:${event.threadId}:${event.turnId}:${event.itemId}:${event.approvalId}`
}
