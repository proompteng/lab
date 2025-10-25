const WORKER_DOC = 'packages/temporal-bun-sdk/docs/worker-runtime.md'

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

export class WorkerRuntime {
  constructor(readonly options: WorkerRuntimeOptions) {
    void options
    // TODO(codex, zig-worker-01): Initialize native worker handles once the Zig worker bridge wires
    // up Temporal core creation semantics (see WORKER_DOC §1–§3).
  }

  static async create(options: WorkerRuntimeOptions): Promise<never> {
    // TODO(codex, zig-worker-01): Build async factory that wires Bun-native worker creation per
    // WORKER_DOC §2 once Zig exports are available.
    void options
    return Promise.reject(new Error('WorkerRuntime.create is not implemented yet')) as never
  }

  async run(): Promise<never> {
    // TODO(codex, zig-worker-03): Kick off workflow and activity polling loops using the Zig worker
    // pending-handle APIs (WORKER_DOC §3).
    return Promise.reject(new Error('WorkerRuntime.run is not implemented yet')) as never
  }

  async shutdown(_gracefulTimeoutMs?: number): Promise<never> {
    // TODO(codex, zig-worker-08): Implement graceful shutdown semantics before swapping out the Node
    // worker bridge.
    void _gracefulTimeoutMs
    return Promise.reject(new Error('WorkerRuntime.shutdown is not implemented yet')) as never
  }
}
