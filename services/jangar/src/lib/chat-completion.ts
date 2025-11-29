import type { StreamDelta } from '@proompteng/codex'

import { createDbClient } from '../db'
import { getAppServer } from './app-server'
import { isSupportedModel, resolveModel, supportedModels } from './models'

export type Message = { role: string; content: unknown }

export type ChatCompletionRequest = {
  messages?: Message[]
  model?: string
  stream?: boolean
  user?: string
  chat_id?: string
  stream_options?: {
    include_usage?: boolean
  }
}

const defaultUserId = 'openwebui'
const systemFingerprint = Bun.env.CODEX_SYSTEM_FINGERPRINT ?? null
const serviceTier = 'default'

const defaultContextWindowMessage =
  "Codex ran out of room in the model's context window. Start a new conversation or clear earlier history before retrying."

let sharedAppServer: ReturnType<typeof getAppServer> | null = null
const resolveAppServer = () => {
  if (!sharedAppServer) {
    sharedAppServer = getAppServer(Bun.env.CODEX_BIN ?? 'codex', Bun.env.CODEX_CWD ?? process.cwd())
  }
  return sharedAppServer
}

export const createSafeEnqueuer = (
  controller: Pick<ReadableStreamDefaultController<Uint8Array>, 'enqueue' | 'close'>,
) => {
  let controllerClosed = false
  const safeEnqueue = (chunk: Uint8Array) => {
    if (controllerClosed) return
    try {
      controller.enqueue(chunk)
    } catch (error) {
      controllerClosed = true
      console.warn('[jangar] stream enqueue after close', error)
    }
  }
  const closeIfOpen = () => {
    if (controllerClosed) return
    controllerClosed = true
    try {
      controller.close()
    } catch (error) {
      console.warn('[jangar] failed to close controller', error)
    }
  }
  const isClosed = () => controllerClosed
  return { safeEnqueue, closeIfOpen, isClosed }
}

// Track Codex thread IDs per OpenWebUI chat so we can stream multiple turns without re-initializing.
const threadMap = new Map<string, string>()
// Track last chatId per user for cases where chat_id is omitted on follow-ups.
const lastChatIdForUser = new Map<string, string>()

export const stripAnsi = (value: string) => {
  const esc = String.fromCharCode(27)
  return value.replace(new RegExp(`${esc}[[0-9;]*[mK]`, 'g'), '')
}

type ToolDelta = Extract<StreamDelta, { type: 'tool' }>

export const formatToolDelta = (delta: ToolDelta): string => {
  const statusLabel = delta.status === 'delta' ? '' : ` [${delta.status}]`
  const kind =
    delta.toolKind === 'command'
      ? 'cmd'
      : delta.toolKind === 'file'
        ? 'file'
        : delta.toolKind === 'mcp'
          ? 'tool'
          : 'search'
  const detail = delta.detail ? stripAnsi(delta.detail) : ''

  // For streaming command output, wrap in a code fence (TypeScript for readability).
  if (delta.toolKind === 'command' && delta.status === 'delta' && detail) {
    return detail.trim().length ? `\n\n\`\`\`ts\n${detail}\n\`\`\`\n` : detail
  }

  // For non-command deltas, still pass raw progress text through.
  if (delta.status === 'delta' && detail) return detail

  const suffix = detail ? ` — ${detail}` : ''

  if (delta.toolKind === 'command') {
    const rawStatus = statusLabel ? statusLabel.trim().replace(/\[|\]/g, '') : delta.status
    const normalizedStatus = rawStatus === 'started' ? 'start' : rawStatus === 'completed' ? 'end' : rawStatus
    const rendered = `[${normalizedStatus}] ${stripAnsi(delta.title)}${detail ? ` in ${detail}` : ''}`
    return `\n\`\`\`bash\n${rendered}\n\`\`\`\n`
  }

  const title = stripAnsi(delta.title)
  return `\n(${kind}${statusLabel}) ${title}${suffix}\n`
}

const normalizeContent = (content: unknown) => (typeof content === 'string' ? content : JSON.stringify(content))

export const buildPrompt = (messages?: Message[]) =>
  (messages ?? []).map((m) => `${m.role}: ${normalizeContent(m.content)}`).join('\n')

export const estimateTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4))

