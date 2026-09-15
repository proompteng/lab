import { Effect, Layer } from 'effect'

import { resolveTemporalEnvironment, type TemporalConfig } from '../config'
import { deriveWorkerBuildId } from '../worker/defaults'
import { createWorkerRuntimeLayer, resolveWorkerLayerOptions, WorkerRuntimeFailureSignal } from '../worker/layer'
import type { WorkerRuntimeOptions } from '../worker/runtime'
import type { TemporalConfigLayerOptions } from './config-layer'
import {
  createConfigLayer,
  createObservabilityLayer,
  createWorkflowServiceLayer,
  type ObservabilityLayerOptions,
  TemporalConfigService,
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
    const workerConfig = normalizeWorkerConfig(options.worker?.config)
    const configLayer = workerConfig
      ? Layer.succeed(TemporalConfigService, workerConfig)
      : createConfigLayer(withDerivedWorkerBuildId(options.config))
    const observabilityLayer = createObservabilityLayer(options.observability).pipe(Layer.provide(configLayer))
    const workflowLayer = createWorkflowServiceLayer(options.workflow)
      .pipe(Layer.provide(configLayer))
      .pipe(Layer.provide(observabilityLayer))
    const resolvedWorkerOptions = workerConfig
      ? ({ ...(options.worker ?? {}), config: workerConfig } satisfies WorkerRuntimeOptions)
      : options.worker
    const workerLayer = createWorkerRuntimeLayer(resolveWorkerLayerOptions(resolvedWorkerOptions))
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

const normalizeWorkerConfig = (config?: TemporalConfig): TemporalConfig | undefined => {
  if (!config) {
    return undefined
  }
  if (config.workerBuildId) {
    return config
  }
  return {
    ...config,
    workerBuildId: deriveWorkerBuildId(),
  }
}
