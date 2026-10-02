import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { fileURLToPath } from 'node:url'
import { Effect, FileSystem, Layer, Logger, Schema, Stdio, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { sha256 } from '../src/hash'
import {
  MatchedStudyInputSchema,
  MatchedRegistrationSchema,
  runMatchedEntryStudy,
} from '../src/intraday-replay/matched-entry-study'
import { SignalStudyFailure } from '../src/intraday-replay/signal-study'
import { validateBacktestSourceReceipt } from '../src/intraday-replay/source'
import { strictParseOptions } from '../src/schemas'

const verifyRegisteredCheckout = (sourceRevision: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    // Bind the source executing this command, independently of the caller's working directory.
    const cwd = fileURLToPath(new URL('../../../', import.meta.url))
    const git = (args: readonly string[]) =>
      Effect.gen(function* () {
        const child = yield* spawner.spawn(ChildProcess.make('git', args, { cwd, stdin: 'ignore', stderr: 'ignore' }))
        const [output, exitCode] = yield* Effect.all(
          [Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode],
          { concurrency: 'unbounded' },
        )
        if (Number(exitCode) !== 0)
          return yield* new SignalStudyFailure({ message: 'Cannot verify the executing Git checkout' })
        return output.trim()
      }).pipe(
        Effect.scoped,
        Effect.timeout('10 seconds'),
        Effect.mapError(
          (cause) => new SignalStudyFailure({ message: 'Registered checkout verification failed', cause }),
        ),
      )
    if ((yield* git(['rev-parse', 'HEAD'])) !== sourceRevision)
      return yield* new SignalStudyFailure({ message: 'Executing checkout revision differs from registration' })
    if ((yield* git(['status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=none'])) !== '')
      return yield* new SignalStudyFailure({ message: 'Executing checkout must be clean and fully committed' })
  })

export const runMatchedCommand = (args: readonly string[]) =>
  Effect.gen(function* () {
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
    const registeredPath = flags.get('--registration')
    const registeredHash = flags.get('--registration-sha256')
    const arrivals = flags.get('--arrivals')
    const receiptPath = flags.get('--source-receipt')
    const receiptHash = flags.get('--source-receipt-sha256')
    const outputPath = flags.get('--output')
    if (
      flags.size !== 8 ||
      inputPath === undefined ||
      inputHash === undefined ||
      registeredPath === undefined ||
      registeredHash === undefined ||
      arrivals === undefined ||
      receiptPath === undefined ||
      receiptHash === undefined ||
      outputPath === undefined
    )
      return yield* new SignalStudyFailure({
        message:
          'Usage: bun tools/matched-entry-study.ts --input <json> --input-sha256 <sha256> --registration <json> --registration-sha256 <sha256> --arrivals <ndjson.gz> --source-receipt <json> --source-receipt-sha256 <sha256> --output <new-json>',
      })
    const fs = yield* FileSystem.FileSystem
    const inputText = yield* fs.readFileString(inputPath)
    const registeredText = yield* fs.readFileString(registeredPath)
    if (sha256(inputText) !== inputHash || sha256(registeredText) !== registeredHash)
      return yield* new SignalStudyFailure({ message: 'Study input or registration hash differs' })
    const input = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(MatchedStudyInputSchema),
      strictParseOptions,
    )(inputText)
    const registration = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(MatchedRegistrationSchema),
      strictParseOptions,
    )(registeredText)
    yield* verifyRegisteredCheckout(registration.sourceRevision)
    for (const witness of input.witnesses) {
      if (sha256(yield* fs.readFile(witness.path)) !== witness.sha256)
        return yield* new SignalStudyFailure({ message: 'Private witness hash differs' })
    }
    const receipt = yield* Effect.fromResult(
      validateBacktestSourceReceipt(yield* fs.readFileString(receiptPath), receiptHash),
    )
    const report = yield* runMatchedEntryStudy(input, registration, arrivals, receipt)
    yield* verifyRegisteredCheckout(registration.sourceRevision)
    yield* fs.writeFileString(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(
      Stream.make(
        `${JSON.stringify({ outputPath, reportHash: report.reportHash, summary: report.summary }, null, 2)}\n`,
      ),
      stdio.stdout(),
    )
    return report
  }).pipe(Effect.scoped)

if (import.meta.main)
  NodeRuntime.runMain(
    runMatchedCommand(process.argv.slice(2)).pipe(
      Effect.tapCause((cause) => Effect.logError(cause)),
      // @effect-diagnostics-next-line strictEffectProvide:off -- offline command owns file and standard-output resources
      Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.withConsoleError(Logger.formatJson)]))),
    ),
    { disableErrorReporting: true },
  )
