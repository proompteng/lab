import { parseArgs } from 'node:util'

import { NodeFileSystem, NodeRuntime } from '@effect/platform-node'
import { Cause, Console, Effect, FileSystem, Layer, Logger, Option, Result, Schema } from 'effect'

import { GitSourceRevisionSchema, StrictNonEmptyStringSchema, strictParseOptions } from '../src/schemas'
import { attributionError } from './weekly-attribution-receipts'
import {
  buildWeeklyAttributionReport,
  buildWeeklyKnowledgeDelta,
  renderWeeklyAttributionJson,
  renderWeeklyAttributionMarkdown,
} from './weekly-attribution-report'

enum Format {
  Markdown = 'markdown',
  Json = 'json',
}

const Path = StrictNonEmptyStringSchema
const Options = Schema.Struct({
  audit: Path,
  'sleeve-receipt': Schema.NonEmptyArray(Path),
  scorecard: Schema.optionalKey(Path),
  'account-evidence': Schema.optionalKey(Path),
  format: Schema.Enum(Format),
  'emit-knowledge-delta': Schema.optionalKey(Path),
  'source-commit': Schema.optionalKey(GitSourceRevisionSchema),
}).check(
  Schema.makeFilter(
    (options) => (options['emit-knowledge-delta'] === undefined) === (options['source-commit'] === undefined),
  ),
)

const usage = [
  'Usage: bun services/bayn/tools/bayn-weekly-attribution-report.ts',
  '  --audit <audit.json> --sleeve-receipt <receipt.json> [--sleeve-receipt <receipt.json> ...]',
  '  [--scorecard <scorecard.json>] [--account-evidence <evidence.json>] [--format markdown|json]',
  '  [--emit-knowledge-delta <new-path> --source-commit <full-git-sha>]',
].join('\n')

const parseOptions = (args: readonly string[]) =>
  Result.gen(function* () {
    const { tokens, values } = yield* Result.try({
      try: () =>
        parseArgs({
          args: [...args],
          options: {
            audit: { type: 'string' },
            'sleeve-receipt': { type: 'string', multiple: true },
            scorecard: { type: 'string' },
            'account-evidence': { type: 'string' },
            format: { type: 'string', default: Format.Markdown },
            'emit-knowledge-delta': { type: 'string' },
            'source-commit': { type: 'string' },
          },
          tokens: true,
        }),
      catch: (cause) => attributionError(usage, cause),
    })
    const singleFlags = tokens.flatMap((token) =>
      token.kind === 'option' && token.name !== 'sleeve-receipt' ? [token.name] : [],
    )
    if (new Set(singleFlags).size !== singleFlags.length)
      return yield* Result.fail(attributionError(usage, { kind: 'DuplicateFlag' }))
    return yield* Schema.decodeUnknownResult(
      Options,
      strictParseOptions,
    )(values).pipe(Result.mapError((cause) => attributionError(usage, cause)))
  })

const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
const readJson = (fs: FileSystem.FileSystem, path: string, label: string) =>
  fs.readFileString(path).pipe(
    Effect.flatMap(parseJson),
    Effect.mapError((cause) => attributionError(`Cannot read or parse ${label}`, cause)),
  )

export const runWeeklyAttribution = Effect.fn('bayn.weekly-attribution.run')(function* (args: readonly string[]) {
  if (args.length === 1 && args[0] === '--help') return yield* Console.log(usage)
  const options = yield* Effect.fromResult(parseOptions(args))
  const fs = yield* FileSystem.FileSystem
  const audit = yield* readJson(fs, options.audit, 'intraday audit JSON')
  const sleeveReceipts = yield* Effect.forEach(options['sleeve-receipt'], (path, i) =>
    readJson(fs, path, `portfolio receipt JSON #${i + 1}`),
  )
  const scorecard =
    options.scorecard === undefined ? {} : { scorecard: yield* readJson(fs, options.scorecard, 'daily scorecard JSON') }
  const evidencePath = options['account-evidence']
  const evidence =
    evidencePath === undefined ? {} : { accountEvidence: yield* readJson(fs, evidencePath, 'account evidence JSON') }
  const report = yield* Effect.fromResult(
    buildWeeklyAttributionReport({ audit, sleeveReceipts, ...scorecard, ...evidence }),
  )
  const output = options['emit-knowledge-delta']
  const commit = options['source-commit']
  if (output !== undefined && commit !== undefined) {
    const delta = yield* Effect.fromResult(buildWeeklyKnowledgeDelta(report, commit))
    yield* fs
      .writeFileString(output, `${JSON.stringify(delta, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      .pipe(Effect.mapError((cause) => attributionError('Cannot write a new knowledge delta file', cause)))
  }
  yield* Console.log(
    options.format === Format.Json ? renderWeeklyAttributionJson(report) : renderWeeklyAttributionMarkdown(report),
  )
})

if (import.meta.main) {
  NodeRuntime.runMain(
    runWeeklyAttribution(process.argv.slice(2)).pipe(
      Effect.tapCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void
        const failure = Cause.findErrorOption(cause)
        return Effect.logError(Option.isSome(failure) ? failure.value : { kind: 'UnexpectedDefect' })
      }),
      // @effect-diagnostics-next-line strictEffectProvide:off -- this entry point owns local file access and logging
      Effect.provide(Layer.mergeAll(NodeFileSystem.layer, Logger.layer([Logger.consoleJson]))),
    ),
    { disableErrorReporting: true },
  )
}
