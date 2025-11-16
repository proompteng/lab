import { Effect, Layer } from 'effect'

import { resolveTemporalEnvironment } from '../config'
import { deriveWorkerBuildId } from '../worker/defaults'
import { createWorkerRuntimeLayer, resolveWorkerLayerOptions, WorkerRuntimeFailureSignal } from '../worker/layer'
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
    const configLayer = createConfigLayer(withDerivedWorkerBuildId(options.config))
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
  Effect.provide(
    Effect.scoped(
      Effect.gen(function* () {
        const failureSignal = yield* WorkerRuntimeFailureSignal
        return yield* failureSignal
      }),
    ),
    createWorkerAppLayer(options),
  ) as Effect.Effect<never, never, never>

const withDerivedWorkerBuildId = (options?: TemporalConfigLayerOptions): TemporalConfigLayerOptions | undefined => {
  const env = resolveTemporalEnvironment(options?.env)
  const hasEnvBuildId = Boolean(env.TEMPORAL_WORKER_BUILD_ID)
  const hasDefaultBuildId = Boolean(options?.defaults?.workerBuildId)
  const hasOverrideBuildId = Boolean(options?.overrides?.workerBuildId)

  if (hasEnvBuildId || hasDefaultBuildId || hasOverrideBuildId) {
    return options
  }

  const derivedBuildId = deriveWorkerBuildId()
  return {
    ...options,
    defaults: {
      ...options?.defaults,
      workerBuildId: derivedBuildId,
    },
  }
}
