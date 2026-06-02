import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  CodexAppServerClient,
  type CodexAppServerOptions,
  type CodexAppServerTurnOptions,
  type StreamDelta,
  type Turn,
} from '@proompteng/codex'
import { Cause, Context, Data, Effect, Exit, Layer, ManagedRuntime, Option } from 'effect'

import { ensureFileDirectory } from '../../scripts/codex/lib/fs'

import { uploadOutputArtifacts } from './artifact-upload'
import {
  asNumber,
  asString,
  buildTemplateContext,
  type AgentProviderOutputArtifact,
  type AgentRunnerGoal,
  type AgentRunnerSpec,
  type CodexAppServerAdapterConfig,
  isRecord,
  renderOutputArtifacts,
  renderTemplate,
} from './spec'

type AgentRunPayload = Record<string, unknown>

export const DEFAULT_CODEX_BINARY_PATH = '/usr/local/bin/codex'

export type CodexAppServerRunnerStatus = {
  provider: string
  adapter: 'codex-app-server'
  exitCode: number
  status: 'succeeded' | 'failed' | 'cancelled'
  startedAt: string
  finishedAt: string
  threadId?: string
  turnId?: string
  turnStatus?: Turn['status']
  turnError?: string
  model?: string
  effort?: string
  cwd?: string | null
  artifacts: {
    statusPath?: string
    logPath?: string
    outputArtifacts?: AgentProviderOutputArtifact[]
  }
  error?: string
}

