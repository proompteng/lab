import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as S from '@effect/schema/Schema'
import type { CodexAppServerClient } from '@proompteng/codex'
import { Effect, Layer, ManagedRuntime, pipe } from 'effect'
import {
  LOCK_RETRY_ATTEMPTS,
  LOCK_RETRY_DELAY_MS,
  LOCK_STALE_MS,
  runGitWithLockRecovery,
} from '~/server/git-lock-recovery'
import { withWorktreeLock } from '~/server/git-worktree-lock'
import {
  ChatCompletionEncoder,
  type ChatCompletionEncoderService,
  chatCompletionEncoderLive,
  normalizeStreamError,
} from './chat-completion-encoder'
import { safeJsonStringify, stripTerminalControl } from './chat-text'
import { ChatToolEventRenderer, chatToolEventRendererLive, type ToolRenderer } from './chat-tool-event-renderer'
import { buildTranscriptSignature, compareTranscript, fitPromptMessages, type TranscriptEntry } from './chat-transcript'
import { getCodexClient, releaseCodexClient, resetCodexClient, setCodexClientFactory } from './codex-client'
import { loadConfig } from './config'
import { recordSseConnection, recordSseError } from './metrics'
import { ThreadState, ThreadStateLive, type ThreadStateService, ThreadStateUnavailableError } from './thread-state'
import {
  TranscriptState,
  TranscriptStateLive,
  type TranscriptStateService,
  TranscriptStateUnavailableError,
} from './transcript-state'
import { pickWorktreeCityName } from './worktree-cities'
import { WorktreeState, WorktreeStateLive, WorktreeStateUnavailableError } from './worktree-state'

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
type ChatClientKind = 'openwebui' | 'discord' | 'trade-execution' | 'internal' | 'unknown'

class RequestError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

class ChatStateStoreError extends Error {
  readonly store: string
  readonly detail: string

  constructor(store: string, error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    super(`chat state store error (${store}): ${detail}`)
    this.store = store
    this.detail = detail
  }
}