export const deriveChatId = (body: ChatCompletionRequest) => body.chat_id

type TokenUsage = {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  total_tokens?: number
}

type PersistMeta = {
  threadId?: string
  turnId?: string
  tokenUsage?: TokenUsage | null
  reasoningSummary?: string[]
}

const buildUsagePayload = (turnId: string, usage?: TokenUsage | null) => {
  const payload: Record<string, unknown> = { turnId, capturedAt: Date.now() }
  if (!usage) return payload
  if (usage.input_tokens !== undefined) payload.totalInputTokens = usage.input_tokens
  if (usage.cached_input_tokens !== undefined) payload.cachedInputTokens = usage.cached_input_tokens
  if (usage.output_tokens !== undefined) payload.outputTokens = usage.output_tokens
  if (usage.reasoning_output_tokens !== undefined) payload.reasoningOutputTokens = usage.reasoning_output_tokens
  if (usage.total_tokens !== undefined) payload.totalTokens = usage.total_tokens
  return payload
}

const commandSeq = new Map<string, number>()

type NormalizedCodexError = { message: string | null; codexErrorInfo: string | null }

const parseCodexError = (error: unknown): NormalizedCodexError | null => {
  const candidates: Array<unknown> = [error]

  if (error instanceof Error) {
    candidates.push(error.message)
    if (error.cause) candidates.push(error.cause)
  }

  const tryParse = (value: unknown): Record<string, unknown> | null => {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as Record<string, unknown>
      } catch {
        return null
      }
    }
    if (value && typeof value === 'object') return value as Record<string, unknown>
    return null
  }

  for (const candidate of candidates) {
    const parsed = tryParse(candidate)
    if (!parsed) {
      const raw = typeof candidate === 'string' ? candidate : null
      if (raw?.includes('contextWindowExceeded')) {
        return { message: raw, codexErrorInfo: 'contextWindowExceeded' }
      }
      continue
    }

    const nestedError = tryParse(parsed.error ?? null)
    const codexErrorInfo =
      typeof parsed.codexErrorInfo === 'string'
        ? parsed.codexErrorInfo
        : typeof nestedError?.codexErrorInfo === 'string'
          ? nestedError.codexErrorInfo
          : null
    const message =
      typeof parsed.message === 'string'
        ? parsed.message
        : typeof nestedError?.message === 'string'
          ? nestedError.message
          : null

    if (codexErrorInfo || message) return { message, codexErrorInfo }
  }

  return null
}

const buildContextWindowExceededResponse = (message: string) =>
  new Response(
    JSON.stringify({
      error: {
        message,
        type: 'invalid_request_error',
        code: 'context_window_exceeded',
      },
    }),
    {
      status: 400,
      headers: { 'content-type': 'application/json' },
    },
  )

const persistFailedTurn = async (
  db: Awaited<ReturnType<typeof createDbClient>>,
  {
    turnId,
    conversationId,
    chatId,
    userId,
    model,
    startedAt,
  }: {
    turnId: string
    conversationId: string
    chatId: string
    userId: string
    model?: string | null
    startedAt: number
  },
  errorMessage: string,
  eventMethod: string = 'turn/error',
) => {
  try {
    await db.upsertTurn({
      turnId,
      conversationId,
      chatId,
      userId,
      model: model ?? '',
      serviceTier,
      status: 'failed',
      error: errorMessage,
      startedAt,
      endedAt: Date.now(),
    })
    await db.appendEvent({
      conversationId,
      turnId,
      method: eventMethod,
      payload: { error: errorMessage },
      receivedAt: Date.now(),
    })
  } catch (persistError) {
    console.error('[jangar] failed to persist turn error', persistError)
  }
}

