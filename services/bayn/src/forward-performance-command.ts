import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Layer, Stdio, Stream } from 'effect'

import { loadConfig } from './config'
import { PostgresClientLive } from './db/postgres-client'
import { canonicalJsonV1Result, renderCanonicalJsonFailure } from './hash'
import { runForwardPerformance, ForwardPerformanceProgramError } from './forward-performance'
import { makeConfiguredTelemetryRuntimeLayer, withObservedSpan } from './telemetry'

export { runForwardPerformance } from './forward-performance'

export const FORWARD_PERFORMANCE_COMMAND_USAGE = 'Usage: bayn-forward-performance [--help]'

const printUsage = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  yield* Stream.run(Stream.make(`${FORWARD_PERFORMANCE_COMMAND_USAGE}\n`), stdio.stdout())
})

const runProof = Effect.scoped(
  Effect.gen(function* () {
    const config = yield* loadConfig()
    // @effect-diagnostics-next-line strictEffectProvide:off -- command subprogram owns its scoped PostgreSQL layer
    const receipt = yield* runForwardPerformance(config).pipe(Effect.provide(PostgresClientLive(config)))
    const output = yield* Effect.fromResult(canonicalJsonV1Result(receipt)).pipe(
      Effect.mapError(
        (cause) =>
          new ForwardPerformanceProgramError({
            operation: 'construct-receipt',
            message: `forward-performance output encoding failed: ${renderCanonicalJsonFailure(cause)}`,
            cause,
          }),
      ),
    )
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make(`${output}\n`), stdio.stdout())
  }),
).pipe(withObservedSpan('bayn.forward-performance.prove'))

const runtime = Layer.mergeAll(makeConfiguredTelemetryRuntimeLayer('bayn-forward-performance'), NodeServices.layer)
const main = process.argv.slice(2).includes('--help') ? printUsage : runProof
// @effect-diagnostics-next-line strictEffectProvide:off -- command entry point owns the runtime layer
const program = main.pipe(Effect.annotateLogs({ service: 'bayn-forward-performance' }), Effect.provide(runtime))

if (import.meta.main) NodeRuntime.runMain(program)
