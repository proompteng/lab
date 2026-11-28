import { parseArgs } from 'node:util'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import { Cause, Console, Effect, FileSystem, Option, Result, Schema } from 'effect'

import { StrictNonEmptyStringSchema, strictParseOptions } from '../src/schemas'
import {
  ErrorCode,
  Format,
  Severity,
  divergenceError,
  renderDivergence,
  verifyDivergence,
} from './verify-multi-account-divergence-core'

const usage =
  'Usage: bun services/bayn/tools/verify-multi-account-divergence.ts --fixture <path> [--format json|markdown]'
const Options = Schema.Struct({ fixture: StrictNonEmptyStringSchema, format: Schema.Enum(Format) })
const decodeOptions = Schema.decodeUnknownResult(Options, strictParseOptions)
const invalidArguments = (cause: unknown) => divergenceError(ErrorCode.Arguments, usage, cause)
const options = (args: readonly string[]) =>
  Result.gen(function* () {
    const { values, tokens } = yield* Result.try({
      try: () =>
        parseArgs({
          args: [...args],
          options: { fixture: { type: 'string' }, format: { type: 'string', default: Format.Markdown } },
          tokens: true,
        }),
      catch: invalidArguments,
    })
    const flags = tokens.flatMap((token) => (token.kind === 'option' ? [token.name] : []))
    if (new Set(flags).size !== flags.length) return yield* Result.fail(invalidArguments({ kind: 'DuplicateOption' }))
    return yield* decodeOptions(values).pipe(Result.mapError(invalidArguments))
  })

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
const readFixture = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const readError = (cause: unknown) =>
      divergenceError(ErrorCode.Read, 'Cannot read a local regular fixture file.', cause)
    const info = yield* fs.stat(path).pipe(Effect.mapError(readError))
    if (info.type !== 'File') return yield* readError({ kind: 'NotRegularFile' })
    const text = yield* fs.readFileString(path).pipe(Effect.mapError(readError))
    return yield* decodeJson(text).pipe(
      Effect.mapError((cause) => divergenceError(ErrorCode.Json, 'Fixture is not valid JSON.', cause)),
    )
  })

const runVerifier = Effect.fn('bayn.multi-account-divergence.run')(function* (args: readonly string[]) {
  if (args.length === 1 && args[0] === '--help') return yield* Console.log(usage)
  const { fixture, format } = yield* Effect.fromResult(options(args))
  const input = yield* readFixture(fixture)
  const report = yield* Effect.fromResult(verifyDivergence(input))
  yield* Console.log(renderDivergence(report, format))
  if (report.severity !== Severity.Pass) {
    return yield* divergenceError(ErrorCode.NotPass, 'The comparison did not pass.', { severity: report.severity })
  }
})

if (import.meta.main) {
  NodeRuntime.runMain(
    runVerifier(process.argv.slice(2)).pipe(
      Effect.tapCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void
        const failure = Cause.findErrorOption(cause)
        if (Option.isSome(failure) && failure.value.code === ErrorCode.NotPass) return Effect.void
        const { code, message } = Option.getOrElse(failure, () => ({
          code: ErrorCode.Unexpected,
          message: 'Unexpected verification failure.',
        }))
        return Console.error(JSON.stringify({ severity: Severity.Fail, code, message }))
      }),
      // @effect-diagnostics-next-line strictEffectProvide:off -- this entry point owns local file access
      Effect.provide(NodeFileSystem.layer),
    ),
    { disableErrorReporting: true },
  )
}
