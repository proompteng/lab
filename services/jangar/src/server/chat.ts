import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as S from '@effect/schema/Schema'
import type { CodexAppServerClient } from '@proompteng/codex'
import { Effect, pipe } from 'effect'

import { type ChatThreadStore, createRedisChatThreadStore } from './chat-thread-store'
import { getCodexClient, resetCodexClient, setCodexClientFactory } from './codex-client'
import { loadConfig } from './config'

const MessageSchema = S.Struct({
  role: S.String,
  content: S.Unknown,
  name: S.optional(S.String),
})

const ChatRequestSchema = S.Struct({
  model: S.optional(S.String),
  messages: S.Array(MessageSchema),
  stream: S.optional(S.Boolean),
  stream_options: S.optional(
    S.Struct({
      include_usage: S.optional(S.Boolean),
    }),
  ),
})

type ChatRequest = S.Schema.Type<typeof ChatRequestSchema>

class RequestError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const safeJsonStringify = (value: unknown) => {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const stripTerminalControl = (text: string) => {
  if (text.length === 0) return text

  // Some clients (and copy/paste flows) will include U+241B (SYMBOL FOR ESCAPE) instead of a raw ESC.
  const input = text.replaceAll('\u241b', '\u001b')
  const esc = '\u001b'
  const csi = '\u009b'
  const bel = '\u0007'

  let output = ''

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]

    if (char !== esc && char !== csi) {
      // Drop non-printable control characters (keep \t, \n, \r).
      if (char <= '\u001f' || char === '\u007f') {
        if (char === '\n' || char === '\r' || char === '\t') output += char
        continue
      }

      output += char
      continue
    }

    // Treat CSI (0x9B) like ESC [.
    const next = char === csi ? '[' : input[index + 1]

    // If we have a bare ESC at end, drop it.
    if (char === esc && next == null) break

    // OSC / DCS / PM / APC / SOS: skip until BEL or ST (ESC \).
    if (next === ']' || next === 'P' || next === '^' || next === '_' || next === 'X') {
      index += char === esc ? 1 : 0
      for (index += 1; index < input.length; index += 1) {
        const inner = input[index]
        if (inner === bel) break
        if (inner === esc && input[index + 1] === '\\') {
          index += 1
          break
        }
      }
      continue
    }

    // CSI: skip until a final byte in the range @..~.
    if (next === '[') {
      index += char === esc ? 1 : 0
      for (index += 1; index < input.length; index += 1) {
        const code = input.charCodeAt(index)
        if (code >= 0x40 && code <= 0x7e) break
      }
      continue
    }

    // Other short ESC sequences: drop ESC and one following byte (if present).
    if (char === esc) index += 1
  }

  return output
}

let defaultThreadStore: ChatThreadStore | null = null
let customThreadStore: ChatThreadStore | null = null

const getThreadStore = () => {
  if (customThreadStore) return customThreadStore
  if (!defaultThreadStore) {
    defaultThreadStore = createRedisChatThreadStore()
  }
  return defaultThreadStore
}

export const setThreadStore = (store: ChatThreadStore | null) => {
  customThreadStore = store
}

export const resetThreadStore = () => {
  customThreadStore = null
  if (defaultThreadStore) {
    const store = defaultThreadStore
    void pipe(
      store.clearAll(),
      Effect.catchAll((error) => {
        console.warn('[chat] failed to clear redis keys during reset', { error: String(error) })
        return Effect.succeed(undefined)
      }),
      Effect.flatMap(() => store.shutdown()),
      Effect.catchAll((error) => {
        console.warn('[chat] failed to close redis client during reset', { error: String(error) })
        return Effect.succeed(undefined)
      }),
      Effect.runPromise,
    )
    defaultThreadStore = null
  }
}

