import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Layer, Logger, Stdio, Stream } from 'effect'

import { loadConfig } from './config'
import { PostgresClientLive } from './db/evidence-store'
import { canonicalJsonV1Result, renderCanonicalJsonFailure } from './hash'
import { runForwardPerformance, ForwardPerformanceProgramError } from './forward-performance'

export { runForwardPerformance } from './forward-performance'

const main = Effect.scoped(
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
const program = main.pipe(Effect.annotateLogs({ service: 'bayn-forward-performance' }), Effect.provide(runtime))

if (import.meta.main) NodeRuntime.runMain(program)
