import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { Effect } from 'effect'

import { HistorySchema, type HistoryEvent } from '../../src/proto/temporal/api/history/v1/message_pb'

export interface TemporalDevServerConfig {
  readonly address: string
  readonly namespace: string
  readonly taskQueue: string
  readonly cliBinaryPath?: string
  readonly cliPort?: number
  readonly cliUiPort?: number
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
  ) => Effect.Effect<A, TemporalCliError, never>
  readonly executeWorkflow: (
    options: TemporalWorkflowExecuteOptions,
  ) => Effect.Effect<WorkflowExecutionHandle, TemporalCliError, never>
  readonly fetchWorkflowHistory: (
    handle: WorkflowExecutionHandle,
  ) => Effect.Effect<HistoryEvent[], TemporalCliError, never>
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
}

export type TemporalCliError = TemporalCliUnavailableError | TemporalCliCommandError

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

const textDecoder = new TextDecoder()

export const createIntegrationHarness = (
  config: TemporalDevServerConfig,
): Effect.Effect<IntegrationHarness, TemporalCliError, never> =>
  Effect.gen(function* () {
    const projectRoot = join(import.meta.dir, '..', '..')
    const startScript = join(projectRoot, 'scripts', 'start-temporal-cli.ts')
    const stopScript = join(projectRoot, 'scripts', 'stop-temporal-cli.ts')

    if (!existsSync(startScript) || !existsSync(stopScript)) {
      throw new TemporalCliUnavailableError('Temporal CLI management scripts are missing', [])
    }

    const cliExecutable = yield* resolveTemporalCliExecutable(config.cliBinaryPath)

    let started = false

    const setup = Effect.tryPromise(async () => {
      if (started) {
        return
      }
      const child = Bun.spawn(
        ['bun', startScript],
        {
          cwd: projectRoot,
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            ...process.env,
            TEMPORAL_NAMESPACE: config.namespace,
            TEMPORAL_CLI_PATH: cliExecutable,
            TEMPORAL_PORT: String(config.cliPort ?? 7233),
            TEMPORAL_UI_PORT: String(config.cliUiPort ?? 8233),
          },
        },
      )
      const exitCode = await child.exited
      const stdout = child.stdout ? await readStream(child.stdout) : ''
      const stderr = child.stderr ? await readStream(child.stderr) : ''
      if (exitCode !== 0) {
        if (stderr.includes('Temporal CLI already running')) {
          return
        }
        throw new TemporalCliCommandError(['bun', startScript], exitCode, stdout, stderr)
      }
      started = true
    })

    const teardown = Effect.tryPromise(async () => {
      if (!started) {
        return
      }
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
      started = false
    })

    const runTemporalCli = (args: readonly string[]) =>
      Effect.tryPromise(async () => {
        const command = [cliExecutable, ...args]
        const child = Bun.spawn(command, {
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const exitCode = await child.exited
        const stdout = child.stdout ? await readStream(child.stdout) : ''
        const stderr = child.stderr ? await readStream(child.stderr) : ''
        if (exitCode !== 0) {
          throw new TemporalCliCommandError(command, exitCode, stdout, stderr)
        }
        return stdout
      })

    const describeWorkflow = (workflowId: string): Effect.Effect<WorkflowExecutionHandle, TemporalCliError, never> =>
      runTemporalCli([
        'workflow',
        'show',
        '--workflow-id',
        workflowId,
        '--namespace',
        config.namespace,
        '--output',
        'json',
      ]).pipe(
        Effect.flatMap((stdout) =>
          Effect.try({
            try: () => {
              const parsed = JSON.parse(stdout) as Record<string, unknown>
              const execution = (parsed.execution ??
                parsed.workflowExecution ??
                {}) as Record<string, string | undefined>
              const runId =
                execution?.runId ??
                (parsed as Record<string, string | undefined>)?.runId ??
                (parsed as Record<string, string | undefined>)?.executionRunId
              if (!runId) {
                throw new Error('Unable to resolve workflow run id from CLI output')
              }
              return { workflowId, runId }
            },
            catch: (error) =>
              new TemporalCliCommandError(
                ['temporal', 'workflow', 'show', '--workflow-id', workflowId],
                0,
                stdout,
                error instanceof Error ? error.message : String(error),
              ),
          }),
        ),
      )

    const executeWorkflow = (
      options: TemporalWorkflowExecuteOptions,
    ): Effect.Effect<WorkflowExecutionHandle, TemporalCliError, never> => {
      const workflowId = options.workflowId ?? `cli-integration-${crypto.randomUUID()}`
      const taskQueue = options.taskQueue ?? config.taskQueue
      const args = buildInputArgs(options.args)
      const command = [
        'workflow',
        'execute',
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

      return runTemporalCli(command).pipe(
        Effect.flatMap(() => describeWorkflow(workflowId)),
      )
    }

    const fetchWorkflowHistory = (
      handle: WorkflowExecutionHandle,
    ): Effect.Effect<HistoryEvent[], TemporalCliError, never> =>
      runTemporalCli([
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
      ]).pipe(
        Effect.flatMap((stdout) =>
          Effect.try({
            try: () => {
              const parsed = JSON.parse(stdout) as Record<string, unknown>
              const historyJson = (parsed.history ?? parsed.historyJson) as unknown
              if (!historyJson) {
                throw new Error('Temporal CLI response missing history field')
              }
              const history = HistorySchema.fromJson(historyJson)
              return history.events ?? []
            },
            catch: (error) =>
              new TemporalCliCommandError(
                ['temporal', 'workflow', 'show', '--workflow-id', handle.workflowId, '--run-id', handle.runId],
                0,
                stdout,
                error instanceof Error ? error.message : String(error),
              ),
          }),
        ),
      )

    const runScenario: IntegrationHarness['runScenario'] = (name, scenario) =>
      Effect.succeed(void console.info(`[temporal-bun-sdk] scenario: ${name}`)).pipe(
        Effect.zipRight(scenario()),
      )

    return {
      setup,
      teardown,
      runScenario,
      executeWorkflow,
      fetchWorkflowHistory,
    }
  })

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

const resolveTemporalCliExecutable = (
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
  const encoded = JSON.stringify(args)
  return ['--input', encoded]
}
