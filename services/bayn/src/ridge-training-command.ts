import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Layer, Logger, Option, Schema, Stdio, Stream } from 'effect'
import { TestClock } from 'effect/testing'

import { sha256 } from './hash'
import { ControlStudyFailure } from './intraday-replay/control-portfolio'
import { RidgeTrainingInputSchema, runRidgeTraining } from './intraday-replay/ridge-training'
import { validateBacktestSourceReceipt } from './intraday-replay/source'
import { Sha256Schema, strictParseOptions } from './schemas'

const usage =
  'Usage: bayn-ridge-training --input <json> --input-sha256 <hash> --arrivals <gzip> --source-receipt <json> --source-receipt-sha256 <hash> --output <new-json> | --help. Offline original-capture fixed-candidate serial execution labels and unqualified fit; no model-provider calls, broker or capital authority.'
const keys = [
  '--input',
  '--input-sha256',
  '--arrivals',
  '--source-receipt',
  '--source-receipt-sha256',
  '--output',
] as const
const boundedText = (path: string, expectedHash: string) =>
  Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(Sha256Schema, strictParseOptions)(expectedHash)
    const fs = yield* FileSystem.FileSystem
    const file = yield* fs.open(path, { flag: 'r' })
    const chunks: Uint8Array[] = []
    let length = 0
    for (;;) {
      const result = yield* file.readAlloc(Math.min(64 * 1024, 512 * 1024 - length + 1))
      if (Option.isNone(result)) break
      length += result.value.byteLength
      if (length > 512 * 1024)
        return yield* new ControlStudyFailure({ message: 'Training input or receipt exceeds 512 KiB' })
      chunks.push(result.value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    if (sha256(bytes) !== expectedHash)
      return yield* new ControlStudyFailure({ message: 'Training input or receipt hash differs' })
    return yield* Effect.try({
      try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      catch: (cause) => new ControlStudyFailure({ message: 'Training input is not valid UTF-8', cause }),
    })
  }).pipe(Effect.scoped)
const print = (text: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make(text), stdio.stdout())
  })

export const runRidgeTrainingCommand = (args: readonly string[]) =>
  Effect.gen(function* () {
    if (args.length === 1 && args[0] === '--help') return yield* print(usage + '\n')
    const flags = new Map<string, string>()
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index],
        value = args[index + 1]
      if (
        key === undefined ||
        value === undefined ||
        value.trim() === '' ||
        !keys.some((allowed) => key === allowed) ||
        flags.has(key)
      )
        return yield* new ControlStudyFailure({ message: usage })
      flags.set(key, value)
    }
    const [inputPath, inputHash, arrivals, receiptPath, receiptHash, outputPath] = keys.map((key) => flags.get(key))
    if (
      flags.size !== keys.length ||
      inputPath === undefined ||
      inputHash === undefined ||
      arrivals === undefined ||
      receiptPath === undefined ||
      receiptHash === undefined ||
      outputPath === undefined
    )
      return yield* new ControlStudyFailure({ message: usage })
    const fs = yield* FileSystem.FileSystem
    if (yield* fs.exists(outputPath))
      return yield* new ControlStudyFailure({ message: 'Training report already exists; refusing to overwrite it' })
    const input = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(RidgeTrainingInputSchema),
      strictParseOptions,
    )(yield* boundedText(inputPath, inputHash))
    const receipt = yield* Effect.fromResult(
      validateBacktestSourceReceipt(yield* boundedText(receiptPath, receiptHash), receiptHash),
    )
    const report = yield* runRidgeTraining(input, arrivals, receipt).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- offline training owns its simulated execution clock
      Effect.provide(TestClock.layer()),
    )
    yield* fs.writeFileString(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
    yield* print(
      JSON.stringify({
        outputPath,
        reportHash: report.reportHash,
        status: report.status,
        trainingRows: report.rows.length,
        artifactHash: report.artifact?.artifactHash ?? null,
      }) + '\n',
    )
    if (report.artifact === null)
      return yield* new ControlStudyFailure({
        message:
          'Training did not produce an artifact; retained diagnostic reports failures, missing outcomes or no labels',
      })
  })

if (import.meta.main)
  NodeRuntime.runMain(
    runRidgeTrainingCommand(process.argv.slice(2)).pipe(
      Effect.tapCause((cause) => Effect.logError(cause)),
      // @effect-diagnostics-next-line strictEffectProvide:off -- command owns local files and standard output
      Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.withConsoleError(Logger.formatJson)]))),
    ),
    { disableErrorReporting: true },
  )
