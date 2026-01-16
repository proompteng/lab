import { Effect } from 'effect'

import type { Logger } from '../observability/logger'
import type { MetricsRegistry } from '../observability/metrics'
import type { ActivityTaskEnvelope, WorkerSchedulerHooks, WorkflowTaskEnvelope } from './concurrency'

export interface WorkerPluginContext {
  readonly namespace: string
  readonly taskQueue: string
  readonly identity: string
  readonly buildId: string
  readonly deploymentName?: string
  readonly logger: Logger
  readonly metrics: MetricsRegistry
}

export interface WorkerPlugin {
  readonly name: string
  readonly onWorkerStart?: (context: WorkerPluginContext) => Effect.Effect<void, never, never>
  readonly onWorkerStop?: (context: WorkerPluginContext) => Effect.Effect<void, never, never>
  readonly schedulerHooks?: WorkerSchedulerHooks
  readonly onWorkflowTaskStart?: (task: WorkflowTaskEnvelope) => Effect.Effect<void, never, never>
  readonly onWorkflowTaskComplete?: (task: WorkflowTaskEnvelope) => Effect.Effect<void, never, never>
  readonly onActivityTaskStart?: (task: ActivityTaskEnvelope) => Effect.Effect<void, never, never>
  readonly onActivityTaskComplete?: (task: ActivityTaskEnvelope) => Effect.Effect<void, never, never>
}

export const mergeWorkerSchedulerHooks = (plugins: readonly WorkerPlugin[]): WorkerSchedulerHooks | undefined => {
  const hooks = plugins
    .map((plugin) => plugin.schedulerHooks)
    .filter((value): value is WorkerSchedulerHooks => Boolean(value))

  if (hooks.length === 0) {
    return undefined
  }

  return {
    onWorkflowStart: (task) =>
      Effect.forEach(hooks, (hook) => (hook.onWorkflowStart ? hook.onWorkflowStart(task) : Effect.void)).pipe(
        Effect.asVoid,
      ),
    onWorkflowComplete: (task) =>
      Effect.forEach(hooks, (hook) => (hook.onWorkflowComplete ? hook.onWorkflowComplete(task) : Effect.void)).pipe(
        Effect.asVoid,
      ),
    onActivityStart: (task) =>
      Effect.forEach(hooks, (hook) => (hook.onActivityStart ? hook.onActivityStart(task) : Effect.void)).pipe(
        Effect.asVoid,
      ),
    onActivityComplete: (task) =>
      Effect.forEach(hooks, (hook) => (hook.onActivityComplete ? hook.onActivityComplete(task) : Effect.void)).pipe(
        Effect.asVoid,
      ),
  }
}

export const mergeWorkerPluginHooks = (plugins: readonly WorkerPlugin[]): WorkerPlugin[] =>
  plugins.map((plugin) => ({
    ...plugin,
    schedulerHooks: plugin.schedulerHooks ?? {
      onWorkflowStart: plugin.onWorkflowTaskStart,
      onWorkflowComplete: plugin.onWorkflowTaskComplete,
      onActivityStart: plugin.onActivityTaskStart,
      onActivityComplete: plugin.onActivityTaskComplete,
    },
  }))
