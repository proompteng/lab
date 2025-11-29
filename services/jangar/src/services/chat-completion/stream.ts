import { createSafeEnqueuer, estimateTokens, formatToolDelta, stripAnsi } from './utils'
import { buildContextWindowExceededResponse, parseCodexError, persistFailedTurn, persistToolDelta } from './persistence'
import { resolveAppServer, serviceTier, systemFingerprint, threadMap } from './state'
import type { ReasoningPart, StreamOptions, TokenUsage, ToolDelta } from './types'

const createStreamBody = (prompt: string, opts: StreamOptions) => {
  const appServer = resolveAppServer()
  const targetModel = opts.model
  const existingThreadId = opts.threadId ?? threadMap.get(opts.chatId)

  return (async () => {
    let streamHandle: Awaited<ReturnType<ReturnType<typeof resolveAppServer>['runTurnStream']>>
    try {
      streamHandle = existingThreadId
        ? await appServer.runTurnStream({ prompt, model: targetModel, threadId: existingThreadId })
        : await appServer.runTurnStream({ prompt, model: targetModel })
    } catch (error) {
      const codexError = parseCodexError(error)
      if (codexError?.codexErrorInfo === 'contextWindowExceeded') {
        threadMap.delete(opts.chatId)
        const message = codexError.message ?? 'context window exceeded'
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
        return { body: null, contextError: buildContextWindowExceededResponse(message) }
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
          void persistFailedTurn(
            opts.db,
            {
              turnId: opts.turnId,
              conversationId: opts.conversationId,
              chatId: opts.chatId,
              userId: opts.userId,
              model: targetModel,
              startedAt: opts.startedAt,
            },
            `stream timeout after ${streamTimeoutMs}ms`,
            'stream/timeout',
          )
          try {
            stream.return?.(undefined)
          } catch (error) {
            console.warn('[jangar] failed to return stream on timeout', error)
          }
        }, streamTimeoutMs)

        const abortHandler = () => {
          threadMap.delete(opts.chatId)
          clearTimeout(timeoutId)
          send({ error: { message: 'client aborted', type: 'aborted' } })
          sendDone()
          closeIfOpen()
          void persistFailedTurn(
            opts.db,
            {
              turnId: opts.turnId,
              conversationId: opts.conversationId,
              chatId: opts.chatId,
              userId: opts.userId,
              model: targetModel,
              startedAt: opts.startedAt,
            },
            'client aborted',
            'stream/aborted',
          )
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

            const chunk = {
              id,
              object: 'chat.completion.chunk',
              created,
              model: targetModel ?? '',
              system_fingerprint: systemFingerprint,
              service_tier: serviceTier,
              chat_id: opts.chatId,
              choices: [
                {
                  index: 0,
                  delta: sentFirstDelta
                    ? {
                        content: contentDelta ?? undefined,
                        reasoning_content: reasoningDelta ?? undefined,
                        refusal: null,
                      }
                    : {
                        role: 'assistant' as const,
                        content: contentDelta ?? undefined,
                        reasoning_content: reasoningDelta ?? undefined,
                        refusal: null,
                      },
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
            model: targetModel ?? '',
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
            const message = codexError.message ?? 'context window exceeded'
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

    return { body }
  })()
}

export const streamSse = async (prompt: string, opts: StreamOptions): Promise<Response> => {
  const result = await createStreamBody(prompt, opts)
  if (result.contextError) return result.contextError

  return new Response(result.body!, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}
