import { beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { ActivityTask, WorkerBridge } from '../src/worker'
import { Worker } from '../src/worker'
import { slowGreet } from '../examples/worker-mvp/slowGreet.activity'

interface RecordedFailure {
  token: string
  payload: Record<string, unknown>
}

interface RecordedCompletion {
  token: string
  payload: Record<string, unknown>
}

class TestBridge implements WorkerBridge {
  private readonly queue: ActivityTask[]
  private readonly heartbeats = new Map<string, number>()
  private readonly cancelled = new Set<string>()
  private readonly completions: RecordedCompletion[] = []
  private readonly failures: RecordedFailure[] = []
  private readonly waiters: Array<() => void> = []
  private handle = 1

  constructor(tasks: ActivityTask[]) {
    this.queue = [...tasks]
  }

  async createWorker(): Promise<number> {
    return this.handle
  }

  async setConcurrency(): Promise<void> {
    // no-op
  }

  async pollActivity(): Promise<ActivityTask | null> {
    await sleep(10)
    return this.queue.shift() ?? null
  }

  async recordHeartbeat(_workerHandle: number, token: Uint8Array): Promise<void> {
    const key = Buffer.from(token).toString('base64')
    const count = this.heartbeats.get(key) ?? 0
    this.heartbeats.set(key, count + 1)
  }

  async isCancelled(_workerHandle: number, token: Uint8Array): Promise<boolean> {
    const key = Buffer.from(token).toString('base64')
    return this.cancelled.has(key)
  }

  async completeActivity(_workerHandle: number, token: Uint8Array, payload: Uint8Array): Promise<void> {
    const key = Buffer.from(token).toString('base64')
    this.completions.push({ token: key, payload: JSON.parse(Buffer.from(payload).toString('utf8') || '{}') })
    this.notify()
  }

  async failActivity(_workerHandle: number, token: Uint8Array, payload: Uint8Array): Promise<void> {
    const key = Buffer.from(token).toString('base64')
    this.failures.push({ token: key, payload: JSON.parse(Buffer.from(payload).toString('utf8') || '{}') })
    this.notify()
  }

  async shutdownWorker(): Promise<void> {
    // no-op
  }

  cancelToken(token: Uint8Array) {
    const key = Buffer.from(token).toString('base64')
    this.cancelled.add(key)
  }

  async waitForResults(expected: number): Promise<void> {
    while (this.completions.length + this.failures.length < expected) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }

  heartbeatCount(token: Uint8Array): number {
    const key = Buffer.from(token).toString('base64')
    return this.heartbeats.get(key) ?? 0
  }

  getResults() {
    return { completions: this.completions, failures: this.failures }
  }

  private notify() {
    const resolve = this.waiters.shift()
    if (resolve) {
      resolve()
    }
  }
}

describe('Worker MVP', () => {
  let tasks: ActivityTask[]
  let bridge: TestBridge
  let worker: Worker
  let concurrencyTracker = { current: 0, max: 0 }

  beforeEach(() => {
    concurrencyTracker = { current: 0, max: 0 }
    tasks = Array.from({ length: 5 }, (_, index) => ({
      taskToken: Buffer.from(randomUUID(), 'utf8'),
      type: 'slowGreet',
      input: { name: `Task ${index + 1}`, delayMs: 1500 },
    }))
    bridge = new TestBridge(tasks)
    worker = new Worker({ type: 'client', handle: 1 }, { taskQueue: 'worker-mvp-tq', concurrency: 2, bridge })
    worker.registerActivity('slowGreet', async (context, input) => {
      concurrencyTracker.current += 1
      concurrencyTracker.max = Math.max(concurrencyTracker.max, concurrencyTracker.current)
      try {
        return await slowGreet(context, input as { name: string; delayMs?: number })
      } finally {
        concurrencyTracker.current -= 1
      }
    })
  })

  it('processes tasks with bounded concurrency, heartbeats, and cancellation', async () => {
    const cancelToken = tasks[2].taskToken
    const runPromise = worker.run()

    void (async () => {
      await sleep(500)
      bridge.cancelToken(cancelToken)
    })()

    await bridge.waitForResults(tasks.length)
    await worker.shutdown({ drainSeconds: 5 })
    await runPromise

    expect(concurrencyTracker.max).toBeLessThanOrEqual(2)
    expect(bridge.heartbeatCount(tasks[0].taskToken)).toBeGreaterThanOrEqual(2)

    const { completions, failures } = bridge.getResults()
    const cancelled = failures.find((entry) => entry.token === Buffer.from(cancelToken).toString('base64'))
    expect(cancelled).toBeDefined()
    expect(cancelled?.payload.cancelled).toBe(true)

    expect(completions).toHaveLength(tasks.length - 1)
    expect(failures).toHaveLength(1)
  })
})
