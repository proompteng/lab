import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import {
  ListToolsRequestSchema,
  type CallToolResult,
  type ToolAnnotations,
  type ToolExecution,
} from '@modelcontextprotocol/sdk/types.js'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { normalizeObjectSchema, type AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import { z } from 'zod'

type ShellJobStatus = 'running' | 'exited' | 'killed' | 'timed_out'

type OutputTail = {
  totalBytes: number
  truncated: boolean
  buffer: Buffer
}

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

type CommandInput = {
  command: string
  cwd: string
  timeoutSeconds: number
  maxOutputBytes: number
}

type ProcessResult = {
  ok: boolean
  command: string
  cwd: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

type OAuth2SecurityScheme = {
  type: 'oauth2'
  scopes: string[]
}

type RegisteredToolForList = {
  title?: string
  description?: string
  inputSchema?: AnySchema
  outputSchema?: AnySchema
  annotations?: ToolAnnotations
  execution?: ToolExecution
  _meta?: Record<string, unknown>
  enabled: boolean
}

export type AuthContext = {
  subject: string
  email: string | null
  scopes: Set<string>
  payload: JWTPayload
}

export type AgentsShellConfig = {
  name: string
  version: string
  resource: string
  issuer: string
  jwksUrl: string
  supportedScopes: string[]
  allowedEmails: Set<string>
  allowedSubjects: Set<string>
  workspaceRoot: string
  defaultTimeoutSeconds: number
  maxTimeoutSeconds: number
  defaultOutputBytes: number
  maxOutputBytes: number
  maxConcurrentJobs: number
  auditLogPath: string | null
  allowedK8sNamespaces: Set<string>
  k8sApplyEnabled: boolean
  port: number
  host: string
}

const AGENTS_SHELL_VERSION = '0.1.0'
const DEFAULT_RESOURCE = 'https://agents-shell.proompteng.ai'
const DEFAULT_ISSUER = 'https://auth.proompteng.ai/realms/master'
const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource'

const SCOPES = {
  read: 'agents-shell.read',
  write: 'agents-shell.write',
  admin: 'agents-shell.admin',
  offlineAccess: 'offline_access',
} as const

const READ_SCOPES = [SCOPES.read, SCOPES.write, SCOPES.admin]
const WRITE_SCOPES = [SCOPES.write, SCOPES.admin]
const OAUTH_SESSION_SCOPES = [SCOPES.offlineAccess]

const readOnlyAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
}

const openReadOnlyAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
}

const writeAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
}

const shellAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
}

const destructiveAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
}

