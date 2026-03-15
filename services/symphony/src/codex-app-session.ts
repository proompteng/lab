import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import * as Schema from '@effect/schema/Schema'
import { Context, Effect, Layer, Runtime } from 'effect'
import * as Deferred from 'effect/Deferred'
import * as Fiber from 'effect/Fiber'
import * as Ref from 'effect/Ref'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import * as SynchronizedRef from 'effect/SynchronizedRef'

import type {
  AskForApproval,
  DynamicToolCallResponse,
  DynamicToolSpec,
  RateLimitSnapshot,
  SandboxMode,
  SandboxPolicy,
  ThreadStartParams,
  ThreadStartResponse,
  TurnStartParams,
  TurnStartResponse,
} from '@proompteng/codex'

import { CodexProtocolError, toLogError } from './errors'
import type { Logger } from './logger'
import type { TokenUsageTotals } from './types'

type PendingRequest = {
  method: string
  deferred: Deferred.Deferred<unknown, CodexProtocolError>
}

type ActiveTurn = {
  threadId: string
  turnId: string
  deferred: Deferred.Deferred<TurnOutcome, CodexProtocolError>
}

export type CodexEvent = {
  event: string
  timestamp: string
  codexAppServerPid: string | null
  sessionId?: string | null
  threadId?: string | null
  turnId?: string | null
  message?: string | null
  usage?: TokenUsageTotals | null
  rateLimits?: RateLimitSnapshot | null
}

export type TurnOutcome = {
  status: 'completed' | 'failed' | 'cancelled'
  threadId: string
  turnId: string
}

export type CodexSessionOptions = {
  command: string
  cwd: string
  approvalPolicy: AskForApproval | null
  threadSandbox: SandboxMode | null
  turnSandboxPolicy: SandboxPolicy | null
  readTimeoutMs: number
  turnTimeoutMs: number
  title: string
  dynamicTools: DynamicToolSpec[]
  logger: Logger
  onEvent: (event: CodexEvent) => Effect.Effect<void, never>
  onToolCall: (tool: string, args: unknown) => Effect.Effect<DynamicToolCallResponse, never>
}

export type CodexSessionHandle = {
  readonly runTurn: (prompt: string) => Effect.Effect<TurnOutcome, CodexProtocolError>
}

export interface CodexSessionServiceDefinition {
  readonly createSession: (
    options: CodexSessionOptions,
  ) => Effect.Effect<CodexSessionHandle, CodexProtocolError, Scope.Scope>
}

export class CodexSessionService extends Context.Tag('symphony/CodexSessionService')<
  CodexSessionService,
  CodexSessionServiceDefinition
>() {}

const JsonRpcResponseSchema = Schema.Struct({
  id: Schema.Number,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
})

const JsonRpcMethodSchema = Schema.Struct({
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
  id: Schema.optional(Schema.Number),
})

const toSandboxPolicy = (sandbox: SandboxMode | null, override: SandboxPolicy | null): SandboxPolicy => {
  if (override) return override
  if (sandbox === 'workspace-write') {
    return {
      type: 'workspaceWrite',
      writableRoots: [],
      readOnlyAccess: { type: 'fullAccess' },
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    }
  }
  if (sandbox === 'read-only') {
    return {
      type: 'readOnly',
      access: { type: 'fullAccess' },
      networkAccess: true,
    }
  }
  return { type: 'dangerFullAccess' }
}

const extractTokenUsage = (value: unknown): TokenUsageTotals | null => {
  if (!value || typeof value !== 'object') return null
  const raw = value as {
    total?: { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown }
    inputTokens?: unknown
    outputTokens?: unknown
    totalTokens?: unknown
  }

  if (raw.total && typeof raw.total === 'object') {
    const total = raw.total
    const inputTokens = typeof total.inputTokens === 'number' ? total.inputTokens : null
    const outputTokens = typeof total.outputTokens === 'number' ? total.outputTokens : null
    const totalTokens = typeof total.totalTokens === 'number' ? total.totalTokens : null
    if (inputTokens !== null && outputTokens !== null && totalTokens !== null) {
      return { inputTokens, outputTokens, totalTokens }
    }
  }

  if (
    typeof raw.inputTokens === 'number' &&
    typeof raw.outputTokens === 'number' &&
    typeof raw.totalTokens === 'number'
  ) {
    return {
      inputTokens: raw.inputTokens,
      outputTokens: raw.outputTokens,
      totalTokens: raw.totalTokens,
    }
  }

  return null
}

