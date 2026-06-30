import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose'
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

type AgentStartInput = {
  task: string
  headBranch?: string
  baseBranch?: string
  repository?: string
  agentName?: string
  tokenBudget?: number
  ttlSecondsAfterFinished?: number
  acceptanceCriteria?: string[]
  timeoutSeconds?: number
  maxOutputBytes?: number
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
  username: string | null
  scopes: Set<string>
  payload: JWTPayload
  authError?: OAuthChallenge
}

type OAuthChallenge = {
  error: string
  description: string
}

export type AgentsShellConfig = {
  name: string
  version: string
  resource: string
  issuer: string
  jwksUrl: string
  supportedScopes: string[]
  allowedEmails: Set<string>
  allowedUsernames: Set<string>
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
  agentNamespace: string
  agentName: string
  agentRepository: string
  agentBaseBranch: string
  agentVcsRef: string
  agentRuntimeServiceAccount: string
  agentSecrets: string[]
  agentDefaultTokenBudget: number
  agentDefaultTtlSecondsAfterFinished: number
  port: number
  host: string
}

const AGENTS_SHELL_VERSION = '0.1.0'
const DEFAULT_RESOURCE = 'https://agents-shell.proompteng.ai'
const DEFAULT_ISSUER = 'https://auth.proompteng.ai/realms/master'
const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource'
const DEFAULT_AGENT_NAMESPACE = 'agents'
const DEFAULT_AGENT_NAME = 'codex-agent'
const DEFAULT_AGENT_REPOSITORY = 'proompteng/lab'
const DEFAULT_AGENT_BASE_BRANCH = 'main'
const DEFAULT_AGENT_VCS_REF = 'github'
const DEFAULT_AGENT_RUNTIME_SERVICE_ACCOUNT = 'agents-sa'
const DEFAULT_AGENT_SECRETS = ['github-token', 'codex-auth']
const DEFAULT_AGENT_TOKEN_BUDGET = 250_000
const DEFAULT_AGENT_TTL_SECONDS_AFTER_FINISHED = 86_400
const DEFAULT_WORKSPACE_SEARCH_EXCLUDES = [
  '.git',
  'node_modules',
  '.next',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'coverage',
  'target',
  'vendor',
  '.venv',
  'venv',
  'schemas/custom',
]

const AGENT_GUIDE = `Use agents-shell as a production coding agent for /workspace/lab.

Operate like Codex:
- Apply these instructions to the current ChatGPT model in this chat; do not rely on stale model-specific prompt text.
- Persist until the request is complete or an evidence-backed blocker remains.
- Inspect before editing: read repo state, relevant files, tests, and applicable AGENTS.md instructions.
- Respect dirty worktrees: do not revert, overwrite, or discard changes you did not make.
- Use search for repo/file discovery, read_file for bounded file reads, and apply_patch with Codex patch syntax for edits.
- Use destructive git, Kubernetes, or filesystem operations only when the user request clearly requires them.
- Validate from focused tests to broader checks, then summarize exact commands and results.

Default direct ChatGPT repo workflow:
1. Treat /workspace/lab as the read-only seed checkout for direct ChatGPT sessions.
2. Start from fresh origin/main in a unique worktree:
   git -C /workspace/lab fetch origin main
   mkdir -p /workspace/worktrees/lab
   git -C /workspace/lab worktree add -B codex/<task-slug> /workspace/worktrees/lab/<branch-slug> origin/main
3. Use cwd: "worktrees/lab/<branch-slug>" for search, read_file, apply_patch, shell, git, tests, and any repo-local kubectl or gh command.
4. Never share a worktree or branch between concurrent ChatGPT sessions.
5. Do not edit /workspace/lab directly for multi-session work; only use it to fetch and create isolated worktrees.
6. Search with search, inspect with read_file and git, and make scoped edits with apply_patch.
7. Run focused tests, lint, type checks, or smoke commands that prove the change.
8. Commit as Greg Konush, push the branch, create a pull request with gh, and monitor CI.
9. Fix failures and continue until the task is complete, CI status is checked, and the PR URL is available.

Use shell_run for short commands, shell_start/read/status/kill for long commands, git and git_write for repository operations, and kubectl and kubectl_admin for cluster operations. Do not use agent_start/status/read/cancel for direct multi-session ChatGPT work unless the user explicitly requests delegated AgentRun work. Report blockers only with exact tool calls, arguments, timestamps, server logs, audit entries, live environment state, and the layer that failed.`

