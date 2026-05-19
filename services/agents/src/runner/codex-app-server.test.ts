import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { CodexAppServerOptions, CodexAppServerTurnOptions, StreamDelta, Turn } from '@proompteng/codex'
import { describe, expect, it, vi } from 'vitest'

import {
  CodexRunnerCancellationError,
  CodexRunnerClientError,
  CodexRunnerInputError,
  CodexRunnerTurnError,
  DEFAULT_CODEX_BINARY_PATH,
  resolveCodexBinaryPath,
  runCodexAppServerAdapter,
  type CodexAppServerRunnerClient,
} from './codex-app-server'

const makeStream = async function* (): AsyncGenerator<StreamDelta, Turn | null, void> {
  yield { type: 'message', delta: 'done' }
  return null
}

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

describe('codex app-server runner adapter', () => {
  it('uses an absolute Codex binary path by default for Bun child-process spawning', () => {
    expect(resolveCodexBinaryPath({}, {})).toBe(DEFAULT_CODEX_BINARY_PATH)
    expect(resolveCodexBinaryPath({}, { AGENTS_CODEX_BINARY: '/custom/agents-codex' })).toBe('/custom/agents-codex')
    expect(resolveCodexBinaryPath({}, { CODEX_BINARY: '/custom/codex' })).toBe('/custom/codex')
    expect(resolveCodexBinaryPath({ binaryPath: '/adapter/codex' }, { AGENTS_CODEX_BINARY: '/env/codex' })).toBe(
      '/adapter/codex',
    )
  })

  it('maps run.json and runner adapter config into a Codex app-server turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-codex-runner-'))
    const runPath = join(dir, 'run.json')
    const statusPath = join(dir, 'status.json')
    const logPath = join(dir, 'runner.log')
    const cwd = join(dir, 'lab')
    await writeFile(
      runPath,
      `${JSON.stringify({
        implementation: { text: 'implement the feature' },
        systemPrompt: 'system instructions',
        parameters: { artifactName: 'research-result' },
        goal: { objective: 'ship the feature', tokenBudget: 1234 },
      })}\n`,
      'utf8',
    )

    const createdClients: CodexAppServerOptions[] = []
    const turnOptions: CodexAppServerTurnOptions[] = []
    const fakeClient: CodexAppServerRunnerClient = {
      runTurnStream: async (_prompt, options) => {
        turnOptions.push(options ?? {})
        return {
          stream: makeStream(),
          turnId: 'turn-1',
          threadId: 'thread-1',
        }
      },
      stop: () => undefined,
    }

    const exitCode = await runCodexAppServerAdapter(
      {
        provider: 'codex-runner',
        inputs: {
          stage: 'research',
        },
        payloads: {
          eventFilePath: runPath,
        },
        artifacts: {
          statusPath,
          logPath,
        },
        providerSpec: {
          outputArtifacts: [
            {
              name: 'codex-artifact',
              path: '/workspace/{{ inputs.stage }}/{{ run.parameters.artifactName }}.json',
              key: 'codex-research/{{ run.parameters.artifactName }}.json',
            },
          ],
        },
      },
      {
        model: 'gpt-5.5',
        effort: 'high',
        sandbox: 'danger-full-access',
        approval: 'never',
        cwd,
        threadConfig: { web_search: 'live', mcp_servers: {} },
      },
      {
        createClient: (options) => {
          createdClients.push(options)
          return fakeClient
        },
        uploadArtifacts: async (artifacts) =>
          artifacts.map((artifact) => ({
            ...artifact,
            url: artifact.key ? `s3://argo-workflows/${artifact.key}` : artifact.url,
          })),
      },
    )

    expect(exitCode).toBe(0)
    expect(createdClients[0]).toMatchObject({
      binaryPath: DEFAULT_CODEX_BINARY_PATH,
      defaultModel: 'gpt-5.5',
      defaultEffort: 'high',
      sandbox: 'danger-full-access',
      approval: 'never',
      cwd,
      threadConfig: { web_search: 'live', mcp_servers: {} },
    })
    expect(turnOptions[0]).toMatchObject({
      model: 'gpt-5.5',
      effort: 'high',
      cwd,
      baseInstructions: 'system instructions',
      goal: {
        objective: 'ship the feature',
        tokenBudget: 1234,
      },
    })

    const status = JSON.parse(await readFile(statusPath, 'utf8')) as Record<string, unknown>
    expect(status).toMatchObject({
      provider: 'codex-runner',
      adapter: 'codex-app-server',
      exitCode: 0,
      status: 'succeeded',
      threadId: 'thread-1',
      turnId: 'turn-1',
    })
    expect(status.artifacts).toMatchObject({
      outputArtifacts: [
        {
          name: 'codex-artifact',
          path: '/workspace/research/research-result.json',
          key: 'codex-research/research-result.json',
          url: 's3://argo-workflows/codex-research/research-result.json',
        },
      ],
    })
    expect(await readFile(logPath, 'utf8')).toContain('"delta":"done"')
  })

  it('requires the versioned payload eventFilePath contract', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-codex-runner-'))
    const statusPath = join(dir, 'status.json')

    await expect(
      runCodexAppServerAdapter(
        {
          provider: 'codex-runner',
          payloads: {},
          artifacts: { statusPath },
        },
        {},
        {
          createClient: () => {
            throw new Error('client should not start')
          },
        },
      ),
    ).rejects.toBeInstanceOf(CodexRunnerInputError)

    const status = JSON.parse(await readFile(statusPath, 'utf8')) as Record<string, unknown>
    expect(status).toMatchObject({
      exitCode: 1,
      status: 'failed',
    })
    expect(String(status.error)).toContain('payloads.eventFilePath')
  })

  it('creates a non-VCS cwd before starting Codex app-server', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-codex-runner-'))
    const runPath = join(dir, 'run.json')
    const cwd = join(dir, 'workspace')
    await writeFile(runPath, `${JSON.stringify({ implementation: { text: 'check startup' } })}\n`, 'utf8')

    let cwdExistedWhenClientStarted = false

    await runCodexAppServerAdapter(
      {
        provider: 'codex-runner',
        payloads: {
          eventFilePath: runPath,
        },
      },
      {
        cwd,
      },
      {
        createClient: () => {
          cwdExistedWhenClientStarted = existsSync(cwd)
          return {
            runTurnStream: async () => ({
              stream: makeStream(),
              turnId: 'turn-1',
              threadId: 'thread-1',
            }),
          }
        },
      },
    )

    expect(cwdExistedWhenClientStarted).toBe(true)
    expect((await stat(cwd)).isDirectory()).toBe(true)
  })

  it('checks out VCS-backed runs into the adapter cwd before starting Codex app-server', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-codex-runner-'))
    const runPath = join(dir, 'run.json')
    const cwd = join(dir, 'lab')
    await writeFile(
      runPath,
      `${JSON.stringify({
        implementation: { text: 'check startup' },
        vcs: {
          repository: 'proompteng/lab',
          cloneBaseUrl: 'https://github.com',
          baseBranch: 'main',
          headBranch: 'codex/test',
          mode: 'read-write',
          writeEnabled: true,
        },
      })}\n`,
      'utf8',
    )

    const commands: string[] = []
    await runCodexAppServerAdapter(
      {
        provider: 'codex-runner',
        payloads: {
          eventFilePath: runPath,
        },
      },
      {
        cwd,
      },
      {
        runCommand: async (command, args) => {
          commands.push([command, ...args].join(' '))
          if (command === 'git' && args[0] === 'clone') {
            await mkdir(join(cwd, '.git'), { recursive: true })
          }
          return { exitCode: 0, stdout: '', stderr: '' }
        },
        createClient: () => ({
          runTurnStream: async () => ({
            stream: makeStream(),
            turnId: 'turn-1',
            threadId: 'thread-1',
          }),
        }),
      },
    )

    expect(commands).toContain(
      'git clone --filter=blob:none --no-checkout https://github.com/proompteng/lab.git ' + cwd,
    )
    expect(commands).toContain('git fetch --prune --depth=1 origin +refs/heads/main:refs/remotes/origin/main')
    expect(commands).toContain(
      'git fetch --prune --depth=1 origin +refs/heads/codex/test:refs/remotes/origin/codex/test',
    )
    expect(commands).toContain('git checkout -B codex/test refs/remotes/origin/codex/test')
  })

  it('writes failed status and throws a typed input error when run payload JSON is invalid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-codex-runner-'))
    const runPath = join(dir, 'run.json')
    const statusPath = join(dir, 'status.json')
    await writeFile(runPath, '{bad-json', 'utf8')

    await expect(
      runCodexAppServerAdapter(
        {
          provider: 'codex-runner',
          payloads: { eventFilePath: runPath },
          artifacts: { statusPath },
        },
        {},
        {
          createClient: () => {
            throw new Error('client should not start')
          },
        },
      ),
    ).rejects.toBeInstanceOf(CodexRunnerInputError)

    const status = JSON.parse(await readFile(statusPath, 'utf8')) as Record<string, unknown>
    expect(status).toMatchObject({
      provider: 'codex-runner',
      adapter: 'codex-app-server',
      exitCode: 1,
      status: 'failed',
    })
    expect(String(status.error)).toContain('CodexRunnerInputError')
    expect(String(status.error)).toContain(runPath)
  })

  it('categorizes client construction failures and writes failed status', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-codex-runner-'))
    const runPath = join(dir, 'run.json')
    const statusPath = join(dir, 'status.json')
    await writeFile(runPath, `${JSON.stringify({ implementation: { text: 'start client' } })}\n`, 'utf8')

    await expect(
      runCodexAppServerAdapter(
        {
          provider: 'codex-runner',
          payloads: { eventFilePath: runPath },
          artifacts: { statusPath },
        },
        {},
        {
          createClient: () => {
            throw new Error('missing codex binary')
          },
        },
      ),
    ).rejects.toBeInstanceOf(CodexRunnerClientError)

    const status = JSON.parse(await readFile(statusPath, 'utf8')) as Record<string, unknown>
    expect(status).toMatchObject({
      exitCode: 1,
      status: 'failed',
    })
    expect(String(status.error)).toContain('CodexRunnerClientError')
    expect(String(status.error)).toContain('missing codex binary')
  })

  it('categorizes stream failures and still stops the app-server client', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-codex-runner-'))
    const runPath = join(dir, 'run.json')
    const statusPath = join(dir, 'status.json')
    await writeFile(runPath, `${JSON.stringify({ implementation: { text: 'fail during stream' } })}\n`, 'utf8')

    const stop = vi.fn()
    const stream = async function* (): AsyncGenerator<StreamDelta, Turn | null, void> {
      yield { type: 'message', delta: 'starting' }
      throw new Error('stream disconnected')
    }

    await expect(
      runCodexAppServerAdapter(
        {
          provider: 'codex-runner',
          payloads: { eventFilePath: runPath },
          artifacts: { statusPath },
        },
        {},
        {
          createClient: () => ({
            runTurnStream: async () => ({
              stream: stream(),
              turnId: 'turn-stream',
              threadId: 'thread-stream',
            }),
            stop,
          }),
        },
      ),
    ).rejects.toBeInstanceOf(CodexRunnerTurnError)

    expect(stop).toHaveBeenCalledTimes(1)
    const status = JSON.parse(await readFile(statusPath, 'utf8')) as Record<string, unknown>
    expect(status).toMatchObject({
      exitCode: 1,
      status: 'failed',
      threadId: 'thread-stream',
      turnId: 'turn-stream',
    })
    expect(String(status.error)).toContain('CodexRunnerTurnError')
    expect(String(status.error)).toContain('stream disconnected')
  })

  it('interrupts the app-server turn and writes cancelled status when the runner is terminated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-codex-runner-'))
    const runPath = join(dir, 'run.json')
    const statusPath = join(dir, 'status.json')
    await writeFile(runPath, `${JSON.stringify({ implementation: { text: 'cancel me' } })}\n`, 'utf8')

    const abortController = new AbortController()
    const streamEntered = deferred()
    const interruptTurn = vi.fn().mockResolvedValue(undefined)
    const stop = vi.fn()
    const stream = async function* (): AsyncGenerator<StreamDelta, Turn | null, void> {
      streamEntered.resolve()
      await new Promise<never>(() => undefined)
      return null
    }

    const run = runCodexAppServerAdapter(
      {
        provider: 'codex-runner',
        payloads: { eventFilePath: runPath },
        artifacts: { statusPath },
      },
      {},
      {
        abortSignal: abortController.signal,
        createClient: () => ({
          runTurnStream: async () => ({
            stream: stream(),
            turnId: 'turn-cancel',
            threadId: 'thread-cancel',
          }),
          interruptTurn,
          stop,
        }),
      },
    )

    await streamEntered.promise
    abortController.abort({ signal: 'SIGTERM' })

    await expect(run).rejects.toBeInstanceOf(CodexRunnerCancellationError)
    expect(interruptTurn).toHaveBeenCalledWith('turn-cancel', 'thread-cancel')
    expect(stop).toHaveBeenCalledTimes(1)
    const status = JSON.parse(await readFile(statusPath, 'utf8')) as Record<string, unknown>
    expect(status).toMatchObject({
      exitCode: 130,
      status: 'cancelled',
      threadId: 'thread-cancel',
      turnId: 'turn-cancel',
    })
    expect(String(status.error)).toContain('CodexRunnerCancellationError')
    expect(String(status.error)).toContain('SIGTERM')
  })

  it('honors cancellation before starting the app-server client', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-codex-runner-'))
    const runPath = join(dir, 'run.json')
    const statusPath = join(dir, 'status.json')
    await writeFile(runPath, `${JSON.stringify({ implementation: { text: 'do not start' } })}\n`, 'utf8')

    const abortController = new AbortController()
    abortController.abort({ signal: 'SIGINT' })

    const createClient = vi.fn(() => ({
      runTurnStream: async () => ({
        stream: makeStream(),
        turnId: 'turn-1',
        threadId: 'thread-1',
      }),
    }))

    await expect(
      runCodexAppServerAdapter(
        {
          provider: 'codex-runner',
          payloads: { eventFilePath: runPath },
          artifacts: { statusPath },
        },
        {},
        {
          abortSignal: abortController.signal,
          createClient,
        },
      ),
    ).rejects.toBeInstanceOf(CodexRunnerCancellationError)

    expect(createClient).not.toHaveBeenCalled()
    const status = JSON.parse(await readFile(statusPath, 'utf8')) as Record<string, unknown>
    expect(status).toMatchObject({
      exitCode: 130,
      status: 'cancelled',
    })
    expect(status).not.toHaveProperty('threadId')
    expect(status).not.toHaveProperty('turnId')
    expect(String(status.error)).toContain('SIGINT')
  })
})
