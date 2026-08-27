import type { TengriCodexEvent, TengriCodexEventKind } from '@/lib/tengri/types'

const MAX_CODEX_EVENTS = 500
const MAX_EVENT_TEXT_BYTES = 512 << 10
const TRUNCATION_MARKER = '\n… output truncated …'
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

export type CodexApprovalDecision = 'approve-once' | 'approve-session' | 'deny'

export type CodexThreadState = {
  activeTurnId: string
  items: CodexTranscriptItem[]
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
      text: isDeltaEvent(event) ? appendBoundedText(previous.text, event.text) : event.text || previous.text,
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
    const snapshot = record(params.rateLimits || params.rateLimit || params)
    const primary = rateLimitWindow('Primary', snapshot.primary)
    const secondary = rateLimitWindow('Secondary', snapshot.secondary)
    return [primary, secondary].filter(Boolean).join(' · ')
  }
  return ''
}

export function codexApprovalOptions(event: TengriCodexEvent): CodexApprovalDecision[] {
  const defaults: CodexApprovalDecision[] = ['approve-once', 'approve-session', 'deny']
  if (event.method !== 'item/commandExecution/requestApproval') return defaults
  const raw = parseRawEvent(event.rawJson)
  const available = record(raw.params).availableDecisions
  if (available === null || available === undefined) return defaults
  if (!Array.isArray(available)) return []

  const options: CodexApprovalDecision[] = []
  for (const decision of available) {
    let option: CodexApprovalDecision | null = null
    if (decision === 'accept') option = 'approve-once'
    else if (decision === 'acceptForSession') option = 'approve-session'
    else if (decision === 'decline' || decision === 'cancel') option = 'deny'
    if (option && !options.includes(option)) options.push(option)
  }
  return options
}

export function codexThreadStateFromThread(rawJson: string): CodexThreadState {
  try {
    const response = record(JSON.parse(rawJson))
    const thread = record(response.thread)
    const turns = Array.isArray(thread.turns) ? thread.turns : []
    const transcript: CodexTranscriptItem[] = []
    const seen = new Set<string>()
    let activeTurnId = ''
    for (const turnValue of turns) {
      const turn = record(turnValue)
      const turnId = boundedString(turn.id, 256)
      if (string(turn.status) === 'inProgress' && turnId) activeTurnId = turnId
      const items = Array.isArray(turn.items) ? turn.items : []
      for (const itemValue of items) {
        const item = record(itemValue)
        const transcriptItem = transcriptItemFromCodex(boundedString(item.id, 256), string(item.type), item)
        if (transcriptItem && !seen.has(transcriptItem.id)) {
          seen.add(transcriptItem.id)
          transcript.push(transcriptItem)
        }
      }
    }
    return { activeTurnId, items: transcript }
  } catch {
    return { activeTurnId: '', items: [] }
  }
}

export function codexTranscriptFromThread(rawJson: string): CodexTranscriptItem[] {
  return codexThreadStateFromThread(rawJson).items
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
  if (type === 'webSearch') {
    const completed = item.action !== null && item.action !== undefined
    return transcript(id, completed ? 'tool-output' : 'tool-call', `Web search: ${string(item.query)}`)
  }
  if (type === 'imageView') return transcript(id, 'tool-call', `Viewed image: ${string(item.path)}`)
  if (type === 'imageGeneration') {
    const failure = string(record(item.failure).message)
    const savedPath = string(item.savedPath)
    const revisedPrompt = string(item.revisedPrompt)
    const result = string(item.result)
    const status = string(item.status)
    const details = [
      status && `Image generation: ${status}`,
      revisedPrompt && `Prompt: ${revisedPrompt}`,
      result && `Result: ${result}`,
      savedPath && `Saved to ${savedPath}`,
      failure && `Failed: ${failure}`,
    ]
      .filter(Boolean)
      .join('\n')
    return transcript(id, status === 'inProgress' ? 'tool-call' : 'tool-output', details)
  }
  if (type === 'collabAgentToolCall') {
    const status = string(item.status)
    const tool = string(item.tool)
    if (status === 'completed' || status === 'failed') {
      const states = Object.entries(record(item.agentsStates))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([threadId, value]) => {
          const state = record(value)
          const agentStatus = string(state.status) || 'unknown'
          const message = string(state.message)
          return `${threadId}: ${agentStatus}${message ? ` — ${message}` : ''}`
        })
      const summary = `Agent collaboration${tool ? ` ${tool}` : ''}: ${status}`
      return transcript(id, 'tool-output', [summary, ...states].join('\n'))
    }
    const details = [tool, string(item.prompt)].filter(Boolean).join(': ')
    return transcript(id, 'tool-call', details && `Agent collaboration: ${details}`)
  }
  if (type === 'subAgentActivity') {
    const details = [string(item.agentPath), string(item.kind)].filter(Boolean).join(' · ')
    return transcript(id, 'tool-call', details && `Agent activity: ${details}`)
  }
  return null
}

function toolResultText(item: Record<string, unknown>) {
  const error = string(record(item.error).message)
  if (error) return error
  const contentItems = Array.isArray(item.contentItems) ? item.contentItems : []
  const dynamicText = contentItems.map(contentItemText).filter(Boolean).join('\n')
  if (dynamicText) return dynamicText
  const result = record(item.result)
  const content = Array.isArray(result.content) ? result.content : []
  return content.map(contentItemText).filter(Boolean).join('\n')
}

function contentItemText(value: unknown) {
  const part = record(value)
  const text = string(part.text)
  if (text) return text
  const type = string(part.type).toLowerCase()
  if (type.includes('image')) return '[Image output]'
  if (type.includes('audio')) return '[Audio output]'
  return ''
}

function transcript(id: string, kind: CodexTranscriptItem['kind'], text: string): CodexTranscriptItem | null {
  return text ? { id, kind, text: truncateUtf8(text, MAX_EVENT_TEXT_BYTES) } : null
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

function rateLimitWindow(label: string, value: unknown) {
  const window = record(value)
  const used = finiteNumber(window.usedPercent)
  if (used === null) return ''
  const duration = finiteNumber(window.windowDurationMins)
  return `${label}: ${Math.round(used)}% used${duration === null ? '' : ` / ${duration} min`}`
}

function appendBoundedText(previous: string, delta: string) {
  if (previous.endsWith(TRUNCATION_MARKER)) return previous
  return truncateUtf8(`${previous}${delta}`, MAX_EVENT_TEXT_BYTES)
}

function truncateUtf8(value: string, maximumBytes: number) {
  const encoded = new TextEncoder().encode(value)
  if (encoded.byteLength <= maximumBytes) return value
  const marker = new TextEncoder().encode(TRUNCATION_MARKER)
  let end = Math.max(0, maximumBytes - marker.byteLength)
  while (end > 0) {
    try {
      return `${new TextDecoder('utf-8', { fatal: true }).decode(encoded.subarray(0, end))}${TRUNCATION_MARKER}`
    } catch {
      end -= 1
    }
  }
  return TRUNCATION_MARKER.slice(0, maximumBytes)
}

function isDeltaEvent(event: TengriCodexEvent) {
  return event.method.toLowerCase().endsWith('delta')
}

function codexEventKey(event: TengriCodexEvent) {
  return `${event.sequence}:${event.method}:${event.threadId}:${event.turnId}:${event.itemId}:${event.approvalId}`
}
