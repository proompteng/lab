import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { NodeFileSystem, NodeRuntime } from '@effect/platform-node'
import { Cause, Config, Console, Effect, FileSystem, Layer, Logger, Result, Schema } from 'effect'

import { StrictNonEmptyStringSchema, strictParseOptions } from '../src/schemas'
import {
  buildScorecard,
  renderScorecardJson,
  renderScorecardMarkdown,
  scorecardError,
} from './multi-horizon-scorecard-core'

enum OutputFormat {
  Markdown = 'markdown',
  Json = 'json',
}

const format = Schema.Enum(OutputFormat)
const path = StrictNonEmptyStringSchema
const Options = Schema.Struct({
  'intraday-dir': path,
  'macro-core-dir': path,
  'macro-canary-dir': path,
  'sip-dir': Schema.optionalKey(path),
  'qualification-file': Schema.optionalKey(path),
  format: Schema.optionalKey(format),
  output: Schema.optionalKey(path),
})

const usage = [
  'Usage: bun services/bayn/tools/bayn-daily-scorecard.ts',
  '  --intraday-dir <dir> --macro-core-dir <dir> --macro-canary-dir <dir>',
  '  [--sip-dir <dir>] [--qualification-file <path>] [--format markdown|json] [--output <new-path>]',
].join('\n')

const parseOptions = (args: readonly string[]) =>
  Result.gen(function* () {
    const { values, tokens } = yield* Result.try({
      try: () =>
        parseArgs({
          args: [...args],
          options: {
            'intraday-dir': { type: 'string' },
            'macro-core-dir': { type: 'string' },
            'macro-canary-dir': { type: 'string' },
            'sip-dir': { type: 'string' },
            'qualification-file': { type: 'string' },
            format: { type: 'string' },
            output: { type: 'string' },
          },
          tokens: true,
        }),
      catch: (cause) => scorecardError(usage, cause),
    })
    const names = tokens.flatMap((token) => (token.kind === 'option' ? [token.name] : []))
    if (new Set(names).size !== names.length)
      return yield* Result.fail(scorecardError(usage, { _tag: 'DuplicateFlag' }))
    return yield* Schema.decodeUnknownResult(
      Options,
      strictParseOptions,
    )(values).pipe(Result.mapError((cause) => scorecardError(usage, cause)))
  })

const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
const fileOptions = { flag: 'wx', mode: 0o600, noFollow: true } as const

const readJson = (fs: FileSystem.FileSystem, filename: string, label: string) =>
  fs.readFileString(filename).pipe(
    Effect.flatMap(parseJson),
    Effect.mapError((cause) => scorecardError(`Cannot read or parse JSON: ${label}`, cause)),
  )

const readDirectory = Effect.fn('bayn.scorecard.readDirectory')(function* (
  fs: FileSystem.FileSystem,
  directory: string,
  label: string,
) {
  const names = yield* fs
    .readDirectory(directory)
    .pipe(Effect.mapError((cause) => scorecardError(`Cannot read receipt directory: ${label}`, cause)))
  const documents = yield* Effect.forEach(names.filter((name) => name.endsWith('.json')).sort(), (file, i) =>
    readJson(fs, join(directory, file), `${label} JSON file #${i + 1}`),
  )
  return documents.flatMap((document) => (Array.isArray(document) ? document : [document]))
})

export const runScorecard = (args: readonly string[]) =>
  Effect.gen(function* () {
    if (args.length === 1 && args[0] === '--help') return yield* Console.log(usage)
    const options = yield* Effect.fromResult(parseOptions(args))
    const outputFormat =
      options.format ??
      (yield* Config.schema(format, 'BAYN_SCORECARD_FORMAT').pipe(
        Config.withDefault(OutputFormat.Markdown),
        Effect.mapError((cause) => scorecardError('Invalid BAYN_SCORECARD_FORMAT', cause)),
      ))
    const fs = yield* FileSystem.FileSystem
    const intraday = yield* readDirectory(fs, options['intraday-dir'], 'intraday audit')
    const macroCore = yield* readDirectory(fs, options['macro-core-dir'], 'macro ETF core')
    const macroCanary = yield* readDirectory(fs, options['macro-canary-dir'], 'macro canary')
    const sip =
      options['sip-dir'] === undefined ? undefined : yield* readDirectory(fs, options['sip-dir'], 'SIP shadow')
    const qualification =
      options['qualification-file'] === undefined
        ? {}
        : { qualification: yield* readJson(fs, options['qualification-file'], 'qualification evidence') }
    const scorecard = yield* Effect.fromResult(
      buildScorecard({
        intraday,
        macroCore,
        macroCanary,
        ...qualification,
        ...(sip === undefined ? {} : { sip }),
      }),
    )
    const document =
      outputFormat === OutputFormat.Json
        ? yield* Effect.fromResult(renderScorecardJson(scorecard))
        : renderScorecardMarkdown(scorecard)
    const outputPath = options.output
    if (outputPath === undefined) return yield* Console.log(document)
    yield* Effect.scoped(
      Effect.gen(function* () {
        const output = yield* fs.open(outputPath, fileOptions)
        yield* output.writeAll(new TextEncoder().encode(`${document}\n`))
        yield* output.sync
      }),
    ).pipe(Effect.mapError((cause) => scorecardError('Cannot write new scorecard output', cause)))
  })

if (import.meta.main) {
  NodeRuntime.runMain(
    runScorecard(process.argv.slice(2)).pipe(
      Effect.tapCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(cause))),
      // @effect-diagnostics-next-line strictEffectProvide:off -- CLI composition
      Effect.provide(Layer.mergeAll(NodeFileSystem.layer, Logger.layer([Logger.withConsoleError(Logger.formatJson)]))),
    ),
    { disableErrorReporting: true },
  )
}