export type CodexAppServerRunnerClient = {
  runTurnStream: (
    prompt: string,
    options?: CodexAppServerTurnOptions,
  ) => Promise<{ stream: AsyncGenerator<StreamDelta, Turn | null, void>; turnId: string; threadId: string }>
  waitForThreadIdle?: (
    threadId: string,
    options?: { quietMs?: number; timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<{ lastTurn: Turn | null }>
  interruptTurn?: (turnId: string, threadId: string) => Promise<void>
  stop?: () => void
}

export type RunCodexAppServerAdapterOptions = {
  createClient?: (options: CodexAppServerOptions) => CodexAppServerRunnerClient
  runCommand?: CommandRunner
  uploadArtifacts?: typeof uploadOutputArtifacts
  now?: () => Date
  abortSignal?: AbortSignal
}

type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

type CommandRunner = (command: string, args: string[], options?: { cwd?: string }) => Promise<CommandResult>

export class CodexRunnerInputError extends Data.TaggedError('CodexRunnerInputError')<{
  readonly operation: 'load-payload' | 'resolve-prompt' | 'validate-adapter' | 'load-system-prompt'
  readonly path?: string
  readonly cause: unknown
}> {}

export class CodexRunnerWorkspaceError extends Data.TaggedError('CodexRunnerWorkspaceError')<{
  readonly operation: 'prepare-cwd' | 'run-command'
  readonly command?: string
  readonly cwd?: string
  readonly cause: unknown
}> {}

export class CodexRunnerClientError extends Data.TaggedError('CodexRunnerClientError')<{
  readonly operation: 'create-client'
  readonly cause: unknown
}> {}

export class CodexRunnerTurnError extends Data.TaggedError('CodexRunnerTurnError')<{
  readonly operation: 'start-turn' | 'stream-turn'
  readonly threadId?: string
  readonly turnId?: string
  readonly cause: unknown
}> {}

export class CodexRunnerCancellationError extends Data.TaggedError('CodexRunnerCancellationError')<{
  readonly operation: 'before-start' | 'cancel-turn'
  readonly threadId?: string
  readonly turnId?: string
  readonly signal?: string
  readonly cause: unknown
}> {}

export class CodexRunnerStatusError extends Data.TaggedError('CodexRunnerStatusError')<{
  readonly operation: 'write-status'
  readonly path?: string
  readonly cause: unknown
}> {}

export class CodexRunnerArtifactError extends Data.TaggedError('CodexRunnerArtifactError')<{
  readonly operation: 'upload-output-artifacts'
  readonly cause: unknown
}> {}

export class CodexRunnerLogError extends Data.TaggedError('CodexRunnerLogError')<{
  readonly operation: 'open-log'
  readonly path?: string
  readonly cause: unknown
}> {}

export type CodexRunnerError =
  | CodexRunnerInputError
  | CodexRunnerWorkspaceError
  | CodexRunnerClientError
  | CodexRunnerTurnError
  | CodexRunnerCancellationError
  | CodexRunnerStatusError
  | CodexRunnerArtifactError
  | CodexRunnerLogError

export type CodexAppServerClientFactoryService = {
  create: (options: CodexAppServerOptions) => Effect.Effect<CodexAppServerRunnerClient, CodexRunnerClientError>
}

export class CodexAppServerClientFactory extends Context.Tag('CodexAppServerClientFactory')<
  CodexAppServerClientFactory,
  CodexAppServerClientFactoryService
>() {}

export type RunnerCommandService = {
  run: (
    command: string,
    args: string[],
    options?: { cwd?: string },
  ) => Effect.Effect<CommandResult, CodexRunnerWorkspaceError>
}

export class RunnerCommand extends Context.Tag('RunnerCommand')<RunnerCommand, RunnerCommandService>() {}

type VcsWorkspaceContext = {
  repository: string
  cloneBaseUrl: string
  baseBranch: string
  headBranch: string | null
  writeEnabled: boolean
}

const timestampUtc = (now: () => Date): string =>
  now()
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')

const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const describeRunnerError = (error: unknown) => {
  if (error instanceof CodexRunnerInputError) {
    return `${error._tag}: ${error.operation}${error.path ? ` ${error.path}` : ''}: ${toErrorMessage(error.cause)}`
  }
  if (error instanceof CodexRunnerWorkspaceError) {
    const command = error.command ? ` ${error.command}` : ''
    const cwd = error.cwd ? ` in ${error.cwd}` : ''
    return `${error._tag}: ${error.operation}${command}${cwd}: ${toErrorMessage(error.cause)}`
  }
  if (error instanceof CodexRunnerClientError) {
    return `${error._tag}: ${error.operation}: ${toErrorMessage(error.cause)}`
  }
  if (error instanceof CodexRunnerTurnError) {
    const ids = [error.threadId ? `thread=${error.threadId}` : null, error.turnId ? `turn=${error.turnId}` : null]
      .filter(Boolean)
      .join(' ')
    return `${error._tag}: ${error.operation}${ids ? ` ${ids}` : ''}: ${toErrorMessage(error.cause)}`
  }
  if (error instanceof CodexRunnerCancellationError) {
    const ids = [error.threadId ? `thread=${error.threadId}` : null, error.turnId ? `turn=${error.turnId}` : null]
      .filter(Boolean)
      .join(' ')
    const signal = error.signal ? ` signal=${error.signal}` : ''
    return `${error._tag}: ${error.operation}${ids ? ` ${ids}` : ''}${signal}: ${toErrorMessage(error.cause)}`
  }
  if (error instanceof CodexRunnerStatusError) {
    return `${error._tag}: ${error.operation}${error.path ? ` ${error.path}` : ''}: ${toErrorMessage(error.cause)}`
  }
  if (error instanceof CodexRunnerArtifactError) {
    return `${error._tag}: ${error.operation}: ${toErrorMessage(error.cause)}`
  }
  if (error instanceof CodexRunnerLogError) {
    return `${error._tag}: ${error.operation}${error.path ? ` ${error.path}` : ''}: ${toErrorMessage(error.cause)}`
  }
  return toErrorMessage(error)
}

const isCodexRunnerError = (error: unknown): error is CodexRunnerError =>
  error instanceof CodexRunnerInputError ||
  error instanceof CodexRunnerWorkspaceError ||
  error instanceof CodexRunnerClientError ||
  error instanceof CodexRunnerTurnError ||
  error instanceof CodexRunnerCancellationError ||
  error instanceof CodexRunnerStatusError ||
  error instanceof CodexRunnerArtifactError ||
  error instanceof CodexRunnerLogError

const describeAbortReason = (reason: unknown): string | undefined => {
  if (typeof reason === 'string') return reason
  if (reason instanceof Error) return reason.message
  if (isRecord(reason) && typeof reason.signal === 'string') return reason.signal
  return undefined
}

const describeTurnError = (turn: Turn): string => {
  const message = turn.error?.message?.trim()
  const details = turn.error?.additionalDetails?.trim()
  const status = `Codex app-server turn ${turn.id} finished with status ${turn.status}`
  return [message && message.length > 0 ? message : status, details]
    .filter((part) => part && part.length > 0)
    .join(': ')
}

const terminalErrorForTurn = (
  turn: Turn | null,
  threadId: string | undefined,
  turnId: string | undefined,
): CodexRunnerTurnError | CodexRunnerCancellationError | null => {
  if (!turn || turn.status === 'completed') return null
  if (turn.status === 'interrupted') {
    return new CodexRunnerCancellationError({
      operation: 'cancel-turn',
      threadId,
      turnId,
      signal: 'app-server-interrupted',
      cause: new Error(describeTurnError(turn)),
    })
  }
  return new CodexRunnerTurnError({
    operation: 'stream-turn',
    threadId,
    turnId,
    cause: new Error(describeTurnError(turn)),
  })
}

const cancellationErrorFor = (signal: AbortSignal, threadId?: string, turnId?: string): CodexRunnerCancellationError =>
  new CodexRunnerCancellationError({
    operation: threadId || turnId ? 'cancel-turn' : 'before-start',
    threadId,
    turnId,
    signal: describeAbortReason(signal.reason),
    cause: signal.reason ?? new Error('agent runner cancelled'),
  })

const throwIfCancelled = (signal: AbortSignal | undefined, threadId?: string, turnId?: string) => {
  if (signal?.aborted) {
    throw cancellationErrorFor(signal, threadId, turnId)
  }
}

const throwIfCancelledEffect = (signal: AbortSignal | undefined, threadId?: string, turnId?: string) =>
  signal?.aborted ? Effect.fail(cancellationErrorFor(signal, threadId, turnId)) : Effect.void

const createCancellationWaiter = (
  signal: AbortSignal | undefined,
  getThreadId: () => string | undefined,
  getTurnId: () => string | undefined,
): { promise: Promise<never>; cleanup: () => void } | null => {
  if (!signal) return null

  let cleanup: () => void = () => {}
  const promise = new Promise<never>((_, reject) => {
    const onAbort = () => reject(cancellationErrorFor(signal, getThreadId(), getTurnId()))
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    cleanup = () => signal.removeEventListener('abort', onAbort)
  })

  return { promise, cleanup }
}

const readNested = (value: unknown, path: string[]): unknown => {
  let current = value
  for (const segment of path) {
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return current
}

const readJsonFile = async (path: string): Promise<AgentRunPayload> => {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) {
      throw new Error(`Expected JSON object in ${path}`)
    }
    return parsed
  } catch (error) {
    throw new CodexRunnerInputError({ operation: 'load-payload', path, cause: error })
  }
}

const loadRunPayload = async (spec: AgentRunnerSpec): Promise<AgentRunPayload> => {
  const payloadPath = asString(spec.payloads?.eventFilePath)
  if (!payloadPath) {
    throw new CodexRunnerInputError({
      operation: 'load-payload',
      path: 'payloads.eventFilePath',
      cause: new Error('agent-runner payloads.eventFilePath is required'),
    })
  }
  return readJsonFile(payloadPath)
}

const loadRunPayloadEffect = (spec: AgentRunnerSpec) =>
  Effect.tryPromise({
    try: () => loadRunPayload(spec),
    catch: (cause) =>
      cause instanceof CodexRunnerInputError ? cause : new CodexRunnerInputError({ operation: 'load-payload', cause }),
  })

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

const runProcessCommand: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.on('error', reject)
    child.on('exit', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })

