import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Config, Effect, FileSystem, Layer, Logger, Stdio, Stream } from 'effect'

import { canonicalHashV1Result, sha256 } from './hash'
import {
  decodeHybridCrashVwapSessionBars,
  evaluateHybridCrashVwapShadow,
  HybridCrashVwapFailure,
  HybridCrashVwapMode,
  HybridCrashVwapModeSchema,
} from './intraday-replay/crash-vwap-bounce'
import { currentUtcInstant } from './time'

/** RESEARCH_ONLY shadow switch. Absent means off; any value outside the closed vocabulary fails at startup. */
export const hybridCrashVwapModeConfig = Config.schema(HybridCrashVwapModeSchema, 'BAYN_HYBRID_CRASH_VWAP').pipe(
  Config.withDefault(HybridCrashVwapMode.Off),
)

const usage =
  'Usage: bayn-hybrid-crash-vwap-shadow --input <session-bars-json> --input-sha256 <sha256> --output <new-json> | --help'
const allowedFlags = new Set(['--input', '--input-sha256', '--output'])

export const parseHybridCrashVwapShadowArgs = (args: readonly string[]) => {
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
  const outputPath = flags.get('--output')
  if (
    inputPath === undefined ||
    inputHash === undefined ||
    outputPath === undefined ||
    !/^[a-f0-9]{64}$/.test(inputHash)
  )
    return invalid
  return { _tag: 'Run', inputPath, inputHash, outputPath } as const
}

const print = (text: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make(`${text}\n`), stdio.stdout())
  })

export const runHybridCrashVwapShadowCommand = (rawArgs: readonly string[]) =>
  Effect.gen(function* () {
    const args = parseHybridCrashVwapShadowArgs(rawArgs)
    if (args._tag === 'Help') return yield* print(usage)
    if (args._tag === 'Invalid') return yield* new HybridCrashVwapFailure({ message: usage })
    const mode = yield* hybridCrashVwapModeConfig
    if (mode === HybridCrashVwapMode.Off) {
      yield* Effect.logInfo('Hybrid crash-VWAP shadow is off; no record written').pipe(Effect.annotateLogs({ mode }))
      return yield* print(JSON.stringify({ mode, outputPath: null }))
    }
    const fs = yield* FileSystem.FileSystem
    if (yield* fs.exists(args.outputPath))
      return yield* new HybridCrashVwapFailure({ message: 'Hybrid crash-VWAP shadow output already exists' })
    const inputText = yield* fs.readFileString(args.inputPath)
    if (sha256(inputText) !== args.inputHash)
      return yield* new HybridCrashVwapFailure({ message: 'Hybrid crash-VWAP session bars hash differs' })
    const session = yield* Effect.fromResult(decodeHybridCrashVwapSessionBars(inputText))
    const record = evaluateHybridCrashVwapShadow({ session, evaluatedAt: yield* currentUtcInstant })
    const recordHash = yield* Effect.fromResult(canonicalHashV1Result(record))
    yield* fs.writeFileString(args.outputPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
    const summary = {
      mode,
      outputPath: args.outputPath,
      inputSha256: args.inputHash,
      recordHash,
      sessionDate: record.sessionDate,
      candidates: record.candidates.length,
    }
    yield* Effect.logInfo('Hybrid crash-VWAP shadow record written').pipe(Effect.annotateLogs(summary))
    yield* print(JSON.stringify(summary))
  })

if (import.meta.main)
  NodeRuntime.runMain(
    runHybridCrashVwapShadowCommand(process.argv.slice(2)).pipe(
      Effect.tapCause((cause) => Effect.logError(cause)),
      // @effect-diagnostics-next-line strictEffectProvide:off -- offline research command owns file and standard-output resources
      Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.withConsoleError(Logger.formatJson)]))),
    ),
    { disableErrorReporting: true },
  )
