import { NodeHttpClient, NodeRuntime, NodeServices } from '@effect/platform-node'
import { Clock, Config, Context, Effect, FileSystem, Layer, Logger, Schema, Stdio, Stream } from 'effect'
import { TestClock } from 'effect/testing'

import { sha256 } from './hash'
import { ControlStudyFailure } from './intraday-replay/control-portfolio'
import { ControlInputCoverage, runControlPreflight } from './intraday-replay/control-preflight'
import {
  ControlManagementMode,
  ControlStudyInputSchema,
  runControlStudy,
  type ControlStudyManagement,
} from './intraday-replay/control-study'
import { prepareBacktest } from './intraday-replay/backtest'
import { JevClient, JevClientLive } from './jev/client'
import { validateBacktestSourceReceipt } from './intraday-replay/source'

const usage =
  'Usage: bayn-control-study --input <json> --input-sha256 <sha256> --arrivals <ndjson.gz> --source-receipt <json> --source-receipt-sha256 <sha256> --output <new-json> [--mode study|preflight] [--evidence-directory <new-directory-required-for-JEV-study>] | --help'
const allowedFlags = new Set([
  '--input',
  '--input-sha256',
  '--arrivals',
  '--source-receipt',
  '--source-receipt-sha256',
  '--output',
  '--mode',
  '--evidence-directory',
])

export const parseControlStudyArgs = (args: readonly string[]) => {
  if (args.length === 1 && args[0] === '--help') return { _tag: 'Help' } as const
  const invalid = { _tag: 'Invalid' } as const
  const flags = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (
      key === undefined ||
      value === undefined ||
      !allowedFlags.has(key) ||
      flags.has(key) ||
      value.trim() === '' ||
      value.startsWith('--')
    )
      return invalid
    flags.set(key, value)
  }
  const inputPath = flags.get('--input')
  const inputHash = flags.get('--input-sha256')
  const arrivals = flags.get('--arrivals')
  const receiptPath = flags.get('--source-receipt')
  const receiptHash = flags.get('--source-receipt-sha256')
  const outputPath = flags.get('--output')
  const evidenceDirectory = flags.get('--evidence-directory')
  const mode = flags.get('--mode') ?? 'study'
  if (
    inputPath === undefined ||
    inputHash === undefined ||
    arrivals === undefined ||
    receiptPath === undefined ||
    receiptHash === undefined ||
    outputPath === undefined ||
    !/^[a-f0-9]{64}$/.test(inputHash) ||
    !/^[a-f0-9]{64}$/.test(receiptHash) ||
    (mode !== 'study' && mode !== 'preflight') ||
    (mode === 'preflight' && evidenceDirectory !== undefined)
  )
    return invalid
  return {
    _tag: 'Run',
    inputPath,
    inputHash,
    arrivals,
    receiptPath,
    receiptHash,
    outputPath,
    evidenceDirectory,
    mode,
  } as const
}

export const runControlStudyCommand = (rawArgs: readonly string[]) =>
  Effect.gen(function* () {
    const args = parseControlStudyArgs(rawArgs)
    if (args._tag === 'Help') {
      const stdio = yield* Stdio.Stdio
      return yield* Stream.run(Stream.make(`${usage}\n`), stdio.stdout())
    }
    if (args._tag === 'Invalid') return yield* new ControlStudyFailure({ message: usage })
    const { inputPath, inputHash, arrivals, receiptPath, receiptHash, outputPath, evidenceDirectory, mode } = args
    const fs = yield* FileSystem.FileSystem
    if (yield* fs.exists(outputPath))
      return yield* new ControlStudyFailure({ message: 'Control output already exists' })
    const inputText = yield* fs.readFileString(inputPath)
    if (sha256(inputText) !== inputHash) return yield* new ControlStudyFailure({ message: 'Study input hash differs' })
    const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ControlStudyInputSchema))(inputText)
    const receipt = yield* Effect.fromResult(
      validateBacktestSourceReceipt(yield* fs.readFileString(receiptPath), receiptHash),
    )
    if (mode === 'preflight') {
      const report = yield* runControlPreflight(input, arrivals, receipt)
      yield* fs.writeFileString(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
      const stdio = yield* Stdio.Stdio
      yield* Stream.run(
        Stream.make(`${JSON.stringify({ outputPath, reportHash: report.reportHash, coverage: report.coverage })}\n`),
        stdio.stdout(),
      )
      if (report.coverage !== ControlInputCoverage.Complete)
        return yield* new ControlStudyFailure({
          message: `Preflight input coverage is ${report.coverage}; diagnostic report written without running a study`,
        })
      return
    }
    let management: ControlStudyManagement
    if (input.management === ControlManagementMode.Jev) {
      if (evidenceDirectory === undefined)
        return yield* new ControlStudyFailure({ message: 'JEV controls require a new evidence directory' })
      const prepared = yield* Effect.fromResult(prepareBacktest(input.backtest, receipt))
      const providerClock = yield* Clock.clockWith(Effect.succeed)
      const providerContext = yield* Layer.build(
        JevClientLive(yield* Config.Redacted('BAYN_JEV_API_KEY'), prepared.protocol.inferenceValidityMs).pipe(
          Layer.provide(NodeHttpClient.layerNodeHttp),
        ),
      )
      management = {
        mode: ControlManagementMode.Jev,
        evidenceDirectory,
        providerClock,
        provider: Context.get(providerContext, JevClient),
      }
    } else {
      if (evidenceDirectory !== undefined)
        return yield* new ControlStudyFailure({ message: 'Mechanical controls do not use a Jev evidence directory' })
      management = { mode: ControlManagementMode.Mechanical }
    }
    const report = yield* runControlStudy(input, arrivals, receipt, management).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- command isolates market time from provider deadlines
      Effect.provide(TestClock.layer()),
    )
    yield* fs.writeFileString(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(
      Stream.make(
        `${JSON.stringify({ outputPath, reportHash: report.reportHash, sessions: report.sessions.map(({ policy, sessionDate, completion, completedEpisodes, filledNotionalMicros, netPnlAfterKnownCostsMicros }) => ({ policy, sessionDate, completion, completedEpisodes, filledNotionalMicros, netPnlAfterKnownCostsMicros })) }, null, 2)}\n`,
      ),
      stdio.stdout(),
    )
  }).pipe(Effect.scoped)

if (import.meta.main)
  NodeRuntime.runMain(
    runControlStudyCommand(process.argv.slice(2)).pipe(
      Effect.tapCause((cause) => Effect.logError(cause)),
      // @effect-diagnostics-next-line strictEffectProvide:off -- offline command owns file and standard-output resources
      Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.withConsoleError(Logger.formatJson)]))),
    ),
    { disableErrorReporting: true },
  )
