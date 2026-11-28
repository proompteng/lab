import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Layer, Logger, Schema, Stdio, Stream } from 'effect'

import {
  evaluateRetainedJevAcceptance,
  jevAcceptanceProtocolHash,
  JevAcceptanceError,
  JevAcceptanceVersion,
  JevNumericalVerdict,
} from '../src/jev/acceptance'

const main = Effect.gen(function* () {
  const args = process.argv.slice(2)
  const stdio = yield* Stdio.Stdio
  const output = (value: unknown) => Stream.run(Stream.make(`${JSON.stringify(value, null, 2)}\n`), stdio.stdout())
  if (args.length === 1 && args[0] === '--protocol')
    return yield* output({
      scope: 'RETAINED_BOOTSTRAP_RESEARCH_ONLY',
      protocolHash: yield* Effect.fromResult(jevAcceptanceProtocolHash(JevAcceptanceVersion.RetainedV5)),
    })
  if (args.length !== 2 || args[0] !== '--retained-input' || args[1] === undefined)
    return yield* new JevAcceptanceError({
      message: 'Usage: bun tools/jev-acceptance.ts --retained-input <summary.json> | --protocol',
    })
  const fs = yield* FileSystem.FileSystem
  const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
    yield* fs.readFileString(args[1]),
  )
  const report = yield* Effect.fromResult(evaluateRetainedJevAcceptance(input))
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
