import { NodeRuntime } from '@effect/platform-node'
import { Effect, pipe } from 'effect'

import { loadApplicationPlan } from './application-plan'
import { runApplicationPlan } from './composition'
import { initializeErrorTracking, reportTerminalFailure } from './error-tracking'
import { makeConfiguredTelemetryRuntimeLayer } from './telemetry'

initializeErrorTracking('bayn')
NodeRuntime.runMain(
  pipe(
    loadApplicationPlan,
    Effect.flatMap(runApplicationPlan),
    Effect.scoped,
    Effect.annotateLogs({ service: 'bayn' }),
    // @effect-diagnostics-next-line strictEffectProvide:off -- process entry point owns the telemetry layer
    Effect.provide(makeConfiguredTelemetryRuntimeLayer('bayn')),
    reportTerminalFailure('bayn'),
  ),
)
