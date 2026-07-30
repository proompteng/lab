import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Layer, Logger, Stdio, Stream } from 'effect'

import { loadConfig } from './config'
import { PostgresClientLive } from './db/evidence-store'
import { canonicalJsonV1Result, renderCanonicalJsonFailure } from './hash'
import { runForwardPerformance, ForwardPerformanceProgramError } from './forward-performance'

export { runForwardPerformance } from './forward-performance'

export const FORWARD_PERFORMANCE_COMMAND_USAGE = 'Usage: bayn-forward-performance [--help]'

const printUsage = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  yield* Stream.run(Stream.make(`${FORWARD_PERFORMANCE_COMMAND_USAGE}\n`), stdio.stdout())
})

const runProof = Effect.scoped(
  Effect.gen(function* () {
    const config = yield* loadConfig()
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
)

const runtime = Layer.mergeAll(Logger.layer([Logger.consoleJson]), NodeServices.layer)
const main = process.argv.slice(2).includes('--help') ? printUsage : runProof
const program = main.pipe(Effect.annotateLogs({ service: 'bayn-forward-performance' }), Effect.provide(runtime))

if (import.meta.main) NodeRuntime.runMain(program)