const extractThreadId = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') return null
  const raw = value as { threadId?: unknown; thread_id?: unknown; thread?: { id?: unknown } }
  if (typeof raw.threadId === 'string') return raw.threadId
  if (typeof raw.thread_id === 'string') return raw.thread_id
  if (typeof raw.thread?.id === 'string') return raw.thread.id
  return null
}

const extractTurnId = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') return null
  const raw = value as { turnId?: unknown; turn_id?: unknown; turn?: { id?: unknown } }
  if (typeof raw.turnId === 'string') return raw.turnId
  if (typeof raw.turn_id === 'string') return raw.turn_id
  if (typeof raw.turn?.id === 'string') return raw.turn.id
  return null
}

const writeMessage = (
  child: ChildProcessWithoutNullStreams,
  payload: Record<string, unknown>,
): Effect.Effect<void, CodexProtocolError, never> =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8', (error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      }),
    catch: (error) => new CodexProtocolError('response_error', 'failed to write to codex app-server stdin', error),
  })

const decodeResponse = Schema.decodeUnknownEither(JsonRpcResponseSchema)
const decodeMethod = Schema.decodeUnknownEither(JsonRpcMethodSchema)

export const decodeProtocolMessage = (rawLine: string): Record<string, unknown> | null => {
  const trimmed = rawLine.trim()
  if (trimmed.length === 0) return null
  const parsed = JSON.parse(trimmed) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CodexProtocolError('response_error', 'codex protocol line was not an object', parsed)
  }
  return parsed as Record<string, unknown>
}

