import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

import type { ClientInfo, ClientRequest, RequestId, ServerNotification } from './app-server'
import type { ReasoningEffort } from './app-server/ReasoningEffort'
import type { TokenUsage } from './app-server/TokenUsage'
import type {
  AgentMessageDeltaNotification,
  AskForApproval,
  CommandExecutionOutputDeltaNotification,
  ItemCompletedNotification,
  ItemStartedNotification,
  McpToolCallProgressNotification,
  SandboxMode,
  ThreadItem,
  ThreadStartParams,
  ThreadStartResponse,
  Turn,
  TurnCompletedNotification,
  TurnStartParams,
  TurnStartResponse,
} from './app-server/v2'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  method: string
  startedAt: number
}

export type StreamDelta =
  | { type: 'message' | 'reasoning'; delta: string }
  | {
      type: 'tool'
      toolKind: 'command' | 'file' | 'mcp' | 'webSearch'
      id: string
      status: 'started' | 'delta' | 'completed'
      title: string
      detail?: string
      data?: Record<string, unknown>
    }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'error'; error: unknown }

type TurnStream = {
  push: (delta: StreamDelta) => void
  complete: (turn: Turn) => void
  fail: (error: unknown) => void
  iterator: AsyncGenerator<StreamDelta, Turn | null, void>
  lastReasoningDelta: string | null
}

