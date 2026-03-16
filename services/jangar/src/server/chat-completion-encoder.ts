import { Context } from 'effect'
import * as Either from 'effect/Either'
import {
  recordOpenWebUIDetailLink,
  recordOpenWebUIDetailPreviewTruncation,
  recordOpenWebUIDetailStagedBytes,
} from './metrics'
import { safeJsonStringify, stripTerminalControl } from './chat-text'
import { decodeToolEvent, type ToolEvent } from './chat-tool-event'
import type { ToolRenderer } from './chat-tool-event-renderer'
import { OPENWEBUI_RENDER_URL_TTL_SECONDS, createMessageBindingHash } from './openwebui-render-signing'
import { type OpenWebUiRenderBlob, createOpenWebUiRenderBlob } from './openwebui-render-store'

const TOOL_EVENT_DECODE_FAILED_TAG = '[jangar][tool-event][decode-failed]'

const RENDER_EVENT_VERSION = 'v1' as const
const OPENWEBUI_MAX_INLINE_ACTIVITY_BYTES = 4 * 1024
const OPENWEBUI_MAX_TOTAL_ACTIVITY_BYTES = 24 * 1024
const OPENWEBUI_MAX_INLINE_STRUCTURED_PAYLOAD_BYTES = 8 * 1024

type OpenWebUIRenderRef = {
  id: string
  kind: string
  href: string
  expiresAt: string
}

type JangarRenderLane = 'message' | 'reasoning' | 'plan' | 'rate_limits' | 'tool' | 'usage' | 'error'
type JangarRenderOp = 'append_text' | 'merge' | 'replace' | 'complete'

type JangarRenderEvent = {
  version: typeof RENDER_EVENT_VERSION
  seq: number
  logicalId: string
  revision: number
  lane: JangarRenderLane
  op: JangarRenderOp
  payload: Record<string, unknown>
  preview?: {
    title?: string
    subtitle?: string
    badge?: string
  }
  renderRef?: OpenWebUIRenderRef
}

type JangarRenderConfig = {
  detailLinks?: {
    enabled: boolean
    renderUrlTtlSeconds?: number
    createRenderRef?: (args: {
      renderId: string
      kind: string
      messageBindingHash: string
      expiresAt: string
    }) => OpenWebUIRenderRef | null
  }
  jangarEvent?: {
    enabled: boolean
    mode: 'rich-ui-v1'
  }
}

type JangarEventState = {
  revision: number
}

type JangarRenderMeta = {
  title?: string
  subtitle?: string
  badge?: string
}

type ThreadMeta = {
  threadId?: string | null
  turnNumber?: number | null
  chatId?: string | null
}

type PlanStep = {
  step: string
  status: 'pending' | 'in_progress' | 'completed' | 'inProgress'
}

type RateLimitWindow = {
  usedPercent?: number
  windowDurationMins?: number | null
  resetsAt?: number | null
}

type CreditsSnapshot = {
  hasCredits?: boolean
  unlimited?: boolean
  balance?: string | null
}

type RateLimitSnapshot = {
  primary?: RateLimitWindow | null
  secondary?: RateLimitWindow | null
  credits?: CreditsSnapshot | null
  planType?: string | null
  plan_type?: string | null
}

const sanitizePlanText = (value: string) => value.replaceAll('\n', ' ').trim()

const toPlanMarkdown = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.plan)) return null

  const explanation = typeof record.explanation === 'string' ? sanitizePlanText(record.explanation) : null
  const steps: string[] = []

  for (const entry of record.plan) {
    if (!entry || typeof entry !== 'object') continue
    const step = entry as Partial<PlanStep> & Record<string, unknown>
    if (typeof step.step !== 'string' || step.step.trim().length === 0) continue
    const label = sanitizePlanText(step.step)
    const status = step.status

    if (status === 'completed') {
      steps.push(`- [x] ${label}`)
      continue
    }

    if (status === 'in_progress' || status === 'inProgress') {
      steps.push(`- [ ] ${label} (in progress)`)
      continue
    }

    steps.push(`- [ ] ${label}`)
  }

  if (!steps.length) return null

  const lines = ['**Plan**']
  if (explanation && explanation.length > 0) lines.push(explanation)
  lines.push(...steps)
  return lines.join('\n')
}

const formatPercent = (value: number) => {
  if (!Number.isFinite(value)) return 'unknown'
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded}%`
}

const clampPercent = (value: number) => Math.max(0, Math.min(100, value))

const formatResetTime = (value: number) => {
  if (!Number.isFinite(value)) return null
  const ms = value < 1_000_000_000_000 ? value * 1000 : value
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return null
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZoneName: 'short',
    }).format(date)
  } catch {
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date)
    } catch {
      return date.toLocaleString()
    }
  }
}

const formatDurationHours = (minutes: number) => {
  if (!Number.isFinite(minutes)) return 'window unknown'
  const total = Math.max(0, Math.round(minutes))
  const hours = Math.floor(total / 60)
  const mins = total % 60
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const leftoverHours = hours % 24
    if (leftoverHours === 0 && mins === 0) return `${days}d`
    if (mins === 0) return `${days}d ${leftoverHours}h`
    return `${days}d ${leftoverHours}h ${mins}m`
  }
  if (hours > 0 && mins > 0) return `${hours}h ${mins}m`
  if (hours > 0) return `${hours}h`
  return `${mins}m`
}

const toRateLimitMarkdown = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') return null
  const record = value as RateLimitSnapshot
  const lines: string[] = ['> **Rate limits**']

  const planType =
    typeof record.planType === 'string'
      ? record.planType
      : typeof record.plan_type === 'string'
        ? record.plan_type
        : null
  if (planType) lines.push(`> Plan: ${planType}`)

  const renderWindow = (label: string, window?: RateLimitWindow | null) => {
    if (!window) return
    const used = window.usedPercent
    const usage = typeof used === 'number' ? `${formatPercent(clampPercent(100 - used))} left` : 'usage unknown'
    const duration =
      typeof window.windowDurationMins === 'number'
        ? `${formatDurationHours(window.windowDurationMins)} window`
        : 'window unknown'
    const reset = typeof window.resetsAt === 'number' ? formatResetTime(window.resetsAt) : null
    const parts = [usage, duration]
    if (reset) parts.push(`resets ${reset}`)
    lines.push(`> ${label}: ${parts.join(' · ')}`)
  }

  renderWindow('Primary', record.primary)
  renderWindow('Secondary', record.secondary)

  if (record.credits) {
    const credits = record.credits
    const parts: string[] = []
    if (credits.unlimited) {
      parts.push('unlimited')
    } else if (credits.hasCredits) {
      parts.push('has credits')
    } else {
      parts.push('no credits')
    }
    if (credits.balance) parts.push(`balance ${credits.balance}`)
    lines.push(`> Credits: ${parts.join(' · ')}`)
  }

  return lines.length > 1 ? lines.join('\n') : null
}

const pickNumber = (value: unknown, keys: string[]): number | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of keys) {
    const candidate = record[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate
    }
  }
  return undefined
}

const normalizeUsage = (raw: unknown) => {
  const usage = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const totals = usage.total && typeof usage.total === 'object' ? (usage.total as Record<string, unknown>) : null
  const last = usage.last && typeof usage.last === 'object' ? (usage.last as Record<string, unknown>) : null
  const source =
    (last && Object.keys(last).length ? last : null) ?? (totals && Object.keys(totals).length ? totals : null) ?? usage

  const promptTokens = pickNumber(source, ['input_tokens', 'prompt_tokens', 'inputTokens', 'promptTokens']) ?? 0
  const cachedTokens =
    pickNumber(source, ['cached_input_tokens', 'cached_prompt_tokens', 'cachedInputTokens', 'cachedPromptTokens']) ?? 0
  const completionTokens =
    pickNumber(source, ['output_tokens', 'completion_tokens', 'outputTokens', 'completionTokens']) ?? 0
  const reasoningTokens =
    pickNumber(source, ['reasoning_output_tokens', 'reasoning_tokens', 'reasoningOutputTokens', 'reasoningTokens']) ?? 0
  const totalTokens =
    pickNumber(source, ['total_tokens', 'totalTokens', 'token_count', 'tokenCount']) ??
    promptTokens + completionTokens + reasoningTokens

  const normalized: Record<string, unknown> = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens + reasoningTokens,
    total_tokens: totalTokens,
  }

  if (cachedTokens > 0) {
    normalized.prompt_tokens_details = { cached_tokens: cachedTokens }
  }
  if (reasoningTokens > 0) {
    normalized.completion_tokens_details = { reasoning_tokens: reasoningTokens }
  }

  return normalized
}

const utf8Encoder = new TextEncoder()

const utf8ByteLength = (value: string) => utf8Encoder.encode(value).length

const truncatePreview = (value: string, max = OPENWEBUI_MAX_INLINE_STRUCTURED_PAYLOAD_BYTES) => {
  if (utf8ByteLength(value) <= max) return value

  let truncated = ''
  for (const character of value) {
    if (utf8ByteLength(`${truncated}${character}…`) > max) break
    truncated += character
  }
  return `${truncated}…`
}

const clampTextForPreview = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return truncatePreview(value)
}

const closeUnbalancedCodeFence = (value: string) =>
  (value.match(/```/g) ?? []).length % 2 === 0 ? value : `${value}\n\`\`\`\n`

