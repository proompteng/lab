import { EventEmitter } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import type { NativeClient } from './internal/core-bridge/native'

const textEncoder = new TextEncoder()

export interface WorkerBridge {
  createWorker(clientHandle: bigint | number, taskQueue: Uint8Array): Promise<number>
  setConcurrency(workerHandle: number, concurrency: number): Promise<void>
  pollActivity(workerHandle: number): Promise<ActivityTask | null>
  recordHeartbeat(workerHandle: number, token: Uint8Array, details: Uint8Array): Promise<void>
  isCancelled(workerHandle: number, token: Uint8Array): Promise<boolean>
  completeActivity(workerHandle: number, token: Uint8Array, payload: Uint8Array): Promise<void>
  failActivity(workerHandle: number, token: Uint8Array, error: Uint8Array): Promise<void>
  shutdownWorker(workerHandle: number, drainSeconds: number): Promise<void>
}

export interface WorkerOptions {
  taskQueue: string
  concurrency?: number
  bridge?: WorkerBridge
  shutdownSignalDrainSeconds?: number
}

export interface ActivityTask {
  readonly taskToken: Uint8Array
  readonly type: string
  readonly input: unknown
}

export interface ActivityContext {
  readonly taskToken: Uint8Array
  heartbeat(details?: unknown): Promise<void>
  isCancelled(): Promise<boolean>
  throwIfCancelled(): Promise<void>
  scheduleHeartbeat(everyMs: number, detailsProvider?: () => unknown | Promise<unknown>): () => void
}

export type ActivityHandler = (context: ActivityContext, input: unknown) => Promise<unknown>

export class ActivityCancelledError extends Error {
  constructor(message = 'Activity cancelled') {
    super(message)
    this.name = 'ActivityCancelledError'
  }
}

class ActivityContextImpl extends EventEmitter implements ActivityContext {
  private stopped = false
  private readonly timers = new Set<NodeJS.Timeout>()

  constructor(
    readonly taskToken: Uint8Array,
    private readonly bridge: WorkerBridge,
    private readonly workerHandle: number,
  ) {
    super()
  }

  stop() {
    this.stopped = true
    for (const timer of this.timers) {
      clearInterval(timer)
    }
    this.timers.clear()
  }

  async heartbeat(details?: unknown): Promise<void> {
    if (this.stopped) return
    const payload = details === undefined ? new Uint8Array() : textEncoder.encode(JSON.stringify(details))
    await this.bridge.recordHeartbeat(this.workerHandle, this.taskToken, payload)
  }

  async isCancelled(): Promise<boolean> {
    if (this.stopped) return false
    return await this.bridge.isCancelled(this.workerHandle, this.taskToken)
  }

  async throwIfCancelled(): Promise<void> {
    const cancelled = await this.isCancelled()
    if (cancelled) {
      throw new ActivityCancelledError()
    }
  }

  scheduleHeartbeat(everyMs: number, detailsProvider?: () => unknown | Promise<unknown>): () => void {
    if (everyMs <= 0) {
      throw new Error('Heartbeat interval must be positive')
    }

    const timer = setInterval(async () => {
      if (this.stopped) return
      try {
        const details = detailsProvider ? await detailsProvider() : undefined
        await this.heartbeat(details)
        await this.throwIfCancelled()
      } catch (error) {
        this.emit('heartbeatError', error)
      }
    }, everyMs)

    this.timers.add(timer)

    return () => {
      clearInterval(timer)
      this.timers.delete(timer)
    }
  }
}

export class Worker {
  private readonly client: NativeClient
  private readonly taskQueue: string
  private readonly concurrency: number
  private readonly bridge: WorkerBridge
  private workerHandle: number | null = null
  private running = false
  private stopping = false
  private readonly activities = new Map<string, ActivityHandler>()
  private readonly activeTasks = new Set<Promise<void>>()
  private readonly availability: Array<() => void> = []
  private signalHandlersInstalled = false
  private runPromise: Promise<void> | null = null
  private readonly signalHandler: () => void
  private readonly shutdownDrainSeconds: number