const sseError = (payload: unknown, status = 400) => {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(stream, {
    status,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}

const normalizeStreamError = (error: unknown) => {
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

const parseRequest = async (request: Request): Promise<ChatRequest> => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new RequestError(400, 'invalid_json', 'Invalid JSON body')
  }

  let parsed: ChatRequest
  try {
    parsed = await S.decodeUnknownPromise(ChatRequestSchema)(body)
  } catch (error) {
    throw new RequestError(
      400,
      'invalid_request_error',
      stripTerminalControl(error instanceof Error ? error.message : safeJsonStringify(error)),
    )
  }

  if (!parsed.messages.length) {
    throw new RequestError(400, 'messages_required', '`messages` must be a non-empty array')
  }

  if (parsed.stream !== true) {
    throw new RequestError(400, 'stream_required', '`stream` must be true for streaming responses')
  }
  return parsed
}

const summarizeNonTextPart = (part: Record<string, unknown>) => {
  const type = typeof part.type === 'string' && part.type.length > 0 ? part.type : 'part'
  if (type === 'image_url') {
    const imageUrl = part.image_url
    if (imageUrl && typeof imageUrl === 'object') {
      const url = (imageUrl as Record<string, unknown>).url
      if (typeof url === 'string' && url.length > 0) return ` [image_url] ${url}`
    }
    return ' [image_url]'
  }
  if (type === 'input_audio') return ' [input_audio]'
  if (type === 'file') return ' [file]'
  return ` [${type}]`
}

const normalizeMessageContent = (content: unknown): string => {
  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          const obj = part as Record<string, unknown>
          if (typeof obj.text === 'string') return obj.text
          if (typeof obj.content === 'string') return obj.content
          return summarizeNonTextPart(obj)
        }
        return part == null ? '' : String(part)
      })
      .filter((value) => value.length > 0)
    return parts.join('')
  }

  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>
    if (typeof obj.text === 'string') return obj.text
    if (typeof obj.content === 'string') return obj.content
    return summarizeNonTextPart(obj)
  }

  return content == null ? '' : String(content)
}

const buildPrompt = (messages: ChatRequest['messages']) =>
  messages
    .map((msg) => {
      const prefix = msg.name && msg.name.length > 0 ? `${msg.role}(${msg.name})` : msg.role
      return `${prefix}: ${normalizeMessageContent(msg.content)}`
    })
    .join('\n')

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

const truncateLines = (text: string, maxLines: number) => {
  const lines = text.split(/\r?\n/)
  if (lines.length <= maxLines) return text
  return [...lines.slice(0, maxLines), '...', ''].join('\n')
}

const renderFileChanges = (rawChanges: unknown, maxDiffLines = 5) => {
  if (!Array.isArray(rawChanges)) return undefined

  const rendered = rawChanges
    .map((change) => {
      if (!change || typeof change !== 'object') return null
      const obj = change as { path?: unknown; diff?: unknown }
      const path = typeof obj.path === 'string' && obj.path.length > 0 ? obj.path : 'unknown-file'
      const diffText = typeof obj.diff === 'string' ? obj.diff : ''
      const lines = diffText.split(/\r?\n/)
      const truncated = lines.length > maxDiffLines ? [...lines.slice(0, maxDiffLines), '…'] : lines
      const body = truncated.join('\n')
      return `\n\`\`\`bash\n${path}\n${body}\n\`\`\`\n`
    })
    .filter(Boolean)

  if (rendered.length === 0) return undefined
  if (rendered.length === 1) return rendered[0] as string
  return rendered.join('\n\n')
}

const resolveCodexCwd = () => {
  const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  return process.env.CODEX_CWD ?? (process.env.NODE_ENV === 'production' ? '/workspace/lab' : defaultRepoRoot)
}

type ThreadContext = {
  chatId: string
  threadId: string | null
  store: ChatThreadStore
  turnNumber: number | null
}

