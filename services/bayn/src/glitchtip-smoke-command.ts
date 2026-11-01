import * as Sentry from '@sentry/node'
import { NodeRuntime } from '@effect/platform-node'
import { Effect } from 'effect'
import { CycleRunnerError } from './cycle/runner/model'
import { flushErrorTracking, initializeErrorTracking, reportNativeArrivalFailure } from './error-tracking'
import { OperationalError } from './errors'
import { NativeArrivalCaptureError } from './market-data/streaming/native-arrival'
import { observePass } from './observe-composition/decision-builder'
import { currentUtcInstant } from './time'

/** Manual deployment smoke only; not invoked by a trading process. */
const service = process.env['BAYN_ERROR_TRACKING_SERVICE'] || 'bayn-smoke'
if (!initializeErrorTracking(service)) {
  throw new Error('GlitchTip smoke cannot run without a configured DSN')
}
Sentry.setTag('synthetic', 'true')
let captured = false
let nativeArrivalCaptured = service !== 'bayn-execution-controller'
Sentry.addEventProcessor((event) => {
  if (event.tags?.['stage'] === 'bayn.execution.cycle-pass' && event.tags?.['synthetic'] === 'true') captured = true
  if (event.tags?.['stage'] === 'bayn.market-data.native-arrival' && event.tags?.['synthetic'] === 'true')
    nativeArrivalCaptured = true
  return event
})
NodeRuntime.runMain(
  Effect.gen(function* () {
    yield* observePass(() => Effect.void, {
      outcome: 'FAILED',
      observedAt: yield* currentUtcInstant,
      error: new CycleRunnerError({
        operation: 'run-cycle-pass',
        failure: 'operational',
        message: 'GlitchTip synthetic handled cycle pass smoke',
      }),
    })
    if (service === 'bayn-execution-controller')
      yield* reportNativeArrivalFailure(
        new NativeArrivalCaptureError({ message: 'GlitchTip synthetic native arrival failure smoke' }),
      )
    const flushed = yield* Effect.promise(() => flushErrorTracking(5_000))
    if (!captured || !nativeArrivalCaptured || !flushed) {
      return yield* new OperationalError({
        component: 'http',
        operation: 'glitchtip-smoke',
        retryable: false,
        message: 'GlitchTip synthetic integration event was not captured and flushed',
      })
    }
    yield* Effect.logInfo('Synthetic failed cycle pass was captured and flushed; verify the server receipt')
  }),
)