const commandResultSchema = z.object({
  ok: z.boolean(),
  command: z.string(),
  cwd: z.string(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  stdoutBytes: z.number().int(),
  stderrBytes: z.number().int(),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
})

const shellJobSchema = commandResultSchema.extend({
  jobId: z.string(),
  status: z.enum(['running', 'exited', 'killed', 'timed_out']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  stdoutRetentionStartByte: z.number().int(),
  stderrRetentionStartByte: z.number().int(),
  stdoutNextOffset: z.number().int(),
  stderrNextOffset: z.number().int(),
})

const shellInputSchema = {
  command: z.string().min(1).describe('Shell command executed with /bin/bash -lc inside the agents-shell container.'),
  cwd: z.string().optional().describe('Working directory under /workspace. Defaults to /workspace.'),
  timeoutSeconds: z.number().int().min(1).optional().describe('Timeout in seconds, capped by server policy.'),
  maxOutputBytes: z
    .number()
    .int()
    .min(1024)
    .optional()
    .describe('Per-stream output tail cap, capped by server policy.'),
}

const jobIdSchema = {
  jobId: z.string().min(1).describe('Job id returned by shell_start.'),
}

const parseList = (value: string | undefined) =>
  new Set(
    (value ?? '')
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  )

const parseListenPort = (env: NodeJS.ProcessEnv) => {
  const raw = env.PORT ?? env.AGENTS_SHELL_LISTEN_PORT ?? '8080'
  if (!/^\d+$/.test(raw)) {
    throw new Error(`listen port must be a numeric TCP port, got ${raw}`)
  }
  const port = Number(raw)
  if (port < 1 || port > 65535) {
    throw new Error(`listen port must be between 1 and 65535, got ${raw}`)
  }
  return port
}

const asPositiveInteger = (value: unknown, key: string, fallback: number, max: number, min = 1) => {
  if (value == null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new Error(`${key} must be a number between ${min} and ${max}`)
  }
  return Math.min(Math.floor(value), max)
}

const tail = (): OutputTail => ({ totalBytes: 0, truncated: false, buffer: Buffer.alloc(0) })

const appendTail = (output: OutputTail, chunk: Buffer, maxBytes: number) => {
  output.totalBytes += chunk.length
  const merged = Buffer.concat([output.buffer, chunk])
  if (merged.length > maxBytes) {
    output.buffer = merged.subarray(merged.length - maxBytes)
    output.truncated = true
    return
  }
  output.buffer = merged
}

const outputFromOffset = (output: OutputTail, offset: number | null, maxBytes: number) => {
  const retentionStart = Math.max(0, output.totalBytes - output.buffer.length)
  const safeOffset = offset ?? retentionStart
  const start = Math.max(0, safeOffset - retentionStart)
  let buffer = output.buffer.subarray(Math.min(start, output.buffer.length))
  let truncatedBeforeOffset = safeOffset < retentionStart
  if (buffer.length > maxBytes) {
    buffer = buffer.subarray(buffer.length - maxBytes)
    truncatedBeforeOffset = true
  }
  return {
    text: buffer.toString('utf8'),
    retentionStartByte: retentionStart,
    nextOffset: output.totalBytes,
    truncatedBeforeOffset,
  }
}

export const isInsidePath = (root: string, candidate: string) => {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export const resolveWorkspacePath = (workspaceRoot: string, inputPath?: string | null) => {
  const root = resolve(workspaceRoot)
  const candidate = inputPath ? resolve(root, inputPath) : root
  if (!isInsidePath(root, candidate)) {
    throw new Error(`path must stay under ${root}`)
  }
  return candidate
}

const resolveExistingDirectory = (workspaceRoot: string, cwd?: string | null) => {
  const candidate = resolveWorkspacePath(workspaceRoot, cwd)
  if (!existsSync(candidate)) throw new Error(`cwd does not exist: ${candidate}`)
  return candidate
}

const jsonTextResult = (structuredContent: Record<string, unknown>): CallToolResult => ({
  structuredContent,
  content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
})

const errorResult = (message: string, challenge?: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
  ...(challenge ? { _meta: { 'mcp/www_authenticate': [challenge] } } : {}),
})

export const defaultAgentsShellConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): AgentsShellConfig => {
  const issuer = env.AGENTS_SHELL_OAUTH_ISSUER ?? DEFAULT_ISSUER
  const resource = env.AGENTS_SHELL_RESOURCE ?? DEFAULT_RESOURCE

  return {
    name: 'agents-shell',
    version: AGENTS_SHELL_VERSION,
    resource,
    issuer,
    jwksUrl: env.AGENTS_SHELL_JWKS_URL ?? `${issuer.replace(/\/$/, '')}/protocol/openid-connect/certs`,
    supportedScopes: ['openid', 'email', 'profile', SCOPES.offlineAccess, SCOPES.read, SCOPES.write, SCOPES.admin],
    allowedEmails: parseList(env.AGENTS_SHELL_ALLOWED_EMAILS),
    allowedSubjects: parseList(env.AGENTS_SHELL_ALLOWED_SUBJECTS),
    workspaceRoot: env.AGENTS_SHELL_WORKSPACE_ROOT ?? '/workspace',
    defaultTimeoutSeconds: Number(env.AGENTS_SHELL_DEFAULT_TIMEOUT_SECONDS ?? '60'),
    maxTimeoutSeconds: Number(env.AGENTS_SHELL_MAX_TIMEOUT_SECONDS ?? '1800'),
    defaultOutputBytes: Number(env.AGENTS_SHELL_DEFAULT_OUTPUT_BYTES ?? '20000'),
    maxOutputBytes: Number(env.AGENTS_SHELL_MAX_OUTPUT_BYTES ?? '200000'),
    maxConcurrentJobs: Number(env.AGENTS_SHELL_MAX_CONCURRENT_JOBS ?? '4'),
    auditLogPath: env.AGENTS_SHELL_AUDIT_LOG_PATH ?? '/workspace/.agents-shell/audit.jsonl',
    allowedK8sNamespaces: parseList(env.AGENTS_SHELL_ALLOWED_K8S_NAMESPACES ?? 'agents'),
    k8sApplyEnabled: env.AGENTS_SHELL_ENABLE_K8S_APPLY === 'true',
    port: parseListenPort(env),
    host: env.HOST ?? env.AGENTS_SHELL_HOST ?? '0.0.0.0',
  }
}

export const oauthProtectedResourceMetadata = (config: AgentsShellConfig) => ({
  resource: config.resource,
  authorization_servers: [config.issuer],
  scopes_supported: config.supportedScopes,
  bearer_methods_supported: ['header'],
})

const quoteAuthParam = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

export const buildBearerChallenge = (config: AgentsShellConfig, error?: string, errorDescription?: string) => {
  const metadataUrl = `${config.resource.replace(/\/$/, '')}${PROTECTED_RESOURCE_PATH}`
  const parts = [`resource_metadata="${quoteAuthParam(metadataUrl)}"`]
  if (error) parts.push(`error="${error}"`)
  if (errorDescription) parts.push(`error_description="${quoteAuthParam(errorDescription)}"`)
  return `Bearer ${parts.join(', ')}`
}

export const normalizeMcpAcceptHeader = (accept: string | string[] | undefined) => {
  const value = Array.isArray(accept) ? accept.join(', ') : (accept ?? '')
  const normalized = value.toLowerCase()
  if (normalized.includes('application/json') && normalized.includes('text/event-stream')) return value
  return 'application/json, text/event-stream'
}

const withNormalizedMcpAcceptHeader = (request: Request) => {
  const headers = new Headers(request.headers)
  headers.set('accept', normalizeMcpAcceptHeader(headers.get('accept') ?? undefined))
  return new Request(request, { headers })
}

const bearerTokenFromRequest = (request: Request) => {
  const header = request.headers.get('authorization')
  const match = header?.match(/^Bearer\s+(.+)$/i)
  return match?.[1] ?? null
}

class AuthVerifier {
  readonly config: AgentsShellConfig
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>

  constructor(config: AgentsShellConfig) {
    this.config = config
    this.jwks = createRemoteJWKSet(new URL(config.jwksUrl))
  }

  async verify(token: string): Promise<AuthContext> {
    const result = await jwtVerify(token, this.jwks, {
      issuer: this.config.issuer,
      audience: this.config.resource,
    })
    const payload = result.payload
    const subject = payload.sub
    if (!subject) throw new Error('token is missing subject')

    const email = typeof payload.email === 'string' ? payload.email : null
    if (this.config.allowedSubjects.size > 0 && !this.config.allowedSubjects.has(subject)) {
      throw new Error('subject is not allowed')
    }
    if (this.config.allowedEmails.size > 0 && (!email || !this.config.allowedEmails.has(email))) {
      throw new Error('email is not allowed')
    }

    const scopes = new Set(
      String(payload.scope ?? '')
        .split(/\s+/)
        .map((scope) => scope.trim())
        .filter(Boolean),
    )
    return { subject, email, scopes, payload }
  }
}

const scopesSatisfied = (auth: AuthContext, acceptedScopes: string[]) =>
  acceptedScopes.some((scope) => auth.scopes.has(scope))

const requireScopes = (auth: AuthContext, acceptedScopes: string[]) => {
  if (!scopesSatisfied(auth, acceptedScopes)) {
    throw new Error(`missing required OAuth scope; one of ${acceptedScopes.join(', ')} is required`)
  }
}

const formatCommand = (command: string, args: string[]) =>
  [command, ...args.map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg))].join(' ')

