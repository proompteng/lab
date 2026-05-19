import { spawn } from 'node:child_process'
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
import { Context, Data, Effect, Layer, ManagedRuntime } from 'effect'

import { ensureFileDirectory } from '../../scripts/codex/lib/fs'

import {
  asNumber,
  asString,
  buildTemplateContext,
  type AgentRunnerGoal,
  type AgentRunnerSpec,
  type CodexAppServerAdapterConfig,
  isRecord,
  renderTemplate,
} from './spec'

type AgentRunPayload = Record<string, unknown>

export const DEFAULT_CODEX_BINARY_PATH = '/usr/local/bin/codex'

export type CodexAppServerRunnerStatus = {
  provider: string
  adapter: 'codex-app-server'
  exitCode: number
  status: 'succeeded' | 'failed'
  startedAt: string
  finishedAt: string
  threadId?: string
  turnId?: string
  model?: string
  effort?: string
  cwd?: string | null
  artifacts: {
    statusPath?: string
    logPath?: string
  }
  error?: string
}

export type CodexAppServerRunnerClient = {
  runTurnStream: (
    prompt: string,
    options?: CodexAppServerTurnOptions,
  ) => Promise<{ stream: AsyncGenerator<StreamDelta, Turn | null, void>; turnId: string; threadId: string }>
  interruptTurn?: (turnId: string, threadId: string) => Promise<void>
  stop?: () => void
}

export type RunCodexAppServerAdapterOptions = {
  createClient?: (options: CodexAppServerOptions) => CodexAppServerRunnerClient
  runCommand?: CommandRunner
  now?: () => Date
}

type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

type CommandRunner = (command: string, args: string[], options?: { cwd?: string }) => Promise<CommandResult>

export class CodexRunnerInputError extends Data.TaggedError('CodexRunnerInputError')<{
  readonly operation: 'load-payload' | 'resolve-prompt'
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

export class CodexRunnerStatusError extends Data.TaggedError('CodexRunnerStatusError')<{
  readonly operation: 'write-status'
  readonly path?: string
  readonly cause: unknown
}> {}

export type CodexRunnerError =
  | CodexRunnerInputError
  | CodexRunnerWorkspaceError
  | CodexRunnerClientError
  | CodexRunnerTurnError
  | CodexRunnerStatusError

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
  if (error instanceof CodexRunnerStatusError) {
    return `${error._tag}: ${error.operation}${error.path ? ` ${error.path}` : ''}: ${toErrorMessage(error.cause)}`
  }
  return toErrorMessage(error)
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
  const payloadPath = asString(spec.payloads?.eventFilePath) ?? asString(spec.payloads?.eventBodyPath)
  if (!payloadPath) {
    return {}
  }
  return readJsonFile(payloadPath)
}

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
  const rendered = renderTemplate(template, {
    ...buildTemplateContext(spec),
    run: runPayload,
  })
  return nonEmptyString(rendered)
}

const resolvePrompt = (
  spec: AgentRunnerSpec,
  adapter: CodexAppServerAdapterConfig,
  runPayload: AgentRunPayload,
): string => {
  const adapterPrompt = renderOptionalTemplate(adapter.prompt, spec, runPayload)
  if (adapterPrompt) return adapterPrompt

  const candidates = [
    runPayload.prompt,
    readNested(runPayload, ['parameters', 'prompt']),
    readNested(runPayload, ['implementation', 'text']),
    readNested(runPayload, ['implementation', 'summary']),
    runPayload.issueBody,
    readNested(runPayload, ['event', 'body']),
  ]

  for (const candidate of candidates) {
    const text = nonEmptyString(candidate)
    if (text) return text
  }

  return JSON.stringify(runPayload, null, 2)
}

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

export const runCodexAppServerAdapter = async (
  spec: AgentRunnerSpec,
  adapter: CodexAppServerAdapterConfig,
  options: RunCodexAppServerAdapterOptions = {},
): Promise<number> => {
  const now = options.now ?? (() => new Date())
  const startedAt = timestampUtc(now)
  const statusPath = spec.artifacts?.statusPath
  const logPath = spec.artifacts?.logPath

  let threadId: string | undefined
  let turnId: string | undefined
  let exitCode = 1
  let errorMessage: string | undefined
  let caughtError: unknown
  let client: CodexAppServerRunnerClient | null = null
  let logStream: Awaited<ReturnType<typeof openLog>> = null

  try {
    const runPayload = await loadRunPayload(spec)
    const prompt = resolvePrompt(spec, adapter, runPayload)
    const baseInstructions =
      renderOptionalTemplate(adapter.baseInstructions, spec, runPayload) ?? nonEmptyString(runPayload.systemPrompt)
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
      threadConfig: adapter.threadConfig as CodexAppServerOptions['threadConfig'],
      experimentalRawEvents: adapter.experimentalRawEvents,
      persistExtendedHistory: adapter.persistExtendedHistory,
      bootstrapTimeoutMs: adapter.bootstrapTimeoutMs,
    }
    await prepareCodexCwd(adapter, runPayload, options.runCommand ?? runDefaultCommand)
    client = await createRunnerClient(clientOptions, options.createClient)
    logStream = await openLog(logPath)

    const turnOptions: CodexAppServerTurnOptions = {
      model: adapter.model,
      cwd: adapter.cwd,
      threadId: adapter.threadId,
      effort: adapter.effort,
      baseInstructions,
      developerInstructions,
      goal,
    }
    const response = await client.runTurnStream(prompt, turnOptions).catch((cause) => {
      throw new CodexRunnerTurnError({ operation: 'start-turn', cause })
    })
    threadId = response.threadId
    turnId = response.turnId

    const iterator = response.stream[Symbol.asyncIterator]()
    while (true) {
      const { value, done } = await iterator.next().catch((cause) => {
        throw new CodexRunnerTurnError({ operation: 'stream-turn', threadId, turnId, cause })
      })
      if (done) break
      writeDelta(value, logStream)
    }
    exitCode = 0
  } catch (error) {
    caughtError = error
    errorMessage = describeRunnerError(error)
    exitCode = 1
  } finally {
    await new Promise<void>((resolve) => {
      if (!logStream) {
        resolve()
        return
      }
      logStream.end(resolve)
    })
    client?.stop?.()

    await writeStatus(statusPath, {
      provider: spec.provider,
      adapter: 'codex-app-server',
      exitCode,
      status: exitCode === 0 ? 'succeeded' : 'failed',
      startedAt,
      finishedAt: timestampUtc(now),
      ...(threadId ? { threadId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(adapter.model ? { model: adapter.model } : {}),
      ...(adapter.effort ? { effort: adapter.effort } : {}),
      ...(adapter.cwd !== undefined ? { cwd: adapter.cwd } : {}),
      artifacts: {
        statusPath,
        logPath,
      },
      ...(errorMessage ? { error: errorMessage } : {}),
    })
  }

  if (caughtError) {
    throw caughtError
  }

  return exitCode
}
