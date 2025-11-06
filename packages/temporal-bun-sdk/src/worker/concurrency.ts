import { Effect } from 'effect'

export interface WorkerSchedulerOptions {
  readonly workflowConcurrency: number
  readonly activityConcurrency: number
}

export interface WorkflowTaskEnvelope {
  readonly taskToken: Uint8Array
  readonly execute: () => Effect.Effect<unknown, unknown, never>
}

export interface ActivityTaskEnvelope {
  readonly taskToken: Uint8Array
  readonly handler: (...args: unknown[]) => unknown | Promise<unknown>
  readonly args: unknown[]
}

export interface WorkerScheduler {
  readonly start: Effect.Effect<void, unknown, never>
  readonly stop: Effect.Effect<void, unknown, never>
  readonly enqueueWorkflow: (task: WorkflowTaskEnvelope) => Effect.Effect<void, unknown, never>
  readonly enqueueActivity: (task: ActivityTaskEnvelope) => Effect.Effect<void, unknown, never>
}

export const makeWorkerScheduler = (_options: WorkerSchedulerOptions): Effect.Effect<WorkerScheduler, unknown, never> =>
  Effect.succeed({
    start: Effect.sync(() => {
      /* TODO(TBS-003): Implement scheduler start */
    }),
    stop: Effect.sync(() => {
      /* TODO(TBS-003): Implement scheduler stop */
    }),
    enqueueWorkflow: (task) =>
      Effect.sync(() => {
        /* TODO(TBS-003): Enqueue workflow task */
        void task
      }),
    enqueueActivity: (task) =>
      Effect.sync(() => {
        /* TODO(TBS-003): Enqueue activity task */
        void task
      }),
  })