const fitMarkdownPreviewToBytes = (value: string, maxBytes: number) => {
  if (maxBytes <= 0) return { content: '', truncated: value.length > 0 }
  if (utf8ByteLength(value) <= maxBytes) return { content: value, truncated: false }

  const suffix = '\n…\n'
  const budget = Math.max(0, maxBytes - utf8ByteLength(suffix))
  let truncated = ''

  for (const character of value) {
    if (utf8ByteLength(`${truncated}${character}`) > budget) break
    truncated += character
  }

  const content = closeUnbalancedCodeFence(`${truncated.trimEnd()}${suffix}`)
  return { content, truncated: true }
}

const toJangarMeta = (state: string | undefined): string | undefined => {
  if (!state) return undefined
  const trimmed = state.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const toRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const toString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const normalizeDeltaText = (delta: unknown): string => {
  if (typeof delta === 'string') return delta

  if (Array.isArray(delta)) {
    return delta
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          const obj = part as Record<string, unknown>
          if (typeof obj.text === 'string') return obj.text
          if (typeof obj.content === 'string') return obj.content
        }
        return String(part)
      })
      .join('')
  }

  if (delta && typeof delta === 'object') {
    const obj = delta as Record<string, unknown>
    if (typeof obj.text === 'string') return obj.text
    if (typeof obj.content === 'string') return obj.content
  }

  return delta == null ? '' : String(delta)
}

type ToolRenderState = {
  kind: string
  logicalId: string
  title?: string
  status?: string
  reasoningState: ReasoningDetailsState
  openWebUiOutput: string
  openWebUiSummaryKey?: string
  openWebUiSummaryEmitted?: boolean
}

type OpenWebUIDetailState = {
  ref: OpenWebUIRenderRef
  linkEmitted: boolean
  pendingLinkMarkdown?: string
  pendingLinkToken?: string
}

type JangarEventRenderState = {
  ref: OpenWebUIRenderRef
}

type ToolSummaryBase = {
  title?: string
  status?: string
  detail?: string
}

type CommandToolSummary = ToolSummaryBase & {
  kind: 'command'
  exitCode?: unknown
  duration?: unknown
  outputPreview?: string
}

type FileToolSummary = ToolSummaryBase & {
  kind: 'file'
  changed: ReturnType<typeof summarizeFileChanges>
  changedFileCount?: unknown
  patchSummary?: unknown
}

type McpToolSummary = ToolSummaryBase & {
  kind: 'mcp'
  argumentsPreview?: string
  resultPreview?: string
  errorPreview?: string
}

type WebSearchToolSummary = ToolSummaryBase & {
  kind: 'webSearch'
  query?: string
}

type DynamicToolSummary = ToolSummaryBase & {
  kind: 'dynamicTool'
  tool?: string
  arguments?: unknown
  result?: unknown
  success?: boolean
}

type ImageGenerationToolSummary = ToolSummaryBase & {
  kind: 'imageGeneration'
  prompt?: string
  imageUrl?: string
}

type GenericToolSummary = ToolSummaryBase & {
  kind: 'tool'
}

type ToolSummary =
  | CommandToolSummary
  | FileToolSummary
  | McpToolSummary
  | WebSearchToolSummary
  | DynamicToolSummary
  | ImageGenerationToolSummary
  | GenericToolSummary

const toToolLogicalId = (kind: string, toolId: string) => `tool:${kind}-${toolId}`

const summarizePlan = (record: unknown): string | null => {
  if (!record || typeof record !== 'object') return null
  const value = record as Record<string, unknown>
  return toPlanMarkdown(value)
}

const summarizeRateLimits = (record: unknown): string | null => {
  if (!record || typeof record !== 'object') return null
  const value = record as Record<string, unknown>
  return toRateLimitMarkdown(value.rateLimits)
}

const summarizeFileChanges = (event: ToolEvent) => {
  const rawChanges = Array.isArray(event.changes) ? event.changes : []
  const changedPaths: string[] = []
  const compactDiffs: string[] = []

  for (const change of rawChanges) {
    if (!change || typeof change !== 'object') continue
    const path = toJangarMeta((change as Record<string, unknown>).path as string | undefined) ?? 'unknown-file'
    const diff = toString((change as Record<string, unknown>).diff) ?? ''
    changedPaths.push(path)

    const lines = diff.split(/\r?\n/).filter(Boolean)
    if (!lines.length) continue
    compactDiffs.push(...lines.slice(0, 3))
  }

  return {
    changedPaths: changedPaths.slice(0, 16),
    compactDiff: compactDiffs.length > 0 ? truncatePreview(compactDiffs.join('\n')) : undefined,
    changedFileCount: changedPaths.length,
  }
}

const parseToolMcpSummary = (event: ToolEvent): Omit<McpToolSummary, 'kind'> => {
  const detail = toString(event.detail)
  const result =
    event.data && typeof event.data === 'object' && toRecord(event.data.result) ? event.data.result : undefined
  const args =
    event.data && typeof event.data === 'object' && 'arguments' in event.data ? event.data.arguments : undefined
  const error = event.data && typeof event.data === 'object' && 'error' in event.data ? event.data.error : undefined

  return {
    title: toJangarMeta(event.title),
    status: toJangarMeta(event.status),
    detail: detail ?? undefined,
    argumentsPreview: clampTextForPreview(args != null ? safeJsonStringify(args) : undefined),
    resultPreview: clampTextForPreview(result != null ? safeJsonStringify(result) : undefined),
    errorPreview: clampTextForPreview(error != null ? safeJsonStringify(error) : undefined),
  }
}

const parseToolImageGenerationSummary = (event: ToolEvent): Omit<ImageGenerationToolSummary, 'kind'> => {
  const data = event.data
  if (!data) return { title: toJangarMeta(event.title), status: toJangarMeta(event.status) }
  const prompt = toString(data.prompt) ?? toString(data.userPrompt)
  const url = toString(data.imageUrl) ?? toString(data.url) ?? toString(data.result)
  return {
    title: toJangarMeta(event.title),
    status: toJangarMeta(event.status),
    prompt: clampTextForPreview(prompt),
    imageUrl: url,
  }
}

const sanitizeReasoningText = (text: string) => text.replace(/\*{4,}/g, '\n')

type ReasoningDetailsState = {
  carry: string
  insideDetails: boolean
  insideSummary: boolean
}

const createReasoningDetailsState = (): ReasoningDetailsState => ({
  carry: '',
  insideDetails: false,
  insideSummary: false,
})

