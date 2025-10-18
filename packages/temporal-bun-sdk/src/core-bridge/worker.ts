import type { Runtime } from './runtime.ts'
import { Client } from './client.ts'
import { native, type NativeWorker } from '../internal/core-bridge/native.ts'

export interface WorkerOptions {
  readonly namespace: string
  readonly taskQueue: string
  readonly identity?: string
  readonly buildId?: string
  readonly maxCachedWorkflows?: number
  readonly noRemoteActivities?: boolean
}

const finalizeWorker = (worker: NativeWorker): void => {
  try {
    native.workerFree(worker)
  } catch {
    // Ignore errors triggered during GC cleanup.
  }
}

const workerFinalizer = new FinalizationRegistry<NativeWorker>(finalizeWorker)

export class Worker {
  #native: NativeWorker | undefined

  static async create(runtime: Runtime, client: Client, options: WorkerOptions): Promise<Worker> {
    const worker = new Worker(runtime, client, options)
    await worker.#init()
    return worker
  }

  private constructor(
    private readonly runtime: Runtime,
    private readonly client: Client,
    private readonly options: WorkerOptions,
  ) {}

  async #init(): Promise<void> {
    const payload: Record<string, unknown> = {
      namespace: this.options.namespace,
      task_queue: this.options.taskQueue,
    }

    if (this.options.identity) {
      payload.identity = this.options.identity
    }

    if (this.options.buildId) {
      payload.build_id = this.options.buildId
    }

    if (typeof this.options.maxCachedWorkflows === 'number') {
      payload.max_cached_workflows = this.options.maxCachedWorkflows
    }

    if (typeof this.options.noRemoteActivities === 'boolean') {
      payload.no_remote_activities = this.options.noRemoteActivities
    }

    this.#native = native.createWorker(this.runtime.nativeHandle, this.client.nativeHandle, payload)
    workerFinalizer.register(this, this.#native, this)
  }

  get nativeHandle(): NativeWorker {
    if (!this.#native) {
      throw new Error('Worker has already been shut down')
    }
    return this.#native
  }

  async validate(): Promise<void> {
    await native.workerValidate(this.nativeHandle)
  }

  initiateShutdown(): void {
    native.workerInitiateShutdown(this.nativeHandle)
  }

  async shutdown(): Promise<void> {
    if (!this.#native) return
    try {
      await native.workerShutdown(this.#native)
    } finally {
      native.workerFree(this.#native)
      workerFinalizer.unregister(this)
      this.#native = undefined
    }
  }
}

export const createWorker = async (runtime: Runtime, client: Client, options: WorkerOptions): Promise<Worker> => {
  return await Worker.create(runtime, client, options)
}

export const __TEST__ = {
  finalizeWorker,
}