const toSseResponse = (
  client: CodexAppServerClient,
  prompt: string,
  model: string,
  includeUsage: boolean,
  threadContext: ThreadContext | null,
  signal?: AbortSignal,
) => {
  const encoder = new TextEncoder()
  const created = Math.floor(Date.now() / 1000)
  const id = `chatcmpl-${crypto.randomUUID()}`
  const heartbeatIntervalMs = 5_000
  const enableHeartbeat = process.env.NODE_ENV !== 'test'

  const codexCwd = resolveCodexCwd()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let aborted = false
      let controllerClosed = false
      let activeTurnId: string | null = null
      let activeThreadId: string | null = null
      let pendingInterrupt = false
      let didInterrupt = false
      let lastUsage: Record<string, unknown> | null = null
      let turnFinished = false
      let sawUpstreamError = false
      const includeUsageChunk = includeUsage

      const interruptTurn = (turnId: string, threadId: string) => {
        if (didInterrupt) return
        didInterrupt = true
        void client.interruptTurn(turnId, threadId).catch(() => {})
      }

      const interruptCodex = () => {
        if (activeTurnId && activeThreadId) {
          interruptTurn(activeTurnId, activeThreadId)
          return
        }
        pendingInterrupt = true
      }

      const safeClose = () => {
        if (controllerClosed) return
        try {
          controller.close()
        } catch {
          // ignore
        } finally {
          controllerClosed = true
        }
      }

      const attachMeta = (chunk: Record<string, unknown>) => {
        if (threadContext?.threadId || activeThreadId) {
          chunk.thread_id = activeThreadId ?? threadContext?.threadId ?? undefined
        }
        if (threadContext?.turnNumber != null) {
          chunk.turn_number = threadContext.turnNumber
        }
        return chunk
      }

      let hasEmittedAnyChunk = false

      const enqueueChunk = (chunk: unknown) => {
        if (controllerClosed) return
        hasEmittedAnyChunk = true
        try {
          const withMeta = chunk && typeof chunk === 'object' ? attachMeta(chunk as Record<string, unknown>) : chunk
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(withMeta)}\n\n`))
        } catch {
          // If the client has already gone away, ensure we close the stream and interrupt Codex
          controllerClosed = true
          aborted = true
          interruptCodex()
          safeClose()
        }
      }

      let messageRoleEmitted = false
      const abortControllers: Array<() => void> = []
      let reasoningBuffer = ''
      let commandFenceOpen = false
      let lastContentEndsWithNewline = true
      let hadError = false
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null
      const ensureTurnNumber = async () => {
        if (!threadContext || threadContext.turnNumber != null) return
        threadContext.turnNumber = await pipe(threadContext.store.nextTurn(threadContext.chatId), Effect.runPromise)
      }

      type ToolState = {
        id: string
        index: number
        toolKind: string
        title?: string
        lastContent?: string
        lastStatus?: string
      }

      const toolStates = new Map<string, ToolState>()
      let nextToolIndex = 0

      const getToolState = (event: Record<string, unknown>): ToolState => {
        const toolId = typeof event.id === 'string' ? event.id : `tool-${nextToolIndex}`
        const existing = toolStates.get(toolId)
        if (existing) {
          if (!existing.title && typeof event.title === 'string' && event.title.length > 0) {
            existing.title = event.title
          }
          return existing
        }

        const toolKind = typeof event.toolKind === 'string' && event.toolKind.length > 0 ? event.toolKind : 'tool'
        const toolState: ToolState = {
          id: toolId,
          index: nextToolIndex++,
          toolKind,
          title: typeof event.title === 'string' && event.title.length > 0 ? event.title : undefined,
        }
        toolStates.set(toolId, toolState)
        return toolState
      }

      const formatToolArguments = (toolState: ToolState, event: Record<string, unknown>) => {
        const payload: Record<string, unknown> = {
          tool: toolState.toolKind,
        }

        if (toolState.title) payload.title = toolState.title
        const status = typeof event.status === 'string' ? event.status : undefined
        if (status) payload.status = status
        const detail = typeof event.detail === 'string' ? event.detail : undefined
        if (typeof event.delta === 'string' && event.delta.length > 0) {
          payload.output = event.delta
        } else if (event.delta != null && typeof event.delta !== 'function') {
          payload.output = String(event.delta)
        }

        const isCommandLocationDetail = toolState.toolKind === 'command' && detail && status === 'started'

        if (detail && !isCommandLocationDetail) payload.detail = detail

        return payload
      }

      const formatToolContent = (toolState: ToolState, payload: Record<string, unknown>) => {
        const output = typeof payload.output === 'string' ? payload.output : undefined
        const detail = typeof payload.detail === 'string' ? payload.detail : undefined
        const title = typeof payload.title === 'string' ? payload.title : undefined
        const status = typeof payload.status === 'string' ? payload.status : undefined

        // Skip empty completions; this prevents an extra blank chunk when a command finishes without output.
        if (status === 'completed' && toolState.toolKind === 'command' && !output && !detail) return ''

        if (output && output.length > 0) return truncateLines(output, 5)
        if (detail && detail.length > 0) return truncateLines(detail, 5)
        if (title && title.length > 0) return title
        return toolState.toolKind
      }

      const emitContentDelta = (content: string) => {
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
        enqueueChunk(chunk)
        lastContentEndsWithNewline = sanitizedContent.endsWith('\n')
      }

      const openCommandFence = () => {
        if (commandFenceOpen) return
        if (!lastContentEndsWithNewline) {
          emitContentDelta('\n')
        }
        // Start command output fence without leading/trailing blank lines and with explicit language for clarity.
        emitContentDelta('```ts\n')
        commandFenceOpen = true
      }

      const closeCommandFence = () => {
        if (!commandFenceOpen) return
        // Ensure the closing fence is on its own line (and leave a trailing blank line) even when command output does not end with a newline.
        emitContentDelta('\n```\n\n')
        commandFenceOpen = false
      }

      const ensureRole = (deltaPayload: Record<string, unknown>) => {
        if (!messageRoleEmitted) {
          deltaPayload.role = 'assistant'
          messageRoleEmitted = true
        }
      }

      const flushReasoning = () => {
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
        enqueueChunk(chunk)
        reasoningBuffer = carry
      }

      const startHeartbeat = () => {
        if (!enableHeartbeat) return
        heartbeatTimer = setInterval(() => {
          if (controllerClosed || aborted) return
          try {
            controller.enqueue(encoder.encode(': keepalive\n\n'))
          } catch {
            aborted = true
            controllerClosed = true
            interruptCodex()
            safeClose()
          }
        }, heartbeatIntervalMs)
      }

      try {
        const handleAbort = () => {
          aborted = true
          enqueueChunk({
            error: {
              message: 'request was aborted by the client',
              type: 'request_cancelled',
              code: 'client_abort',
            },
          })
          interruptCodex()
        }

        if (signal) {
          if (signal.aborted) {
            handleAbort()
            return
          }
          signal.addEventListener('abort', handleAbort, { once: true })
          abortControllers.push(() => signal.removeEventListener('abort', handleAbort))
        }

        abortControllers.push(() => {
          if (heartbeatTimer) clearInterval(heartbeatTimer)
        })
        startHeartbeat()

        class ConversationNotFoundError extends Error {
          readonly upstream: unknown

          constructor(upstream: unknown) {
            super('conversation not found')
            this.upstream = upstream
          }
        }

        const isConversationNotFoundError = (error: unknown): boolean => {
          if (!error) return false

          const includesConversationNotFound = (message: string) =>
            message.toLowerCase().includes('conversation not found')

          if (typeof error === 'string') return includesConversationNotFound(error)
          if (typeof error !== 'object') return false

          const record = error as Record<string, unknown>
          const code = record.code
          const message = record.message

          if (code === -32600 && typeof message === 'string') {
            return includesConversationNotFound(message)
          }
          if (typeof message === 'string' && includesConversationNotFound(message)) return true

          const nested = record.error
          if (nested && typeof nested === 'object') {
            const nestedRecord = nested as Record<string, unknown>
            const nestedCode = nestedRecord.code
            const nestedMessage = nestedRecord.message
            if (nestedCode === -32600 && typeof nestedMessage === 'string') {
              return includesConversationNotFound(nestedMessage)
            }
            if (typeof nestedMessage === 'string' && includesConversationNotFound(nestedMessage)) return true
          }

          return false
        }

        const clearStaleThread = async () => {
          if (!threadContext) return
          try {
            await pipe(threadContext.store.clearThread(threadContext.chatId), Effect.runPromise)
          } catch (error) {
            console.warn('[chat] failed to clear stale redis thread', {
              chatId: threadContext.chatId,
              error: String(error),
            })
          }
          threadContext.threadId = null
          threadContext.turnNumber = null
        }

        const runTurnAttempt = async (resumeThreadId: string | null, canRetry: boolean) => {
          sawUpstreamError = false
          turnFinished = false

          if (aborted || controllerClosed) {
            return
          }

          const {
            stream: codexStream,
            turnId,
            threadId,
          } = await client.runTurnStream(prompt, {
            model,
            cwd: codexCwd,
            threadId: resumeThreadId ?? undefined,
          })

          activeTurnId = turnId
          activeThreadId = threadId

          if (threadContext) {
            threadContext.threadId = threadId
          }

          if (pendingInterrupt || aborted || controllerClosed) {
            interruptTurn(turnId, threadId)
            return
          }

          if (threadContext?.chatId && threadContext.store) {
            try {
              await pipe(threadContext.store.setThread(threadContext.chatId, threadId), Effect.runPromise)
              await ensureTurnNumber()
              console.info('[chat] thread stored', {
                chatId: threadContext.chatId,
                threadId,
                turnNumber: threadContext.turnNumber ?? undefined,
              })
            } catch (error) {
              hadError = true
              enqueueChunk({
                error: {
                  message: 'failed to persist chat thread',
                  type: 'internal',
                  code: 'thread_store_error',
                  detail: error instanceof Error ? error.message : undefined,
                },
              })
              interruptCodex()
              return
            }
          }

          try {
            for await (const delta of codexStream) {
              if (aborted || controllerClosed) {
                interruptCodex()
                break
              }

              if (delta.type !== 'reasoning') {
                flushReasoning()
              }

              if (delta.type === 'usage') {
                closeCommandFence()
                if (includeUsageChunk) {
                  lastUsage = normalizeUsage(delta.usage)
                }
                continue
              }

              if (sawUpstreamError) {
                // After an upstream error we only care about trailing usage updates.
                continue
              }

              if (delta.type === 'error') {
                if (canRetry && !hasEmittedAnyChunk && isConversationNotFoundError(delta.error)) {
                  throw new ConversationNotFoundError(delta.error)
                }

                hadError = true
                sawUpstreamError = true
                closeCommandFence()
                enqueueChunk({ error: normalizeStreamError(delta.error) })
                // Keep listening for possible trailing usage.
                continue
              }

              if (delta.type === 'message') {
                closeCommandFence()
                const text = normalizeDeltaText(delta.delta)
                emitContentDelta(text)
              }

              if (delta.type === 'reasoning') {
                const text = sanitizeReasoningText(normalizeDeltaText(delta.delta))
                reasoningBuffer += text
                // Emit reasoning immediately to avoid long silent periods that can trip upstream timeouts.
                flushReasoning()
              }

              if (delta.type === 'tool') {
                const deltaRecord = delta as Record<string, unknown>
                const toolState = getToolState(deltaRecord)
                const argsPayload = formatToolArguments(toolState, deltaRecord)
                if (toolState.toolKind === 'file') {
                  closeCommandFence()
                  const status = typeof deltaRecord.status === 'string' ? deltaRecord.status : undefined

                  // Skip the start event to avoid duplicated summaries like "1 change(s)1 change(s)".
                  if (status === 'started') {
                    toolState.lastStatus = status
                    continue
                  }

                  const changes = Array.isArray((deltaRecord.data as { changes?: unknown } | undefined)?.changes)
                    ? (deltaRecord.data as { changes: unknown[] }).changes
                    : Array.isArray(deltaRecord.changes as unknown)
                      ? (deltaRecord.changes as unknown[])
                      : undefined

                  const content = renderFileChanges(changes) ?? formatToolContent(toolState, argsPayload)
                  if (!content) {
                    toolState.lastStatus = status
                    continue
                  }

                  // Avoid re-emitting identical apply_patch summaries across delta/completed events.
                  if (content === toolState.lastContent && status === toolState.lastStatus) {
                    continue
                  }

                  toolState.lastContent = content
                  toolState.lastStatus = status
                  emitContentDelta(content)
                  continue
                }
                if (toolState.toolKind === 'webSearch') {
                  closeCommandFence()
                  // Emit the attempted search term plainly, wrapped in backticks so UIs like
                  // OpenWebUI render it as a code span without extra prefixes/suffixes.
                  if (deltaRecord.status !== 'completed') {
                    const query =
                      (typeof toolState.title === 'string' && toolState.title.length > 0
                        ? toolState.title
                        : undefined) ??
                      (typeof argsPayload.detail === 'string' && argsPayload.detail.length > 0
                        ? argsPayload.detail
                        : undefined)
                    if (query) emitContentDelta(`\`${query}\``)
                  }
                  continue
                }

                if (toolState.toolKind === 'command') {
                  openCommandFence()
                  const status = typeof deltaRecord.status === 'string' ? deltaRecord.status : undefined
                  let content = formatToolContent(toolState, argsPayload)
                  // Ensure the initial command line is followed by a newline so subsequent output starts on a new line.
                  if (status === 'started' && content.length > 0 && !content.endsWith('\n')) {
                    content = `${content}\n\n`
                  }
                  const hasContent = content.length > 0
                  if (hasContent) emitContentDelta(content)
                } else {
                  closeCommandFence()
                  emitContentDelta(formatToolContent(toolState, argsPayload))
                }
              }
            }

            flushReasoning()
            if (!aborted) {
              turnFinished = true
            }
          } finally {
            if ((aborted || !turnFinished) && activeTurnId && activeThreadId) {
              interruptTurn(activeTurnId, activeThreadId)
            }
          }
        }

        let resumeThreadId = threadContext?.threadId ?? null
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await runTurnAttempt(resumeThreadId, attempt === 0 && resumeThreadId != null)
            break
          } catch (error) {
            const upstreamError = error instanceof ConversationNotFoundError ? error.upstream : error
            if (
              attempt === 0 &&
              resumeThreadId != null &&
              !hasEmittedAnyChunk &&
              isConversationNotFoundError(upstreamError)
            ) {
              console.warn('[chat] stale thread id detected; starting new thread', {
                chatId: threadContext?.chatId,
                threadId: resumeThreadId,
                upstream: safeJsonStringify(upstreamError),
              })
              await clearStaleThread()
              resumeThreadId = null
              continue
            }
            throw error
          }
        }
      } catch (error) {
        hadError = true
        const normalized = normalizeStreamError(error)
        enqueueChunk({
          error: {
            message: typeof normalized.message === 'string' ? normalized.message : safeJsonStringify(normalized),
            type: 'internal',
            code: 'codex_error',
          },
        })
      } finally {
        for (const removeAbort of abortControllers) removeAbort()

        closeCommandFence()

        if (includeUsageChunk && lastUsage && !controllerClosed) {
          enqueueChunk({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [],
            usage: lastUsage,
          })
        }

        if (!aborted && !hadError && turnFinished && !controllerClosed) {
          const finalChunk: Record<string, unknown> = {
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
          }

          enqueueChunk(finalChunk)
        }

        if (!controllerClosed) {
          try {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          } catch {
            // ignore
          }
          safeClose()
        }
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}