const normalizeCliArgs = (toolName: string, rawArgs: string[]) => {
  const args = rawArgs.map((arg) => arg.trim()).filter(Boolean)
  if (args.length === 0) throw new Error(`${toolName} args must not be empty`)
  return args
}

const toProcessResult = (
  command: string,
  cwd: string,
  exitCode: number | null,
  signal: string | null,
  timedOut: boolean,
  stdout: OutputTail,
  stderr: OutputTail,
  maxOutputBytes: number,
  okExitCodes = new Set([0]),
): ProcessResult => {
  const stdoutOutput = outputFromOffset(stdout, null, maxOutputBytes)
  const stderrOutput = outputFromOffset(stderr, null, maxOutputBytes)
  return {
    ok: exitCode != null ? okExitCodes.has(exitCode) : false,
    command,
    cwd,
    exitCode,
    signal,
    timedOut,
    stdout: stdoutOutput.text,
    stderr: stderrOutput.text,
    stdoutBytes: stdout.totalBytes,
    stderrBytes: stderr.totalBytes,
    stdoutTruncated: stdout.truncated || stdoutOutput.truncatedBeforeOffset,
    stderrTruncated: stderr.truncated || stderrOutput.truncatedBeforeOffset,
  }
}

export class AgentsShellRunner {
  readonly config: AgentsShellConfig
  readonly jobs = new Map<string, ShellJob>()

  constructor(config: AgentsShellConfig) {
    this.config = config
    mkdirSync(resolve(config.workspaceRoot), { recursive: true })
  }

  parseCommandInput(args: {
    command: string
    cwd?: string
    timeoutSeconds?: number
    maxOutputBytes?: number
  }): CommandInput {
    return {
      command: args.command,
      cwd: resolveExistingDirectory(this.config.workspaceRoot, args.cwd),
      timeoutSeconds: asPositiveInteger(
        args.timeoutSeconds,
        'timeoutSeconds',
        this.config.defaultTimeoutSeconds,
        this.config.maxTimeoutSeconds,
      ),
      maxOutputBytes: asPositiveInteger(
        args.maxOutputBytes,
        'maxOutputBytes',
        this.config.defaultOutputBytes,
        this.config.maxOutputBytes,
        1024,
      ),
    }
  }

