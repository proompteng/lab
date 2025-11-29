import { createDbClient } from '../../lib/db'
import { buildPrompt, deriveChatId } from './utils'
import { buildUsagePayload, persistAssistant, persistFailedTurn } from './persistence'
import { lastChatIdForUser, serviceTier, threadMap } from './state'
import { streamSse } from './stream'
import { isSupportedModel, resolveModel, supportedModels } from '../../lib/models'
import type { ChatCompletionRequest, Message } from './types'

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
    let body: ChatCompletionRequest | null = null
    try {
      body = (await request.json()) as ChatCompletionRequest
    } catch {
      // ignore parse errors; return stub anyway
    }

    const requestedModel = body?.model
    const model = resolveModel(requestedModel)
    const userId = body?.user ?? 'openwebui'
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

    if (body?.stream !== true) {
      const payload = {
        error: {
          message: 'Streaming only: set stream=true',
          type: 'invalid_request_error',
          code: 'stream_required',
        },
      }
      threadMap.delete(chatId)
      return buildSseErrorResponse(payload, 400)
    }

    if (requestedModel && !isSupportedModel(requestedModel)) {
      const message = `Unsupported model "${requestedModel}". Supported models: ${supportedModels.join(', ')}`
      const payload = { error: { message, type: 'invalid_request_error', code: 'model_not_supported' } }
      threadMap.delete(chatId)
      return buildSseErrorResponse(payload, 400)
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
    for (const msg of promptMessages ?? []) {
      await db.appendMessage({
        turnId,
        role: msg.role,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        createdAt: startedAt,
      })
    }

    const prompt = buildPrompt(promptMessages)
    const includeUsage = body?.stream_options?.include_usage === true

    try {
      const existingThreadId = threadMap.get(chatId)
      const sseOptions = {
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

      return buildSseErrorResponse({ error: 'codex app-server failed', details: `${error}` }, 200)
    }
  }
}
