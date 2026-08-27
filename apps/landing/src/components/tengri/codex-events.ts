import type { TengriCodexEvent, TengriCodexEventKind } from '@/lib/tengri/types'

const MAX_CODEX_EVENTS = 500
const MAX_EVENT_TEXT_BYTES = 512 << 10
const TRUNCATION_MARKER = '\n… output truncated …'
const DEFAULT_CODEX_APPROVAL_DECISIONS = ['approve-once', 'approve-session', 'deny'] as const
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

export type CodexApprovalDecision = (typeof DEFAULT_CODEX_APPROVAL_DECISIONS)[number]

export function appendCodexEvent(current: TengriCodexEvent[], event: TengriCodexEvent) {
  if (isRawReasoningDelta(event)) return current
  const key = codexEventKey(event)
  if (current.some((candidate) => codexEventKey(candidate) === key)) return current
  const eventText = commandOutputDeltaText(event)

  const planIndex = isAuthoritativePlanSnapshot(event)
    ? current.findIndex(
        (candidate) =>
          isAuthoritativePlanSnapshot(candidate) &&
          candidate.threadId === event.threadId &&
          candidate.turnId === event.turnId,
      )
    : -1

  if (planIndex >= 0) {
    const next = [...current]
    next[planIndex] = { ...event, text: truncateEventText(eventText) }
    return next
  }

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
      text: isDeltaEvent(event)
        ? appendBoundedText(previous.text, eventText)
        : truncateEventText(eventText || previous.text),
    }
    return next
  }

  return [...current.slice(-(MAX_CODEX_EVENTS - 1)), { ...event, text: truncateEventText(eventText) }]
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
      threadId: boundedIdentifier(value.threadId, 256),
      turnId: boundedIdentifier(value.turnId, 256),
      itemId: boundedIdentifier(value.itemId, 256),
      text: truncateEventText(string(value.text)),
      approvalId: boundedIdentifier(value.approvalId, 256),
      rawJson: boundedRawJson(value.rawJson),
    }
  } catch {
    return null
  }
}

export function codexEventDisplayText(event: TengriCodexEvent) {
  if (isRawReasoningDelta(event)) return ''
  const raw = parseRawEvent(event.rawJson)
  const params = record(raw.params)
  const item = record(params.item)

  if (event.kind === 'approval') return approvalDisplayText(params, event.text)
  if (event.kind === 'usage') return usageDisplayText(params) || event.text

  const eventText =
    event.kind === 'tool-output' && isCommandExecutionEvent(event, item)
      ? decodeMaybeBase64Text(event.text)
      : event.text
  if (eventText) return eventText
  if (event.kind === 'tool-call') return toolCallText(item)
  if (event.kind === 'tool-output') {
    return toolResultText(item) || commandStatusText(string(item.status), number(item.exitCode))
  }
  return ''
}

export function codexApprovalDecisions(event: TengriCodexEvent): CodexApprovalDecision[] {
  if (event.kind !== 'approval') return []
  const params = record(parseRawEvent(event.rawJson).params)
  const available = params.availableDecisions
  if (event.method.toLowerCase() !== 'item/commandexecution/requestapproval' || available == null) {
    return [...DEFAULT_CODEX_APPROVAL_DECISIONS]
  }
  if (!Array.isArray(available)) return []

  const decisions = new Set<CodexApprovalDecision>()
  for (const value of available) {
    if (value === 'accept') decisions.add('approve-once')
    if (value === 'acceptForSession') decisions.add('approve-session')
    if (value === 'decline' || value === 'cancel') decisions.add('deny')
  }
  return DEFAULT_CODEX_APPROVAL_DECISIONS.filter((decision) => decisions.has(decision))
}

export function codexEventMatchesThread(event: TengriCodexEvent, threadId: string) {
  if (event.kind === 'approval') return Boolean(threadId) && event.threadId === threadId
  return !event.threadId || event.threadId === threadId
}

export function codexEventShouldRender(
  event: TengriCodexEvent,
  threadId: string,
  restoredItemIds: ReadonlySet<string>,
) {
  if (!codexEventMatchesThread(event, threadId)) return false
  if (event.kind === 'approval') return true
  return !event.itemId || !restoredItemIds.has(event.itemId)
}

export function codexActiveTurnIdFromThread(rawJson: string) {
  try {
    const response = record(JSON.parse(rawJson))
    const thread = record(response.thread)
    const turns = Array.isArray(thread.turns) ? thread.turns : []
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = record(turns[index])
      if (string(turn.status) === 'inProgress') return boundedIdentifier(turn.id, 256)
    }
  } catch {
    // A malformed resume response cannot identify an active turn.
  }
  return ''
}