  audit(event: string, auth: AuthContext | null, payload: Record<string, unknown>) {
    if (!this.config.auditLogPath) return
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      subject: auth?.subject ?? null,
      email: auth?.email ?? null,
      ...payload,
    })
    try {
      mkdirSync(dirname(this.config.auditLogPath), { recursive: true })
      appendFileSync(this.config.auditLogPath, `${line}\n`)
    } catch (error) {
      console.warn('[agents-shell] failed to write audit log', error)
    }
  }

  runningJobs() {
    return Array.from(this.jobs.values()).filter((job) => job.status === 'running')
  }

  start(input: CommandInput, auth: AuthContext): ShellJob {
    if (this.runningJobs().length >= this.config.maxConcurrentJobs) {
      throw new Error(`max concurrent jobs reached: ${this.config.maxConcurrentJobs}`)
    }

    const child = spawn('/bin/bash', ['-lc', input.command], {
      cwd: input.cwd,
      env: { ...process.env, TERM: process.env.TERM ?? 'dumb' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const job: ShellJob = {
      id: randomUUID(),
      command: input.command,
      cwd: input.cwd,
      process: child,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running',
      exitCode: null,
      signal: null,
      timedOut: false,
      timeout: null,
      stdout: tail(),
      stderr: tail(),
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
      this.audit('shell_job_finished', auth, {
        jobId: job.id,
        status: job.status,
        exitCode: code,
        signal,
        timedOut: job.timedOut,
      })
    })
    child.on('error', (error) => appendTail(job.stderr, Buffer.from(String(error)), input.maxOutputBytes))
    job.timeout = setTimeout(() => {
      if (job.status !== 'running') return
      job.timedOut = true
      job.status = 'timed_out'
      this.killProcessGroup(job, 'SIGTERM')
    }, input.timeoutSeconds * 1000)

    this.jobs.set(job.id, job)
    this.audit('shell_job_started', auth, {
      jobId: job.id,
      command: input.command,
      cwd: input.cwd,
      timeoutSeconds: input.timeoutSeconds,
    })
    return job
  }

  async run(input: CommandInput, auth: AuthContext) {
    const job = this.start(input, auth)
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

  kill(jobId: string, auth: AuthContext, signal = 'SIGTERM') {
    const job = this.requireJob(jobId)
    if (job.status !== 'running') return job
    const killed = this.killProcessGroup(job, signal)
    if (killed) {
      job.status = 'killed'
      job.signal = signal
      this.audit('shell_job_killed', auth, { jobId: job.id, signal })
    }
    return job
  }

  requireJob(jobId: string) {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error(`unknown jobId: ${jobId}`)
    return job
  }

  async runProcess(options: {
    command: string
    args: string[]
    cwd?: string
    stdin?: string
    timeoutSeconds?: number
    maxOutputBytes?: number
    okExitCodes?: number[]
    auth: AuthContext
    auditEvent: string
  }): Promise<ProcessResult> {
    const cwd = resolveExistingDirectory(this.config.workspaceRoot, options.cwd)
    const timeoutSeconds = asPositiveInteger(
      options.timeoutSeconds,
      'timeoutSeconds',
      this.config.defaultTimeoutSeconds,
      this.config.maxTimeoutSeconds,
    )
    const maxOutputBytes = asPositiveInteger(
      options.maxOutputBytes,
      'maxOutputBytes',
      this.config.defaultOutputBytes,
      this.config.maxOutputBytes,
      1024,
    )
    const commandLine = formatCommand(options.command, options.args)
    const stdout = tail()
    const stderr = tail()
    let timedOut = false

    this.audit(options.auditEvent, options.auth, { command: commandLine, cwd, timeoutSeconds })

    const child = spawn(options.command, options.args, {
      cwd,
      env: { ...process.env, TERM: process.env.TERM ?? 'dumb' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    child.stdout.on('data', (chunk: Buffer) => appendTail(stdout, Buffer.from(chunk), maxOutputBytes))
    child.stderr.on('data', (chunk: Buffer) => appendTail(stderr, Buffer.from(chunk), maxOutputBytes))

    if (options.stdin != null) {
      child.stdin.write(options.stdin)
    }
    child.stdin.end()

    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutSeconds * 1000)

    const result = await new Promise<{ exitCode: number | null; signal: string | null }>((resolvePromise, reject) => {
      child.on('error', reject)
      child.on('close', (exitCode, signal) => resolvePromise({ exitCode, signal }))
    }).finally(() => clearTimeout(timeout))

    return toProcessResult(
      commandLine,
      cwd,
      result.exitCode,
      result.signal,
      timedOut,
      stdout,
      stderr,
      maxOutputBytes,
      new Set(options.okExitCodes ?? [0]),
    )
  }

  shutdown() {
    for (const job of this.runningJobs()) {
      job.status = 'killed'
      this.killProcessGroup(job, 'SIGTERM')
    }
  }
}

const summarizeJob = (
  job: ShellJob,
  maxOutputBytes: number,
  offsets: { stdoutOffset?: number | null; stderrOffset?: number | null } = {},
) => {
  const stdout = outputFromOffset(job.stdout, offsets.stdoutOffset ?? null, maxOutputBytes)
  const stderr = outputFromOffset(job.stderr, offsets.stderrOffset ?? null, maxOutputBytes)
  return {
    ok: job.exitCode === 0 && !job.timedOut,
    command: job.command,
    cwd: job.cwd,
    exitCode: job.exitCode,
    signal: job.signal,
    timedOut: job.timedOut,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutBytes: job.stdout.totalBytes,
    stderrBytes: job.stderr.totalBytes,
    stdoutTruncated: job.stdout.truncated || stdout.truncatedBeforeOffset,
    stderrTruncated: job.stderr.truncated || stderr.truncatedBeforeOffset,
    jobId: job.id,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    stdoutRetentionStartByte: stdout.retentionStartByte,
    stderrRetentionStartByte: stderr.retentionStartByte,
    stdoutNextOffset: stdout.nextOffset,
    stderrNextOffset: stderr.nextOffset,
  }
}

const toolSecurityMeta = (scopes: string[]) => {
  const requestedScopes = Array.from(new Set([...scopes, ...OAUTH_SESSION_SCOPES]))
  const securitySchemes = [
    {
      type: 'oauth2',
      scopes: requestedScopes,
    },
  ]
  return {
    securitySchemes,
    _meta: {
      securitySchemes,
      ui: { visibility: ['model'] },
      'openai/visibility': 'public',
      'openai/toolInvocation/invoking': 'Running tool',
      'openai/toolInvocation/invoked': 'Tool complete',
    },
  }
}

const getToolSecuritySchemes = (tool: RegisteredToolForList): OAuth2SecurityScheme[] | undefined => {
  const schemes = tool._meta?.securitySchemes
  if (!Array.isArray(schemes)) return undefined

  const validSchemes = schemes.filter(
    (scheme): scheme is OAuth2SecurityScheme =>
      typeof scheme === 'object' &&
      scheme !== null &&
      (scheme as { type?: unknown }).type === 'oauth2' &&
      Array.isArray((scheme as { scopes?: unknown }).scopes) &&
      (scheme as { scopes: unknown[] }).scopes.every((scope) => typeof scope === 'string'),
  )

  return validSchemes.length > 0 ? validSchemes : undefined
}

const sanitizeJsonSchemaForChatGpt = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map((item) => sanitizeJsonSchemaForChatGpt(item))
  if (typeof schema !== 'object' || schema === null) return schema

  const source = schema as Record<string, unknown>
  const anyOf = source.anyOf
  if (Array.isArray(anyOf) && anyOf.length === 2) {
    const nullIndex = anyOf.findIndex(
      (item) => typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'null',
    )
    const valueIndex = nullIndex === 0 ? 1 : nullIndex === 1 ? 0 : -1
    const valueSchema = valueIndex >= 0 ? anyOf[valueIndex] : null
    if (
      typeof valueSchema === 'object' &&
      valueSchema !== null &&
      typeof (valueSchema as Record<string, unknown>).type === 'string'
    ) {
      const sanitizedValue = sanitizeJsonSchemaForChatGpt(valueSchema) as Record<string, unknown>
      return {
        ...sanitizedValue,
        type: [sanitizedValue.type, 'null'],
      }
    }
  }

  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (key === '$schema') continue
    if (key === 'maximum' && typeof value === 'number' && value >= Number.MAX_SAFE_INTEGER) continue
    if (key === 'minimum' && typeof value === 'number' && value <= -Number.MAX_SAFE_INTEGER) continue
    sanitized[key] = sanitizeJsonSchemaForChatGpt(value)
  }
  if (sanitized.type === 'object' && sanitized.additionalProperties === undefined) {
    sanitized.additionalProperties = false
  }
  return sanitized
}

const objectJsonSchema = (schema: AnySchema | undefined, pipeStrategy: 'input' | 'output') => {
  const objectSchema = normalizeObjectSchema(schema)
  const jsonSchema = objectSchema
    ? toJsonSchemaCompat(objectSchema, {
        strictUnions: true,
        pipeStrategy,
      })
    : {
        type: 'object',
        properties: {},
      }
  return sanitizeJsonSchemaForChatGpt(jsonSchema)
}

const installOpenAiToolsListHandler = (server: McpServer) => {
  const registeredTools = (server as unknown as { _registeredTools: Record<string, RegisteredToolForList> })
    ._registeredTools

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: Object.entries(registeredTools)
      .filter(([, tool]) => tool.enabled)
      .map(([name, tool]) => {
        const securitySchemes = getToolSecuritySchemes(tool)
        const toolDefinition = {
          name,
          title: tool.title,
          description: tool.description,
          inputSchema: objectJsonSchema(tool.inputSchema, 'input'),
          ...(tool.outputSchema ? { outputSchema: objectJsonSchema(tool.outputSchema, 'output') } : {}),
          annotations: tool.annotations,
          ...(securitySchemes ? { securitySchemes } : {}),
          _meta: tool._meta,
        }
        return toolDefinition
      }),
  }))
}

