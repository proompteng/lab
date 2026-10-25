import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Layer, Logger, Result, Schema, Stdio, Stream } from 'effect'

import { EntryTimingExportFailure, exportEntryTiming } from '../src/intraday-replay/entry-timing-export'
import { Sha256Schema, SourceRevisionSchema } from '../src/schemas'

export const entryTimingExportUsage =
  'Usage: bun tools/entry-timing-export.ts --trace <tempo-json> --trace-sha256 <sha256> --decision <native-json> --decision-sha256 <sha256> --source-revision <revision> --output <new-private-directory> | --help'

type EntryTimingExportArgs =
  | { readonly _tag: 'Help' }
  | ({ readonly _tag: 'Export' } & Parameters<typeof exportEntryTiming>[0])

export const parseEntryTimingExportArgs = (
  args: readonly string[],
): Result.Result<EntryTimingExportArgs, EntryTimingExportFailure> => {
  if (args.length === 1 && args[0] === '--help') return Result.succeed({ _tag: 'Help' } as const)
  const allowed = new Set([
    '--trace',
    '--trace-sha256',
    '--decision',
    '--decision-sha256',
    '--source-revision',
    '--output',
  ])
  const invalid = () => Result.fail(new EntryTimingExportFailure({ message: entryTimingExportUsage }))
  const flags = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (
      key === undefined ||
      value === undefined ||
      !allowed.has(key) ||
      flags.has(key) ||
      value.trim() === '' ||
      value.startsWith('--')
    )
      return invalid()
    flags.set(key, value)
  }
  const tracePath = flags.get('--trace')
  const traceSha256 = flags.get('--trace-sha256')
  const decisionPath = flags.get('--decision')
  const decisionSha256 = flags.get('--decision-sha256')
  const sourceRevision = flags.get('--source-revision')
  const outputPath = flags.get('--output')
  if (
    flags.size !== allowed.size ||
    tracePath === undefined ||
    decisionPath === undefined ||
    outputPath === undefined ||
    traceSha256 === undefined ||
    decisionSha256 === undefined ||
    sourceRevision === undefined ||
    !Schema.is(Sha256Schema)(traceSha256) ||
    !Schema.is(Sha256Schema)(decisionSha256) ||
    !Schema.is(SourceRevisionSchema)(sourceRevision)
  )
    return invalid()
  return Result.succeed({
    _tag: 'Export',
    tracePath,
    traceSha256,
    decisionPath,
    decisionSha256,
    sourceRevision,
    outputPath,
  } as const)
}

export const runEntryTimingExportCommand = (args: readonly string[]) =>
  Effect.gen(function* () {
    const command = yield* Effect.fromResult(parseEntryTimingExportArgs(args))
    const stdio = yield* Stdio.Stdio
    if (command._tag === 'Help') return yield* Stream.run(Stream.make(`${entryTimingExportUsage}\n`), stdio.stdout())
    const receipt = yield* exportEntryTiming(command)
    yield* Stream.run(
      Stream.make(
        `${JSON.stringify({ outputPath: command.outputPath, receiptHash: receipt.receiptHash, timingSha256: receipt.timing.sha256, scope: receipt.scope, qualification: receipt.qualification })}\n`,
      ),
      stdio.stdout(),
    )
    return receipt
  })

if (import.meta.main)
  NodeRuntime.runMain(
    runEntryTimingExportCommand(process.argv.slice(2)).pipe(
      Effect.tapError((error) =>
        Effect.logError(error instanceof EntryTimingExportFailure ? error.message : 'Entry timing export failed'),
      ),
      // @effect-diagnostics-next-line strictEffectProvide:off -- offline command owns file and standard-output resources
      Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.withConsoleError(Logger.formatJson)]))),
    ),
    { disableErrorReporting: true },
  )
