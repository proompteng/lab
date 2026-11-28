import { parseArgs } from 'node:util'

import { NodeFileSystem, NodeRuntime } from '@effect/platform-node'
import { Cause, Console, Effect, FileSystem, Layer, Logger, Option, Result, Schema } from 'effect'

import { StrictNonEmptyStringSchema, strictParseOptions } from '../src/schemas'
import {
  analyzeWashSaleExposure,
  renderWashSaleJson,
  renderWashSaleMarkdown,
  washSaleError,
} from './analyze-wash-sale-exposure-core'

enum Format {
  Json = 'json',
  Markdown = 'markdown',
}

const usage = 'Usage: bun services/bayn/tools/analyze-wash-sale-exposure.ts --fixture <path> [--format json|markdown]'
const Options = Schema.Struct({ fixture: StrictNonEmptyStringSchema, format: Schema.Enum(Format) })
const parseOptions = (args: readonly string[]) =>
  Result.gen(function* () {
    const { tokens, values } = yield* Result.try({
      try: () =>
        parseArgs({
          args: [...args],
          options: { fixture: { type: 'string' }, format: { type: 'string', default: Format.Markdown } },
          tokens: true,
        }),
      catch: (cause) => washSaleError(usage, cause),
    })
    const flags = tokens.flatMap((token) => (token.kind === 'option' ? [token.name] : []))
    if (new Set(flags).size !== flags.length)
      return yield* Result.fail(washSaleError(usage, { reason: 'DuplicateFlag' }))
    return yield* Schema.decodeUnknownResult(
      Options,
      strictParseOptions,
    )(values).pipe(Result.mapError((cause) => washSaleError(usage, cause)))
  })

const run = Effect.fn('bayn.wash-sale-exposure.run')(function* (args: readonly string[]) {
  if (args.length === 1 && args[0] === '--help') return yield* Console.log(usage)
  const options = yield* Effect.fromResult(parseOptions(args))
  const fs = yield* FileSystem.FileSystem
  const fixture = yield* fs
    .readFileString(options.fixture)
    .pipe(Effect.mapError((cause) => washSaleError('Cannot read fixture; check the local path and permissions', cause)))
  const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(fixture).pipe(
    Effect.mapError((cause) => washSaleError('Invalid fixture JSON', cause)),
  )
  const report = yield* Effect.fromResult(analyzeWashSaleExposure(input))
  yield* Console.log(options.format === Format.Json ? renderWashSaleJson(report) : renderWashSaleMarkdown(report))
})

if (import.meta.main) {
  NodeRuntime.runMain(
    run(process.argv.slice(2)).pipe(
      Effect.tapCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void
        const failure = Cause.findErrorOption(cause)
        if (Option.isNone(failure)) return Effect.logError({ kind: 'UnexpectedDefect' })
        const { _tag, message, fillNumber, cause: redacted } = failure.value
        return Effect.logError({ kind: _tag, message, fillNumber, cause: redacted })
      }),
      // @effect-diagnostics-next-line strictEffectProvide:off -- this entry point owns local file access and stderr
      Effect.provide(Layer.mergeAll(NodeFileSystem.layer, Logger.layer([Logger.withConsoleError(Logger.formatJson)]))),
    ),
    { disableErrorReporting: true },
  )
}
