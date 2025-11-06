import { Effect, Queue, Ref, Schedule } from 'effect'

import type { ActivityHandler } from './runtime'
import type { WorkflowDeterminismState } from '../workflow/determinism'

export interface WorkerSchedulerOptions {
  readonly workflowConcurrency: number
  readonly activityConcurrency: number
}

export interface WorkflowTaskEnvelope {
  readonly taskToken: Uint8Array
  readonly execute: () => Effect.Effect<WorkflowDeterminismState, unknown, never>
}

export interface ActivityTaskEnvelope {
  readonly taskToken: Uint8Array
  readonly handler: ActivityHandler
  readonly args: unknown[]
}

export interface WorkerScheduler {
  readonly start: Effect.Effect<void, unknown, never>
  readonly stop: Effect.Effect<void, unknown, never>
  readonly enqueueWorkflow: (task: WorkflowTaskEnvelope) => Effect.Effect<void, unknown, never>
  readonly enqueueActivity: (task: ActivityTaskEnvelope) => Effect.Effect<void, unknown, never>
}

export const makeWorkerScheduler = (options: WorkerSchedulerOptions): Effect.Effect<WorkerScheduler, unknown, never> =>
  Effect.gen(function* () {
    const workflowQueue = yield* Queue.bounded<WorkflowTaskEnvelope>(options.workflowConcurrency * 2)
    const activityQueue = yield* Queue.bounded<ActivityTaskEnvelope>(options.activityConcurrency * 2)
    const running = yield* Ref.make(false)

    const workflowWorker = Queue.take(workflowQueue).pipe(
      Effect.flatMap((task) =>
        task.execute().pipe(
          Effect.tapError((error) =>
            // TODO(TBS-003): Surface workflow execution error metrics and structured logging.
            Effect.sync(() => {
              console.error('[temporal-bun-sdk] workflow execution error', error)
            }),
          ),
          Effect.ignore,
        ),
      ),
      Effect.forever,
    )

    const activityWorker = Queue.take(activityQueue).pipe(
      Effect.flatMap((task) =>
        Effect.promise(async () => await task.handler(...task.args)).pipe(
          Effect.catchAll((error) =>
            // TODO(TBS-002): Connect to activity retry orchestration and heartbeat cancellation.
            Effect.sync(() => {
              console.error('[temporal-bun-sdk] activity execution error', error)
            }),
          ),
          Effect.ignore,
        ),
      ),
      Effect.forever,
    )

    const workflowFibers = yield* Effect.all(
      Array.from({ length: options.workflowConcurrency }, () => Effect.forkDaemon(workflowWorker)),
    )

    const activityFibers = yield* Effect.all(
      Array.from({ length: options.activityConcurrency }, () =>
        Effect.forkDaemon(
          activityWorker.pipe(
            Effect.retry(Schedule.recurs(Infinity)), // TODO(TBS-003): Replace with jittered retry schedule tuned to worker semantics.
          ),
        ),
      ),
    )

    const start = Ref.modify(running, (started) => {
      if (started) {
        return [Effect.unit, started] as const
      }
      return [Effect.unit, true] as const
    }).pipe(Effect.flatten)

    const stop = Ref.modify(running, (started) => {
      if (!started) {
        return [Effect.unit, started] as const
      }
      return [
        Effect.all(
          workflowFibers.concat(activityFibers).map((fiber) =>
            fiber.interrupt().pipe(
              Effect.catchAll(() => Effect.unit),
              Effect.flatMap(() => Effect.unit),
            ),
          ),
        ).pipe(
          Effect.tap(() => Queue.shutdown(workflowQueue)),
          Effect.tap(() => Queue.shutdown(activityQueue)),
        ),
        false,
      ] as const
    }).pipe(Effect.flatten)

    return {
      start,
      stop,
      enqueueWorkflow: (task) => Queue.offer(workflowQueue, task).pipe(Effect.unit),
      enqueueActivity: (task) => Queue.offer(activityQueue, task).pipe(Effect.unit),
    }
  })