const persistToolDelta = async (
  db: Awaited<ReturnType<typeof createDbClient>>,
  turnId: string,
  conversationId: string,
  delta: ToolDelta,
) => {
  const callId = delta.id ?? `tool-${crypto.randomUUID()}`
  const now = Date.now()

  await db.appendEvent({
    conversationId,
    turnId,
    method: 'tool',
    payload: delta,
    receivedAt: now,
  })

  if (delta.status === 'started') {
    await db.upsertCommand({
      callId,
      turnId,
      command: [stripAnsi(delta.title)],
      source: delta.toolKind,
      parsedCmd: delta.detail ? { detail: stripAnsi(delta.detail) } : undefined,
      status: 'started',
      startedAt: now,
      chunked: true,
    })
    return
  }

  if (delta.status === 'delta' && delta.detail) {
    const seq = (commandSeq.get(callId) ?? 0) + 1
    commandSeq.set(callId, seq)
    await db.appendCommandChunk({
      callId,
      stream: delta.toolKind === 'command' ? 'stdout' : 'stdout',
      seq,
      chunkBase64: Buffer.from(stripAnsi(delta.detail)).toString('base64'),
      createdAt: now,
    })
    await db.upsertCommand({
      callId,
      turnId,
      command: [stripAnsi(delta.title)],
      source: delta.toolKind,
      status: 'running',
      startedAt: now,
      chunked: true,
    })
    return
  }

  // completed/failed/etc.
  await db.upsertCommand({
    callId,
    turnId,
    command: [stripAnsi(delta.title)],
    source: delta.toolKind,
    status: delta.status,
    startedAt: now,
    endedAt: now,
    chunked: true,
  })
}

const persistAssistant = async (turnId: string, content: string, meta?: PersistMeta) => {
  try {
    const db = await createDbClient()
    await db.appendAssistantMessageWithMeta(turnId, content, meta)
  } catch (error) {
    console.warn('[jangar] convex persistence failed for assistant message', error)
  }
}

type ReasoningPart = { type: 'text'; text: string }

type StreamOptions = {
  model?: string
  signal: AbortSignal
  onComplete?: (content: string, reasoning: ReasoningPart[], meta: PersistMeta) => Promise<void>
  chatId: string
  includeUsage?: boolean
  threadId?: string
  db: Awaited<ReturnType<typeof createDbClient>>
  conversationId: string
  turnId: string
  userId: string
  startedAt: number
}

