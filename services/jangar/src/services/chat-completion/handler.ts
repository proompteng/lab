import { createDbClient } from '~/services/db'
import { isSupportedModel, resolveModel, supportedModels } from '~/services/models'
import { buildUsagePayload, persistAssistant, persistFailedTurn } from './persistence'
import {
  clearActiveTurn,
  defaultUserId,
  getActiveTurn,
  registerActiveTurn,
  serviceTier,
  updateActiveTurnCodexIds,
} from './state'
import { streamSse } from './stream'
import type { ChatCompletionRequest, Message, PersistMeta, ReasoningPart, StreamOptions } from './types'
import { buildPrompt, truncateForConvex } from './utils'

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

const safeStringifyContent = (value: unknown): string => {
  const seen = new WeakSet<object>()
  const replacer = (_key: string, val: unknown) => {
    if (typeof val === 'bigint') throw new TypeError('BigInt not supported in content')
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) throw new TypeError('circular content not supported')
      seen.add(val)
    }
    return val
  }

  if (typeof value === 'string') return value
  return JSON.stringify(value, replacer)
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

    const stringifiedMessages: Array<{ role: string; content: string }> = []
    try {
      for (const msg of promptMessages) {
        stringifiedMessages.push({ role: msg.role, content: safeStringifyContent(msg.content) })
      }
    } catch (error) {
      const payload = {
        error: {
          message: `messages content invalid: ${error instanceof Error ? error.message : error}`,
          type: 'invalid_request_error',
          code: 'messages_content_invalid',
        },
      }
      return buildSseErrorResponse(payload, 400)
    }

    const model = resolveModel(requestedModel)
    const userId = body.user ?? defaultUserId
    const chatId = crypto.randomUUID()
    const conversationId = chatId
    const turnId = crypto.randomUUID()
    const startedAt = Date.now()
    const acceptedStream = requestedStream === true

    // Invariant: one active turn per chatId/conversation. Reject overlapping requests early.
    const activeTurn = getActiveTurn(chatId)
    if (activeTurn) {
      const payload = {
        error: {
          message: 'a turn is already running for this chat; wait for it to finish before starting another',
          type: 'conflict',
          code: 'turn_active',
          turn_id: activeTurn.turnId,
        },
      }
      return new Response(JSON.stringify(payload), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })
    }

    registerActiveTurn(chatId, { turnId, conversationId, startedAt })
    const releaseActiveTurn = () => clearActiveTurn(chatId, turnId)

    console.info(`[jangar] ${pathLabel}`, {
      model,
      messageCount: promptMessages.length,
      requestedStream,
      acceptedStream,
      streamRequired: true,
      chatId,
      userId,
    })

    let db: Awaited<ReturnType<typeof createDbClient>> | null = null
    try {
      db = await createDbClient()
      await db.upsertConversation({
        conversationId,
        threadId: '',
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
      for (const msg of stringifiedMessages) {
        const safeContent = truncateForConvex(msg.content, 'message_content')
        await db.appendMessage({
          turnId,
          role: msg.role,
          content: safeContent,
          createdAt: startedAt,
        })
      }
    } catch (error) {
      console.error('[jangar] db write failed before streaming', error)
      releaseActiveTurn()
      if (db)
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
          'db/error',
        )

      const payload = {
        error: {
          message: 'failed to prepare turn',
          type: 'server_error',
          code: 'db_error',
        },
      }
      return buildSseErrorResponse(payload, 500)
    }

    const prompt = buildPrompt(stringifiedMessages)
    const includeUsage = body.stream_options?.include_usage === true

    try {
      const sseOptions: StreamOptions = {
        model,
        signal: request.signal,
        chatId,
        includeUsage,
        db,
        conversationId,
        turnId,
        userId,
        startedAt,
        onCodexTurn: ({ threadId: codexThreadId, codexTurnId }) => {
          const codexIds: { threadId?: string; codexTurnId?: string } = { threadId: codexThreadId }
          if (codexTurnId !== undefined) codexIds.codexTurnId = codexTurnId
          updateActiveTurnCodexIds(chatId, codexIds)
          console.info('[jangar] codex turn attached', {
            chatId,
            conversationId,
            turnId,
            codexTurnId,
            threadId: codexThreadId,
          })
        },
        onFinalize: async ({ outcome, reason }) => {
          releaseActiveTurn()
          await db.appendEvent({
            conversationId,
            turnId,
            method: 'turn/settled',
            payload: { outcome, reason },
            receivedAt: Date.now(),
          })
        },
        onComplete: async (text: string, reasoning: ReasoningPart[], meta: PersistMeta) => {
          const combinedReasoning = reasoning.map((r) => r.text).join('')
          const safeReasoning = combinedReasoning ? truncateForConvex(combinedReasoning, 'reasoning') : ''
          const safeAssistantText = truncateForConvex(text, 'assistant_content')

          await db.upsertConversation({
            conversationId,
            threadId: meta.threadId ?? '',
            modelProvider: 'codex',
            clientName: 'jangar',
            at: Date.now(),
          })

          if (safeReasoning) {
            await db.appendReasoning({
              turnId,
              itemId: `${turnId}-reasoning`,
              summaryText: [safeReasoning],
              position: 0,
              createdAt: Date.now(),
            })
          }

          if (meta.tokenUsage && !meta.usagePersisted) {
            await db.appendUsage(buildUsagePayload(turnId, meta.tokenUsage) as never)
          }

          await persistAssistant(turnId, safeAssistantText, {
            ...meta,
            reasoningSummary: safeReasoning ? [safeReasoning] : [],
          })
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
      releaseActiveTurn()

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
