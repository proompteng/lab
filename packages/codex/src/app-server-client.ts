import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

import type { ClientInfo, RequestId } from './app-server'
import type { ReasoningEffort } from './app-server/ReasoningEffort'
import type { JsonValue } from './app-server/serde_json/JsonValue'
import type {
  AccountRateLimitsUpdatedNotification,
  AgentMessageDeltaNotification,
  AskForApproval,
  CommandExecutionOutputDeltaNotification,
  ContextCompactedNotification,
  ErrorNotification,
  FileChangeOutputDeltaNotification,
  ItemCompletedNotification,
  ItemStartedNotification,
  McpToolCallProgressNotification,
  RateLimitSnapshot,
  SandboxMode,
  TerminalInteractionNotification,
  ThreadItem,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadTokenUsageUpdatedNotification,
  Turn,
  TurnCompletedNotification,
  TurnDiffUpdatedNotification,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnPlanUpdatedNotification,
  TurnStartParams,
  TurnStartResponse,
} from './app-server/v2'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  method: string
  startedAt: number
}

type JsonRpcRequestMethod = 'initialize' | 'thread/start' | 'turn/start' | 'turn/interrupt'
type JsonRpcRequest = { id: RequestId; method: JsonRpcRequestMethod; params: unknown }
type JsonRpcNotification = { method: string; params?: unknown }

export type StreamDelta =
  | { type: 'message' | 'reasoning'; delta: string }
  | {
      type: 'plan'
      explanation: string | null
      plan: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }>
    }
  | { type: 'rate_limits'; rateLimits: RateLimitSnapshot }
  | {
      type: 'tool'
      toolKind: 'command' | 'file' | 'mcp' | 'webSearch'
      id: string
      status: 'started' | 'delta' | 'completed'
      title: string
      detail?: string
      data?: Record<string, unknown>
    }
  | { type: 'usage'; usage: unknown }
  | { type: 'error'; error: unknown }

type ToolPayload = Omit<Extract<StreamDelta, { type: 'tool' }>, 'type'>

type TurnStream = {
  push: (delta: StreamDelta) => void
  complete: (turn: Turn | null) => void
  fail: (error: unknown) => void
  iterator: AsyncGenerator<StreamDelta, Turn | null, void>
  lastReasoningDelta: string | null
  lastMessageDelta: string | null
}

type LegacySandboxMode = 'dangerFullAccess' | 'workspaceWrite' | 'readOnly'
type SandboxModeInput = SandboxMode | LegacySandboxMode
type LegacyApprovalMode = 'unlessTrusted' | 'onFailure' | 'onRequest'
type ApprovalModeInput = AskForApproval | LegacyApprovalMode

