import { parseArgs } from 'node:util'

import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Cause, Data, Effect, FileSystem, Option, Redacted, Result, Schema, Stdio, Stream } from 'effect'

import { StrictNonEmptyStringSchema, UtcInstantSchema, strictParseOptions } from '../src/schemas'
import { currentUtcInstant } from '../src/time'
import {
  Block,
  decodeDossierEvidence,
  DossierDecision,
  DossierInputError,
  dossierReport,
  evaluateDossier,
} from './monday-cutover-dossier-core'

const usage = `Usage: bun services/bayn/tools/monday-cutover-dossier.ts --evidence <file.json> [--as-of <UTC instant>]
Reads local evidence only; --as-of is for historical replay (YYYY-MM-DDTHH:mm:ss.sssZ).`

const options = { evidence: { type: 'string' }, 'as-of': { type: 'string' } } as const
const Options = Schema.Struct({
  evidence: StrictNonEmptyStringSchema,
  'as-of': Schema.optionalKey(UtcInstantSchema),
})
class DossierUsageError extends Data.TaggedError('DossierUsageError')<{
  readonly cause: Redacted.Redacted<unknown>
}> {}
class DossierHeld extends Data.TaggedError('DossierHeld') {}

const invalidArgs = (cause: unknown) => new DossierUsageError({ cause: Redacted.make(cause) })
const parseOptions = (args: readonly string[]) =>
  Result.gen(function* () {
    const { tokens, values } = yield* Result.try({
      try: () => parseArgs({ args: [...args], options, tokens: true }),
      catch: invalidArgs,
    })
    const names = tokens.flatMap((token) => (token.kind === 'option' ? [token.name] : []))
    if (names.length !== new Set(names).size) return yield* Result.fail(invalidArgs({ kind: 'DuplicateOption' }))
    return yield* Schema.decodeUnknownResult(Options, strictParseOptions)(values).pipe(Result.mapError(invalidArgs))
  })

export const runMondayCutoverDossier = (args: readonly string[]) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    if (args.length === 1 && args[0] === '--help') return yield* Stream.run(Stream.make(`${usage}\n`), stdio.stdout())
    const opts = yield* Effect.fromResult(parseOptions(args))
    const fs = yield* FileSystem.FileSystem
    const evidence = yield* Effect.result(
      fs.readFileString(opts.evidence).pipe(
        Effect.mapError(
          (cause) =>
            new DossierInputError({
              code: Block.EvidenceUnavailable,
              message: 'Cannot read the local evidence file.',
              cause: Redacted.make(cause),
            }),
        ),
        Effect.flatMap((text) => Effect.fromResult(decodeDossierEvidence(text))),
      ),
    )
    const asOf = opts['as-of'] ?? (yield* currentUtcInstant)
    const report = Result.isSuccess(evidence)
      ? evaluateDossier(evidence.success, asOf)
      : dossierReport(asOf, [{ code: evidence.failure.code, message: evidence.failure.message }])
    const json = JSON.stringify({ ...report, replay: opts['as-of'] !== undefined }, null, 2)
    yield* Stream.run(Stream.make(`${json}\n`), stdio.stdout())
    if (Result.isFailure(evidence)) return yield* evidence.failure
    if (report.decision === DossierDecision.Hold) return yield* new DossierHeld()
  })

if (import.meta.main) {
  NodeRuntime.runMain(
    runMondayCutoverDossier(process.argv.slice(2)).pipe(
      Effect.tapCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void
        const error = Cause.findErrorOption(cause)
        if (Option.isSome(error) && (error.value instanceof DossierHeld || error.value instanceof DossierInputError))
          return Effect.void
        const message =
          Option.isSome(error) && error.value instanceof DossierUsageError
            ? usage
            : 'The dossier could not complete; do not proceed with PR #16395.'
        return Effect.flatMap(Stdio.Stdio, (stdio) => Stream.run(Stream.make(`${message}\n`), stdio.stderr()))
      }),
      // @effect-diagnostics-next-line strictEffectProvide:off -- the CLI owns filesystem and stdio composition
      Effect.provide(NodeServices.layer),
    ),
    { disableErrorReporting: true },
  )
}
