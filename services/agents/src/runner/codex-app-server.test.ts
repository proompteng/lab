import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  CodexAppServerBootstrapTimeoutError,
  type CodexAppServerOptions,
  type CodexAppServerTurnOptions,
  type StreamDelta,
  type Turn,
} from '@proompteng/codex'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { extractRunnerStatusFromJobPods } from '../server/agents-controller/runner-status'
import { RUNNER_STATUS_EVENT, RUNNER_TERMINATION_BYTES } from '../runner-status'
import { resolveWorkspaceMirrorPath } from '../workspace-cache'

import {
  CodexRunnerArtifactError,
  CodexRunnerCancellationError,
  CodexRunnerClientError,
  CodexRunnerInputError,
  CodexRunnerTurnError,
  CodexRunnerWorkspaceError,
  DEFAULT_CODEX_BINARY_PATH,
  describeRunnerError,
  readRunnerWorkspaceTmpfsBytes,
  resolveCodexBinaryPath,
  runCodexAppServerAdapter,
  type CodexAppServerRunnerClient,
  type RunCodexAppServerAdapterOptions,
} from './codex-app-server'

it('omits tmpfs usage when the workspace mount is unavailable', async () => {
  expect(await readRunnerWorkspaceTmpfsBytes('/dev/null/not-a-workspace')).toBeUndefined()
})

const makeStream = async function* (): AsyncGenerator<StreamDelta, Turn | null, void> {
  yield { type: 'message', delta: 'done' }
  return null
}