export const RunnerCommandLive = Layer.succeed(RunnerCommand, {
  run: (command, args, options) =>
    Effect.tryPromise({
      try: () => runProcessCommand(command, args, options),
      catch: (cause) =>
        new CodexRunnerWorkspaceError({
          operation: 'run-command',
          command: [command, ...args].join(' '),
          cwd: options?.cwd,
          cause,
        }),
    }),
} satisfies RunnerCommandService)

export const CodexAppServerClientFactoryLive = Layer.succeed(CodexAppServerClientFactory, {
  create: (options) =>
    Effect.try({
      try: () => new CodexAppServerClient(options),
      catch: (cause) => new CodexRunnerClientError({ operation: 'create-client', cause }),
    }),
} satisfies CodexAppServerClientFactoryService)

const runnerRuntime = ManagedRuntime.make(Layer.merge(RunnerCommandLive, CodexAppServerClientFactoryLive))

const runDefaultCommand: CommandRunner = (command, args, options) =>
  runnerRuntime.runPromise(Effect.flatMap(RunnerCommand, (service) => service.run(command, args, options)))

const createDefaultClient = (options: CodexAppServerOptions) =>
  runnerRuntime.runPromise(Effect.flatMap(CodexAppServerClientFactory, (service) => service.create(options)))

const createRunnerClient = async (
  clientOptions: CodexAppServerOptions,
  factory: RunCodexAppServerAdapterOptions['createClient'],
): Promise<CodexAppServerRunnerClient> => {
  if (!factory) {
    return createDefaultClient(clientOptions)
  }
  try {
    return factory(clientOptions)
  } catch (cause) {
    throw new CodexRunnerClientError({ operation: 'create-client', cause })
  }
}

const assertCommandSuccess = (result: CommandResult, description: string) => {
  if (result.exitCode === 0) return
  const output = [result.stderr, result.stdout].filter(Boolean).join('\n').trim()
  throw new CodexRunnerWorkspaceError({
    operation: 'run-command',
    command: description,
    cause: `${description} failed with exit ${result.exitCode}${output ? `: ${output}` : ''}`,
  })
}

const nonEmptyString = (value: unknown): string | null => {
  const text = asString(value)?.trim()
  return text ? text : null
}

const nonBlankStringPreserve = (value: unknown): string | null => {
  const text = asString(value)
  return text && text.trim() ? text : null
}

const isSafeRepositorySlug = (repository: string) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)

const isSafeGitRef = (ref: string) =>
  /^[A-Za-z0-9._/-]+$/.test(ref) &&
  !ref.includes('..') &&
  !ref.includes('@{') &&
  !ref.startsWith('/') &&
  !ref.endsWith('/') &&
  !ref.endsWith('.lock')

const requireSafeGitRef = (ref: string, label: string) => {
  if (!isSafeGitRef(ref)) {
    throw new Error(`Unsafe ${label} git ref "${ref}"`)
  }
}

const readVcsWorkspaceContext = (runPayload: AgentRunPayload): VcsWorkspaceContext | null => {
  const vcs = isRecord(runPayload.vcs) ? runPayload.vcs : {}
  const parameters = isRecord(runPayload.parameters) ? runPayload.parameters : {}
  const repository =
    nonEmptyString(vcs.repository) ?? nonEmptyString(parameters.repository) ?? nonEmptyString(runPayload.repository)
  if (!repository) return null
  if (!isSafeRepositorySlug(repository)) {
    throw new Error(`Unsupported VCS repository "${repository}"; expected owner/repo`)
  }

  const baseBranch =
    nonEmptyString(vcs.baseBranch) ?? nonEmptyString(parameters.base) ?? nonEmptyString(runPayload.base) ?? 'main'
  const headBranch =
    nonEmptyString(vcs.headBranch) ?? nonEmptyString(parameters.head) ?? nonEmptyString(runPayload.head) ?? null
  requireSafeGitRef(baseBranch, 'base')
  if (headBranch) requireSafeGitRef(headBranch, 'head')

  const cloneBaseUrl =
    nonEmptyString(vcs.cloneBaseUrl) ?? nonEmptyString(process.env.VCS_CLONE_BASE_URL) ?? 'https://github.com'
  const writeEnabled = vcs.writeEnabled === true || nonEmptyString(vcs.mode) === 'read-write'

  return {
    repository,
    cloneBaseUrl,
    baseBranch,
    headBranch,
    writeEnabled,
  }
}