const SERVER_INSTRUCTIONS =
  'Private Codex-style repo agent for /workspace/lab. Inspect first, respect dirty work, edit with apply_patch, validate, commit as Greg Konush, push, create PRs with gh, monitor CI, and report evidence-backed blockers only.'

const SCOPES = {
  read: 'agents-shell.read',
  write: 'agents-shell.write',
  admin: 'agents-shell.admin',
  offlineAccess: 'offline_access',
} as const

const READ_SCOPES = [SCOPES.read, SCOPES.write, SCOPES.admin]
const CONNECTOR_LINK_SCOPES = [SCOPES.offlineAccess]
// ChatGPT connector sessions are private and identity-allowlisted. Keep tool authorization on the stable
// linked scope so long-running workflows do not re-enter OAuth when they move from read tools to write tools.
const WRITE_SCOPES = READ_SCOPES

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
  destructiveHint: false,
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
  command: z
    .string()
    .min(1)
    .describe(
      'User-requested terminal command line executed inside the private agents-shell workspace container. The tool returns output only and does not publish messages or data.',
    ),
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

const parseArray = (value: string | undefined, fallback: string[]) => {
  const parsed = Array.from(parseList(value))
  return parsed.length > 0 ? parsed : fallback
}

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
    allowedUsernames: parseList(env.AGENTS_SHELL_ALLOWED_USERNAMES),
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
    agentNamespace: env.AGENTS_SHELL_AGENT_NAMESPACE ?? DEFAULT_AGENT_NAMESPACE,
    agentName: env.AGENTS_SHELL_AGENT_NAME ?? DEFAULT_AGENT_NAME,
    agentRepository: env.AGENTS_SHELL_AGENT_REPOSITORY ?? DEFAULT_AGENT_REPOSITORY,
    agentBaseBranch: env.AGENTS_SHELL_AGENT_BASE_BRANCH ?? DEFAULT_AGENT_BASE_BRANCH,
    agentVcsRef: env.AGENTS_SHELL_AGENT_VCS_REF ?? DEFAULT_AGENT_VCS_REF,
    agentRuntimeServiceAccount: env.AGENTS_SHELL_AGENT_RUNTIME_SERVICE_ACCOUNT ?? DEFAULT_AGENT_RUNTIME_SERVICE_ACCOUNT,
    agentSecrets: parseArray(env.AGENTS_SHELL_AGENT_SECRETS, DEFAULT_AGENT_SECRETS),
    agentDefaultTokenBudget: Number(env.AGENTS_SHELL_AGENT_DEFAULT_TOKEN_BUDGET ?? DEFAULT_AGENT_TOKEN_BUDGET),
    agentDefaultTtlSecondsAfterFinished: Number(
      env.AGENTS_SHELL_AGENT_DEFAULT_TTL_SECONDS_AFTER_FINISHED ?? DEFAULT_AGENT_TTL_SECONDS_AFTER_FINISHED,
    ),
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

export const oauthIdentityAllowed = (
  config: AgentsShellConfig,
  identity: { subject: string; email: string | null; username: string | null },
) => {
  if (config.allowedSubjects.size > 0 && !config.allowedSubjects.has(identity.subject)) return false
  if (config.allowedEmails.size === 0 && config.allowedUsernames.size === 0) return true
  return (
    (identity.email ? config.allowedEmails.has(identity.email) : false) ||
    (identity.username ? config.allowedUsernames.has(identity.username) : false)
  )
}

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

const hashJwtSubject = (subject: unknown) =>
  typeof subject === 'string' ? createHash('sha256').update(subject).digest('hex').slice(0, 12) : null

const normalizeJwtAudience = (audience: unknown) => {
  if (Array.isArray(audience)) return audience.filter((value): value is string => typeof value === 'string')
  return typeof audience === 'string' ? audience : null
}

const decodeSafeJwtDiagnostics = (token: string) => {
  try {
    const header = decodeProtectedHeader(token)
    const payload = decodeJwt(token)
    const nowSeconds = Math.floor(Date.now() / 1000)
    return {
      header: {
        alg: header.alg,
        typ: typeof header.typ === 'string' ? header.typ : undefined,
      },
      claims: {
        iss: payload.iss,
        aud: normalizeJwtAudience(payload.aud),
        azp: typeof payload.azp === 'string' ? payload.azp : undefined,
        scope: typeof payload.scope === 'string' ? payload.scope : undefined,
        subHash: hashJwtSubject(payload.sub),
        exp: payload.exp,
        iat: payload.iat,
        nbf: payload.nbf,
        expiresInSeconds: typeof payload.exp === 'number' ? payload.exp - nowSeconds : undefined,
        tokenAgeSeconds: typeof payload.iat === 'number' ? nowSeconds - payload.iat : undefined,
      },
    }
  } catch (error) {
    return {
      decodeError: error instanceof Error ? error.message : String(error),
    }
  }
}

