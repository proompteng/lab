import { Context, Effect, Layer } from 'effect'

import type { BunWorkerHandle, CreateWorkerOptions } from '../worker'
import { createWorker } from '../worker'

export interface WorkerRuntimeService {
  readonly handle: BunWorkerHandle
  readonly run: Effect.Effect<void, unknown, never>
  readonly shutdown: Effect.Effect<void, unknown, never>
}

export class WorkerService extends Context.Service<WorkerService, WorkerRuntimeService>()('TemporalWorkerService') {
  static readonly Default = (options?: CreateWorkerOptions) =>
    Layer.effect(
      WorkerService,
      Effect.acquireRelease(
        Effect.promise(() => createWorker(options)),
        (handle) =>
          Effect.promise(async () => {
            await handle.worker.shutdown()
          }),
      ).pipe(
        Effect.map(
          (handle) =>
            ({
              handle,
              run: Effect.promise(() => handle.worker.run()),
              shutdown: Effect.promise(() => handle.worker.shutdown()),
            }) satisfies WorkerRuntimeService,
        ),
      ),
    )

  static readonly handle = Effect.map(WorkerService, (service) => service.handle)
  static readonly run = Effect.flatMap(WorkerService, (service) => service.run)
  static readonly shutdown = Effect.flatMap(WorkerService, (service) => service.shutdown)
}