export type CodexAppServerOptions = {
  binaryPath?: string
  cwd?: string
  sandbox?: SandboxMode
  approval?: AskForApproval
  defaultModel?: string
  defaultEffort?: ReasoningEffort
  clientInfo?: ClientInfo
  logger?: (level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void
}

const toCliSandbox = (mode: SandboxMode): 'danger-full-access' | 'workspace-write' | 'read-only' => {
  if (mode === 'dangerFullAccess') return 'danger-full-access'
  if (mode === 'workspaceWrite') return 'workspace-write'
  return 'read-only'
}

const defaultClientInfo: ClientInfo = { name: 'lab', title: 'lab app-server client', version: '0.0.0' }
const DEFAULT_EFFORT: ReasoningEffort = 'high'

const newId = (() => {
  let id = 1
  return () => id++
})()

const createTurnStream = (): TurnStream => {
  const queue: Array<StreamDelta | { done: true; turn: Turn | null } | { error: unknown }> = []
  let resolver: (() => void) | null = null
  let closed = false

  const wake = () => {
    if (resolver) {
      resolver()
      resolver = null
    }
  }

  const push = (delta: StreamDelta) => {
    if (closed) return
    queue.push(delta)
    wake()
  }

  const complete = (turn: Turn) => {
    if (closed) return
    closed = true
    queue.push({ done: true, turn })
    wake()
  }

  const fail = (error: unknown) => {
    if (closed) return
    closed = true
    queue.push({ error })
    wake()
  }

  const iterator = (async function* iterate(): AsyncGenerator<StreamDelta, Turn | null, void> {
    while (true) {
      if (!queue.length) {
        await new Promise<void>((resolve) => {
          resolver = resolve
        })
      }

      const next = queue.shift()
      if (!next) continue

      if ('error' in next) {
        throw next.error
      }

      if ('done' in next) {
        return next.turn
      }

      yield next
    }
  })()

  return { push, complete, fail, iterator, lastReasoningDelta: null }
}

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams
  private send = (payload: unknown) => {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`)
  }
  private pending = new Map<RequestId, PendingRequest>()
  private turnStreams = new Map<string, TurnStream>()
  private readyPromise: Promise<void>
  private logger: CodexAppServerOptions['logger']
  private sandbox: SandboxMode
  private approval: AskForApproval
  private defaultModel: string
  private defaultEffort: ReasoningEffort

  constructor({
    binaryPath = 'codex',
    cwd,
    sandbox = 'dangerFullAccess',
    approval = 'never',
    defaultModel = 'gpt-5.1-codex-max',
    defaultEffort = DEFAULT_EFFORT,
    clientInfo = defaultClientInfo,
    logger,
  }: CodexAppServerOptions = {}) {
    this.logger = logger
    this.sandbox = sandbox
    this.approval = approval
    this.defaultModel = defaultModel
    this.defaultEffort = defaultEffort

    const args = [
      '--sandbox',
      toCliSandbox(sandbox),
      '--ask-for-approval',
      approval,
      '--model',
      defaultModel,
      'app-server',
    ]
    this.child = spawn(binaryPath, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.readyPromise = this.bootstrap(clientInfo)

    this.child.on('exit', (code, signal) => {
      this.log('error', 'codex app-server exited', { code, signal })
      const error = new Error(`codex app-server exited with code ${code ?? 'unknown'} signal ${signal ?? 'unknown'}`)
      for (const [, entry] of this.pending) {
        entry.reject(error)
      }
      this.pending.clear()
      for (const [, stream] of this.turnStreams) {
        stream.fail(error)
      }
      this.turnStreams.clear()
    })
  }

  async ensureReady(): Promise<void> {
    await this.readyPromise
  }

  stop(): void {
    this.child.kill()
  }

  async runTurn(
    prompt: string,
    {
      model,
      cwd,
      threadId,
      effort,
    }: { model?: string; cwd?: string | null; threadId?: string; effort?: ReasoningEffort } = {},
  ): Promise<{ text: string; turn: Turn | null; threadId: string }> {
    const runOpts: { model?: string; cwd?: string | null; threadId?: string; effort?: ReasoningEffort } = {}
    if (model !== undefined) runOpts.model = model
    if (cwd !== undefined) runOpts.cwd = cwd
    if (threadId !== undefined) runOpts.threadId = threadId
    if (effort !== undefined) runOpts.effort = effort

    const { stream, turnId: activeTurnId, threadId: activeThreadId } = await this.runTurnStream(prompt, runOpts)
    let text = ''
    let turn: Turn | null = null

    const iterator = stream[Symbol.asyncIterator]()
    while (true) {
      const { value, done } = await iterator.next()
      if (done) {
        turn = value ?? null
        break
      }
      if ((value as StreamDelta).type === 'message') {
        const msg = value as { type: 'message'; delta: string }
        text += msg.delta
      }
    }

    this.turnStreams.delete(activeTurnId)
    return { text, turn, threadId: activeThreadId }
  }

  async runTurnStream(
    prompt: string,
    {
      model,
      cwd,
      threadId,
      effort,
    }: { model?: string; cwd?: string | null; threadId?: string; effort?: ReasoningEffort } = {},
  ): Promise<{ stream: AsyncGenerator<StreamDelta, Turn | null, void>; turnId: string; threadId: string }> {
    await this.ensureReady()

    const turnOptions: { model?: string; cwd?: string | null; threadId?: string; effort?: ReasoningEffort } = {}
    if (model !== undefined) turnOptions.model = model
    if (cwd !== undefined) turnOptions.cwd = cwd
    if (threadId !== undefined) turnOptions.threadId = threadId
    turnOptions.effort = effort ?? this.defaultEffort

    let activeThreadId = turnOptions.threadId

    if (!activeThreadId) {
      const threadParams: ThreadStartParams = {
        model: turnOptions.model ?? this.defaultModel,
        modelProvider: null,
        cwd: turnOptions.cwd ?? null,
        approvalPolicy: this.approval,
        sandbox: this.sandbox,
        // Disable MCP servers for this app-server client; can be overridden later if needed.
        config: { mcp_servers: {}, 'features.web_search_request': true },
        baseInstructions: null,
        developerInstructions: null,
      }

      const threadResp = (await this.request<ThreadStartResponse>('thread/start', threadParams)) as ThreadStartResponse
      activeThreadId = threadResp.thread.id
    }

    const turnParams: TurnStartParams = {
      threadId: activeThreadId,
      input: [{ type: 'text', text: prompt }],
      cwd: turnOptions.cwd ?? null,
      approvalPolicy: this.approval,
      sandboxPolicy:
        this.sandbox === 'workspaceWrite'
          ? {
              type: 'workspaceWrite',
              writableRoots: [],
              networkAccess: true,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            }
          : { type: this.sandbox },
      model: turnOptions.model ?? this.defaultModel,
      effort: turnOptions.effort ?? this.defaultEffort,
      summary: null,
    }

    const turnResp = (await this.request<TurnStartResponse>('turn/start', turnParams)) as TurnStartResponse
    const turnId = turnResp.turn.id

    const stream = createTurnStream()
    this.turnStreams.set(turnId, stream)
    return { stream: stream.iterator, turnId, threadId: activeThreadId }
  }

  private async bootstrap(clientInfo: ClientInfo): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''
    this.child.stdout.on('data', (chunk: Buffer) => {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) this.handleLine(line)
    })

    const initializeParams = { clientInfo }
    await this.request('initialize', initializeParams)
    this.log('info', 'codex app-server initialized', { clientInfo })
  }

  private handleLine(raw: string): void {
    if (!raw.trim()) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw) as Record<string, unknown>
    } catch (error) {
      this.log('warn', 'failed to parse app-server line', { raw, error: `${error}` })
      return
    }

    const hasId = typeof (msg as { id?: unknown }).id !== 'undefined'
    const hasMethod = typeof (msg as { method?: unknown }).method === 'string'
    const isResponse = hasId && ('result' in msg || 'error' in msg)

    if (isResponse) {
      this.handleResponse(msg as { id: RequestId; result?: unknown; error?: unknown })
      return
    }

    if (hasId && hasMethod) {
      this.handleServerRequest(msg as { id: RequestId; method: string; params?: unknown })
      return
    }

    if (hasMethod) {
      this.handleNotification(msg as ServerNotification)
    }
  }

  private handleServerRequest(message: { id: RequestId; method: string; params?: unknown }): void {
    const { id, method, params } = message
    this.log('info', 'codex app-server request (server → client)', { id, method })

    // Auto-decline risky requests to avoid hangs; extend if approvals are needed later.
    let result: unknown = { acknowledged: true }

    switch (method) {
      case 'item/commandExecution/requestApproval':
        result = { decision: 'decline', acceptSettings: null }
        break
      case 'item/fileChange/requestApproval':
        result = { decision: 'decline' }
        break
      case 'applyPatchApproval':
        result = { decision: 'denied' }
        break
      case 'execCommandApproval':
        result = { decision: 'denied' }
        break
      default:
        this.log('warn', 'unrecognized server request method, sending empty ack', { method, params })
    }

    this.send({ id, result })
  }

  private handleResponse(message: { id: RequestId; result?: unknown; error?: unknown }): void {
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)

    if (message.error !== undefined) {
      entry.reject(message.error)
      this.log('error', 'codex app-server request failed', {
        id: message.id,
        method: entry.method,
        error: message.error,
        latencyMs: Date.now() - entry.startedAt,
      })
      return
    }

    entry.resolve(message.result)
    this.log('info', 'codex app-server response', {
      id: message.id,
      method: entry.method,
      latencyMs: Date.now() - entry.startedAt,
    })
  }

  private handleNotification(notification: ServerNotification | { method: string; params?: unknown }): void {
    const { method } = notification
    const pushReasoning = (delta: string | null | undefined) => {
      if (!delta) return
      const turn = this.lastTurnStream()
      if (!turn) return
      if (turn.lastReasoningDelta === delta) {
        this.log('info', 'skipping duplicate reasoning delta', { delta })
        return
      }
      turn.lastReasoningDelta = delta
      turn.push({ type: 'reasoning', delta })
    }

    const pushTool = (
      payload:
        | {
            toolKind: 'command' | 'file' | 'mcp' | 'webSearch'
            id: string
            status: 'started' | 'completed' | 'delta'
            title: string
            detail?: string
            data?: Record<string, unknown>
          }
        | {
            toolKind: 'command'
            id: string
            status: 'delta'
            title: string
            detail?: string
            data?: Record<string, unknown>
          },
    ) => {
      const turn = this.lastTurnStream()
      if (!turn) return
      turn.push({ type: 'tool', ...payload })
    }

    const pushUsage = (usage: TokenUsage) => {
      const turn = this.lastTurnStream()
      if (!turn) return
      turn.push({ type: 'usage', usage })
    }

    const toToolDeltaFromItem = (
      item: ThreadItem,
      status: 'started' | 'completed',
    ): Parameters<typeof pushTool>[0] | null => {
      switch (item.type) {
        case 'commandExecution':
          return {
            toolKind: 'command',
            id: item.id,
            status,
            title: `${item.command}`,
            detail: item.cwd ?? undefined,
            data: {
              status: item.status,
              aggregatedOutput: item.aggregatedOutput,
              exitCode: item.exitCode,
              durationMs: item.durationMs,
            },
          }
        case 'fileChange':
          return {
            toolKind: 'file',
            id: item.id,
            status,
            title: 'file changes',
            detail: `${item.changes.length} change(s)`,
            data: { status: item.status, changes: item.changes },
          }
        case 'mcpToolCall':
          return {
            toolKind: 'mcp',
            id: item.id,
            status,
            title: `${item.server}:${item.tool}`,
            data: { status: item.status, arguments: item.arguments, result: item.result, error: item.error },
          }
        case 'webSearch':
          return {
            toolKind: 'webSearch',
            id: item.id,
            status,
            title: item.query,
          }
        default:
          return null
      }
    }

    const extractDelta = (params: unknown): string | null => {
      if (!params) return null
      if (typeof params === 'string') return params
      if (typeof params === 'object') {
        const obj = params as { delta?: unknown; msg?: { delta?: unknown } }
        if (typeof obj.delta === 'string') return obj.delta
        if (obj.msg && typeof obj.msg.delta === 'string') return obj.msg.delta
      }
      return null
    }

    switch (method) {
      case 'item/agentMessage/delta': {
        const params = notification.params as AgentMessageDeltaNotification
        const turn = this.lastTurnStream()
        if (turn) turn.push({ type: 'message', delta: params.delta })
        this.log('info', 'agent message delta', { deltaBytes: params.delta.length })
        break
      }
      case 'codex/event/agent_reasoning_delta':
      case 'codex/event/reasoning_content_delta':
      case 'item/reasoning/summaryTextDelta': {
        pushReasoning(extractDelta(notification.params ?? null))
        this.log('info', 'agent reasoning delta', { method, params: notification.params })
        break
      }
      case 'turn/completed': {
        const params = notification.params as TurnCompletedNotification
        const turnId = params.turn.id
        const stream = this.turnStreams.get(turnId)
        if (stream) {
          if (params.turn.status === 'failed') {
            stream.fail(new Error(JSON.stringify(params.turn)))
          } else {
            stream.complete(params.turn)
          }
          this.turnStreams.delete(turnId)
        }
        this.log(params.turn.status === 'failed' ? 'error' : 'info', 'turn completed', {
          turnId,
          status: params.turn.status,
        })
        break
      }
      case 'turn/started': {
        const params = notification.params as { turn: Turn }
        this.log('info', 'turn started', { turnId: params.turn.id })
        break
      }
      case 'item/started': {
        const params = notification.params as ItemStartedNotification
        const toolDelta = toToolDeltaFromItem(params.item, 'started')
        if (toolDelta) pushTool(toolDelta)
        break
      }
      case 'item/completed': {
        const params = notification.params as ItemCompletedNotification
        const toolDelta = toToolDeltaFromItem(params.item, 'completed')
        if (toolDelta) pushTool(toolDelta)
        break
      }
      case 'item/commandExecution/outputDelta': {
        const params = notification.params as CommandExecutionOutputDeltaNotification
        pushTool({
          toolKind: 'command',
          id: params.itemId,
          status: 'delta',
          title: 'command output',
          detail: params.delta,
        })
        break
      }
      case 'item/mcpToolCall/progress': {
        const params = notification.params as McpToolCallProgressNotification
        pushTool({
          toolKind: 'mcp',
          id: params.itemId,
          status: 'delta',
          title: 'mcp progress',
          detail: params.message,
        })
        break
      }
      case 'thread/tokenUsage/updated': {
        const params = notification.params as { tokenUsage?: TokenUsage; usage?: TokenUsage }
        const usage = params.tokenUsage ?? params.usage
        if (usage) pushUsage(usage)
        break
      }
      case 'codex/event/stream_error':
      case 'stream_error':
      case 'error': {
        const stream = this.lastTurnStream()
        if (stream) {
          stream.push({ type: 'error', error: notification.params ?? 'unknown' })
          stream.fail(new Error(JSON.stringify(notification.params)))
        }
        this.log('error', 'codex stream error', { method, params: notification.params })
        break
      }
      default:
        // Catch-all: still log unknown/other notifications so we don't lose signal, but let
        // downstream filters handle volume (structured JSON makes it easy to grep/label).
        this.log('info', 'codex app-server notification', { method, params: notification.params })
        break
    }
  }

  private lastTurnStream(): TurnStream | undefined {
    const entries = Array.from(this.turnStreams.values())
    return entries.at(-1)
  }

  private request<T = unknown>(method: ClientRequest['method'], params: ClientRequest['params']): Promise<T> {
    const id: RequestId = newId()
    const payload = { id, method, params } as ClientRequest & { id: RequestId }

    const promise = new Promise<T>((resolve, reject) => {
      const wrappedResolve = (value: unknown) => resolve(value as T)
      this.pending.set(id, { resolve: wrappedResolve, reject, method, startedAt: Date.now() })
    })

    this.child.stdin.write(`${JSON.stringify(payload)}\n`)
    this.log('info', 'codex app-server request', { id, method })
    return promise
  }

  private log(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void {
    if (this.logger) {
      this.logger(level, message, meta)
      return
    }

    const entry = {
      ts: new Date().toISOString(),
      level,
      message,
      component: 'codex-app-server-client',
      ...(meta ?? {}),
    }

    const line = JSON.stringify(entry)
    const sink: typeof console.log = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    sink(line)
  }
}
