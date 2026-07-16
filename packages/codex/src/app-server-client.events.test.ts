import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CodexAppServerClient } from './app-server-client'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

class FakeChildProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false

  kill(): boolean {
    this.killed = true
    this.emit('exit', 0, null)
    return true
  }
}

const spawnMock = spawn as unknown as {
  mock: { calls: unknown[][] }
  mockReturnValue: (value: unknown) => void
  mockReset: () => void
}

const writeLine = (child: FakeChildProcess, payload: unknown) => {
  child.stdout.write(Buffer.from(`${JSON.stringify(payload)}\n`))
}

const writeLines = (child: FakeChildProcess, payloads: unknown[]) => {
  child.stdout.write(Buffer.from(`${payloads.map((payload) => JSON.stringify(payload)).join('\n')}\n`))
}

type JsonRpcRequest = { id: number; method: string; params?: unknown } & Record<string, unknown>
type JsonRpcMessage = { id?: number; method?: string; params?: unknown; result?: unknown } & Record<string, unknown>

const nextMessage = (child: FakeChildProcess) =>
  new Promise<JsonRpcMessage>((resolve) => {
    let buffer = ''
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      const line = lines.find((candidate) => candidate.trim().length > 0)
      if (!line) return
      child.stdin.off('data', onData)
      resolve(JSON.parse(line) as JsonRpcMessage)
    }
    child.stdin.on('data', onData)
  })

const nextRequest = async (child: FakeChildProcess) => (await nextMessage(child)) as JsonRpcRequest

const respondToInitialize = async (child: FakeChildProcess, inspect?: (request: JsonRpcRequest) => void) => {
  const initReq = await nextRequest(child)
  expect(initReq.method).toBe('initialize')
  inspect?.(initReq)
  writeLine(child, { id: initReq.id, result: {} })
}

const respondToThreadStart = async (
  child: FakeChildProcess,
  threadId: string,
  inspect?: (request: JsonRpcRequest) => void,
) => {
  const request = await nextRequest(child)
  expect(request.method).toBe('thread/start')
  inspect?.(request)
  writeLine(child, {
    id: request.id,
    result: {
      thread: {
        id: threadId,
        preview: '',
        modelProvider: 'test',
        createdAt: 0,
        path: '',
        turns: [],
      },
    },
  })
}

const respondToThreadResume = async (
  child: FakeChildProcess,
  threadId: string,
  inspect?: (request: JsonRpcRequest) => void,
) => {
  const request = await nextRequest(child)
  expect(request.method).toBe('thread/resume')
  inspect?.(request)
  writeLine(child, {
    id: request.id,
    result: {
      thread: {
        id: threadId,
        preview: '',
        modelProvider: 'test',
        createdAt: 0,
        path: '',
        turns: [],
      },
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      serviceTier: null,
      cwd: '/workspace/lab',
      instructionSources: [],
      approvalPolicy: 'never',
      approvalsReviewer: { type: 'none' },
      sandbox: { type: 'dangerFullAccess' },
      permissionProfile: null,
      activePermissionProfile: null,
      reasoningEffort: 'high',
    },
  })
}

const respondToTurnStart = async (
  child: FakeChildProcess,
  turnId: string,
  inspect?: (request: JsonRpcRequest) => void,
) => {
  const request = await nextRequest(child)
  expect(request.method).toBe('turn/start')
  inspect?.(request)
  writeLine(child, {
    id: request.id,
    result: { turn: { id: turnId, status: 'inProgress', items: [], error: null } },
  })
}

const respondToGoalSet = async (child: FakeChildProcess, inspect?: (request: JsonRpcRequest) => void) => {
  const request = await nextRequest(child)
  expect(request.method).toBe('thread/goal/set')
  inspect?.(request)
  writeLine(child, {
    id: request.id,
    result: {
      goal: {
        threadId: 'thread-1',
        objective: 'ship AgentRun goals',
        status: 'active',
        tokenBudget: 5000,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    },
  })
}

const setupClient = (options: ConstructorParameters<typeof CodexAppServerClient>[0] = {}) => {
  const child = new FakeChildProcess()
  spawnMock.mockReturnValue(child as unknown as ReturnType<typeof spawn>)
  const client = new CodexAppServerClient({ logger: () => {}, ...options })
  return { child, client }
}

const drainStream = async (stream: AsyncGenerator<unknown, unknown, void>) => {
  const deltas: unknown[] = []
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const next = await stream.next()
    if (next.done) break
    deltas.push(next.value)
  }
  return deltas
}

const withTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 500)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

describe('CodexAppServerClient v2 notifications', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opts into experimental app-server APIs during initialize', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child, (request) => {
      expect(request.params).toMatchObject({
        clientInfo: {
          name: 'lab',
          title: 'lab app-server client',
          version: '0.0.0',
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      })
    })
    await client.ensureReady()
    client.stop()
  })

  it('responds to current time requests with whole Unix seconds', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-17T08:30:45.999Z'))
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    writeLine(child, {
      id: 41,
      method: 'currentTime/read',
      params: { threadId: 'thread-1' },
    })

    await expect(nextMessage(child)).resolves.toEqual({
      id: 41,
      result: { currentTimeAt: 1_784_277_045 },
    })
    client.stop()
  })

  it('returns protocol-valid defaults for unattended tool requests', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    writeLine(child, {
      id: 42,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'input-1',
        questions: [],
        autoResolutionMs: null,
      },
    })
    await expect(nextMessage(child)).resolves.toEqual({ id: 42, result: { answers: {} } })

    writeLine(child, {
      id: 43,
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: null,
        tool: 'browser.click',
        arguments: { ref: 'button-1' },
      },
    })
    await expect(nextMessage(child)).resolves.toEqual({
      id: 43,
      result: {
        contentItems: [
          {
            type: 'inputText',
            text: 'Dynamic tool handler is not configured for browser.click',
          },
        ],
        success: false,
      },
    })

    client.stop()
  })

  it('delegates user-input and dynamic tool requests to configured handlers', async () => {
    const onRequestUserInput = vi.fn(async () => ({
      answers: { choice: { answers: ['continue'] } },
    }))
    const onDynamicToolCall = vi.fn(async () => ({
      contentItems: [{ type: 'inputText' as const, text: 'clicked' }],
      success: true,
    }))
    const { child, client } = setupClient({ onRequestUserInput, onDynamicToolCall })
    await respondToInitialize(child)
    await client.ensureReady()

    const inputParams = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'input-1',
      questions: [
        {
          id: 'choice',
          header: 'Action',
          question: 'Continue?',
          isOther: false,
          isSecret: false,
          options: null,
        },
      ],
      autoResolutionMs: null,
    }
    writeLine(child, { id: 44, method: 'item/tool/requestUserInput', params: inputParams })
    await expect(nextMessage(child)).resolves.toEqual({
      id: 44,
      result: { answers: { choice: { answers: ['continue'] } } },
    })
    expect(onRequestUserInput).toHaveBeenCalledWith(inputParams)

    const params = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'call-1',
      namespace: 'browser',
      tool: 'click',
      arguments: { ref: 'button-1' },
    }
    writeLine(child, { id: 45, method: 'item/tool/call', params })

    await expect(nextMessage(child)).resolves.toEqual({
      id: 45,
      result: {
        contentItems: [{ type: 'inputText', text: 'clicked' }],
        success: true,
      },
    })
    expect(onDynamicToolCall).toHaveBeenCalledWith(params)

    client.stop()
  })

  it('declines permission escalation and refreshes ChatGPT tokens from the Codex auth file', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'codex-app-server-auth-'))
    const authPath = path.join(tempDir, 'auth.json')
    await writeFile(
      authPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: 'access-token-1',
          account_id: 'account-1',
        },
      }),
      'utf8',
    )

    const { child, client } = setupClient({ chatgptAuthPath: authPath })
    try {
      await respondToInitialize(child)
      await client.ensureReady()

      writeLine(child, {
        id: 46,
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          environmentId: null,
          startedAtMs: 1_784_277_045_000,
          cwd: '/workspace/lab',
          reason: 'needs network access',
          permissions: { network: { enabled: true }, fileSystem: null },
        },
      })
      await expect(nextMessage(child)).resolves.toEqual({
        id: 46,
        result: {
          permissions: {},
          scope: 'turn',
          strictAutoReview: true,
        },
      })

      writeLine(child, {
        id: 47,
        method: 'account/chatgptAuthTokens/refresh',
        params: { reason: 'unauthorized', previousAccountId: 'account-old' },
      })
      await expect(nextMessage(child)).resolves.toEqual({
        id: 47,
        result: {
          accessToken: 'access-token-1',
          chatgptAccountId: 'account-1',
          chatgptPlanType: null,
        },
      })
    } finally {
      client.stop()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('returns a JSON-RPC error for unsupported server request methods', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    writeLine(child, { id: 48, method: 'future/request', params: {} })

    await expect(nextMessage(child)).resolves.toEqual({
      id: 48,
      error: {
        code: -32_000,
        message: 'Unsupported codex app-server request method: future/request',
      },
    })

    client.stop()
  })

  it('rejects JSON-RPC error objects with their message instead of Object stringification', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello', {
      goal: {
        objective: 'ship AgentRun goals',
      },
    })
    await respondToThreadStart(child, 'thread-1')
    const request = await nextRequest(child)
    expect(request.method).toBe('thread/goal/set')
    writeLine(child, {
      id: request.id,
      error: {
        code: -32600,
        message: 'thread/goal/set requires experimentalApi capability',
      },
    })

    await expect(runPromise).rejects.toThrow('thread/goal/set requires experimentalApi capability (code -32600)')
    client.stop()
  })

  it('resumes existing threads with current runtime config before starting a turn', async () => {
    const { child, client } = setupClient({
      cwd: '/workspace/lab',
      approval: 'never',
      sandbox: 'danger-full-access',
      defaultModel: 'gpt-5.6-sol',
      defaultEffort: 'high',
      threadConfig: { mcp_servers: {}, web_search: 'live' },
      persistExtendedHistory: true,
    })
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello', {
      threadId: 'thread-existing',
      baseInstructions: 'system prompt',
      developerInstructions: 'developer prompt',
    })
    await respondToThreadResume(child, 'thread-existing', (request) => {
      expect(request.params).toMatchObject({
        threadId: 'thread-existing',
        model: 'gpt-5.6-sol',
        cwd: '/workspace/lab',
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        config: { mcp_servers: {}, web_search: 'live' },
        baseInstructions: 'system prompt',
        developerInstructions: 'developer prompt',
        excludeTurns: true,
      })
      expect(request.params).not.toHaveProperty('persistExtendedHistory')
      expect(request.params).not.toHaveProperty('historyMode')
    })
    await respondToTurnStart(child, 'turn-1')
    const { threadId } = await runPromise

    expect(threadId).toBe('thread-existing')
    client.stop()
  })

  it('maps extended history compatibility to paginated history for new threads', async () => {
    const { child, client } = setupClient({ persistExtendedHistory: true })
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1', (request) => {
      expect(request.params).toMatchObject({ historyMode: 'paginated' })
      expect(request.params).not.toHaveProperty('persistExtendedHistory')
    })
    await respondToTurnStart(child, 'turn-1')
    await runPromise
    client.stop()
  })

  it('fails the active stream when error notifications use the canonical turn id from turn/started', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'response-turn-id')
    const { stream } = await runPromise

    writeLine(child, {
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'canonical-turn-id',
          status: 'inProgress',
          items: [],
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      },
    })
    writeLine(child, {
      method: 'error',
      params: {
        error: {
          message: 'Quota exceeded. Check your plan and billing details.',
          codexErrorInfo: 'usageLimitExceeded',
          additionalDetails: null,
        },
        willRetry: false,
        threadId: 'thread-1',
        turnId: 'canonical-turn-id',
      },
    })

    await expect(stream.next()).resolves.toMatchObject({
      value: {
        type: 'error',
        error: {
          error: {
            message: 'Quota exceeded. Check your plan and billing details.',
          },
        },
      },
      done: false,
    })
    await expect(stream.next()).rejects.toThrow('Quota exceeded. Check your plan and billing details.')
    client.stop()
  })

  it('keeps the active stream open when app-server error notifications are retryable', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'response-turn-id')
    const { stream } = await runPromise

    writeLine(child, {
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'canonical-turn-id',
          status: 'inProgress',
          items: [],
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      },
    })
    writeLine(child, {
      method: 'error',
      params: {
        error: {
          message: 'Reconnecting... 2/5',
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
          additionalDetails: 'Stream disconnected before completion.',
        },
        willRetry: true,
        threadId: 'thread-1',
        turnId: 'canonical-turn-id',
      },
    })

    await expect(stream.next()).resolves.toMatchObject({
      value: {
        type: 'error',
        error: {
          error: {
            message: 'Reconnecting... 2/5',
          },
          willRetry: true,
        },
      },
      done: false,
    })

    writeLine(child, {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'canonical-turn-id', status: 'completed', items: [], error: null },
      },
    })

    await expect(withTimeout(stream.next(), 'retryable error stream completion')).resolves.toMatchObject({
      done: true,
      value: { id: 'canonical-turn-id', status: 'completed' },
    })
    client.stop()
  })

  it('omits the CLI approval flag for structured rejection policies', async () => {
    const { child, client } = setupClient({
      approval: {
        granular: {
          sandbox_approval: true,
          rules: false,
          skill_approval: false,
          request_permissions: false,
          mcp_elicitations: false,
        },
      },
    })

    const [binaryPath, args] = spawnMock.mock.calls[0] ?? []
    expect(binaryPath).toBe('codex')
    expect(args).toEqual(['--sandbox', 'danger-full-access', '--model', 'gpt-5.6-sol', 'app-server'])

    await respondToInitialize(child)
    await client.ensureReady()
    client.stop()
  })

  it('applies CLI config overrides before launching the app server', async () => {
    const { child, client } = setupClient({
      cliConfigOverrides: ['mcp_servers={}', 'notify=[]'],
    })

    const [binaryPath, args] = spawnMock.mock.calls[0] ?? []
    expect(binaryPath).toBe('codex')
    expect(args).toEqual([
      '--sandbox',
      'danger-full-access',
      '-c',
      'mcp_servers={}',
      '-c',
      'notify=[]',
      '--ask-for-approval',
      'never',
      '--model',
      'gpt-5.6-sol',
      'app-server',
    ])

    await respondToInitialize(child)
    await client.ensureReady()
    client.stop()
  })

  it('declines MCP elicitation requests with a protocol-valid response', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const responsePromise = nextMessage(child)
    writeLine(child, {
      id: 42,
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-1',
        turnId: null,
        serverName: 'memories',
        mode: 'url',
        message: 'Open the auth page',
        url: 'https://example.com/auth',
        elicitationId: 'elic-1',
      },
    })

    await expect(responsePromise).resolves.toEqual({
      id: 42,
      result: { action: 'decline', content: null },
    })

    client.stop()
  })

  it('emits usage deltas from thread/tokenUsage/updated', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    const tokenUsage = {
      total: { totalTokens: 12, inputTokens: 6, cachedInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 2 },
      last: { totalTokens: 12, inputTokens: 6, cachedInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 2 },
      modelContextWindow: 2048,
    }

    writeLine(child, {
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage,
      },
    })

    const delta = await stream.next()
    expect(delta.value).toEqual({ type: 'usage', usage: tokenUsage })

    writeLine(child, {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null } },
    })
    await drainStream(stream as unknown as AsyncGenerator<unknown, unknown, void>)
  })

  it('does not drop same-chunk turn notifications before runTurnStream returns', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')

    const request = await nextRequest(child)
    expect(request.method).toBe('turn/start')
    writeLines(child, [
      {
        id: request.id,
        result: { turn: { id: 'turn-1', status: 'inProgress', items: [], error: null } },
      },
      {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          delta: 'done',
        },
      },
      {
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null } },
      },
    ])

    const { stream, turnId } = await runPromise
    expect(turnId).toBe('turn-1')
    await expect(withTimeout(stream.next(), 'same-chunk message delta')).resolves.toEqual({
      done: false,
      value: { type: 'message', delta: 'done' },
    })
    await expect(withTimeout(stream.next(), 'same-chunk turn completion')).resolves.toMatchObject({
      done: true,
      value: { id: 'turn-1', status: 'completed' },
    })
    client.stop()
  })

  it('omits summary override from turn/start payload by default', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1', (request) => {
      const params = request.params as Record<string, unknown>
      expect(params).not.toHaveProperty('summary')
    })
    const { stream } = await runPromise

    writeLine(child, {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null } },
    })
    await drainStream(stream as unknown as AsyncGenerator<unknown, unknown, void>)
  })

  it('sets a thread goal before starting a turn when a goal is provided', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello', {
      goal: {
        objective: ' ship AgentRun goals ',
        tokenBudget: 5000,
      },
    })
    await respondToThreadStart(child, 'thread-1')
    await respondToGoalSet(child, (request) => {
      expect(request.params).toEqual({
        threadId: 'thread-1',
        objective: 'ship AgentRun goals',
        status: 'active',
        tokenBudget: 5000,
      })
    })
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    writeLine(child, {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null } },
    })
    await drainStream(stream as unknown as AsyncGenerator<unknown, unknown, void>)
  })

  it('emits command tool deltas from item lifecycle', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    writeLine(child, {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'echo hi',
          cwd: '/tmp',
          processId: null,
          status: 'inProgress',
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      },
    })

    const started = await stream.next()
    expect(started.value).toEqual({
      type: 'tool',
      toolKind: 'command',
      id: 'cmd-1',
      status: 'started',
      title: 'echo hi',
      detail: undefined,
      data: { status: 'inProgress', aggregatedOutput: null, exitCode: null, durationMs: null },
    })

    writeLine(child, {
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-1',
        delta: 'aGkNCg==',
      },
    })

    const output = await stream.next()
    expect(output.value).toEqual({
      type: 'tool',
      toolKind: 'command',
      id: 'cmd-1',
      status: 'delta',
      title: 'command output',
      detail: 'hi\r\n',
    })

    writeLine(child, {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'echo hi',
          cwd: '/tmp',
          processId: null,
          status: 'completed',
          commandActions: [],
          aggregatedOutput: 'aGkNCg==',
          exitCode: 0,
          durationMs: 10,
        },
      },
    })

    const completed = await stream.next()
    expect(completed.value).toEqual({
      type: 'tool',
      toolKind: 'command',
      id: 'cmd-1',
      status: 'completed',
      title: 'echo hi',
      detail: undefined,
      data: { status: 'completed', aggregatedOutput: 'hi\r\n', exitCode: 0, durationMs: 10 },
    })

    writeLine(child, {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null } },
    })
    await drainStream(stream as unknown as AsyncGenerator<unknown, unknown, void>)
  })

  it('drops terminal noise from command output deltas', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    const noise = 'G1s/MjVsDRtbSw3io74=DRtbSw3io70=DRtbSw3io7s=G1s/MjVoDRtbSw=='
    writeLine(child, {
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-1',
        delta: `${noise}14\n`,
      },
    })

    const output = await stream.next()
    expect(output.value).toEqual({
      type: 'tool',
      toolKind: 'command',
      id: 'cmd-1',
      status: 'delta',
      title: 'command output',
      detail: '14\n',
    })

    writeLine(child, {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null } },
    })
    await drainStream(stream as unknown as AsyncGenerator<unknown, unknown, void>)
  })

  it('strips embedded reasoning details from command output deltas', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    writeLine(child, {
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-1',
        delta: 'Installing\n<details type="reasoning" done="true"><summary>Thought</summary>\nWaiting</details>\nDone',
      },
    })

    const output = await stream.next()
    expect(output.value).toEqual({
      type: 'tool',
      toolKind: 'command',
      id: 'cmd-1',
      status: 'delta',
      title: 'command output',
      detail: 'Installing\n\nDone',
    })

    writeLine(child, {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null } },
    })
    await drainStream(stream as unknown as AsyncGenerator<unknown, unknown, void>)
  })

  it('emits mcp tool deltas from item lifecycle', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    writeLine(child, {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'mcpToolCall',
          id: 'mcp-1',
          server: 'memories',
          tool: 'retrieve',
          status: 'inProgress',
          arguments: { query: 'hello' },
          result: null,
          error: null,
          durationMs: null,
        },
      },
    })

    const started = await stream.next()
    expect(started.value).toEqual({
      type: 'tool',
      toolKind: 'mcp',
      id: 'mcp-1',
      status: 'started',
      title: 'memories:retrieve',
      data: { status: 'inProgress', arguments: { query: 'hello' }, result: null, error: null },
    })

    writeLine(child, {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'mcpToolCall',
          id: 'mcp-1',
          server: 'memories',
          tool: 'retrieve',
          status: 'completed',
          arguments: { query: 'hello' },
          result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true } },
          error: null,
          durationMs: 15,
        },
      },
    })

    const completed = await stream.next()
    expect(completed.value).toEqual({
      type: 'tool',
      toolKind: 'mcp',
      id: 'mcp-1',
      status: 'completed',
      title: 'memories:retrieve',
      data: {
        status: 'completed',
        arguments: { query: 'hello' },
        result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true } },
        error: null,
      },
    })

    writeLine(child, {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null } },
    })
    await drainStream(stream as unknown as AsyncGenerator<unknown, unknown, void>)
  })

  it('emits dynamic tool and image generation lifecycle events', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    writeLine(child, {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'dynamicToolCall',
          id: 'dyn-1',
          tool: 'browser.click',
          arguments: { ref: 'button-1' },
          status: 'inProgress',
          contentItems: null,
          success: null,
          durationMs: null,
        },
      },
    })

    const started = await stream.next()
    expect(started.value).toEqual({
      type: 'tool',
      toolKind: 'dynamicTool',
      id: 'dyn-1',
      status: 'started',
      title: 'browser.click',
      data: {
        status: 'inProgress',
        arguments: { ref: 'button-1' },
        contentItems: null,
        success: null,
        durationMs: null,
      },
    })

    writeLine(child, {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'imageGeneration',
          id: 'img-1',
          status: 'completed',
          revisedPrompt: 'astronaut cat',
          result: 'https://example.com/cat.png',
        },
      },
    })

    const completed = await stream.next()
    expect(completed.value).toEqual({
      type: 'tool',
      toolKind: 'imageGeneration',
      id: 'img-1',
      status: 'completed',
      title: 'image generation',
      detail: 'astronaut cat',
      data: {
        status: 'completed',
        revisedPrompt: 'astronaut cat',
        result: 'https://example.com/cat.png',
      },
    })

    writeLine(child, {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null } },
    })
    await drainStream(stream as unknown as AsyncGenerator<unknown, unknown, void>)
  })

  it('emits plan deltas from turn/plan/updated', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    writeLine(child, {
      method: 'turn/plan/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        explanation: 'doing stuff',
        plan: [
          { step: 'a', status: 'pending' },
          { step: 'b', status: 'inProgress' },
          { step: 'c', status: 'completed' },
        ],
      },
    })

    const delta = await stream.next()
    expect(delta.value).toEqual({
      type: 'plan',
      explanation: 'doing stuff',
      plan: [
        { step: 'a', status: 'pending' },
        { step: 'b', status: 'in_progress' },
        { step: 'c', status: 'completed' },
      ],
    })

    writeLine(child, {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null } },
    })
    await drainStream(stream as unknown as AsyncGenerator<unknown, unknown, void>)
  })

  it('skips duplicate agent message deltas', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    writeLine(child, {
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        delta: 'Cool',
      },
    })

    writeLine(child, {
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        delta: 'Cool',
      },
    })

    writeLine(child, {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null } },
    })

    const deltas = await drainStream(stream as unknown as AsyncGenerator<unknown, unknown, void>)
    expect(deltas).toEqual([{ type: 'message', delta: 'Cool' }])
  })

  it('splits embedded reasoning details out of agent message deltas', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    writeLine(child, {
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        delta:
          'Working\n<details type="reasoning" done="true"><summary>Thought</summary>\nInvestigating</details>\nDone',
      },
    })

    writeLine(child, {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null } },
    })

    const deltas = await drainStream(stream as unknown as AsyncGenerator<unknown, unknown, void>)
    expect(deltas).toEqual([
      { type: 'message', delta: 'Working\n' },
      { type: 'reasoning', delta: '\nInvestigating' },
      { type: 'message', delta: '\nDone' },
    ])
  })

  it('splits reasoning details that span multiple agent message deltas', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    writeLine(child, {
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        delta: 'Working\n<details type="reasoning" done="true"><summary>Thought</summary>\nInvest',
      },
    })

    writeLine(child, {
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        delta: 'igating</details>\nDone',
      },
    })

    writeLine(child, {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null } },
    })

    const deltas = await drainStream(stream as unknown as AsyncGenerator<unknown, unknown, void>)
    expect(deltas).toEqual([
      { type: 'message', delta: 'Working\n' },
      { type: 'reasoning', delta: '\nInvest' },
      { type: 'reasoning', delta: 'igating' },
      { type: 'message', delta: '\nDone' },
    ])
  })

  it('emits reasoning deltas from item/reasoning/textDelta', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    writeLine(child, {
      method: 'item/reasoning/textDelta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'reasoning-1',
        delta: 'thinking',
        contentIndex: 0,
      },
    })

    const delta = await stream.next()
    expect(delta.value).toEqual({ type: 'reasoning', delta: 'thinking' })

    writeLine(child, {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null } },
    })
    await drainStream(stream as unknown as AsyncGenerator<unknown, unknown, void>)
  })
})
