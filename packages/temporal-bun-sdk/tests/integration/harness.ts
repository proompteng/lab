import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { fromJson } from '@bufbuild/protobuf'
import { Effect } from 'effect'

import { HistorySchema, type HistoryEvent } from '../../src/proto/temporal/api/history/v1/message_pb'
import { EventType } from '../../src/proto/temporal/api/enums/v1/event_type_pb'

export interface TemporalDevServerConfig {
  readonly address: string
  readonly namespace: string
  readonly taskQueue?: string
  readonly cliBinaryPath?: string
  readonly cliPort?: number
  readonly cliUiPort?: number
  readonly cliLogPath?: string
  readonly artifactsDir?: string
  readonly workerLoadArtifactsDir?: string
  readonly tls?: {
    readonly caPath?: string
    readonly certPath?: string
    readonly keyPath?: string
  }
}

export interface WorkflowExecutionHandle {
  readonly workflowId: string
  readonly runId: string
}

export interface IntegrationHarness {
  readonly setup: Effect.Effect<void, TemporalCliError, never>
  readonly teardown: Effect.Effect<void, TemporalCliError, never>
  readonly runScenario: <A>(
    name: string,
    scenario: () => Effect.Effect<A, TemporalCliError, never>,
    options?: ScenarioRunOptions,
  ) => Effect.Effect<A, TemporalCliError, never>
  readonly executeWorkflow: (
    options: TemporalWorkflowExecuteOptions,
  ) => Effect.Effect<WorkflowExecutionHandle, TemporalCliError, never>
  readonly fetchWorkflowHistory: (
    handle: WorkflowExecutionHandle,
  ) => Effect.Effect<HistoryEvent[], TemporalCliError, never>
  readonly workerLoadArtifacts: WorkerLoadArtifactsHelper
  readonly temporalCliLogPath: string
}

export interface ScenarioRunOptions {
  readonly env?: Record<string, string | undefined>
}

export interface WorkerLoadArtifactsHelper {
  readonly root: string
  readonly resolve: (...segments: string[]) => string
  readonly prepare: (options?: { readonly clean?: boolean }) => Effect.Effect<string, TemporalCliError, never>
}

export interface TemporalWorkflowExecuteOptions {
  readonly workflowType: string
  readonly workflowId?: string
  readonly taskQueue?: string
  readonly args?: unknown[]
  readonly signal?: {
    readonly name: string
    readonly payload?: unknown[]
  }
  readonly startOnly?: boolean
}

export type TemporalCliError =
  | TemporalCliUnavailableError
  | TemporalCliCommandError
  | TemporalCliArtifactError

export class TemporalCliUnavailableError extends Error {
  readonly attempts: readonly { candidate: string; error: string }[]

  constructor(message: string, attempts: readonly { candidate: string; error: string }[]) {
    super(message)
    this.name = 'TemporalCliUnavailableError'
    this.attempts = attempts
  }
}

export class TemporalCliCommandError extends Error {
  readonly command: readonly string[]
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string

  constructor(command: readonly string[], exitCode: number, stdout: string, stderr: string) {
    super(`Temporal CLI command failed (exit ${exitCode}): ${command.join(' ')}`)
    this.name = 'TemporalCliCommandError'
    this.command = command
    this.exitCode = exitCode
    this.stdout = stdout
    this.stderr = stderr
  }
}

export class TemporalCliArtifactError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'TemporalCliArtifactError'
  }
}

export const findTemporalCliUnavailableError = (
  value: unknown,
  visited: Set<unknown> = new Set(),
): TemporalCliUnavailableError | null => {
  if (value instanceof TemporalCliUnavailableError) {
    return value
  }
  if (!value || typeof value !== 'object') {
    return null
  }
  if (visited.has(value)) {
    return null
  }
  visited.add(value)
  const record = value as Record<string, unknown>
  for (const key of ['error', 'cause', 'left', 'right']) {
    const match = findTemporalCliUnavailableError(record[key], visited)
    if (match) {
      return match
    }
  }
  return null
}

const textDecoder = new TextDecoder()
const reuseExistingServer = process.env.TEMPORAL_TEST_SERVER === '1'