const logOAuthFailure = (request: Request, requestId: string, token: string, error: unknown) => {
  const { pathname } = new URL(request.url)
  const typedError = error as { code?: unknown }
  console.warn(
    JSON.stringify({
      msg: 'agents-shell oauth token rejected',
      requestId,
      method: request.method,
      path: pathname,
      errorName: error instanceof Error ? error.name : undefined,
      errorMessage: error instanceof Error ? error.message : String(error),
      joseCode: typeof typedError.code === 'string' ? typedError.code : undefined,
      token: decodeSafeJwtDiagnostics(token),
      userAgent: request.headers.get('user-agent'),
    }),
  )
}

class AuthChallengeError extends Error {
  readonly oauthError: string
  readonly oauthDescription: string

  constructor(challenge: OAuthChallenge) {
    super(challenge.description)
    this.name = 'AuthChallengeError'
    this.oauthError = challenge.error
    this.oauthDescription = challenge.description
  }
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
    const username = typeof payload.preferred_username === 'string' ? payload.preferred_username : null
    if (!oauthIdentityAllowed(this.config, { subject, email, username })) throw new Error('identity is not allowed')

    const scopes = new Set(
      String(payload.scope ?? '')
        .split(/\s+/)
        .map((scope) => scope.trim())
        .filter(Boolean),
    )
    return { subject, email, username, scopes, payload }
  }
}

const scopesSatisfied = (auth: AuthContext, acceptedScopes: string[]) =>
  acceptedScopes.some((scope) => auth.scopes.has(scope))

const requireScopes = (auth: AuthContext, acceptedScopes: string[]) => {
  if (auth.authError) {
    throw new AuthChallengeError(auth.authError)
  }
  if (!scopesSatisfied(auth, acceptedScopes)) {
    throw new AuthChallengeError({
      error: 'insufficient_scope',
      description: 'The requested agents-shell tool requires additional OAuth scopes.',
    })
  }
}

const formatCommand = (command: string, args: string[]) =>
  [command, ...args.map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg))].join(' ')

const normalizeCliArgs = (toolName: string, rawArgs: string[]) => {
  const args = rawArgs.map((arg) => arg.trim()).filter(Boolean)
  if (args.length === 0) throw new Error(`${toolName} args must not be empty`)
  return args
}

const READ_ONLY_GIT_COMMANDS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'grep', 'describe'])
const READ_ONLY_KUBECTL_COMMANDS = new Set([
  'api-resources',
  'api-versions',
  'auth',
  'cluster-info',
  'describe',
  'events',
  'explain',
  'get',
  'logs',
  'top',
  'version',
])
const READ_ONLY_KUBECTL_AUTH_COMMANDS = new Set(['can-i', 'whoami'])
const READ_ONLY_KUBECTL_ROLLOUT_COMMANDS = new Set(['history', 'status'])

const requireReadOnlyGitArgs = (args: string[]) => {
  const command = args[0]
  if (READ_ONLY_GIT_COMMANDS.has(command)) return
  throw new Error(`git supports read-only repository inspection only; use git_write for git ${command}`)
}