const resolveCloneUrl = (vcs: VcsWorkspaceContext): string =>
  `${vcs.cloneBaseUrl.replace(/\/+$/, '')}/${vcs.repository}.git`

const ensureGitAskpass = async () => {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.VCS_TOKEN
  if (!token) return

  if (!process.env.GITHUB_TOKEN) process.env.GITHUB_TOKEN = token
  if (!process.env.GH_TOKEN) process.env.GH_TOKEN = token
  if (!process.env.GIT_ASKPASS_USERNAME) process.env.GIT_ASKPASS_USERNAME = 'x-access-token'
  process.env.GIT_ASKPASS_TOKEN = token
  process.env.GIT_TERMINAL_PROMPT ??= '0'

  if (process.env.GIT_ASKPASS) return
  const askpassPath = '/tmp/agents-git-askpass.sh'
  const script = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' "$GIT_ASKPASS_USERNAME" ;;
  *Password*) printf '%s\\n' "$GIT_ASKPASS_TOKEN" ;;
  *) printf '%s\\n' "$GIT_ASKPASS_TOKEN" ;;
esac
`
  await writeFile(askpassPath, script, 'utf8')
  await chmod(askpassPath, 0o700)
  process.env.GIT_ASKPASS = askpassPath
}

const fetchBranch = async (
  runner: CommandRunner,
  cwd: string,
  branch: string,
  options: { required: boolean },
): Promise<boolean> => {
  const result = await runner(
    'git',
    ['fetch', '--prune', '--depth=1', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    { cwd },
  )
  if (result.exitCode === 0) return true
  if (!options.required) return false
  assertCommandSuccess(result, `git fetch origin ${branch}`)
  return false
}

const ensureVcsCheckout = async (cwd: string, vcs: VcsWorkspaceContext, runner: CommandRunner) => {
  await ensureGitAskpass()
  const cloneUrl = resolveCloneUrl(vcs)
  const gitDir = join(cwd, '.git')

  if (await pathExists(gitDir)) {
    assertCommandSuccess(await runner('git', ['remote', 'set-url', 'origin', cloneUrl], { cwd }), 'git remote set-url')
  } else {
    await mkdir(dirname(cwd), { recursive: true })
    if (await pathExists(cwd)) {
      if (!(await isDirectory(cwd))) {
        throw new CodexRunnerWorkspaceError({
          operation: 'prepare-cwd',
          cwd,
          cause: `Codex cwd ${cwd} exists but is not a directory`,
        })
      }
      const entries = await readdir(cwd)
      if (entries.length > 0) {
        throw new CodexRunnerWorkspaceError({
          operation: 'prepare-cwd',
          cwd,
          cause: `Codex cwd ${cwd} exists but is not a git checkout`,
        })
      }
    }
    assertCommandSuccess(
      await runner('git', ['clone', '--filter=blob:none', '--no-checkout', cloneUrl, cwd]),
      `git clone ${vcs.repository}`,
    )
  }

  await fetchBranch(runner, cwd, vcs.baseBranch, { required: true })
  const headBranch = vcs.headBranch ?? vcs.baseBranch
  const fetchedHead =
    headBranch === vcs.baseBranch ? true : await fetchBranch(runner, cwd, headBranch, { required: false })
  const checkoutRef = fetchedHead ? `refs/remotes/origin/${headBranch}` : `refs/remotes/origin/${vcs.baseBranch}`

  if (vcs.writeEnabled) {
    assertCommandSuccess(
      await runner('git', ['checkout', '-B', headBranch, checkoutRef], { cwd }),
      `git checkout ${headBranch}`,
    )
  } else {
    assertCommandSuccess(
      await runner('git', ['checkout', '--detach', checkoutRef], { cwd }),
      `git checkout ${checkoutRef}`,
    )
  }
}

const prepareCodexCwd = async (
  adapter: CodexAppServerAdapterConfig,
  runPayload: AgentRunPayload,
  runner: CommandRunner,
): Promise<void> => {
  const cwd = nonEmptyString(adapter.cwd)
  if (!cwd) return

  const vcs = readVcsWorkspaceContext(runPayload)
  if (vcs) {
    await ensureVcsCheckout(cwd, vcs, runner)
    return
  }

  await mkdir(cwd, { recursive: true })
}

const prepareCodexCwdEffect = (
  adapter: CodexAppServerAdapterConfig,
  runPayload: AgentRunPayload,
  runner: CommandRunner,
) =>
  Effect.tryPromise({
    try: () => prepareCodexCwd(adapter, runPayload, runner),
    catch: (cause) =>
      cause instanceof CodexRunnerWorkspaceError
        ? cause
        : new CodexRunnerWorkspaceError({
            operation: 'prepare-cwd',
            cwd: nonEmptyString(adapter.cwd) ?? undefined,
            cause,
          }),
  })

export const resolveCodexBinaryPath = (
  adapter: CodexAppServerAdapterConfig,
  env: Record<string, string | undefined> = process.env,
): string => {
  return (
    nonEmptyString(adapter.binaryPath) ??
    nonEmptyString(env.AGENTS_CODEX_BINARY) ??
    nonEmptyString(env.CODEX_BINARY) ??
    DEFAULT_CODEX_BINARY_PATH
  )
}

const renderOptionalTemplate = (
  template: string | undefined,
  spec: AgentRunnerSpec,
  runPayload: AgentRunPayload,
): string | null => {
  if (!template) return null
  const rendered = renderTemplate(template, buildRuntimeTemplateContext(spec, runPayload))
  return nonBlankStringPreserve(rendered)
}

const buildRuntimeTemplateContext = (spec: AgentRunnerSpec, runPayload: AgentRunPayload) => ({
  ...buildTemplateContext(spec),
  run: runPayload,
  env: process.env,
})

const renderTemplatedJsonValue = (value: unknown, context: ReturnType<typeof buildRuntimeTemplateContext>): unknown => {
  if (typeof value === 'string') return renderTemplate(value, context)
  if (Array.isArray(value)) return value.map((entry) => renderTemplatedJsonValue(entry, context))
  if (!isRecord(value)) return value

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entry]) => [key, renderTemplatedJsonValue(entry, context)])
      .filter(([, entry]) => entry !== undefined),
  )
}

const renderThreadConfig = (
  threadConfig: CodexAppServerAdapterConfig['threadConfig'],
  spec: AgentRunnerSpec,
  runPayload: AgentRunPayload,
) => {
  if (threadConfig === undefined || threadConfig === null) return threadConfig
  const rendered = renderTemplatedJsonValue(threadConfig, buildRuntimeTemplateContext(spec, runPayload))
  return isRecord(rendered) ? rendered : threadConfig
}

const resolvePrompt = (
  spec: AgentRunnerSpec,
  adapter: CodexAppServerAdapterConfig,
  runPayload: AgentRunPayload,
): string => {
  const adapterPrompt = renderOptionalTemplate(adapter.prompt, spec, runPayload)
  if (adapterPrompt) return adapterPrompt

  throw new CodexRunnerInputError({
    operation: 'resolve-prompt',
    cause: new Error('codex app-server adapter requires normalized adapter.codex.prompt in agent-runner.json'),
  })
}

const resolvePromptEffect = (
  spec: AgentRunnerSpec,
  adapter: CodexAppServerAdapterConfig,
  runPayload: AgentRunPayload,
) =>
  Effect.try({
    try: () => resolvePrompt(spec, adapter, runPayload),
    catch: (cause) =>
      cause instanceof CodexRunnerInputError
        ? cause
        : new CodexRunnerInputError({ operation: 'resolve-prompt', cause }),
  })

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex')

const resolveSystemPromptPath = (adapter: CodexAppServerAdapterConfig) =>
  nonEmptyString(adapter.systemPromptPath) ?? nonEmptyString(process.env.CODEX_SYSTEM_PROMPT_PATH)

const resolveExpectedSystemPromptHash = (adapter: CodexAppServerAdapterConfig) =>
  nonEmptyString(adapter.systemPromptExpectedHash) ?? nonEmptyString(process.env.CODEX_SYSTEM_PROMPT_EXPECTED_HASH)

const isSystemPromptRequired = (adapter: CodexAppServerAdapterConfig) =>
  Boolean(resolveSystemPromptPath(adapter)) ||
  nonEmptyString(process.env.CODEX_SYSTEM_PROMPT_REQUIRED)?.toLowerCase() === 'true'

const assertSystemPromptHash = (contents: string, adapter: CodexAppServerAdapterConfig, source: string) => {
  const expectedHash = resolveExpectedSystemPromptHash(adapter)
  const actualHash = sha256Hex(contents)
  if (expectedHash && actualHash !== expectedHash) {
    throw new Error(
      `system prompt hash mismatch for ${source}: expected ${expectedHash}, actual ${actualHash}, bytes ${Buffer.byteLength(
        contents,
        'utf8',
      )}`,
    )
  }
}

const readSystemPromptInstructions = async (
  adapter: CodexAppServerAdapterConfig,
  spec: AgentRunnerSpec,
  runPayload: AgentRunPayload,
): Promise<string | null> => {
  const rendered = renderOptionalTemplate(adapter.baseInstructions, spec, runPayload)
  if (rendered) {
    assertSystemPromptHash(rendered, adapter, 'adapter.baseInstructions')
    return rendered
  }

  const systemPromptPath = resolveSystemPromptPath(adapter)
  if (systemPromptPath) {
    try {
      const contents = await readFile(systemPromptPath, 'utf8')
      assertSystemPromptHash(contents, adapter, systemPromptPath)
      const prompt = nonBlankStringPreserve(contents)
      if (prompt) return prompt
      if (isSystemPromptRequired(adapter)) {
        throw new Error(`system prompt file ${systemPromptPath} is empty`)
      }
      return null
    } catch (cause) {
      throw new CodexRunnerInputError({ operation: 'load-system-prompt', path: systemPromptPath, cause })
    }
  }

  const inlinePrompt = nonBlankStringPreserve(runPayload.systemPrompt)
  if (inlinePrompt) {
    assertSystemPromptHash(inlinePrompt, adapter, 'run.json systemPrompt')
    return inlinePrompt
  }
  if (isSystemPromptRequired(adapter)) {
    throw new CodexRunnerInputError({
      operation: 'load-system-prompt',
      cause: new Error('CODEX_SYSTEM_PROMPT_REQUIRED is true but no system prompt path or inline prompt was provided'),
    })
  }
  return null
}

const readSystemPromptInstructionsEffect = (
  adapter: CodexAppServerAdapterConfig,
  spec: AgentRunnerSpec,
  runPayload: AgentRunPayload,
) =>
  Effect.tryPromise({
    try: () => readSystemPromptInstructions(adapter, spec, runPayload),
    catch: (cause) =>
      cause instanceof CodexRunnerInputError
        ? cause
        : new CodexRunnerInputError({ operation: 'load-system-prompt', cause }),
  })

const validateCodexAdapter = (adapter: CodexAppServerAdapterConfig) => {
  if (adapter.approval && adapter.approval !== 'never') {
    throw new CodexRunnerInputError({
      operation: 'validate-adapter',
      cause: new Error(
        `codex app-server runner currently supports approval=never only; adapter requested approval=${adapter.approval}`,
      ),
    })
  }
}

const validateCodexAdapterEffect = (adapter: CodexAppServerAdapterConfig) =>
  Effect.try({
    try: () => validateCodexAdapter(adapter),
    catch: (cause) =>
      cause instanceof CodexRunnerInputError
        ? cause
        : new CodexRunnerInputError({ operation: 'validate-adapter', cause }),
  })

const normalizeGoal = (value: unknown): AgentRunnerGoal | null => {
  if (typeof value === 'string') {
    const objective = value.trim()
    return objective ? { objective } : null
  }
  if (!isRecord(value)) return null

  const objective =
    nonEmptyString(value.objective) ??
    nonEmptyString(value.text) ??
    nonEmptyString(value.summary) ??
    nonEmptyString(value.prompt)
  const tokenBudget = asNumber(value.tokenBudget)
  const status = asString(value.status) as AgentRunnerGoal['status']

  const goal: AgentRunnerGoal = {}
  if (objective) goal.objective = objective
  if (tokenBudget !== null) goal.tokenBudget = tokenBudget
  if (status) goal.status = status

  return Object.keys(goal).length > 0 ? goal : null
}

const mergeGoals = (...goals: Array<AgentRunnerGoal | null | undefined>): AgentRunnerGoal | null => {
  const merged: AgentRunnerGoal = {}
  for (const goal of goals) {
    if (!goal) continue
    if (goal.objective !== undefined) merged.objective = goal.objective
    if (goal.status !== undefined) merged.status = goal.status
    if (goal.tokenBudget !== undefined) merged.tokenBudget = goal.tokenBudget
  }
  return Object.keys(merged).length > 0 ? merged : null
}

const writeStatus = async (statusPath: string | undefined, status: CodexAppServerRunnerStatus) => {
  if (!statusPath) return
  try {
    await ensureFileDirectory(statusPath)
    await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8')
  } catch (error) {
    throw new CodexRunnerStatusError({ operation: 'write-status', path: statusPath, cause: error })
  }
}

const openLog = async (logPath: string | undefined) => {
  if (!logPath) return null
  await ensureFileDirectory(logPath)
  return createWriteStream(logPath, { flags: 'a' })
}

const openLogEffect = (logPath: string | undefined) =>
  Effect.tryPromise({
    try: () => openLog(logPath),
    catch: (cause) => new CodexRunnerLogError({ operation: 'open-log', path: logPath, cause }),
  })

const writeDelta = (delta: StreamDelta, logStream: ReturnType<typeof createWriteStream> | null) => {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), event: delta })}\n`
  logStream?.write(line)

  if (delta.type === 'message') {
    process.stdout.write(delta.delta)
    return
  }

  if (delta.type === 'reasoning') {
    process.stderr.write(delta.delta)
    return
  }

  if (delta.type === 'tool') {
    const detail = delta.detail ? ` ${delta.detail}` : ''
    process.stdout.write(`[${delta.toolKind}:${delta.status}] ${delta.title}${detail}\n`)
  }
}