export const createIntegrationHarness = (
  config: TemporalDevServerConfig,
): Effect.Effect<IntegrationHarness, TemporalCliError, never> =>
  Effect.gen(function* () {
    const projectRoot = join(import.meta.dir, '..', '..')
    const artifactsRoot =
      config.artifactsDir ?? process.env.TEMPORAL_ARTIFACTS_DIR ?? join(projectRoot, '.artifacts')
    const workerLoadArtifactsDir =
      config.workerLoadArtifactsDir ?? join(artifactsRoot, 'worker-load')
    const temporalCliLogPath =
      config.cliLogPath ?? process.env.TEMPORAL_CLI_LOG_PATH ?? join(projectRoot, '.temporal-cli.log')
    const startScript = join(projectRoot, 'scripts', 'start-temporal-cli.ts')
    const stopScript = join(projectRoot, 'scripts', 'stop-temporal-cli.ts')
    const lockDir = join(projectRoot, '.temporal-cli')
    const testLockFile = join(lockDir, 'test.lock')
    const testRefcountFile = join(lockDir, 'test.refcount')

    if (!existsSync(startScript) || !existsSync(stopScript)) {
      throw new TemporalCliUnavailableError('Temporal CLI management scripts are missing', [])
    }

    const workerLoadArtifacts = createWorkerLoadArtifactsHelper(workerLoadArtifactsDir)

    const { hostname, port } = parseAddress(config.address)
    const cliPort = config.cliPort ?? port
    const cliUiPort = config.cliUiPort ?? cliPort + 1000

    const cliExecutable = yield* resolveTemporalCliExecutable(config.cliBinaryPath)

    let started = false

    const scenarioEnv: Record<string, string | undefined> = {
      TEMPORAL_ADDRESS: config.address,
      TEMPORAL_NAMESPACE: config.namespace,
      TEMPORAL_TLS_CA_PATH: config.tls?.caPath,
      TEMPORAL_TLS_CERT_PATH: config.tls?.certPath,
      TEMPORAL_TLS_KEY_PATH: config.tls?.keyPath,
      TEMPORAL_ARTIFACTS_DIR: artifactsRoot,
      TEMPORAL_WORKER_LOAD_ARTIFACTS_DIR: workerLoadArtifacts.root,
      TEMPORAL_CLI_LOG_PATH: temporalCliLogPath,
    }
    const cliEnv = compactStringEnv(scenarioEnv)

    const runTemporalCli = (args: readonly string[]) => {
      const command = [cliExecutable, '--address', config.address, ...args]
      return Effect.tryPromise({
        try: async () => {
          console.info('[temporal-bun-sdk] running CLI command', command.join(' '))
          const child = Bun.spawn(command, {
            stdout: 'pipe',
            stderr: 'pipe',
            env: {
              ...process.env,
              ...cliEnv,
            },
          })
          const exitCode = await child.exited
          const stdout = child.stdout ? await readStream(child.stdout) : ''
          const stderr = child.stderr ? await readStream(child.stderr) : ''
          if (exitCode !== 0) {
            const cliError = new TemporalCliCommandError(command, exitCode, stdout, stderr)
            console.error('[temporal-bun-sdk] CLI command failed', { command, exitCode, stdout, stderr })
            if (isTemporalEndpointUnavailable(cliError)) {
              throw new TemporalCliUnavailableError(
                `Temporal endpoint ${config.address} is unavailable while running "${command.join(' ')}"`,
                [{ candidate: config.address, error: stderr || stdout || cliError.message }],
              )
            }
            throw cliError
          }
          console.info('[temporal-bun-sdk] CLI command stdout', stdout)
          if (stderr.trim().length > 0) {
            console.info('[temporal-bun-sdk] CLI command stderr', stderr)
          }
          return stdout
        },
        catch: (error) => {
          if (error instanceof TemporalCliUnavailableError || error instanceof TemporalCliCommandError) {
            return error
          }
          return new TemporalCliCommandError(
            command,
            -1,
            '',
            error instanceof Error ? error.message : String(error),
          )
        },
      })
    }

    const waitForNamespaceReady = async () => {
      // Keep readiness retries below the default 60s bun hook timeout so suites can catch and skip cleanly.
      const maxAttempts = Number.parseInt(process.env.TEMPORAL_NAMESPACE_READY_MAX_ATTEMPTS ?? '90', 10)
      const retryDelayMs = Number.parseInt(process.env.TEMPORAL_NAMESPACE_READY_RETRY_MS ?? '500', 10)
      let lastError: unknown
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await Effect.runPromise(
            runTemporalCli(['operator', 'namespace', 'describe', '--namespace', config.namespace, '--output', 'json']),
          )
          return
        } catch (error) {
          lastError = error
          if (attempt === maxAttempts) {
            break
          }
          if (attempt === 1 || attempt % 10 === 0) {
            console.warn('[temporal-bun-sdk] waiting for Temporal namespace readiness', {
              address: config.address,
              namespace: config.namespace,
              attempt,
              maxAttempts,
              delayMs: retryDelayMs,
              error: error instanceof Error ? error.message : String(error),
            })
          }
          await Bun.sleep(retryDelayMs)
        }
      }
      if (isTemporalEndpointUnavailable(lastError)) {
        const detail =
          lastError instanceof TemporalCliCommandError
            ? lastError.stderr || lastError.stdout || lastError.message
            : lastError instanceof Error
              ? lastError.message
              : String(lastError)
        throw new TemporalCliUnavailableError(
          `Temporal endpoint ${config.address} is unavailable after ${maxAttempts} readiness attempts`,
          [{ candidate: config.address, error: detail }],
        )
      }
      throw lastError
    }

    const setup = Effect.tryPromise({
      try: async () => {
        if (started) {
          return
        }
        await withTestLock(lockDir, testLockFile, async () => {
          const currentRef = readRefcount(testRefcountFile)
          if (currentRef === 0 && !reuseExistingServer) {
            const child = Bun.spawn(['bun', startScript], {
              cwd: projectRoot,
              stdout: 'pipe',
              stderr: 'pipe',
              env: {
                ...process.env,
                TEMPORAL_NAMESPACE: config.namespace,
                TEMPORAL_CLI_PATH: cliExecutable,
                TEMPORAL_PORT: String(cliPort),
                TEMPORAL_UI_PORT: String(cliUiPort),
                TEMPORAL_ARTIFACTS_DIR: artifactsRoot,
                TEMPORAL_WORKER_LOAD_ARTIFACTS_DIR: workerLoadArtifacts.root,
                TEMPORAL_CLI_LOG_PATH: temporalCliLogPath,
              },
            })
            const exitCode = await child.exited
            const stdout = child.stdout ? await readStream(child.stdout) : ''
            const stderr = child.stderr ? await readStream(child.stderr) : ''
            if (exitCode !== 0 && !stderr.includes('Temporal CLI already running')) {
              throw new TemporalCliCommandError(['bun', startScript], exitCode, stdout, stderr)
            }
            console.info(
              `[temporal-bun-sdk] Temporal CLI dev server running at ${hostname}:${cliPort} (ui:${cliUiPort})`,
            )
          } else if (reuseExistingServer) {
            console.info('[temporal-bun-sdk] reusing existing Temporal dev server')
          }
          writeRefcount(testRefcountFile, currentRef + 1)
        })
        started = true
        await waitForNamespaceReady()
      },
      catch: (error) => normalizeTemporalCliError(error, ['harness.setup']),
    })

    const teardown = Effect.tryPromise({
      try: async () => {
        if (!started) {
          return
        }
        await withTestLock(lockDir, testLockFile, async () => {
          const currentRef = readRefcount(testRefcountFile)
          const nextRef = Math.max(0, currentRef - 1)
          if (nextRef === 0) {
            if (reuseExistingServer) {
              console.info('[temporal-bun-sdk] leaving Temporal dev server running (reuse enabled)')
            } else {
              const child = Bun.spawn(['bun', stopScript], {
                cwd: projectRoot,
                stdout: 'pipe',
                stderr: 'pipe',
              })
              const exitCode = await child.exited
              const stdout = child.stdout ? await readStream(child.stdout) : ''
              const stderr = child.stderr ? await readStream(child.stderr) : ''
              if (exitCode !== 0) {
                throw new TemporalCliCommandError(['bun', stopScript], exitCode, stdout, stderr)
              }
            }
            rmSync(testRefcountFile, { force: true })
          } else {
            writeRefcount(testRefcountFile, nextRef)
          }
        })
        started = false
      },
      catch: (error) => normalizeTemporalCliError(error, ['harness.teardown']),
    })

    const executeWorkflow = (
      options: TemporalWorkflowExecuteOptions,
    ): Effect.Effect<WorkflowExecutionHandle, TemporalCliError, never> => {
      const workflowId = options.workflowId ?? `cli-integration-${randomUUID()}`
      const taskQueue = options.taskQueue ?? config.taskQueue
      if (!taskQueue) {
        throw new TemporalCliCommandError(
          ['temporal', 'workflow', options.startOnly ? 'start' : 'execute'],
          -1,
          '',
          'Task queue missing for Temporal CLI workflow execution',
        )
      }
      const args = buildInputArgs(options.args)
      const cliOperation = options.startOnly ? 'start' : 'execute'
      const command = [
        'workflow',
        cliOperation,
        '--workflow-id',
        workflowId,
        '--task-queue',
        taskQueue,
        '--type',
        options.workflowType,
        '--namespace',
        config.namespace,
        '--output',
        'json',
        ...args,
      ]

      const cliCommand = [cliExecutable, ...command] as const
      const describeArgs = [
        'workflow',
        'describe',
        '--workflow-id',
        workflowId,
        '--namespace',
        config.namespace,
        '--output',
        'json',
      ] as const
      const describeCommand = [cliExecutable, ...describeArgs] as const
      return runTemporalCli(command).pipe(
        Effect.flatMap((stdout) => parseWorkflowExecutionHandle(stdout, workflowId, cliCommand)),
        Effect.catchAll((error) => {
          if (error instanceof TemporalCliCommandError) {
            console.warn('[temporal-bun-sdk:test] CLI command failed, stdout:', error.stdout)
            console.warn('[temporal-bun-sdk:test] CLI command failed, stderr:', error.stderr)
            return runTemporalCli(describeArgs).pipe(
              Effect.flatMap((stdout) => parseWorkflowDescribeHandle(stdout, workflowId, describeCommand)),
            )
          }
          return Effect.fail(error)
        }),
      )
    }

    const fetchWorkflowHistory = (
      handle: WorkflowExecutionHandle,
    ): Effect.Effect<HistoryEvent[], TemporalCliError, never> => {
      const showArgs = [
        'workflow',
        'show',
        '--workflow-id',
        handle.workflowId,
        '--run-id',
        handle.runId,
        '--namespace',
        config.namespace,
        '--output',
        'json',
      ] as const

      return runTemporalCli(showArgs).pipe(
        Effect.flatMap((stdout) => parseHistoryEvents(stdout, ['temporal', ...showArgs] as const)),
      )
    }

    const runScenario: IntegrationHarness['runScenario'] = (name, scenario, options) =>
      withEnvironment(
        { ...scenarioEnv, ...(options?.env ?? {}) },
        Effect.sync(() => {
          console.info(`[temporal-bun-sdk] scenario: ${name}`)
        }).pipe(Effect.zipRight(scenario())),
      )

    return {
      setup,
      teardown,
      runScenario,
      executeWorkflow,
      fetchWorkflowHistory,
      workerLoadArtifacts,
      temporalCliLogPath,
    }
  })

