import { NodeFileSystem, NodeRuntime } from '@effect/platform-node'
import { Cause, Console, Data, Effect, FileSystem, Layer, type PlatformError, Redacted, Result, Schema } from 'effect'

import { reportingLogger } from '../src/reporting-runtime'
import { strictParseOptions } from '../src/schemas'
import {
  analyzeFillQuality,
  FillTimingEvidence,
  renderFillQualityJson,
  renderFillQualityMarkdown,
} from './analyze-fill-quality-core'
import { AuditInput, MarketEvidence } from './live-profitability-audit-core'

const usage =
  'Usage: bun services/bayn/tools/analyze-fill-quality.ts --fixture PATH [--timing-evidence PATH] [--market-evidence PATH] [--format markdown|json]'
const flags = new Set(['--fixture', '--timing-evidence', '--market-evidence', '--format'])

enum OutputFormat {
  Markdown = 'markdown',
  Json = 'json',
}
const decodeFormat = Schema.decodeUnknownResult(Schema.Enum(OutputFormat), { reportInput: false })

class FillQualityUsageError extends Data.TaggedError('FillQualityUsageError')<{ readonly message: string }> {}

type Options = {
  readonly fixture: string
  readonly timing: string | undefined
  readonly market: string | undefined
  readonly format: OutputFormat
}
const parseOptions = (args: readonly string[]): Result.Result<Options, FillQualityUsageError> => {
  const invalid = () => Result.fail(new FillQualityUsageError({ message: usage }))
  const values = new Map<string, string>()
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]
    const value = args[i + 1]
    if (
      key === undefined ||
      value === undefined ||
      !flags.has(key) ||
      values.has(key) ||
      value.trim() === '' ||
      value.startsWith('-')
    )
      return invalid()
    values.set(key, value)
  }
  const fixture = values.get('--fixture')
  const format = decodeFormat(values.get('--format') ?? OutputFormat.Markdown)
  if (fixture === undefined || Result.isFailure(format)) return invalid()
  return Result.succeed({
    fixture,
    timing: values.get('--timing-evidence'),
    market: values.get('--market-evidence'),
    format: format.success,
  })
}

class FillQualityInputError extends Data.TaggedError('FillQualityInputError')<{
  readonly message: string
  readonly source: '--fixture' | '--timing-evidence' | '--market-evidence'
  readonly cause: Redacted.Redacted<PlatformError.PlatformError | Schema.SchemaError>
}> {}

const readEvidence = <S extends Schema.Decoder<unknown>>(
  schema: S,
  source: FillQualityInputError['source'],
  path: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs
      .readFileString(path)
      .pipe(
        Effect.mapError(
          (cause) =>
            new FillQualityInputError({ message: `Cannot read ${source} file.`, source, cause: Redacted.make(cause) }),
        ),
      )
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema), {
      ...strictParseOptions,
      reportInput: false,
    })(text).pipe(
      Effect.mapError(
        (cause) =>
          new FillQualityInputError({
            message: `Invalid normalized JSON in ${source}.`,
            source,
            cause: Redacted.make(cause),
          }),
      ),
    )
  })

export const runFillQuality = (args: readonly string[]) =>
  Effect.gen(function* () {
    if (args.length === 1 && args[0] === '--help') return yield* Console.log(usage)
    const options = yield* Effect.fromResult(parseOptions(args))
    const input = yield* readEvidence(AuditInput, '--fixture', options.fixture)
    const timing =
      options.timing === undefined
        ? undefined
        : yield* readEvidence(FillTimingEvidence, '--timing-evidence', options.timing)
    const market =
      options.market === undefined
        ? undefined
        : yield* readEvidence(MarketEvidence, '--market-evidence', options.market)
    const report = yield* Effect.fromResult(analyzeFillQuality(input, timing, market))
    yield* Console.log(
      options.format === OutputFormat.Json ? renderFillQualityJson(report) : renderFillQualityMarkdown(report),
    )
  })

if (import.meta.main) {
  NodeRuntime.runMain(
    runFillQuality(process.argv.slice(2)).pipe(
      Effect.tapCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(cause))),
      // @effect-diagnostics-next-line strictEffectProvide:off -- CLI composition root
      Effect.provide(Layer.mergeAll(NodeFileSystem.layer, reportingLogger)),
    ),
    { disableErrorReporting: true },
  )
}