export const makeCodexSessionLayer = (logger: Logger) =>
  Layer.succeed(CodexSessionService, {
    createSession: (options) =>
      Effect.gen(function* () {
        yield* Scope.Scope
        const runtime = yield* Effect.runtime<never>()
        const sessionLogger = options.logger.child({
          component: 'codex-app-session',
          workspace_path: options.cwd,
        })
        const pending = new Map<number, PendingRequest>()
        const nextRequestId = yield* Ref.make(1)
        const threadIdRef = yield* Ref.make<string | null>(null)
        const activeTurnRef = yield* SynchronizedRef.make<ActiveTurn | null>(null)
        const readyRef = yield* Ref.make(false)

        const failAllPending = (error: CodexProtocolError) =>
          Effect.gen(function* () {
            for (const [id, entry] of pending) {
              pending.delete(id)
              yield* Deferred.fail(entry.deferred, error)
            }
            const activeTurn = yield* SynchronizedRef.get(activeTurnRef)
            if (activeTurn) {
              yield* Deferred.fail(activeTurn.deferred, error)
              yield* SynchronizedRef.set(activeTurnRef, null)
            }
          })

        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            spawn('bash', ['-lc', options.command], {
              cwd: options.cwd,
              env: process.env,
              stdio: ['pipe', 'pipe', 'pipe'],
            }),
          ),
          (resource) =>
            Effect.sync(() => {
              if (!resource.killed) {
                resource.kill('SIGKILL')
              }
            }),
        )

        yield* Effect.sync(() => {
          child.once('exit', (code, signal) => {
            const error = new CodexProtocolError(
              'port_exit',
              `codex app-server exited code=${code ?? 'unknown'} signal=${signal ?? 'unknown'}`,
            )
            Runtime.runFork(runtime)(failAllPending(error))
          })
        })

        const handleServerRequest = (id: number, method: string, params: unknown) =>
          Effect.gen(function* () {
            if (method === 'item/commandExecution/requestApproval') {
              yield* writeMessage(child, { id, result: { decision: 'acceptForSession' } })
              yield* options.onEvent({
                event: 'approval_auto_approved',
                timestamp: new Date().toISOString(),
                codexAppServerPid: String(child.pid ?? ''),
                message: 'auto-approved command execution',
              })
              return
            }

            if (method === 'item/fileChange/requestApproval') {
              yield* writeMessage(child, { id, result: { decision: 'acceptForSession' } })
              yield* options.onEvent({
                event: 'approval_auto_approved',
                timestamp: new Date().toISOString(),
                codexAppServerPid: String(child.pid ?? ''),
                message: 'auto-approved file change',
              })
              return
            }

            if (method === 'applyPatchApproval' || method === 'execCommandApproval') {
              yield* writeMessage(child, { id, result: { decision: 'approved_for_session' } })
              yield* options.onEvent({
                event: 'approval_auto_approved',
                timestamp: new Date().toISOString(),
                codexAppServerPid: String(child.pid ?? ''),
                message: 'auto-approved legacy approval request',
              })
              return
            }

            if (method === 'mcpServer/elicitation/request') {
              yield* writeMessage(child, { id, result: { action: 'decline', content: null } })
              yield* options.onEvent({
                event: 'notification',
                timestamp: new Date().toISOString(),
                codexAppServerPid: String(child.pid ?? ''),
                message: 'declined mcp elicitation request',
              })
              return
            }

            if (method === 'item/tool/requestUserInput') {
              yield* writeMessage(child, { id, error: { code: -32000, message: 'turn_input_required' } })
              const activeTurn = yield* SynchronizedRef.get(activeTurnRef)
              if (activeTurn) {
                yield* Deferred.fail(
                  activeTurn.deferred,
                  new CodexProtocolError('turn_input_required', 'agent requested user input'),
                )
                yield* SynchronizedRef.set(activeTurnRef, null)
              }
              yield* options.onEvent({
                event: 'turn_input_required',
                timestamp: new Date().toISOString(),
                codexAppServerPid: String(child.pid ?? ''),
                message: 'agent requested user input',
              })
              return
            }

            if (method === 'item/tool/call') {
              const raw = params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
              const toolCallId =
                typeof raw.callId === 'string' ? raw.callId : typeof raw.id === 'string' ? raw.id : null
              const toolName = typeof raw.name === 'string' ? raw.name : 'unknown'
              const args = 'input' in raw ? raw.input : raw.arguments
              const result = yield* options.onToolCall(toolName, args)
              yield* writeMessage(child, { id, result: { ...result, callId: toolCallId } })
              return
            }

            yield* writeMessage(child, {
              id,
              result: {
                success: false,
                error: 'unsupported_tool_call',
              },
            })
          }).pipe(
            Effect.catchAll((error) =>
              Effect.sync(() => {
                sessionLogger.log('warn', 'codex_request_handling_failed', {
                  method,
                  ...toLogError(error),
                })
              }),
            ),
          )

        const emitTurnOutcome = (
          status: TurnOutcome['status'],
          turnId: string,
          threadId: string,
          message?: string | null,
        ) =>
          Effect.gen(function* () {
            const activeTurn = yield* SynchronizedRef.get(activeTurnRef)
            if (!activeTurn || activeTurn.turnId !== turnId) return

            yield* Deferred.succeed(activeTurn.deferred, { status, turnId, threadId })
            yield* SynchronizedRef.set(activeTurnRef, null)
            yield* options.onEvent({
              event: `turn_${status}`,
              timestamp: new Date().toISOString(),
              codexAppServerPid: String(child.pid ?? ''),
              sessionId: `${threadId}-${turnId}`,
              threadId,
              turnId,
              message: message ?? null,
            })
          })

        const handleNotification = (method: string, params: unknown) =>
          Effect.gen(function* () {
            const timestamp = new Date().toISOString()
            const usage = extractTokenUsage(params)
            const rateLimits =
              params && typeof params === 'object' && 'rateLimits' in params
                ? ((params as { rateLimits?: RateLimitSnapshot | null }).rateLimits ?? null)
                : null

            if (method === 'turn/completed') {
              const activeTurn = yield* SynchronizedRef.get(activeTurnRef)
              if (activeTurn) {
                yield* emitTurnOutcome('completed', activeTurn.turnId, activeTurn.threadId)
              }
              return
            }

            if (method === 'turn/failed') {
              const activeTurn = yield* SynchronizedRef.get(activeTurnRef)
              if (activeTurn) {
                yield* emitTurnOutcome('failed', activeTurn.turnId, activeTurn.threadId)
              }
              return
            }

            if (method === 'turn/cancelled') {
              const activeTurn = yield* SynchronizedRef.get(activeTurnRef)
              if (activeTurn) {
                yield* emitTurnOutcome('cancelled', activeTurn.turnId, activeTurn.threadId)
              }
              return
            }

            yield* options.onEvent({
              event: method.replaceAll('/', '_'),
              timestamp,
              codexAppServerPid: String(child.pid ?? ''),
              threadId: extractThreadId(params),
              turnId: extractTurnId(params),
              sessionId:
                extractThreadId(params) && extractTurnId(params)
                  ? `${extractThreadId(params)}-${extractTurnId(params)}`
                  : null,
              message:
                params && typeof params === 'object' && 'message' in params && typeof params.message === 'string'
                  ? params.message
                  : null,
              usage,
              rateLimits,
            })
          })

        const handleProtocolLine = (line: string) =>
          Effect.gen(function* () {
            let message: Record<string, unknown> | null = null
            try {
              message = decodeProtocolMessage(line)
            } catch (error) {
              yield* options.onEvent({
                event: 'malformed',
                timestamp: new Date().toISOString(),
                codexAppServerPid: String(child.pid ?? ''),
                message: line.trim().slice(0, 400),
              })
              yield* Effect.sync(() => {
                sessionLogger.log('warn', 'codex_stdout_malformed', {
                  line: line.trim().slice(0, 400),
                  ...toLogError(error),
                })
              })
              return
            }

            if (!message) return

            const responseDecoded = decodeResponse(message)
            if (responseDecoded._tag === 'Right' && ('result' in message || 'error' in message)) {
              const response = responseDecoded.right
              const request = pending.get(response.id)
              if (!request) return
              pending.delete(response.id)

              if (response.error !== undefined) {
                yield* Deferred.fail(
                  request.deferred,
                  new CodexProtocolError('response_error', `${request.method} failed`, response.error),
                )
              } else {
                yield* Deferred.succeed(request.deferred, response.result)
              }
              return
            }

            const methodDecoded = decodeMethod(message)
            if (methodDecoded._tag === 'Right') {
              const request = methodDecoded.right
              if (typeof request.id === 'number') {
                yield* handleServerRequest(request.id, request.method, request.params)
                return
              }
              yield* handleNotification(request.method, request.params)
            }
          }).pipe(
            Effect.catchAll((error) =>
              Effect.sync(() => {
                sessionLogger.log('warn', 'codex_protocol_error', toLogError(error))
              }),
            ),
          )

        const stdoutFiber = yield* Stream.fromAsyncIterable(
          child.stdout,
          (error) => new CodexProtocolError('port_exit', 'codex stdout stream failed', error),
        ).pipe(Stream.decodeText(), Stream.splitLines, Stream.runForEach(handleProtocolLine), Effect.forkScoped)

        const stderrFiber = yield* Stream.fromAsyncIterable(
          child.stderr,
          (error) => new CodexProtocolError('port_exit', 'codex stderr stream failed', error),
        ).pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) =>
            Effect.sync(() => {
              if (line.trim().length === 0) return
              sessionLogger.log('info', 'codex_stderr', { message: line.trim() })
            }),
          ),
          Effect.forkScoped,
        )

        yield* Effect.addFinalizer(() =>
          Fiber.interruptFork(stdoutFiber).pipe(Effect.zipRight(Fiber.interruptFork(stderrFiber))),
        )

        const request = (method: string, params: unknown) =>
          Effect.gen(function* () {
            const id = yield* Ref.modify(nextRequestId, (current) => [current, current + 1] as const)
            const deferred = yield* Deferred.make<unknown, CodexProtocolError>()
            pending.set(id, { method, deferred })
            yield* writeMessage(child, { id, method, params })
            return yield* Deferred.await(deferred).pipe(
              Effect.timeoutFail({
                duration: options.readTimeoutMs,
                onTimeout: () =>
                  new CodexProtocolError('response_timeout', `${method} timed out after ${options.readTimeoutMs}ms`),
              }),
              Effect.ensuring(Effect.sync(() => pending.delete(id))),
            )
          })

        const initialize = Ref.get(readyRef).pipe(
          Effect.flatMap((ready) =>
            ready
              ? Effect.void
              : request('initialize', {
                  clientInfo: { name: 'symphony', version: '0.1.0' },
                  capabilities: {},
                }).pipe(
                  Effect.zipRight(writeMessage(child, { method: 'initialized', params: {} })),
                  Effect.zipRight(Ref.set(readyRef, true)),
                  Effect.zipRight(
                    options.onEvent({
                      event: 'session_started',
                      timestamp: new Date().toISOString(),
                      codexAppServerPid: String(child.pid ?? ''),
                      message: 'codex app-server initialized',
                    }),
                  ),
                ),
          ),
        )

        const startThread = Effect.gen(function* () {
          const existing = yield* Ref.get(threadIdRef)
          if (existing) return existing

          const params: ThreadStartParams = {
            model: null,
            modelProvider: null,
            cwd: options.cwd,
            approvalPolicy: options.approvalPolicy,
            sandbox: options.threadSandbox,
            config: { mcp_servers: {}, web_search: 'live' },
            serviceName: 'symphony',
            baseInstructions: null,
            developerInstructions: null,
            personality: null,
            ephemeral: false,
            dynamicTools: options.dynamicTools,
            experimentalRawEvents: false,
            persistExtendedHistory: false,
          }

          const response = (yield* request('thread/start', params)) as ThreadStartResponse
          yield* Ref.set(threadIdRef, response.thread.id)
          return response.thread.id
        })

        const startTurn = (threadId: string, prompt: string) =>
          Effect.gen(function* () {
            const params: TurnStartParams = {
              threadId,
              input: [{ type: 'text', text: prompt, text_elements: [] }],
              cwd: options.cwd,
              approvalPolicy: options.approvalPolicy,
              sandboxPolicy: toSandboxPolicy(options.threadSandbox, options.turnSandboxPolicy),
              model: null,
              serviceTier: null,
              effort: null,
              summary: null,
              personality: null,
              outputSchema: null,
              collaborationMode: null,
            }

            const response = (yield* request('turn/start', params)) as TurnStartResponse
            const turnId = response.turn.id
            const deferred = yield* Deferred.make<TurnOutcome, CodexProtocolError>()
            yield* SynchronizedRef.set(activeTurnRef, { threadId, turnId, deferred })
            yield* options.onEvent({
              event: 'turn_started',
              timestamp: new Date().toISOString(),
              codexAppServerPid: String(child.pid ?? ''),
              threadId,
              turnId,
              sessionId: `${threadId}-${turnId}`,
              message: options.title,
            })
            return {
              turnId,
              deferred,
            }
          })

        const handle: CodexSessionHandle = {
          runTurn: (prompt) =>
            Effect.gen(function* () {
              yield* initialize
              const threadId = yield* startThread
              const { turnId, deferred } = yield* startTurn(threadId, prompt)
              return yield* Deferred.await(deferred).pipe(
                Effect.timeoutFail({
                  duration: options.turnTimeoutMs,
                  onTimeout: () =>
                    new CodexProtocolError('turn_timeout', `turn ${turnId} exceeded ${options.turnTimeoutMs}ms`),
                }),
                Effect.catchAll((error) =>
                  error.code === 'turn_input_required'
                    ? Effect.fail(error)
                    : Effect.fail(
                        error.code === 'turn_timeout'
                          ? error
                          : new CodexProtocolError('turn_failed', error.message, error.causeValue),
                      ),
                ),
              )
            }),
        }

        return handle
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            logger.log('warn', 'codex_session_create_failed', toLogError(error))
          }),
        ),
      ),
  })
