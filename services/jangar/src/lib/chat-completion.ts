import type { StreamDelta } from '@proompteng/codex'

import { createDbClient } from '../db'
import type { ChatMessage, ChatRole } from '../types/persistence'
import { getAppServer } from './app-server'

type Message = { role: string; content: unknown }

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

const defaultCodexModel = 'gpt-5.1-codex-max'
const defaultUserId = 'openwebui'
const systemFingerprint = Bun.env.CODEX_SYSTEM_FINGERPRINT ?? null
const serviceTier = 'default'

const appServer = getAppServer(Bun.env.CODEX_BIN ?? 'codex', Bun.env.CODEX_CWD ?? process.cwd())

// Track Codex thread IDs per OpenWebUI chat so we can stream multiple turns without re-initializing.
const threadMap = new Map<string, string>()

const stripAnsi = (value: string) => {
  const esc = String.fromCharCode(27)
  return value.replace(new RegExp(`${esc}[[0-9;]*[mK]`, 'g'), '')
}

type ToolDelta = Extract<StreamDelta, { type: 'tool' }>

const formatToolDelta = (delta: ToolDelta): string => {
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

const buildPrompt = (messages?: Message[]) =>
  (messages ?? []).map((m) => `${m.role}: ${normalizeContent(m.content)}`).join('\n')

const estimateTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4))

const resolveModel = (requested?: string | null) => {
  if (!requested || requested === 'meta-orchestrator') return defaultCodexModel
  return requested
}

const deriveChatId = (body: ChatCompletionRequest) => body.chat_id

const deriveTitle = (chatId: string | undefined, messages?: Message[]) => {
  if (chatId) return `openwebui:${chatId}`
  const firstUser = (messages ?? []).find((m) => m.role === 'user')
  if (firstUser) {
    const text = normalizeContent(firstUser.content)
    return text.slice(0, 60) || 'OpenWebUI chat'
  }
  return 'OpenWebUI chat'
}

const syncHistory = async (
  db: Awaited<ReturnType<typeof createDbClient>>,
  sessionId: string,
  messages: Message[] | undefined,
  existing: ChatMessage[] | null,
): Promise<void> => {
  if (!messages?.length) return

  const already = existing?.length ?? 0
  const toAppend = messages.slice(already)
  for (const msg of toAppend) {
    await db.appendMessage({
      sessionId,
      role: (msg.role as ChatRole) ?? 'user',
      content: normalizeContent(msg.content),
    })
  }
  await db.updateSessionLastMessage(sessionId, Date.now())
}

const persistAssistant = async (sessionId: string, content: string) => {
  try {
    const db = await createDbClient()
    await db.appendMessage({ sessionId, role: 'assistant', content })
    await db.updateSessionLastMessage(sessionId, Date.now())
  } catch (error) {
    console.warn('[jangar] convex persistence failed for assistant message', error)
  }
}

type ReasoningPart = { type: 'text'; text: string }

type StreamOptions = {
  model?: string
  signal: AbortSignal
  onComplete?: (content: string, reasoning: ReasoningPart[]) => Promise<void>
  chatId: string
  includeUsage?: boolean
  threadId?: string
}

type TokenUsage = {
  input_tokens: number
  cached_input_tokens: number
  output_tokens: number
  reasoning_output_tokens: number
  total_tokens: number
}

