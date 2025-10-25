import {
  NativeBridgeError,
  type NativeClient,
  type Runtime as NativeRuntime,
  type NativeWorker,
  native,
} from '../internal/core-bridge/native'

const WORKER_DOC = 'packages/temporal-bun-sdk/docs/worker-runtime.md'
const DEFAULT_NAMESPACE = 'default'
const DEFAULT_IDENTITY_PREFIX = 'temporal-bun-worker'

const shouldUseZigWorkerBridge = (): boolean => process.env.TEMPORAL_BUN_SDK_USE_ZIG === '1'

const _notImplemented = (feature: string): never => {
  throw new Error(`${feature} is not implemented yet. See ${WORKER_DOC} for implementation guidance.`)
}

export interface WorkerRuntimeOptions {
  workflowsPath: string
  activities?: Record<string, (...args: unknown[]) => unknown>
  taskQueue?: string
  namespace?: string
  concurrency?: { workflow?: number; activity?: number }
}

export interface NativeWorkerOptions {
  runtime: NativeRuntime
  client: NativeClient
  namespace?: string
  taskQueue?: string
  identity?: string
}

export const isZigWorkerBridgeEnabled = (): boolean => shouldUseZigWorkerBridge() && native.bridgeVariant === 'zig'

export const maybeCreateNativeWorker = (options: NativeWorkerOptions): NativeWorker | null => {
  if (!shouldUseZigWorkerBridge()) {
    return null
  }

  if (native.bridgeVariant !== 'zig') {
    throw new NativeBridgeError({
      code: 2,
      message: 'TEMPORAL_BUN_SDK_USE_ZIG=1 requires the Zig bridge, but a different native bridge variant was loaded.',
      details: { bridgeVariant: native.bridgeVariant },
    })
  }

  const namespace = (options.namespace ?? DEFAULT_NAMESPACE).trim()
  if (namespace.length === 0) {
    throw new NativeBridgeError({
      code: 3,
      message: 'Worker namespace must be a non-empty string when TEMPORAL_BUN_SDK_USE_ZIG=1',
    })
  }

  const taskQueue = options.taskQueue?.trim()
  if (!taskQueue) {
    throw new NativeBridgeError({
      code: 3,
      message: 'Worker taskQueue is required when TEMPORAL_BUN_SDK_USE_ZIG=1',
    })
  }

  const identity = options.identity?.trim().length
    ? options.identity.trim()
    : `${DEFAULT_IDENTITY_PREFIX}-${process.pid}`

  try {
    return native.createWorker(options.runtime, options.client, {
      namespace,
      taskQueue,
      identity,
    })
  } catch (error) {
    if (error instanceof NativeBridgeError) {
      throw error
    }
    throw new NativeBridgeError(error instanceof Error ? error.message : String(error))
  }
}

export const destroyNativeWorker = (worker: NativeWorker | null | undefined): void => {
  if (!worker) {
    return
  }
  native.destroyWorker(worker)
}

export class WorkerRuntime {
  constructor(readonly options: WorkerRuntimeOptions) {
    void options
    // TODO(codex): Initialize native worker handles and runtime scaffolding per WORKER_DOC §1–§3.
  }

  static async create(options: WorkerRuntimeOptions): Promise<never> {
    // TODO(codex): Build async factory that wires Bun-native worker creation per WORKER_DOC §2.
    void options
    return Promise.reject(new Error('WorkerRuntime.create is not implemented yet')) as never
  }

  async run(): Promise<never> {
    // TODO(codex): Kick off workflow and activity polling loops (WORKER_DOC §3).
    return Promise.reject(new Error('WorkerRuntime.run is not implemented yet')) as never
  }

  async shutdown(_gracefulTimeoutMs?: number): Promise<never> {
    // TODO(codex): Implement graceful shutdown semantics before swapping out the Node worker bridge.
    void _gracefulTimeoutMs
    return Promise.reject(new Error('WorkerRuntime.shutdown is not implemented yet')) as never
  }
}
