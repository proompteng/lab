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
    result: { turn: { id: turnId, status: 'inProgress', items: [] } },
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

describe('CodexAppServerClient codex/event bridging', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('bridges codex/event/token_count into usage deltas', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')

    const { stream } = await runPromise

    writeLine(child, {
      method: 'codex/event/token_count',
      params: {
        id: 'turn-1',
        msg: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 2,
              output_tokens: 3,
              reasoning_output_tokens: 4,
              total_tokens: 17,
            },
            last_token_usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              output_tokens: 2,
              reasoning_output_tokens: 0,
              total_tokens: 3,
            },
            model_context_window: null,
          },
          rate_limits: null,
        },
      },
    })

    const delta = await stream.next()
    expect(delta.value).toEqual({
      type: 'usage',
      usage: {
        total: {
          input_tokens: 10,
          cached_input_tokens: 2,
          output_tokens: 3,
          reasoning_output_tokens: 4,
          total_tokens: 17,
        },
        last: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 2,
          reasoning_output_tokens: 0,
          total_tokens: 3,
        },
        modelContextWindow: null,
      },
    })
  })

  it('bridges codex/event/exec_command_* into tool deltas', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    writeLine(child, {
      method: 'codex/event/exec_command_begin',
      params: {
        id: 'turn-1',
        msg: {
          type: 'exec_command_begin',
          call_id: 'call-1',
          turn_id: 'turn-1',
          command: ['echo', 'hi'],
          cwd: '/tmp',
          parsed_cmd: [],
          source: 'Agent',
        },
      },
    })

    const started = await stream.next()
    expect(started.value).toEqual({
      type: 'tool',
      toolKind: 'command',
      id: 'call-1',
      status: 'started',
      title: 'echo hi',
      detail: '/tmp',
      data: { processId: undefined, source: 'Agent' },
    })

    writeLine(child, {
      method: 'codex/event/exec_command_output_delta',
      params: {
        msg: {
          type: 'exec_command_output_delta',
          call_id: 'call-1',
          stream: 'stdout',
          chunk: 'hello\\n',
        },
      },
    })

    const output = await stream.next()
    expect(output.value).toEqual({
      type: 'tool',
      toolKind: 'command',
      id: 'call-1',
      status: 'delta',
      title: 'command output',
      detail: 'hello\\n',
    })

    writeLine(child, {
      method: 'codex/event/exec_command_end',
      params: {
        msg: {
          type: 'exec_command_end',
          call_id: 'call-1',
          turn_id: 'turn-1',
          command: ['echo', 'hi'],
          cwd: '/tmp',
          parsed_cmd: [],
          source: 'Agent',
          stdout: 'hello\\n',
          stderr: '',
          aggregated_output: 'hello\\n',
          exit_code: 0,
          duration: '10ms',
          formatted_output: 'hello',
        },
      },
    })

    const completed = await stream.next()
    expect(completed.value).toEqual({
      type: 'tool',
      toolKind: 'command',
      id: 'call-1',
      status: 'completed',
      title: 'echo hi',
      data: { aggregatedOutput: 'hello\\n', exitCode: 0, duration: '10ms' },
    })
  })

  it('bridges codex/event/mcp_tool_call_* into tool deltas', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    writeLine(child, {
      method: 'codex/event/mcp_tool_call_begin',
      params: {
        id: 'turn-1',
        msg: {
          type: 'mcp_tool_call_begin',
          call_id: 'mcp-1',
          invocation: {
            server: 'memories',
            tool: 'retrieve',
            arguments: { query: 'hello' },
          },
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
      data: { arguments: { query: 'hello' } },
    })

    writeLine(child, {
      method: 'codex/event/mcp_tool_call_end',
      params: {
        msg: {
          type: 'mcp_tool_call_end',
          call_id: 'mcp-1',
          invocation: {
            server: 'memories',
            tool: 'retrieve',
            arguments: { query: 'hello' },
          },
          duration: '15ms',
          result: {
            Ok: {
              content: [{ type: 'text', text: 'ok' }],
              structuredContent: { ok: true },
            },
          },
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
        arguments: { query: 'hello' },
        result: {
          content: [{ type: 'text', text: 'ok' }],
          structuredContent: { ok: true },
        },
        error: undefined,
      },
    })
  })

  it('decodes base64 exec_command_output_delta chunks', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    writeLine(child, {
      method: 'codex/event/exec_command_begin',
      params: {
        id: 'turn-1',
        msg: {
          type: 'exec_command_begin',
          call_id: 'call-1',
          turn_id: 'turn-1',
          command: ['echo', 'hi'],
          cwd: '/tmp',
          parsed_cmd: [],
          source: 'Agent',
        },
      },
    })

    await stream.next()

    // "hi\\r\\n" as padded base64, matching raw-bytes encoding used by app-server.
    writeLine(child, {
      method: 'codex/event/exec_command_output_delta',
      params: {
        msg: {
          type: 'exec_command_output_delta',
          call_id: 'call-1',
          stream: 'stdout',
          chunk: 'aGkNCg==',
        },
      },
    })

    const output = await stream.next()
    expect(output.value).toEqual({
      type: 'tool',
      toolKind: 'command',
      id: 'call-1',
      status: 'delta',
      title: 'command output',
      detail: 'hi\r\n',
    })
  })

  it('decodes unpadded base64 exec_command_output_delta chunks', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    writeLine(child, {
      method: 'codex/event/exec_command_begin',
      params: {
        id: 'turn-1',
        msg: {
          type: 'exec_command_begin',
          call_id: 'call-1',
          turn_id: 'turn-1',
          command: ['echo', 'hi'],
          cwd: '/tmp',
          parsed_cmd: [],
          source: 'Agent',
        },
      },
    })

    await stream.next()

    // "UPDATED\\r\\n" encoded without padding.
    writeLine(child, {
      method: 'codex/event/exec_command_output_delta',
      params: {
        msg: {
          type: 'exec_command_output_delta',
          call_id: 'call-1',
          stream: 'stdout',
          chunk: 'VVBEQVRFRA0K',
        },
      },
    })

    const output = await stream.next()
    expect(output.value).toEqual({
      type: 'tool',
      toolKind: 'command',
      id: 'call-1',
      status: 'delta',
      title: 'command output',
      detail: 'UPDATED\r\n',
    })
  })

  it('decodes concatenated base64 exec_command_output_delta chunks', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    writeLine(child, {
      method: 'codex/event/exec_command_begin',
      params: {
        id: 'turn-1',
        msg: {
          type: 'exec_command_begin',
          call_id: 'call-1',
          turn_id: 'turn-1',
          command: ['echo', 'hi'],
          cwd: '/tmp',
          parsed_cmd: [],
          source: 'Agent',
        },
      },
    })

    await stream.next()

    // "hi\\r\\nthere\\r\\n" as two padded base64 chunks concatenated without a separator.
    writeLine(child, {
      method: 'codex/event/exec_command_output_delta',
      params: {
        msg: {
          type: 'exec_command_output_delta',
          call_id: 'call-1',
          stream: 'stdout',
          chunk: 'aGkNCg==dGhlcmUNCg==',
        },
      },
    })

    const output = await stream.next()
    expect(output.value).toEqual({
      type: 'tool',
      toolKind: 'command',
      id: 'call-1',
      status: 'delta',
      title: 'command output',
      detail: 'hi\r\nthere\r\n',
    })
  })

  it('decodes concatenated base64 chunks when the last chunk is unpadded', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    writeLine(child, {
      method: 'codex/event/exec_command_begin',
      params: {
        id: 'turn-1',
        msg: {
          type: 'exec_command_begin',
          call_id: 'call-1',
          turn_id: 'turn-1',
          command: ['echo', 'hi'],
          cwd: '/tmp',
          parsed_cmd: [],
          source: 'Agent',
        },
      },
    })

    await stream.next()

    // "hi\\r\\nthere\\r\\n" as a padded base64 chunk concatenated with an unpadded base64 chunk.
    writeLine(child, {
      method: 'codex/event/exec_command_output_delta',
      params: {
        msg: {
          type: 'exec_command_output_delta',
          call_id: 'call-1',
          stream: 'stdout',
          chunk: 'aGkNCg==dGhlcmUNCg',
        },
      },
    })

    const output = await stream.next()
    expect(output.value).toEqual({
      type: 'tool',
      toolKind: 'command',
      id: 'call-1',
      status: 'delta',
      title: 'command output',
      detail: 'hi\r\nthere\r\n',
    })
  })

  it('drops base64-encoded terminal control noise before plain output', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    writeLine(child, {
      method: 'codex/event/exec_command_begin',
      params: {
        id: 'turn-1',
        msg: {
          type: 'exec_command_begin',
          call_id: 'call-1',
          turn_id: 'turn-1',
          command: ['gh', 'pr', 'view'],
          cwd: '/tmp',
          parsed_cmd: [],
          source: 'Agent',
        },
      },
    })

    await stream.next()

    // ANSI cursor/spinner bytes encoded as concatenated base64 fragments, followed by the real output.
    const noise = 'G1s/MjVsDRtbSw3io74=DRtbSw3io70=DRtbSw3io7s=G1s/MjVoDRtbSw=='
    writeLine(child, {
      method: 'codex/event/exec_command_output_delta',
      params: {
        msg: {
          type: 'exec_command_output_delta',
          call_id: 'call-1',
          stream: 'stdout',
          chunk: `${noise}14\n`,
        },
      },
    })

    const output = await stream.next()
    expect(output.value).toEqual({
      type: 'tool',
      toolKind: 'command',
      id: 'call-1',
      status: 'delta',
      title: 'command output',
      detail: '14\n',
    })
  })

  it('drops base64-encoded terminal control noise before JSON output in the same chunk', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    writeLine(child, {
      method: 'codex/event/exec_command_begin',
      params: {
        id: 'turn-1',
        msg: {
          type: 'exec_command_begin',
          call_id: 'call-1',
          turn_id: 'turn-1',
          command: ['gh', 'pr', 'view'],
          cwd: '/tmp',
          parsed_cmd: [],
          source: 'Agent',
        },
      },
    })

    await stream.next()

    const noise = 'G1s/MjVsDRtbSw3io74=DRtbSw3io70=DRtbSw3io7s=G1s/MjVoDRtbSw=='
    const json = '{\n  "checks": []\n}\n'
    writeLine(child, {
      method: 'codex/event/exec_command_output_delta',
      params: {
        msg: {
          type: 'exec_command_output_delta',
          call_id: 'call-1',
          stream: 'stdout',
          chunk: `${noise}${json}`,
        },
      },
    })

    const output = await stream.next()
    expect(output.value).toEqual({
      type: 'tool',
      toolKind: 'command',
      id: 'call-1',
      status: 'delta',
      title: 'command output',
      detail: json,
    })
  })

  it('decodes base64 item/commandExecution/outputDelta deltas', async () => {
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
        itemId: 'item-1',
        delta: 'aGkNCg==',
      },
    })

    const output = await stream.next()
    expect(output.value).toEqual({
      type: 'tool',
      toolKind: 'command',
      id: 'item-1',
      status: 'delta',
      title: 'command output',
      detail: 'hi\r\n',
    })
  })

  it('emits tool deltas from only one source (legacy then v2)', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    writeLine(child, {
      method: 'codex/event/exec_command_begin',
      params: {
        id: 'turn-1',
        msg: {
          type: 'exec_command_begin',
          call_id: 'call-1',
          turn_id: 'turn-1',
          command: ['bash', '-lc', 'echo hi'],
          cwd: '/tmp',
          parsed_cmd: [],
          source: 'Agent',
        },
      },
    })

    // If v2 tool events also arrive for the same turn, they should be suppressed once legacy is selected.
    writeLine(child, {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'commandExecution',
          id: 'item-1',
          status: 'inProgress',
          command: 'bash -lc echo hi',
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      },
    })

    writeLine(child, {
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed', items: [] } },
    })

    const deltas = await drainStream(stream as unknown as AsyncGenerator<unknown, unknown, void>)
    expect(deltas).toEqual([
      {
        type: 'tool',
        toolKind: 'command',
        id: 'call-1',
        status: 'started',
        title: 'bash -lc echo hi',
        detail: '/tmp',
        data: { processId: undefined, source: 'Agent' },
      },
    ])
  })

  it('emits tool deltas from only one source (v2 then legacy)', async () => {
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
          id: 'item-1',
          status: 'inProgress',
          command: 'bash -lc echo hi',
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      },
    })

    // Legacy tool events should be suppressed once v2 is selected.
    writeLine(child, {
      method: 'codex/event/exec_command_begin',
      params: {
        id: 'turn-1',
        msg: {
          type: 'exec_command_begin',
          call_id: 'call-1',
          turn_id: 'turn-1',
          command: ['bash', '-lc', 'echo hi'],
          cwd: '/tmp',
          parsed_cmd: [],
          source: 'Agent',
        },
      },
    })

    writeLine(child, {
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed', items: [] } },
    })

    const deltas = await drainStream(stream as unknown as AsyncGenerator<unknown, unknown, void>)
    expect(deltas).toEqual([
      {
        type: 'tool',
        toolKind: 'command',
        id: 'item-1',
        status: 'started',
        title: 'bash -lc echo hi',
        data: { aggregatedOutput: null, durationMs: null, exitCode: null, status: 'inProgress' },
      },
    ])
  })

  it('does not let turn diffs suppress command tool deltas', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    writeLine(child, {
      method: 'turn/diff/updated',
      params: { turnId: 'turn-1', diff: 'diff --git a/a b/a\nindex 1..2\n--- a/a\n+++ b/a\n@@\n' },
    })

    writeLine(child, {
      method: 'codex/event/exec_command_begin',
      params: {
        id: 'turn-1',
        msg: {
          type: 'exec_command_begin',
          call_id: 'call-1',
          turn_id: 'turn-1',
          command: ['bash', '-lc', 'echo hi'],
          cwd: '/tmp',
          parsed_cmd: [],
          source: 'Agent',
        },
      },
    })

    writeLine(child, {
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed', items: [] } },
    })

    const deltas = await drainStream(stream as unknown as AsyncGenerator<unknown, unknown, void>)
    expect(deltas).toEqual([
      {
        type: 'tool',
        toolKind: 'file',
        id: 'turn-1:diff',
        status: 'delta',
        title: 'turn diff',
        data: { changes: [{ path: 'turn.diff', diff: 'diff --git a/a b/a\nindex 1..2\n--- a/a\n+++ b/a\n@@\n' }] },
      },
      {
        type: 'tool',
        toolKind: 'command',
        id: 'call-1',
        status: 'started',
        title: 'bash -lc echo hi',
        detail: '/tmp',
        data: { processId: undefined, source: 'Agent' },
      },
    ])
  })

  it('emits agent message deltas from only one source (legacy then v2)', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    writeLine(child, {
      method: 'codex/event/agent_message_delta',
      params: {
        id: 'turn-1',
        msg: { delta: 'Cool' },
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
      method: 'codex/event/agent_message_delta',
      params: {
        id: 'turn-1',
        msg: { delta: ' story' },
      },
    })

    const first = await stream.next()
    expect(first.value).toEqual({ type: 'message', delta: 'Cool' })

    const second = await stream.next()
    expect(second.value).toEqual({ type: 'message', delta: ' story' })
  })

  it('skips duplicate agent message deltas even when interleaved with reasoning deltas', async () => {
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
      method: 'codex/event/agent_reasoning_delta',
      params: {
        id: 'turn-1',
        msg: { delta: 'thinking' },
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
      params: { turn: { id: 'turn-1', status: 'completed', items: [] } },
    })

    const deltas = await drainStream(stream as unknown as AsyncGenerator<unknown, unknown, void>)
    expect(deltas).toEqual([
      { type: 'message', delta: 'Cool' },
      { type: 'reasoning', delta: 'thinking' },
    ])
  })

  it('emits agent message deltas from only one source (v2 then legacy)', async () => {
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
      method: 'codex/event/agent_message_delta',
      params: {
        id: 'turn-1',
        msg: { delta: 'Cool' },
      },
    })

    writeLine(child, {
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        delta: ' story',
      },
    })

    const first = await stream.next()
    expect(first.value).toEqual({ type: 'message', delta: 'Cool' })

    const second = await stream.next()
    expect(second.value).toEqual({ type: 'message', delta: ' story' })
  })

  it('bridges codex/event/plan_update into plan deltas', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    writeLine(child, {
      method: 'codex/event/plan_update',
      params: {
        id: 'turn-1',
        msg: {
          type: 'plan_update',
          explanation: null,
          plan: [
            { step: 'first', status: 'completed' },
            { step: 'second', status: 'inProgress' },
            { step: 'third', status: 'pending' },
          ],
        },
      },
    })

    const delta = await stream.next()
    expect(delta.value).toEqual({
      type: 'plan',
      explanation: null,
      plan: [
        { step: 'first', status: 'completed' },
        { step: 'second', status: 'in_progress' },
        { step: 'third', status: 'pending' },
      ],
    })
  })

  it('bridges turn/plan/updated into plan deltas', async () => {
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
  })
})