const makeTurn = (status: Turn['status'], error: Turn['error'] = null): Turn => ({
  id: `turn-${status}`,
  rootTurnId: null,
  items: [],
  itemsView: 'full',
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
const runnerEnvKeys = [
  'AGENT_RUN_UID', // Unit tests must not write telemetry to the enclosing AgentRun's object.
  'AGENTS_FAKE_CODEX_APP_SERVER_ARTIFACT',
  'CODEX_AUTH',
  'CODEX_SYSTEM_PROMPT_PATH',
  'CODEX_SYSTEM_PROMPT_EXPECTED_HASH',
  'CODEX_SYSTEM_PROMPT_REQUIRED',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GIT_ASKPASS',
  'GIT_TERMINAL_PROMPT',
  'VCS_TOKEN',
]
const originalRunnerEnv = Object.fromEntries(runnerEnvKeys.map((key) => [key, process.env[key]]))

describe('codex app-server runner adapter', () => {
  beforeEach(() => {
    for (const key of runnerEnvKeys) delete process.env[key]
  })

  afterEach(() => {
    for (const key of runnerEnvKeys) {
      const value = originalRunnerEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it.each([
    { name: 'VCS without a workspace', vcs: { repository: 'example/repo' }, message: 'adapter.codex.cwd is required' },
    {
      name: 'invalid remote',
      vcs: { repository: 'example/repo', cloneBaseUrl: 'https://url-secret@example.test?query' },
      cwd: 'checkout',
      message: 'Invalid VCS clone URL',
    },
    {
      name: 'missing Git auth',
      vcs: { repository: 'example/repo', mode: 'read-write' },
      cwd: 'checkout',
      message: 'Read-write VCS checkout requires Git credentials',
    },
    { name: 'workspace is a file', cwd: 'run.json', message: 'is not a directory' },
  ])('fails $name before starting a client or running Git', async ({ vcs, cwd, message }) => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-preflight-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const runPath = join(dir, 'run.json')
    const statusPath = join(dir, 'status.json')
    const createClient = vi.fn()
    const runCommand = vi.fn()
    await writeFile(runPath, JSON.stringify({ vcs }))
    await expect(
      runCodexAppServerAdapter(
        { provider: 'codex', payloads: { eventFilePath: runPath }, artifacts: { statusPath } },
        { prompt: NORMALIZED_PROMPT, cwd: cwd ? join(dir, cwd) : undefined },
        { createClient, runCommand },
      ),
    ).rejects.toBeInstanceOf(CodexRunnerWorkspaceError)
    expect(createClient).not.toHaveBeenCalled()
    expect(runCommand).not.toHaveBeenCalled()
    const status = await readFile(statusPath, 'utf8')
    expect(JSON.parse(status)).toMatchObject({ status: 'failed', error: expect.stringContaining(message) })
    expect(status).not.toContain('url-secret')
  })

  it('fails with an actionable error for a checkout with no origin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-preflight-origin-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const runPath = join(dir, 'run.json')
    const statusPath = join(dir, 'status.json')
    expect(spawnSync('git', ['init', dir]).status).toBe(0)
    await writeFile(runPath, JSON.stringify({ vcs: { repository: 'example/repo' } }))
    const createClient = vi.fn()
    await expect(
      runCodexAppServerAdapter(
        { provider: 'codex', payloads: { eventFilePath: runPath }, artifacts: { statusPath } },
        { cwd: dir, prompt: NORMALIZED_PROMPT },
        { createClient },
      ),
    ).rejects.toBeInstanceOf(CodexRunnerWorkspaceError)
    expect(createClient).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(statusPath, 'utf8'))).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('the workspace must be a valid checkout with an origin remote'),
    })
  })

  it('does not fall back to base on head fetch auth failures and redacts Git diagnostics', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-preflight-remote-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const runPath = join(dir, 'run.json')
    const statusPath = join(dir, 'status.json')
    const logPath = join(dir, 'runner.log')
    await mkdir(join(dir, '.git'))
    await writeFile(runPath, JSON.stringify({ vcs: { repository: 'example/repo', headBranch: 'feature' } }))
    const controller = new AbortController()
    const createClient = vi.fn()
    const runCommand = vi.fn<NonNullable<RunCodexAppServerAdapterOptions['runCommand']>>(async (_, args) => {
      const denied = args[0] === 'fetch' && args.at(-1)?.includes('feature')
      return {
        exitCode: denied ? 128 : 0,
        stdout: '',
        stderr: denied
          ? '403 https://secret-user:secret-pass@example.test/repo\nAuthorization: Bearer sample-secret'
          : '',
      }
    })
    const failure = await runCodexAppServerAdapter(
      { provider: 'codex', payloads: { eventFilePath: runPath }, artifacts: { statusPath, logPath } },
      { cwd: dir, prompt: NORMALIZED_PROMPT },
      { createClient, runCommand, abortSignal: controller.signal },
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CodexRunnerWorkspaceError)
    expect(createClient).not.toHaveBeenCalled()
    expect(runCommand.mock.calls.map(([, args]) => args[0])).toEqual(['remote', 'fetch', 'fetch'])
    expect(runCommand).toHaveBeenLastCalledWith(
      'git',
      expect.any(Array),
      expect.objectContaining({
        signal: controller.signal,
        timeoutMs: 45_000,
        env: expect.objectContaining({ GIT_TERMINAL_PROMPT: '0' }),
      }),
    )
    for (const output of [
      describeRunnerError(failure),
      await readFile(logPath, 'utf8'),
      await readFile(statusPath, 'utf8'),
    ]) {
      expect(output).toContain('check the remote, branch, and VCS credentials')
      expect(output).toContain('https://[REDACTED]@example.test/repo')
      expect(output).not.toMatch(/secret-user|secret-pass|sample-secret/)
    }
  })

  it('checks executable and mounted Codex auth before app-server spawn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-preflight-codex-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const runPath = join(dir, 'run.json')
    await writeFile(runPath, '{}')
    const spec = { provider: 'codex', payloads: { eventFilePath: runPath } }
    await expect(
      runCodexAppServerAdapter(spec, { binaryPath: join(dir, 'missing'), prompt: NORMALIZED_PROMPT }),
    ).rejects.toMatchObject({
      operation: 'check-executable',
      cause: expect.objectContaining({ message: expect.stringContaining('AGENTS_CODEX_BINARY') }),
    })
    const authPath = join(dir, 'auth.json')
    await writeFile(authPath, 'invalid auth JSON with unprefixed-secret')
    process.env.CODEX_AUTH = authPath
    const failure = await runCodexAppServerAdapter(spec, {
      binaryPath: process.execPath,
      prompt: NORMALIZED_PROMPT,
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CodexRunnerInputError)
    expect(describeRunnerError(failure)).toContain(`mount a readable Codex auth.json at ${authPath}`)
    expect(describeRunnerError(failure)).not.toContain('unprefixed-secret')
  })

  it('retains a completed structured log and telemetry when workspace preparation fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runner-failed-log-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const runPath = join(dir, 'run.json')
    const logPath = join(dir, 'runner.log')
    const statusPath = join(dir, 'status.json')
    await writeFile(
      runPath,
      JSON.stringify({ implementation: { text: 'task' }, parameters: { repository: 'proompteng/lab', base: 'main' } }),
    )
    const uploadArtifacts = vi.fn(async (artifacts) => {
      expect(await readFile(logPath, 'utf8')).toContain('"state":"finished"')
      return artifacts.map((artifact: { name: string; key?: string }) => ({
        ...artifact,
        url: `s3://agents-artifacts/${artifact.key}`,
      }))
    })
    await expect(
      runCodexAppServerAdapter(
        {
          provider: 'codex',
          payloads: { eventFilePath: runPath },
          artifacts: { statusPath, logPath },
          providerSpec: {
            outputArtifacts: [
              { name: 'runner-result', path: join(dir, 'result.json'), key: 'runs/result.json' },
              { name: 'runner-log', path: logPath },
            ],
          },
        },
        { prompt: 'task', cwd: join(dir, 'workspace') },
        {
          runCommand: async () => {
            throw new Error('checkout unavailable')
          },
          uploadArtifacts,
        },
      ),
    ).rejects.toBeInstanceOf(CodexRunnerWorkspaceError)
    expect(uploadArtifacts).toHaveBeenCalledOnce()
    const status = JSON.parse(await readFile(statusPath, 'utf8'))
    expect(status).toMatchObject({
      status: 'failed',
      telemetry: { state: 'finished' },
      artifacts: {
        outputArtifacts: [
          { name: 'runner-result' },
          {
            name: 'runner-log',
            key: 'runs/result.json.events.jsonl',
            url: 's3://agents-artifacts/runs/result.json.events.jsonl',
          },
        ],
      },
    })
    const log = await readFile(logPath, 'utf8')
    expect(log).toContain('checkout unavailable')
    expect(log).toContain('"phase":"git_checkout","outcome":"failed"')
  })

  it('keeps long artifact references and Unicode previews within the termination byte limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runner-status-budget-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const runPath = join(dir, 'run.json')
    await writeFile(runPath, JSON.stringify({ implementation: { text: 'task' } }))
    const statusPath = join(dir, 'status.json')
    const logPath = join(dir, 'runner.log')
    const stdout = vi.spyOn(process.stdout, 'write')
    onTestFinished(() => stdout.mockRestore())
    await runCodexAppServerAdapter(
      {
        provider: 'codex',
        payloads: { eventFilePath: runPath },
        artifacts: { statusPath, logPath },
        providerSpec: {
          outputArtifacts: [
            { name: 'runner-result', path: join(dir, 'result.json'), key: 'r'.repeat(512) },
            { name: 'runner-log', path: logPath },
            { name: 'extra', path: join(dir, 'extra.json'), key: 'e'.repeat(512) },
          ],
        },
      },
      { prompt: 'task' },
      {
        createClient: () => ({
          runTurnStream: async () => ({
            threadId: 'thread',
            turnId: 'turn',
            stream: (async function* () {
              yield { type: 'message' as const, delta: '界'.repeat(256) }
              return makeTurn('completed')
            })(),
          }),
        }),
        uploadArtifacts: async (artifacts) =>
          artifacts.map((artifact) => ({ ...artifact, url: `s3://agents-artifacts/${artifact.key}` })),
      },
    )
    const message = await readFile(statusPath, 'utf8')
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(RUNNER_TERMINATION_BYTES)
    expect(JSON.parse(message)).toHaveProperty('runnerStatusDigest')
    const logs = stdout.mock.calls.map(([line]) => String(line)).join('')
    expect(logs).toContain(RUNNER_STATUS_EVENT)
    const kube = {
      list: vi.fn(async () => ({
        items: [
          {
            metadata: { name: 'pod' },
            status: { containerStatuses: [{ name: 'agent-runner', state: { terminated: { message } } }] },
          },
        ],
      })),
      logs: vi.fn(async () => `${logs}later diagnostic\n`),
    }
    const retained = await extractRunnerStatusFromJobPods(kube, 'agents', 'job')
    expect(retained).toMatchObject({
      status: 'succeeded',
      telemetry: { state: 'finished' },
      result: { text: '界'.repeat(256) },
    })
    expect(retained?.artifacts?.outputArtifacts).toHaveLength(3)
    expect(retained?.artifacts?.outputArtifacts?.[0]?.url).toBe(`s3://agents-artifacts/${'r'.repeat(512)}`)
    expect(kube.logs).toHaveBeenCalledWith(
      expect.objectContaining({ pod: 'pod', namespace: 'agents', container: 'agent-runner', limitBytes: 1_048_576 }),
    )
  })

  it('uses an absolute Codex binary path by default for Bun child-process spawning', () => {
    expect(resolveCodexBinaryPath({}, {})).toBe(DEFAULT_CODEX_BINARY_PATH)
    expect(resolveCodexBinaryPath({}, { AGENTS_CODEX_BINARY: '/custom/agents-codex' })).toBe('/custom/agents-codex')
    expect(resolveCodexBinaryPath({}, { CODEX_BINARY: '/custom/codex' })).toBe('/custom/codex')
    expect(resolveCodexBinaryPath({ binaryPath: '/adapter/codex' }, { AGENTS_CODEX_BINARY: '/env/codex' })).toBe(
      '/adapter/codex',
    )
  })

  describe('app-server bootstrap', () => {
    let runPath: string
    beforeEach(async () => {
      const dir = await mkdtemp(join(tmpdir(), 'agents-codex-bootstrap-'))
      onTestFinished(() => rm(dir, { recursive: true, force: true }))
      runPath = join(dir, 'run.json')
      await writeFile(runPath, '{}')
    })

    const run = (options: RunCodexAppServerAdapterOptions) =>
      runCodexAppServerAdapter(
        { provider: 'codex', payloads: { eventFilePath: runPath } },
        { prompt: NORMALIZED_PROMPT, bootstrapTimeoutMs: 123 },
        options,
      )

    it('stops the timed-out child before creating a replacement and starts exactly one turn', async () => {
      const stopStarted = deferred()
      const shutdown = deferred()
      const runUnreadyTurn = vi.fn()
      const runTurnStream = vi.fn(async () => ({ stream: makeStream(), threadId: 'thread-1', turnId: 'turn-1' }))
      const stopAndWait = vi.fn(async () => {
        stopStarted.resolve()
        await shutdown.promise
      })
      const stop = vi.fn()
      const createClient = vi
        .fn()
        .mockReturnValueOnce({
          ensureReady: async () => {
            throw new CodexAppServerBootstrapTimeoutError(123)
          },
          stopAndWait,
          runTurnStream: runUnreadyTurn,
        })
        .mockReturnValueOnce({ ensureReady: async () => {}, runTurnStream, stop })

      const result = run({ createClient })
      await stopStarted.promise
      expect(createClient).toHaveBeenCalledTimes(1)
      expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ bootstrapTimeoutMs: 123 }))
      shutdown.resolve()

      await expect(result).resolves.toBe(0)
      expect(createClient).toHaveBeenCalledTimes(2)
      expect(stopAndWait).toHaveBeenCalledTimes(1)
      expect(runUnreadyTurn).not.toHaveBeenCalled()
      expect(runTurnStream).toHaveBeenCalledTimes(1)
      expect(stop).toHaveBeenCalledTimes(1)
    })

    it.each([
      { description: 'two initialize timeouts', cause: new CodexAppServerBootstrapTimeoutError(123), attempts: 2 },
      { description: 'a non-timeout initialize failure', cause: new Error('initialize request rejected'), attempts: 1 },
    ])('fails after $description without starting a turn', async ({ cause, attempts }) => {
      const stop = vi.fn()
      const runTurnStream = vi.fn()
      const createClient = vi.fn(() => ({
        ensureReady: async () => {
          throw cause
        },
        runTurnStream,
        stop,
      }))

      await expect(run({ createClient })).rejects.toMatchObject({ operation: 'create-client', cause })
      expect(createClient).toHaveBeenCalledTimes(attempts)
      expect(stop).toHaveBeenCalledTimes(attempts)
      expect(runTurnStream).not.toHaveBeenCalled()
    })

    it('never retries a turn request after successful initialization', async () => {
      const cause = new CodexAppServerBootstrapTimeoutError(123)
      const stop = vi.fn()
      const runTurnStream = vi.fn().mockRejectedValue(cause)
      const createClient = vi.fn(() => ({ ensureReady: async () => {}, runTurnStream, stop }))

      await expect(run({ createClient })).rejects.toMatchObject({ operation: 'start-turn', cause })
      expect(createClient).toHaveBeenCalledTimes(1)
      expect(runTurnStream).toHaveBeenCalledTimes(1)
      expect(stop).toHaveBeenCalledTimes(1)
    })

    it('stops the unready child on cancellation without waiting for the bootstrap deadline', async () => {
      const controller = new AbortController()
      const initializing = deferred()
      const handshake = deferred()
      const stop = vi.fn(() => handshake.reject(new Error('child stopped')))
      const runTurnStream = vi.fn()
      const createClient = vi.fn(() => ({
        ensureReady: () => {
          initializing.resolve()
          return handshake.promise
        },
        runTurnStream,
        stop,
      }))

      const result = run({ createClient, abortSignal: controller.signal })
      await initializing.promise
      controller.abort('SIGTERM')
      await expect(result).rejects.toBeInstanceOf(CodexRunnerCancellationError)
      expect(stop).toHaveBeenCalledTimes(1)
      expect(createClient).toHaveBeenCalledTimes(1)
      expect(runTurnStream).not.toHaveBeenCalled()
    })

    it('honors cancellation during retry backoff without launching a replacement', async () => {
      const controller = new AbortController()
      const stop = vi.fn(() => setImmediate(() => controller.abort('SIGTERM')))
      const runTurnStream = vi.fn()
      const createClient = vi.fn(() => ({
        ensureReady: async () => {
          throw new CodexAppServerBootstrapTimeoutError(123)
        },
        runTurnStream,
        stop,
      }))

      await expect(run({ createClient, abortSignal: controller.signal })).rejects.toBeInstanceOf(
        CodexRunnerCancellationError,
      )
      expect(createClient).toHaveBeenCalledTimes(1)
      expect(stop).toHaveBeenCalledTimes(1)
      expect(runTurnStream).not.toHaveBeenCalled()
    })
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
        createdClients.at(-1)?.onNotification?.({
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'done' },
        })
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
          resultPath: join(dir, 'result.json'),
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
        model: 'gpt-6.2-sol',
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
      defaultModel: 'gpt-6.2-sol',
      defaultEffort: 'high',
      sandbox: 'danger-full-access',
      approval: 'never',
      cwd,
      threadConfig: { web_search: 'live', mcp_servers: {} },
    })
    expect(turnOptions[0]).toMatchObject({
      model: 'gpt-6.2-sol',
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
    expect(status.result).toEqual({ text: 'done', truncated: false })
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
    expect(JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'))).toMatchObject({
      threadId: 'thread-1',
      turnId: 'turn-1',
      responseText: 'done',
      responseTruncated: false,
    })
  })

  it.each(['full', 'notLoaded'] as const)(
    'retains the settled continuation result with %s items',
    async (itemsView) => {
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
          return {
            lastTurn: {
              ...makeTurn('completed'),
              itemsView,
              items:
                itemsView === 'full'
                  ? [
                      {
                        type: 'agentMessage',
                        moderation: null,
                        id: 'final-message',
                        text: 'completed after continuation',
                        phase: 'final_answer',
                        memoryCitation: null,
                        delivery: null,
                        questions: null,
                      },
                    ]
                  : [],
            },
          }
        },
        getTurnItems: async (threadId, turnId) => {
          expect([threadId, turnId]).toEqual(['thread-continuation', 'turn-completed'])
          return [
            {
              type: 'agentMessage',
              moderation: null,
              id: 'final-message',
              text: 'completed after continuation',
              phase: 'final_answer',
              memoryCitation: null,
              delivery: null,
              questions: null,
            },
          ]
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
            resultPath: join(dir, 'result.json'),
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
        turnId: 'turn-completed',
        turnStatus: 'completed',
      })
      expect(JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'))).toMatchObject({
        turnId: 'turn-completed',
        responseText: 'completed after continuation',
        responseTruncated: false,
      })
    },
  )

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
          misalignment: null,
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
        provider: 'codex-smoke',
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
      provider: 'codex-smoke',
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

  it('resolves mirror paths only for safe owner and repository components', () => {
    const root = '/var/cache/agents-shared'
    expect(resolveWorkspaceMirrorPath(root, 'proompteng/lab')).toBe(`${root}/git/proompteng/lab.git`)
    expect(resolveWorkspaceMirrorPath(root, 'some-owner/my_repo.v2')).toBe(`${root}/git/some-owner/my_repo.v2.git`)
    for (const slug of [
      '../lab',
      'proompteng/..',
      './lab',
      'proompteng/.',
      'proompteng/lab/other',
      'proompteng//lab',
      '/lab',
      'owner/%2e%2e',
      'proompteng\\lab',
      'proompteng/lab\n',
    ]) {
      expect(resolveWorkspaceMirrorPath(root, slug)).toBeNull()
    }
  })

  it.each(['missing', 'stale', 'invalid', 'escaped', 'current', 'clone failure'] as const)(
    'checks out VCS-backed runs with a %s shared mirror before starting Codex',
    async (mirrorState) => {
      const dir = await mkdtemp(join(tmpdir(), 'agents-codex-runner-'))
      onTestFinished(() => rm(dir, { recursive: true, force: true }))
      const runPath = join(dir, 'run.json')
      const cwd = join(dir, 'lab')
      const cacheRoot = join(dir, 'shared-cache')
      const mirror = join(cacheRoot, 'git/proompteng/lab.git')
      process.env.GIT_ASKPASS = process.execPath
      const slot = `${mirror}.0`
      if (mirrorState !== 'missing') {
        // A ready stamp does not override a stale snapshot, invalid Git repo, or escaped symlink.
        if (mirrorState === 'escaped') {
          const outside = join(dir, 'outside')
          await mkdir(outside)
          await mkdir(join(cacheRoot, 'git/proompteng'), { recursive: true })
          await symlink(outside, mirror)
        } else {
          await mkdir(slot, { recursive: true })
          await symlink('lab.git.0', mirror)
        }
        const stamp = join(mirror, '.refreshed')
        await writeFile(stamp, '')
        if (mirrorState === 'stale') await utimes(stamp, 0, 0)
      }
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
      const cloneArgs: string[][] = []
      let freshCloneDestination = true
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
          sharedCachePath: cacheRoot,
          runCommand: async (command, args) => {
            commands.push([command, ...args].join(' '))
            if (command === 'git' && args[0] === '--git-dir') {
              return { exitCode: 0, stdout: mirrorState === 'invalid' ? 'false\n' : 'true\n', stderr: '' }
            }
            if (command === 'git' && args[0] === 'clone') {
              cloneArgs.push(args)
              freshCloneDestination &&= !existsSync(join(cwd, '.git'))
              await mkdir(join(cwd, '.git'), { recursive: true })
              if (mirrorState === 'clone failure' && args.includes('--reference')) {
                return { exitCode: 128, stdout: '', stderr: 'missing alternate object' }
              }
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

      expect(freshCloneDestination).toBe(true)
      const normalClone = ['clone', '--filter=blob:none', '--no-checkout', 'https://github.com/proompteng/lab.git', cwd]
      const cachedClone = [
        ...normalClone.slice(0, 3),
        '--depth=1',
        '--branch',
        'main',
        '--reference',
        mirrorState === 'current' || mirrorState === 'clone failure' ? await realpath(slot) : slot,
        '--dissociate',
        ...normalClone.slice(3),
      ]
      expect(cloneArgs).toEqual(
        mirrorState === 'current'
          ? [cachedClone]
          : mirrorState === 'clone failure'
            ? [cachedClone, normalClone]
            : [normalClone],
      )
      expect(commands.filter((command) => command.startsWith('git fetch '))).toEqual(
        mirrorState === 'current'
          ? ['git fetch --prune --depth=1 origin +refs/heads/codex/test:refs/remotes/origin/codex/test']
          : [],
      )
      expect(commands).toContain('git checkout -B codex/test refs/remotes/origin/codex/test')
    },
  )

  it.each([
    { name: 'warm with a stale upstream tip in the mirror', warm: true, head: 'codex/existing', fetches: 1 },
    { name: 'cold with an existing head', warm: false, head: 'codex/existing', fetches: 0 },
    { name: 'cold with a new head', warm: false, head: 'codex/new', fetches: 0 },
    { name: 'cold with only a symbolic origin/HEAD', warm: false, head: 'HEAD', readOnly: true, fetches: 0 },
    { name: 'reused checkout with an updated head', warm: false, head: 'codex/existing', reused: true, fetches: 2 },
    { name: 'reused checkout with a new head', warm: false, head: 'codex/new', reused: true, fetches: 2 },
  ])('uses authoritative Git refs and an independent checkout when $name', async (testCase) => {
    const { warm, head, reused, readOnly, fetches } = testCase
    if (!readOnly) process.env.GIT_ASKPASS = process.execPath
    const dir = await mkdtemp(join(tmpdir(), 'agents-codex-git-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const upstream = join(dir, 'upstream')
    const cwd = join(dir, 'lab')
    const cacheRoot = join(dir, 'shared')
    const mirror = join(cacheRoot, 'git/proompteng/lab.git')
    const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
    const git = (args: string[], path = dir) =>
      spawnSync('git', ['-c', `url.file://${upstream}.insteadOf=https://github.com/proompteng/lab.git`, ...args], {
        cwd: path,
        env,
        encoding: 'utf8',
      })
    const ok = (args: string[], path?: string) => {
      const result = git(args, path)
      expect(result.status, result.stderr).toBe(0)
      return result.stdout.trim()
    }
    ok(['init', '-b', 'main', upstream])
    ok(['config', 'uploadpack.allowFilter', 'true'], upstream)
    const commit = async (value: string) => {
      await writeFile(join(upstream, 'tip.txt'), value)
      ok(['add', 'tip.txt'], upstream)
      ok(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', value], upstream)
      return ok(['rev-parse', 'HEAD'], upstream)
    }
    await writeFile(join(upstream, 'stable.txt'), 'present in the mirror')
    ok(['add', 'stable.txt'], upstream)
    await commit('old base')
    if (warm) {
      await mkdir(join(cacheRoot, 'git/proompteng'), { recursive: true })
      ok(['clone', '--mirror', upstream, `${mirror}.0`])
      await writeFile(join(`${mirror}.0`, '.refreshed'), '')
      await symlink('lab.git.0', mirror)
    }
    if (reused) ok(['clone', `file://${upstream}`, cwd])
    const base = await commit('new base')
    ok(['switch', '-c', 'codex/existing'], upstream)
    const existing = await commit('existing head')

    const runPath = join(dir, 'run.json')
    await writeFile(
      runPath,
      JSON.stringify({ vcs: { repository: 'proompteng/lab', headBranch: head, writeEnabled: !readOnly } }),
    )
    const commands: string[] = []
    expect(
      await runCodexAppServerAdapter(
        { provider: 'codex', payloads: { eventFilePath: runPath } },
        { cwd, prompt: NORMALIZED_PROMPT },
        {
          sharedCachePath: cacheRoot,
          runCommand: async (command, args, options) => {
            expect(command).toBe('git')
            commands.push(args[0])
            const result = git(args, options?.cwd)
            return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
          },
          createClient: () => ({
            runTurnStream: async () => ({ stream: makeStream(), turnId: 'turn-1', threadId: 'thread-1' }),
          }),
        },
      ),
    ).toBe(0)
    await rm(`${mirror}.0`, { recursive: true, force: true })
    expect(existsSync(join(cwd, '.git/objects/info/alternates'))).toBe(false)
    expect(ok(['rev-parse', 'refs/remotes/origin/main'], cwd)).toBe(base)
    expect(ok(['rev-parse', 'HEAD'], cwd)).toBe(head === 'codex/existing' ? existing : base)
    expect(ok(['branch', '--show-current'], cwd)).toBe(readOnly ? '' : head)
    expect(await readFile(join(cwd, 'tip.txt'), 'utf8')).toBe(head === 'codex/existing' ? 'existing head' : 'new base')
    expect(ok(['-c', 'protocol.file.allow=never', 'show', 'HEAD:tip.txt'], cwd)).toBe(
      head === 'codex/existing' ? 'existing head' : 'new base',
    )
    expect(ok(['-c', 'protocol.file.allow=never', 'show', 'HEAD:stable.txt'], cwd)).toBe('present in the mirror')
    expect(commands.filter((command) => command === 'fetch')).toHaveLength(fetches)
  })

  it.each(['hit', 'miss', 'cold', 'timeout', 'already installed'] as const)(
    'bootstraps the memories workspace before turn one on a Bun cache %s',
    async (cacheState) => {
      const dir = await mkdtemp(join(tmpdir(), 'agents-codex-runner-'))
      onTestFinished(() => rm(dir, { recursive: true, force: true }))
      const cwd = join(dir, 'lab')
      const runPath = join(dir, 'run.json')
      const logPath = join(dir, 'runner.log')
      const cacheRoot = join(dir, 'shared')
      const bunCache = join(cacheRoot, 'bun-cache')
      await mkdir(cacheState === 'cold' ? cacheRoot : bunCache, { recursive: true })
      if (cacheState !== 'cold') {
        await mkdir(join(bunCache, 'cached-package'))
        await mkdir(join(bunCache, '.tmp'))
      }
      await writeFile(
        runPath,
        JSON.stringify({ vcs: { repository: 'proompteng/lab', cloneBaseUrl: 'https://github.com' } }),
      )

      const installs: { args: string[]; cacheDir?: string; timeoutMs?: number }[] = []
      let cachedPackageTarget: string | undefined
      let linkedTmpDir = false
      let installsBeforeClient = -1
      await runCodexAppServerAdapter(
        { provider: 'codex-runner', payloads: { eventFilePath: runPath }, artifacts: { logPath } },
        { cwd, prompt: NORMALIZED_PROMPT },
        {
          sharedCachePath: cacheRoot,
          runCommand: async (command, args, options) => {
            if (command === 'git' && args[0] === 'checkout') {
              await mkdir(join(cwd, 'services/memories'), { recursive: true })
              await writeFile(join(cwd, 'bun.lock'), '{}')
              await writeFile(join(cwd, 'services/memories/package.json'), '{"name":"memories"}')
              if (cacheState === 'already installed') await mkdir(join(cwd, 'node_modules'))
            }
            if (command === 'bun') {
              expect(options?.cwd).toBe(cwd)
              const cacheDir = options?.env?.BUN_INSTALL_CACHE_DIR
              if (cacheDir) {
                cachedPackageTarget = await readlink(join(cacheDir, 'cached-package'))
                linkedTmpDir = existsSync(join(cacheDir, '.tmp'))
              }
              installs.push({ args, cacheDir, timeoutMs: options?.timeoutMs })
              const exitCode =
                cacheState === 'timeout' ? 124 : cacheState === 'miss' && args.includes('--offline') ? 1 : 0
              return { exitCode, stdout: '', stderr: '' }
            }
            return { exitCode: 0, stdout: '', stderr: '' }
          },
          createClient: () => {
            installsBeforeClient = installs.length
            return {
              runTurnStream: async () => ({ stream: makeStream(), turnId: 'turn-1', threadId: 'thread-1' }),
            }
          },
        },
      )

      const install = [
        'install',
        '--frozen-lockfile',
        '--production',
        '--omit=peer',
        '--ignore-scripts',
        '--filter',
        'memories',
      ]
      const offline = {
        args: [...install, '--offline', '--backend=copyfile'],
        timeoutMs: 20_000,
        cacheDir: expect.stringContaining('agents-bun-cache-'),
      }
      const local = { args: [...install, '--prefer-offline'], timeoutMs: 30_000 }
      expect(installs).toEqual(
        cacheState === 'already installed'
          ? []
          : cacheState === 'hit'
            ? [offline]
            : cacheState === 'cold'
              ? [local]
              : [offline, local],
      )
      if (cacheState !== 'already installed' && cacheState !== 'cold') {
        expect(cachedPackageTarget).toBe(join(bunCache, 'cached-package'))
        expect(linkedTmpDir).toBe(false)
        expect(existsSync(installs[0]?.cacheDir ?? '')).toBe(false)
      }
      expect(installsBeforeClient).toBe(installs.length)
      const phases = (await readFile(logPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).event)
        .filter((event) => event.type === 'startup_phase')
      const bunOutcome = {
        hit: 'shared',
        miss: 'local',
        cold: 'local',
        timeout: 'failed',
        'already installed': 'skipped',
      }
      expect(phases.map(({ phase, outcome }) => [phase, outcome])).toEqual([
        ['git_checkout', 'origin'],
        ['bun_bootstrap', bunOutcome[cacheState]],
        ['app_server_ready', 'ok'],
        ['first_turn_started', 'ok'],
      ])
      for (const { durationMs, elapsedMs } of phases) {
        expect(durationMs).toBeGreaterThanOrEqual(0)
        expect(elapsedMs).toBeGreaterThanOrEqual(durationMs)
      }
    },
  )

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
        misalignment: null,
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
      yield await new Promise<StreamDelta>(() => undefined)
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
      exitCode: 143,
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