export type CodexAppServerOptions = {
  binaryPath?: string
  cwd?: string
  sandbox?: SandboxModeInput
  approval?: ApprovalModeInput
  defaultModel?: string
  defaultEffort?: ReasoningEffort
  /**
   * Thread-level app-server config blob.
   *
   * When omitted, we keep MCP servers disabled by default.
   */
  threadConfig?: { [key in string]?: JsonValue } | null
  /**
   * Opt into emitting raw response items on the event stream.
   * Defaults to false.
   */
  experimentalRawEvents?: boolean
  clientInfo?: ClientInfo
  logger?: (level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void
  bootstrapTimeoutMs?: number
}

const normalizeSandboxMode = (mode: SandboxModeInput): SandboxMode => {
  if (mode === 'dangerFullAccess') return 'danger-full-access'
  if (mode === 'workspaceWrite') return 'workspace-write'
  if (mode === 'readOnly') return 'read-only'
  return mode
}

const normalizeApprovalPolicy = (approval: ApprovalModeInput): AskForApproval => {
  if (approval === 'onFailure') return 'on-failure'
  if (approval === 'onRequest') return 'on-request'
  if (approval === 'unlessTrusted') return 'untrusted'
  return approval
}

const defaultClientInfo: ClientInfo = { name: 'lab', title: 'lab app-server client', version: '0.0.0' }
const DEFAULT_EFFORT: ReasoningEffort = 'high'
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 10_000

const newId = (() => {
  let id = 1
  return () => id++
})()

const toSandboxPolicy = (mode: SandboxMode) => {
  if (mode === 'workspace-write') {
    return {
      type: 'workspaceWrite' as const,
      writableRoots: [],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    }
  }
  if (mode === 'read-only') {
    return { type: 'readOnly' as const }
  }
  return { type: 'dangerFullAccess' as const }
}

const createTurnStream = (): TurnStream => {
  const queue: Array<StreamDelta | { done: true; turn: Turn | null } | { error: unknown }> = []
  let resolver: (() => void) | null = null
  let closed = false
  let stream: TurnStream

  const wake = () => {
    if (resolver) {
      resolver()
      resolver = null
    }
  }

  const push = (delta: StreamDelta) => {
    if (closed) return
    if (delta.type === 'message') stream.lastMessageDelta = delta.delta
    queue.push(delta)
    wake()
  }

  const complete = (turn: Turn | null) => {
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

  stream = {
    push,
    complete,
    fail,
    iterator,
    lastReasoningDelta: null,
    lastMessageDelta: null,
  }
  return stream
}

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams
  private fatalErrorHandled = false
  private send = (payload: unknown) => {
    this.writeToChild(payload)
  }
  private pending = new Map<RequestId, PendingRequest>()
  // Active turn streams keyed by Codex turn_id. Notifications without turn_id are only inferred when exactly
  // one active stream exists to preserve the per-conversation “one live turn at a time” invariant enforced upstream.
  private turnStreams = new Map<string, TurnStream>()
  private turnItems = new Map<string, Set<string>>()
  private itemTurnMap = new Map<string, string>()
  private lastActiveTurnId: string | null = null
  private readyPromise: Promise<void>
  private resolveReady: (() => void) | null = null
  private rejectReady: ((reason: unknown) => void) | null = null
  private readySettled = false
  private bootstrapTimeout: ReturnType<typeof setTimeout> | null = null
  private bootstrapTimeoutMs: number
  private logger: CodexAppServerOptions['logger']
  private sandbox: SandboxMode
  private approval: AskForApproval
  private defaultModel: string
  private defaultEffort: ReasoningEffort
  private threadConfig: { [key in string]?: JsonValue } | null
  private experimentalRawEvents: boolean

  constructor({
    binaryPath = 'codex',
    cwd,
    sandbox = 'danger-full-access',
    approval = 'never',
    defaultModel = 'gpt-5.3-codex',
    defaultEffort = DEFAULT_EFFORT,
    threadConfig,
    experimentalRawEvents = false,
    clientInfo = defaultClientInfo,
    logger,
    bootstrapTimeoutMs = DEFAULT_BOOTSTRAP_TIMEOUT_MS,
  }: CodexAppServerOptions = {}) {
    this.logger = logger
    this.sandbox = normalizeSandboxMode(sandbox)
    this.approval = normalizeApprovalPolicy(approval)
    this.defaultModel = defaultModel
    this.defaultEffort = defaultEffort
    this.threadConfig =
      threadConfig === undefined ? { mcp_servers: {}, 'features.web_search_request': true } : threadConfig
    this.experimentalRawEvents = experimentalRawEvents
    this.bootstrapTimeoutMs = bootstrapTimeoutMs

    const args = ['--sandbox', this.sandbox, '--ask-for-approval', this.approval, '--model', defaultModel, 'app-server']
    this.child = spawn(binaryPath, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })

    this.bootstrapTimeout = setTimeout(() => {
      this.handleFatalError(new Error(`codex app-server failed to initialize within ${this.bootstrapTimeoutMs}ms`))
    }, this.bootstrapTimeoutMs)

    this.bootstrap(clientInfo)
      .then(() => this.settleReady())
      .catch((error) => this.handleFatalError(error))

    this.child.on('exit', (code, signal) => {
      this.log('error', 'codex app-server exited', { code, signal })
      const error = new Error(`codex app-server exited with code ${code ?? 'unknown'} signal ${signal ?? 'unknown'}`)
      this.handleFatalError(error)
    })
  }

  async ensureReady(): Promise<void> {
    await this.readyPromise
  }

  stop(): void {
    if (this.bootstrapTimeout) {
      clearTimeout(this.bootstrapTimeout)
      this.bootstrapTimeout = null
    }
    this.child.kill()
  }

  private settleReady(): void {
    if (this.readySettled) return
    this.readySettled = true
    if (this.bootstrapTimeout) {
      clearTimeout(this.bootstrapTimeout)
      this.bootstrapTimeout = null
    }
    this.resolveReady?.()
  }

  private handleFatalError(error: unknown): void {
    if (this.fatalErrorHandled) return
    this.fatalErrorHandled = true

    if (!this.readySettled) {
      this.readySettled = true
      if (this.bootstrapTimeout) {
        clearTimeout(this.bootstrapTimeout)
        this.bootstrapTimeout = null
      }
      this.rejectReady?.(error)
    }

    this.rejectAllPending(error)
    this.failAllStreams(error)

    if (!this.child.killed) {
      this.child.kill()
    }
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
    const runOpts: {
      model?: string
      cwd?: string | null
      threadId?: string
      effort?: ReasoningEffort
    } = {}
    if (model !== undefined) runOpts.model = model
    if (cwd !== undefined) runOpts.cwd = cwd
    if (threadId !== undefined) runOpts.threadId = threadId
    if (effort !== undefined) runOpts.effort = effort

    const { stream, turnId: activeTurnId, threadId: activeThreadId } = await this.runTurnStream(prompt, runOpts)
    let text = ''
    let turn: Turn | null = null

    const iterator = stream[Symbol.asyncIterator]()
    try {
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
    } finally {
      this.clearTurn(activeTurnId)
    }

    return { text, turn, threadId: activeThreadId }
  }

  async runTurnStream(
    prompt: string,
    {
      model,
      cwd,
      threadId,
      effort,
    }: {
      model?: string
      cwd?: string | null
      threadId?: string
      effort?: ReasoningEffort
    } = {},
  ): Promise<{ stream: AsyncGenerator<StreamDelta, Turn | null, void>; turnId: string; threadId: string }> {
    await this.ensureReady()

    const turnOptions: {
      model?: string
      cwd?: string | null
      threadId?: string
      effort?: ReasoningEffort
    } = {}
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
        config: this.threadConfig,
        baseInstructions: null,
        developerInstructions: null,
        personality: null,
        ephemeral: null,
        dynamicTools: null,
        experimentalRawEvents: this.experimentalRawEvents,
      }

      const threadResp = (await this.request<ThreadStartResponse>('thread/start', threadParams)) as ThreadStartResponse
      activeThreadId = threadResp.thread.id
    }

    const turnParams: TurnStartParams = {
      threadId: activeThreadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      cwd: turnOptions.cwd ?? null,
      approvalPolicy: this.approval,
      sandboxPolicy: toSandboxPolicy(this.sandbox),
      model: turnOptions.model ?? this.defaultModel,
      effort: turnOptions.effort ?? this.defaultEffort,
      summary: null,
      personality: null,
      outputSchema: null,
      collaborationMode: null,
    }

    const turnResp = (await this.request<TurnStartResponse>('turn/start', turnParams)) as TurnStartResponse
    const turnId = turnResp.turn.id

    const stream = createTurnStream()
    this.turnStreams.set(turnId, stream)
    this.turnItems.set(turnId, new Set())
    this.lastActiveTurnId = turnId
    return { stream: stream.iterator, turnId, threadId: activeThreadId }
  }

  async interruptTurn(turnId: string, threadId: string): Promise<void> {
    await this.ensureReady()
    const params: TurnInterruptParams = { threadId, turnId }
    try {
      await this.request<TurnInterruptResponse>('turn/interrupt', params)
      this.log('info', 'turn interrupt requested', { turnId, threadId })
    } catch (error) {
      this.log('warn', 'turn interrupt failed', { turnId, threadId, error })
      throw error
    } finally {
      this.clearTurn(turnId)
    }
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
      this.handleNotification(msg as JsonRpcNotification)
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

  private handleNotification(notification: JsonRpcNotification): void {
    const { method } = notification
    const params = notification.params

    const routeToStream = (
      targetParams: unknown,
      handler: (stream: TurnStream, turnId: string) => void,
      { trackItem }: { trackItem?: boolean } = {},
    ): boolean => {
      if (trackItem) this.trackItemFromParams(targetParams)
      const resolved = this.resolveTurnStream(targetParams)
      if (!resolved) {
        const activeTurnIds = Array.from(this.turnStreams.keys())
        const turnId = this.findTurnId(targetParams)
        this.log('info', 'dropping notification for inactive turn stream', {
          method,
          turnId,
          activeTurnIds,
        })
        return false
      }
      handler(resolved.stream, resolved.turnId)
      return true
    }

    const pushReasoning = (delta: string | null | undefined) => {
      if (!delta) return
      routeToStream(params, (stream) => {
        if (stream.lastReasoningDelta === delta) {
          this.log('info', 'skipping duplicate reasoning delta', { delta })
          return
        }
        stream.lastReasoningDelta = delta
        stream.push({ type: 'reasoning', delta })
      })
    }

    const pushMessage = (targetParams: unknown, delta: string, { trackItem }: { trackItem?: boolean } = {}) => {
      routeToStream(
        targetParams,
        (stream) => {
          if (stream.lastMessageDelta === delta) {
            this.log('info', 'skipping duplicate agent message delta', {
              method,
              deltaBytes: delta.length,
            })
            return
          }

          stream.push({ type: 'message', delta })
        },
        { trackItem },
      )
    }

    const pushTool = (targetParams: unknown, payload: ToolPayload, { trackItem }: { trackItem?: boolean } = {}) => {
      routeToStream(targetParams, (stream) => stream.push({ type: 'tool', ...payload }), { trackItem })
    }

    const pushUsage = (usage: unknown) => {
      routeToStream(params, (stream) => {
        stream.push({ type: 'usage', usage })
      })
    }

    const normalizePlanStepStatus = (status: unknown): 'pending' | 'in_progress' | 'completed' | null => {
      if (status === 'pending' || status === 'in_progress' || status === 'completed') return status
      if (status === 'inProgress') return 'in_progress'
      return null
    }

    const decodeMaybeBase64Text = (raw: string): string => {
      // Some app-server surfaces stream bytes as base64 because they may not be valid UTF-8 (e.g. PTY control bytes).
      // Decode when we can round-trip; if the decoded text isn't "human output" (ANSI escapes, spinners, etc.),
      // scrub terminal noise and drop empty fragments.
      if (raw.length < 4) return raw
      // Base64 without padding is valid; reject only impossible lengths.
      if (raw.length % 4 === 1) return raw

      const looksMostlyPrintable = (decoded: string) => {
        if (decoded.length === 0) return false
        if (decoded.includes('\uFFFD')) return false

        let printable = 0
        let nonWhitespace = 0
        for (let i = 0; i < decoded.length; i += 1) {
          const code = decoded.charCodeAt(i)
          if (code === 9 || code === 10 || code === 13) {
            printable += 1
            continue
          }
          if (code >= 32 && code !== 127) {
            printable += 1
            if (code !== 32) nonWhitespace += 1
          }
        }

        if (nonWhitespace === 0) return false
        return printable / decoded.length >= 0.9
      }

      const sanitizeTerminalNoise = (text: string) => {
        // Strip ANSI escapes (CSI + OSC), then drop remaining C0 controls (except whitespace) and common spinners.
        const stripAnsi = (input: string) => {
          const result: string[] = []
          let i = 0

          while (i < input.length) {
            const char = input[i]
            if (char !== '\u001b') {
              result.push(char)
              i += 1
              continue
            }

            const next = input[i + 1]
            if (next === '[') {
              // CSI: ESC [ ... <final>
              i += 2
              while (i < input.length) {
                const code = input.charCodeAt(i)
                i += 1
                if (code >= 0x40 && code <= 0x7e) break
              }
              continue
            }

            if (next === ']') {
              // OSC: ESC ] ... BEL  OR  ESC ] ... ESC \
              i += 2
              while (i < input.length) {
                const current = input[i]
                if (current === '\u0007') {
                  i += 1
                  break
                }
                if (current === '\u001b' && input[i + 1] === '\\') {
                  i += 2
                  break
                }
                i += 1
              }
              continue
            }

            if (next === '(' || next === ')') {
              // Charset selection: ESC ( X  or  ESC ) X
              i += 3
              continue
            }

            // Fallback: drop ESC byte.
            i += 1
          }

          return result.join('')
        }

        const strippedAnsi = stripAnsi(text)

        const filtered: string[] = []
        let sawNonWhitespace = false
        let sawNonSpinner = false
        for (let i = 0; i < strippedAnsi.length; i += 1) {
          const code = strippedAnsi.charCodeAt(i)
          const char = strippedAnsi[i]

          if (code === 9 || code === 10 || code === 13) {
            filtered.push(char)
            continue
          }

          if (code < 32 || code === 127) continue

          filtered.push(char)

          if (char.trim().length === 0) continue
          sawNonWhitespace = true
          if (code < 0x2800 || code > 0x28ff) sawNonSpinner = true
        }

        if (!sawNonWhitespace) return ''
        if (!sawNonSpinner) return ''

        return filtered.join('')
      }

      const decodeBase64TokenIfPrintable = (token: string): string | null => {
        const decoded = decodeBase64Token(token, { allowShort: true })
        if (decoded === null) return null
        if (!looksMostlyPrintable(decoded)) return null
        return decoded
      }

      const decodeBase64Token = (token: string, options?: { allowShort?: boolean }): string | null => {
        const allowShort = options?.allowShort ?? false
        if (!allowShort && token.length < 8) return null
        if (token.length < 2) return null
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(token)) return null
        if (token.length % 4 === 1) return null

        try {
          const padded = token.length % 4 === 0 ? token : `${token}${'='.repeat(4 - (token.length % 4))}`
          const buf = Buffer.from(padded, 'base64')
          const stripPad = (value: string) => value.replace(/=+$/g, '')
          if (stripPad(buf.toString('base64')) !== stripPad(token)) return null

          const decoded = buf.toString('utf8')
          if (looksMostlyPrintable(decoded)) return decoded

          const cleaned = sanitizeTerminalNoise(decoded)
          return cleaned
        } catch {
          return null
        }
      }

      const decodedSingle = decodeBase64Token(raw)
      if (decodedSingle !== null) return decodedSingle

      // Some tool output deltas arrive as concatenated base64 fragments (often padded) with no separator,
      // sometimes followed by plain UTF-8 output (e.g. JSON) in the same chunk.
      if (!raw.includes('=')) return raw

      const firstNonBase64Char = raw.search(/[^A-Za-z0-9+/=]/)
      const base64Prefix = firstNonBase64Char === -1 ? raw : raw.slice(0, firstNonBase64Char)
      const suffix = firstNonBase64Char === -1 ? '' : raw.slice(firstNonBase64Char)
      if (!base64Prefix.includes('=')) return raw

      const tokens: string[] = []
      let cursor = 0
      for (let i = 0; i < base64Prefix.length; i += 1) {
        if (base64Prefix[i] !== '=') continue
        let j = i
        while (j < base64Prefix.length && base64Prefix[j] === '=') j += 1
        const token = base64Prefix.slice(cursor, j)
        if (token.length > 0) tokens.push(token)
        cursor = j
        i = j - 1
      }

      if (tokens.length === 0) return raw

      const remainder = cursor < base64Prefix.length ? base64Prefix.slice(cursor) : ''

      const decodedPieces: string[] = []
      for (const token of tokens) {
        const decoded = decodeBase64Token(token, { allowShort: true })
        if (decoded === null) return raw
        decodedPieces.push(decoded)
      }

      const decodedPrefix = decodedPieces.join('')
      const decodedRemainder = remainder ? decodeBase64TokenIfPrintable(remainder) : null
      return `${decodedPrefix}${decodedRemainder ?? remainder}${suffix}`
    }

    const toToolDeltaFromItem = (item: ThreadItem, status: 'started' | 'completed'): ToolPayload | null => {
      switch (item.type) {
        case 'commandExecution':
          return {
            toolKind: 'command',
            id: item.id,
            status,
            title: `${item.command}`,
            // Avoid streaming cwd/exit metadata into the code fence; let the command string and output
            // speak for themselves to prevent trailing “/workspace/…” lines.
            detail: undefined,
            data: {
              status: item.status,
              aggregatedOutput:
                typeof item.aggregatedOutput === 'string' ? decodeMaybeBase64Text(item.aggregatedOutput) : null,
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

    switch (method) {
      case 'item/agentMessage/delta': {
        const params = notification.params as AgentMessageDeltaNotification
        pushMessage(params, params.delta, { trackItem: true })
        this.log('info', 'agent message delta', { deltaBytes: params.delta.length })
        break
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const params = notification.params as { delta?: string }
        if (params?.delta) pushReasoning(params.delta)
        this.log('info', 'agent reasoning delta', { method, params: notification.params })
        break
      }
      case 'turn/completed': {
        const params = notification.params as TurnCompletedNotification
        const turnId = this.findTurnId(params) ?? params.turn.id
        const stream = this.turnStreams.get(turnId)
        if (stream) {
          if (params.turn.status === 'failed') {
            stream.fail(new Error(JSON.stringify(params.turn)))
          } else {
            stream.complete(params.turn)
          }
        }
        this.clearTurn(turnId)
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
      case 'turn/diff/updated': {
        const params = notification.params as TurnDiffUpdatedNotification
        pushTool(params, {
          toolKind: 'file',
          id: `${params.turnId}:diff`,
          status: 'delta',
          title: 'turn diff',
          data: { changes: [{ path: 'turn.diff', diff: params.diff }] },
        })
        break
      }
      case 'turn/plan/updated': {
        const planUpdate = notification.params as TurnPlanUpdatedNotification
        routeToStream(planUpdate, (stream) => {
          stream.push({
            type: 'plan',
            explanation: planUpdate.explanation,
            plan: planUpdate.plan
              .map((step) => ({ step: step.step, status: normalizePlanStepStatus(step.status) }))
              .filter(
                (step): step is { step: string; status: 'pending' | 'in_progress' | 'completed' } =>
                  step.status != null,
              ),
          })
        })
        this.log('info', 'turn plan updated', { params: notification.params })
        break
      }
      case 'item/started': {
        const params = notification.params as ItemStartedNotification
        this.trackItemFromParams(params)
        const toolDelta = toToolDeltaFromItem(params.item, 'started')
        if (toolDelta) pushTool(params, toolDelta)
        break
      }
      case 'item/completed': {
        const params = notification.params as ItemCompletedNotification
        this.trackItemFromParams(params)
        const toolDelta = toToolDeltaFromItem(params.item, 'completed')
        if (toolDelta) pushTool(params, toolDelta)
        break
      }
      case 'item/commandExecution/outputDelta': {
        const params = notification.params as CommandExecutionOutputDeltaNotification
        this.trackItemFromParams(params)
        pushTool(params, {
          toolKind: 'command',
          id: params.itemId,
          status: 'delta',
          title: 'command output',
          detail: decodeMaybeBase64Text(params.delta),
        })
        break
      }
      case 'item/fileChange/outputDelta': {
        const params = notification.params as FileChangeOutputDeltaNotification
        this.trackItemFromParams(params)
        pushTool(params, {
          toolKind: 'file',
          id: params.itemId,
          status: 'delta',
          title: 'file changes',
          detail: params.delta,
        })
        break
      }
      case 'item/commandExecution/terminalInteraction': {
        const params = notification.params as TerminalInteractionNotification
        this.trackItemFromParams(params)
        pushTool(params, {
          toolKind: 'command',
          id: params.itemId,
          status: 'delta',
          title: 'command input',
          detail: params.stdin,
          data: { processId: params.processId },
        })
        break
      }
      case 'item/mcpToolCall/progress': {
        const params = notification.params as McpToolCallProgressNotification
        this.trackItemFromParams(params)
        pushTool(params, {
          toolKind: 'mcp',
          id: params.itemId,
          status: 'delta',
          title: 'mcp progress',
          detail: params.message,
        })
        break
      }
      case 'thread/tokenUsage/updated': {
        const raw = (notification.params ?? null) as
          | (Partial<ThreadTokenUsageUpdatedNotification> & { usage?: unknown })
          | null
        const usage = raw ? (raw.tokenUsage ?? raw.usage) : null
        if (usage) pushUsage(usage)
        break
      }
      case 'thread/compacted': {
        const params = notification.params as ContextCompactedNotification
        this.log('info', 'thread compacted notification received', { threadId: params.threadId, turnId: params.turnId })
        break
      }
      case 'account/rateLimits/updated': {
        const params = notification.params as AccountRateLimitsUpdatedNotification
        routeToStream(params, (stream) => {
          stream.push({ type: 'rate_limits', rateLimits: params.rateLimits })
        })
        this.log('info', 'account rate limits updated', { params })
        break
      }
      case 'error': {
        const errorPayload = (notification.params as ErrorNotification) ?? { message: 'unknown error' }
        const resolved = this.resolveTurnStream(notification.params)
        if (resolved) {
          resolved.stream.push({ type: 'error', error: errorPayload })
          this.failTurnStream(resolved.turnId, new Error(JSON.stringify(errorPayload)))
        } else {
          this.log('info', 'stream error without matching active turn (dropped)', {
            method,
            params: notification.params,
          })
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

  private findTurnId(params: unknown): string | null {
    if (!params || typeof params !== 'object') return null
    const obj = params as { [key: string]: unknown }

    if (typeof obj.id === 'string') return obj.id
    if (typeof obj.turnId === 'string') return obj.turnId
    if (typeof obj.turn_id === 'string') return obj.turn_id
    if (obj.turn && typeof (obj.turn as { id?: unknown }).id === 'string') return (obj.turn as { id: string }).id
    if (obj.params && typeof (obj.params as { turnId?: unknown }).turnId === 'string') {
      return (obj.params as { turnId: string }).turnId
    }

    if (obj.msg && typeof obj.msg === 'object') {
      const msg = obj.msg as { [key: string]: unknown }
      if (typeof msg.turnId === 'string') return msg.turnId
      if (typeof msg.turn_id === 'string') return msg.turn_id
      if (typeof msg.turnID === 'string') return msg.turnID
    }

    return null
  }

  private findItemId(params: unknown): string | null {
    if (!params || typeof params !== 'object') return null
    const obj = params as { [key: string]: unknown }

    if (typeof obj.itemId === 'string') return obj.itemId
    if (typeof obj.item_id === 'string') return obj.item_id
    if (typeof obj.call_id === 'string') return obj.call_id
    if (typeof obj.callId === 'string') return obj.callId
    if (obj.item && typeof (obj.item as { id?: unknown }).id === 'string') return (obj.item as { id: string }).id

    if (obj.msg && typeof obj.msg === 'object') {
      const msg = obj.msg as { [key: string]: unknown }
      if (typeof msg.itemId === 'string') return msg.itemId
      if (typeof msg.item_id === 'string') return msg.item_id
      if (typeof msg.call_id === 'string') return msg.call_id
      if (typeof msg.callId === 'string') return msg.callId
      if (msg.item && typeof (msg.item as { id?: unknown }).id === 'string') return (msg.item as { id: string }).id
    }

    return null
  }

  private resolveTurnStream(params: unknown): { stream: TurnStream; turnId: string } | null {
    const turnIdFromParams = this.findTurnId(params)
    const itemIdFromParams = this.findItemId(params)
    let turnId = turnIdFromParams ?? (itemIdFromParams ? (this.itemTurnMap.get(itemIdFromParams) ?? null) : null)
    if (!turnId) {
      const activeTurnIds = Array.from(this.turnStreams.keys())
      if (activeTurnIds.length !== 1) {
        this.log('info', 'ignoring notification without turnId; multiple active turns', { activeTurnIds })
        return null
      }
      const [onlyActive] = activeTurnIds
      if (!onlyActive) return null
      turnId = onlyActive
      this.log('info', 'inferring turn for notification without turnId', { activeTurnIds, inferredTurnId: onlyActive })
    }
    const stream = this.turnStreams.get(turnId)
    if (!stream) return null
    return { stream, turnId }
  }

  private trackItemFromParams(params: unknown): void {
    let turnId = this.findTurnId(params)
    const itemId = this.findItemId(params)
    if (!itemId) return

    if (!turnId) {
      const activeTurnIds = Array.from(this.turnStreams.keys())
      if (activeTurnIds.length !== 1) {
        this.log('info', 'ignoring item notification without turnId', { itemId, activeTurnIds })
        return
      }

      const [inferred] = activeTurnIds
      if (!inferred || !this.turnStreams.has(inferred)) return

      this.log('info', 'inferring turn for item without turnId', {
        itemId,
        inferredTurnId: inferred,
        activeTurnIds,
      })
      turnId = inferred
    }

    if (!turnId) return

    this.trackItemForTurn(turnId, itemId)
  }

  private trackItemForTurn(turnId: string, itemId: string): void {
    this.itemTurnMap.set(itemId, turnId)
    const existing = this.turnItems.get(turnId)
    if (existing) {
      existing.add(itemId)
      return
    }
    this.turnItems.set(turnId, new Set([itemId]))
  }

  private clearTurn(turnId: string): void {
    const items = this.turnItems.get(turnId)
    if (items) {
      for (const itemId of items) this.itemTurnMap.delete(itemId)
      this.turnItems.delete(turnId)
    }
    this.turnStreams.delete(turnId)
    if (this.lastActiveTurnId === turnId) {
      const remaining = Array.from(this.turnStreams.keys())
      this.lastActiveTurnId = remaining.length ? (remaining.at(-1) ?? null) : null
    }
  }

  private failTurnStream(turnId: string, error: unknown): void {
    const stream = this.turnStreams.get(turnId)
    if (stream) stream.fail(error)
    this.clearTurn(turnId)
  }

  private rejectAllPending(error: unknown): void {
    for (const [, entry] of this.pending) {
      entry.reject(error)
    }
    this.pending.clear()
  }

  private failAllStreams(error: unknown): void {
    const turnIds = Array.from(this.turnStreams.keys())
    for (const turnId of turnIds) {
      this.failTurnStream(turnId, error)
    }
  }

  private request<T = unknown>(method: JsonRpcRequestMethod, params: unknown): Promise<T> {
    const id: RequestId = newId()
    const payload: JsonRpcRequest = { id, method, params }

    const promise = new Promise<T>((resolve, reject) => {
      const wrappedResolve = (value: unknown) => resolve(value as T)
      this.pending.set(id, { resolve: wrappedResolve, reject, method, startedAt: Date.now() })
    })

    try {
      this.writeToChild(payload)
      this.log('info', 'codex app-server request', { id, method })
    } catch (error) {
      // writeToChild already triggered fatal handling; return the same promise which will reject.
      this.log('error', 'failed to send codex app-server request', { id, method, error })
    }

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

  private writeToChild(payload: unknown): void {
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`)
    } catch (error) {
      const err = error instanceof Error ? error : new Error('failed to write to codex app-server')
      this.log('error', 'failed to write to codex app-server', { error: err.message })
      this.handleFatalError(err)
      throw err
    }
  }
}

export { normalizeApprovalPolicy, normalizeSandboxMode, toSandboxPolicy }