const streamSse = async (prompt: string, opts: StreamOptions): Promise<Response> => {
  const appServer = resolveAppServer()
  const targetModel = resolveModel(opts.model)
  const existingThreadId = opts.threadId ?? threadMap.get(opts.chatId)
  let streamHandle: Awaited<ReturnType<ReturnType<typeof getAppServer>['runTurnStream']>>
  try {
    streamHandle = existingThreadId
      ? await appServer.runTurnStream({ prompt, model: targetModel, threadId: existingThreadId })
      : await appServer.runTurnStream({ prompt, model: targetModel })
  } catch (error) {
    const codexError = parseCodexError(error)
    if (codexError?.codexErrorInfo === 'contextWindowExceeded') {
      threadMap.delete(opts.chatId)
      const message = codexError.message ?? defaultContextWindowMessage
      await persistFailedTurn(
        opts.db,
        {
          turnId: opts.turnId,
          conversationId: opts.conversationId,
          chatId: opts.chatId,
          userId: opts.userId,
          model: targetModel,
          startedAt: opts.startedAt,
        },
        message,
      )
      return buildContextWindowExceededResponse(message)
    }
    throw error
  }

  const { stream, threadId, turnId } = streamHandle
  if (!existingThreadId) threadMap.set(opts.chatId, threadId)
  const encoder = new TextEncoder()
  const created = Math.floor(Date.now() / 1000)
  const id = `chatcmpl-${crypto.randomUUID()}`
  let sentFirstDelta = false
  let collected = ''
  const promptTokens = estimateTokens(prompt)
  const reasoningParts: ReasoningPart[] = []
  let lastMessageChunk: string | null = null
  let lastReasoningChunk: string | null = null
  let latestUsage: TokenUsage | null = null

  const body = new ReadableStream({
    start: async (controller) => {
      const { safeEnqueue, closeIfOpen } = createSafeEnqueuer(controller)

      const send = (payload: unknown) => safeEnqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
      const sendDone = () => safeEnqueue(encoder.encode('data: [DONE]\n\n'))
      const streamTimeoutMs = Number(Bun.env.JANGAR_STREAM_TIMEOUT_MS ?? '300000')
      const timeoutId = setTimeout(() => {
        threadMap.delete(opts.chatId)
        send({
          error: {
            message: `stream timeout after ${streamTimeoutMs}ms`,
            type: 'timeout',
            code: 'stream_timeout',
          },
        })
        sendDone()
        closeIfOpen()
        try {
          stream.return?.(undefined)
        } catch (error) {
          console.warn('[jangar] failed to return stream on timeout', error)
        }
      }, streamTimeoutMs)

      const abortHandler = () => {
        threadMap.delete(opts.chatId)
        // Emit an SSE end marker so clients don't treat abort as truncation.
        send({ error: { message: 'client aborted', type: 'aborted' } })
        sendDone()
        closeIfOpen()
        try {
          stream.return?.(undefined)
        } catch (error) {
          console.warn('[jangar] failed to return stream on abort', error)
        }
      }
      opts.signal.addEventListener('abort', abortHandler, { once: true })

      try {
        for await (const delta of stream) {
          let contentDelta: string | null = null
          let reasoningDelta: string | null = null

          if ((delta as { type?: string }).type === 'usage') {
            latestUsage = (delta as { usage: TokenUsage }).usage
            await opts.db.appendUsage(buildUsagePayload(opts.turnId, latestUsage) as never)
            await opts.db.appendEvent({
              conversationId: opts.conversationId,
              turnId: opts.turnId,
              method: 'usage',
              payload: latestUsage,
              receivedAt: Date.now(),
            })
            continue
          }
          if ((delta as { type?: string }).type === 'error') {
            const err = (delta as { error: unknown }).error
            contentDelta = `[codex error] ${typeof err === 'string' ? err : JSON.stringify(err)}`
          }

          let toolDelta: ToolDelta | null = null
          if ((delta as { type?: string }).type === 'tool') {
            toolDelta = delta as ToolDelta
            await persistToolDelta(opts.db, opts.turnId, opts.conversationId, toolDelta)
          }

          if (typeof delta === 'string') contentDelta = stripAnsi(delta)
          else if ((delta as { type?: string }).type === 'message')
            contentDelta = stripAnsi((delta as { delta: string }).delta)
          else if ((delta as { type?: string }).type === 'reasoning')
            reasoningDelta = stripAnsi((delta as { delta: string }).delta)
          else if (
            typeof delta === 'object' &&
            delta !== null &&
            'type' in delta &&
            'delta' in delta &&
            typeof (delta as { delta: unknown }).delta === 'string'
          ) {
            contentDelta = stripAnsi((delta as { delta: string }).delta)
          }

          if (toolDelta) {
            if (toolDelta.status === 'delta' && toolDelta.detail) {
              contentDelta = formatToolDelta(toolDelta)
            } else if (toolDelta.status !== 'delta') {
              contentDelta = formatToolDelta(toolDelta)
            }
          }

          if (contentDelta === lastMessageChunk) contentDelta = null
          if (reasoningDelta === lastReasoningChunk) reasoningDelta = null

          if (contentDelta) {
            collected += contentDelta
            lastMessageChunk = contentDelta
          }
          if (reasoningDelta) {
            reasoningParts.push({ type: 'text', text: reasoningDelta })
            lastReasoningChunk = reasoningDelta
          }
          type ChoiceDelta = {
            role?: 'assistant'
            content?: string | undefined
            reasoning_content?: string | undefined
            refusal: null
            tool_calls?: Array<{
              id: string
              type: 'function'
              function: { name: string; arguments: string }
            }>
          }

          const chunk: {
            id: string
            object: string
            created: number
            model: string
            system_fingerprint: string | null
            service_tier: string
            chat_id: string
            choices: Array<{
              index: number
              delta: ChoiceDelta
              finish_reason: null
              logprobs: null
            }>
          } = {
            id,
            object: 'chat.completion.chunk',
            created,
            model: targetModel,
            system_fingerprint: systemFingerprint,
            service_tier: serviceTier,
            chat_id: opts.chatId,
            choices: [
              {
                index: 0,
                delta: (sentFirstDelta
                  ? {
                      content: contentDelta ?? undefined,
                      reasoning_content: reasoningDelta ?? undefined,
                      refusal: null,
                    }
                  : {
                      role: 'assistant',
                      content: contentDelta ?? undefined,
                      reasoning_content: reasoningDelta ?? undefined,
                      refusal: null,
                    }) as ChoiceDelta,
                finish_reason: null,
                logprobs: null,
              },
            ],
          }

          if (toolDelta && toolDelta.status === 'started') {
            const id = toolDelta.id || `tool_${crypto.randomUUID()}`
            const name =
              toolDelta.toolKind === 'command'
                ? 'command_execution'
                : toolDelta.toolKind === 'file'
                  ? 'file_change'
                  : toolDelta.toolKind === 'mcp'
                    ? 'mcp_tool_call'
                    : 'web_search'
            const args = {
              title: stripAnsi(toolDelta.title),
              detail: toolDelta.detail ? stripAnsi(toolDelta.detail) : undefined,
              status: toolDelta.status,
            }

            const choice = chunk.choices[0]
            if (choice?.delta) {
              choice.delta.tool_calls = [
                {
                  id,
                  type: 'function',
                  function: {
                    name,
                    arguments: JSON.stringify(args, (_k, v) => (v === undefined ? undefined : v)),
                  },
                },
              ]
            }
          }
          send(chunk)
          sentFirstDelta = true
        }

        const completionTokens = estimateTokens(collected)
        const usageFromServer = latestUsage
        const doneChunk = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: targetModel,
          system_fingerprint: systemFingerprint,
          service_tier: serviceTier,
          chat_id: opts.chatId,
          choices: [
            {
              index: 0,
              delta: { reasoning_content: undefined, refusal: null },
              finish_reason: 'stop' as const,
              logprobs: null,
            },
          ],
          ...(opts.includeUsage
            ? {
                usage: {
                  prompt_tokens: usageFromServer?.input_tokens ?? promptTokens,
                  completion_tokens: usageFromServer?.output_tokens ?? completionTokens,
                  total_tokens:
                    (usageFromServer?.input_tokens ?? promptTokens) +
                    (usageFromServer?.output_tokens ?? completionTokens),
                  prompt_tokens_details: {
                    cached_tokens: usageFromServer?.cached_input_tokens ?? 0,
                    audio_tokens: 0,
                  },
                  completion_tokens_details: {
                    reasoning_tokens:
                      usageFromServer?.reasoning_output_tokens ??
                      (reasoningParts.length ? estimateTokens(reasoningParts.map((p) => p.text).join(' ')) : 0),
                    audio_tokens: 0,
                    accepted_prediction_tokens: 0,
                    rejected_prediction_tokens: 0,
                  },
                },
              }
            : {}),
        }
        send(doneChunk)
        sendDone()

        if (opts.onComplete)
          await opts.onComplete(collected, reasoningParts, {
            threadId,
            turnId,
            tokenUsage: latestUsage,
            reasoningSummary: reasoningParts.map((p) => p.text),
          })
      } catch (error) {
        const codexError = parseCodexError(error)
        threadMap.delete(opts.chatId)

        if (codexError?.codexErrorInfo === 'contextWindowExceeded') {
          const message = codexError.message ?? defaultContextWindowMessage
          await persistFailedTurn(
            opts.db,
            {
              turnId: opts.turnId,
              conversationId: opts.conversationId,
              chatId: opts.chatId,
              userId: opts.userId,
              model: targetModel,
              startedAt: opts.startedAt,
            },
            message,
            'stream/error',
          )
          send({
            error: { message, type: 'invalid_request_error', code: 'context_window_exceeded' },
          })
          sendDone()
          return
        }

        console.error('[jangar] codex stream error', error)
        await persistFailedTurn(
          opts.db,
          {
            turnId: opts.turnId,
            conversationId: opts.conversationId,
            chatId: opts.chatId,
            userId: opts.userId,
            model: targetModel,
            startedAt: opts.startedAt,
          },
          `${error}`,
          'stream/error',
        )

        const message =
          error instanceof Error
            ? error.message
            : typeof error === 'string'
              ? error
              : 'streaming error (unexpected end)'
        send({ error: { message, type: 'server_error' } })
        sendDone()
        return
      } finally {
        clearTimeout(timeoutId)
        closeIfOpen()
      }
    },
  })

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}

