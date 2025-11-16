import { Cause, Effect, Exit, Layer } from 'effect'

import type { TemporalConfigLayerOptions } from './config-layer'
import {
  createConfigLayer,
  createObservabilityLayer,
  createWorkflowServiceLayer,
  type ObservabilityLayerOptions,
  type WorkflowServiceLayerOptions,
} from './effect-layers'

export interface TemporalCliLayerOptions {
  readonly config?: TemporalConfigLayerOptions
  readonly observability?: ObservabilityLayerOptions
  readonly workflow?: WorkflowServiceLayerOptions
}

export const createTemporalCliLayer = (options: TemporalCliLayerOptions = {}) =>
  Layer.suspend(() => {
    const configLayer = createConfigLayer(options.config)
    const observabilityLayer = createObservabilityLayer(options.observability).pipe(Layer.provide(configLayer))
    const workflowLayer = createWorkflowServiceLayer(options.workflow)
      .pipe(Layer.provide(configLayer))
      .pipe(Layer.provide(observabilityLayer))
    return Layer.mergeAll(configLayer, observabilityLayer, workflowLayer)
  })

export const TemporalCliLayer = createTemporalCliLayer()

export const runTemporalCliEffect = async <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options?: TemporalCliLayerOptions,
): Promise<A> => {
  const exit = await Effect.runPromiseExit(
    Effect.provide(effect, createTemporalCliLayer(options)) as Effect.Effect<A, E, never>,
  )
  if (Exit.isSuccess(exit)) {
    return exit.value
  }
  throw Cause.squash(exit.cause)
}
