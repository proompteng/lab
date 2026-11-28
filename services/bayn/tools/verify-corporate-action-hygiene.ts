import { NodeFileSystem, NodeRuntime } from '@effect/platform-node'
import { Cause, Console, Effect, FileSystem, Option, Result, Schema } from 'effect'

import { StrictNonEmptyStringSchema } from '../src/schemas'
import {
  decodeCorporateActionHygieneEvidence,
  HygieneErrorCode,
  hygieneError,
  HygieneStatus,
  verifyCorporateActionHygiene,
} from './corporate-action-hygiene-core'

const usage = 'Usage: bun services/bayn/tools/verify-corporate-action-hygiene.ts --input <evidence.json>'
const decodeArgs = Schema.decodeUnknownResult(Schema.Tuple([Schema.Literal('--input'), StrictNonEmptyStringSchema]))

export const runCorporateActionHygiene = Effect.fn('bayn.corporate-action-hygiene.verify')(function* (
  args: readonly string[],
) {
  if (args.length === 1 && args[0] === '--help') return yield* Console.log(usage)
  const [, path] = yield* Effect.fromResult(
    decodeArgs(args).pipe(
      Result.mapError((cause) => hygieneError(HygieneErrorCode.InvalidArguments, cause, { usage })),
    ),
  )
  const fs = yield* FileSystem.FileSystem
  const json = yield* fs
    .readFileString(path)
    .pipe(
      Effect.mapError((cause) => hygieneError(HygieneErrorCode.ReadEvidenceFailed, cause, { kind: cause.reason._tag })),
    )
  const evidence = yield* Effect.fromResult(decodeCorporateActionHygieneEvidence(json))
  const report = verifyCorporateActionHygiene(evidence)
  yield* Console.log(JSON.stringify(report))
  if (report.status === HygieneStatus.Fail) return yield* hygieneError(HygieneErrorCode.RejectedEvidence, report)
})

if (import.meta.main) {
  NodeRuntime.runMain(
    runCorporateActionHygiene(process.argv.slice(2)).pipe(
      Effect.tapCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void
        const failure = Cause.findErrorOption(cause)
        if (Option.isNone(failure)) return Console.error(JSON.stringify({ code: 'UnexpectedDefect' }))
        const { code, details } = failure.value
        // A rejected, decoded report is already on stdout. Operational failures never print the input or file path.
        return code === HygieneErrorCode.RejectedEvidence
          ? Effect.void
          : Console.error(JSON.stringify({ code, details }))
      }),
      // @effect-diagnostics-next-line strictEffectProvide:off -- the CLI is the local file system composition root
      Effect.provide(NodeFileSystem.layer),
    ),
    { disableErrorReporting: true },
  )
}
