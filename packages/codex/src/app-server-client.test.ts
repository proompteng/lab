import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodexAppServerOptions } from './app-server-client'
import { CodexAppServerClient } from './app-server-client'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

class FakeChildProcess extends EventEmitter {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean

  constructor() {
    super()
    this.stdin = new PassThrough()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.killed = false
  }

  emitExit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal)
  }

  kill(): boolean {
    this.killed = true
    this.emitExit()
    return true
  }
}

const spawnMock = spawn as unknown as vi.Mock

type ClientInternals = {
  turnStreams: Map<string, unknown>
  itemTurnMap: Map<string, string>
  pending: Map<unknown, unknown>
}

const getInternals = (client: CodexAppServerClient): ClientInternals => client as unknown as ClientInternals

const writeLine = (child: FakeChildProcess, payload: unknown) => {
  child.stdout.write(Buffer.from(`${JSON.stringify(payload)}\n`))
}

const nextRequest = (child: FakeChildProcess): Promise<Record<string, unknown>> => {
  return new Promise((resolve) => {
    let buffer = ''
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      const line = lines.find((candidate) => candidate.trim().length > 0)
      if (!line) return
      child.stdin.off('data', onData)
      resolve(JSON.parse(line) as Record<string, unknown>)
    }
    child.stdin.on('data', onData)
  })
}

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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const setupClient = (options: CodexAppServerOptions = {}) => {
  const child = new FakeChildProcess()
  spawnMock.mockReturnValue(child as unknown as ChildProcessWithoutNullStreams)
  const client = new CodexAppServerClient({ logger: () => {}, ...options })
  return { child, client }
}

describe('CodexAppServerClient', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears streams on turn completion', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    writeLine(child, { method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed', items: [] } } })

    const completion = await stream.next()
    expect(completion.done).toBe(true)
    const internals = getInternals(client)
    expect(internals.turnStreams.size).toBe(0)
    expect(internals.itemTurnMap.size).toBe(0)
  })

  it('clears streams on stream error and iterator throws', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const runPromise = client.runTurnStream('hello')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream } = await runPromise

    writeLine(child, { method: 'stream_error', params: { turnId: 'turn-1', message: 'boom' } })

    await expect(stream.next()).rejects.toThrow()
    const internals = getInternals(client)
    expect(internals.turnStreams.size).toBe(0)
    expect(internals.itemTurnMap.size).toBe(0)
  })

  it('routes notifications by addressed turn and avoids misrouting', async () => {
    const { child, client } = setupClient()
    await respondToInitialize(child)
    await client.ensureReady()

    const firstRun = client.runTurnStream('one')
    await respondToThreadStart(child, 'thread-1')
    await respondToTurnStart(child, 'turn-1')
    const { stream: streamOne, turnId: turnOne } = await firstRun

    const secondRun = client.runTurnStream('two')
    await respondToThreadStart(child, 'thread-2')
    await respondToTurnStart(child, 'turn-2')
    const { stream: streamTwo, turnId: turnTwo } = await secondRun

    writeLine(child, {
      method: 'item/started',
      params: { turnId: turnOne, item: { type: 'agentMessage', id: 'item-1', text: '' } },
    })
    writeLine(child, {
      method: 'item/started',
      params: { turnId: turnTwo, item: { type: 'agentMessage', id: 'item-2', text: '' } },
    })

    writeLine(child, {
      method: 'item/agentMessage/delta',
      params: { turnId: turnOne, itemId: 'item-1', delta: 'hello' },
    })
    const firstDelta = await streamOne.next()
    expect(firstDelta.value).toEqual({ type: 'message', delta: 'hello' })

    const secondNext = streamTwo.next()
    const raced = await Promise.race([secondNext.then(() => 'misrouted'), delay(20).then(() => 'timeout')])
    expect(raced).toBe('timeout')

    writeLine(child, {
      method: 'item/agentMessage/delta',
      params: { turnId: turnTwo, itemId: 'item-2', delta: 'world' },
    })
    const secondDelta = await secondNext
    expect(secondDelta.value).toEqual({ type: 'message', delta: 'world' })

    writeLine(child, { method: 'turn/completed', params: { turn: { id: turnOne, status: 'completed', items: [] } } })
    await streamOne.next()
    writeLine(child, { method: 'turn/completed', params: { turn: { id: turnTwo, status: 'completed', items: [] } } })
    await streamTwo.next()
  })

  it('rejects readiness when the child exits before initialization', async () => {
    const { child, client } = setupClient()
    const readyPromise = client.ensureReady()

    child.emitExit(1)

    await expect(readyPromise).rejects.toThrow()
    const internals = getInternals(client)
    expect(internals.pending.size).toBe(0)
    expect(internals.turnStreams.size).toBe(0)
  })

  it('rejects readiness on bootstrap timeout', async () => {
    const { client } = setupClient({ bootstrapTimeoutMs: 20 })

    const readyPromise = client.ensureReady()

    await expect(readyPromise).rejects.toThrow()
    const internals = getInternals(client)
    expect(internals.pending.size).toBe(0)
  })
})