export const createChatCompletionHandler = (pathLabel: string) => {
  return async ({ request }: { request: Request }): Promise<Response> => {
    let body: ChatCompletionRequest | null = null
    try {
      body = (await request.json()) as ChatCompletionRequest
    } catch {
      // ignore parse errors; return stub anyway
    }

    const requestedModel = body?.model
    const model = resolveModel(requestedModel)
    const userId = body?.user ?? defaultUserId
    const incomingChatId = deriveChatId(body ?? {})
    const chatId = incomingChatId ?? lastChatIdForUser.get(userId) ?? crypto.randomUUID()
    const conversationId = chatId
    const turnId = crypto.randomUUID()
    const startedAt = Date.now()
    const promptMessages: Message[] | undefined = body?.messages

    const requestedStream = body?.stream
    const acceptedStream = requestedStream === true

    console.info(`[jangar] ${pathLabel}`, {
      model,
      messageCount: body?.messages?.length ?? 0,
      requestedStream,
      acceptedStream,
      streamRequired: true,
      chatId,
      userId,
      incomingChatId,
    })

    if (requestedModel && !isSupportedModel(requestedModel)) {
      const message = `Unsupported model "${requestedModel}". Supported models: ${supportedModels.join(', ')}`
      const payload = { error: { message, type: 'invalid_request_error', code: 'model_not_supported' } }
      threadMap.delete(chatId)
      const encoder = new TextEncoder()
      const errorStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(errorStream, {
        status: 400,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        },
      })
    }

    lastChatIdForUser.set(userId, chatId)

    const db = await createDbClient()
    await db.upsertConversation({
      conversationId,
      threadId: threadMap.get(chatId) ?? '',
      modelProvider: 'codex',
      clientName: 'jangar',
      at: startedAt,
    })
    await db.upsertTurn({
      turnId,
      conversationId,
      chatId,
      userId,
      model,
      serviceTier,
      status: 'running',
      startedAt,
    })
    // Persist all provided messages (order preserved).
    for (const msg of promptMessages ?? []) {
      await db.appendMessage({
        turnId,
        role: msg.role,
        content: normalizeContent(msg.content),
        createdAt: startedAt,
      })
    }

    const prompt = buildPrompt(promptMessages)

    const includeUsage = body?.stream_options?.include_usage === true

    if (body?.stream !== true) {
      const payload = {
        error: {
          message: 'Streaming only: set stream=true',
          type: 'invalid_request_error',
          code: 'stream_required',
        },
      }
      threadMap.delete(chatId)
      const encoder = new TextEncoder()
      const errorStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(errorStream, {
        status: 400,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        },
      })
    }

    try {
      const existingThreadId = threadMap.get(chatId)
      const sseOptions: StreamOptions = existingThreadId
        ? {
            model,
            signal: request.signal,
            chatId,
            includeUsage,
            threadId: existingThreadId,
            db,
            conversationId,
            turnId,
            userId,
            startedAt,
          }
        : {
            model,
            signal: request.signal,
            chatId,
            includeUsage,
            db,
            conversationId,
            turnId,
            userId,
            startedAt,
          }

      sseOptions.onComplete = async (text: string, reasoning, meta) => {
        await db.upsertConversation({
          conversationId,
          threadId: meta.threadId ?? threadMap.get(chatId) ?? '',
          modelProvider: 'codex',
          clientName: 'jangar',
          at: Date.now(),
        })

        for (const [idx, r] of reasoning.entries()) {
          await db.appendReasoning({
            turnId,
            itemId: `${turnId}-reasoning-${idx}`,
            summaryText: [r.text],
            position: idx,
            createdAt: Date.now(),
          })
        }

        if (meta.tokenUsage) {
          await db.appendUsage(buildUsagePayload(turnId, meta.tokenUsage) as never)
        }

        await persistAssistant(turnId, text, meta)
        await db.upsertTurn({
          turnId,
          conversationId,
          chatId,
          userId,
          model: model ?? '',
          serviceTier,
          status: 'succeeded',
          startedAt,
          endedAt: Date.now(),
        })
      }

      return await streamSse(prompt, sseOptions)
    } catch (error) {
      console.error('[jangar] codex app-server stream error', error)
      threadMap.delete(chatId)

      const encoder = new TextEncoder()
      const errorStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ error: 'codex app-server failed', details: `${error}` })}\n\n`),
          )
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      })

      return new Response(errorStream, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        },
      })
    }
  }
}