const sseError = (payload: unknown, status = 400) => {
  recordSseError('chat', status >= 500 ? 'server' : 'client')
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

const resolveChatClientKind = (request: Request, hasOpenWebUIChatId: boolean): ChatClientKind => {
  const tradeExecutionHeader = request.headers.get('x-trade-execution')
  if (tradeExecutionHeader !== null) {
    const normalized = tradeExecutionHeader.trim().toLowerCase()
    if (normalized !== 'torghut') {
      throw new RequestError(
        400,
        'invalid_trade_execution_header',
        "`x-trade-execution` must be 'torghut' when provided",
      )
    }
    return 'trade-execution'
  }

  const raw = request.headers.get('x-jangar-client-kind')
  const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (normalized === 'trade-execution') {
    throw new RequestError(
      400,
      'deprecated_trade_execution_header',
      '`x-jangar-client-kind: trade-execution` is no longer supported; use `x-trade-execution: torghut`',
    )
  }
  if (normalized === 'discord') return 'discord'
  if (normalized === 'openwebui') return 'openwebui'
  if (normalized === 'internal') return 'internal'
  if (normalized.length > 0) return 'unknown'
  return hasOpenWebUIChatId ? 'openwebui' : 'unknown'
}

const WORKTREE_DIR_NAME = '.worktrees'
const WORKTREE_NAME_PATTERN = /^[a-z0-9-]+$/
const TRADE_EXECUTION_DIR_NAME = 'torghut'
const DEFAULT_CODEX_MAX_INPUT_CHARS = 1_048_576

const MISSING_UPSTREAM_THREAD_MESSAGE_FRAGMENTS = ['conversation not found', 'thread not found'] as const

class MissingUpstreamThreadError extends Error {
  readonly upstream: unknown

  constructor(upstream: unknown) {
    super('missing upstream thread')
    this.upstream = upstream
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const includesMissingUpstreamThreadMessage = (message: string) => {
  const normalized = message.toLowerCase()
  return MISSING_UPSTREAM_THREAD_MESSAGE_FRAGMENTS.some((fragment) => normalized.includes(fragment))
}

const collectErrorMessages = (error: unknown, maxDepth = 5): string[] => {
  const messages: string[] = []
  const seen = new WeakSet<object>()

  const visit = (value: unknown, depth: number) => {
    if (depth <= 0 || value == null) return
    if (typeof value === 'string') {
      messages.push(value)
      return
    }
    if (!isRecord(value)) return
    if (seen.has(value)) return
    seen.add(value)

    if (typeof value.message === 'string') messages.push(value.message)
    if (typeof value.error === 'string') messages.push(value.error)

    // JSON-RPC errors tend to nest under `.error` (and sometimes `.error.error`).
    if (value.error != null) visit(value.error, depth - 1)
  }

  visit(error, maxDepth)
  return messages
}

const isMissingUpstreamThreadError = (error: unknown): boolean =>
  collectErrorMessages(error).some((message) => includesMissingUpstreamThreadMessage(message))

const isErrno = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === 'object' && error !== null && 'code' in error

const shouldSkipGitWorktree = () => {
  if (process.env.NODE_ENV === 'test') return true
  return typeof (globalThis as { Bun?: unknown }).Bun === 'undefined'
}

const resolveRepoRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const resolveCodexBaseCwd = () => {
  const envCwd = process.env.CODEX_CWD?.trim()
  if (envCwd) return envCwd
  return process.env.NODE_ENV === 'production' ? '/workspace/lab' : resolveRepoRoot()
}

const resolveCodexCwd = (worktreePath?: string) => worktreePath ?? resolveCodexBaseCwd()

const resolveCodexMaxInputChars = () => {
  const raw = process.env.JANGAR_CODEX_MAX_INPUT_CHARS?.trim()
  if (!raw) return DEFAULT_CODEX_MAX_INPUT_CHARS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('JANGAR_CODEX_MAX_INPUT_CHARS must be a positive integer')
  }
  return parsed
}

const resolveWorktreeRoot = () => join(resolveCodexBaseCwd(), WORKTREE_DIR_NAME)
const resolveTradeExecutionRoot = () => join(resolveCodexBaseCwd(), TRADE_EXECUTION_DIR_NAME)

const ensureTradeExecutionCwd = async () => {
  const tradeExecutionCwd = resolveTradeExecutionRoot()
  await mkdir(tradeExecutionCwd, { recursive: true })
  return tradeExecutionCwd
}

const runGitWithRecovery = async (
  args: string[],
  cwd: string,
  options: { worktreeName?: string; worktreePath?: string; label?: string },
) =>
  runGitWithLockRecovery((gitArgs, gitCwd) => runGitCommand(gitCwd, gitArgs), args, cwd, {
    repoRoot: resolveCodexBaseCwd(),
    worktreeName: options.worktreeName ?? null,
    worktreePath: options.worktreePath ?? null,
    label: options.label,
    staleMs: LOCK_STALE_MS,
    attempts: LOCK_RETRY_ATTEMPTS,
    delayMs: LOCK_RETRY_DELAY_MS,
  })

const readExistingWorktreeNames = async (worktreeRoot: string) => {
  const entries = await readdir(worktreeRoot, { withFileTypes: true })
  return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
}

const readProcessText = async (stream: ReadableStream | null) => {
  if (!stream) return ''
  return new Response(stream).text()
}

const runGitCommand = async (repoRoot: string, args: string[]) => {
  const process = Bun.spawn(['git', ...args], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exitCode = await process.exited
  const stdout = await readProcessText(process.stdout)
  const stderr = await readProcessText(process.stderr)
  return { exitCode, stdout, stderr }
}

const gitBranchExists = async (repoRoot: string, branchName: string) => {
  const result = await runGitCommand(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`])
  return result.exitCode === 0
}

const createGitWorktree = async (repoRoot: string, worktreePath: string, worktreeName: string) => {
  const branchExists = await gitBranchExists(repoRoot, worktreeName)
  const args = branchExists
    ? ['worktree', 'add', worktreePath, worktreeName]
    : ['worktree', 'add', '-b', worktreeName, worktreePath, 'HEAD']
  const startedAt = Date.now()
  console.info('[chat] worktree git add start', { worktreeName, worktreePath, branchExists })
  const result = await withWorktreeLock(() =>
    runGitWithRecovery(args, repoRoot, {
      worktreeName,
      worktreePath,
      label: 'git worktree add',
    }),
  )
  console.info('[chat] worktree git add done', {
    worktreeName,
    worktreePath,
    exitCode: result.exitCode,
    durationMs: Date.now() - startedAt,
  })
  if (result.exitCode === 0) return
  const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
  throw new Error(`git worktree add failed${detail ? `: ${detail}` : ''}`)
}

const ensureWorktreePath = async (worktreeName: string) => {
  if (!WORKTREE_NAME_PATTERN.test(worktreeName)) {
    throw new Error(`Invalid worktree name '${worktreeName}'`)
  }

  const worktreeRoot = resolveWorktreeRoot()
  console.info('[chat] worktree ensure start', { worktreeName, worktreeRoot })
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
    console.info('[chat] worktree ensure existing', { worktreeName, worktreePath })
    return worktreePath
  }

  if (shouldSkipGitWorktree()) {
    console.info('[chat] worktree ensure create (skip git)', { worktreeName, worktreePath })
    await mkdir(worktreePath, { recursive: true })
    console.info('[chat] worktree ensure ready', { worktreeName, worktreePath })
    return worktreePath
  }

  console.info('[chat] worktree ensure create (git)', { worktreeName, worktreePath })
  await createGitWorktree(resolveCodexBaseCwd(), worktreePath, worktreeName)
  console.info('[chat] worktree ensure ready', { worktreeName, worktreePath })
  return worktreePath
}

const allocateWorktree = async () => {
  const worktreeRoot = resolveWorktreeRoot()
  await mkdir(worktreeRoot, { recursive: true })
  const existing = await readExistingWorktreeNames(worktreeRoot)
  console.info('[chat] worktree allocate start', { worktreeRoot, existingCount: existing.size })
  let lastError: Error | null = null

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = pickWorktreeCityName(existing)
    console.info('[chat] worktree allocate attempt', { attempt: attempt + 1, candidate })
    try {
      const path = await ensureWorktreePath(candidate)
      console.info('[chat] worktree allocate success', { candidate, path })
      return { name: candidate, path }
    } catch (error) {
      console.warn('[chat] worktree allocate failed', { candidate, error: String(error) })
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
  threadState: ThreadStateService
  turnNumber: number | null
}

const toSseResponse = (
  client: CodexAppServerClient,
  prompt: string,
  retryPrompt: string,
  model: string,
  includeUsage: boolean,
  includePlan: boolean,
  toolRenderer: ToolRenderer,
  completionEncoder: ChatCompletionEncoderService,
  threadContext: ThreadContext | null,
  codexCwd: string,
  onTurnSettled?: (result: {
    aborted: boolean
    turnFinished: boolean
    hadError: boolean
    assistantContent: string
    threadId: string | null
  }) => Promise<void>,
  emitAssistantRolePreamble = false,
  requestSignal?: AbortSignal,
  onStreamFinished?: () => void,
) => {
  const textEncoder = new TextEncoder()
  const created = Math.floor(Date.now() / 1000)
  const id = `chatcmpl-${crypto.randomUUID()}`
  const heartbeatIntervalMs = 5_000
  const enableHeartbeat = process.env.NODE_ENV !== 'test'
  let connectionClosed = false
  let handleClientDisconnect: (() => void) | null = null

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      recordSseConnection('chat', 'opened')
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
          if (!connectionClosed) {
            recordSseConnection('chat', 'closed')
            connectionClosed = true
          }
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
        const emitHeartbeat = () => {
          if (controllerClosed || aborted) return
          try {
            controller.enqueue(textEncoder.encode(': keepalive\n\n'))
          } catch {
            aborted = true
            controllerClosed = true
            interruptCodex()
            safeClose()
          }
        }

        // OpenWebUI can cancel upstream requests if no SSE bytes arrive promptly while Jangar is still
        // initializing the Codex turn. Emit an immediate keepalive before the regular heartbeat cadence.
        emitHeartbeat()
        heartbeatTimer = setInterval(emitHeartbeat, heartbeatIntervalMs)
      }

      try {
        handleClientDisconnect = () => {
          if (aborted) return
          aborted = true
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer)
            heartbeatTimer = null
          }
          interruptCodex()
          safeClose()
        }

        if (requestSignal) {
          const handleRequestAbort = () => {
            handleClientDisconnect?.()
          }
          if (requestSignal.aborted) {
            handleRequestAbort()
          } else {
            requestSignal.addEventListener('abort', handleRequestAbort, { once: true })
            abortControllers.push(() => {
              requestSignal.removeEventListener('abort', handleRequestAbort)
            })
          }
        }

        if (emitAssistantRolePreamble) {
          enqueueChunk({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                },
              },
            ],
          })
        }

        abortControllers.push(() => {
          if (heartbeatTimer) clearInterval(heartbeatTimer)
        })
        startHeartbeat()

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
          } = await client.runTurnStream(resumeThreadId ? prompt : retryPrompt, {
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
                isMissingUpstreamThreadError((delta as Record<string, unknown>).error)
              ) {
                throw new MissingUpstreamThreadError((delta as Record<string, unknown>).error)
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
            const upstreamError = error instanceof MissingUpstreamThreadError ? error.upstream : error
            if (
              attempt === 0 &&
              resumeThreadId != null &&
              !session.getState().hasEmittedAnyChunk &&
              isMissingUpstreamThreadError(upstreamError)
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
        recordSseError('chat', 'internal')
        enqueueFrames(
          session.onInternalError({
            message: typeof normalized.message === 'string' ? normalized.message : safeJsonStringify(normalized),
            type: 'internal',
            code: 'codex_error',
          }),
        )
      } finally {
        handleClientDisconnect = null
        for (const removeAbort of abortControllers) removeAbort()
        if (onTurnSettled) {
          try {
            const state = session.getState()
            await onTurnSettled({
              aborted,
              turnFinished,
              hadError: state.hadError,
              assistantContent: state.assistantContent,
              threadId: activeThreadId,
            })
          } catch (error) {
            console.warn('[chat] failed to finalize transcript state', {
              chatId: threadContext?.chatId,
              threadId: activeThreadId ?? threadContext?.threadId ?? null,
              error: String(error),
            })
          }
        }
        enqueueFrames(session.finalize({ aborted, turnFinished }))

        if (!controllerClosed) {
          try {
            controller.enqueue(textEncoder.encode('data: [DONE]\n\n'))
          } catch {
            // ignore
          }
          safeClose()
        }
        if (onStreamFinished) {
          try {
            onStreamFinished()
          } catch (error) {
            console.warn('[chat] failed to release codex client', {
              chatId: threadContext?.chatId,
              threadId: activeThreadId ?? threadContext?.threadId ?? null,
              error: String(error),
            })
          }
        }
      }
    },
    cancel() {
      handleClientDisconnect?.()
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
        const chatClientKind = yield* Effect.try({
          try: () => resolveChatClientKind(request, chatId !== null),
          catch: (error) =>
            error instanceof RequestError
              ? error
              : new RequestError(400, 'invalid_request_error', 'Invalid chat request headers'),
        })
        const tradeExecutionRequest = chatClientKind === 'trade-execution'
        const statefulTranscriptEnabled =
          chatClientKind === 'openwebui' && process.env.JANGAR_STATEFUL_CHAT_MODE !== '0'
        const shouldTrackConversationState = chatClientKind === 'openwebui' || chatClientKind === 'discord'

        const { config, toolRenderer, encoder } = yield* Effect.all({
          config: loadConfig,
          toolRenderer: ChatToolEventRenderer,
          encoder: ChatCompletionEncoder,
        })

        let threadContext: ThreadContext | null = null
        let codexCwd = resolveCodexCwd()
        let transcriptState: TranscriptStateService | null = null
        let storedTranscript: TranscriptEntry[] | null = null

        if (tradeExecutionRequest) {
          codexCwd = yield* Effect.tryPromise({
            try: () => ensureTradeExecutionCwd(),
            catch: (error) =>
              new RequestError(
                500,
                'trade_execution_cwd_setup_failed',
                error instanceof Error ? error.message : 'Unable to prepare trade-execution workspace',
              ),
          })
        }

        if (chatId && shouldTrackConversationState) {
          const resolved = yield* pipe(
            Effect.gen(function* () {
              const threadState = yield* ThreadState
              const worktreeState = yield* WorktreeState
              const transcriptService = statefulTranscriptEnabled ? yield* TranscriptState : null

              let threadId = yield* pipe(
                threadState.getThreadId(chatId),
                Effect.mapError((error) => new ChatStateStoreError('thread', error)),
              )

              const storedWorktreeName = yield* pipe(
                worktreeState.getWorktreeName(chatId),
                Effect.mapError((error) => new ChatStateStoreError('worktree', error)),
              )

              let worktreeName = storedWorktreeName
              let worktreePath: string

              if (worktreeName) {
                const existingName = worktreeName
                worktreePath = yield* Effect.tryPromise({
                  try: () => ensureWorktreePath(existingName),
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
                const allocatedName = allocation.name
                worktreeName = allocatedName
                worktreePath = allocation.path

                yield* pipe(
                  worktreeState.setWorktreeName(chatId, allocatedName),
                  Effect.mapError((error) => new ChatStateStoreError('worktree', error)),
                )
              }

              let transcriptSignature = transcriptService
                ? yield* pipe(
                    transcriptService.getTranscript(chatId),
                    Effect.mapError((error) => new ChatStateStoreError('transcript', error)),
                  )
                : null

              if (transcriptService && threadId && !transcriptSignature) {
                console.info('[chat] stored thread missing transcript signature; resetting thread', {
                  chatId,
                  threadId,
                })
                yield* pipe(
                  threadState.clearChat(chatId),
                  Effect.mapError((error) => new ChatStateStoreError('thread', error)),
                )
                threadId = null
              }

              if (transcriptService && !threadId && transcriptSignature) {
                yield* pipe(
                  transcriptService.clearTranscript(chatId),
                  Effect.mapError((error) => new ChatStateStoreError('transcript', error)),
                )
                transcriptSignature = null
              }

              return {
                threadContext: {
                  chatId,
                  threadId,
                  threadState,
                  turnNumber: null,
                },
                codexCwd: resolveCodexCwd(worktreePath),
                transcriptState: transcriptService,
                transcriptSignature,
                worktreeName,
                worktreePath,
              }
            }),
            Effect.catchAll((error) => {
              if (error instanceof ChatStateStoreError) {
                console.warn('[chat] openwebui state unavailable; falling back to stateless', {
                  chatId,
                  store: error.store,
                  detail: error.detail,
                })
                return Effect.succeed({
                  threadContext: null,
                  codexCwd: resolveCodexCwd(),
                  transcriptState: null,
                  transcriptSignature: null,
                  worktreeName: null,
                  worktreePath: null,
                })
              }
              if (error instanceof ThreadStateUnavailableError || error instanceof WorktreeStateUnavailableError) {
                console.warn('[chat] openwebui state unavailable; falling back to stateless', {
                  chatId,
                  detail: error.message,
                })
                return Effect.succeed({
                  threadContext: null,
                  codexCwd: resolveCodexCwd(),
                  transcriptState: null,
                  transcriptSignature: null,
                  worktreeName: null,
                  worktreePath: null,
                })
              }
              if (error instanceof TranscriptStateUnavailableError) {
                console.warn('[chat] openwebui transcript store unavailable; falling back to stateless', {
                  chatId,
                  detail: error.message,
                })
                return Effect.succeed({
                  threadContext: null,
                  codexCwd: resolveCodexCwd(),
                  transcriptState: null,
                  transcriptSignature: null,
                  worktreeName: null,
                  worktreePath: null,
                })
              }
              return Effect.fail(error)
            }),
          )

          threadContext = resolved.threadContext
          codexCwd = resolved.codexCwd
          transcriptState = resolved.transcriptState
          storedTranscript = resolved.transcriptSignature

          if (threadContext) {
            console.info('[chat] chat id received', {
              chatId,
              threadId: threadContext.threadId,
              clientKind: chatClientKind,
              transcriptMode: statefulTranscriptEnabled ? 'stateful' : 'stateless',
            })
          }
          if (resolved.worktreeName && resolved.worktreePath) {
            console.info('[chat] worktree resolved', {
              chatId,
              worktreeName: resolved.worktreeName,
              worktreePath: resolved.worktreePath,
            })
          }
        }
        if (chatId && !shouldTrackConversationState) {
          console.info('[chat] skipping thread state for stateless client request', {
            chatId,
            clientKind: chatClientKind,
          })
        }

        if (tradeExecutionRequest && !parsed.model) {
          return yield* Effect.fail(
            new RequestError(400, 'model_required', '`model` is required when using `x-trade-execution: torghut`'),
          )
        }

        const model = parsed.model ?? config.defaultModel
        if (!config.models.includes(model)) {
          return yield* Effect.fail(
            new RequestError(400, 'model_not_found', `Unknown model '${model}'. See /openai/v1/models.`),
          )
        }

        let promptMessages = parsed.messages
        let nextTranscriptSignature: TranscriptEntry[] | null =
          threadContext && transcriptState && statefulTranscriptEnabled
            ? buildTranscriptSignature(parsed.messages)
            : null

        if (threadContext && threadContext.threadId && transcriptState && statefulTranscriptEnabled) {
          const comparison = compareTranscript(storedTranscript, parsed.messages)
          promptMessages = comparison.deltaMessages.length > 0 ? comparison.deltaMessages : parsed.messages
          nextTranscriptSignature = comparison.signature

          if (comparison.resetRequired) {
            console.info('[chat] transcript mismatch; resetting thread', {
              chatId: threadContext.chatId,
              storedLength: storedTranscript?.length ?? 0,
              incomingLength: parsed.messages.length,
              resetReason: comparison.resetReason,
              resetMismatchIndex: comparison.resetMismatchIndex,
              clientKind: chatClientKind,
            })
            yield* pipe(
              threadContext.threadState.clearChat(threadContext.chatId),
              Effect.catchAll((error) => {
                console.warn('[chat] failed to clear thread after transcript mismatch', {
                  chatId: threadContext.chatId,
                  error: String(error),
                })
                return Effect.succeed(undefined)
              }),
            )
            yield* pipe(
              transcriptState.clearTranscript(threadContext.chatId),
              Effect.catchAll((error) => {
                console.warn('[chat] failed to clear transcript after transcript mismatch', {
                  chatId: threadContext.chatId,
                  error: String(error),
                })
                return Effect.succeed(undefined)
              }),
            )
            threadContext.threadId = null
            threadContext.turnNumber = null
            promptMessages = parsed.messages
          }
        }

        const finalizeTranscriptState =
          threadContext && transcriptState && statefulTranscriptEnabled && nextTranscriptSignature
            ? async (result: {
                aborted: boolean
                turnFinished: boolean
                hadError: boolean
                assistantContent: string
                threadId: string | null
              }) => {
                const clearConversationState = async (reason: string) => {
                  await pipe(
                    Effect.all([
                      pipe(
                        threadContext.threadState.clearChat(threadContext.chatId),
                        Effect.catchAll((error) => {
                          console.warn('[chat] failed to clear thread after transcript finalization issue', {
                            chatId: threadContext.chatId,
                            threadId: result.threadId,
                            reason,
                            error: String(error),
                          })
                          return Effect.succeed(undefined)
                        }),
                      ),
                      pipe(
                        transcriptState.clearTranscript(threadContext.chatId),
                        Effect.catchAll((error) => {
                          console.warn('[chat] failed to clear transcript after transcript finalization issue', {
                            chatId: threadContext.chatId,
                            threadId: result.threadId,
                            reason,
                            error: String(error),
                          })
                          return Effect.succeed(undefined)
                        }),
                      ),
                    ]),
                    Effect.runPromise,
                  )
                  threadContext.threadId = null
                  threadContext.turnNumber = null
                }

                if (result.aborted || !result.turnFinished || result.hadError) {
                  await clearConversationState('turn_not_settled')
                  return
                }

                const assistantContent = normalizeAssistantTranscriptContent(result.assistantContent)
                const completedSignature =
                  assistantContent.length > 0
                    ? buildTranscriptSignature([...parsed.messages, { role: 'assistant', content: assistantContent }])
                    : nextTranscriptSignature

                await pipe(
                  transcriptState.setTranscript(threadContext.chatId, completedSignature),
                  Effect.catchAll((error) => {
                    console.warn('[chat] failed to persist completed chat transcript signature', {
                      chatId: threadContext.chatId,
                      threadId: result.threadId,
                      error: String(error),
                    })
                    return Effect.tryPromise({
                      try: () => clearConversationState('transcript_write_failed'),
                      catch: () => undefined,
                    })
                  }),
                  Effect.runPromise,
                )
              }
            : undefined

        const maxInputChars = resolveCodexMaxInputChars()
        const promptFit = fitPromptMessages(promptMessages, maxInputChars)
        const retryPromptFit = fitPromptMessages(parsed.messages, maxInputChars)

        if (!promptFit.fits || !retryPromptFit.fits) {
          return yield* Effect.fail(
            new RequestError(
              400,
              'input_too_large',
              `Chat input exceeds the maximum supported length of ${maxInputChars} characters. Start a new chat or shorten the latest message.`,
            ),
          )
        }

        if (promptFit.trimmed) {
          console.info('[chat] trimmed prompt history to fit upstream input limit', {
            chatId: threadContext?.chatId,
            clientKind: chatClientKind,
            originalMessages: promptMessages.length,
            keptMessages: promptFit.messages.length,
            originalChars: promptFit.totalChars,
            keptChars: promptFit.keptChars,
            maxChars: maxInputChars,
          })
        }

        if (retryPromptFit.trimmed) {
          console.info('[chat] trimmed retry prompt history to fit upstream input limit', {
            chatId: threadContext?.chatId,
            clientKind: chatClientKind,
            originalMessages: parsed.messages.length,
            keptMessages: retryPromptFit.messages.length,
            originalChars: retryPromptFit.totalChars,
            keptChars: retryPromptFit.keptChars,
            maxChars: maxInputChars,
          })
        }

        const prompt = promptFit.prompt
        const retryPrompt = retryPromptFit.prompt
        const client = yield* getCodexClient()
        let clientReleased = false
        const releaseClient = () => {
          if (clientReleased) return
          clientReleased = true
          releaseCodexClient(client)
        }

        try {
          return toSseResponse(
            client,
            prompt,
            retryPrompt,
            model,
            includeUsage,
            includePlan,
            toolRenderer.create(),
            encoder,
            threadContext,
            codexCwd,
            finalizeTranscriptState,
            chatClientKind === 'openwebui',
            request.signal,
            releaseClient,
          )
        } catch (error) {
          releaseClient()
          throw error
        }
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
    ThreadStateLive,
    WorktreeStateLive,
    TranscriptStateLive,
    Layer.succeed(ChatToolEventRenderer, chatToolEventRendererLive),
    Layer.succeed(ChatCompletionEncoder, chatCompletionEncoderLive),
  ),
)

export const handleChatCompletion = (request: Request): Promise<Response> => runChatCompletionWithModeSupport(request)

export { setCodexClientFactory, resetCodexClient }

const runChatCompletionWithModeSupport = async (request: Request): Promise<Response> => {
  const streamingProxyRequest = await buildStreamingProxyRequest(request)
  if (!streamingProxyRequest) {
    return handlerRuntime.runPromise(handleChatCompletionEffect(request))
  }

  const streamResponse = await handlerRuntime.runPromise(handleChatCompletionEffect(streamingProxyRequest))
  return convertSseToChatCompletionResponse(streamResponse)
}

const buildStreamingProxyRequest = async (request: Request): Promise<Request | null> => {
  if (request.method.toUpperCase() !== 'POST') return null

  let body: unknown
  try {
    body = await request.clone().json()
  } catch {
    return null
  }
  if (!isRecord(body)) return null
  if (body.stream === true) return null

  const streamOptions = isRecord(body.stream_options) ? body.stream_options : {}
  const proxiedBody: Record<string, unknown> = {
    ...body,
    stream: true,
    stream_options: {
      ...streamOptions,
      include_usage: true,
    },
  }

  const headers = new Headers(request.headers)
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  return new Request(request.url, {
    method: request.method,
    headers,
    body: safeJsonStringify(proxiedBody),
    signal: request.signal,
  })
}

const convertSseToChatCompletionResponse = async (response: Response): Promise<Response> => {
  const body = await response.text()
  const frames = parseSseFrames(body)

  const errorFrame = frames.find((frame) => isRecord(frame) && isRecord(frame.error))
  if (isRecord(errorFrame) && isRecord(errorFrame.error)) {
    return new Response(safeJsonStringify({ error: errorFrame.error }), {
      status: response.status,
      headers: {
        'content-type': 'application/json',
      },
    })
  }

  let model = 'unknown'
  let content = ''
  let usage: Record<string, unknown> | null = null

  for (const frame of frames) {
    if (!isRecord(frame)) continue
    const frameModel = frame.model
    if (typeof frameModel === 'string' && frameModel.length > 0) {
      model = frameModel
    }
    if (isRecord(frame.usage)) {
      usage = frame.usage
    }
    const choices = frame.choices
    if (!Array.isArray(choices)) continue
    for (const choice of choices) {
      if (!isRecord(choice)) continue
      if (isRecord(choice.usage)) {
        usage = choice.usage
      }
      const delta = isRecord(choice.delta) ? choice.delta : null
      const message = isRecord(choice.message) ? choice.message : null
      const deltaContent = typeof delta?.content === 'string' ? delta.content : ''
      const messageContent = typeof message?.content === 'string' ? message.content : ''
      if (deltaContent.length > 0) {
        content += deltaContent
      } else if (messageContent.length > 0) {
        content += messageContent
      }
    }
  }

  const payload: Record<string, unknown> = {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: 'stop',
      },
    ],
  }
  if (usage) {
    payload.usage = usage
  }

  return new Response(safeJsonStringify(payload), {
    status: response.status,
    headers: {
      'content-type': 'application/json',
    },
  })
}

const parseSseFrames = (body: string): unknown[] => {
  const frames: unknown[] = []
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const value = trimmed.slice(5).trim()
    if (!value || value === '[DONE]') continue
    try {
      frames.push(JSON.parse(value))
    } catch {
      continue
    }
  }
  return frames
}

const normalizeAssistantTranscriptContent = (content: string) => content.replace(/^\n+/, '')
