import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

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

import { SymphonyError, toError } from './errors'
import type { Logger } from './logger'
import type { TokenUsageTotals } from './types'

type PendingRequest = {
  method: string
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timer: Timer
}

type ActiveTurn = {
  threadId: string
  turnId: string
  resolve: (value: TurnOutcome) => void
  reject: (reason: unknown) => void
  timer: Timer
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

type CodexAppSessionOptions = {
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
  onEvent: (event: CodexEvent) => void
  onToolCall: (tool: string, args: unknown) => Promise<DynamicToolCallResponse>
}

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

export class CodexAppSession {
  private readonly options: CodexAppSessionOptions
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, PendingRequest>()
  private readonly logger: Logger
  private buffer = ''
  private nextRequestId = 1
  private ready = false
  private threadId: string | null = null
  private activeTurn: ActiveTurn | null = null
  private exitError: Error | null = null
  private stopped = false

  constructor(options: CodexAppSessionOptions) {
    this.options = options
    this.logger = options.logger.child({ component: 'codex-app-session', workspace_path: options.cwd })
    this.child = spawn('bash', ['-lc', options.command], {
      cwd: options.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop() ?? ''
      for (const line of lines) {
        this.handleStdoutLine(line)
      }
    })
    this.child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text.length > 0) {
        this.logger.log('info', 'codex_stderr', { message: text })
      }
    })
    this.child.on('exit', (code, signal) => {
      const error = new SymphonyError(
        'port_exit',
        `codex app-server exited code=${code ?? 'unknown'} signal=${signal ?? 'unknown'}`,
      )
      this.exitError = error
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(error)
        this.pending.delete(id)
      }
      if (this.activeTurn) {
        clearTimeout(this.activeTurn.timer)
        this.activeTurn.reject(error)
        this.activeTurn = null
      }
    })
  }

  async initialize(): Promise<void> {
    if (this.ready) return
    await this.request('initialize', { clientInfo: { name: 'symphony', version: '0.1.0' }, capabilities: {} })
    this.write({ method: 'initialized', params: {} })
    this.ready = true
    this.options.onEvent({
      event: 'session_started',
      timestamp: new Date().toISOString(),
      codexAppServerPid: String(this.child.pid ?? ''),
      message: 'codex app-server initialized',
    })
  }

  async runTurn(prompt: string): Promise<TurnOutcome> {
    await this.initialize()
    const threadId = this.threadId ?? (await this.startThread())
    const turnId = await this.startTurn(threadId, prompt)
    return new Promise<TurnOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.activeTurn = null
        reject(new SymphonyError('turn_timeout', `turn ${turnId} exceeded ${this.options.turnTimeoutMs}ms`))
      }, this.options.turnTimeoutMs)

      this.activeTurn = {
        threadId,
        turnId,
        resolve,
        reject,
        timer,
      }
    })
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (!this.child.killed) {
      this.child.kill('SIGKILL')
    }
  }

  private async startThread(): Promise<string> {
    const params: ThreadStartParams = {
      model: null,
      modelProvider: null,
      cwd: this.options.cwd,
      approvalPolicy: this.options.approvalPolicy,
      sandbox: this.options.threadSandbox,
      config: { mcp_servers: {}, web_search: 'live' },
      serviceName: 'symphony',
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      ephemeral: false,
      dynamicTools: this.options.dynamicTools,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    }
    const response = (await this.request('thread/start', params)) as ThreadStartResponse
    this.threadId = response.thread.id
    return response.thread.id
  }

  private async startTurn(threadId: string, prompt: string): Promise<string> {
    const params: TurnStartParams = {
      threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      cwd: this.options.cwd,
      approvalPolicy: this.options.approvalPolicy,
      sandboxPolicy: toSandboxPolicy(this.options.threadSandbox, this.options.turnSandboxPolicy),
      model: null,
      serviceTier: null,
      effort: null,
      summary: null,
      personality: null,
      outputSchema: null,
      collaborationMode: null,
    }
    const response = (await this.request('turn/start', params)) as TurnStartResponse
    const turnId = response.turn.id
    const sessionId = `${threadId}-${turnId}`
    this.options.onEvent({
      event: 'turn_started',
      timestamp: new Date().toISOString(),
      codexAppServerPid: String(this.child.pid ?? ''),
      threadId,
      turnId,
      sessionId,
      message: this.options.title,
    })
    return turnId
  }

  private handleStdoutLine(rawLine: string): void {
    const trimmed = rawLine.trim()
    if (trimmed.length === 0) return

    let message: Record<string, unknown>
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>
    } catch (error) {
      this.options.onEvent({
        event: 'malformed',
        timestamp: new Date().toISOString(),
        codexAppServerPid: String(this.child.pid ?? ''),
        message: trimmed.slice(0, 400),
      })
      this.logger.log('warn', 'codex_stdout_malformed', { error: toError(error).message, line: trimmed.slice(0, 400) })
      return
    }

    if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if ('error' in message && message.error !== undefined) {
        pending.reject(new SymphonyError('response_error', `${pending.method} failed`, message.error))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (typeof message.id === 'number' && typeof message.method === 'string') {
      void this.handleServerRequest(message.id, message.method, message.params)
      return
    }

    if (typeof message.method === 'string') {
      this.handleNotification(message.method, message.params)
    }
  }

  private async handleServerRequest(id: number, method: string, params: unknown): Promise<void> {
    if (method === 'item/commandExecution/requestApproval') {
      this.write({ id, result: { decision: 'acceptForSession' } })
      this.emitEvent('approval_auto_approved', params, 'auto-approved command execution')
      return
    }
    if (method === 'item/fileChange/requestApproval') {
      this.write({ id, result: { decision: 'acceptForSession' } })
      this.emitEvent('approval_auto_approved', params, 'auto-approved file change')
      return
    }
    if (method === 'applyPatchApproval' || method === 'execCommandApproval') {
      this.write({ id, result: { decision: 'approved_for_session' } })
      this.emitEvent('approval_auto_approved', params, 'auto-approved legacy approval request')
      return
    }
    if (method === 'mcpServer/elicitation/request') {
      this.write({ id, result: { action: 'decline', content: null } })
      this.emitEvent('notification', params, 'declined mcp elicitation request')
      return
    }
    if (method === 'item/tool/requestUserInput') {
      this.write({ id, error: { code: -32000, message: 'turn_input_required' } })
      const error = new SymphonyError('turn_input_required', 'agent requested user input')
      this.emitEvent('turn_input_required', params, 'agent requested user input')
      if (this.activeTurn) {
        clearTimeout(this.activeTurn.timer)
        this.activeTurn.reject(error)
        this.activeTurn = null
      }
      return
    }
    if (method === 'item/tool/call') {
      const raw = params as { tool?: unknown; arguments?: unknown } | null
      const toolName = typeof raw?.tool === 'string' ? raw.tool : ''
      try {
        const result = await this.options.onToolCall(toolName, raw?.arguments)
        this.write({ id, result })
        if (!result.success) {
          this.emitEvent('unsupported_tool_call', params, `tool ${toolName} returned failure`)
        }
      } catch (error) {
        const payload: DynamicToolCallResponse = {
          success: false,
          contentItems: [{ type: 'inputText', text: JSON.stringify({ error: toError(error).message }) }],
        }
        this.write({ id, result: payload })
        this.emitEvent('unsupported_tool_call', params, `tool ${toolName} failed`)
      }
      return
    }

    this.write({ id, result: { acknowledged: true } })
    this.emitEvent('notification', params, `acknowledged ${method}`)
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === 'turn/completed') {
      const threadId = extractThreadId(params) ?? this.activeTurn?.threadId ?? this.threadId
      const turnId = extractTurnId(params) ?? this.activeTurn?.turnId
      const status = (params as { turn?: { status?: unknown } } | null | undefined)?.turn?.status
      const sessionId = threadId && turnId ? `${threadId}-${turnId}` : null
      if (this.activeTurn && turnId === this.activeTurn.turnId) {
        clearTimeout(this.activeTurn.timer)
        const resolver = this.activeTurn
        this.activeTurn = null
        if (status === 'completed') {
          resolver.resolve({ status: 'completed', threadId: resolver.threadId, turnId: resolver.turnId })
          this.options.onEvent({
            event: 'turn_completed',
            timestamp: new Date().toISOString(),
            codexAppServerPid: String(this.child.pid ?? ''),
            sessionId,
            threadId: resolver.threadId,
            turnId: resolver.turnId,
            message: this.options.title,
          })
          return
        }
        if (status === 'interrupted') {
          resolver.reject(new SymphonyError('turn_cancelled', `turn ${resolver.turnId} was interrupted`))
          this.options.onEvent({
            event: 'turn_cancelled',
            timestamp: new Date().toISOString(),
            codexAppServerPid: String(this.child.pid ?? ''),
            sessionId,
            threadId: resolver.threadId,
            turnId: resolver.turnId,
            message: this.options.title,
          })
          return
        }
        resolver.reject(new SymphonyError('turn_failed', `turn ${resolver.turnId} failed`, params))
        this.options.onEvent({
          event: 'turn_failed',
          timestamp: new Date().toISOString(),
          codexAppServerPid: String(this.child.pid ?? ''),
          sessionId,
          threadId: resolver.threadId,
          turnId: resolver.turnId,
          message: this.options.title,
        })
      }
      return
    }

    if (method === 'item/agentMessage/delta') {
      const delta =
        typeof (params as { delta?: unknown } | null | undefined)?.delta === 'string'
          ? (params as { delta: string }).delta
          : null
      if (delta) {
        this.emitEvent('notification', params, delta)
      }
      return
    }

    if (method === 'thread/tokenUsage/updated') {
      const usage = extractTokenUsage(
        (params as { tokenUsage?: unknown; usage?: unknown } | null | undefined)?.tokenUsage ??
          (params as { usage?: unknown } | null | undefined)?.usage,
      )
      if (usage) {
        this.options.onEvent({
          event: 'notification',
          timestamp: new Date().toISOString(),
          codexAppServerPid: String(this.child.pid ?? ''),
          threadId: extractThreadId(params) ?? this.threadId,
          turnId: extractTurnId(params),
          usage,
        })
      }
      return
    }

    if (method === 'account/rateLimits/updated') {
      const rateLimits = ((params as { rateLimits?: unknown } | null | undefined)?.rateLimits ??
        null) as RateLimitSnapshot | null
      this.options.onEvent({
        event: 'notification',
        timestamp: new Date().toISOString(),
        codexAppServerPid: String(this.child.pid ?? ''),
        threadId: extractThreadId(params) ?? this.threadId,
        turnId: extractTurnId(params),
        rateLimits,
      })
      return
    }

    if (method === 'error') {
      if (this.activeTurn) {
        clearTimeout(this.activeTurn.timer)
        const resolver = this.activeTurn
        this.activeTurn = null
        resolver.reject(new SymphonyError('turn_failed', 'codex app-server reported a stream error', params))
      }
      this.emitEvent('turn_ended_with_error', params, JSON.stringify(params))
      return
    }

    this.emitEvent('other_message', params, method)
  }

  private emitEvent(event: string, params: unknown, message: string | null): void {
    const threadId = extractThreadId(params) ?? this.threadId
    const turnId = extractTurnId(params)
    const sessionId = threadId && turnId ? `${threadId}-${turnId}` : null
    this.options.onEvent({
      event,
      timestamp: new Date().toISOString(),
      codexAppServerPid: String(this.child.pid ?? ''),
      sessionId,
      threadId,
      turnId,
      message,
    })
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    if (this.exitError) throw this.exitError
    const id = this.nextRequestId
    this.nextRequestId += 1

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new SymphonyError('response_timeout', `${method} did not complete within ${this.options.readTimeoutMs}ms`),
        )
      }, this.options.readTimeoutMs)

      this.pending.set(id, {
        method,
        resolve,
        reject,
        timer,
      })

      try {
        this.write({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  private write(payload: unknown): void {
    const serialized = `${JSON.stringify(payload)}\n`
    const ok = this.child.stdin.write(serialized)
    if (!ok) {
      this.logger.log('warn', 'codex_stdin_backpressure', {})
    }
  }
}