  constructor(client: NativeClient, options: WorkerOptions) {
    if (!options?.taskQueue) {
      throw new Error('Worker requires a task queue')
    }

    this.client = client
    this.taskQueue = options.taskQueue
    this.concurrency = Math.max(1, options.concurrency ?? 1)
    this.bridge = options.bridge ?? native.workerBridge
    this.shutdownDrainSeconds = Math.max(0, options.shutdownSignalDrainSeconds ?? 5)
    this.signalHandler = () => {
      void this.shutdown({ drainSeconds: this.shutdownDrainSeconds })
    }
  }

  registerActivity(name: string, handler: ActivityHandler): void {
    if (this.activities.has(name)) {
      throw new Error(`Activity '${name}' is already registered`)
    }
    this.activities.set(name, handler)
  }

  async run(): Promise<void> {
    if (this.running) {
      return this.runPromise ?? Promise.resolve()
    }

    this.running = true
    const handle = await this.bridge.createWorker(this.client.handle, textEncoder.encode(this.taskQueue))
    this.workerHandle = handle
    await this.bridge.setConcurrency(handle, this.concurrency)
    this.installSignalHandlers()

    const loop = async () => {
      while (!this.stopping) {
        if (this.activeTasks.size >= this.concurrency) {
          await this.waitForAvailability()
          continue
        }

        const task = await this.bridge.pollActivity(handle)
        if (!task) {
          await sleep(50)
          continue
        }

        this.dispatch(task)
      }

      await Promise.allSettled(this.activeTasks)
    }

    this.runPromise = loop().finally(() => {
      this.running = false
      this.removeSignalHandlers()
    })
    return this.runPromise
  }

  async shutdown(options: { drainSeconds?: number } = {}): Promise<void> {
    if (this.stopping) {
      return this.runPromise ?? Promise.resolve()
    }

    this.stopping = true
    const drainSeconds = options.drainSeconds ?? this.shutdownDrainSeconds
    if (this.workerHandle) {
      await this.bridge.shutdownWorker(this.workerHandle, drainSeconds)
    }
    const runPromise = this.runPromise ?? Promise.resolve()
    await runPromise
  }

  private dispatch(task: ActivityTask) {
    const handler = this.activities.get(task.type)
    if (!handler) {
      const errorPayload = textEncoder.encode(
        JSON.stringify({
          name: 'ActivityNotRegisteredError',
          message: `Activity '${task.type}' is not registered`,
        }),
      )
      void this.bridge.failActivity(this.workerHandle!, task.taskToken, errorPayload)
      return
    }

    const context = new ActivityContextImpl(task.taskToken, this.bridge, this.workerHandle!)
    const promise = (async () => {
      try {
        const result = await handler(context, task.input)
        const payload = textEncoder.encode(JSON.stringify({ result }))
        await this.bridge.completeActivity(this.workerHandle!, task.taskToken, payload)
      } catch (error) {
        if (error instanceof ActivityCancelledError) {
          const payload = textEncoder.encode(JSON.stringify({ cancelled: true, message: error.message }))
          await this.bridge.failActivity(this.workerHandle!, task.taskToken, payload)
          return
        }

        const payload = textEncoder.encode(
          JSON.stringify({
            cancelled: false,
            name: error instanceof Error ? error.name : 'Error',
            message: error instanceof Error ? error.message : String(error),
          }),
        )
        await this.bridge.failActivity(this.workerHandle!, task.taskToken, payload)
      } finally {
        context.stop()
      }
    })()

    this.activeTasks.add(promise)
    promise
      .finally(() => {
        this.activeTasks.delete(promise)
        this.notifyAvailability()
      })
      .catch(() => {})
  }

  private notifyAvailability() {
    const resolve = this.availability.shift()
    if (resolve) {
      resolve()
    }
  }

  private waitForAvailability(): Promise<void> {
    if (this.activeTasks.size < this.concurrency) {
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      this.availability.push(resolve)
    })
  }

  private installSignalHandlers() {
    if (this.signalHandlersInstalled) return
    process.on('SIGINT', this.signalHandler)
    process.on('SIGTERM', this.signalHandler)
    this.signalHandlersInstalled = true
  }

  private removeSignalHandlers() {
    if (!this.signalHandlersInstalled) return
    process.off('SIGINT', this.signalHandler)
    process.off('SIGTERM', this.signalHandler)
    this.signalHandlersInstalled = false
  }
}

export { withHeartbeat } from './internal/heartbeat'
