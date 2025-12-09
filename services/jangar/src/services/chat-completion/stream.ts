import { parseCodexError, persistFailedTurn, persistToolDelta } from './persistence'
import { clearActiveTurn, resolveAppServer, serviceTier, systemFingerprint } from './state'
import type { ReasoningPart, StreamOptions, TokenUsage, ToolDelta } from './types'
import { buildUsagePayload, createSafeEnqueuer, estimateTokens, formatToolDelta, stripAnsi } from './utils'

type StreamBuildResult =
  | { body: ReadableStream<Uint8Array>; errorPayload?: undefined }
  | { body: null; errorPayload: { error: { message: string; type: string; code: string } } }

const buildErrorSseResponse = (payload: unknown, status: number) => {
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

const createStreamBody = (prompt: string, opts: StreamOptions): Promise<StreamBuildResult> => {
  const appServer = opts.appServer ?? resolveAppServer()
  const targetModel = opts.model
  const existingThreadId = opts.threadId
  const finalizeSafely = async (payload: {
    outcome: 'succeeded' | 'failed' | 'aborted' | 'timeout' | 'error'
    reason?: string
  }) => {
    try {
      await opts.onFinalize?.(payload)
    } catch (error) {
      console.warn('[jangar] onFinalize ignored error', { error: `${error}` })
    }
  }

  return (async () => {
    let streamHandle: Awaited<ReturnType<ReturnType<typeof resolveAppServer>['runTurnStream']>>
    try {
      const runTurnArgs: { prompt: string; model?: string; threadId?: string } = { prompt }
      if (targetModel) runTurnArgs.model = targetModel
      if (existingThreadId) runTurnArgs.threadId = existingThreadId
      streamHandle = await appServer.runTurnStream(runTurnArgs)
    } catch (error) {
      const codexError = parseCodexError(error)
      if (codexError?.codexErrorInfo === 'contextWindowExceeded') {
        const message = codexError.message ?? 'context window exceeded'
        await persistFailedTurn(
          opts.db,
          {
            turnId: opts.turnId,
            conversationId: opts.conversationId,
            chatId: opts.chatId,
            userId: opts.userId,
            model: targetModel ?? null,
            startedAt: opts.startedAt,
          },
          message,
        )
        await finalizeSafely({ outcome: 'failed', reason: message })
        return {
          body: null,
          errorPayload: {
            error: {
              message,
              type: 'invalid_request_error',
              code: 'context_window_exceeded',
            },
          },
        }
      }
      throw error
    }

    const { stream, threadId, turnId: codexTurnId } = streamHandle
    const turnId = opts.turnId
    if (codexTurnId && codexTurnId !== turnId) {
      console.warn('[jangar] codex turnId mismatch; keeping db turnId', {
        dbTurnId: turnId,
        codexTurnId,
      })
    }
    opts.onCodexTurn?.({ threadId, codexTurnId: codexTurnId ?? undefined })

    if (codexTurnId) {
      await opts.db.appendEvent({
        conversationId: opts.conversationId,
        turnId,
        method: 'codex_turn_id',
        payload: { codexTurnId },
        receivedAt: Date.now(),
      })
    }
    const encoder = new TextEncoder()
    const created = Math.floor(Date.now() / 1000)
    const id = `chatcmpl-${crypto.randomUUID()}`
    let sentFirstDelta = false
    let collected = ''
    const promptTokens = estimateTokens(prompt)
    const reasoningParts: ReasoningPart[] = []
    let lastReasoningDelta = ''
    let usagePersisted = false
    let latestUsage: TokenUsage | null = null

    const body = new ReadableStream({
      start: async (controller) => {
        const { safeEnqueue, closeIfOpen } = createSafeEnqueuer(controller)

        const send = (payload: unknown) => safeEnqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
        const sendDone = () => safeEnqueue(encoder.encode('data: [DONE]\n\n'))
        let settled = false
        const finalize = async (outcome: 'succeeded' | 'failed' | 'aborted' | 'timeout' | 'error', reason?: string) => {
          if (settled) return
          settled = true
          const payload = reason === undefined ? { outcome } : { outcome, reason }
          await finalizeSafely(payload)
        }

        const interruptTurn = async (reason: 'timeout' | 'aborted' | 'error') => {
          if (!codexTurnId || !threadId || typeof appServer.interruptTurn !== 'function') return
          try {
            await appServer.interruptTurn({ threadId, turnId: codexTurnId })
            await opts.db.appendEvent({
              conversationId: opts.conversationId,
              turnId,
              method: 'turn/interrupted',
              payload: { reason },
              receivedAt: Date.now(),
            })
          } catch (error) {
            console.warn('[jangar] failed to interrupt codex turn', { error, codexTurnId, threadId })
          }
        }

        const streamTimeoutMs = Number(Bun.env.JANGAR_STREAM_TIMEOUT_MS ?? '300000')
        const timeoutId = setTimeout(() => {
          void (async () => {
            const reason = `stream timeout after ${streamTimeoutMs}ms`
            send({
              error: {
                message: reason,
                type: 'timeout',
                code: 'stream_timeout',
              },
            })
            sendDone()
            closeIfOpen()
            await persistFailedTurn(
              opts.db,
              {
                turnId,
                conversationId: opts.conversationId,
                chatId: opts.chatId,
                userId: opts.userId,
                model: targetModel ?? null,
                startedAt: opts.startedAt,
              },
              reason,
              'stream/timeout',
            )
            await interruptTurn('timeout')
            await finalize('timeout', reason)
            try {
              stream.return?.(undefined)
            } catch (error) {
              console.warn('[jangar] failed to return stream on timeout', error)
            }
          })()
        }, streamTimeoutMs)

        const heartbeatMs = Number(Bun.env.JANGAR_STREAM_HEARTBEAT_MS ?? '15000')
        const heartbeatId = setInterval(() => {
          // SSE comment to keep connection alive
          safeEnqueue(encoder.encode(':ping\n\n'))
        }, heartbeatMs)

        const abortHandler = () => {
          void (async () => {
            clearTimeout(timeoutId)
            clearInterval(heartbeatId)
            // The client hung up; don't try to write more bytes (avoids truncated chunk errors downstream).
            closeIfOpen()
            await persistFailedTurn(
              opts.db,
              {
                turnId,
                conversationId: opts.conversationId,
                chatId: opts.chatId,
                userId: opts.userId,
                model: targetModel ?? null,
                startedAt: opts.startedAt,
              },
              'client aborted',
              'stream/aborted',
            )
            await interruptTurn('aborted')
            await finalize('aborted', 'client aborted')
            try {
              stream.return?.(undefined)
            } catch (error) {
              console.warn('[jangar] failed to return stream on abort', error)
            }
          })()
        }
        opts.signal.addEventListener('abort', abortHandler, { once: true })

        try {
          for await (const delta of stream) {
            let contentDelta: string | null = null
            let reasoningDelta: string | null = null

            if ((delta as { type?: string }).type === 'usage') {
              latestUsage = (delta as { usage: TokenUsage }).usage
              await opts.db.appendUsage(buildUsagePayload(turnId, latestUsage) as never)
              usagePersisted = true
              await opts.db.appendEvent({
                conversationId: opts.conversationId,
                turnId,
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
              await persistToolDelta(opts.db, turnId, opts.conversationId, toolDelta)
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

            if (contentDelta) {
              collected += contentDelta
            }
            if (reasoningDelta) {
              if (reasoningDelta !== lastReasoningDelta) {
                reasoningParts.push({ type: 'text', text: reasoningDelta })
                lastReasoningDelta = reasoningDelta
              } else {
                // suppress duplicate reasoning deltas from both payload and SSE chunk
                reasoningDelta = null
              }
            }

            const choiceDelta: {
              role?: 'assistant'
              content?: string
              reasoning_content?: string
              refusal: null
              tool_calls?: Array<{
                id: string
                type: 'function'
                function: { name: string; arguments: string }
              }>
            } = {
              refusal: null,
            }

            if (!sentFirstDelta) {
              choiceDelta.role = 'assistant'
            }
            if (contentDelta) choiceDelta.content = contentDelta
            if (reasoningDelta) choiceDelta.reasoning_content = reasoningDelta

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
                  delta: choiceDelta,
                  finish_reason: null,
                  logprobs: null,
                },
              ],
            }

            if (toolDelta && toolDelta.status === 'started') {
              const id = toolDelta.id || `tool_${crypto.randomUUID()}`
              let name: string
              switch (toolDelta.toolKind) {
                case 'command':
                  name = 'command_execution'
                  break
                case 'file':
                  name = 'file_change'
                  break
                case 'mcp':
                  name = 'mcp_tool_call'
                  break
                default:
                  name = 'web_search'
              }
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

          let onCompleteFailed = false
          if (opts.onComplete) {
            try {
              await opts.onComplete(collected, reasoningParts, {
                threadId,
                turnId,
                codexTurnId,
                tokenUsage: latestUsage,
                reasoningSummary: reasoningParts.map((p) => p.text),
                usagePersisted,
              })
            } catch (error) {
              console.error('[jangar] onComplete persistence failed', error)
              onCompleteFailed = true
              await opts.db.appendEvent({
                conversationId: opts.conversationId,
                turnId,
                method: 'turn/persist_error',
                payload: { error: `${error}` },
                receivedAt: Date.now(),
              })
              await opts.db.upsertTurn({
                turnId,
                conversationId: opts.conversationId,
                chatId: opts.chatId,
                userId: opts.userId,
                model: targetModel ?? '',
                serviceTier,
                status: 'succeeded',
                startedAt: opts.startedAt,
                endedAt: Date.now(),
              })
            }
          }

          await finalize(onCompleteFailed ? 'error' : 'succeeded', onCompleteFailed ? 'persistence failed' : undefined)
        } catch (error) {
          const codexError = parseCodexError(error)

          if (codexError?.codexErrorInfo === 'contextWindowExceeded') {
            const message = codexError.message ?? 'context window exceeded'
            await persistFailedTurn(
              opts.db,
              {
                turnId,
                conversationId: opts.conversationId,
                chatId: opts.chatId,
                userId: opts.userId,
                model: targetModel ?? null,
                startedAt: opts.startedAt,
              },
              message,
              'stream/error',
            )
            send({
              error: { message, type: 'invalid_request_error', code: 'context_window_exceeded' },
            })
            sendDone()
            await finalize('failed', message)
            return
          }

          console.error('[jangar] codex stream error', error)
          await persistFailedTurn(
            opts.db,
            {
              turnId,
              conversationId: opts.conversationId,
              chatId: opts.chatId,
              userId: opts.userId,
              model: targetModel ?? null,
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
          await interruptTurn('error')
          await finalize('error', message)
          return
        } finally {
          clearTimeout(timeoutId)
          clearInterval(heartbeatId)
          closeIfOpen()
          await finalize('failed', 'stream closed')
        }
      },
    })

    return { body }
  })()
}

export const streamSse = async (prompt: string, opts: StreamOptions): Promise<Response> => {
  try {
    const result = await createStreamBody(prompt, opts)
    if (!result.body && result.errorPayload) {
      return buildErrorSseResponse(result.errorPayload, 200)
    }

    if (!result.body) {
      return buildErrorSseResponse(
        { error: { message: 'stream body unavailable', type: 'server_error', code: 'stream_unavailable' } },
        500,
      )
    }

    return new Response(result.body, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'stream failed unexpectedly'

    try {
      await persistFailedTurn(
        opts.db,
        {
          turnId: opts.turnId,
          conversationId: opts.conversationId,
          chatId: opts.chatId,
          userId: opts.userId,
          model: opts.model ?? null,
          startedAt: opts.startedAt,
        },
        message,
        'stream/error',
      )
    } catch (persistError) {
      console.warn('[jangar] failed to persist stream startup error', persistError)
    }

    try {
      await opts.onFinalize?.({ outcome: 'error', reason: message })
    } catch (finalizeError) {
      console.warn('[jangar] onFinalize failed after stream startup error', finalizeError)
    }

    // Ensure active-turn guard is cleared even if onFinalize is absent or throws.
    clearActiveTurn(opts.chatId, opts.turnId)

    return buildErrorSseResponse({ error: { message, type: 'server_error', code: 'stream_unavailable' } }, 500)
  }
}
