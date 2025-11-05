import { Effect } from 'effect'

import type { BunWorkerHandle, CreateWorkerOptions } from '../worker'
import { createWorker } from '../worker'

export interface WorkerRuntimeService {
  readonly handle: BunWorkerHandle
  readonly run: Effect.Effect<void, unknown, never>
  readonly shutdown: Effect.Effect<void, unknown, never>
}

export class WorkerService extends Effect.Service<WorkerRuntimeService>()('TemporalWorkerService', {
  scoped: (options?: CreateWorkerOptions) =>
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
  accessors: true,
}) {}