export function codexLoginCompletionError(event: TengriCodexEvent) {
  if (event.method.toLowerCase() !== 'account/login/completed') return ''
  const params = record(parseRawEvent(event.rawJson).params)
  if (params.success !== false) return ''
  const error = params.error
  if (typeof error === 'string') return error
  return string(record(error).message) || event.text || 'Codex device login failed. Start a new login.'
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
          if (transcript.length > MAX_CODEX_EVENTS) transcript.shift()
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
    return transcript(id, 'user-message', content.map(userInputText).filter(Boolean).join('\n'))
  }
  if (type === 'agentMessage') return transcript(id, 'assistant-text', string(item.text))
  if (type === 'plan') return transcript(id, 'plan', string(item.text))
  if (type === 'reasoning') {
    const summary = stringArray(item.summary).join('\n')
    const content = stringArray(item.content).join('\n')
    return transcript(id, 'reasoning-summary', summary || content)
  }
  if (type === 'commandExecution') {
    const output = decodeMaybeBase64Text(string(item.aggregatedOutput))
    if (output) return transcript(id, 'tool-output', output)
    const status = commandStatusText(string(item.status), number(item.exitCode))
    if (status) return transcript(id, 'tool-output', status)
    return transcript(id, 'tool-call', string(item.command))
  }
  if (type === 'fileChange') return transcript(id, 'file-diff', fileChangesText(item.changes))
  if (type === 'mcpToolCall' || type === 'dynamicToolCall') {
    const output = toolResultText(item)
    if (output) return transcript(id, 'tool-output', output)
    return transcript(id, 'tool-call', toolCallText(item))
  }
  if (type === 'collabAgentToolCall') {
    const status = string(item.status)
    return transcript(
      id,
      status === 'completed' || status === 'failed' ? 'tool-output' : 'tool-call',
      collaborationText(item),
    )
  }
  if (type === 'subAgentActivity') {
    return transcript(
      id,
      'tool-call',
      ['Sub-agent', string(item.kind), string(item.agentPath) || string(item.agentThreadId)].filter(Boolean).join(': '),
    )
  }
  if (type === 'webSearch') {
    return transcript(id, item.action ? 'tool-output' : 'tool-call', `Web search: ${string(item.query) || 'request'}`)
  }
  if (type === 'imageView') return transcript(id, 'tool-call', `View image: ${string(item.path)}`)
  if (type === 'imageGeneration') {
    const result = string(item.savedPath) || string(item.result)
    return transcript(
      id,
      result ? 'tool-output' : 'tool-call',
      result || string(item.revisedPrompt) || 'Generate image',
    )
  }
  return null
}

function userInputText(value: unknown) {
  const input = record(value)
  const type = string(input.type)
  if (type === 'text') return string(input.text)
  if (type === 'image') return '[Image]'
  if (type === 'localImage') return `[Local image: ${string(input.path) || 'attached'}]`
  if (type === 'skill') {
    return `[Skill: ${[string(input.name), string(input.path)].filter(Boolean).join(' — ') || 'attached'}]`
  }
  if (type === 'mention') {
    const name = string(input.name)
    const path = string(input.path)
    return `[Mention: ${[name && `@${name}`, path].filter(Boolean).join(' — ') || 'attached'}]`
  }
  return ''
}

