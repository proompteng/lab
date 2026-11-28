import { parseArgs } from 'node:util'

import { NodeFileSystem, NodeRuntime } from '@effect/platform-node'
import { Cause, Console, Data, Effect, FileSystem, Option, Redacted, Result, Runtime, Schema } from 'effect'

import { StrictNonEmptyStringSchema, strictParseOptions } from '../src/schemas'
import {
  analyzeOrderRejections,
  renderOrderRejectionJson,
  renderOrderRejectionMarkdown,
  TriageSeverity,
} from './analyze-order-rejections-core'

enum Format {
  Json = 'json',
  Markdown = 'markdown',
}

const Options = Schema.Struct({ fixture: StrictNonEmptyStringSchema, format: Schema.Enum(Format) })
const usage = 'Usage: bun services/bayn/tools/analyze-order-rejections.ts --fixture <path> [--format json|markdown]'

class OrderRejectionCommandError extends Data.TaggedError('OrderRejectionCommandError')<{
  readonly message: string
  readonly cause: Redacted.Redacted<unknown>
}> {}

class TriageAlarm extends Data.TaggedError('TriageAlarm')<{ readonly severity: TriageSeverity }> {
  override readonly [Runtime.errorExitCode] = 2
}

const parseOptions = (args: readonly string[]) =>
  Result.gen(function* () {
    const invalid = (cause: unknown) => new OrderRejectionCommandError({ message: usage, cause: Redacted.make(cause) })
    const { values, tokens } = yield* Result.try({
      try: () =>
        parseArgs({
          args: [...args],
          options: { fixture: { type: 'string' }, format: { type: 'string', default: Format.Markdown } },
          tokens: true,
        }),
      catch: invalid,
    })
    const flags = tokens.flatMap((token) => (token.kind === 'option' ? [token.name] : []))
    if (tokens.length !== new Set(flags).size) return yield* Result.fail(invalid({ kind: 'UnexpectedArgumentToken' }))
    return yield* Schema.decodeUnknownResult(Options, strictParseOptions)(values).pipe(Result.mapError(invalid))
  })

const run = (args: readonly string[]) =>
  Effect.gen(function* () {
    if (args.length === 1 && args[0] === '--help') return yield* Console.log(usage)
    const { fixture, format } = yield* Effect.fromResult(parseOptions(args))
    const fs = yield* FileSystem.FileSystem
    const json = yield* fs
      .readFileString(fixture)
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrderRejectionCommandError({ message: 'Cannot read the fixture file.', cause: Redacted.make(cause) }),
        ),
      )
    const report = yield* Effect.fromResult(analyzeOrderRejections(json))
    yield* Console.log(format === Format.Json ? renderOrderRejectionJson(report) : renderOrderRejectionMarkdown(report))
    if (report.severity !== TriageSeverity.Ok) return yield* new TriageAlarm({ severity: report.severity })
  })

if (import.meta.main) {
  NodeRuntime.runMain(
    run(process.argv.slice(2)).pipe(
      Effect.tapCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void
        const failure = Cause.findErrorOption(cause)
        if (Option.isNone(failure)) return Console.error(JSON.stringify({ error: 'UnexpectedDefect' }))
        const error = failure.value
        if (error._tag === 'TriageAlarm') return Effect.void
        return Console.error(
          JSON.stringify({ error: error._tag, message: error.message, row: 'row' in error ? error.row : undefined }),
        )
      }),
      // @effect-diagnostics-next-line strictEffectProvide:off -- CLI composition provides local file reads only.
      Effect.provide(NodeFileSystem.layer),
    ),
    { disableErrorReporting: true },
  )
}