const requireReadOnlyKubectlArgs = (args: string[]) => {
  const command = args[0]
  if (READ_ONLY_KUBECTL_COMMANDS.has(command)) {
    if (command === 'auth' && !READ_ONLY_KUBECTL_AUTH_COMMANDS.has(args[1] ?? '')) {
      throw new Error(
        'kubectl auth supports read-only subcommands only; use kubectl_admin for other kubectl auth calls',
      )
    }
    return
  }
  if (command === 'rollout' && READ_ONLY_KUBECTL_ROLLOUT_COMMANDS.has(args[1] ?? '')) return
  throw new Error(`kubectl supports read-only cluster inspection only; use kubectl_admin for kubectl ${command}`)
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
      username: auth?.username ?? null,
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
      let settled = false
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return
        settled = true
        child.stdout.destroy()
        child.stderr.destroy()
        resolvePromise({ exitCode, signal })
      }

      child.once('error', reject)
      child.once('exit', (exitCode, signal) => setImmediate(() => finish(exitCode, signal)))
      child.once('close', (exitCode, signal) => finish(exitCode, signal))
    }).finally(() => clearTimeout(timeout))

    const processResult = toProcessResult(
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
    this.audit(`${options.auditEvent}_finished`, options.auth, {
      command: commandLine,
      cwd,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut,
    })
    return processResult
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
  const requestedScopes = Array.from(new Set([...scopes, ...CONNECTOR_LINK_SCOPES]))
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
          // Keep connector discovery compact; tool calls still return structured content.
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
      if (error instanceof AuthChallengeError) {
        return errorResult(message, buildBearerChallenge(config, error.oauthError, error.oauthDescription))
      }
      return errorResult(message)
    }
  }

const extractCodexPatchPaths = (patch: string) => {
  const paths = new Set<string>()
  for (const line of patch.split('\n')) {
    const fileMatch = line.match(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/)
    if (fileMatch) paths.add(fileMatch[1].trim())
  }
  return Array.from(paths)
}

const validateCodexPatch = (workspaceRoot: string, cwd: string, patch: string) => {
  if (!patch.trimStart().startsWith('*** Begin Patch')) {
    throw new Error("patch must start with '*** Begin Patch'")
  }
  if (!patch.trimEnd().endsWith('*** End Patch')) {
    throw new Error("patch must end with '*** End Patch'")
  }
  const paths = extractCodexPatchPaths(patch)
  if (paths.length === 0) throw new Error('patch does not contain recognizable Codex patch file paths')
  for (const path of paths) {
    const candidate = resolve(cwd, path)
    if (!isInsidePath(resolve(workspaceRoot), candidate)) {
      throw new Error(`patch path must stay under workspace: ${path}`)
    }
  }
  return paths
}

const slugifyKubernetesName = (value: string) => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'task'
}

const boundedKubernetesName = (parts: string[]) => {
  const suffix = randomUUID().slice(0, 8)
  const prefix = parts.map(slugifyKubernetesName).filter(Boolean).join('-')
  const maxPrefixLength = 63 - suffix.length - 1
  return `${prefix.slice(0, maxPrefixLength).replace(/-+$/g, '')}-${suffix}`
}

const agentRunNameFromInput = (task: string) => boundedKubernetesName(['agents-shell', task])

const buildAgentRunManifest = (config: AgentsShellConfig, args: AgentStartInput) => {
  const agentRunName = agentRunNameFromInput(args.task)
  const baseBranch = args.baseBranch ?? config.agentBaseBranch
  const headBranch = args.headBranch ?? `codex/${agentRunName}`
  const repository = args.repository ?? config.agentRepository
  const agentName = args.agentName ?? config.agentName
  const tokenBudget = asPositiveInteger(args.tokenBudget, 'tokenBudget', config.agentDefaultTokenBudget, 1_000_000, 1)
  const ttlSecondsAfterFinished = asPositiveInteger(
    args.ttlSecondsAfterFinished,
    'ttlSecondsAfterFinished',
    config.agentDefaultTtlSecondsAfterFinished,
    604_800,
    0,
  )

  return {
    apiVersion: 'agents.proompteng.ai/v1alpha1',
    kind: 'AgentRun',
    metadata: {
      name: agentRunName,
      namespace: config.agentNamespace,
      labels: {
        'app.kubernetes.io/name': 'agents-shell',
        'app.kubernetes.io/component': 'delegated-agent',
      },
    },
    spec: {
      agentRef: { name: agentName },
      implementation: {
        inline: {
          summary: `agents-shell delegated work: ${args.task.slice(0, 200)}`,
          text: args.task,
          acceptanceCriteria: args.acceptanceCriteria,
          source: {
            provider: 'custom',
            externalId: `${repository}:${headBranch}`,
            url: config.resource,
          },
          vcsRef: { name: config.agentVcsRef },
        },
      },
      goal: {
        objective: args.task,
        tokenBudget,
      },
      ttlSecondsAfterFinished,
      parameters: {
        repository,
        base: baseBranch,
        head: headBranch,
        stage: 'implementation',
      },
      runtime: {
        type: 'job',
        config: {
          serviceAccountName: config.agentRuntimeServiceAccount,
        },
      },
      secrets: config.agentSecrets,
      vcsRef: { name: config.agentVcsRef },
      vcsPolicy: {
        required: true,
        mode: 'read-write',
      },
    },
  }
}

