import {
  isZigBridge,
  native,
  type NativeClient,
  type NativeWorker,
  type Runtime as NativeRuntime,
} from '../internal/core-bridge/native'

const WORKER_DOC = 'packages/temporal-bun-sdk/docs/worker-runtime.md'

const notImplemented = (feature: string): never => {
  throw new Error(`${feature} is not implemented yet. See ${WORKER_DOC} for implementation guidance.`)
}

export interface WorkerRuntimeOptions {
  workflowsPath: string
  activities?: Record<string, (...args: unknown[]) => unknown>
  taskQueue?: string
  namespace?: string
  concurrency?: { workflow?: number; activity?: number }
  nativeRuntime?: NativeRuntime
  nativeClient?: NativeClient
}

export class WorkerRuntime {
  #options: WorkerRuntimeOptions
  #worker: NativeWorker | undefined

  private constructor(options: WorkerRuntimeOptions, worker?: NativeWorker) {
    this.#options = options
    this.#worker = worker
  }

  static async create(options: WorkerRuntimeOptions): Promise<WorkerRuntime> {
    if (isZigBridge) {
      const runtimeHandle = options.nativeRuntime
      const clientHandle = options.nativeClient
      if (!runtimeHandle || !clientHandle) {
        throw new Error('WorkerRuntime.create requires native runtime and client handles when using the Zig bridge')
      }

      const workerConfig = {
        namespace: options.namespace,
        taskQueue: options.taskQueue,
      }

      const workerHandle = await native.createWorker(runtimeHandle, clientHandle, workerConfig)
      return new WorkerRuntime(options, workerHandle)
    }

    notImplemented('WorkerRuntime.create')
  }

  async run(): Promise<never> {
    // TODO(codex): Kick off workflow and activity polling loops (WORKER_DOC §3).
    notImplemented('WorkerRuntime.run')
  }

  async shutdown(_gracefulTimeoutMs?: number): Promise<never> {
    if (isZigBridge) {
      if (this.#worker) {
        native.workerShutdown(this.#worker)
        this.#worker = undefined
      }
      return Promise.reject(new Error('WorkerRuntime.run is not implemented yet for the Zig bridge'))
    }

    void _gracefulTimeoutMs
    notImplemented('WorkerRuntime.shutdown')
  }
}
