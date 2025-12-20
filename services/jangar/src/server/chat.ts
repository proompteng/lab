import { existsSync } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as S from '@effect/schema/Schema'
import type { CodexAppServerClient } from '@proompteng/codex'
import { Effect, Layer, ManagedRuntime, pipe } from 'effect'

import {
  ChatCompletionEncoder,
  type ChatCompletionEncoderService,
  chatCompletionEncoderLive,
  normalizeStreamError,
} from './chat-completion-encoder'
import { safeJsonStringify, stripTerminalControl } from './chat-text'
import { ChatToolEventRenderer, chatToolEventRendererLive, type ToolRenderer } from './chat-tool-event-renderer'
import { getCodexClient, resetCodexClient, setCodexClientFactory } from './codex-client'
import { loadConfig } from './config'
import {
  OpenWebUiThreadState,
  OpenWebUiThreadStateLive,
  type OpenWebUiThreadStateService,
  OpenWebUiThreadStateUnavailableError,
} from './openwebui-thread-state'
import {
  OpenWebUiWorktreeState,
  OpenWebUiWorktreeStateLive,
  OpenWebUiWorktreeStateUnavailableError,
} from './openwebui-worktree-state'
import { pickWorktreeCityName } from './worktree-cities'

const MessageSchema = S.Struct({
  role: S.String,
  content: S.Unknown,
  name: S.optional(S.String),
})

const ChatRequestSchema = S.Struct({
  model: S.optional(S.String),
  messages: S.Array(MessageSchema),
  stream: S.optional(S.Boolean),
  stream_options: S.optional(
    S.Struct({
      include_usage: S.optional(S.Boolean),
      include_plan: S.optional(S.Boolean),
    }),
  ),
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
    throw new RequestError(
      400,
      'invalid_request_error',
      stripTerminalControl(error instanceof Error ? error.message : safeJsonStringify(error)),
    )
  }

  if (!parsed.messages.length) {
    throw new RequestError(400, 'messages_required', '`messages` must be a non-empty array')
  }

  if (parsed.stream !== true) {
    throw new RequestError(400, 'stream_required', '`stream` must be true for streaming responses')
  }
  return parsed
}

const summarizeNonTextPart = (part: Record<string, unknown>) => {
  const type = typeof part.type === 'string' && part.type.length > 0 ? part.type : 'part'
  if (type === 'image_url') {
    const imageUrl = part.image_url
    if (imageUrl && typeof imageUrl === 'object') {
      const url = (imageUrl as Record<string, unknown>).url
      if (typeof url === 'string' && url.length > 0) return ` [image_url] ${url}`
    }
    return ' [image_url]'
  }
  if (type === 'input_audio') return ' [input_audio]'
  if (type === 'file') return ' [file]'
  return ` [${type}]`
}

const normalizeMessageContent = (content: unknown): string => {
  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          const obj = part as Record<string, unknown>
          if (typeof obj.text === 'string') return obj.text
          if (typeof obj.content === 'string') return obj.content
          return summarizeNonTextPart(obj)
        }
        return part == null ? '' : String(part)
      })
      .filter((value) => value.length > 0)
    return parts.join('')
  }

  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>
    if (typeof obj.text === 'string') return obj.text
    if (typeof obj.content === 'string') return obj.content
    return summarizeNonTextPart(obj)
  }

  return content == null ? '' : String(content)
}

const buildPrompt = (messages: ChatRequest['messages']) =>
  messages
    .map((msg) => {
      const prefix = msg.name && msg.name.length > 0 ? `${msg.role}(${msg.name})` : msg.role
      return `${prefix}: ${normalizeMessageContent(msg.content)}`
    })
    .join('\n')

const WORKTREE_DIR_NAME = '.worktrees'
const WORKTREE_NAME_PATTERN = /^[a-z0-9-]+$/

const isErrno = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === 'object' && error !== null && 'code' in error

const shouldSkipGitWorktree = () => process.env.NODE_ENV === 'test'

const resolveRepoRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const resolveCodexBaseCwd = () => {
  const envCwd = process.env.CODEX_CWD?.trim()
  if (envCwd) return envCwd
  return process.env.NODE_ENV === 'production' ? '/workspace/lab' : resolveRepoRoot()
}

