import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
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
  mockReturnValue: (value: unknown) => void
  mockReset: () => void
}

const writeLine = (child: FakeChildProcess, payload: unknown) => {
  child.stdout.write(Buffer.from(`${JSON.stringify(payload)}\n`))
}

type JsonRpcRequest = { id: number; method: string; params?: unknown } & Record<string, unknown>

const nextRequest = (child: FakeChildProcess) =>
  new Promise<JsonRpcRequest>((resolve) => {
    let buffer = ''
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      const line = lines.find((candidate) => candidate.trim().length > 0)
      if (!line) return
      child.stdin.off('data', onData)
      resolve(JSON.parse(line) as JsonRpcRequest)
    }
    child.stdin.on('data', onData)
  })

const respondToInitialize = async (child: FakeChildProcess) => {
  const initReq = await nextRequest(child)
  expect(initReq.method).toBe('initialize')
  writeLine(child, { id: initReq.id, result: {} })
}

const respondToThreadStart = async (child: FakeChildProcess, threadId: string) => {
  const request = await nextRequest(child)
  expect(request.method).toBe('thread/start')
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

const respondToTurnStart = async (child: FakeChildProcess, turnId: string) => {
  const request = await nextRequest(child)
  expect(request.method).toBe('turn/start')
  writeLine(child, {
    id: request.id,
    result: { turn: { id: turnId, status: 'inProgress', items: [], error: null } },
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

describe('CodexAppServerClient v2 notifications', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
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
