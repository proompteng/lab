import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import * as childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CodexAppServerClient } from './app-server-client'

class FakeChildProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()

  kill(): boolean {
    this.emit('exit', null, null)
    return true
  }
}

type SpawnHarness = {
  fake: FakeChildProcess
  sendNotification: (payload: unknown) => void
}

const setupSpawn = ({
  autoRespond = true,
  turnIds = ['turn-a', 'turn-b'],
  threadIds = ['thread-a', 'thread-b'],
}: {
  autoRespond?: boolean
  turnIds?: string[]
  threadIds?: string[]
} = {}): SpawnHarness => {
  const fake = new FakeChildProcess()
  let turnIndex = 0
  let threadIndex = 0
  let buffer = ''

  const respond = (id: number, result: unknown) => {
    fake.stdout.write(`${JSON.stringify({ id, result })}\n`)
  }

  fake.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const msg = JSON.parse(line) as { id: number; method?: string }
      if (!autoRespond) continue

      switch (msg.method) {
        case 'initialize':
          respond(msg.id, { acknowledged: true })
          break
        case 'thread/start':
          respond(msg.id, { thread: { id: threadIds[threadIndex++] ?? `thread-${threadIndex}` } })
          break
        case 'turn/start':
          respond(msg.id, {
            turn: { id: turnIds[turnIndex++] ?? `turn-${turnIndex}`, items: [], status: 'inProgress' },
          })
          break
        default:
          break
      }
    }
  })

  vi.spyOn(childProcess, 'spawn').mockReturnValue(fake as unknown as ChildProcessWithoutNullStreams)

  return {
    fake,
    sendNotification: (payload: unknown) => {
      fake.stdout.write(`${JSON.stringify(payload)}\n`)
    },
  }
}

describe('CodexAppServerClient stream lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('removes turn streams on completion and stream errors', async () => {
    const { fake, sendNotification } = setupSpawn()
    const client = new CodexAppServerClient({ binaryPath: 'codex' })

    await client.ensureReady()
    const { turnId } = await client.runTurnStream('hello')

    expect((client as { turnStreams?: Map<string, unknown> }).turnStreams?.size).toBe(1)

    sendNotification({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed', items: [] } } })
    await Promise.resolve()

    expect((client as { turnStreams?: Map<string, unknown> }).turnStreams?.size).toBe(0)

    const second = await client.runTurnStream('again')
    const next = second.stream.next()
    sendNotification({ method: 'codex/event/stream_error', params: { turnId: second.turnId, message: 'boom' } })

    await expect(next).rejects.toBeTruthy()
    expect((client as { turnStreams?: Map<string, unknown> }).turnStreams?.size).toBe(0)

    fake.kill()
  })

  it('routes notifications by turnId/itemId without leaking across streams', async () => {
    const { fake, sendNotification } = setupSpawn({
      turnIds: ['turn-1', 'turn-2'],
      threadIds: ['thread-1', 'thread-2'],
    })
    const client = new CodexAppServerClient({ binaryPath: 'codex' })

    await client.ensureReady()
    const first = await client.runTurnStream('first')
    const second = await client.runTurnStream('second')

    sendNotification({
      method: 'item/agentMessage/delta',
      params: { turnId: first.turnId, itemId: 'item-1', delta: 'hello' },
    })
    sendNotification({
      method: 'item/agentMessage/delta',
      params: { turnId: second.turnId, itemId: 'item-2', delta: 'world' },
    })

    const firstDelta = await first.stream.next()
    const secondDelta = await second.stream.next()

    expect(firstDelta.value).toMatchObject({ type: 'message', delta: 'hello' })
    expect(secondDelta.value).toMatchObject({ type: 'message', delta: 'world' })

    fake.kill()
  })

  it('rejects readiness when the child exits before initialization', async () => {
    const { fake } = setupSpawn({ autoRespond: false })
    const client = new CodexAppServerClient({ binaryPath: 'codex' })

    fake.emit('exit', 1, null)

    await expect(client.ensureReady()).rejects.toThrow('exited')
  })

  it('rejects readiness on bootstrap timeout', async () => {
    const { fake } = setupSpawn({ autoRespond: false })
    const client = new CodexAppServerClient({ binaryPath: 'codex', bootstrapTimeoutMs: 20 })

    const readyPromise = client.ensureReady()
    readyPromise.catch(() => undefined)

    await new Promise((resolve) => setTimeout(resolve, 30))
    await expect(readyPromise).rejects.toThrow('timed out')

    fake.kill()
  })
})