const withToolErrors =
  <Args>(
    config: AgentsShellConfig,
    auth: AuthContext,
    scopes: string[],
    handler: (args: Args) => Promise<CallToolResult>,
  ) =>
  async (args: Args): Promise<CallToolResult> => {
    try {
      requireScopes(auth, scopes)
      return await handler(args)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return errorResult(
        message,
        buildBearerChallenge(
          config,
          'insufficient_scope',
          'The requested agents-shell tool requires additional OAuth scopes.',
        ),
      )
    }
  }

const extractPatchPaths = (patch: string) => {
  const paths = new Set<string>()
  for (const line of patch.split('\n')) {
    const diffMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/)
    if (diffMatch) {
      paths.add(diffMatch[1])
      paths.add(diffMatch[2])
      continue
    }
    const fileMatch = line.match(/^(?:---|\+\+\+) (?:a\/|b\/)?(.+)$/)
    if (fileMatch && fileMatch[1] !== '/dev/null') {
      paths.add(fileMatch[1].split('\t')[0])
      continue
    }
  }
  return Array.from(paths)
}

const validatePatchPaths = (workspaceRoot: string, cwd: string, patch: string) => {
  const paths = extractPatchPaths(patch)
  if (paths.length === 0) throw new Error('patch does not contain recognizable file paths')
  for (const path of paths) {
    const candidate = resolve(cwd, path)
    if (!isInsidePath(resolve(workspaceRoot), candidate)) {
      throw new Error(`patch path must stay under workspace: ${path}`)
    }
  }
}