const streamSse = async (prompt: string, opts: StreamOptions): Promise<Response> => {
  const targetModel = resolveModel(opts.model)
  const existingThreadId = opts.threadId ?? threadMap.get(opts.chatId)
  const { stream, threadId } = existingThreadId
    ? await appServer.runTurnStream({ prompt, model: targetModel, threadId: existingThreadId })
    : await appServer.runTurnStream({ prompt, model: targetModel })
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

  const formatToolDelta = (delta: Extract<StreamDelta, { type: 'tool' }>): string => {
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

  const body = new ReadableStream({
    start: async (controller) => {
      const send = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
      const sendDone = () => controller.enqueue(encoder.encode('data: [DONE]\n\n'))

      const abortHandler = () => {
        controller.close()
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
            continue
          }
          if ((delta as { type?: string }).type === 'error') {
            const err = (delta as { error: unknown }).error
            contentDelta = `[codex error] ${typeof err === 'string' ? err : JSON.stringify(err)}`
          }

          let toolDelta: ToolDelta | null = null
          if ((delta as { type?: string }).type === 'tool') {
            toolDelta = delta as ToolDelta
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

        if (opts.onComplete) await opts.onComplete(collected, reasoningParts)
      } catch (error) {
        console.error('[jangar] codex stream error', error)
        controller.error(error)
      } finally {
        controller.close()
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

    const model = resolveModel(body?.model)
    const userId = body?.user ?? defaultUserId
    const incomingChatId = deriveChatId(body ?? {})
    const chatId = incomingChatId ?? crypto.randomUUID()
    let promptMessages: Message[] | undefined = body?.messages

    console.info(`[jangar] ${pathLabel}`, {
      model,
      messageCount: body?.messages?.length ?? 0,
      stream: body?.stream ?? false,
      chatId,
      userId,
      incomingChatId,
    })

    let sessionId: string | null = null
    let existingMessages: ChatMessage[] | null = null
    try {
      const db = await createDbClient()
      const title = deriveTitle(chatId, body?.messages)
      const sessionsForUser = await db.listSessions(userId)
      const matched = sessionsForUser.find((s) => s.title === title)
      sessionId = matched?.id ?? (await db.createSession(userId, title))
      if (!sessionId) throw new Error('failed to resolve session id')
      existingMessages = await db.listMessages(sessionId)
      await syncHistory(db, sessionId, body?.messages ?? [], existingMessages)
      if ((!promptMessages || promptMessages.length === 0) && existingMessages?.length) {
        promptMessages = existingMessages.map((m) => ({ role: m.role, content: m.content }))
      }
      console.info('[jangar][chat]', {
        userId,
        chatId,
        sessionId,
        incomingMessages: body?.messages?.length ?? 0,
        storedMessages: existingMessages?.length ?? 0,
      })
    } catch (error) {
      console.warn('[jangar] convex persistence unavailable; continuing without DB', error)
    }

    const prompt = buildPrompt(promptMessages)

    const includeUsage = body?.stream_options?.include_usage === true

    if (body?.stream) {
      try {
        const existingThreadId = threadMap.get(chatId)
        const sseOptions: StreamOptions = existingThreadId
          ? {
              model,
              signal: request.signal,
              chatId,
              includeUsage,
              threadId: existingThreadId,
            }
          : {
              model,
              signal: request.signal,
              chatId,
              includeUsage,
            }

        if (sessionId) {
          sseOptions.onComplete = async (text: string) => {
            await persistAssistant(sessionId as string, text)
          }
        }

        return await streamSse(prompt, sseOptions)
      } catch (error) {
        console.error('[jangar] codex app-server stream error', error)
        return new Response(JSON.stringify({ error: 'codex app-server failed', details: `${error}` }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      }
    }

    // Non-streaming: reuse streaming plumbing to capture reasoning and message content accurately.
    try {
      const existingThreadId = threadMap.get(chatId)
      const { stream, threadId } = await appServer.runTurnStream(
        existingThreadId ? { prompt, model, threadId: existingThreadId } : { prompt, model },
      )
      if (!existingThreadId) threadMap.set(chatId, threadId)
      let text = ''
      const reasoningParts: ReasoningPart[] = []
      let lastMessageChunk: string | null = null
      let lastReasoningChunk: string | null = null
      let latestUsage: TokenUsage | null = null
      for await (const delta of stream) {
        if ((delta as { type?: string }).type === 'usage') {
          latestUsage = (delta as { usage: TokenUsage }).usage
          continue
        }
        if (typeof delta === 'string') {
          if (delta !== lastMessageChunk) {
            const clean = stripAnsi(delta)
            text += clean
            lastMessageChunk = clean
          }
        } else if ((delta as { type?: string }).type === 'message') {
          const chunk = stripAnsi((delta as { delta: string }).delta)
          if (chunk !== lastMessageChunk) {
            text += chunk
            lastMessageChunk = chunk
          }
        } else if ((delta as { type?: string }).type === 'reasoning') {
          const chunk = stripAnsi((delta as { delta: string }).delta)
          if (chunk !== lastReasoningChunk) {
            reasoningParts.push({ type: 'text', text: chunk })
            lastReasoningChunk = chunk
          }
        } else if ((delta as { type?: string }).type === 'tool') {
          text += `\n${formatToolDelta(delta as Extract<StreamDelta, { type: 'tool' }>)}\n`
        }
      }

      if (sessionId) await persistAssistant(sessionId, text)

      const promptTokens = includeUsage ? (latestUsage?.input_tokens ?? estimateTokens(prompt)) : undefined
      const completionTokens = includeUsage ? (latestUsage?.output_tokens ?? estimateTokens(text)) : undefined

      const responseBody = JSON.stringify({
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        system_fingerprint: systemFingerprint,
        service_tier: serviceTier,
        chat_id: chatId,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant' as const,
              content: text,
              refusal: null,
              reasoning_content: reasoningParts.length ? reasoningParts : undefined,
            },
            finish_reason: 'stop' as const,
            logprobs: null,
          },
        ],
        ...(includeUsage
          ? {
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: (promptTokens ?? 0) + (completionTokens ?? 0),
                prompt_tokens_details: {
                  cached_tokens: latestUsage?.cached_input_tokens ?? 0,
                  audio_tokens: 0,
                },
                completion_tokens_details: {
                  reasoning_tokens:
                    latestUsage?.reasoning_output_tokens ??
                    (reasoningParts.length ? estimateTokens(reasoningParts.map((p) => p.text).join(' ')) : 0),
                  audio_tokens: 0,
                  accepted_prediction_tokens: 0,
                  rejected_prediction_tokens: 0,
                },
              },
            }
          : {}),
      })

      return new Response(responseBody, {
        headers: {
          'content-type': 'application/json',
          'content-length': String(responseBody.length),
        },
      })
    } catch (error) {
      console.error('[jangar] codex app-server error', error)
      return new Response(JSON.stringify({ error: 'codex app-server failed', details: `${error}` }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    }
  }
}
