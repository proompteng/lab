import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Layer, Logger, Option, Schema, Stdio, Stream } from 'effect'

import { sha256 } from './hash'
import { GapRecoveryFailure } from './intraday-replay/gap-recovery'
import { GapRecoveryStudyInputSchema, runGapRecoveryStudy } from './intraday-replay/gap-recovery-study'
import { validateBacktestSourceReceipt } from './intraday-replay/source'
import { Sha256Schema, strictParseOptions } from './schemas'

const usage =
  'Usage: bayn-gap-recovery --input <json> --input-sha256 <hash> --previous-arrivals <gzip> --previous-receipt <json> --previous-receipt-sha256 <hash> --current-arrivals <gzip> --current-receipt <json> --current-receipt-sha256 <hash> --output <new-json> | --help. Offline original-receipt decision replay only; no broker, model, or capital authority.'
const keys = [
  '--input',
  '--input-sha256',
  '--previous-arrivals',
  '--previous-receipt',
  '--previous-receipt-sha256',
  '--current-arrivals',
  '--current-receipt',
  '--current-receipt-sha256',
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
        return yield* new GapRecoveryFailure({ message: 'Gap input or receipt exceeds the 512 KiB file limit' })
      chunks.push(result.value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    if (sha256(bytes) !== expectedHash)
      return yield* new GapRecoveryFailure({ message: 'Gap input or receipt hash differs' })
    return yield* Effect.try({
      try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      catch: (cause) => new GapRecoveryFailure({ message: 'Gap input is not valid UTF-8', cause }),
    })
  }).pipe(Effect.scoped)

const print = (text: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make(text), stdio.stdout())
  })

export const runGapRecoveryCommand = (args: readonly string[]) =>
  Effect.gen(function* () {
    if (args.length === 1 && args[0] === '--help') return yield* print(`${usage}\n`)
    const flags = new Map<string, string>()
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i],
        value = args[i + 1]
      if (
        key === undefined ||
        value === undefined ||
        value.trim() === '' ||
        !keys.some((k) => k === key) ||
        flags.has(key)
      )
        return yield* new GapRecoveryFailure({ message: usage })
      flags.set(key, value)
    }
    if (flags.size !== keys.length) return yield* new GapRecoveryFailure({ message: usage })
    const values = keys.map((key) => flags.get(key))
    const [
      inputPath,
      inputHash,
      previousArrivals,
      previousReceiptPath,
      previousReceiptHash,
      currentArrivals,
      currentReceiptPath,
      currentReceiptHash,
      outputPath,
    ] = values
    if (
      inputPath === undefined ||
      inputHash === undefined ||
      previousArrivals === undefined ||
      previousReceiptPath === undefined ||
      previousReceiptHash === undefined ||
      currentArrivals === undefined ||
      currentReceiptPath === undefined ||
      currentReceiptHash === undefined ||
      outputPath === undefined
    )
      return yield* new GapRecoveryFailure({ message: usage })
    const fs = yield* FileSystem.FileSystem
    if (yield* fs.exists(outputPath))
      return yield* new GapRecoveryFailure({ message: 'Gap report already exists; refusing to overwrite it' })
    const input = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(GapRecoveryStudyInputSchema),
      strictParseOptions,
    )(yield* boundedText(inputPath, inputHash))
    const previousReceipt = yield* Effect.fromResult(
      validateBacktestSourceReceipt(yield* boundedText(previousReceiptPath, previousReceiptHash), previousReceiptHash),
    )
    const currentReceipt = yield* Effect.fromResult(
      validateBacktestSourceReceipt(yield* boundedText(currentReceiptPath, currentReceiptHash), currentReceiptHash),
    )
    const report = yield* runGapRecoveryStudy(
      input,
      { arrivalsPath: previousArrivals, receipt: previousReceipt },
      { arrivalsPath: currentArrivals, receipt: currentReceipt },
    )
    yield* fs.writeFileString(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
    yield* print(
      `${JSON.stringify({
        outputPath,
        reportHash: report.reportHash,
        status: report.decision.status,
        selectedSymbol: report.decision.selectedSymbol,
        inputComplete: report.decision.inputComplete,
        qualification: report.qualification,
      })}\n`,
    )
    if (!report.decision.inputComplete)
      return yield* new GapRecoveryFailure({
        message: 'Gap decision inputs are incomplete; diagnostic written without trading',
      })
  })

if (import.meta.main)
  NodeRuntime.runMain(
    runGapRecoveryCommand(process.argv.slice(2)).pipe(
      Effect.tapCause((cause) => Effect.logError(cause)),
      // @effect-diagnostics-next-line strictEffectProvide:off -- command owns only local file and standard output resources
      Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.withConsoleError(Logger.formatJson)]))),
    ),
    { disableErrorReporting: true },
  )