const resolveCodexCwd = (worktreePath?: string) => worktreePath ?? resolveCodexBaseCwd()

const resolveWorktreeRoot = () => join(resolveCodexBaseCwd(), WORKTREE_DIR_NAME)

const readExistingWorktreeNames = async (worktreeRoot: string) => {
  const entries = await readdir(worktreeRoot, { withFileTypes: true })
  return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
}

const createGitWorktree = async (repoRoot: string, worktreePath: string) => {
  const process = Bun.spawn(['git', 'worktree', 'add', '--detach', worktreePath, 'HEAD'], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exitCode = await process.exited
  if (exitCode === 0) return
  const stdout = await new Response(process.stdout).text()
  const stderr = await new Response(process.stderr).text()
  const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
  throw new Error(`git worktree add failed${detail ? `: ${detail}` : ''}`)
}

const ensureWorktreePath = async (worktreeName: string) => {
  if (!WORKTREE_NAME_PATTERN.test(worktreeName)) {
    throw new Error(`Invalid worktree name '${worktreeName}'`)
  }

  const worktreeRoot = resolveWorktreeRoot()
  await mkdir(worktreeRoot, { recursive: true })
  const worktreePath = join(worktreeRoot, worktreeName)

  const existing = await stat(worktreePath).catch((error) => {
    if (isErrno(error) && error.code === 'ENOENT') return null
    throw error
  })

  if (existing) {
    if (!existing.isDirectory()) {
      throw new Error(`Worktree path exists but is not a directory: ${worktreePath}`)
    }
    return worktreePath
  }

  if (shouldSkipGitWorktree()) {
    await mkdir(worktreePath, { recursive: true })
    return worktreePath
  }

  await createGitWorktree(resolveCodexBaseCwd(), worktreePath)
  return worktreePath
}

const allocateWorktree = async () => {
  const worktreeRoot = resolveWorktreeRoot()
  await mkdir(worktreeRoot, { recursive: true })
  const existing = await readExistingWorktreeNames(worktreeRoot)
  let lastError: Error | null = null

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = pickWorktreeCityName(existing)
    try {
      const path = await ensureWorktreePath(candidate)
      return { name: candidate, path }
    } catch (error) {
      if (existsSync(join(worktreeRoot, candidate))) {
        existing.add(candidate)
        lastError = error instanceof Error ? error : new Error(String(error))
        continue
      }
      throw error
    }
  }

  throw lastError ?? new Error('Unable to allocate a new worktree')
}

type ThreadContext = {
  chatId: string
  threadId: string | null
  threadState: OpenWebUiThreadStateService
  turnNumber: number | null
}