const parseJsonOrNull = (value: string) => {
  try {
    return value.trim() ? (JSON.parse(value) as unknown) : null
  } catch {
    return null
  }
}

export const createAgentsShellServer = (config: AgentsShellConfig, runner: AgentsShellRunner, auth: AuthContext) => {
  const server = new McpServer(
    {
      name: config.name,
      version: config.version,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
      capabilities: {
        tools: {},
      },
    },
  )

  server.registerTool(
    'search',
    {
      title: 'Search files',
      description:
        'Search text under /workspace with rg. Output is bounded and dependency/cache/generated dirs are skipped.',
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
      const rgArgs = ['--line-number', '--no-heading', '--color=never', '--hidden']
      for (const exclude of DEFAULT_WORKSPACE_SEARCH_EXCLUDES) {
        rgArgs.push('-g', `!${exclude}/**`)
      }
      if (args.fixedStrings) rgArgs.push('--fixed-strings')
      if (args.caseSensitive === false) rgArgs.push('--ignore-case')
      rgArgs.push(args.query)
      rgArgs.push('.')
      const result = await runner.runProcess({
        command: 'rg',
        args: rgArgs,
        cwd: relative(resolve(config.workspaceRoot), cwd) || '.',
        timeoutSeconds: config.defaultTimeoutSeconds,
        maxOutputBytes: args.maxOutputBytes,
        okExitCodes: [0, 1],
        auth,
        auditEvent: 'search',
      })
      return jsonTextResult(result)
    }),
  )

  server.registerTool(
    'read_file',
    {
      title: 'Read file',
      description: 'Read a bounded UTF-8 prefix from a file under /workspace.',
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
    'apply_patch',
    {
      title: 'Apply Codex patch',
      description:
        'Edit files under /workspace with Codex patch syntax. Pass the full *** Begin Patch / *** End Patch document.',
      inputSchema: {
        patch: z.string().min(1),
        cwd: z.string().optional().describe('Working directory under /workspace. Defaults to /workspace/lab.'),
        timeoutSeconds: z.number().int().min(1).optional(),
        maxOutputBytes: z.number().int().min(1024).optional(),
      },
      outputSchema: commandResultSchema.extend({
        changedFiles: z.array(z.string()),
      }),
      annotations: writeAnnotations,
      ...toolSecurityMeta([SCOPES.read]),
    },
    withToolErrors<{
      patch: string
      cwd?: string
      timeoutSeconds?: number
      maxOutputBytes?: number
    }>(config, auth, WRITE_SCOPES, async (args) => {
      const cwd = resolveExistingDirectory(config.workspaceRoot, args.cwd ?? 'lab')
      const changedFiles = validateCodexPatch(config.workspaceRoot, cwd, args.patch)
      const result = await runner.runProcess({
        command: 'apply_patch',
        args: [],
        cwd: relative(resolve(config.workspaceRoot), cwd) || '.',
        stdin: args.patch,
        timeoutSeconds: args.timeoutSeconds,
        maxOutputBytes: args.maxOutputBytes,
        auth,
        auditEvent: 'apply_patch',
      })
      return jsonTextResult({ ...result, changedFiles })
    }),
  )

  server.registerTool(
    'agent_guide',
    {
      title: 'Read agent guide',
      description: 'Read the repo-agent workflow guide for direct tools and delegated AgentRuns.',
      inputSchema: {},
      outputSchema: z.object({ guide: z.string() }),
      annotations: readOnlyAnnotations,
      ...toolSecurityMeta([SCOPES.read]),
    },
    withToolErrors<Record<string, never>>(config, auth, READ_SCOPES, async () =>
      jsonTextResult({ guide: AGENT_GUIDE }),
    ),
  )

  server.registerTool(
    'shell_run',
    {
      title: 'Run shell command',
      description:
        'Run a short shell command in the agents-shell container. Returns stdout, stderr, exit code, and job metadata.',
      inputSchema: shellInputSchema,
      outputSchema: shellJobSchema,
      annotations: shellAnnotations,
      ...toolSecurityMeta([SCOPES.read]),
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
      description: 'Start a long-running shell command. Poll with shell_read/status and stop with shell_kill.',
      inputSchema: shellInputSchema,
      outputSchema: shellJobSchema,
      annotations: shellAnnotations,
      ...toolSecurityMeta([SCOPES.read]),
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
      description: 'Read status and retained stdout/stderr for a shell_start job.',
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
      description: 'Terminate a running shell_start job.',
      inputSchema: {
        ...jobIdSchema,
        signal: z.string().optional(),
      },
      outputSchema: shellJobSchema,
      annotations: destructiveAnnotations,
      ...toolSecurityMeta([SCOPES.read]),
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
      description: 'List recent shell jobs or inspect one job by id.',
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
      title: 'Inspect git repository',
      description: 'Run read-only git commands under /workspace. Pass argv after git.',
      inputSchema: {
        args: z.array(z.string().min(1)).min(1).describe('Arguments passed to git, excluding the git executable.'),
        cwd: z.string().optional(),
        timeoutSeconds: z.number().int().min(1).optional(),
        maxOutputBytes: z.number().int().min(1024).optional(),
      },
      outputSchema: commandResultSchema,
      annotations: readOnlyAnnotations,
      ...toolSecurityMeta([SCOPES.read]),
    },
    withToolErrors<{ args: string[]; cwd?: string; timeoutSeconds?: number; maxOutputBytes?: number }>(
      config,
      auth,
      READ_SCOPES,
      async (args) => {
        const gitArgs = normalizeCliArgs('git', args.args)
        requireReadOnlyGitArgs(gitArgs)
        return jsonTextResult(
          await runner.runProcess({
            command: 'git',
            args: gitArgs,
            cwd: args.cwd,
            timeoutSeconds: args.timeoutSeconds,
            maxOutputBytes: args.maxOutputBytes,
            auth,
            auditEvent: 'git',
          }),
        )
      },
    ),
  )

  server.registerTool(
    'git_write',
    {
      title: 'Run mutating git',
      description: 'Run repository-changing git commands under /workspace. Pass argv after git.',
      inputSchema: {
        args: z.array(z.string().min(1)).min(1).describe('Arguments passed to git, excluding the git executable.'),
        cwd: z.string().optional(),
        timeoutSeconds: z.number().int().min(1).optional(),
        maxOutputBytes: z.number().int().min(1024).optional(),
      },
      outputSchema: commandResultSchema,
      annotations: destructiveAnnotations,
      ...toolSecurityMeta([SCOPES.read]),
    },
    withToolErrors<{ args: string[]; cwd?: string; timeoutSeconds?: number; maxOutputBytes?: number }>(
      config,
      auth,
      WRITE_SCOPES,
      async (args) => {
        const gitArgs = normalizeCliArgs('git_write', args.args)
        return jsonTextResult(
          await runner.runProcess({
            command: 'git',
            args: gitArgs,
            cwd: args.cwd,
            timeoutSeconds: args.timeoutSeconds,
            maxOutputBytes: args.maxOutputBytes,
            auth,
            auditEvent: 'git_write',
          }),
        )
      },
    ),
  )

  server.registerTool(
    'kubectl',
    {
      title: 'Inspect Kubernetes with kubectl',
      description: 'Run read-only kubectl inspection. Pass argv after kubectl.',
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
      annotations: openReadOnlyAnnotations,
      ...toolSecurityMeta([SCOPES.read]),
    },
    withToolErrors<{ args: string[]; cwd?: string; timeoutSeconds?: number; maxOutputBytes?: number }>(
      config,
      auth,
      READ_SCOPES,
      async (args) => {
        const kubectlArgs = normalizeCliArgs('kubectl', args.args)
        requireReadOnlyKubectlArgs(kubectlArgs)
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

  server.registerTool(
    'kubectl_admin',
    {
      title: 'Run admin kubectl',
      description: 'Run admin kubectl operations allowed by the agents-shell ServiceAccount. Pass argv after kubectl.',
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
      annotations: destructiveAnnotations,
      ...toolSecurityMeta([SCOPES.read]),
    },
    withToolErrors<{ args: string[]; cwd?: string; timeoutSeconds?: number; maxOutputBytes?: number }>(
      config,
      auth,
      WRITE_SCOPES,
      async (args) => {
        const kubectlArgs = normalizeCliArgs('kubectl_admin', args.args)
        return jsonTextResult(
          await runner.runProcess({
            command: 'kubectl',
            args: kubectlArgs,
            cwd: args.cwd,
            timeoutSeconds: args.timeoutSeconds,
            maxOutputBytes: args.maxOutputBytes,
            okExitCodes: kubectlArgs[0] === 'diff' ? [0, 1] : [0],
            auth,
            auditEvent: 'kubectl_admin',
          }),
        )
      },
    ),
  )

  server.registerTool(
    'agent_start',
    {
      title: 'Start delegated agent',
      description: 'Create a read-write Codex AgentRun for proompteng/lab.',
      inputSchema: {
        task: z.string().min(1).describe('Complete task prompt for the delegated coding agent.'),
        headBranch: z.string().min(1).optional().describe('Optional branch name. Defaults to codex/<generated-name>.'),
        baseBranch: z.string().min(1).optional().describe('Base branch. Defaults to main.'),
        repository: z.string().min(1).optional().describe('Repository in owner/name form. Defaults to proompteng/lab.'),
        agentName: z.string().min(1).optional().describe('Agent resource name. Defaults to codex-agent.'),
        tokenBudget: z.number().int().min(1).optional(),
        ttlSecondsAfterFinished: z.number().int().min(0).optional(),
        acceptanceCriteria: z.array(z.string().min(1)).max(50).optional(),
        timeoutSeconds: z.number().int().min(1).optional(),
        maxOutputBytes: z.number().int().min(1024).optional(),
      },
      outputSchema: z.object({
        ok: z.boolean(),
        agentRunName: z.string(),
        namespace: z.string(),
        repository: z.string(),
        baseBranch: z.string(),
        headBranch: z.string(),
        apply: commandResultSchema,
      }),
      annotations: destructiveAnnotations,
      ...toolSecurityMeta([SCOPES.read]),
    },
    withToolErrors<AgentStartInput>(config, auth, WRITE_SCOPES, async (args) => {
      const manifest = buildAgentRunManifest(config, args)
      const spec = manifest.spec as {
        parameters: { repository: string; base: string; head: string }
      }
      const result = await runner.runProcess({
        command: 'kubectl',
        args: ['apply', '-n', config.agentNamespace, '-f', '-'],
        stdin: JSON.stringify(manifest, null, 2),
        timeoutSeconds: args.timeoutSeconds,
        maxOutputBytes: args.maxOutputBytes,
        auth,
        auditEvent: 'agent_start',
      })
      return jsonTextResult({
        ok: result.ok,
        agentRunName: manifest.metadata.name,
        namespace: config.agentNamespace,
        repository: spec.parameters.repository,
        baseBranch: spec.parameters.base,
        headBranch: spec.parameters.head,
        apply: result,
      })
    }),
  )

  server.registerTool(
    'agent_status',
    {
      title: 'Read delegated agent status',
      description: 'Read a delegated AgentRun object and matching Jobs.',
      inputSchema: {
        agentRunName: z.string().min(1),
        namespace: z.string().min(1).optional(),
        timeoutSeconds: z.number().int().min(1).optional(),
        maxOutputBytes: z.number().int().min(1024).optional(),
      },
      outputSchema: z.object({
        ok: z.boolean(),
        agentRunName: z.string(),
        namespace: z.string(),
        agentRun: z.unknown().nullable(),
        jobs: z.unknown().nullable(),
        getAgentRun: commandResultSchema,
        getJobs: commandResultSchema,
      }),
      annotations: openReadOnlyAnnotations,
      ...toolSecurityMeta([SCOPES.read]),
    },
    withToolErrors<{
      agentRunName: string
      namespace?: string
      timeoutSeconds?: number
      maxOutputBytes?: number
    }>(config, auth, READ_SCOPES, async (args) => {
      const namespace = args.namespace ?? config.agentNamespace
      const getAgentRun = await runner.runProcess({
        command: 'kubectl',
        args: ['get', 'agentrun', args.agentRunName, '-n', namespace, '-o', 'json'],
        timeoutSeconds: args.timeoutSeconds,
        maxOutputBytes: args.maxOutputBytes,
        auth,
        auditEvent: 'agent_status_get_agentrun',
      })
      const getJobs = await runner.runProcess({
        command: 'kubectl',
        args: [
          'get',
          'jobs',
          '-n',
          namespace,
          '-l',
          `agents.proompteng.ai/agent-run=${args.agentRunName}`,
          '-o',
          'json',
        ],
        timeoutSeconds: args.timeoutSeconds,
        maxOutputBytes: args.maxOutputBytes,
        auth,
        auditEvent: 'agent_status_get_jobs',
      })
      return jsonTextResult({
        ok: getAgentRun.ok,
        agentRunName: args.agentRunName,
        namespace,
        agentRun: parseJsonOrNull(getAgentRun.stdout),
        jobs: parseJsonOrNull(getJobs.stdout),
        getAgentRun,
        getJobs,
      })
    }),
  )

  server.registerTool(
    'agent_read',
    {
      title: 'Read delegated agent logs',
      description: 'Read retained logs from a delegated AgentRun job.',
      inputSchema: {
        agentRunName: z.string().min(1),
        namespace: z.string().min(1).optional(),
        tailLines: z.number().int().min(1).max(5000).optional(),
        timeoutSeconds: z.number().int().min(1).optional(),
        maxOutputBytes: z.number().int().min(1024).optional(),
      },
      outputSchema: commandResultSchema,
      annotations: openReadOnlyAnnotations,
      ...toolSecurityMeta([SCOPES.read]),
    },
    withToolErrors<{
      agentRunName: string
      namespace?: string
      tailLines?: number
      timeoutSeconds?: number
      maxOutputBytes?: number
    }>(config, auth, READ_SCOPES, async (args) => {
      const namespace = args.namespace ?? config.agentNamespace
      const tailLines = asPositiveInteger(args.tailLines, 'tailLines', 200, 5000, 1)
      return jsonTextResult(
        await runner.runProcess({
          command: 'kubectl',
          args: [
            'logs',
            '-n',
            namespace,
            '-l',
            `agents.proompteng.ai/agent-run=${args.agentRunName}`,
            '--all-containers=true',
            '--tail',
            String(tailLines),
          ],
          timeoutSeconds: args.timeoutSeconds,
          maxOutputBytes: args.maxOutputBytes,
          auth,
          auditEvent: 'agent_read',
        }),
      )
    }),
  )

  server.registerTool(
    'agent_cancel',
    {
      title: 'Cancel delegated agent',
      description: 'Delete a delegated AgentRun so owned runtime resources are cleaned up.',
      inputSchema: {
        agentRunName: z.string().min(1),
        namespace: z.string().min(1).optional(),
        timeoutSeconds: z.number().int().min(1).optional(),
        maxOutputBytes: z.number().int().min(1024).optional(),
      },
      outputSchema: commandResultSchema,
      annotations: destructiveAnnotations,
      ...toolSecurityMeta([SCOPES.read]),
    },
    withToolErrors<{
      agentRunName: string
      namespace?: string
      timeoutSeconds?: number
      maxOutputBytes?: number
    }>(config, auth, WRITE_SCOPES, async (args) =>
      jsonTextResult(
        await runner.runProcess({
          command: 'kubectl',
          args: ['delete', 'agentrun', args.agentRunName, '-n', args.namespace ?? config.agentNamespace],
          timeoutSeconds: args.timeoutSeconds,
          maxOutputBytes: args.maxOutputBytes,
          auth,
          auditEvent: 'agent_cancel',
        }),
      ),
    ),
  )

  installOpenAiToolsListHandler(server)

  return server
}

const anonymousAuthContext = (authError?: OAuthChallenge): AuthContext => ({
  subject: 'unauthenticated',
  email: null,
  username: null,
  scopes: new Set(),
  payload: {},
  authError,
})

const jsonResponse = (payload: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init.headers,
    },
  })

const logAgentsShellRequest = (request: Request, status: number, startedAt: number, requestId: string) => {
  const { pathname } = new URL(request.url)
  if (pathname !== '/mcp' && pathname !== PROTECTED_RESOURCE_PATH) return

  console.log(
    JSON.stringify({
      msg: 'agents-shell http request',
      requestId,
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

  const handleMcp = async (request: Request, requestId: string): Promise<Response> => {
    const token = bearerTokenFromRequest(request)
    let auth = anonymousAuthContext()
    if (token) {
      try {
        auth = await verifier.verify(token)
      } catch (error) {
        logOAuthFailure(request, requestId, token, error)
        auth = anonymousAuthContext({
          error: 'invalid_token',
          description: 'The access token is invalid or expired.',
        })
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
    const requestId = randomUUID()
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
      response = await handleMcp(request, requestId)
    } else if (pathname === '/mcp') {
      response = new Response('Method Not Allowed', { status: 405 })
    } else {
      response = new Response('Not Found', { status: 404 })
    }

    logAgentsShellRequest(request, response.status, startedAt, requestId)
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
