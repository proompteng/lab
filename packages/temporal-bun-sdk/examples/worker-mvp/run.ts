import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { WorkerBridge, ActivityTask } from '../../src/worker'
import { Worker } from '../../src/worker'
import { slowGreet } from './slowGreet.activity'

class InMemoryBridge implements WorkerBridge {
  private readonly queue: ActivityTask[]
  private readonly heartbeats = new Map<string, number>()
  private readonly completions: Array<{ token: string; payload: Uint8Array }> = []
  private readonly failures: Array<{ token: string; payload: Uint8Array }> = []
  private readonly completionResolvers: Array<() => void> = []
  private workerHandle = 1

  constructor(tasks: ActivityTask[]) {
    this.queue = [...tasks]
  }

  async createWorker(): Promise<number> {
    return this.workerHandle
  }

  async setConcurrency(): Promise<void> {
    // no-op for in-memory bridge
  }

  async pollActivity(): Promise<ActivityTask | null> {
    await sleep(50)
    return this.queue.shift() ?? null
  }

  async recordHeartbeat(_workerHandle: number, token: Uint8Array): Promise<void> {
    const key = Buffer.from(token).toString('base64')
    const count = this.heartbeats.get(key) ?? 0
    this.heartbeats.set(key, count + 1)
  }

  async isCancelled(): Promise<boolean> {
    return false
  }

  async completeActivity(_workerHandle: number, token: Uint8Array, payload: Uint8Array): Promise<void> {
    this.completions.push({ token: Buffer.from(token).toString('base64'), payload })
    this.notify()
  }

  async failActivity(_workerHandle: number, token: Uint8Array, payload: Uint8Array): Promise<void> {
    this.failures.push({ token: Buffer.from(token).toString('base64'), payload })
    this.notify()
  }

  async shutdownWorker(): Promise<void> {
    // no-op
  }

  async waitForCompletion(expected: number): Promise<void> {
    while (this.completions.length + this.failures.length < expected) {
      await new Promise<void>((resolve) => this.completionResolvers.push(resolve))
    }
  }

  private notify() {
    const resolve = this.completionResolvers.shift()
    if (resolve) {
      resolve()
    }
  }
}

const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? 'worker-mvp-tq'
const concurrency = Number.parseInt(process.env.TEMPORAL_WORKER_CONCURRENCY ?? '2', 10)

const bridge = new InMemoryBridge(
  Array.from({ length: 3 }, () => ({
    taskToken: Buffer.from(randomUUID(), 'utf8'),
    type: 'slowGreet',
    input: { name: 'Temporal', delayMs: 1500 },
  })),
)

const worker = new Worker({ type: 'client', handle: 1 }, { taskQueue, concurrency, bridge })
worker.registerActivity('slowGreet', slowGreet)

async function main() {
  console.log(`Starting worker on task queue '${taskQueue}' with concurrency ${concurrency}`)
  const runPromise = worker.run()
  await bridge.waitForCompletion(3)
  await worker.shutdown({ drainSeconds: 5 })
  await runPromise
  console.log('In-memory tasks complete.')
}

void main().catch((error) => {
  console.error('Worker failed', error)
  process.exitCode = 1
})
