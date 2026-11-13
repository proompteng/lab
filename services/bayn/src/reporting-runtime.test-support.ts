import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Layer, Stdio, Stream } from 'effect'
import { makeConfiguredTelemetryRuntimeLayer } from './telemetry'
import { reportingLogger, withReportResourceMeasurement } from './reporting-runtime'

const program = withReportResourceMeasurement(
  'native-report-smoke',
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make('{"complete":true}\n'), stdio.stdout())
  }),
).pipe(
  Effect.provide(
    Layer.mergeAll(makeConfiguredTelemetryRuntimeLayer('native-report-smoke'), NodeServices.layer, reportingLogger),
  ),
)

if (import.meta.main) NodeRuntime.runMain(program)