const toSseResponse = (
  client: CodexAppServerClient,
  prompt: string,
  model: string,
  includeUsage: boolean,
  includePlan: boolean,
  toolRenderer: ToolRenderer,
  completionEncoder: ChatCompletionEncoderService,
  threadContext: ThreadContext | null,
  codexCwd: string,
  signal?: AbortSignal,
) => {
  const textEncoder = new TextEncoder()
  const created = Math.floor(Date.now() / 1000)
  const id = `chatcmpl-${crypto.randomUUID()}`
  const heartbeatIntervalMs = 5_000
  const enableHeartbeat = process.env.NODE_ENV !== 'test'

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let aborted = false
      let controllerClosed = false
      let activeTurnId: string | null = null
      let activeThreadId: string | null = null
      let pendingInterrupt = false
      let didInterrupt = false
      let turnFinished = false

      const session = completionEncoder.create({
        id,
        created,
        model,
        includeUsage,
        toolRenderer,
        meta: {
          chatId: threadContext?.chatId ?? null,
          threadId: threadContext?.threadId ?? null,
          turnNumber: threadContext?.turnNumber ?? null,
        },
      })

      const interruptTurn = (turnId: string, threadId: string) => {
        if (didInterrupt) return
        didInterrupt = true
        void client.interruptTurn(turnId, threadId).catch(() => {})
      }

      const interruptCodex = () => {
        if (activeTurnId && activeThreadId) {
          interruptTurn(activeTurnId, activeThreadId)
          return
        }
        pendingInterrupt = true
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

      const attachMeta = (chunk: Record<string, unknown>) => {
        if (threadContext?.threadId || activeThreadId) {
          chunk.thread_id = activeThreadId ?? threadContext?.threadId ?? undefined
        }
        if (threadContext?.turnNumber != null) {
          chunk.turn_number = threadContext.turnNumber
        }
        return chunk
      }

      const enqueueChunk = (chunk: unknown) => {
        if (controllerClosed) return
        try {
          const withMeta = chunk && typeof chunk === 'object' ? attachMeta(chunk as Record<string, unknown>) : chunk
          controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(withMeta)}\n\n`))
        } catch {
          // If the client has already gone away, ensure we close the stream and interrupt Codex
          controllerClosed = true
          aborted = true
          interruptCodex()
          safeClose()
        }
      }

      const abortControllers: Array<() => void> = []
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null
      const ensureTurnNumber = async () => {
        if (!threadContext || threadContext.turnNumber != null) return
        threadContext.turnNumber = await pipe(
          threadContext.threadState.nextTurn(threadContext.chatId),
          Effect.runPromise,
        )
      }

      const enqueueFrames = (frames: Record<string, unknown>[]) => {
        for (const frame of frames) enqueueChunk(frame)
      }

      const startHeartbeat = () => {
        if (!enableHeartbeat) return
        heartbeatTimer = setInterval(() => {
          if (controllerClosed || aborted) return
          try {
            controller.enqueue(textEncoder.encode(': keepalive\n\n'))
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
          enqueueFrames(session.onClientAbort())
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

        class ConversationNotFoundError extends Error {
          readonly upstream: unknown

          constructor(upstream: unknown) {
            super('conversation not found')
            this.upstream = upstream
          }
        }

        const isConversationNotFoundError = (error: unknown): boolean => {
          if (!error) return false

          const includesConversationNotFound = (message: string) =>
            message.toLowerCase().includes('conversation not found')

          if (typeof error === 'string') return includesConversationNotFound(error)
          if (typeof error !== 'object') return false

          const record = error as Record<string, unknown>
          const code = record.code
          const message = record.message

          if (code === -32600 && typeof message === 'string') {
            return includesConversationNotFound(message)
          }
          if (typeof message === 'string' && includesConversationNotFound(message)) return true

          const nested = record.error
          if (nested && typeof nested === 'object') {
            const nestedRecord = nested as Record<string, unknown>
            const nestedCode = nestedRecord.code
            const nestedMessage = nestedRecord.message
            if (nestedCode === -32600 && typeof nestedMessage === 'string') {
              return includesConversationNotFound(nestedMessage)
            }
            if (typeof nestedMessage === 'string' && includesConversationNotFound(nestedMessage)) return true
          }

          return false
        }

        const clearStaleThread = async () => {
          if (!threadContext) return
          try {
            await pipe(threadContext.threadState.clearChat(threadContext.chatId), Effect.runPromise)
          } catch (error) {
            console.warn('[chat] failed to clear stale redis thread', {
              chatId: threadContext.chatId,
              error: String(error),
            })
          }
          threadContext.threadId = null
          threadContext.turnNumber = null
        }

        const runTurnAttempt = async (resumeThreadId: string | null, canRetry: boolean) => {
          turnFinished = false

          if (aborted || controllerClosed) {
            return
          }

          const {
            stream: codexStream,
            turnId,
            threadId,
          } = await client.runTurnStream(prompt, {
            model,
            cwd: codexCwd,
            threadId: resumeThreadId ?? undefined,
          })

          activeTurnId = turnId
          activeThreadId = threadId
          session.setThreadMeta({ threadId })

          if (threadContext) {
            threadContext.threadId = threadId
          }

          if (pendingInterrupt || aborted || controllerClosed) {
            interruptTurn(turnId, threadId)
            return
          }

          if (threadContext?.chatId) {
            try {
              await pipe(threadContext.threadState.setThreadId(threadContext.chatId, threadId), Effect.runPromise)
              await ensureTurnNumber()
              session.setThreadMeta({ turnNumber: threadContext.turnNumber, chatId: threadContext.chatId })
              console.info('[chat] thread stored', {
                chatId: threadContext.chatId,
                threadId,
                turnNumber: threadContext.turnNumber ?? undefined,
              })
            } catch (error) {
              enqueueFrames(
                session.onInternalError({
                  message: 'failed to persist chat thread',
                  type: 'internal',
                  code: 'thread_store_error',
                  detail: error instanceof Error ? error.message : undefined,
                }),
              )
              interruptCodex()
              return
            }
          }

          try {
            for await (const delta of codexStream) {
              if (aborted || controllerClosed) {
                interruptCodex()
                break
              }
              if (
                delta &&
                typeof delta === 'object' &&
                (delta as Record<string, unknown>).type === 'error' &&
                canRetry &&
                !session.getState().hasEmittedAnyChunk &&
                isConversationNotFoundError((delta as Record<string, unknown>).error)
              ) {
                throw new ConversationNotFoundError((delta as Record<string, unknown>).error)
              }

              if (
                delta &&
                typeof delta === 'object' &&
                (delta as Record<string, unknown>).type === 'plan' &&
                includePlan !== true
              ) {
                continue
              }

              enqueueFrames(session.onDelta(delta))
            }

            if (!aborted) {
              turnFinished = true
            }
          } finally {
            if ((aborted || !turnFinished) && activeTurnId && activeThreadId) {
              interruptTurn(activeTurnId, activeThreadId)
            }
          }
        }

        let resumeThreadId = threadContext?.threadId ?? null
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await runTurnAttempt(resumeThreadId, attempt === 0 && resumeThreadId != null)
            break
          } catch (error) {
            const upstreamError = error instanceof ConversationNotFoundError ? error.upstream : error
            if (
              attempt === 0 &&
              resumeThreadId != null &&
              !session.getState().hasEmittedAnyChunk &&
              isConversationNotFoundError(upstreamError)
            ) {
              console.warn('[chat] stale thread id detected; starting new thread', {
                chatId: threadContext?.chatId,
                threadId: resumeThreadId,
                upstream: safeJsonStringify(upstreamError),
              })
              await clearStaleThread()
              resumeThreadId = null
              continue
            }
            throw error
          }
        }
      } catch (error) {
        const normalized = normalizeStreamError(error)
        enqueueFrames(
          session.onInternalError({
            message: typeof normalized.message === 'string' ? normalized.message : safeJsonStringify(normalized),
            type: 'internal',
            code: 'codex_error',
          }),
        )
      } finally {
        for (const removeAbort of abortControllers) removeAbort()
        enqueueFrames(session.finalize({ aborted, turnFinished }))

        if (!controllerClosed) {
          try {
            controller.enqueue(textEncoder.encode('data: [DONE]\n\n'))
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

const parseRequestEffect = (request: Request) =>
  Effect.tryPromise({
    try: () => parseRequest(request),
    catch: (error) =>
      error instanceof RequestError ? error : new RequestError(500, 'internal_error', 'Unknown error'),
  })

export const handleChatCompletionEffect = (request: Request) =>
  pipe(
    parseRequestEffect(request),
    Effect.flatMap((parsed) =>
      Effect.gen(function* () {
        const includeUsage = parsed.stream_options?.include_usage === true
        const includePlan = parsed.stream_options?.include_plan !== false
        const chatIdHeader = request.headers.get('x-openwebui-chat-id')
        const chatId = typeof chatIdHeader === 'string' && chatIdHeader.trim().length > 0 ? chatIdHeader.trim() : null

        const { config, client, toolRenderer, encoder } = yield* Effect.all({
          config: loadConfig,
          client: getCodexClient(),
          toolRenderer: ChatToolEventRenderer,
          encoder: ChatCompletionEncoder,
        })

        let threadContext: ThreadContext | null = null
        let codexCwd = resolveCodexCwd()
        if (chatId) {
          const threadState = yield* OpenWebUiThreadState
          const worktreeState = yield* OpenWebUiWorktreeState

          const threadId = yield* pipe(
            threadState.getThreadId(chatId),
            Effect.catchAll((error) => {
              if (error instanceof OpenWebUiThreadStateUnavailableError) {
                return Effect.fail(new RequestError(500, 'thread_store_unavailable', error.message))
              }
              return Effect.fail(
                new RequestError(
                  500,
                  'thread_lookup_failed',
                  error instanceof Error ? error.message : 'Unable to read chat thread state',
                ),
              )
            }),
          )

          const storedWorktreeName = yield* pipe(
            worktreeState.getWorktreeName(chatId),
            Effect.catchAll((error) => {
              if (error instanceof OpenWebUiWorktreeStateUnavailableError) {
                return Effect.fail(new RequestError(500, 'worktree_store_unavailable', error.message))
              }
              return Effect.fail(
                new RequestError(
                  500,
                  'worktree_lookup_failed',
                  error instanceof Error ? error.message : 'Unable to read chat worktree state',
                ),
              )
            }),
          )

          let worktreeName = storedWorktreeName
          let worktreePath: string

          if (worktreeName) {
            worktreePath = yield* Effect.tryPromise({
              try: () => ensureWorktreePath(worktreeName),
              catch: (error) =>
                new RequestError(
                  500,
                  'worktree_setup_failed',
                  error instanceof Error ? error.message : 'Unable to ensure chat worktree',
                ),
            })
          } else {
            const allocation = yield* Effect.tryPromise({
              try: () => allocateWorktree(),
              catch: (error) =>
                new RequestError(
                  500,
                  'worktree_setup_failed',
                  error instanceof Error ? error.message : 'Unable to allocate chat worktree',
                ),
            })
            worktreeName = allocation.name
            worktreePath = allocation.path

            yield* pipe(
              worktreeState.setWorktreeName(chatId, worktreeName),
              Effect.catchAll((error) => {
                if (error instanceof OpenWebUiWorktreeStateUnavailableError) {
                  return Effect.fail(new RequestError(500, 'worktree_store_unavailable', error.message))
                }
                return Effect.fail(
                  new RequestError(
                    500,
                    'worktree_write_failed',
                    error instanceof Error ? error.message : 'Unable to persist chat worktree',
                  ),
                )
              }),
            )
          }

          codexCwd = resolveCodexCwd(worktreePath)
          console.info('[chat] chat id received', { chatId, threadId })
          console.info('[chat] worktree resolved', { chatId, worktreeName, worktreePath })
          threadContext = {
            chatId,
            threadId,
            threadState,
            turnNumber: null,
          }
        }

        const model = parsed.model ?? config.defaultModel
        if (!config.models.includes(model)) {
          return yield* Effect.fail(
            new RequestError(400, 'model_not_found', `Unknown model '${model}'. See /openai/v1/models.`),
          )
        }

        const prompt = buildPrompt(parsed.messages)
        return toSseResponse(
          client,
          prompt,
          model,
          includeUsage,
          includePlan,
          toolRenderer.create(),
          encoder,
          threadContext,
          codexCwd,
          request.signal,
        )
      }),
    ),
    Effect.catchAll((error) => {
      if (error instanceof RequestError) {
        return Effect.succeed(
          sseError(
            { error: { message: error.message, type: 'invalid_request_error', code: error.code } },
            error.status,
          ),
        )
      }
      return Effect.succeed(
        sseError({ error: { message: 'Unknown error', type: 'internal', code: 'internal_error' } }, 500),
      )
    }),
  )

const handlerRuntime = ManagedRuntime.make(
  Layer.mergeAll(
    OpenWebUiThreadStateLive,
    OpenWebUiWorktreeStateLive,
    Layer.succeed(ChatToolEventRenderer, chatToolEventRendererLive),
    Layer.succeed(ChatCompletionEncoder, chatCompletionEncoderLive),
  ),
)

export const handleChatCompletion = (request: Request): Promise<Response> =>
  handlerRuntime.runPromise(handleChatCompletionEffect(request))

export { setCodexClientFactory, resetCodexClient }