const readRefcount = (path: string): number => {
  if (!existsSync(path)) {
    return 0
  }
  try {
    const value = readFileSync(path, 'utf8').trim()
    const parsed = Number(value)
    return Number.isNaN(parsed) ? 0 : parsed
  } catch {
    return 0
  }
}

const writeRefcount = (path: string, next: number) => {
  writeFileSync(path, String(next), 'utf8')
}

const compactStringEnv = (values: Record<string, string | undefined>): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string' && value.length > 0) {
      env[key] = value
    }
  }
  return env
}

const isTemporalEndpointUnavailable = (error: unknown): boolean => {
  if (error instanceof TemporalCliUnavailableError) {
    return true
  }
  const detail =
    error instanceof TemporalCliCommandError
      ? `${error.stderr}\n${error.stdout}\n${error.message}`
      : error instanceof Error
        ? error.message
        : String(error)

  const normalized = detail.toLowerCase()
  return (
    normalized.includes('failed reaching server') ||
    normalized.includes('no children to pick from') ||
    normalized.includes('connection refused') ||
    normalized.includes('context deadline exceeded') ||
    normalized.includes('getaddrinfo') ||
    normalized.includes('transport: error while dialing') ||
    normalized.includes('unavailable')
  )
}

const normalizeTemporalCliError = (error: unknown, command: readonly string[]): TemporalCliError => {
  if (
    error instanceof TemporalCliUnavailableError ||
    error instanceof TemporalCliCommandError ||
    error instanceof TemporalCliArtifactError
  ) {
    return error
  }
  return new TemporalCliCommandError(command, -1, '', error instanceof Error ? error.message : String(error))
}

