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
}

export class WorkerRuntime {
  constructor(private readonly options: WorkerRuntimeOptions) {
    void options
    // TODO(codex): Initialize native worker handles and runtime scaffolding per WORKER_DOC §1–§3.
  }

  static async create(options: WorkerRuntimeOptions): Promise<WorkerRuntime> {
    // TODO(codex): Build async factory that wires Bun-native worker creation per WORKER_DOC §2.
    void options
    notImplemented('WorkerRuntime.create')
  }

  async run(): Promise<never> {
    // TODO(codex): Kick off workflow and activity polling loops (WORKER_DOC §3).
    notImplemented('WorkerRuntime.run')
  }

  async shutdown(_gracefulTimeoutMs?: number): Promise<never> {
    // TODO(codex): Implement graceful shutdown semantics before swapping out the Node worker bridge.
    void _gracefulTimeoutMs
    notImplemented('WorkerRuntime.shutdown')
  }

  protected static completeActivityTaskNative(workerHandle: number, completion: ActivityCompletionPayload): void {
    if (!isZigBridge) {
      notImplemented('Zig worker activity completion bridge', 'docs/ffi-surface.md')
    }
    native.worker.completeActivityTask(workerHandle, completion)
  }
}
import { type ActivityCompletionPayload, isZigBridge, native } from '../internal/core-bridge/native.ts'