const stripReasoningDetailsMarkup = (input: string, state: ReasoningDetailsState): string => {
  if (!input) return input

  const openDetailsPattern = /^<details\b[^>]*\btype\s*=\s*["']reasoning["'][^>]*>/i
  const openSummaryPattern = /^<summary\b[^>]*>/i
  const closeSummaryPattern = /^<\/summary\s*>/i
  const closeDetailsPattern = /^<\/details\s*>/i

  const text = state.carry ? `${state.carry}${input}` : input
  state.carry = ''

  let output = ''
  let index = 0

  while (index < text.length) {
    const tagStart = text.indexOf('<', index)
    if (tagStart === -1) {
      if (!state.insideSummary) {
        output += text.slice(index)
      }
      return output
    }

    if (!state.insideSummary) {
      output += text.slice(index, tagStart)
    }

    const tagEnd = text.indexOf('>', tagStart)
    if (tagEnd === -1) {
      state.carry = text.slice(tagStart)
      return output
    }

    const tag = text.slice(tagStart, tagEnd + 1)

    if (openDetailsPattern.test(tag)) {
      state.insideDetails = true
      index = tagEnd + 1
      continue
    }

    if (state.insideDetails && openSummaryPattern.test(tag)) {
      state.insideSummary = true
      index = tagEnd + 1
      continue
    }

    if (state.insideSummary && closeSummaryPattern.test(tag)) {
      state.insideSummary = false
      index = tagEnd + 1
      continue
    }

    if (state.insideDetails && closeDetailsPattern.test(tag)) {
      state.insideDetails = false
      state.insideSummary = false
      index = tagEnd + 1
      continue
    }

    if (!state.insideSummary) {
      output += tag
    }
    index = tagEnd + 1
  }

  return output
}

const isToolTerminalStatus = (status?: string) =>
  status === 'completed' || status === 'failed' || status === 'error' || status === 'timeout' || status === 'cancelled'

const stripToolText = (value: string | undefined, state: ReasoningDetailsState) => {
  if (!value) return undefined
  const filtered = stripReasoningDetailsMarkup(value, state)
  const normalized = stripTerminalControl(filtered)
  return normalized.length > 0 ? normalized : undefined
}

const toolPreviewText = (value: unknown) => clampTextForPreview(typeof value === 'string' ? value : undefined)

const summarizeToolCommand = (event: ToolEvent, reasoningState: ReasoningDetailsState): CommandToolSummary => {
  const data = toRecord(event.data)
  const outputPreview = toolPreviewText(stripToolText(event.delta, reasoningState))

  const exitCode = data?.exitCode ?? data?.exit_code
  const duration = data?.duration ?? data?.durationMs ?? data?.duration_ms

  return {
    kind: 'command',
    title: toJangarMeta(event.title),
    status: toJangarMeta(event.status),
    detail: toJangarMeta(event.detail),
    exitCode,
    duration,
    outputPreview,
  }
}

const summarizeToolFile = (event: ToolEvent): FileToolSummary => {
  const data = toRecord(event.data)
  const changed = summarizeFileChanges(event)
  return {
    kind: 'file',
    title: toJangarMeta(event.title),
    status: toJangarMeta(event.status),
    detail: toJangarMeta(event.detail),
    changed,
    changedFileCount: data?.changedFileCount,
    patchSummary: data?.patchSummary ?? undefined,
  }
}

const parseToolWebSearchSummary = (event: ToolEvent): WebSearchToolSummary => ({
  kind: 'webSearch',
  title: toJangarMeta(event.title),
  status: toJangarMeta(event.status),
  detail: toJangarMeta(event.detail),
  query: toString(toRecord(event.data)?.query) ?? toJangarMeta(event.detail),
})

const parseToolDynamicSummary = (event: ToolEvent): DynamicToolSummary => ({
  kind: 'dynamicTool',
  title: toJangarMeta(event.title),
  status: toJangarMeta(event.status),
  detail: toString(event.detail),
  tool: toJangarMeta(toRecord(event.data)?.tool as string | undefined),
  arguments: toRecord(event.data)?.arguments,
  result: toRecord(event.data)?.result,
  success: (toRecord(event.data)?.success as boolean | undefined) ?? undefined,
})

const parseToolSummary = (event: ToolEvent, reasoningState: ReasoningDetailsState): ToolSummary => {
  const kind = event.toolKind
  switch (kind) {
    case 'command': {
      return summarizeToolCommand(event, reasoningState)
    }
    case 'file': {
      return summarizeToolFile(event)
    }
    case 'mcp': {
      return { kind: 'mcp', ...parseToolMcpSummary(event) }
    }
    case 'webSearch': {
      return parseToolWebSearchSummary(event)
    }
    case 'dynamicTool': {
      return parseToolDynamicSummary(event)
    }
    case 'imageGeneration': {
      return { kind: 'imageGeneration', ...parseToolImageGenerationSummary(event) }
    }
    default:
      return {
        kind: 'tool',
        title: toJangarMeta(event.title),
        status: toJangarMeta(event.status),
        detail: toJangarMeta(event.detail),
      }
  }
}

const stripShellCommandPrefix = (value: string) => {
  const trimmed = value.trim()
  const match = trimmed.match(/^(?:\/(?:usr\/)?bin\/(?:ba|z)sh|(?:ba|z)sh)\s+-lc\s+([\s\S]+)$/u)
  if (!match) return value
  let command = match[1]?.trim() ?? ''
  if (
    command.length >= 2 &&
    ((command.startsWith("'") && command.endsWith("'")) || (command.startsWith('"') && command.endsWith('"')))
  ) {
    const quote = command[0]
    command = command.slice(1, -1)
    if (quote === '"') {
      command = command.replace(/\\"/g, '"')
    } else if (quote === "'") {
      command = command.replace(/\\'/g, "'")
    }
  }
  return command
}

const normalizeMarkdownText = (value: string) => value.replace(/\r\n/g, '\n')

const buildCodeFence = (language: string, value: string) => {
  const trimmed = normalizeMarkdownText(value).trimEnd()
  if (trimmed.length === 0) return ''
  return `\n\`\`\`${language}\n${trimmed}\n\`\`\`\n`
}

const formatToolStatus = (status: string | undefined, exitCode?: unknown) => {
  if (!status) return null
  if (typeof exitCode === 'number' && Number.isFinite(exitCode)) {
    if (status === 'completed') return `completed with exit code ${exitCode}`
    if (status === 'failed' || status === 'error') return `${status} with exit code ${exitCode}`
  }
  if (status === 'started') return 'in progress'
  if (status === 'delta') return 'in progress'
  return status
}

const buildChangedPathList = (paths: string[]) =>
  paths.length > 0 ? paths.map((path) => `- \`${path}\``).join('\n') : '- `unknown-file`'

const summarizeInlineDetail = (value: string | undefined, max = 180) => {
  if (!value) return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length === 0) return undefined
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`
}

const countArrayField = (record: Record<string, unknown> | undefined, field: string) => {
  const value = record?.[field]
  return Array.isArray(value) ? value.length : undefined
}

const firstArrayString = (record: Record<string, unknown> | undefined, field: string) => {
  const value = record?.[field]
  if (!Array.isArray(value)) return undefined
  const first = value.find((entry) => typeof entry === 'string')
  return summarizeInlineDetail(typeof first === 'string' ? first : undefined, 120)
}

export const normalizeStreamError = (error: unknown) => {
  const normalized: Record<string, unknown> = { type: 'upstream', code: 'upstream_error' }

  if (typeof error === 'string') {
    normalized.message = stripTerminalControl(error)
    return normalized
  }

  if (!error || typeof error !== 'object') {
    normalized.message = stripTerminalControl(String(error ?? 'upstream error'))
    return normalized
  }

  const record = error as Record<string, unknown>

  if (typeof record.message === 'string' && record.message.length > 0) {
    normalized.message = stripTerminalControl(record.message)
  } else if (record.error && typeof record.error === 'object') {
    const nested = record.error as Record<string, unknown>
    if (typeof nested.message === 'string' && nested.message.length > 0) {
      normalized.message = stripTerminalControl(nested.message)
    }
    const codexErrorInfo = nested.codexErrorInfo
    if (typeof codexErrorInfo === 'string' && codexErrorInfo.length > 0) {
      normalized.code = codexErrorInfo
    } else if (codexErrorInfo && typeof codexErrorInfo === 'object') {
      const keys = Object.keys(codexErrorInfo as Record<string, unknown>)
      if (keys[0]) normalized.code = keys[0]
    }
  }

  if (normalized.message == null) {
    normalized.message = stripTerminalControl(safeJsonStringify(error))
  }

  if (typeof record.code === 'string' && record.code.length > 0) {
    normalized.code = record.code
  } else if (typeof record.code === 'number' && Number.isFinite(record.code)) {
    normalized.code = String(record.code)
  }

  return normalized
}

type InternalErrorPayload = {
  message: string
  type: string
  code: string
  detail?: string
}

export type ChatCompletionStreamSession = {
  setThreadMeta: (meta: ThreadMeta) => void
  getState: () => { hasEmittedAnyChunk: boolean; hadError: boolean; assistantContent: string }
  takePendingRenderBlobs: () => OpenWebUiRenderBlob[]
  resolvePendingDetailLinks: (frames: Record<string, unknown>[], failedRenderIds?: string[]) => void
  onDelta: (delta: unknown) => Record<string, unknown>[]
  onInternalError: (error: InternalErrorPayload) => Record<string, unknown>[]
  onClientAbort: () => Record<string, unknown>[]
  finalize: (args: { aborted: boolean; turnFinished: boolean }) => Record<string, unknown>[]
}

export type ChatCompletionEncoderService = {
  create: (args: {
    id: string
    created: number
    model: string
    includeUsage: boolean
    toolRenderer: ToolRenderer
    jangarRender?: JangarRenderConfig
    meta?: ThreadMeta
  }) => ChatCompletionStreamSession
}

export class ChatCompletionEncoder extends Context.Tag('ChatCompletionEncoder')<
  ChatCompletionEncoder,
  ChatCompletionEncoderService
>() {}

const createSession = (args: {
  id: string
  created: number
  model: string
  includeUsage: boolean
  toolRenderer: ToolRenderer
  jangarRender?: JangarRenderConfig
  meta?: ThreadMeta
}): ChatCompletionStreamSession => {
  const { id, created, model, includeUsage, toolRenderer, jangarRender } = args
  const detailLinksEnabled = jangarRender?.detailLinks?.enabled === true
  const jangarEventEnabled =
    jangarRender?.jangarEvent?.enabled === true && jangarRender?.jangarEvent.mode === 'rich-ui-v1'
  const renderUrlTtlSeconds = jangarRender?.detailLinks?.renderUrlTtlSeconds ?? OPENWEBUI_RENDER_URL_TTL_SECONDS
  const messageBindingHash = createMessageBindingHash(id)
  const pendingRenderBlobs = new Map<string, OpenWebUiRenderBlob>()
  const openWebUiDetailStates = new Map<string, OpenWebUIDetailState>()
  const jangarEventRenderStates = new Map<string, JangarEventRenderState>()

  let meta: ThreadMeta = { ...args.meta }
  let messageRoleEmitted = false
  let reasoningBuffer = ''
  let fullReasoningContent = ''
  let commandFenceOpen = false
  let pendingCommandFencePrefix = false
  let trailingNewlines = 1
  let lastUsage: Record<string, unknown> | null = null
  let hadError = false
  let sawUpstreamError = false
  let nextAnonymousToolId = 0
  let hasEmittedAnyChunk = false
  let lastPlanMarkdown: string | null = null
  let hasRenderedRateLimits = false
  let sawAnyMessageDelta = false
  let assistantContent = ''
  let openWebUiActivityBytesUsed = 0
  const toolStates = new Map<string, ToolRenderState>()
  const jangarEventState = new Map<string, JangarEventState>()
  let nextJangarSeq = 1
  const reasoningDetailsState = createReasoningDetailsState()

  const getToolState = (toolEvent: ToolEvent): ToolRenderState => {
    const logicalId = toToolLogicalId(toolEvent.toolKind, toolEvent.id)
    const existing = toolStates.get(logicalId)
    if (existing) {
      if (!existing.title && toolEvent.title) existing.title = toolEvent.title
      if (toolEvent.status) existing.status = toolEvent.status
      return existing
    }

    const nextState: ToolRenderState = {
      kind: toolEvent.toolKind,
      logicalId,
      title: toolEvent.title,
      status: toolEvent.status,
      reasoningState: createReasoningDetailsState(),
      openWebUiOutput: '',
    }
    toolStates.set(logicalId, nextState)
    return nextState
  }

  const emitChoiceChunk = (
    frames: Record<string, unknown>[],
    delta: Record<string, unknown>,
    finishReason: string | null = null,
  ) => {
    const chunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          delta,
          index: 0,
          finish_reason: finishReason,
        },
      ],
    }
    pushChunk(frames, chunk)
  }

  const stageOpenWebUIDetailBlob = (
    logicalId: string,
    lane: JangarRenderLane,
    kind: string,
    payload: Record<string, unknown>,
    preview?: JangarRenderMeta,
  ): OpenWebUIRenderRef | undefined => {
    if (!detailLinksEnabled || typeof jangarRender?.detailLinks?.createRenderRef !== 'function') return undefined

    const existing = openWebUiDetailStates.get(logicalId)
    const expiresAt = existing?.ref.expiresAt ?? new Date(Date.now() + renderUrlTtlSeconds * 1000).toISOString()
    const blob = createOpenWebUiRenderBlob({
      renderId: existing?.ref.id,
      kind,
      logicalId,
      lane,
      payload,
      preview,
      messageBindingHash,
      expiresAt,
    })
    recordOpenWebUIDetailStagedBytes(kind, utf8ByteLength(safeJsonStringify(payload)))

    pendingRenderBlobs.set(blob.renderId, blob)

    if (existing) {
      return existing.ref
    }

    const renderRef =
      jangarRender.detailLinks.createRenderRef({
        renderId: blob.renderId,
        kind,
        messageBindingHash,
        expiresAt,
      }) ?? undefined
    if (!renderRef) {
      recordOpenWebUIDetailLink('failed', kind)
      return undefined
    }

    openWebUiDetailStates.set(logicalId, {
      ref: renderRef,
      linkEmitted: false,
    })
    return renderRef
  }

  const stageJangarEventBlob = (
    logicalId: string,
    lane: JangarRenderLane,
    kind: string,
    payload: Record<string, unknown>,
    preview?: JangarRenderMeta,
  ): OpenWebUIRenderRef | undefined => {
    if (!jangarEventEnabled || typeof jangarRender?.detailLinks?.createRenderRef !== 'function') return undefined

    const stateKey = `jangar_event:${logicalId}`
    const existing = jangarEventRenderStates.get(stateKey)
    const expiresAt = existing?.ref.expiresAt ?? new Date(Date.now() + renderUrlTtlSeconds * 1000).toISOString()
    const blob = createOpenWebUiRenderBlob({
      renderId: existing?.ref.id,
      kind,
      logicalId,
      lane,
      payload,
      preview,
      messageBindingHash,
      expiresAt,
    })

    pendingRenderBlobs.set(blob.renderId, blob)

    if (existing) {
      return existing.ref
    }

    const renderRef =
      jangarRender.detailLinks.createRenderRef({
        renderId: blob.renderId,
        kind,
        messageBindingHash,
        expiresAt,
      }) ?? undefined
    if (!renderRef) return undefined

    jangarEventRenderStates.set(stateKey, {
      ref: renderRef,
    })
    return renderRef
  }

  const maybeStageJangarEventStructuredPayload = (
    logicalId: string,
    lane: JangarRenderLane,
    kind: string,
    payload: Record<string, unknown>,
    preview?: JangarRenderMeta,
  ) => {
    if (utf8ByteLength(safeJsonStringify(payload)) <= OPENWEBUI_MAX_INLINE_STRUCTURED_PAYLOAD_BYTES) return undefined
    return stageJangarEventBlob(logicalId, lane, kind, payload, preview)
  }

  const maybeStageJangarEventTextPayload = (
    logicalId: string,
    lane: JangarRenderLane,
    kind: string,
    payloadKey: 'text' | 'markdown',
    text: string,
    preview?: JangarRenderMeta,
    payloadExtras: Record<string, unknown> = {},
  ) => {
    if (utf8ByteLength(text) <= OPENWEBUI_MAX_INLINE_STRUCTURED_PAYLOAD_BYTES) return undefined
    return stageJangarEventBlob(logicalId, lane, kind, { ...payloadExtras, [payloadKey]: text }, preview)
  }

  const emitJangarEvent = (
    frames: Record<string, unknown>[],
    logicalId: string,
    lane: JangarRenderLane,
    op: JangarRenderOp,
    payload: Record<string, unknown>,
    preview?: JangarRenderMeta,
    renderRef?: JangarRenderEvent['renderRef'],
  ) => {
    if (!jangarEventEnabled) return

    const last = jangarEventState.get(logicalId)
    const revision = (last?.revision ?? 0) + 1
    const event: JangarRenderEvent = {
      version: RENDER_EVENT_VERSION,
      seq: nextJangarSeq,
      logicalId,
      revision,
      lane,
      op,
      payload: { ...payload },
    }
    nextJangarSeq += 1

    if (preview) {
      event.preview = preview
    }
    if (renderRef) {
      event.renderRef = renderRef
    }

    jangarEventState.set(logicalId, {
      revision,
    })
    emitChoiceChunk(frames, { jangar_event: event })
  }

  const eventPayloadText = (value: string) => clampTextForPreview(value) ?? value

  const buildPendingDetailLinkToken = (renderId: string) => `__JANGAR_OPENWEBUI_DETAIL_LINK_${renderId}__`

  const applyDetailLinkReplacements = (value: string, replacements: Map<string, string>) => {
    let next = value
    for (const [token, replacement] of replacements) {
      next = next.replaceAll(token, replacement)
    }
    return next
  }

  const emitOpenWebUIDetailLink = (frames: Record<string, unknown>[], logicalId: string, label: string) => {
    const detailState = openWebUiDetailStates.get(logicalId)
    if (!detailState || detailState.linkEmitted) return
    detailState.linkEmitted = true
    detailState.pendingLinkToken = buildPendingDetailLinkToken(detailState.ref.id)
    detailState.pendingLinkMarkdown = `\n\n${label}: <${detailState.ref.href}>\n\n`
    emitContentDelta(frames, detailState.pendingLinkToken)
  }

  const emitOpenWebUIActivityBlock = (args: {
    frames: Record<string, unknown>[]
    logicalId: string
    lane: JangarRenderLane
    kind: string
    content: string
    preview?: JangarRenderMeta
    detailPayload?: Record<string, unknown>
    detailLabel?: string
    forceDetailLink?: boolean
  }) => {
    const remainingBudget = Math.max(0, OPENWEBUI_MAX_TOTAL_ACTIVITY_BYTES - openWebUiActivityBytesUsed)
    const previewBudget = Math.min(OPENWEBUI_MAX_INLINE_ACTIVITY_BYTES, remainingBudget)
    const fittedContent = fitMarkdownPreviewToBytes(args.content, previewBudget)
    const shouldStageDetail =
      args.detailPayload != null &&
      (args.forceDetailLink === true ||
        fittedContent.truncated ||
        utf8ByteLength(safeJsonStringify(args.detailPayload)) > OPENWEBUI_MAX_INLINE_STRUCTURED_PAYLOAD_BYTES)
    if (fittedContent.truncated) {
      recordOpenWebUIDetailPreviewTruncation(args.kind)
    }
    const renderRef = shouldStageDetail
      ? stageOpenWebUIDetailBlob(
          args.logicalId,
          args.lane,
          args.kind,
          args.detailPayload as Record<string, unknown>,
          args.preview,
        )
      : undefined
    if (!shouldStageDetail && args.detailPayload) {
      recordOpenWebUIDetailLink('skipped', args.kind)
    }

    if (fittedContent.content.length > 0) {
      emitContentDelta(args.frames, fittedContent.content)
      openWebUiActivityBytesUsed += utf8ByteLength(fittedContent.content)
    }

    if (renderRef && args.detailLabel) {
      emitOpenWebUIDetailLink(args.frames, args.logicalId, args.detailLabel)
    }
  }

  const emitMessageEvent = (frames: Record<string, unknown>[], text: string) => {
    const preview = { title: 'assistant', badge: 'message' } satisfies JangarRenderMeta
    emitJangarEvent(frames, 'message:assistant', 'message', 'append_text', { text: eventPayloadText(text) }, preview)
  }

  const emitReasoningEvent = (frames: Record<string, unknown>[], text: string) => {
    const preview = { title: 'reasoning', badge: 'summary' } satisfies JangarRenderMeta
    const renderRef = maybeStageJangarEventTextPayload(
      'reasoning:summary',
      'reasoning',
      'reasoning',
      'text',
      text,
      preview,
    )
    emitJangarEvent(
      frames,
      'reasoning:summary',
      'reasoning',
      'append_text',
      { text: eventPayloadText(text) },
      preview,
      renderRef,
    )
  }

  const emitPlanEvent = (frames: Record<string, unknown>[], markdown: string) => {
    const preview = { title: 'plan', badge: 'plan' } satisfies JangarRenderMeta
    const renderRef = maybeStageJangarEventTextPayload('plan:current', 'plan', 'plan', 'markdown', markdown, preview)
    emitJangarEvent(
      frames,
      'plan:current',
      'plan',
      'replace',
      { markdown: eventPayloadText(markdown) },
      preview,
      renderRef,
    )
  }

  const emitRateLimitsEvent = (frames: Record<string, unknown>[], markdown: string) => {
    const preview = { title: 'rate limits', badge: 'quota' } satisfies JangarRenderMeta
    const renderRef = maybeStageJangarEventTextPayload(
      'rate_limits:current',
      'rate_limits',
      'rate_limits',
      'markdown',
      markdown,
      preview,
    )
    emitJangarEvent(
      frames,
      'rate_limits:current',
      'rate_limits',
      'replace',
      { markdown: eventPayloadText(markdown) },
      preview,
      renderRef,
    )
  }

  const emitUsageEvent = (frames: Record<string, unknown>[], usage: Record<string, unknown>) => {
    const preview = { title: 'usage', badge: 'usage' } satisfies JangarRenderMeta
    const renderRef = maybeStageJangarEventStructuredPayload('usage:final', 'usage', 'usage', { usage }, preview)
    emitJangarEvent(frames, 'usage:final', 'usage', 'replace', { usage }, preview, renderRef)
  }

  const emitErrorEvent = (frames: Record<string, unknown>[], error: Record<string, unknown>) => {
    const preview = { title: 'error', badge: 'error' } satisfies JangarRenderMeta
    const renderRef = maybeStageJangarEventStructuredPayload('error:current', 'error', 'error', { error }, preview)
    emitJangarEvent(frames, 'error:current', 'error', 'replace', { error }, preview, renderRef)
  }

  const renderUsageMarkdown = (usage: Record<string, unknown>) => {
    const prompt = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0
    const completion = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0
    const total = typeof usage.total_tokens === 'number' ? usage.total_tokens : prompt + completion
    return `\n\n> Usage: ${prompt} prompt · ${completion} completion · ${total} total tokens\n\n`
  }

  const renderErrorMarkdown = (error: Record<string, unknown>) => {
    const message = typeof error.message === 'string' ? error.message : 'The turn failed.'
    return `\n\n**Error**\n${message}\n\n`
  }

  const emitToolEvents = (frames: Record<string, unknown>[], toolEvent: ToolEvent) => {
    const toolState = getToolState(toolEvent)
    const status = toJangarMeta(toolEvent.status)
    const summary = parseToolSummary(toolEvent, toolState.reasoningState)
    const shouldReplace =
      summary.kind === 'webSearch' ||
      summary.kind === 'dynamicTool' ||
      summary.kind === 'imageGeneration' ||
      summary.kind === 'mcp' ||
      summary.kind === 'file'
    const op: JangarRenderOp = shouldReplace ? 'replace' : 'merge'
    const logicalId = toolState.logicalId
    const toolTitle = toJangarMeta(toolEvent.title) ?? toJangarMeta(toolState.title) ?? summary.kind
    const preview = {
      title: toolTitle,
      subtitle: status ?? undefined,
      badge: summary.kind,
    } satisfies JangarRenderMeta
    const summaryRenderRef = maybeStageJangarEventStructuredPayload(
      logicalId,
      'tool',
      summary.kind,
      { ...summary },
      preview,
    )

    emitJangarEvent(
      frames,
      logicalId,
      'tool',
      op,
      {
        ...summary,
      },
      preview,
      summaryRenderRef,
    )

    const toolOutput = stripToolText(toolEvent.delta, toolState.reasoningState)
    if (toolOutput) {
      const outputPreview = {
        title: toolTitle,
        badge: summary.kind,
        subtitle: status ?? undefined,
      } satisfies JangarRenderMeta
      const outputRenderRef = maybeStageJangarEventTextPayload(
        logicalId,
        'tool',
        summary.kind,
        'text',
        toolOutput,
        outputPreview,
        { kind: summary.kind, status: status ?? undefined },
      )
      emitJangarEvent(
        frames,
        logicalId,
        'tool',
        'append_text',
        {
          text: eventPayloadText(toolOutput),
        },
        {
          title: toolTitle,
          badge: summary.kind,
          subtitle: status ?? undefined,
        },
        outputRenderRef,
      )
    }

    if (isToolTerminalStatus(status)) {
      emitJangarEvent(
        frames,
        logicalId,
        'tool',
        'complete',
        {
          kind: summary.kind,
          status,
        },
        {
          title: toolTitle,
          subtitle: status,
          badge: summary.kind,
        },
      )
    }
  }

  const emitOpenWebUIToolEvents = (frames: Record<string, unknown>[], toolEvent: ToolEvent) => {
    const toolState = getToolState(toolEvent)
    toolState.title = toolEvent.title ?? toolState.title
    toolState.status = toolEvent.status ?? toolState.status

    const status = toJangarMeta(toolEvent.status) ?? toJangarMeta(toolState.status)
    const summary = parseToolSummary(toolEvent, toolState.reasoningState)
    const logicalId = toolState.logicalId
    const title =
      summary.kind === 'command'
        ? stripShellCommandPrefix(toJangarMeta(summary.title) ?? toJangarMeta(toolState.title) ?? 'Run command')
        : summary.kind === 'file' && (toolState.title === 'file changes' || !toolState.title)
          ? 'Update files'
          : (toJangarMeta(summary.title) ?? toJangarMeta(toolState.title) ?? summary.kind)

    const preview = {
      title,
      subtitle: formatToolStatus(status, 'exitCode' in summary ? summary.exitCode : undefined) ?? status ?? undefined,
      badge: summary.kind,
    } satisfies JangarRenderMeta

    if (summary.kind === 'command') {
      const toolOutput = stripToolText(toolEvent.delta, toolState.reasoningState)
      if (toolOutput) {
        toolState.openWebUiOutput += toolOutput
      }

      const aggregatedOutput = toString(toRecord(toolEvent.data)?.aggregatedOutput)
      if (aggregatedOutput && aggregatedOutput.length >= toolState.openWebUiOutput.length) {
        toolState.openWebUiOutput = stripTerminalControl(aggregatedOutput)
      }

      if (status === 'started' && !toolState.openWebUiSummaryEmitted) {
        toolState.openWebUiSummaryEmitted = true
        emitOpenWebUIActivityBlock({
          frames,
          logicalId,
          lane: 'tool',
          kind: 'command',
          content: `\n\n**${title}**\nStatus: in progress\nCommand:${buildCodeFence('bash', title)}\n`,
          preview,
          detailPayload: {
            format: 'command',
            command: title,
            status: 'started',
            text: `$ ${title}`,
          },
        })
        return
      }

      if (!isToolTerminalStatus(status)) return

      const finalStatus = formatToolStatus(status, summary.exitCode) ?? status ?? 'completed'
      const previewBlock =
        toolState.openWebUiOutput.trim().length > 0
          ? `Preview:${buildCodeFence('text', truncatePreview(toolState.openWebUiOutput, OPENWEBUI_MAX_INLINE_ACTIVITY_BYTES))}`
          : ''
      const fullTranscript = [`$ ${title}`, toolState.openWebUiOutput.trim()].filter(Boolean).join('\n\n')
      const summaryKey = `${finalStatus}:${summary.exitCode ?? ''}:${fullTranscript}`
      if (toolState.openWebUiSummaryKey === summaryKey) return
      toolState.openWebUiSummaryKey = summaryKey

      emitOpenWebUIActivityBlock({
        frames,
        logicalId,
        lane: 'tool',
        kind: 'command',
        content: `\n\n**${title}**\nStatus: ${finalStatus}\nCommand:${buildCodeFence('bash', title)}${previewBlock}\n`,
        preview: { ...preview, subtitle: finalStatus },
        detailLabel: 'Open full transcript',
        detailPayload: {
          format: 'command',
          command: title,
          status,
          exitCode: summary.exitCode ?? null,
          durationMs: summary.duration ?? null,
          text: fullTranscript,
        },
        forceDetailLink: utf8ByteLength(fullTranscript) > OPENWEBUI_MAX_INLINE_ACTIVITY_BYTES,
      })
      return
    }

    if (summary.kind === 'file') {
      if (status === 'started') return

      const changedPaths = summary.changed.changedPaths
      const diffPreview = summary.changed.compactDiff
      const fullDiff = (toolEvent.changes ?? [])
        .map((change) => {
          if (!change || typeof change !== 'object') return null
          const record = change as Record<string, unknown>
          const path = toString(record.path) ?? 'unknown-file'
          const diff = toString(record.diff) ?? ''
          return `${path}\n${diff}`.trim()
        })
        .filter((value): value is string => value != null && value.length > 0)
        .join('\n\n')
      const content = `\n\n**${title}**\nStatus: ${formatToolStatus(status) ?? status ?? 'completed'}\nChanged paths:\n${buildChangedPathList(changedPaths)}\n${
        diffPreview ? `\nPreview:${buildCodeFence('diff', diffPreview)}` : '\n'
      }`
      const summaryKey = `${status}:${changedPaths.join(',')}:${diffPreview ?? ''}`
      if (toolState.openWebUiSummaryKey === summaryKey) return
      toolState.openWebUiSummaryKey = summaryKey

      emitOpenWebUIActivityBlock({
        frames,
        logicalId,
        lane: 'tool',
        kind: 'diff',
        content,
        preview,
        detailLabel: fullDiff.length > 0 ? 'Open full diff' : undefined,
        detailPayload:
          fullDiff.length > 0
            ? {
                format: 'diff',
                paths: changedPaths,
                text: fullDiff,
                status,
              }
            : undefined,
        forceDetailLink: fullDiff.length > 0,
      })
      return
    }

    if (summary.kind === 'mcp') {
      if (status === 'delta') return
      const rawData = toRecord(toolEvent.data)
      const resultRecord = toRecord(rawData?.result)
      const itemCount = countArrayField(resultRecord, 'items')
      const sections = [
        `\n\n**${title}**`,
        `Status: ${formatToolStatus(status) ?? status ?? 'completed'}`,
        summary.detail ? `Summary: ${summary.detail}` : null,
        summary.argumentsPreview ? `Arguments: \`${summarizeInlineDetail(summary.argumentsPreview)}\`` : null,
        itemCount != null ? `Items: ${itemCount}` : null,
        resultRecord?.summary && typeof resultRecord.summary === 'string' ? `Result: ${resultRecord.summary}` : null,
        summary.errorPreview ? `Error: \`${summarizeInlineDetail(summary.errorPreview)}\`` : null,
      ].filter((value): value is string => value != null)
      const content = `${sections.join('\n')}\n`
      const summaryKey = `${status}:${summary.detail ?? ''}:${summary.resultPreview ?? ''}:${summary.errorPreview ?? ''}`
      if (toolState.openWebUiSummaryKey === summaryKey) return
      toolState.openWebUiSummaryKey = summaryKey

      emitOpenWebUIActivityBlock({
        frames,
        logicalId,
        lane: 'tool',
        kind: 'json',
        content,
        preview,
        detailLabel: 'Open full result',
        detailPayload: {
          format: 'json',
          tool: title,
          status,
          detail: summary.detail ?? null,
          arguments: toRecord(toolEvent.data)?.arguments ?? null,
          result: toRecord(toolEvent.data)?.result ?? null,
          error: toRecord(toolEvent.data)?.error ?? null,
        },
      })
      return
    }

    if (summary.kind === 'dynamicTool') {
      if (status === 'delta') return
      const resultRecord = toRecord(summary.result)
      const itemCount = countArrayField(resultRecord, 'items')
      const sections = [
        `\n\n**${title}**`,
        `Status: ${formatToolStatus(status) ?? status ?? 'completed'}`,
        summary.detail ? `Summary: ${summary.detail}` : null,
        summary.arguments ? `Arguments: \`${summarizeInlineDetail(safeJsonStringify(summary.arguments))}\`` : null,
        itemCount != null ? `Items: ${itemCount}` : null,
        resultRecord?.summary && typeof resultRecord.summary === 'string' ? `Result: ${resultRecord.summary}` : null,
        typeof summary.success === 'boolean' ? `Success: ${summary.success ? 'yes' : 'no'}` : null,
      ].filter((value): value is string => value != null)
      const content = `${sections.join('\n')}\n`
      const summaryKey = `${status}:${safeJsonStringify(summary.arguments ?? null)}:${safeJsonStringify(summary.result ?? null)}:${summary.success ?? 'unknown'}`
      if (toolState.openWebUiSummaryKey === summaryKey) return
      toolState.openWebUiSummaryKey = summaryKey

      emitOpenWebUIActivityBlock({
        frames,
        logicalId,
        lane: 'tool',
        kind: 'json',
        content,
        preview,
        detailLabel: 'Open full result',
        detailPayload: {
          format: 'json',
          tool: title,
          status,
          detail: summary.detail ?? null,
          arguments: summary.arguments ?? null,
          result: summary.result ?? null,
          success: summary.success ?? null,
        },
      })
      return
    }

    if (summary.kind === 'webSearch') {
      if (status === 'delta') return
      const data = toRecord(toolEvent.data)
      const resultCount = countArrayField(data, 'results')
      const topResult = firstArrayString(
        toRecord({
          items: Array.isArray(data?.results)
            ? data?.results
                .map((entry) =>
                  entry && typeof entry === 'object' ? toString((entry as Record<string, unknown>).title) : undefined,
                )
                .filter((entry): entry is string => entry != null)
            : undefined,
        }),
        'items',
      )
      const content = `\n\n**Web search**\nStatus: ${formatToolStatus(status) ?? status ?? 'completed'}\nQuery: \`${summary.query ?? title}\`\n${
        summary.detail ? `Summary: ${summary.detail}\n` : ''
      }${resultCount != null ? `Results: ${resultCount}\n` : ''}${topResult ? `Top result: ${topResult}\n` : ''}`
      const summaryKey = `${status}:${summary.query ?? ''}:${summary.detail ?? ''}`
      if (toolState.openWebUiSummaryKey === summaryKey) return
      toolState.openWebUiSummaryKey = summaryKey

      emitOpenWebUIActivityBlock({
        frames,
        logicalId,
        lane: 'tool',
        kind: 'json',
        content,
        preview: { ...preview, title: 'Web search' },
        detailLabel: 'Open full result',
        detailPayload: {
          format: 'json',
          query: summary.query ?? null,
          status,
          detail: summary.detail ?? null,
          data: toRecord(toolEvent.data) ?? null,
        },
      })
      return
    }

    if (summary.kind === 'imageGeneration') {
      if (status === 'delta') return
      const content = `\n\n**${title}**\nStatus: ${formatToolStatus(status) ?? status ?? 'completed'}\n${
        summary.prompt ? `Prompt: ${summary.prompt}\n` : ''
      }`
      const summaryKey = `${status}:${summary.prompt ?? ''}:${summary.imageUrl ?? ''}`
      if (toolState.openWebUiSummaryKey === summaryKey) return
      toolState.openWebUiSummaryKey = summaryKey

      emitOpenWebUIActivityBlock({
        frames,
        logicalId,
        lane: 'tool',
        kind: 'image',
        content,
        preview,
        detailLabel: summary.imageUrl ? 'Open image preview' : undefined,
        detailPayload: summary.imageUrl
          ? {
              format: 'image',
              prompt: summary.prompt ?? null,
              status,
              imageUrl: summary.imageUrl,
            }
          : undefined,
        forceDetailLink: Boolean(summary.imageUrl),
      })
      return
    }
  }

  const attachMeta = (chunk: Record<string, unknown>) => {
    const threadId = meta.threadId
    const turnNumber = meta.turnNumber

    if (threadId || turnNumber != null) {
      return {
        ...chunk,
        thread_id: threadId ?? undefined,
        turn_number: turnNumber ?? undefined,
      }
    }
    return chunk
  }

  const ensureRole = (deltaPayload: Record<string, unknown>) => {
    if (!messageRoleEmitted) {
      deltaPayload.role = 'assistant'
      messageRoleEmitted = true
    }
  }

  const pushChunk = (frames: Record<string, unknown>[], chunk: Record<string, unknown> | null) => {
    if (!chunk) return
    hasEmittedAnyChunk = true
    frames.push(attachMeta(chunk))
  }

  const emitContentDelta = (frames: Record<string, unknown>[], content: string) => {
    const sanitizedContent = stripTerminalControl(content)
    if (sanitizedContent.length === 0) return

    assistantContent += sanitizedContent

    const deltaPayload: Record<string, unknown> = { content: sanitizedContent }
    ensureRole(deltaPayload)
    const chunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          delta: deltaPayload,
          index: 0,
          finish_reason: null,
        },
      ],
    }
    pushChunk(frames, chunk)

    const trailingMatch = sanitizedContent.match(/\n+$/)
    trailingNewlines = trailingMatch ? Math.min(2, trailingMatch[0].length) : 0
  }

  const openCommandFence = (frames: Record<string, unknown>[]) => {
    if (commandFenceOpen) return
    if (trailingNewlines === 0) {
      emitContentDelta(frames, '\n')
    }
    // Keep the opening fence attached to the first command chunk so incremental markdown renderers
    // treat the command block as code instead of a literal ``` line.
    pendingCommandFencePrefix = true
    commandFenceOpen = true
  }

  const closeCommandFence = (frames: Record<string, unknown>[]) => {
    if (!commandFenceOpen) return
    if (pendingCommandFencePrefix) {
      emitContentDelta(frames, '```ts\n')
      pendingCommandFencePrefix = false
    }
    // Ensure the closing fence is on its own line (and leave a trailing blank line) even when command output does not end with a newline.
    emitContentDelta(frames, '\n```\n\n')
    commandFenceOpen = false
  }

  const flushReasoning = (frames: Record<string, unknown>[]) => {
    if (!reasoningBuffer) return

    // Preserve up to 3 trailing asterisks to allow cross-delta "****" detection.
    let carry = ''
    const carryMatch = reasoningBuffer.match(/(\*{1,3})$/)
    if (carryMatch) {
      carry = carryMatch[1]
      reasoningBuffer = reasoningBuffer.slice(0, -carry.length)
    }

    const sanitized = stripTerminalControl(sanitizeReasoningText(reasoningBuffer))
    const deltaPayload: Record<string, unknown> = {
      reasoning_content: sanitized,
    }
    ensureRole(deltaPayload)

    const chunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          delta: deltaPayload,
          index: 0,
          finish_reason: null,
        },
      ],
    }

    pushChunk(frames, chunk)

    const emittedText = stripTerminalControl(sanitized)
    if (emittedText.length > 0) {
      fullReasoningContent += emittedText
      emitReasoningEvent(frames, emittedText)
      if (detailLinksEnabled && utf8ByteLength(fullReasoningContent) > OPENWEBUI_MAX_INLINE_STRUCTURED_PAYLOAD_BYTES) {
        stageOpenWebUIDetailBlob(
          'reasoning:summary',
          'reasoning',
          'text',
          { format: 'text', text: fullReasoningContent },
          { title: 'reasoning', badge: 'summary' },
        )
        emitOpenWebUIDetailLink(frames, 'reasoning:summary', 'Open detail')
      }
    }

    reasoningBuffer = carry
  }

  const onDelta: ChatCompletionStreamSession['onDelta'] = (delta) => {
    const frames: Record<string, unknown>[] = []
    const record = delta && typeof delta === 'object' ? (delta as Record<string, unknown>) : null
    const type = record && typeof record.type === 'string' ? record.type : null

    if (type !== 'reasoning') {
      flushReasoning(frames)
    }

    if (type === 'usage') {
      closeCommandFence(frames)
      if (includeUsage) {
        lastUsage = normalizeUsage(record?.usage)
        emitUsageEvent(frames, lastUsage)
      }
      return frames
    }

    if (type === 'plan') {
      closeCommandFence(frames)
      const markdown = toPlanMarkdown(record)
      if (!markdown || markdown === lastPlanMarkdown) return frames
      lastPlanMarkdown = markdown
      if (detailLinksEnabled) {
        emitOpenWebUIActivityBlock({
          frames,
          logicalId: 'plan:current',
          lane: 'plan',
          kind: 'markdown',
          content: `\n\n${markdown}\n\n\n`,
          preview: { title: 'plan', badge: 'plan' },
          detailLabel: 'Open detail',
          detailPayload: {
            format: 'markdown',
            markdown,
          },
        })
      } else {
        emitContentDelta(frames, `\n\n${markdown}\n\n\n`)
      }
      emitPlanEvent(frames, markdown)
      return frames
    }

    if (type === 'rate_limits') {
      closeCommandFence(frames)
      const markdown = toRateLimitMarkdown(record?.rateLimits)
      if (!markdown || hasRenderedRateLimits) return frames
      hasRenderedRateLimits = true
      if (detailLinksEnabled) {
        emitOpenWebUIActivityBlock({
          frames,
          logicalId: 'rate_limits:current',
          lane: 'rate_limits',
          kind: 'json',
          content: `\n\n${markdown}\n\n`,
          preview: { title: 'rate limits', badge: 'quota' },
          detailLabel: 'Open detail',
          detailPayload: {
            format: 'json',
            rateLimits: record?.rateLimits ?? null,
          },
        })
      } else {
        emitContentDelta(frames, `\n\n${markdown}\n\n`)
      }
      emitRateLimitsEvent(frames, markdown)
      return frames
    }

    if (sawUpstreamError) {
      // After an upstream error we only care about trailing usage updates.
      return frames
    }

    if (type === 'error') {
      hadError = true
      sawUpstreamError = true
      closeCommandFence(frames)
      const normalized = normalizeStreamError(record?.error)
      if (detailLinksEnabled) {
        emitOpenWebUIActivityBlock({
          frames,
          logicalId: 'error:current',
          lane: 'error',
          kind: 'json',
          content: renderErrorMarkdown(normalized),
          preview: { title: 'error', badge: 'error' },
          detailLabel: 'Open detail',
          detailPayload: {
            format: 'json',
            error: normalized,
          },
        })
      }
      pushChunk(frames, { error: normalized })
      emitErrorEvent(frames, normalized)
      return frames
    }

    if (type === 'message') {
      closeCommandFence(frames)
      const text = normalizeDeltaText(record?.delta)
      if (!sawAnyMessageDelta && text.length > 0 && !text.startsWith('\n')) {
        const prefixed = `\n${text}`
        emitContentDelta(frames, prefixed)
        emitMessageEvent(frames, prefixed)
      } else {
        emitContentDelta(frames, text)
        emitMessageEvent(frames, text)
      }
      if (text.length > 0) {
        sawAnyMessageDelta = true
      }
      return frames
    }

    if (type === 'reasoning') {
      closeCommandFence(frames)
      reasoningBuffer += sanitizeReasoningText(
        stripReasoningDetailsMarkup(normalizeDeltaText(record?.delta), reasoningDetailsState),
      )
      // Emit reasoning immediately to avoid long silent periods that can trip upstream timeouts.
      flushReasoning(frames)
      return frames
    }

    if (type === 'tool') {
      const decoded = decodeToolEvent(delta, `tool-${nextAnonymousToolId++}`)
      if (Either.isLeft(decoded)) {
        closeCommandFence(frames)
        const raw = delta as Record<string, unknown>
        console.warn(TOOL_EVENT_DECODE_FAILED_TAG, {
          chatId: meta.chatId,
          threadId: meta.threadId ?? undefined,
          turnNumber: meta.turnNumber ?? undefined,
          error: decoded.left,
          rawKeys: typeof raw === 'object' && raw ? Object.keys(raw) : undefined,
          rawToolKind: typeof raw.toolKind === 'string' ? raw.toolKind : undefined,
          rawStatus: typeof raw.status === 'string' ? raw.status : undefined,
          rawTitle: typeof raw.title === 'string' ? raw.title : undefined,
        })
        return frames
      }

      const toolEvent = decoded.right

      if (detailLinksEnabled) {
        emitToolEvents(frames, toolEvent)
        emitOpenWebUIToolEvents(frames, toolEvent)
        return frames
      }

      // If a new command starts while the command fence is already open, ensure there is a blank line before
      // the next command header. This prevents consecutive commands from visually "sticking" together.
      if (
        toolEvent.toolKind === 'command' &&
        toolEvent.status === 'started' &&
        commandFenceOpen &&
        trailingNewlines < 2
      ) {
        emitContentDelta(frames, '\n'.repeat(2 - trailingNewlines))
      }

      const actions = toolRenderer.onToolEvent(toolEvent)
      emitToolEvents(frames, toolEvent)

      for (const action of actions) {
        if (action.type === 'openCommandFence') {
          openCommandFence(frames)
          continue
        }
        if (action.type === 'closeCommandFence') {
          closeCommandFence(frames)
          continue
        }
        if (action.type === 'emitContent' && typeof action.content === 'string' && action.content.length > 0) {
          const content = pendingCommandFencePrefix ? `\`\`\`ts\n${action.content}` : action.content
          pendingCommandFencePrefix = false
          emitContentDelta(frames, content)
        }
      }
      return frames
    }

    return frames
  }

  const onInternalError: ChatCompletionStreamSession['onInternalError'] = (error) => {
    hadError = true
    const frames: Record<string, unknown>[] = []
    closeCommandFence(frames)
    const normalized = {
      message: error.message,
      type: error.type,
      code: error.code,
      ...(error.detail != null ? { detail: error.detail } : {}),
    }
    if (detailLinksEnabled) {
      emitOpenWebUIActivityBlock({
        frames,
        logicalId: 'error:current',
        lane: 'error',
        kind: 'json',
        content: renderErrorMarkdown(normalized),
        preview: { title: 'error', badge: 'error' },
        detailLabel: 'Open detail',
        detailPayload: {
          format: 'json',
          error: normalized,
        },
      })
    }
    pushChunk(frames, { error: normalized })
    emitErrorEvent(frames, normalized)
    return frames
  }

  const onClientAbort: ChatCompletionStreamSession['onClientAbort'] = () => {
    const frames: Record<string, unknown>[] = []
    const normalized = {
      message: 'request was aborted by the client',
      type: 'request_cancelled',
      code: 'client_abort',
    }
    hadError = true
    closeCommandFence(frames)
    if (detailLinksEnabled) {
      emitOpenWebUIActivityBlock({
        frames,
        logicalId: 'error:current',
        lane: 'error',
        kind: 'json',
        content: renderErrorMarkdown(normalized),
        preview: { title: 'error', badge: 'error' },
        detailLabel: 'Open detail',
        detailPayload: {
          format: 'json',
          error: normalized,
        },
      })
    }
    pushChunk(frames, { error: normalized })
    emitErrorEvent(frames, normalized)
    return frames
  }

  const takePendingRenderBlobs: ChatCompletionStreamSession['takePendingRenderBlobs'] = () =>
    Array.from(pendingRenderBlobs.values()).map((blob) => {
      pendingRenderBlobs.delete(blob.renderId)
      return blob
    })

  const resolvePendingDetailLinks: ChatCompletionStreamSession['resolvePendingDetailLinks'] = (
    frames,
    failedRenderIds = [],
  ) => {
    if (!detailLinksEnabled) return

    const failedRenderIdSet = new Set(failedRenderIds)
    const replacements = new Map<string, string>()

    for (const detailState of openWebUiDetailStates.values()) {
      if (!detailState.pendingLinkToken || detailState.pendingLinkMarkdown == null) continue

      const failed = failedRenderIdSet.has(detailState.ref.id)
      replacements.set(detailState.pendingLinkToken, failed ? '' : detailState.pendingLinkMarkdown)
      detailState.pendingLinkToken = undefined
      detailState.pendingLinkMarkdown = undefined

      if (failed) {
        detailState.linkEmitted = false
        recordOpenWebUIDetailLink('failed', detailState.ref.kind)
        continue
      }

      recordOpenWebUIDetailLink('created', detailState.ref.kind)
    }

    if (replacements.size === 0) return

    assistantContent = applyDetailLinkReplacements(assistantContent, replacements)

    for (const frame of frames) {
      const choices = Array.isArray(frame.choices) ? frame.choices : []
      for (const choice of choices) {
        const choiceRecord = toRecord(choice)
        const delta = toRecord(choiceRecord?.delta)
        if (!delta || typeof delta.content !== 'string') continue
        delta.content = applyDetailLinkReplacements(delta.content, replacements)
      }
    }
  }

  const finalize: ChatCompletionStreamSession['finalize'] = ({ aborted }) => {
    const frames: Record<string, unknown>[] = []

    flushReasoning(frames)
    closeCommandFence(frames)

    if (includeUsage && lastUsage) {
      emitUsageEvent(frames, lastUsage)
      if (detailLinksEnabled) {
        emitOpenWebUIActivityBlock({
          frames,
          logicalId: 'usage:final',
          lane: 'usage',
          kind: 'json',
          content: renderUsageMarkdown(lastUsage),
          preview: { title: 'usage', badge: 'usage' },
          detailLabel: 'Open detail',
          detailPayload: {
            format: 'json',
            usage: lastUsage,
          },
        })
      }
      pushChunk(frames, {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [],
        usage: lastUsage,
      })
    }

    if (!aborted) {
      pushChunk(frames, {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            delta: {},
            index: 0,
            finish_reason: 'stop',
          },
        ],
      })
    }

    return frames
  }

  return {
    setThreadMeta: (next) => {
      meta = { ...meta, ...next }
    },
    getState: () => ({ hasEmittedAnyChunk, hadError, assistantContent }),
    takePendingRenderBlobs,
    resolvePendingDetailLinks,
    onDelta,
    onInternalError,
    onClientAbort,
    finalize,
  }
}

export const chatCompletionEncoderLive: ChatCompletionEncoderService = {
  create: (args) => createSession(args),
}
