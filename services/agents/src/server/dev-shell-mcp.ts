import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'

type JsonRpcId = string | number | null

type JsonRpcRequest = {
  jsonrpc?: string
  id?: JsonRpcId
  method: string
  params?: unknown
}

type JsonRpcError = {
  code: number
  message: string
  data?: unknown
}

type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: JsonRpcError
}

type ShellJobStatus = 'running' | 'exited' | 'killed' | 'timed_out'

type ShellJob = {
  id: string
  command: string
  cwd: string
  process: ChildProcessByStdio<null, Readable, Readable>
  startedAt: string
  finishedAt: string | null
  status: ShellJobStatus
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  timeout: ReturnType<typeof setTimeout> | null
  stdout: OutputTail
  stderr: OutputTail
}

type OutputTail = {
  totalBytes: number
  truncated: boolean
  buffer: Buffer
}

export type DevShellMcpConfig = {
  workspaceRoot: string
  defaultTimeoutSeconds: number
  maxTimeoutSeconds: number
  defaultOutputBytes: number
  maxOutputBytes: number
  maxConcurrentJobs: number
  auditLogPath: string | null
}

type CommandInput = {
  command: string
  cwd: string
  timeoutSeconds: number
  maxOutputBytes: number
}

const MCP_SESSION_HEADER = 'Mcp-Session-Id'
const MCP_PROTOCOL_VERSION = '2024-11-05'
const MCP_SERVER_INFO = { name: 'agents-dev-shell', version: '0.1.0' } as const
const MCP_CONFIG_RESOURCE_URI = 'agents-dev-shell://config'
const TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
} as const

const DEFAULT_CONFIG: DevShellMcpConfig = {
  workspaceRoot: process.env.AGENTS_DEV_SHELL_WORKSPACE_ROOT ?? '/workspace',
  defaultTimeoutSeconds: Number(process.env.AGENTS_DEV_SHELL_DEFAULT_TIMEOUT_SECONDS ?? '60'),
  maxTimeoutSeconds: Number(process.env.AGENTS_DEV_SHELL_MAX_TIMEOUT_SECONDS ?? '1800'),
  defaultOutputBytes: Number(process.env.AGENTS_DEV_SHELL_DEFAULT_OUTPUT_BYTES ?? '20000'),
  maxOutputBytes: Number(process.env.AGENTS_DEV_SHELL_MAX_OUTPUT_BYTES ?? '200000'),
  maxConcurrentJobs: Number(process.env.AGENTS_DEV_SHELL_MAX_CONCURRENT_JOBS ?? '4'),
  auditLogPath: process.env.AGENTS_DEV_SHELL_AUDIT_LOG_PATH ?? '/workspace/.agents-dev-shell/audit.jsonl',
}

const commandInputSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'Required shell command executed as /bin/bash -lc inside the dev-shell container.',
    },
    cwd: {
      type: 'string',
      description: 'Optional working directory under /workspace. Defaults to /workspace.',
    },
    timeoutSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 1800,
      description: 'Optional timeout. Defaults to 60 seconds and is capped by server policy.',
    },
    maxOutputBytes: {
      type: 'integer',
      minimum: 1024,
      maximum: 200000,
      description: 'Optional per-stream output tail cap. Defaults to server policy.',
    },
  },
  required: ['command'],
  additionalProperties: false,
} as const

const shellOutputSchema = {
  type: 'object',
  properties: {
    jobId: { type: 'string' },
    command: { type: 'string' },
    cwd: { type: 'string' },
    status: { type: 'string' },
    exitCode: { type: ['integer', 'null'] },
    signal: { type: ['string', 'null'] },
    timedOut: { type: 'boolean' },
    startedAt: { type: 'string' },
    finishedAt: { type: ['string', 'null'] },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    stdoutBytes: { type: 'integer' },
    stderrBytes: { type: 'integer' },
    stdoutRetentionStartByte: { type: 'integer' },
    stderrRetentionStartByte: { type: 'integer' },
    stdoutNextOffset: { type: 'integer' },
    stderrNextOffset: { type: 'integer' },
    stdoutTruncated: { type: 'boolean' },
    stderrTruncated: { type: 'boolean' },
  },
  additionalProperties: false,
} as const

