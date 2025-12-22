import { Context } from 'effect'
import * as Either from 'effect/Either'
import { safeJsonStringify, stripTerminalControl } from './chat-text'
import { decodeToolEvent } from './chat-tool-event'
import type { ToolRenderer } from './chat-tool-event-renderer'

const TOOL_EVENT_DECODE_FAILED_TAG = '[jangar][tool-event][decode-failed]'

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
    const usage = typeof used === 'number' ? `${formatPercent(used)} used` : 'usage unknown'
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

const sanitizeReasoningText = (text: string) => text.replace(/\*{4,}/g, '\n')

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
  getState: () => { hasEmittedAnyChunk: boolean; hadError: boolean }
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
  meta?: ThreadMeta
}): ChatCompletionStreamSession => {
  const { id, created, model, includeUsage, toolRenderer } = args

  let meta: ThreadMeta = { ...args.meta }
  let messageRoleEmitted = false
  let reasoningBuffer = ''
  let commandFenceOpen = false
  let trailingNewlines = 1
  let lastUsage: Record<string, unknown> | null = null
  let hadError = false
  let sawUpstreamError = false
  let nextAnonymousToolId = 0
  let hasEmittedAnyChunk = false
  let lastPlanMarkdown: string | null = null
  let lastRateLimitsMarkdown: string | null = null
  let sawAnyMessageDelta = false

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
    // Start command output fence without leading/trailing blank lines and with explicit language for clarity.
    emitContentDelta(frames, '```ts\n')
    commandFenceOpen = true
  }

  const closeCommandFence = (frames: Record<string, unknown>[]) => {
    if (!commandFenceOpen) return
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
      }
      return frames
    }

    if (type === 'plan') {
      closeCommandFence(frames)
      const markdown = toPlanMarkdown(record)
      if (!markdown || markdown === lastPlanMarkdown) return frames
      lastPlanMarkdown = markdown
      emitContentDelta(frames, `\n\n${markdown}\n\n\n`)
      return frames
    }

    if (type === 'rate_limits') {
      closeCommandFence(frames)
      const markdown = toRateLimitMarkdown(record?.rateLimits)
      if (!markdown || markdown === lastRateLimitsMarkdown) return frames
      lastRateLimitsMarkdown = markdown
      emitContentDelta(frames, `\n\n${markdown}\n\n`)
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
      pushChunk(frames, { error: normalizeStreamError(record?.error) })
      return frames
    }

    if (type === 'message') {
      closeCommandFence(frames)
      const text = normalizeDeltaText(record?.delta)
      if (!sawAnyMessageDelta && text.length > 0 && !text.startsWith('\n')) {
        emitContentDelta(frames, `\n${text}`)
      } else {
        emitContentDelta(frames, text)
      }
      if (text.length > 0) {
        sawAnyMessageDelta = true
      }
      return frames
    }

    if (type === 'reasoning') {
      reasoningBuffer += sanitizeReasoningText(normalizeDeltaText(record?.delta))
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
          emitContentDelta(frames, action.content)
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
    pushChunk(frames, { error })
    return frames
  }

  const onClientAbort: ChatCompletionStreamSession['onClientAbort'] = () => {
    const frames: Record<string, unknown>[] = []
    pushChunk(frames, {
      error: {
        message: 'request was aborted by the client',
        type: 'request_cancelled',
        code: 'client_abort',
      },
    })
    return frames
  }

  const finalize: ChatCompletionStreamSession['finalize'] = ({ aborted }) => {
    const frames: Record<string, unknown>[] = []

    flushReasoning(frames)
    closeCommandFence(frames)

    if (includeUsage && lastUsage) {
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
    getState: () => ({ hasEmittedAnyChunk, hadError }),
    onDelta,
    onInternalError,
    onClientAbort,
    finalize,
  }
}

export const chatCompletionEncoderLive: ChatCompletionEncoderService = {
  create: (args) => createSession(args),
}