export const handleChatCompletion = async (request: Request): Promise<Response> => {
  try {
    const parsed = await parseRequest(request)
    const includeUsage = parsed.stream_options?.include_usage === true
    const chatIdHeader = request.headers.get('x-openwebui-chat-id')
    const chatId = typeof chatIdHeader === 'string' && chatIdHeader.trim().length > 0 ? chatIdHeader.trim() : null
    let threadStore: ChatThreadStore | null = null
    let threadId: string | null = null

    if (chatId) {
      try {
        threadStore = getThreadStore()
      } catch (error) {
        throw new RequestError(
          500,
          'thread_store_unavailable',
          error instanceof Error ? error.message : 'Chat thread store is not configured',
        )
      }
    }

    if (chatId && threadStore) {
      try {
        threadId = await pipe(threadStore.getThread(chatId), Effect.runPromise)
        console.info('[chat] chat id received', { chatId, threadId })
      } catch (error) {
        throw new RequestError(
          500,
          'thread_lookup_failed',
          error instanceof Error ? error.message : 'Unable to read chat thread state',
        )
      }
    }

    const threadContext: ThreadContext | null =
      chatId && threadStore
        ? {
            chatId,
            threadId,
            store: threadStore,
            turnNumber: null,
          }
        : null

    const { config, client } = await pipe(
      Effect.all({
        config: loadConfig,
        client: getCodexClient(),
      }),
      Effect.runPromise,
    )

    const model = parsed.model ?? config.defaultModel
    if (!config.models.includes(model)) {
      throw new RequestError(400, 'model_not_found', `Unknown model '${model}'. See /openai/v1/models.`)
    }

    const prompt = buildPrompt(parsed.messages)
    return toSseResponse(client, prompt, model, includeUsage, threadContext, request.signal)
  } catch (error) {
    if (error instanceof RequestError) {
      return sseError(
        { error: { message: error.message, type: 'invalid_request_error', code: error.code } },
        error.status,
      )
    }
    return sseError({ error: { message: 'Unknown error', type: 'internal', code: 'internal_error' } }, 500)
  }
}

export { setCodexClientFactory, resetCodexClient }