const toolsListResult = {
  tools: [
    {
      name: 'shell_run',
      title: 'Run shell command',
      description:
        'Use this when the user explicitly wants to execute a short shell command or script inside the private agents dev-shell container. This can modify files, call networks, or destroy data inside the container.',
      inputSchema: commandInputSchema,
      outputSchema: shellOutputSchema,
      annotations: TOOL_ANNOTATIONS,
    },
    {
      name: 'shell_start',
      title: 'Start long-running shell command',
      description:
        'Use this when the user explicitly wants to start a long-running shell command or script inside the private agents dev-shell container and poll it later with shell_read.',
      inputSchema: commandInputSchema,
      outputSchema: shellOutputSchema,
      annotations: TOOL_ANNOTATIONS,
    },
    {
      name: 'shell_read',
      title: 'Read shell job output',
      description: 'Use this when reading status and retained stdout/stderr output for a shell_start job.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'Required shell_start job id.' },
          stdoutOffset: { type: 'integer', minimum: 0, description: 'Optional stdout byte offset to read from.' },
          stderrOffset: { type: 'integer', minimum: 0, description: 'Optional stderr byte offset to read from.' },
          maxOutputBytes: { type: 'integer', minimum: 1024, maximum: 200000 },
        },
        required: ['jobId'],
        additionalProperties: false,
      },
      outputSchema: shellOutputSchema,
      annotations: { readOnlyHint: true },
    },
    {
      name: 'shell_kill',
      title: 'Kill shell job',
      description: 'Use this when the user explicitly wants to terminate a running shell_start job.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'Required shell_start job id.' },
          signal: {
            type: 'string',
            description: 'Optional POSIX signal. Defaults to SIGTERM.',
          },
        },
        required: ['jobId'],
        additionalProperties: false,
      },
      outputSchema: shellOutputSchema,
      annotations: TOOL_ANNOTATIONS,
    },
    {
      name: 'shell_status',
      title: 'List shell jobs',
      description: 'Use this when inspecting recent shell job status in the private agents dev-shell container.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'Optional job id. Omit to list recent jobs.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Optional list limit.' },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          jobs: { type: 'array', items: shellOutputSchema },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
  ],
} as const

const resourcesListResult = {
  resources: [
    {
      uri: MCP_CONFIG_RESOURCE_URI,
      name: 'Agents dev-shell MCP config',
      description: 'Server metadata and bounded command execution defaults for the Agents dev-shell MCP server.',
      mimeType: 'application/json',
    },
  ],
} as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const jsonResponse = (payload: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init.headers,
    },
  })

const asJsonRpcResponse = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result })
const asJsonRpcError = (id: JsonRpcId, error: JsonRpcError): JsonRpcResponse => ({ jsonrpc: '2.0', id, error })

const withMcpSessionHeaders = (request: Request, init: ResponseInit = {}): ResponseInit => {
  const sessionId = request.headers.get(MCP_SESSION_HEADER)
  if (!sessionId) return init
  return {
    ...init,
    headers: {
      ...init.headers,
      [MCP_SESSION_HEADER]: sessionId,
    },
  }
}

const asPositiveInteger = (args: Record<string, unknown>, key: string, fallback: number, max: number, min = 1) => {
  const value = args[key]
  if (value == null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new Error(`${key} must be a positive number`)
  }
  return Math.min(Math.floor(value), max)
}