const interruptAppServerTurn = async (
  client: CodexAppServerRunnerClient | null,
  cancellation: CodexRunnerCancellationError,
  threadId?: string,
  turnId?: string,
) => {
  if (!client?.interruptTurn || !threadId || !turnId) return
  try {
    await client.interruptTurn(turnId, threadId)
  } catch (cause) {
    throw new CodexRunnerCancellationError({
      operation: 'cancel-turn',
      threadId,
      turnId,
      signal: cancellation.signal,
      cause,
    })
  }
}

const createRunnerClientEffect = (
  clientOptions: CodexAppServerOptions,
  factory: RunCodexAppServerAdapterOptions['createClient'],
) =>
  Effect.tryPromise({
    try: () => createRunnerClient(clientOptions, factory),
    catch: (cause) =>
      cause instanceof CodexRunnerClientError
        ? cause
        : new CodexRunnerClientError({ operation: 'create-client', cause }),
  })

const startTurnStreamEffect = (
  client: CodexAppServerRunnerClient,
  prompt: string,
  turnOptions: CodexAppServerTurnOptions,
) =>
  Effect.tryPromise({
    try: () => client.runTurnStream(prompt, turnOptions),
    catch: (cause) => new CodexRunnerTurnError({ operation: 'start-turn', cause }),
  })

