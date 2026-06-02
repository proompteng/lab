import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import type { CodexAppServerOptions, CodexAppServerTurnOptions, StreamDelta, Turn } from '@proompteng/codex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CodexRunnerArtifactError,
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

const makeTurn = (status: Turn['status'], error: Turn['error'] = null): Turn => ({
  id: `turn-${status}`,
  items: [],
  status,
  error,
  startedAt: 1,
  completedAt: 2,
  durationMs: 1000,
})

const fakeAppServerPath = fileURLToPath(new URL('../../scripts/codex/fake-app-server.ts', import.meta.url))

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

const NORMALIZED_PROMPT = 'run the normalized Codex adapter contract'
const systemPromptEnvKeys = [
  'CODEX_SYSTEM_PROMPT_PATH',
  'CODEX_SYSTEM_PROMPT_EXPECTED_HASH',
  'CODEX_SYSTEM_PROMPT_REQUIRED',
]
const originalSystemPromptEnv = Object.fromEntries(systemPromptEnvKeys.map((key) => [key, process.env[key]]))

describe('codex app-server runner adapter', () => {
  beforeEach(() => {
    for (const key of systemPromptEnvKeys) delete process.env[key]
  })

  afterEach(() => {
    for (const key of systemPromptEnvKeys) {
      const value = originalSystemPromptEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

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
        agentRun: { name: 'run-1' },
        systemPrompt: 'system instructions',
        parameters: { artifactName: 'research-result' },
        goal: { objective: 'ship the feature', tokenBudget: 1234 },
      })}\n`,
      'utf8',
    )

    const createdClients: CodexAppServerOptions[] = []
    const turnOptions: CodexAppServerTurnOptions[] = []
    const prompts: string[] = []
    const fakeClient: CodexAppServerRunnerClient = {
      runTurnStream: async (prompt, options) => {
        prompts.push(prompt)
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
              key: 'codex-research/{{ agentRun.name }}/{{ run.parameters.artifactName }}.json',
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
        prompt: 'implement the feature',
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
    expect(prompts).toEqual(['implement the feature'])
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
          key: 'codex-research/run-1/research-result.json',
          url: 's3://argo-workflows/codex-research/run-1/research-result.json',
        },
      ],
    })
    expect(await readFile(logPath, 'utf8')).toContain('"delta":"done"')
  })

  it('waits for the app-server thread to settle before reporting success', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-codex-runner-'))
    const runPath = join(dir, 'run.json')
    const statusPath = join(dir, 'status.json')
    await writeFile(
      runPath,
      `${JSON.stringify({
        implementation: { text: 'continue until the session is actually done' },
        agentRun: { name: 'run-continuation' },
      })}\n`,
      'utf8',
    )

    let waitedForThreadId: string | null = null
    const fakeClient: CodexAppServerRunnerClient = {
      runTurnStream: async () => ({
        stream: makeStream(),
        turnId: 'turn-initial',
        threadId: 'thread-continuation',
      }),
      waitForThreadIdle: async (threadId) => {
        waitedForThreadId = threadId
        return { lastTurn: makeTurn('completed') }
      },
      stop: () => undefined,
    }

    const exitCode = await runCodexAppServerAdapter(
      {
        provider: 'codex-runner',
        payloads: {
          eventFilePath: runPath,
        },
        artifacts: {
          statusPath,
        },
      },
      {
        prompt: 'continue until the session is actually done',
      },
      {
        createClient: () => fakeClient,
        uploadArtifacts: async (artifacts) => artifacts,
      },
    )

    expect(exitCode).toBe(0)
    expect(waitedForThreadId).toBe('thread-continuation')
    const status = JSON.parse(await readFile(statusPath, 'utf8')) as Record<string, unknown>
    expect(status).toMatchObject({
      status: 'succeeded',
      threadId: 'thread-continuation',
      turnStatus: 'completed',
    })
  })

  it('fails when an automatic app-server continuation fails before the thread settles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-codex-runner-'))
    const runPath = join(dir, 'run.json')
    const statusPath = join(dir, 'status.json')
    await writeFile(
      runPath,
      `${JSON.stringify({
        implementation: { text: 'continue until failure is visible' },
        agentRun: { name: 'run-continuation-failure' },
      })}\n`,
      'utf8',
    )

    const fakeClient: CodexAppServerRunnerClient = {
      runTurnStream: async () => ({
        stream: makeStream(),
        turnId: 'turn-initial',
        threadId: 'thread-continuation-failure',
      }),
      waitForThreadIdle: async () => ({
        lastTurn: makeTurn('failed', {
          message: 'automatic continuation failed',
          codexErrorInfo: null,
          additionalDetails: null,
        }),
      }),
      stop: () => undefined,
    }

    await expect(
      runCodexAppServerAdapter(
        {
          provider: 'codex-runner',
          payloads: {
            eventFilePath: runPath,
          },
          artifacts: {
            statusPath,
          },
        },
        {
          prompt: 'continue until failure is visible',
        },
        {
          createClient: () => fakeClient,
          uploadArtifacts: async (artifacts) => artifacts,
        },
      ),
    ).rejects.toBeInstanceOf(CodexRunnerTurnError)

    const status = JSON.parse(await readFile(statusPath, 'utf8')) as Record<string, unknown>
    expect(status).toMatchObject({
      status: 'failed',
      turnStatus: 'failed',
    })
    expect(String(status.error)).toContain('automatic continuation failed')
  })

  it('renders threadConfig string templates from runtime environment before creating the Codex client', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-codex-runner-'))
    const runPath = join(dir, 'run.json')
    await writeFile(
      runPath,
      `${JSON.stringify({
        implementation: { text: 'check the broker connection' },
        agentRun: { name: 'run-credentials' },
      })}\n`,
      'utf8',
    )

    const previousEnv = {
      ALPACA_API_KEY: process.env.ALPACA_API_KEY,
      ALPACA_SECRET_KEY: process.env.ALPACA_SECRET_KEY,
      ALPACA_PAPER_TRADE: process.env.ALPACA_PAPER_TRADE,
    }
    process.env.ALPACA_API_KEY = 'paper-key'
    process.env.ALPACA_SECRET_KEY = 'paper-secret'
    process.env.ALPACA_PAPER_TRADE = 'true'

    const createdClients: CodexAppServerOptions[] = []
    const fakeClient: CodexAppServerRunnerClient = {
      runTurnStream: async () => ({
        stream: makeStream(),
        turnId: 'turn-env',
        threadId: 'thread-env',
      }),
      stop: () => undefined,
    }

    try {
      const exitCode = await runCodexAppServerAdapter(
        {
          provider: 'codex-runner',
          payloads: {
            eventFilePath: runPath,
          },
        },
        {
          prompt: 'check broker connection',
          threadConfig: {
            mcp_servers: {
              alpaca: {
                command: '/usr/bin/python3',
                args: ['-u', '/root/alpaca-mcp-stdio-bridge.py'],
                env: {
                  ALPACA_API_KEY: '{{ env.ALPACA_API_KEY }}',
                  ALPACA_SECRET_KEY: '{{ env.ALPACA_SECRET_KEY }}',
                  ALPACA_PAPER_TRADE: '{{ env.ALPACA_PAPER_TRADE }}',
                  FASTMCP_LOG_LEVEL: 'ERROR',
                },
              },
            },
            web_search: 'live',
          },
        },
        {
          createClient: (options) => {
            createdClients.push(options)
            return fakeClient
          },
        },
      )

      expect(exitCode).toBe(0)
      expect(createdClients[0].threadConfig).toMatchObject({
        mcp_servers: {
          alpaca: {
            env: {
              ALPACA_API_KEY: 'paper-key',
              ALPACA_SECRET_KEY: 'paper-secret',
              ALPACA_PAPER_TRADE: 'true',
              FASTMCP_LOG_LEVEL: 'ERROR',
            },
          },
        },
      })
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('runs the deterministic fake app-server binary through the real Codex client protocol', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-codex-runner-'))
    const runPath = join(dir, 'run.json')
    const statusPath = join(dir, 'status.json')
    const logPath = join(dir, 'runner.log')
    const artifactPath = join(dir, 'smoke', 'result.md')
    await writeFile(
      runPath,
      `${JSON.stringify({
        implementation: { text: 'run deterministic smoke' },
        parameters: { stage: 'smoke' },
        goal: { objective: 'verify fake app-server smoke', tokenBudget: 100 },
      })}\n`,
      'utf8',
    )

    const exitCode = await runCodexAppServerAdapter(
      {
        provider: 'codex-spark-smoke',
        payloads: { eventFilePath: runPath },
        artifacts: { statusPath, logPath },
        providerSpec: {
          outputArtifacts: [{ name: 'smoke-result', path: artifactPath }],
        },
      },
      {
        binaryPath: fakeAppServerPath,
        model: 'agents-fake-codex-app-server',
        effort: 'low',
        sandbox: 'danger-full-access',
        approval: 'never',
        prompt: `Write \`${artifactPath}\` and respond OK.`,
        goal: { objective: 'verify fake app-server smoke', tokenBudget: 100 },
        threadConfig: { mcp_servers: {}, web_search: 'off' },
      },
    )

    expect(exitCode).toBe(0)
    expect(await readFile(artifactPath, 'utf8')).toContain('startup status: ok')
    expect(await readFile(logPath, 'utf8')).toContain('"delta":"OK\\n"')
    const status = JSON.parse(await readFile(statusPath, 'utf8')) as Record<string, unknown>
    expect(status).toMatchObject({
      provider: 'codex-spark-smoke',
      adapter: 'codex-app-server',
      exitCode: 0,
      status: 'succeeded',
      turnStatus: 'completed',
      model: 'agents-fake-codex-app-server',
      effort: 'low',
    })
    expect(status.artifacts).toMatchObject({
      outputArtifacts: [{ name: 'smoke-result', path: artifactPath }],
    })
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
        { prompt: NORMALIZED_PROMPT },
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

  it('requires a normalized Codex prompt in the runner contract', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-codex-runner-'))
    const runPath = join(dir, 'run.json')
    const statusPath = join(dir, 'status.json')
    await writeFile(runPath, `${JSON.stringify({ implementation: { text: 'legacy prompt' } })}\n`, 'utf8')

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
    expect(status).toMatchObject({ exitCode: 1, status: 'failed' })
    expect(String(status.error)).toContain('adapter.codex.prompt')
  })

  it('reads and hash-checks mounted system prompts from the runner contract', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-codex-runner-'))
    const runPath = join(dir, 'run.json')
    const systemPromptPath = join(dir, 'system-prompt.txt')
    await writeFile(runPath, `${JSON.stringify({ implementation: { text: 'run' } })}\n`, 'utf8')
    await writeFile(systemPromptPath, 'mounted system prompt', 'utf8')

    const turnOptions: CodexAppServerTurnOptions[] = []
    await runCodexAppServerAdapter(
      {
        provider: 'codex-runner',
        payloads: { eventFilePath: runPath },
      },
      {
        prompt: NORMALIZED_PROMPT,
        systemPromptPath,
        systemPromptExpectedHash: createHash('sha256').update('mounted system prompt').digest('hex'),
      },
      {
        createClient: () => ({
          runTurnStream: async (_prompt, options) => {
            turnOptions.push(options ?? {})
            return {
              stream: makeStream(),
              turnId: 'turn-1',
              threadId: 'thread-1',
            }
          },
        }),
      },
    )

    expect(turnOptions[0]).toMatchObject({ baseInstructions: 'mounted system prompt' })
  })

  it('preserves inline system prompt bytes before validating the controller hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-codex-runner-'))
    const runPath = join(dir, 'run.json')
    const baseInstructions = 'system instructions with newline\n'
    await writeFile(
      runPath,
      `${JSON.stringify({ implementation: { text: 'run' }, systemPrompt: baseInstructions })}\n`,
      'utf8',
    )

    const turnOptions: CodexAppServerTurnOptions[] = []
    await runCodexAppServerAdapter(
      {
        provider: 'codex-runner',
        payloads: { eventFilePath: runPath },
      },
      {
        prompt: NORMALIZED_PROMPT,
        baseInstructions,
        systemPromptExpectedHash: createHash('sha256').update(baseInstructions).digest('hex'),
      },
      {
        createClient: () => ({
          runTurnStream: async (_prompt, options) => {
            turnOptions.push(options ?? {})
            return {
              stream: makeStream(),
              turnId: 'turn-1',
              threadId: 'thread-1',
            }
          },
        }),
      },
    )

    expect(turnOptions[0]).toMatchObject({ baseInstructions })
  })

  it('rejects unsupported app-server approval modes before starting Codex', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-codex-runner-'))
    const runPath = join(dir, 'run.json')
    const statusPath = join(dir, 'status.json')
    await writeFile(runPath, `${JSON.stringify({ implementation: { text: 'run' } })}\n`, 'utf8')

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
        { prompt: NORMALIZED_PROMPT, approval: 'on-request' },
        { createClient },
      ),
    ).rejects.toBeInstanceOf(CodexRunnerInputError)

    expect(createClient).not.toHaveBeenCalled()
    const status = JSON.parse(await readFile(statusPath, 'utf8')) as Record<string, unknown>
    expect(String(status.error)).toContain('approval=never only')
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
        prompt: NORMALIZED_PROMPT,
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
        prompt: NORMALIZED_PROMPT,
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
        { prompt: NORMALIZED_PROMPT },
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
        { prompt: NORMALIZED_PROMPT },
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
        { prompt: NORMALIZED_PROMPT },
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

  it('fails the runner when the app-server stream returns a failed final turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-codex-runner-'))
    const runPath = join(dir, 'run.json')
    const statusPath = join(dir, 'status.json')
    await writeFile(runPath, `${JSON.stringify({ implementation: { text: 'final turn fails' } })}\n`, 'utf8')

    const stream = async function* (): AsyncGenerator<StreamDelta, Turn | null, void> {
      yield { type: 'message', delta: 'started' }
      return makeTurn('failed', {
        message: 'policy denied',
        codexErrorInfo: null,
        additionalDetails: 'approval mode rejected the command',
      })
    }

    await expect(
      runCodexAppServerAdapter(
        {
          provider: 'codex-runner',
          payloads: { eventFilePath: runPath },
          artifacts: { statusPath },
        },
        { prompt: NORMALIZED_PROMPT },
        {
          createClient: () => ({
            runTurnStream: async () => ({
              stream: stream(),
              turnId: 'turn-failed',
              threadId: 'thread-failed',
            }),
          }),
        },
      ),
    ).rejects.toBeInstanceOf(CodexRunnerTurnError)

    const status = JSON.parse(await readFile(statusPath, 'utf8')) as Record<string, unknown>
    expect(status).toMatchObject({
      exitCode: 1,
      status: 'failed',
      threadId: 'thread-failed',
      turnId: 'turn-failed',
      turnStatus: 'failed',
      turnError: 'policy denied: approval mode rejected the command',
    })
    expect(String(status.error)).toContain('CodexRunnerTurnError')
  })

  it('classifies artifact upload failures after a successful app-server turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-codex-runner-'))
    const runPath = join(dir, 'run.json')
    const statusPath = join(dir, 'status.json')
    await writeFile(runPath, `${JSON.stringify({ implementation: { text: 'upload artifact' } })}\n`, 'utf8')

    const stream = async function* (): AsyncGenerator<StreamDelta, Turn | null, void> {
      yield { type: 'message', delta: 'done' }
      return makeTurn('completed')
    }

    await expect(
      runCodexAppServerAdapter(
        {
          provider: 'codex-runner',
          payloads: { eventFilePath: runPath },
          artifacts: { statusPath },
          providerSpec: {
            outputArtifacts: [{ name: 'codex-artifact', path: '/workspace/artifact.json', key: 'runs/run-1.json' }],
          },
        },
        { prompt: NORMALIZED_PROMPT },
        {
          createClient: () => ({
            runTurnStream: async () => ({
              stream: stream(),
              turnId: 'turn-artifact',
              threadId: 'thread-artifact',
            }),
          }),
          uploadArtifacts: async () => {
            throw new Error('s3 unavailable')
          },
        },
      ),
    ).rejects.toBeInstanceOf(CodexRunnerArtifactError)

    const status = JSON.parse(await readFile(statusPath, 'utf8')) as Record<string, unknown>
    expect(status).toMatchObject({
      exitCode: 1,
      status: 'failed',
      threadId: 'thread-artifact',
      turnId: 'turn-artifact',
      turnStatus: 'completed',
    })
    expect(String(status.error)).toContain('CodexRunnerArtifactError')
    expect(String(status.error)).toContain('s3 unavailable')
  })

  it('marks app-server interrupted final turns as cancelled without sending a second interrupt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-codex-runner-'))
    const runPath = join(dir, 'run.json')
    const statusPath = join(dir, 'status.json')
    await writeFile(runPath, `${JSON.stringify({ implementation: { text: 'server interrupts' } })}\n`, 'utf8')

    const interruptTurn = vi.fn().mockResolvedValue(undefined)
    const stream = async function* (): AsyncGenerator<StreamDelta, Turn | null, void> {
      yield { type: 'message', delta: 'started' }
      return makeTurn('interrupted')
    }

    await expect(
      runCodexAppServerAdapter(
        {
          provider: 'codex-runner',
          payloads: { eventFilePath: runPath },
          artifacts: { statusPath },
        },
        { prompt: NORMALIZED_PROMPT },
        {
          createClient: () => ({
            runTurnStream: async () => ({
              stream: stream(),
              turnId: 'turn-interrupted',
              threadId: 'thread-interrupted',
            }),
            interruptTurn,
          }),
        },
      ),
    ).rejects.toBeInstanceOf(CodexRunnerCancellationError)

    expect(interruptTurn).not.toHaveBeenCalled()
    const status = JSON.parse(await readFile(statusPath, 'utf8')) as Record<string, unknown>
    expect(status).toMatchObject({
      exitCode: 130,
      status: 'cancelled',
      threadId: 'thread-interrupted',
      turnId: 'turn-interrupted',
      turnStatus: 'interrupted',
    })
    expect(String(status.error)).toContain('app-server-interrupted')
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
      { prompt: NORMALIZED_PROMPT },
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
        { prompt: NORMALIZED_PROMPT },
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
