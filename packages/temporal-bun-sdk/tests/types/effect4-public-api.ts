import { Effect, type Layer } from 'effect'

import { createConfigLayer, TemporalConfigService } from '../../src/runtime/effect-layers'
import type { TemporalConfig, TemporalConfigError, TemporalTlsConfigurationError } from '../../src/config'

const layer: Layer.Layer<TemporalConfigService, TemporalConfigError | TemporalTlsConfigurationError> =
  createConfigLayer({ env: { TEMPORAL_NAMESPACE: 'effect4-typecheck' } })
const configured: Effect.Effect<TemporalConfig, TemporalConfigError | TemporalTlsConfigurationError> = Effect.provide(
  TemporalConfigService,
  layer,
)

void configured