const withTestLock = async <T>(lockDir: string, lockFile: string, fn: () => Promise<T>): Promise<T> => {
  mkdirSync(lockDir, { recursive: true })
  const start = Date.now()
  const timeoutMs = 30_000
  while (true) {
    try {
      const fd = openSync(lockFile, 'wx')
      closeSync(fd)
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        throw error
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for integration lock at ${lockFile}`)
      }
      await Bun.sleep(200)
    }
  }
  try {
    return await fn()
  } finally {
    rmSync(lockFile, { force: true })
  }
}

const readStream = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
  if (!stream) {
    return ''
  }
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    if (value) {
      chunks.push(value)
    }
  }
  if (chunks.length === 0) {
    return ''
  }
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const merged = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return textDecoder.decode(merged)
}

export const resolveTemporalCliExecutable = (
  override?: string,
): Effect.Effect<string, TemporalCliUnavailableError, never> =>
  Effect.try({
    try: () => {
      const attempts: Array<{ candidate: string; error: string }> = []
      const home = process.env.HOME?.trim()
      const candidates = override
        ? [override]
        : [
            'temporal',
            ...(home ? [`${home}/.temporalio/bin/temporal`, `${home}/.local/bin/temporal`] : []),
            '/usr/local/bin/temporal',
            '/usr/bin/temporal',
            '/opt/homebrew/bin/temporal',
          ]

      for (const candidate of candidates) {
        try {
          const result = Bun.spawnSync([candidate, '--help'], { stdout: 'ignore', stderr: 'pipe' })
          if (result.exitCode === 0) {
            return candidate
          }
          const stderrMsg = result.stderr ? textDecoder.decode(result.stderr) : `exit code ${result.exitCode}`
          attempts.push({ candidate, error: stderrMsg.trim() })
        } catch (error) {
          attempts.push({ candidate, error: error instanceof Error ? error.message : String(error) })
        }
      }

      throw new TemporalCliUnavailableError(
        'Unable to locate a working `temporal` CLI executable. Set TEMPORAL_CLI_PATH or install https://github.com/temporalio/cli.',
        attempts,
      )
    },
    catch: (error) => (error instanceof TemporalCliUnavailableError ? error : new TemporalCliUnavailableError(String(error), [])),
  })

const buildInputArgs = (args: unknown[] | undefined): string[] => {
  if (!args || args.length === 0) {
    return []
  }
  const parts: string[] = []
  for (const value of args) {
    parts.push('--input', JSON.stringify(value))
  }
  return parts
}

const parseWorkflowExecutionHandle = (
  stdout: string,
  fallbackWorkflowId: string,
  command: readonly string[],
): Effect.Effect<WorkflowExecutionHandle, TemporalCliCommandError, never> =>
  Effect.try({
    try: () => {
      const trimmed = stdout.trim()
      if (trimmed.length === 0) {
        throw new Error('Temporal CLI returned empty workflow execute output')
      }
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const workflowExecution =
        (parsed.execution ?? parsed.workflowExecution ?? {}) as Record<string, string | undefined>
      const resolvedWorkflowId =
        (parsed.workflowId as string | undefined) ?? workflowExecution.workflowId ?? fallbackWorkflowId
      const runId =
        (parsed.runId as string | undefined) ??
        (parsed.executionRunId as string | undefined) ??
        workflowExecution.runId
      if (!runId) {
        throw new Error('Temporal CLI did not return a runId')
      }
      return { workflowId: resolvedWorkflowId, runId }
    },
    catch: (error) =>
      new TemporalCliCommandError(
        command,
        0,
        stdout,
        error instanceof Error ? error.message : String(error),
      ),
  })

const parseWorkflowDescribeHandle = (
  stdout: string,
  fallbackWorkflowId: string,
  command: readonly string[],
): Effect.Effect<WorkflowExecutionHandle, TemporalCliCommandError, never> =>
  Effect.try({
    try: () => {
      const trimmed = stdout.trim()
      if (trimmed.length === 0) {
        throw new Error('Temporal CLI returned empty workflow describe output')
      }
      const parsed = JSON.parse(trimmed) as {
        workflowExecutionInfo?: {
          execution?: {
            workflowId?: string
            runId?: string
          }
        }
      }
      const execution = parsed.workflowExecutionInfo?.execution ?? {}
      const runId = execution.runId
      if (!runId) {
        throw new Error('Temporal CLI describe output missing runId')
      }
      const resolvedWorkflowId = execution.workflowId ?? fallbackWorkflowId
      return { workflowId: resolvedWorkflowId, runId }
    },
    catch: (error) =>
      new TemporalCliCommandError(
        command,
        0,
        stdout,
        error instanceof Error ? error.message : String(error),
      ),
  })

const parseHistoryEvents = (
  stdout: string,
  command: readonly string[],
): Effect.Effect<HistoryEvent[], TemporalCliCommandError, never> =>
  Effect.try({
    try: () => {
      const trimmed = stdout.trim()
      if (trimmed.length === 0) {
        throw new Error('Temporal CLI returned empty history output')
      }
      const parsed = JSON.parse(trimmed) as unknown
      const historyJson = normalizeHistoryJson(parsed)
      const history = fromJson(HistorySchema, historyJson)
      if (!history.events || history.events.length === 0) {
        throw new Error('Temporal CLI returned empty history events')
      }
      return history.events.map(normalizeEventTypeFlag)
    },
    catch: (error) =>
      new TemporalCliCommandError(
        command,
        0,
        stdout,
        error instanceof Error ? error.message : String(error),
      ),
  })

const normalizeHistoryJson = (input: unknown): unknown => {
  if (Array.isArray(input)) {
    return { events: input }
  }
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>
    if (Array.isArray(record.events)) {
      return { events: record.events }
    }
    if (record.history) {
      return record.history
    }
    if (record.historyJson) {
      return record.historyJson
    }
  }
  return input
}

const normalizeEventTypeFlag = (event: HistoryEvent): HistoryEvent => {
  if (event.eventType && typeof event.eventType !== 'number') {
    const raw = String(event.eventType)
    const key = raw.startsWith('EVENT_TYPE_') ? raw.replace('EVENT_TYPE_', '') : raw
    const numeric = (EventType as Record<string, number>)[key]
    if (typeof numeric === 'number') {
      event.eventType = numeric as typeof event.eventType
    }
  }
  return event
}

const createWorkerLoadArtifactsHelper = (root: string): WorkerLoadArtifactsHelper => {
  const prepare = (options?: { readonly clean?: boolean }) =>
    Effect.try({
      try: () => {
        if (options?.clean && existsSync(root)) {
          rmSync(root, { recursive: true, force: true })
        }
        mkdirSync(root, { recursive: true })
        return root
      },
      catch: (error) =>
        new TemporalCliArtifactError(
          `Failed to prepare worker load artifacts directory at ${root}`,
          error,
        ),
    })

  return {
    root,
    resolve: (...segments: string[]) => join(root, ...segments),
    prepare: (options) => prepare(options),
  }
}

const parseAddress = (value: string): { hostname: string; port: number } => {
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`)
    const parsedPort = Number(url.port)
    if (!Number.isInteger(parsedPort) || parsedPort <= 0) {
      throw new Error(`address is missing a valid port: ${value}`)
    }
    return { hostname: url.hostname, port: parsedPort }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new TemporalCliUnavailableError(`Invalid Temporal address "${value}": ${message}`, [])
  }
}

const withEnvironment = <A, E, R>(
  assignments: Record<string, string | undefined>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const snapshot = new Map<string, string | undefined>()
      for (const [key, value] of Object.entries(assignments)) {
        snapshot.set(key, process.env[key])
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
      return snapshot
    }),
    () => effect,
    (snapshot) =>
      Effect.sync(() => {
        for (const [key, value] of snapshot) {
          if (value === undefined) {
            delete process.env[key]
          } else {
            process.env[key] = value
          }
        }
      }),
  )
