import { parseArgs } from 'node:util'

import { NodeFileSystem, NodeRuntime } from '@effect/platform-node'
import { Cause, Console, Data, DateTime, Effect, FileSystem, Option, Result, Schema } from 'effect'

import { StrictNonEmptyStringSchema, strictParseOptions } from '../src/schemas'
import {
  evaluateLiveGraduation,
  GraduationInputError,
  graduationInputError,
  renderGraduationMarkdown,
  Verdict,
} from './live-graduation-gate-core'

enum Format {
  Json = 'json',
  Markdown = 'markdown',
}

const paths = Schema.optionalKey(Schema.Array(StrictNonEmptyStringSchema))
const Options = Schema.Struct({
  audit: paths,
  'sleeve-receipts': paths,
  'sip-evidence': paths,
  policy: Schema.optionalKey(StrictNonEmptyStringSchema),
  format: Schema.Enum(Format),
})
const usage = [
  'Usage: bun services/bayn/tools/evaluate-live-graduation.ts',
  '  --audit <audit.json> ... --sleeve-receipts <portfolio-or-settlement.json> ...',
  '  --policy <policy.json> [--sip-evidence <parity.json> ...] [--format json|markdown]',
  '  Repeat the flag for each audit, sleeve receipt, or SIP report.',
].join('\n')

const parseOptions = (args: readonly string[]) =>
  Result.gen(function* () {
    const multiple = { type: 'string', multiple: true } as const
    const { tokens, values } = yield* Result.try({
      try: () =>
        parseArgs({
          args: [...args],
          options: {
            audit: multiple,
            'sleeve-receipts': multiple,
            'sip-evidence': multiple,
            policy: { type: 'string' },
            format: { type: 'string', default: Format.Json },
          },
          tokens: true,
        }),
      catch: (cause) => graduationInputError(usage, cause),
    })
    for (const flag of ['policy', 'format'])
      if (tokens.filter((token) => token.kind === 'option' && token.name === flag).length > 1)
        return yield* Result.fail(graduationInputError(usage, { kind: 'DuplicateFlag', flag }))
    return yield* Schema.decodeUnknownResult(
      Options,
      strictParseOptions,
    )(values).pipe(Result.mapError((cause) => graduationInputError(usage, cause)))
  })

class NotReady extends Data.TaggedError('NotReady')<{ readonly verdict: Verdict }> {}

export const runLiveGraduation = Effect.fn('bayn.live-graduation.run')(function* (args: readonly string[]) {
  const options = yield* Effect.fromResult(parseOptions(args))
  const now = DateTime.formatIso(yield* DateTime.now)
  const fs = yield* FileSystem.FileSystem
  const read = (paths: readonly string[], flag: string) =>
    Effect.forEach(paths, (path, i) =>
      fs
        .readFile(path)
        .pipe(Effect.mapError((cause) => graduationInputError(`Cannot read ${flag} (input #${i + 1})`, cause))),
    )
  const audits = yield* read(options.audit ?? [], '--audit')
  const sleeveReceipts = yield* read(options['sleeve-receipts'] ?? [], '--sleeve-receipts')
  const sipEvidence = yield* read(options['sip-evidence'] ?? [], '--sip-evidence')
  const [policy] = yield* read(options.policy === undefined ? [] : [options.policy], '--policy')
  const report = yield* Effect.fromResult(
    evaluateLiveGraduation({ audits, sleeveReceipts, sipEvidence, ...(policy === undefined ? {} : { policy }) }, now),
  )
  yield* Console.log(
    options.format === Format.Json ? JSON.stringify(report, null, 2) : renderGraduationMarkdown(report),
  )
  if (report.verdict !== Verdict.Ready) return yield* new NotReady({ verdict: report.verdict })
})

if (import.meta.main) {
  NodeRuntime.runMain(
    runLiveGraduation(process.argv.slice(2)).pipe(
      Effect.tapCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void
        const failure = Cause.findErrorOption(cause)
        if (Option.isSome(failure) && failure.value instanceof NotReady) return Effect.void
        return Console.error(
          JSON.stringify(
            Option.isSome(failure) && failure.value instanceof GraduationInputError
              ? { error: failure.value._tag, message: failure.value.message }
              : { error: 'UnexpectedGraduationFailure' },
          ),
        )
      }),
      // @effect-diagnostics-next-line strictEffectProvide:off -- the CLI owns only local read access
      Effect.provide(NodeFileSystem.layer),
    ),
    { disableErrorReporting: true },
  )
}
