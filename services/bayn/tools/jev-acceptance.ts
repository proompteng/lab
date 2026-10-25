import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Layer, Logger, Schema, Stdio, Stream } from 'effect'

import {
  evaluateJevAcceptance,
  jevAcceptanceProtocolHash,
  JevAcceptanceError,
  JevNumericalVerdict,
} from '../src/jev/acceptance'

const main = Effect.gen(function* () {
  const args = process.argv.slice(2)
  const stdio = yield* Stdio.Stdio
  const output = (value: unknown) => Stream.run(Stream.make(`${JSON.stringify(value, null, 2)}\n`), stdio.stdout())
  if (args.length === 1 && args[0] === '--protocol')
    return yield* output({ protocolHash: yield* Effect.fromResult(jevAcceptanceProtocolHash()) })
  if (args.length !== 2 || args[0] !== '--input' || args[1] === undefined)
    return yield* new JevAcceptanceError({
      message: 'Usage: bun tools/jev-acceptance.ts --input <summary.json> | --protocol',
    })
  const fs = yield* FileSystem.FileSystem
  const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
    yield* fs.readFileString(args[1]),
  )
  const report = yield* Effect.fromResult(evaluateJevAcceptance(input))
  yield* output(report)
  if (report.verdict !== JevNumericalVerdict.Passed) return yield* new JevAcceptanceError({ message: report.verdict })
})

if (import.meta.main)
  NodeRuntime.runMain(
    main.pipe(
      Effect.tapCause((cause) => Effect.logError(cause)),
      // @effect-diagnostics-next-line strictEffectProvide:off -- offline command owns file and standard-output resources
      Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.withConsoleError(Logger.formatJson)]))),
    ),
    { disableErrorReporting: true },
  )
