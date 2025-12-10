import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as S from '@effect/schema/Schema'
import type { CodexAppServerClient } from '@proompteng/codex'
import { Effect, pipe } from 'effect'

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

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })

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
    throw new RequestError(400, 'invalid_request_error', String(error))
  }

  if (!parsed.messages.length) {
    throw new RequestError(400, 'messages_required', '`messages` must be a non-empty array')
  }

  if (parsed.stream !== true) {
    throw new RequestError(400, 'stream_required', '`stream` must be true for streaming responses')
  }
  return parsed
}

const buildPrompt = (messages: ChatRequest['messages']) =>
  messages
    .map((msg) => `${msg.role}: ${typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}`)
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
  const totals =
    (usage.total && typeof usage.total === 'object' ? (usage.total as Record<string, unknown>) : null) ?? usage
  const last = usage.last && typeof usage.last === 'object' ? (usage.last as Record<string, unknown>) : null
  const source = Object.keys(totals).length ? totals : (last ?? totals)

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

const resolveCodexCwd = () => {
  const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  return process.env.CODEX_CWD ?? (process.env.NODE_ENV === 'production' ? '/workspace/lab' : defaultRepoRoot)
}

const toSseResponse = (client: CodexAppServerClient, prompt: string, model: string, signal?: AbortSignal) => {
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
      let lastUsage: Record<string, unknown> | null = null
      let turnFinished = false

      const interruptCodex = () => {
        if (activeTurnId && activeThreadId) {
          void client.interruptTurn(activeTurnId, activeThreadId).catch(() => {})
        }
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

      const enqueueChunk = (chunk: unknown) => {
        if (controllerClosed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
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
      let lastCommandId: string | null = null
      let hasEmittedAnyCommand = false
      let hadError = false
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null

      type ToolState = {
        id: string
        index: number
        toolKind: string
        title?: string
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

      const _emitToolCallDelta = (toolState: ToolState, args: string) => {
        const deltaPayload: Record<string, unknown> = {
          tool_calls: [
            {
              index: toolState.index,
              id: toolState.id,
              type: 'function',
              function: {
                name: toolState.toolKind,
                arguments: args,
              },
            },
          ],
        }
        ensureRole(deltaPayload)
        enqueueChunk({
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
        })
      }

      const emitContentDelta = (content: string) => {
        const deltaPayload: Record<string, unknown> = { content }
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
      }

      const openCommandFence = () => {
        if (commandFenceOpen) return
        emitContentDelta('```\n')
        commandFenceOpen = true
        lastCommandId = null
      }

      const closeCommandFence = () => {
        if (!commandFenceOpen) return
        emitContentDelta('\n```\n')
        commandFenceOpen = false
        lastCommandId = null
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

        const sanitized = sanitizeReasoningText(reasoningBuffer)
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

        await Effect.runPromise(
          Effect.acquireUseRelease(
            Effect.promise(() => client.runTurnStream(prompt, { model, cwd: codexCwd })),
            ({ stream: codexStream, turnId, threadId }) =>
              Effect.promise(async () => {
                activeTurnId = turnId
                activeThreadId = threadId

                for await (const delta of codexStream) {
                  if (aborted || controllerClosed) {
                    interruptCodex()
                    break
                  }

                  if (delta.type !== 'reasoning') {
                    flushReasoning()
                  }

                  if (delta.type === 'error') {
                    hadError = true
                    const errorPayload = {
                      error:
                        delta.error && typeof delta.error === 'object'
                          ? delta.error
                          : { message: String(delta.error ?? 'upstream error'), type: 'upstream' },
                    }
                    enqueueChunk(errorPayload)
                    turnFinished = true
                    break
                  }

                  if (delta.type === 'message') {
                    closeCommandFence()
                    const text = normalizeDeltaText(delta.delta)
                    const deltaPayload: Record<string, unknown> = { content: text }
                    ensureRole(deltaPayload)
                    enqueueChunk({
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
                    })
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
                    if (toolState.toolKind === 'command') {
                      openCommandFence()
                      const content = formatToolContent(toolState, argsPayload)
                      const isNewCommand = lastCommandId !== toolState.id
                      if (hasEmittedAnyCommand && isNewCommand) {
                        emitContentDelta('\n---\n')
                      }
                      const prefixed =
                        deltaRecord.status === 'started' && content.length > 0 ? `${content}\n\n` : content
                      if (prefixed.length > 0) emitContentDelta(prefixed)
                      lastCommandId = toolState.id
                      hasEmittedAnyCommand = true
                    } else {
                      closeCommandFence()
                      emitContentDelta(formatToolContent(toolState, argsPayload))
                    }
                  }

                  if (delta.type === 'usage') {
                    closeCommandFence()
                    lastUsage = normalizeUsage(delta.usage)
                  }
                }

                flushReasoning()
                if (!aborted) {
                  turnFinished = true
                }
              }),
            ({ turnId, threadId }) =>
              aborted || !turnFinished
                ? Effect.sync(() => {
                    void client.interruptTurn(turnId, threadId).catch(() => {})
                  })
                : Effect.succeed(undefined),
          ),
        )
      } catch (error) {
        hadError = true
        const payload = {
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: 'internal',
            code: 'codex_error',
          },
        }
        enqueueChunk(payload)
      } finally {
        for (const removeAbort of abortControllers) removeAbort()

        closeCommandFence()

        if (!aborted && !hadError && turnFinished) {
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

          if (lastUsage) {
            finalChunk.usage = lastUsage
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

    return await pipe(
      Effect.all({
        config: loadConfig,
        client: getCodexClient(),
      }),
      Effect.flatMap(({ config, client }) =>
        Effect.promise(() => {
          const model = parsed.model ?? config.defaultModel
          const prompt = buildPrompt(parsed.messages)
          return Promise.resolve(toSseResponse(client, prompt, model, request.signal))
        }),
      ),
      Effect.runPromise,
    )
  } catch (error) {
    if (error instanceof RequestError) {
      return error.code === 'stream_required'
        ? sseError({ error: { message: error.message, type: 'invalid_request_error', code: error.code } }, error.status)
        : jsonResponse(
            { error: { message: error.message, type: 'invalid_request_error', code: error.code } },
            error.status,
          )
    }
    return jsonResponse({ error: { message: 'Unknown error', type: 'internal' } }, 500)
  }
}

export { setCodexClientFactory, resetCodexClient }
