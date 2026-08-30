import { NodeRuntime } from '@effect/platform-node'
import { Effect, pipe } from 'effect'

import { program } from './entrypoint'
import { makeConfiguredTelemetryRuntimeLayer } from './telemetry'

NodeRuntime.runMain(
  pipe(
    program,
    Effect.annotateLogs({ service: 'bayn' }),
    // @effect-diagnostics-next-line strictEffectProvide:off -- process entry point owns the telemetry layer
    Effect.provide(makeConfiguredTelemetryRuntimeLayer('bayn')),
  ),
)