const asOptionalString = (args: Record<string, unknown>, key: string) => {
  const value = args[key]
  if (value == null) return null
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const asRequiredString = (args: Record<string, unknown>, key: string) => {
  const value = asOptionalString(args, key)
  if (!value) throw new Error(`${key} is required`)
  return value
}

const appendTail = (tail: OutputTail, chunk: Buffer, maxBytes: number) => {
  tail.totalBytes += chunk.length
  const merged = Buffer.concat([tail.buffer, chunk])
  if (merged.length > maxBytes) {
    tail.buffer = merged.subarray(merged.length - maxBytes)
    tail.truncated = true
    return
  }
  tail.buffer = merged
}

const newTail = (): OutputTail => ({ totalBytes: 0, truncated: false, buffer: Buffer.alloc(0) })

const outputFromOffset = (tail: OutputTail, offset: number | null, maxBytes: number) => {
  const retentionStart = Math.max(0, tail.totalBytes - tail.buffer.length)
  const safeOffset = offset ?? retentionStart
  const start = Math.max(0, safeOffset - retentionStart)
  let buffer = tail.buffer.subarray(Math.min(start, tail.buffer.length))
  let truncatedBeforeOffset = safeOffset < retentionStart
  if (buffer.length > maxBytes) {
    buffer = buffer.subarray(buffer.length - maxBytes)
    truncatedBeforeOffset = true
  }
  return {
    text: buffer.toString('utf8'),
    retentionStartByte: retentionStart,
    nextOffset: tail.totalBytes,
    truncatedBeforeOffset,
  }
}

const isInside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const resolveCwd = (workspaceRoot: string, cwd: string | null) => {
  const root = resolve(workspaceRoot)
  const candidate = cwd ? resolve(root, cwd) : root
  if (!isInside(root, candidate)) {
    throw new Error(`cwd must stay under ${root}`)
  }
  if (!existsSync(candidate)) {
    throw new Error(`cwd does not exist: ${candidate}`)
  }
  return candidate
}

const buildConfigResource = (config: DevShellMcpConfig) => ({
  uri: MCP_CONFIG_RESOURCE_URI,
  mimeType: 'application/json',
  text: JSON.stringify(
    {
      serverInfo: MCP_SERVER_INFO,
      protocolVersion: MCP_PROTOCOL_VERSION,
      workspaceRoot: resolve(config.workspaceRoot),
      defaultTimeoutSeconds: config.defaultTimeoutSeconds,
      maxTimeoutSeconds: config.maxTimeoutSeconds,
      defaultOutputBytes: config.defaultOutputBytes,
      maxOutputBytes: config.maxOutputBytes,
      maxConcurrentJobs: config.maxConcurrentJobs,
      tools: toolsListResult.tools.map((tool) => tool.name),
    },
    null,
    2,
  ),
})

const parseToolCall = (params: unknown): { name: string; args: Record<string, unknown> } | JsonRpcError => {
  if (!isRecord(params)) return { code: -32602, message: 'Invalid params' }
  const name = params.name
  if (typeof name !== 'string' || name.length === 0) {
    return { code: -32602, message: 'Invalid params: missing tool name' }
  }
  const args = params.arguments
  if (args == null) return { name, args: {} }
  if (!isRecord(args)) return { code: -32602, message: 'Invalid params: arguments must be an object' }
  return { name, args: args as Record<string, unknown> }
}

const parseResourceReadParams = (params: unknown): { uri: string } | JsonRpcError => {
  if (!isRecord(params)) return { code: -32602, message: 'Invalid params' }
  const uri = params.uri
  if (typeof uri !== 'string' || uri.length === 0) {
    return { code: -32602, message: 'Invalid params: missing resource uri' }
  }
  return { uri }
}

const summarizeJob = (
  job: ShellJob,
  maxOutputBytes: number,
  offsets: { stdoutOffset?: number | null; stderrOffset?: number | null } = {},
) => {
  const stdout = outputFromOffset(job.stdout, offsets.stdoutOffset ?? null, maxOutputBytes)
  const stderr = outputFromOffset(job.stderr, offsets.stderrOffset ?? null, maxOutputBytes)
  return {
    jobId: job.id,
    command: job.command,
    cwd: job.cwd,
    status: job.status,
    exitCode: job.exitCode,
    signal: job.signal,
    timedOut: job.timedOut,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutBytes: job.stdout.totalBytes,
    stderrBytes: job.stderr.totalBytes,
    stdoutRetentionStartByte: stdout.retentionStartByte,
    stderrRetentionStartByte: stderr.retentionStartByte,
    stdoutNextOffset: stdout.nextOffset,
    stderrNextOffset: stderr.nextOffset,
    stdoutTruncated: job.stdout.truncated || stdout.truncatedBeforeOffset,
    stderrTruncated: job.stderr.truncated || stderr.truncatedBeforeOffset,
  }
}

const toolResult = (structuredContent: unknown) => ({
  structuredContent,
  content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
})

export class DevShellRunner {
  readonly config: DevShellMcpConfig
  readonly jobs = new Map<string, ShellJob>()

  constructor(config: Partial<DevShellMcpConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    mkdirSync(resolve(this.config.workspaceRoot), { recursive: true })
  }

  runningJobs() {
    return Array.from(this.jobs.values()).filter((job) => job.status === 'running')
  }

  parseCommandInput(args: Record<string, unknown>): CommandInput {
    return {
      command: asRequiredString(args, 'command'),
      cwd: resolveCwd(this.config.workspaceRoot, asOptionalString(args, 'cwd')),
      timeoutSeconds: asPositiveInteger(
        args,
        'timeoutSeconds',
        this.config.defaultTimeoutSeconds,
        this.config.maxTimeoutSeconds,
      ),
      maxOutputBytes: asPositiveInteger(
        args,
        'maxOutputBytes',
        this.config.defaultOutputBytes,
        this.config.maxOutputBytes,
        1024,
      ),
    }
  }

  audit(event: string, payload: Record<string, unknown>) {
    if (!this.config.auditLogPath) return
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...payload })
    try {
      mkdirSync(dirname(this.config.auditLogPath), { recursive: true })
      appendFileSync(this.config.auditLogPath, `${line}\n`)
    } catch (error) {
      console.warn('[agents-dev-shell] failed to write audit log', error)
    }
  }

  start(input: CommandInput): ShellJob {
    if (this.runningJobs().length >= this.config.maxConcurrentJobs) {
      throw new Error(`max concurrent jobs reached: ${this.config.maxConcurrentJobs}`)
    }

    const child = spawn('/bin/bash', ['-lc', input.command], {
      cwd: input.cwd,
      env: { ...process.env, TERM: process.env.TERM ?? 'dumb' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const now = new Date().toISOString()
    const job: ShellJob = {
      id: randomUUID(),
      command: input.command,
      cwd: input.cwd,
      process: child,
      startedAt: now,
      finishedAt: null,
      status: 'running',
      exitCode: null,
      signal: null,
      timedOut: false,
      timeout: null,
      stdout: newTail(),
      stderr: newTail(),
    }

    child.stdout.on('data', (chunk: Buffer) => appendTail(job.stdout, Buffer.from(chunk), input.maxOutputBytes))
    child.stderr.on('data', (chunk: Buffer) => appendTail(job.stderr, Buffer.from(chunk), input.maxOutputBytes))
    child.on('close', (code, signal) => {
      if (job.timeout) {
        clearTimeout(job.timeout)
        job.timeout = null
      }
      if (job.status === 'running') job.status = 'exited'
      job.exitCode = code
      job.signal = signal
      job.finishedAt = new Date().toISOString()
      this.audit('shell_job_finished', {
        jobId: job.id,
        status: job.status,
        exitCode: code,
        signal,
        timedOut: job.timedOut,
      })
    })
    child.on('error', (error) => {
      appendTail(job.stderr, Buffer.from(String(error)), input.maxOutputBytes)
    })
    job.timeout = setTimeout(() => {
      if (job.status !== 'running') return
      job.timedOut = true
      job.status = 'timed_out'
      this.killProcessGroup(job, 'SIGTERM')
    }, input.timeoutSeconds * 1000)

    this.jobs.set(job.id, job)
    this.audit('shell_job_started', {
      jobId: job.id,
      command: input.command,
      cwd: input.cwd,
      timeoutSeconds: input.timeoutSeconds,
    })
    return job
  }

  async run(input: CommandInput) {
    const job = this.start(input)
    await new Promise<void>((resolvePromise) => job.process.once('close', () => resolvePromise()))
    return job
  }

  killProcessGroup(job: ShellJob, signal = 'SIGTERM') {
    const pid = job.process.pid
    if (!pid) return false
    try {
      process.kill(-pid, signal as NodeJS.Signals)
      return true
    } catch {
      return job.process.kill(signal as NodeJS.Signals)
    }
  }

  kill(jobId: string, signal = 'SIGTERM') {
    const job = this.requireJob(jobId)
    if (job.status !== 'running') return job
    const killed = this.killProcessGroup(job, signal)
    if (killed) {
      job.status = 'killed'
      job.signal = signal
      this.audit('shell_job_killed', { jobId: job.id, signal })
    }
    return job
  }

  requireJob(jobId: string) {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error(`unknown jobId: ${jobId}`)
    return job
  }

  shutdown() {
    for (const job of this.runningJobs()) {
      job.status = 'killed'
      this.killProcessGroup(job, 'SIGTERM')
    }
  }
}

let defaultRunner: DevShellRunner | null = null

const getDefaultRunner = () => {
  defaultRunner ??= new DevShellRunner()
  return defaultRunner
}

const handleToolCall = async (
  id: JsonRpcId,
  runner: DevShellRunner,
  toolName: string,
  args: Record<string, unknown>,
) => {
  try {
    if (toolName === 'shell_run') {
      const input = runner.parseCommandInput(args)
      const job = await runner.run(input)
      return asJsonRpcResponse(id, toolResult(summarizeJob(job, input.maxOutputBytes)))
    }

    if (toolName === 'shell_start') {
      const input = runner.parseCommandInput(args)
      const job = runner.start(input)
      return asJsonRpcResponse(id, toolResult(summarizeJob(job, input.maxOutputBytes)))
    }

    if (toolName === 'shell_read') {
      const job = runner.requireJob(asRequiredString(args, 'jobId'))
      const maxOutputBytes = asPositiveInteger(
        args,
        'maxOutputBytes',
        runner.config.defaultOutputBytes,
        runner.config.maxOutputBytes,
        1024,
      )
      const stdoutOffset = asPositiveInteger(args, 'stdoutOffset', 0, Number.MAX_SAFE_INTEGER, 0)
      const stderrOffset = asPositiveInteger(args, 'stderrOffset', 0, Number.MAX_SAFE_INTEGER, 0)
      return asJsonRpcResponse(
        id,
        toolResult(
          summarizeJob(job, maxOutputBytes, {
            stdoutOffset: args.stdoutOffset == null ? null : stdoutOffset,
            stderrOffset: args.stderrOffset == null ? null : stderrOffset,
          }),
        ),
      )
    }

    if (toolName === 'shell_kill') {
      const job = runner.kill(asRequiredString(args, 'jobId'), asOptionalString(args, 'signal') ?? 'SIGTERM')
      return asJsonRpcResponse(id, toolResult(summarizeJob(job, runner.config.defaultOutputBytes)))
    }

    if (toolName === 'shell_status') {
      const jobId = asOptionalString(args, 'jobId')
      const limit = asPositiveInteger(args, 'limit', 20, 100)
      const jobs = jobId
        ? [runner.requireJob(jobId)]
        : Array.from(runner.jobs.values())
            .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
            .slice(0, limit)
      return asJsonRpcResponse(id, toolResult({ jobs: jobs.map((job) => summarizeJob(job, 4096)) }))
    }

    return asJsonRpcError(id, { code: -32601, message: `Unknown tool: ${toolName}` })
  } catch (error) {
    return asJsonRpcError(id, {
      code: -32602,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

const handleJsonRpcMessage = async (request: Request, runner: DevShellRunner, raw: unknown) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return asJsonRpcError(null, { code: -32600, message: 'Invalid Request' })
  }

  const msg = raw as JsonRpcRequest
  const id: JsonRpcId = typeof msg.id === 'string' || typeof msg.id === 'number' || msg.id === null ? msg.id : null
  const method = msg.method
  if (typeof method !== 'string' || method.length === 0) {
    return asJsonRpcError(id, { code: -32600, message: 'Invalid Request: missing method' })
  }
  const isNotification = !('id' in msg)

  switch (method) {
    case 'initialize':
      if (isNotification) return null
      return asJsonRpcResponse(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {} },
        serverInfo: MCP_SERVER_INFO,
      })
    case 'notifications/initialized':
      return null
    case 'tools/list':
      if (isNotification) return null
      return asJsonRpcResponse(id, toolsListResult)
    case 'resources/list':
      if (isNotification) return null
      return asJsonRpcResponse(id, resourcesListResult)
    case 'resources/read': {
      const parsed = parseResourceReadParams(msg.params)
      if ('code' in parsed) return isNotification ? null : asJsonRpcError(id, parsed)
      if (parsed.uri !== MCP_CONFIG_RESOURCE_URI) {
        return isNotification
          ? null
          : asJsonRpcError(id, { code: -32602, message: 'Invalid params: unknown resource uri' })
      }
      return isNotification ? null : asJsonRpcResponse(id, { contents: [buildConfigResource(runner.config)] })
    }
    case 'resources/templates/list':
      if (isNotification) return null
      return asJsonRpcResponse(id, { resourceTemplates: [] })
    case 'tools/call': {
      const parsed = parseToolCall(msg.params)
      if ('code' in parsed) return isNotification ? null : asJsonRpcError(id, parsed)
      return isNotification ? null : handleToolCall(id, runner, parsed.name, parsed.args)
    }
    default:
      return isNotification ? null : asJsonRpcError(id, { code: -32601, message: `Method not found: ${method}` })
  }
}

export const handleDevShellMcpRequest = async (request: Request, runner = getDefaultRunner()) => {
  const url = new URL(request.url)
  if (request.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/readyz')) {
    return jsonResponse({ ok: true, server: MCP_SERVER_INFO.name })
  }
  if (request.method !== 'POST' || url.pathname !== '/mcp') {
    return new Response('Not Found', { status: 404 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonResponse(
      asJsonRpcError(null, { code: -32700, message: 'Parse error' }),
      withMcpSessionHeaders(request, { status: 400 }),
    )
  }

  if (Array.isArray(body)) {
    const responses: JsonRpcResponse[] = []
    for (const item of body) {
      const response = await handleJsonRpcMessage(request, runner, item)
      if (response) responses.push(response)
    }
    if (responses.length === 0) return new Response(null, withMcpSessionHeaders(request, { status: 202 }))
    return jsonResponse(responses, withMcpSessionHeaders(request))
  }

  const response = await handleJsonRpcMessage(request, runner, body)
  if (!response) return new Response(null, withMcpSessionHeaders(request, { status: 202 }))
  return jsonResponse(response, withMcpSessionHeaders(request))
}

if (import.meta.main) {
  const port = Number(process.env.AGENTS_DEV_SHELL_MCP_PORT ?? process.env.PORT ?? '8090')
  const hostname = process.env.AGENTS_DEV_SHELL_MCP_HOST ?? '127.0.0.1'
  const server = Bun.serve({
    hostname,
    port,
    fetch: (request) => handleDevShellMcpRequest(request),
  })
  const shutdown = () => {
    defaultRunner?.shutdown()
    server.stop(true)
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  console.log(`[agents-dev-shell] MCP server listening on http://${hostname}:${port}/mcp`)
}