const consumeTurnStreamEffect = ({
  stream,
  signal,
  threadId,
  turnId,
  logStream,
}: {
  stream: AsyncGenerator<StreamDelta, Turn | null, void>
  signal?: AbortSignal
  threadId: string
  turnId: string
  logStream: ReturnType<typeof createWriteStream> | null
}) =>
  Effect.tryPromise({
    try: async () => {
      const iterator = stream[Symbol.asyncIterator]()
      const cancellationWaiter = createCancellationWaiter(
        signal,
        () => threadId,
        () => turnId,
      )
      try {
        while (true) {
          throwIfCancelled(signal, threadId, turnId)
          const nextDelta = iterator.next().catch((cause) => {
            throw new CodexRunnerTurnError({ operation: 'stream-turn', threadId, turnId, cause })
          })
          const { value, done } = cancellationWaiter
            ? await Promise.race([nextDelta, cancellationWaiter.promise])
            : await nextDelta
          if (done) {
            return value ?? null
          }
          writeDelta(value, logStream)
        }
      } finally {
        cancellationWaiter?.cleanup()
      }
    },
    catch: (cause) =>
      isCodexRunnerError(cause)
        ? cause
        : new CodexRunnerTurnError({ operation: 'stream-turn', threadId, turnId, cause }),
  })

