import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Layer, Logger, Schema, Stdio, Stream } from 'effect'

import { sha256 } from '../src/hash'
import { SignalStudyFailure, runSignalStudy } from '../src/intraday-replay/signal-study'
import { validateBacktestSourceReceipt } from '../src/intraday-replay/source'

const main = Effect.gen(function* () {
  const args = process.argv.slice(2)
  const flags = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (key === undefined || value === undefined || flags.has(key))
      return yield* new SignalStudyFailure({ message: 'Study arguments must be unique flag/value pairs' })
    flags.set(key, value)
  }
  const inputPath = flags.get('--input')
  const inputHash = flags.get('--input-sha256')
  const arrivals = flags.get('--arrivals')
  const receiptPath = flags.get('--source-receipt')
  const receiptHash = flags.get('--source-receipt-sha256')
  const outputPath = flags.get('--output')
  if (
    flags.size !== 6 ||
    inputPath === undefined ||
    inputHash === undefined ||
    arrivals === undefined ||
    receiptPath === undefined ||
    receiptHash === undefined ||
    outputPath === undefined
  )
    return yield* new SignalStudyFailure({
      message:
        'Usage: bun tools/jev-signal-study.ts --input <json> --input-sha256 <sha256> --arrivals <ndjson.gz> --source-receipt <json> --source-receipt-sha256 <sha256> --output <new-json>',
    })
  const fs = yield* FileSystem.FileSystem
  const inputText = yield* fs.readFileString(inputPath)
  if (sha256(inputText) !== inputHash) return yield* new SignalStudyFailure({ message: 'Study input hash differs' })
  const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(inputText)
  const receipt = yield* Effect.fromResult(
    validateBacktestSourceReceipt(yield* fs.readFileString(receiptPath), receiptHash),
  )
  const report = yield* runSignalStudy(input, arrivals, receipt)
  yield* fs.writeFileString(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  const stdio = yield* Stdio.Stdio
  yield* Stream.run(
    Stream.make(`${JSON.stringify({ outputPath, reportHash: report.reportHash, summary: report.summary }, null, 2)}\n`),
    stdio.stdout(),
  )
}).pipe(Effect.scoped)

if (import.meta.main)
  NodeRuntime.runMain(
    main.pipe(
      Effect.tapCause((cause) => Effect.logError(cause)),
      // @effect-diagnostics-next-line strictEffectProvide:off -- offline command owns file and standard-output resources
      Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.withConsoleError(Logger.formatJson)]))),
    ),
    { disableErrorReporting: true },
  )