export const createAgentsShellServer = (config: AgentsShellConfig, runner: AgentsShellRunner, auth: AuthContext) => {
  const server = new McpServer(
    {
      name: config.name,
      version: config.version,
    },
    {
      instructions:
        'Agents-shell is a private tool-only ChatGPT app for bounded agentic work inside /workspace. Use workspace tools for file search/read/patch operations. Use shell_run for short commands and shell_start/shell_read/shell_kill for long-running scripts. Use git and kubectl for generic argv-based CLI calls when structured arguments help; otherwise use shell_run. Always inspect state before mutating. The shell and CLI tools are bounded by OAuth scopes, audit logging, cwd, timeout, output caps, and the Kubernetes ServiceAccount RBAC.',
      capabilities: {
        tools: {},
      },
    },
  )

  server.registerTool(
    'workspace_search',
    {
      title: 'Search workspace',
      description:
        'Use this when searching text or file contents under /workspace. It runs ripgrep with bounded output and never modifies files.',
      inputSchema: {
        query: z.string().min(1),
        path: z.string().optional(),
        fixedStrings: z.boolean().optional(),
        caseSensitive: z.boolean().optional(),
        maxOutputBytes: z.number().int().min(1024).optional(),
      },
      outputSchema: commandResultSchema,
      annotations: readOnlyAnnotations,
      ...toolSecurityMeta([SCOPES.read]),
    },
    withToolErrors<{
      query: string
      path?: string
      fixedStrings?: boolean
      caseSensitive?: boolean
      maxOutputBytes?: number
    }>(config, auth, READ_SCOPES, async (args) => {
      const cwd = resolveExistingDirectory(config.workspaceRoot, args.path)
      const rgArgs = ['--line-number', '--no-heading', '--color=never', '--hidden', '-g', '!.git']
      if (args.fixedStrings) rgArgs.push('--fixed-strings')
      if (args.caseSensitive === false) rgArgs.push('--ignore-case')
      rgArgs.push(args.query)
      const result = await runner.runProcess({
        command: 'rg',
        args: rgArgs,
        cwd: relative(resolve(config.workspaceRoot), cwd) || '.',
        timeoutSeconds: config.defaultTimeoutSeconds,
        maxOutputBytes: args.maxOutputBytes,
        okExitCodes: [0, 1],
        auth,
        auditEvent: 'workspace_search',
      })
      return jsonTextResult(result)
    }),
  )

  server.registerTool(
    'workspace_read_file',
    {
      title: 'Read workspace file',
      description:
        'Use this when reading a specific file under /workspace. It returns a bounded UTF-8 text prefix and never modifies files.',
      inputSchema: {
        path: z.string().min(1),
        maxBytes: z.number().int().min(1).optional(),
      },
      outputSchema: z.object({
        path: z.string(),
        content: z.string(),
        bytes: z.number().int(),
        truncated: z.boolean(),
      }),
      annotations: readOnlyAnnotations,
      ...toolSecurityMeta([SCOPES.read]),
    },
    withToolErrors<{ path: string; maxBytes?: number }>(config, auth, READ_SCOPES, async (args) => {
      const path = resolveWorkspacePath(config.workspaceRoot, args.path)
      const maxBytes = asPositiveInteger(args.maxBytes, 'maxBytes', config.defaultOutputBytes, config.maxOutputBytes, 1)
      const buffer = readFileSync(path)
      const slice = buffer.subarray(0, maxBytes)
      return jsonTextResult({
        path,
        content: slice.toString('utf8'),
        bytes: buffer.length,
        truncated: buffer.length > maxBytes,
      })
    }),
  )

  server.registerTool(
    'workspace_apply_patch',
    {
      title: 'Apply workspace patch',
      description:
        'Use this when applying a unified diff to files under /workspace. It validates paths, runs git apply --check, then applies the patch.',
      inputSchema: {
        patch: z.string().min(1),
        cwd: z.string().optional(),
        timeoutSeconds: z.number().int().min(1).optional(),
        maxOutputBytes: z.number().int().min(1024).optional(),
      },
      outputSchema: commandResultSchema,
      annotations: writeAnnotations,
      ...toolSecurityMeta([SCOPES.write]),
    },
    withToolErrors<{
      patch: string
      cwd?: string
      timeoutSeconds?: number
      maxOutputBytes?: number
    }>(config, auth, WRITE_SCOPES, async (args) => {
      const cwd = resolveExistingDirectory(config.workspaceRoot, args.cwd)
      validatePatchPaths(config.workspaceRoot, cwd, args.patch)
      const check = await runner.runProcess({
        command: 'git',
        args: ['apply', '--check', '-'],
        cwd: relative(resolve(config.workspaceRoot), cwd) || '.',
        stdin: args.patch,
        timeoutSeconds: args.timeoutSeconds,
        maxOutputBytes: args.maxOutputBytes,
        auth,
        auditEvent: 'workspace_apply_patch_check',
      })
      if (!check.ok) return jsonTextResult(check)
      const result = await runner.runProcess({
        command: 'git',
        args: ['apply', '-'],
        cwd: relative(resolve(config.workspaceRoot), cwd) || '.',
        stdin: args.patch,
        timeoutSeconds: args.timeoutSeconds,
        maxOutputBytes: args.maxOutputBytes,
        auth,
        auditEvent: 'workspace_apply_patch',
      })
      return jsonTextResult(result)
    }),
  )

  server.registerTool(
    'shell_run',
    {
      title: 'Run shell command',
      description:
        'Use this when executing a short shell command or script inside the private agents-shell container. It can modify files, access networks, and affect cluster state through installed CLIs.',
      inputSchema: shellInputSchema,
      outputSchema: shellJobSchema,
      annotations: shellAnnotations,
      ...toolSecurityMeta([SCOPES.write]),
    },
    withToolErrors<{ command: string; cwd?: string; timeoutSeconds?: number; maxOutputBytes?: number }>(
      config,
      auth,
      WRITE_SCOPES,
      async (args) => {
        const input = runner.parseCommandInput(args)
        const job = await runner.run(input, auth)
        return jsonTextResult(summarizeJob(job, input.maxOutputBytes))
      },
    ),
  )

  server.registerTool(
    'shell_start',
    {
      title: 'Start shell job',
      description:
        'Use this when starting a long-running shell command or script inside agents-shell. Poll it later with shell_read and terminate it with shell_kill.',
      inputSchema: shellInputSchema,
      outputSchema: shellJobSchema,
      annotations: shellAnnotations,
      ...toolSecurityMeta([SCOPES.write]),
    },
    withToolErrors<{ command: string; cwd?: string; timeoutSeconds?: number; maxOutputBytes?: number }>(
      config,
      auth,
      WRITE_SCOPES,
      async (args) => {
        const input = runner.parseCommandInput(args)
        const job = runner.start(input, auth)
        return jsonTextResult(summarizeJob(job, input.maxOutputBytes))
      },
    ),
  )

  server.registerTool(
    'shell_read',
    {
      title: 'Read shell job',
      description:
        'Use this when reading status and retained stdout/stderr output for a shell_start job. It never starts a new command.',
      inputSchema: {
        ...jobIdSchema,
        stdoutOffset: z.number().int().min(0).optional(),
        stderrOffset: z.number().int().min(0).optional(),
        maxOutputBytes: z.number().int().min(1024).optional(),
      },
      outputSchema: shellJobSchema,
      annotations: openReadOnlyAnnotations,
      ...toolSecurityMeta([SCOPES.read]),
    },
    withToolErrors<{ jobId: string; stdoutOffset?: number; stderrOffset?: number; maxOutputBytes?: number }>(
      config,
      auth,
      READ_SCOPES,
      async (args) => {
        const maxOutputBytes = asPositiveInteger(
          args.maxOutputBytes,
          'maxOutputBytes',
          config.defaultOutputBytes,
          config.maxOutputBytes,
          1024,
        )
        return jsonTextResult(
          summarizeJob(runner.requireJob(args.jobId), maxOutputBytes, {
            stdoutOffset: args.stdoutOffset ?? null,
            stderrOffset: args.stderrOffset ?? null,
          }),
        )
      },
    ),
  )

  server.registerTool(
    'shell_kill',
    {
      title: 'Kill shell job',
      description: 'Use this when terminating a running shell_start job inside agents-shell.',
      inputSchema: {
        ...jobIdSchema,
        signal: z.string().optional(),
      },
      outputSchema: shellJobSchema,
      annotations: destructiveAnnotations,
      ...toolSecurityMeta([SCOPES.write]),
    },
    withToolErrors<{ jobId: string; signal?: string }>(config, auth, WRITE_SCOPES, async (args) => {
      const job = runner.kill(args.jobId, auth, args.signal ?? 'SIGTERM')
      return jsonTextResult(summarizeJob(job, config.defaultOutputBytes))
    }),
  )

  server.registerTool(
    'shell_status',
    {
      title: 'List shell jobs',
      description: 'Use this when inspecting recent shell job status in agents-shell. It never starts a command.',
      inputSchema: {
        jobId: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      outputSchema: z.object({ jobs: z.array(shellJobSchema) }),
      annotations: openReadOnlyAnnotations,
      ...toolSecurityMeta([SCOPES.read]),
    },
    withToolErrors<{ jobId?: string; limit?: number }>(config, auth, READ_SCOPES, async (args) => {
      const jobs = args.jobId
        ? [runner.requireJob(args.jobId)]
        : Array.from(runner.jobs.values())
            .slice(-asPositiveInteger(args.limit, 'limit', 20, 100, 1))
            .reverse()
      return jsonTextResult({ jobs: jobs.map((job) => summarizeJob(job, config.defaultOutputBytes)) })
    }),
  )

  server.registerTool(
    'git',
    {
      title: 'Run git',
      description:
        'Use this when running git inside /workspace. Pass args exactly as argv after git, for example ["status","--short","--branch"] or ["diff","--","path"]. It is generic and may modify repository state depending on args.',
      inputSchema: {
        args: z.array(z.string().min(1)).min(1).describe('Arguments passed to git, excluding the git executable.'),
        cwd: z.string().optional(),
        timeoutSeconds: z.number().int().min(1).optional(),
        maxOutputBytes: z.number().int().min(1024).optional(),
      },
      outputSchema: commandResultSchema,
      annotations: shellAnnotations,
      ...toolSecurityMeta([SCOPES.write]),
    },
    withToolErrors<{ args: string[]; cwd?: string; timeoutSeconds?: number; maxOutputBytes?: number }>(
      config,
      auth,
      WRITE_SCOPES,
      async (args) =>
        jsonTextResult(
          await runner.runProcess({
            command: 'git',
            args: normalizeCliArgs('git', args.args),
            cwd: args.cwd,
            timeoutSeconds: args.timeoutSeconds,
            maxOutputBytes: args.maxOutputBytes,
            auth,
            auditEvent: 'git',
          }),
        ),
    ),
  )

  server.registerTool(
    'kubectl',
    {
      title: 'Run kubectl',
      description:
        'Use this when running kubectl inside the agents-shell container. Pass args exactly as argv after kubectl, for example ["get","pods","-n","agents"] or ["rollout","status","deployment/agents-shell","-n","agents"]. This is a generic kubectl wrapper; authorization is controlled by OAuth scopes and the Kubernetes ServiceAccount RBAC.',
      inputSchema: {
        args: z
          .array(z.string().min(1))
          .min(1)
          .describe('Arguments passed to kubectl, excluding the kubectl executable.'),
        cwd: z.string().optional(),
        timeoutSeconds: z.number().int().min(1).optional(),
        maxOutputBytes: z.number().int().min(1024).optional(),
      },
      outputSchema: commandResultSchema,
      annotations: shellAnnotations,
      ...toolSecurityMeta([SCOPES.write]),
    },
    withToolErrors<{ args: string[]; cwd?: string; timeoutSeconds?: number; maxOutputBytes?: number }>(
      config,
      auth,
      WRITE_SCOPES,
      async (args) => {
        const kubectlArgs = normalizeCliArgs('kubectl', args.args)
        return jsonTextResult(
          await runner.runProcess({
            command: 'kubectl',
            args: kubectlArgs,
            cwd: args.cwd,
            timeoutSeconds: args.timeoutSeconds,
            maxOutputBytes: args.maxOutputBytes,
            okExitCodes: kubectlArgs[0] === 'diff' ? [0, 1] : [0],
            auth,
            auditEvent: 'kubectl',
          }),
        )
      },
    ),
  )

  installOpenAiToolsListHandler(server)

  return server
}

const anonymousAuthContext = (): AuthContext => ({
  subject: 'unauthenticated',
  email: null,
  scopes: new Set(),
  payload: {},
})

const jsonResponse = (payload: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init.headers,
    },
  })