const parseNonNegativeInteger = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

const waitForThreadIdleEffect = (
  client: CodexAppServerRunnerClient,
  threadId: string,
  signal: AbortSignal | undefined,
) =>
  Effect.tryPromise({
    try: () => {
      if (!client.waitForThreadIdle) return Promise.resolve(null)
      return client.waitForThreadIdle(threadId, {
        quietMs: parseNonNegativeInteger(process.env.CODEX_APP_SERVER_THREAD_IDLE_QUIET_MS, 1000),
        timeoutMs: parseNonNegativeInteger(process.env.CODEX_APP_SERVER_THREAD_IDLE_TIMEOUT_MS, 0),
        signal,
      })
    },
    catch: (cause) => new CodexRunnerTurnError({ operation: 'stream-turn', threadId, cause }),
  })

const uploadOutputArtifactsEffect = (
  artifacts: AgentProviderOutputArtifact[],
  uploadArtifacts: typeof uploadOutputArtifacts,
) =>
  Effect.tryPromise({
    try: () => uploadArtifacts(artifacts),
    catch: (cause) =>
      cause instanceof CodexRunnerArtifactError
        ? cause
        : new CodexRunnerArtifactError({ operation: 'upload-output-artifacts', cause }),
  })

const runCodexEffectPromise = async <A>(effect: Effect.Effect<A, CodexRunnerError>) => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) {
    return exit.value
  }
  const failure = Cause.failureOption(exit.cause)
  if (Option.isSome(failure)) {
    throw failure.value
  }
  throw Cause.squash(exit.cause)
}

type CodexAppServerAdapterState = {
  threadId?: string
  turnId?: string
  finalTurn: Turn | null
  outputArtifacts: AgentProviderOutputArtifact[]
  client: CodexAppServerRunnerClient | null
  logStream: Awaited<ReturnType<typeof openLog>>
}

