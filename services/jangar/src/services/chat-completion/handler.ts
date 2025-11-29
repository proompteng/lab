import { createDbClient } from '~/services/db'
import { isSupportedModel, resolveModel, supportedModels } from '~/services/models'
import { buildUsagePayload, persistAssistant, persistFailedTurn } from './persistence'
import { defaultUserId, lastChatIdForUser, serviceTier, threadMap } from './state'
import { streamSse } from './stream'
import type { ChatCompletionRequest, Message, PersistMeta, ReasoningPart, StreamOptions } from './types'
import { buildPrompt, deriveChatId } from './utils'

const buildSseErrorResponse = (payload: unknown, status = 400) => {
  const encoder = new TextEncoder()
  const errorStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(errorStream, {
    status,
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
    let body: ChatCompletionRequest
    try {
      body = (await request.json()) as ChatCompletionRequest
    } catch {
      const payload = {
        error: {
          message: 'Invalid JSON body',
          type: 'invalid_request_error',
          code: 'invalid_json',
        },
      }
      return buildSseErrorResponse(payload, 400)
    }

    const requestedStream = body.stream
    if (requestedStream !== true) {
      const payload = {
        error: {
          message: 'Streaming only: set stream=true',
          type: 'invalid_request_error',
          code: 'stream_required',
        },
      }
      return buildSseErrorResponse(payload, 400)
    }

    const requestedModel = body.model
    if (requestedModel && !isSupportedModel(requestedModel)) {
      const message = `Unsupported model "${requestedModel}". Supported models: ${supportedModels.join(', ')}`
      const payload = { error: { message, type: 'invalid_request_error', code: 'model_not_supported' } }
      return buildSseErrorResponse(payload, 400)
    }

    const promptMessages: Message[] | null = Array.isArray(body.messages) ? (body.messages as Message[]) : null
    if (!promptMessages || promptMessages.length === 0) {
      const payload = {
        error: {
          message: '`messages` must be a non-empty array',
          type: 'invalid_request_error',
          code: 'messages_required',
        },
      }
      return buildSseErrorResponse(payload, 400)
    }

    for (const [idx, msg] of promptMessages.entries()) {
      if (!msg || typeof msg !== 'object' || typeof msg.role !== 'string' || msg.content === undefined) {
        const payload = {
          error: {
            message: `messages[${idx}] must include role (string) and content`,
            type: 'invalid_request_error',
            code: 'messages_invalid',
          },
        }
        return buildSseErrorResponse(payload, 400)
      }
    }

    const model = resolveModel(requestedModel)
    const userId = body.user ?? defaultUserId
    const incomingChatId = deriveChatId(body ?? {})
    const chatId = incomingChatId ?? lastChatIdForUser.get(userId) ?? crypto.randomUUID()
    const conversationId = chatId
    const turnId = crypto.randomUUID()
    const startedAt = Date.now()
    const acceptedStream = requestedStream === true

    console.info(`[jangar] ${pathLabel}`, {
      model,
      messageCount: promptMessages.length,
      requestedStream,
      acceptedStream,
      streamRequired: true,
      chatId,
      userId,
      incomingChatId,
    })

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
    for (const msg of promptMessages) {
      await db.appendMessage({
        turnId,
        role: msg.role,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        createdAt: startedAt,
      })
    }

    const prompt = buildPrompt(promptMessages)
    const includeUsage = body.stream_options?.include_usage === true

    try {
      const existingThreadId = threadMap.get(chatId)
      const sseOptions: StreamOptions = {
        model,
        signal: request.signal,
        chatId,
        includeUsage,
        ...(existingThreadId ? { threadId: existingThreadId } : {}),
        db,
        conversationId,
        turnId,
        userId,
        startedAt,
        onComplete: async (text: string, reasoning: ReasoningPart[], meta: PersistMeta) => {
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

          if (meta.tokenUsage && !meta.usagePersisted) {
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
        },
      }

      return await streamSse(prompt, sseOptions)
    } catch (error) {
      console.error('[jangar] codex app-server stream error', error)
      threadMap.delete(chatId)

      await persistFailedTurn(
        db,
        {
          turnId,
          conversationId,
          chatId,
          userId,
          model,
          startedAt,
        },
        `${error}`,
        'stream/error',
      )

      return buildSseErrorResponse({ error: 'codex app-server failed', details: `${error}` }, 500)
    }
  }
}
