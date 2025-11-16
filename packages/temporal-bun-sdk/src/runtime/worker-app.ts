import { Effect, Layer } from 'effect'

import { resolveWorkerActivities, resolveWorkerWorkflowsPath } from '../worker/defaults'
import { createWorkerRuntimeLayer } from '../worker/layer'
import type { WorkerRuntimeOptions } from '../worker/runtime'
import type { TemporalConfigLayerOptions } from './config-layer'
import {
  createConfigLayer,
  createObservabilityLayer,
  createWorkflowServiceLayer,
  type ObservabilityLayerOptions,
  type WorkflowServiceLayerOptions,
} from './effect-layers'

export interface WorkerAppLayerOptions {
  readonly config?: TemporalConfigLayerOptions
  readonly observability?: ObservabilityLayerOptions
  readonly workflow?: WorkflowServiceLayerOptions
  readonly worker?: WorkerRuntimeOptions
}

export const createWorkerAppLayer = (options: WorkerAppLayerOptions = {}) =>
  Layer.suspend(() => {
    const configLayer = createConfigLayer(options.config)
    const observabilityLayer = createObservabilityLayer(options.observability).pipe(Layer.provide(configLayer))
    const workflowLayer = createWorkflowServiceLayer(options.workflow)
      .pipe(Layer.provide(configLayer))
      .pipe(Layer.provide(observabilityLayer))
    const workerLayer = createWorkerRuntimeLayer(resolveWorkerLayerOptions(options.worker))
      .pipe(Layer.provide(configLayer))
      .pipe(Layer.provide(observabilityLayer))
      .pipe(Layer.provide(workflowLayer))

    return Layer.mergeAll(configLayer, observabilityLayer, workflowLayer, workerLayer)
  })

export const WorkerAppLayer = createWorkerAppLayer()

export const runWorkerApp = (options: WorkerAppLayerOptions = {}): Effect.Effect<never, never, never> =>
  Effect.provide(Effect.scoped(Effect.never), createWorkerAppLayer(options)) as Effect.Effect<never, never, never>

const resolveWorkerLayerOptions = (worker?: WorkerRuntimeOptions): WorkerRuntimeOptions => ({
  ...worker,
  activities: worker?.activities ?? resolveWorkerActivities(undefined),
  workflowsPath: worker?.workflowsPath ?? resolveWorkerWorkflowsPath(undefined),
})