export const runCodexAppServerAdapterEffect = ({
  spec,
  adapter,
  options,
  state,
}: {
  spec: AgentRunnerSpec
  adapter: CodexAppServerAdapterConfig
  options: RunCodexAppServerAdapterOptions
  state: CodexAppServerAdapterState
}) =>
  Effect.gen(function* () {
    yield* throwIfCancelledEffect(options.abortSignal)
    yield* validateCodexAdapterEffect(adapter)
    const runPayload = yield* loadRunPayloadEffect(spec)
    state.outputArtifacts = renderOutputArtifacts(spec.providerSpec?.outputArtifacts, {
      ...runPayload,
      ...buildTemplateContext(spec),
      run: runPayload,
    })
    yield* throwIfCancelledEffect(options.abortSignal)

    const prompt = yield* resolvePromptEffect(spec, adapter, runPayload)
    const baseInstructions = yield* readSystemPromptInstructionsEffect(adapter, spec, runPayload)
    const developerInstructions = renderOptionalTemplate(adapter.developerInstructions, spec, runPayload)
    const goal = mergeGoals(normalizeGoal(runPayload.goal), spec.goal, adapter.goal)

    const clientOptions: CodexAppServerOptions = {
      binaryPath: resolveCodexBinaryPath(adapter),
      cliConfigOverrides: adapter.cliConfigOverrides,
      cwd: adapter.cwd,
      sandbox: adapter.sandbox,
      approval: adapter.approval,
      defaultModel: adapter.model,
      defaultEffort: adapter.effort,
      threadConfig: renderThreadConfig(adapter.threadConfig, spec, runPayload) as CodexAppServerOptions['threadConfig'],
      experimentalRawEvents: adapter.experimentalRawEvents,
      persistExtendedHistory: adapter.persistExtendedHistory,
      bootstrapTimeoutMs: adapter.bootstrapTimeoutMs,
    }

    yield* prepareCodexCwdEffect(adapter, runPayload, options.runCommand ?? runDefaultCommand)
    yield* throwIfCancelledEffect(options.abortSignal)
    state.client = yield* createRunnerClientEffect(clientOptions, options.createClient)
    state.logStream = yield* openLogEffect(spec.artifacts?.logPath)

    const turnOptions: CodexAppServerTurnOptions = {
      model: adapter.model,
      cwd: adapter.cwd,
      threadId: adapter.threadId,
      effort: adapter.effort,
      baseInstructions,
      developerInstructions,
      goal,
    }
    yield* throwIfCancelledEffect(options.abortSignal)
    const response = yield* startTurnStreamEffect(state.client, prompt, turnOptions)
    state.threadId = response.threadId
    state.turnId = response.turnId
    state.finalTurn = yield* consumeTurnStreamEffect({
      stream: response.stream,
      signal: options.abortSignal,
      threadId: response.threadId,
      turnId: response.turnId,
      logStream: state.logStream,
    })
    const idleResult = yield* waitForThreadIdleEffect(state.client, response.threadId, options.abortSignal)
    if (idleResult?.lastTurn) {
      state.finalTurn = idleResult.lastTurn
    }

    const terminalError = terminalErrorForTurn(state.finalTurn, state.threadId, state.turnId)
    if (terminalError) {
      yield* Effect.fail(terminalError)
    }

    state.outputArtifacts = yield* uploadOutputArtifactsEffect(
      state.outputArtifacts,
      options.uploadArtifacts ?? uploadOutputArtifacts,
    )
    return 0
  })

export const runCodexAppServerAdapter = async (
  spec: AgentRunnerSpec,
  adapter: CodexAppServerAdapterConfig,
  options: RunCodexAppServerAdapterOptions = {},
): Promise<number> => {
  const now = options.now ?? (() => new Date())
  const startedAt = timestampUtc(now)
  const statusPath = spec.artifacts?.statusPath
  const logPath = spec.artifacts?.logPath

  let exitCode = 1
  let errorMessage: string | undefined
  let caughtError: unknown
  const state: CodexAppServerAdapterState = {
    finalTurn: null,
    outputArtifacts: renderOutputArtifacts(spec.providerSpec?.outputArtifacts, buildTemplateContext(spec)),
    client: null,
    logStream: null,
  }

  try {
    exitCode = await runCodexEffectPromise(runCodexAppServerAdapterEffect({ spec, adapter, options, state }))
  } catch (error) {
    let runnerError = error
    if (error instanceof CodexRunnerCancellationError) {
      if (options.abortSignal?.aborted) {
        try {
          await interruptAppServerTurn(state.client, error, state.threadId, state.turnId)
        } catch (interruptError) {
          runnerError = interruptError
        }
      }
      exitCode = 130
    } else {
      exitCode = 1
    }
    caughtError = runnerError
    errorMessage = describeRunnerError(runnerError)
  } finally {
    await new Promise<void>((resolve) => {
      if (!state.logStream) {
        resolve()
        return
      }
      state.logStream.end(resolve)
    })
    state.client?.stop?.()

    const runnerStatus: CodexAppServerRunnerStatus = {
      provider: spec.provider,
      adapter: 'codex-app-server',
      exitCode,
      status: exitCode === 0 ? 'succeeded' : exitCode === 130 ? 'cancelled' : 'failed',
      startedAt,
      finishedAt: timestampUtc(now),
      ...(state.threadId ? { threadId: state.threadId } : {}),
      ...(state.turnId ? { turnId: state.turnId } : {}),
      ...(state.finalTurn?.status ? { turnStatus: state.finalTurn.status } : {}),
      ...(state.finalTurn && state.finalTurn.status !== 'completed'
        ? { turnError: describeTurnError(state.finalTurn) }
        : {}),
      ...(adapter.model ? { model: adapter.model } : {}),
      ...(adapter.effort ? { effort: adapter.effort } : {}),
      ...(adapter.cwd !== undefined ? { cwd: adapter.cwd } : {}),
      artifacts: {
        statusPath,
        logPath,
        ...(state.outputArtifacts.length > 0 ? { outputArtifacts: state.outputArtifacts } : {}),
      },
      ...(errorMessage ? { error: errorMessage } : {}),
    }
    try {
      await writeStatus(statusPath, runnerStatus)
    } catch (statusError) {
      if (!caughtError) {
        caughtError = statusError
        errorMessage = describeRunnerError(statusError)
        exitCode = 1
      } else {
        process.stderr.write(`failed to write Codex app-server runner status: ${describeRunnerError(statusError)}\n`)
      }
    }
  }

  if (caughtError) {
    throw caughtError
  }

  return exitCode
}
