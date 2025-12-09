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
    throw new RequestError(400, 'stream_required', 'Streaming only: set stream=true')
  }
  return parsed
}

const buildPrompt = (messages: ChatRequest['messages']) =>
  messages
    .map((msg) => `${msg.role}: ${typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}`)
    .join('\n')

const toSseResponse = (client: CodexAppServerClient, prompt: string, model: string, signal?: AbortSignal) => {
  const encoder = new TextEncoder()
  const created = Math.floor(Date.now() / 1000)
  const id = `chatcmpl-${crypto.randomUUID()}`
  const sendChunk = (controller: ReadableStreamDefaultController<Uint8Array>, chunk: unknown) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
  }

  const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const codexCwd = process.env.CODEX_CWD ?? (process.env.NODE_ENV === 'production' ? '/workspace/lab' : defaultRepoRoot)

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let finished = false
      let hadError = false
      let reasoningSnapshot = ''
      try {
        const { stream: codexStream } = await client.runTurnStream(prompt, {
          model,
          cwd: codexCwd,
        })

        for await (const delta of codexStream) {
          if (signal?.aborted) {
            hadError = true
            controller.error(new DOMException('Aborted', 'AbortError'))
            return
          }

          // Codex may resend the cumulative reasoning trace; trim the already-sent
          // prefix so OpenAI/OpenWebUI clients receive a single, ordered stream
          // of reasoning_content without duplicates.
          if (delta.type === 'reasoning') {
            const reasoningDelta = typeof delta.delta === 'string' ? delta.delta : ''
            if (!reasoningDelta) {
              continue
            }

            const isDuplicate = reasoningDelta === reasoningSnapshot
            const incrementalDelta = reasoningDelta.startsWith(reasoningSnapshot)
              ? reasoningDelta.slice(reasoningSnapshot.length)
              : reasoningDelta

            if (!isDuplicate && incrementalDelta.length > 0) {
              const chunk = {
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [
                  {
                    delta: { reasoning_content: incrementalDelta },
                    index: 0,
                    finish_reason: null,
                  },
                ],
              }
              sendChunk(controller, chunk)
            }

            reasoningSnapshot = reasoningDelta
          }

          if (delta.type === 'message') {
            const chunk = {
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [
                {
                  delta: { content: delta.delta },
                  index: 0,
                  finish_reason: null,
                },
              ],
            }
            sendChunk(controller, chunk)
          }

          if (delta.type === 'usage') {
            const usageChunk = {
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
              usage: delta.usage,
            }
            sendChunk(controller, usageChunk)
            finished = true
          }

          if (delta.type === 'error') {
            const payload = {
              error: {
                message: delta.error?.message ?? 'Codex stream error',
                type: 'internal',
                code: delta.error?.code ?? 'codex_error',
              },
            }
            hadError = true
            sendChunk(controller, payload)
            break
          }
        }
      } catch (error) {
        const payload = {
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: 'internal',
            code: 'codex_error',
          },
        }
        hadError = true
        sendChunk(controller, payload)
      } finally {
        if (!finished && !hadError) {
          const finalChunk = {
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
          sendChunk(controller, finalChunk)
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
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
      Effect.map(({ config, client }) => ({ model: parsed.model ?? config.defaultModel, client })),
      Effect.map(({ model, client }) => {
        const prompt = buildPrompt(parsed.messages)
        return toSseResponse(client, prompt, model, request.signal)
      }),
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