const logAgentsShellRequest = (request: Request, status: number, startedAt: number) => {
  const { pathname } = new URL(request.url)
  if (pathname !== '/mcp' && pathname !== PROTECTED_RESOURCE_PATH) return

  console.log(
    JSON.stringify({
      msg: 'agents-shell http request',
      method: request.method,
      path: pathname,
      status,
      durationMs: Date.now() - startedAt,
      userAgent: request.headers.get('user-agent'),
    }),
  )
}

export const createAgentsShellRequestHandler = (config: AgentsShellConfig, runner = new AgentsShellRunner(config)) => {
  const verifier = new AuthVerifier(config)

  const handleMcp = async (request: Request): Promise<Response> => {
    const token = bearerTokenFromRequest(request)
    let auth = anonymousAuthContext()
    if (token) {
      try {
        auth = await verifier.verify(token)
      } catch (error) {
        return jsonResponse(
          { error: 'invalid_token', detail: error instanceof Error ? error.message : String(error) },
          {
            status: 401,
            headers: {
              'WWW-Authenticate': buildBearerChallenge(
                config,
                'invalid_token',
                'The access token is invalid or expired.',
              ),
            },
          },
        )
      }
    }

    const server = createAgentsShellServer(config, runner, auth)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })

    try {
      await server.connect(transport)
      const response = await transport.handleRequest(withNormalizedMcpAcceptHeader(request))
      await transport.close()
      await server.close()
      return response
    } catch (error) {
      await transport.close().catch(() => undefined)
      await server.close().catch(() => undefined)
      return jsonResponse(
        { error: 'mcp_request_failed', detail: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      )
    }
  }

  return async (request: Request): Promise<Response> => {
    const startedAt = Date.now()
    const { pathname } = new URL(request.url)
    let response: Response

    if (pathname === '/healthz' && request.method === 'GET') {
      response = jsonResponse({ ok: true })
    } else if (pathname === '/readyz' && request.method === 'GET') {
      response = jsonResponse({
        ok: true,
        resource: config.resource,
        issuer: config.issuer,
        workspaceRoot: resolve(config.workspaceRoot),
        runningJobs: runner.runningJobs().length,
      })
    } else if (pathname === PROTECTED_RESOURCE_PATH && request.method === 'GET') {
      response = jsonResponse(oauthProtectedResourceMetadata(config))
    } else if (pathname === '/mcp' && ['DELETE', 'GET', 'POST'].includes(request.method)) {
      response = await handleMcp(request)
    } else if (pathname === '/mcp') {
      response = new Response('Method Not Allowed', { status: 405 })
    } else {
      response = new Response('Not Found', { status: 404 })
    }

    logAgentsShellRequest(request, response.status, startedAt)
    return response
  }
}

export const startAgentsShellServer = (config = defaultAgentsShellConfigFromEnv()) => {
  const runner = new AgentsShellRunner(config)
  const handleRequest = createAgentsShellRequestHandler(config, runner)

  process.once('SIGTERM', () => runner.shutdown())
  process.once('SIGINT', () => runner.shutdown())

  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    fetch: handleRequest,
  })

  console.log(
    JSON.stringify({
      msg: 'agents-shell MCP listening',
      host: server.hostname,
      port: server.port,
      resource: config.resource,
      issuer: config.issuer,
    }),
  )

  return server
}

if (import.meta.main) {
  startAgentsShellServer()
}
