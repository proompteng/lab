import { Layer } from 'effect'

import type { TemporalConfig } from '../../src/config'
import {
  TemporalConfigService,
  createObservabilityLayer,
  createWorkflowServiceLayer,
} from '../../src/runtime/effect-layers'

export const buildTemporalLayer = (config: TemporalConfig) => {
  const configLayer = Layer.succeed(TemporalConfigService, config)
  const observabilityLayer = createObservabilityLayer().pipe(Layer.provide(configLayer))
  const workflowLayer = createWorkflowServiceLayer()
    .pipe(Layer.provide(configLayer))
    .pipe(Layer.provide(observabilityLayer))
  return Layer.mergeAll(configLayer, observabilityLayer, workflowLayer)
}
