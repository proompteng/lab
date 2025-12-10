import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as S from '@effect/schema/Schema'
import type { CodexAppServerClient, StreamDelta } from '@proompteng/codex'
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

const toSseResponse = (client: CodexAppServerClient, prompt: string, model: string, signal?: AbortSignal) => {
  const encoder = new TextEncoder()
  const created = Math.floor(Date.now() / 1000)
  const id = `chatcmpl-${crypto.randomUUID()}`

  const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const codexCwd = process.env.CODEX_CWD ?? (process.env.NODE_ENV === 'production' ? '/workspace/lab' : defaultRepoRoot)

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let finished = false
      let hadError = false
      let aborted = false
      let controllerClosed = false

      const enqueueChunk = (chunk: unknown) => {
        if (controllerClosed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
        } catch {
          controllerClosed = true
        }
      }

      const toolIndex = new Map<string, number>()
      const toolArguments = new Map<string, { opened: boolean; closed: boolean; entries: number; lastEntry?: string }>()
      let nextToolIndex = 0
      let messageRoleEmitted = false
      let roleEmittedForTools = false
      const abortControllers: Array<() => void> = []

      type ToolDelta = Extract<StreamDelta, { type: 'tool' }>

      const getToolIndex = (toolId: string) => {
        const existing = toolIndex.get(toolId)
        if (typeof existing === 'number') return existing
        const nextIndex = nextToolIndex
        toolIndex.set(toolId, nextIndex)
        nextToolIndex += 1
        return nextIndex
      }

      const appendToolArguments = (delta: ToolDelta) => {
        const state = toolArguments.get(delta.id) ?? { opened: false, closed: false, entries: 0 }
        const entryPayload = {
          status: delta.status,
          title: delta.title,
          detail: delta.detail,
          data: delta.data,
        }
        const serialized = JSON.stringify(entryPayload)

        if (state.lastEntry === serialized) {
          toolArguments.set(delta.id, state)
          return null
        }

        const fragments: string[] = []
        if (!state.opened) {
          fragments.push('[')
          state.opened = true
        }

        if (state.entries > 0) {
          fragments.push(',')
        }

        fragments.push(serialized)
        state.entries += 1

        if (delta.status === 'completed' && !state.closed) {
          fragments.push(']')
          state.closed = true
        }

        state.lastEntry = serialized
        toolArguments.set(delta.id, state)

        return fragments.join('')
      }

      const toolKindToName = (toolKind: ToolDelta['toolKind']) => (toolKind === 'webSearch' ? 'web_search' : toolKind)

      const emitToolChunk = (delta: ToolDelta) => {
        const argumentFragment = appendToolArguments(delta)
        const index = getToolIndex(delta.id)

        if (!argumentFragment) return

        const deltaPayload: Record<string, unknown> = {
          tool_calls: [
            {
              index,
              id: delta.id,
              type: 'function',
              function: {
                name: toolKindToName(delta.toolKind),
                arguments: argumentFragment,
              },
            },
          ],
        }

        if (!roleEmittedForTools) {
          deltaPayload.role = 'assistant'
          roleEmittedForTools = true
        }

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

      try {
        const {
          stream: codexStream,
          turnId,
          threadId,
        } = await client.runTurnStream(prompt, {
          model,
          cwd: codexCwd,
        })

        const handleAbort = () => {
          hadError = true
          aborted = true
          enqueueChunk({
            error: {
              message: 'request was aborted by the client',
              type: 'request_cancelled',
              code: 'client_abort',
            },
          })
          if (!controllerClosed) {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
            controllerClosed = true
          }
          // Best-effort interrupt of the Codex turn so we do not leak work
          void client.interruptTurn(turnId, threadId).catch(() => {})
        }

        if (signal) {
          if (signal.aborted) {
            handleAbort()
            return
          }
          signal.addEventListener('abort', handleAbort, { once: true })
          abortControllers.push(() => signal.removeEventListener('abort', handleAbort))
        }

        for await (const delta of codexStream) {
          if (aborted) {
            break
          }

          if (delta.type === 'message') {
            const deltaPayload: Record<string, unknown> = { content: delta.delta }
            if (!messageRoleEmitted) {
              deltaPayload.role = 'assistant'
              messageRoleEmitted = true
            }

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

          if (delta.type === 'reasoning') {
            const chunk = {
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [
                {
                  delta: { reasoning_content: [{ type: 'text', text: delta.delta }] },
                  index: 0,
                  finish_reason: null,
                },
              ],
            }
            enqueueChunk(chunk)
          }

          if (delta.type === 'tool') {
            emitToolChunk(delta)
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
              usage: normalizeUsage(delta.usage),
            }
            enqueueChunk(usageChunk)
            finished = true
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
        enqueueChunk(payload)
      } finally {
        for (const removeAbort of abortControllers) removeAbort()

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
          enqueueChunk(finalChunk)
        }
        if (!controllerClosed) {
          try {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          } catch {
            // ignore
          }
          controller.close()
          controllerClosed = true
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