function approvalDisplayText(params: Record<string, unknown>, eventText: string) {
  const command = commandText(params.command)
  const reason = string(params.reason) || (!command ? eventText : '')
  const cwd = string(params.cwd)
  const grantRoot = string(params.grantRoot)
  const fileChanges = approvalFileChangesText(params.fileChanges)
  const networkApproval = networkApprovalText(params.networkApprovalContext, params.proposedNetworkPolicyAmendments)
  const permissions = [
    permissionProfileText('Requested permissions', params.permissions),
    permissionProfileText('Additional permissions', params.additionalPermissions),
  ].filter(Boolean)
  return truncateEventText(
    [
      reason,
      command && `Command: ${command}`,
      cwd && `Working directory: ${cwd}`,
      networkApproval,
      grantRoot && `Requested write root: ${grantRoot}`,
      fileChanges,
      ...permissions,
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

function networkApprovalText(contextValue: unknown, amendmentsValue: unknown) {
  const context = record(contextValue)
  const host = string(context.host)
  const protocol = string(context.protocol)
  const amendments = Array.isArray(amendmentsValue) ? amendmentsValue : []
  const lines: string[] = []

  if (host) lines.push(`Network target: ${host}${protocol ? ` (${protocol})` : ''}`)
  const amendmentLines = amendments
    .map((value) => {
      const amendment = record(value)
      const amendmentHost = string(amendment.host)
      const action = string(amendment.action)
      return amendmentHost ? `- ${action || 'change'} ${amendmentHost}` : ''
    })
    .filter(Boolean)
  if (amendmentLines.length > 0) lines.push('Proposed network policy:', ...amendmentLines)

  return lines.join('\n')
}

function approvalFileChangesText(value: unknown) {
  const changes = record(value)
  const paths = Object.keys(changes).sort()
  if (paths.length === 0) return ''
  return [
    'Files:',
    ...paths.map((path) => {
      const changeType = string(record(changes[path]).type)
      return `- ${path}${changeType ? ` (${changeType})` : ''}`
    }),
  ].join('\n')
}

function permissionProfileText(label: string, value: unknown) {
  const profile = record(value)
  if (Object.keys(profile).length === 0) return ''
  const network = record(profile.network)
  const fileSystem = record(profile.fileSystem)
  const lines: string[] = []
  if (typeof network.enabled === 'boolean') lines.push(`Network: ${network.enabled ? 'enabled' : 'disabled'}`)
  for (const [access, paths] of [
    ['Read', fileSystem.read],
    ['Write', fileSystem.write],
  ] as const) {
    if (!Array.isArray(paths) || paths.length === 0) continue
    lines.push(`${access} access:`, ...paths.map((path) => `- ${string(path)}`).filter((path) => path !== '- '))
  }
  const entries = Array.isArray(fileSystem.entries) ? fileSystem.entries : []
  for (const entryValue of entries) {
    const entry = record(entryValue)
    const path = permissionPath(entry.path)
    if (path) lines.push(`- ${path} (${string(entry.access) || 'requested'})`)
  }
  return lines.length > 0 ? `${label}:\n${lines.join('\n')}` : ''
}

function permissionPath(value: unknown) {
  if (typeof value === 'string') return value
  const path = record(value)
  if (string(path.path)) return string(path.path)
  if (string(path.pattern)) return string(path.pattern)
  if (typeof path.value === 'string') return path.value
  return ''
}

function usageDisplayText(params: Record<string, unknown>) {
  const rateLimits = record(params.rateLimits)
  if (Object.keys(rateLimits).length > 0) {
    const windows = [
      rateLimitWindowText('Primary', rateLimits.primary),
      rateLimitWindowText('Secondary', rateLimits.secondary),
    ].filter(Boolean)
    const credits = record(rateLimits.credits)
    if (credits.balance !== undefined && credits.balance !== null) windows.push(`Credits: ${string(credits.balance)}`)
    const reached = string(rateLimits.rateLimitReachedType)
    if (reached) windows.push(`Limit state: ${reached.replaceAll('_', ' ')}`)
    if (windows.length > 0) return windows.join(' · ')
  }

  const tokenUsage = record(params.tokenUsage || params.usage)
  const total = record(tokenUsage.total)
  const usage = Object.keys(total).length > 0 ? total : tokenUsage
  const input = nonNegativeNumber(usage.inputTokens ?? usage.input_tokens)
  const output = nonNegativeNumber(usage.outputTokens ?? usage.output_tokens)
  if (input !== null || output !== null) return `Tokens: ${input ?? 0} input · ${output ?? 0} output`
  return ''
}

function rateLimitWindowText(label: string, value: unknown) {
  const window = record(value)
  const used = nonNegativeNumber(window.usedPercent)
  if (used === null) return ''
  const duration = nonNegativeNumber(window.windowDurationMins)
  const durationLabel = duration === null ? label : `${formatDuration(duration)} window`
  return `${durationLabel}: ${Math.min(100, used)}% used`
}

function formatDuration(minutes: number) {
  if (minutes >= 1_440 && minutes % 1_440 === 0) return `${minutes / 1_440}d`
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

function toolCallText(item: Record<string, unknown>) {
  const type = string(item.type)
  if (type === 'webSearch') return `Web search: ${string(item.query) || 'request'}`
  if (type === 'subAgentActivity') {
    return ['Sub-agent', string(item.kind), string(item.agentPath) || string(item.agentThreadId)]
      .filter(Boolean)
      .join(': ')
  }
  if (type === 'collabAgentToolCall') return collaborationText(item)
  if (type === 'imageView') return `View image: ${string(item.path)}`
  if (type === 'imageGeneration') return string(item.revisedPrompt) || 'Generate image'
  const server = string(item.server)
  const namespace = string(item.namespace)
  const tool = string(item.tool)
  return [server || namespace, tool].filter(Boolean).join('/') || string(item.command)
}

function collaborationText(item: Record<string, unknown>) {
  const tool = string(item.tool)
  const status = string(item.status)
  const prompt = string(item.prompt)
  const receivers = stringArray(item.receiverThreadIds)
  const states = Object.entries(record(item.agentsStates))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([threadId, stateValue]) => {
      const state = record(stateValue)
      const agentStatus = string(state.status) || 'unknown'
      const message = string(state.message)
      return `${threadId}: ${agentStatus}${message ? ` — ${message}` : ''}`
    })
  return [
    ['Agent collaboration', tool, status].filter(Boolean).join(': '),
    prompt && `Prompt: ${prompt}`,
    receivers.length > 0 && `Agents: ${receivers.join(', ')}`,
    ...states,
  ]
    .filter(Boolean)
    .join('\n')
}

function fileChangesText(value: unknown) {
  const changes = Array.isArray(value) ? value : []
  return changes
    .map((change) => {
      const item = record(change)
      return string(item.diff) || string(item.path)
    })
    .filter(Boolean)
    .join('\n')
}

function toolResultText(item: Record<string, unknown>) {
  const error = string(record(item.error).message)
  if (error) return error

  const dynamic = contentItemsText(item.contentItems)
  const resultValue = item.result
  const result = record(resultValue)
  const content = contentItemsText(result.content)
  const structured = prettyJson(result.structuredContent ?? result.structured_content)
  const rawResult = typeof resultValue === 'string' ? resultValue : ''
  return [dynamic, content, structured, rawResult].filter(Boolean).join('\n')
}

function contentItemsText(value: unknown) {
  const items = Array.isArray(value) ? value : []
  return items
    .map((partValue) => {
      if (typeof partValue === 'string') return partValue
      const part = record(partValue)
      const text = string(part.text)
      if (text) return text
      const type = string(part.type)
      if (type.toLowerCase().includes('image')) return '[Image output]'
      if (type.toLowerCase().includes('audio')) return '[Audio output]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function commandStatusText(status: string, exitCode: number | null) {
  if (!['completed', 'failed', 'declined'].includes(status)) return ''
  const label =
    status === 'completed' ? 'Command completed' : status === 'failed' ? 'Command failed' : 'Command declined'
  return exitCode === null ? label : `${label} (exit ${exitCode})`
}

function commandText(value: unknown) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => shellDisplayArgument(string(part)))
    .filter(Boolean)
    .join(' ')
}

function shellDisplayArgument(value: string) {
  if (!value) return "''"
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}

function decodeMaybeBase64Text(raw: string) {
  if (raw.length < 4 || raw.length % 4 === 1) return raw
  const single = decodeBase64Token(raw)
  if (single !== null) return single
  if (!raw.includes('=')) return raw

  const firstNonBase64 = raw.search(/[^A-Za-z0-9+/=]/)
  const base64Prefix = firstNonBase64 === -1 ? raw : raw.slice(0, firstNonBase64)
  const suffix = firstNonBase64 === -1 ? '' : raw.slice(firstNonBase64)
  const tokens: string[] = []
  let cursor = 0
  for (let index = 0; index < base64Prefix.length; index += 1) {
    if (base64Prefix[index] !== '=') continue
    let end = index
    while (base64Prefix[end] === '=') end += 1
    const token = base64Prefix.slice(cursor, end)
    if (token) tokens.push(token)
    cursor = end
    index = end - 1
  }
  if (tokens.length === 0) return raw

  const decoded: string[] = []
  for (const token of tokens) {
    const value = decodeBase64Token(token, true)
    if (value === null) return raw
    decoded.push(value)
  }
  const remainder = base64Prefix.slice(cursor)
  const decodedRemainder = remainder ? decodeBase64Token(remainder, true) : null
  return `${decoded.join('')}${decodedRemainder ?? remainder}${suffix}`
}

function decodeBase64Token(token: string, allowShort = false) {
  if ((!allowShort && token.length < 8) || token.length < 2) return null
  if (token.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(token)) return null
  try {
    const padded = token.length % 4 === 0 ? token : `${token}${'='.repeat(4 - (token.length % 4))}`
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const encoded = btoa(binary).replace(/=+$/g, '')
    if (encoded !== token.replace(/=+$/g, '')) return null
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return mostlyPrintable(decoded) ? decoded : sanitizeTerminalText(decoded)
  } catch {
    return null
  }
}

function mostlyPrintable(value: string) {
  if (!value || value.includes('\uFFFD')) return false
  let printable = 0
  let nonWhitespace = 0
  let total = 0
  for (const character of value) {
    total += 1
    const code = character.codePointAt(0) || 0
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) printable += 1
    if (!/\s/.test(character)) nonWhitespace += 1
  }
  return nonWhitespace > 0 && printable / total >= 0.9
}

function sanitizeTerminalText(value: string) {
  const withoutAnsi: string[] = []
  let index = 0
  while (index < value.length) {
    const code = value.charCodeAt(index)
    if (code !== 27) {
      withoutAnsi.push(value[index]!)
      index += 1
      continue
    }

    const next = value[index + 1]
    if (next === '[') {
      index += 2
      while (index < value.length) {
        const current = value.charCodeAt(index)
        index += 1
        if (current >= 0x40 && current <= 0x7e) break
      }
      continue
    }
    if (next === ']') {
      index += 2
      while (index < value.length) {
        const current = value.charCodeAt(index)
        if (current === 7) {
          index += 1
          break
        }
        if (current === 27 && value[index + 1] === '\\') {
          index += 2
          break
        }
        index += 1
      }
      continue
    }
    index += 1
  }

  const filtered: string[] = []
  let sawNonWhitespace = false
  let sawNonSpinner = false
  for (const character of withoutAnsi) {
    const code = character.charCodeAt(0)
    if (code === 9 || code === 10 || code === 13) {
      filtered.push(character)
      continue
    }
    if (code < 32 || code === 127) continue
    filtered.push(character)
    if (!character.trim()) continue
    sawNonWhitespace = true
    if (code < 0x2800 || code > 0x28ff) sawNonSpinner = true
  }
  return sawNonWhitespace && sawNonSpinner ? filtered.join('') : ''
}

function transcript(id: string, kind: CodexTranscriptItem['kind'], text: string): CodexTranscriptItem | null {
  const bounded = truncateEventText(text)
  return bounded ? { id, kind, text: bounded } : null
}

function parseRawEvent(rawJson: string) {
  try {
    return record(JSON.parse(rawJson))
  } catch {
    return {}
  }
}

function prettyJson(value: unknown) {
  if (value === undefined || value === null) return ''
  try {
    return truncateEventText(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  } catch {
    return ''
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

function boundedIdentifier(value: unknown, maximumBytes: number) {
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > maximumBytes) return ''
  return value
}

function boundedRawJson(value: unknown) {
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > MAX_EVENT_TEXT_BYTES) return ''
  return value
}

function appendBoundedText(current: string, delta: string) {
  if (current.endsWith(TRUNCATION_MARKER)) return current
  return truncateEventText(`${current}${delta}`)
}

function commandOutputDeltaText(event: TengriCodexEvent) {
  const method = event.method.toLowerCase()
  return event.kind === 'tool-output' && method.includes('commandexecution') && method.endsWith('delta')
    ? decodeMaybeBase64Text(event.text)
    : event.text
}

function isCommandExecutionEvent(event: TengriCodexEvent, item: Record<string, unknown>) {
  return event.method.toLowerCase().includes('commandexecution') || string(item.type) === 'commandExecution'
}

function truncateEventText(value: string) {
  const encoder = new TextEncoder()
  const encoded = encoder.encode(value)
  if (encoded.byteLength <= MAX_EVENT_TEXT_BYTES) return value
  const marker = encoder.encode(TRUNCATION_MARKER)
  let end = Math.max(0, MAX_EVENT_TEXT_BYTES - marker.byteLength)
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1
  return `${new TextDecoder().decode(encoded.subarray(0, end))}${TRUNCATION_MARKER}`
}

function nonNegativeNumber(value: unknown) {
  if (typeof value !== 'number') return null
  const result = value
  return Number.isFinite(result) && result >= 0 ? result : null
}

function number(value: unknown) {
  if (typeof value !== 'number') return null
  const result = value
  return Number.isFinite(result) ? result : null
}

function isDeltaEvent(event: TengriCodexEvent) {
  return event.method.toLowerCase().endsWith('delta')
}

function isAuthoritativePlanSnapshot(event: TengriCodexEvent) {
  return event.kind === 'plan' && Boolean(event.turnId) && event.method.toLowerCase() === 'turn/plan/updated'
}

function isRawReasoningDelta(event: TengriCodexEvent) {
  return event.method.toLowerCase() === 'item/reasoning/textdelta'
}

function codexEventKey(event: TengriCodexEvent) {
  return `${event.sequence}:${event.method}:${event.threadId}:${event.turnId}:${event.itemId}:${event.approvalId}`
}
