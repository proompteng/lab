import { randomUUID } from 'node:crypto'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Layer, Logger, Result, Schema, Stdio, Stream } from 'effect'

import { canonicalJsonV1Result } from '../src/hash'
import { evidenceArchiveConfig, makeEvidenceArchive } from '../src/research/evidence-archive'
import {
  auditNativeArrivalArchive,
  NativeArrivalArchiveAuditFailure,
} from '../src/research/native-arrival-archive-audit'
import { Sha256Schema, SourceRevisionSchema } from '../src/schemas'
import { currentUtcInstant } from '../src/time'

export const nativeArchiveAuditUsage =
  'Usage: bun tools/native-arrival-archive-audit.ts --capture <sha256> --receipt <sha256> --maximum-pages <1..100000> --source-revision <revision> | --help'

type NativeArchiveAuditCommand =
  | { readonly _tag: 'Help' }
  | ({ readonly _tag: 'Audit' } & Parameters<typeof auditNativeArrivalArchive>[1])

export const parseNativeArchiveAuditArgs = (
  args: readonly string[],
): Result.Result<NativeArchiveAuditCommand, NativeArrivalArchiveAuditFailure> => {
  if (args.length === 1 && args[0] === '--help') return Result.succeed({ _tag: 'Help' } as const)
  const captureId = args[1]
  const receiptHash = args[3]
  const maximumPages = Number(args[5])
  const auditSourceRevision = args[7]
  if (
    args.length !== 8 ||
    args[0] !== '--capture' ||
    args[2] !== '--receipt' ||
    args[4] !== '--maximum-pages' ||
    args[6] !== '--source-revision' ||
    !/^[1-9][0-9]*$/.test(args[5] ?? '') ||
    maximumPages > 100_000 ||
    !Schema.is(Sha256Schema)(captureId) ||
    !Schema.is(Sha256Schema)(receiptHash) ||
    !Schema.is(SourceRevisionSchema)(auditSourceRevision)
  )
    return Result.fail(new NativeArrivalArchiveAuditFailure({ message: nativeArchiveAuditUsage }))
  return Result.succeed({ _tag: 'Audit', captureId, receiptHash, maximumPages, auditSourceRevision } as const)
}

export const runNativeArchiveAuditCommand = (args: readonly string[]) =>
  Effect.gen(function* () {
    const command = yield* Effect.fromResult(parseNativeArchiveAuditArgs(args))
    const stdio = yield* Stdio.Stdio
    const print = (text: string) => Stream.run(Stream.make(`${text}\n`), stdio.stdout())
    if (command._tag === 'Help') return yield* print(nativeArchiveAuditUsage)
    const { _tag, ...input } = command
    const archive = yield* makeEvidenceArchive(yield* evidenceArchiveConfig)
    const prefix = `native-evidence/v1/attempts/${yield* Effect.sync(randomUUID)}/`
    const retain = (key: string, value: unknown) =>
      Effect.fromResult(canonicalJsonV1Result(value)).pipe(
        Effect.flatMap((text) => archive.retain(key, new TextEncoder().encode(text))),
      )
    const started = {
      scope: 'NATIVE_ARRIVAL_ARCHIVE_AUDIT',
      startedAt: yield* currentUtcInstant,
      ...input,
      qualification: 'UNQUALIFIED',
    } as const
    yield* retain(`${prefix}started.json`, started)
    const report = yield* auditNativeArrivalArchive(archive, input).pipe(
      Effect.tapError((error) =>
        Effect.gen(function* () {
          yield* retain(`${prefix}failed.json`, {
            ...started,
            failedAt: yield* currentUtcInstant,
            failure: error.message,
          })
        }).pipe(
          Effect.catchCause(() =>
            Effect.logError('Archive audit attempt remains incomplete; its started receipt is retained'),
          ),
        ),
      ),
    )
    const object = yield* retain(
      `native-evidence/v1/arrivals/${input.captureId}/audits/${report.reportHash}.json`,
      report,
    )
    yield* retain(`${prefix}completed.json`, { ...started, finishedAt: yield* currentUtcInstant, report: object })
    yield* print(
      JSON.stringify({
        attempt: prefix,
        report: object,
        pages: report.pages,
        records: report.records,
        qualification: report.qualification,
        completeSessionCoverage: report.completeSessionCoverage,
      }),
    )
  })

if (import.meta.main)
  NodeRuntime.runMain(
    runNativeArchiveAuditCommand(process.argv.slice(2)).pipe(
      Effect.tapError(() => Effect.logError('Native archive audit did not complete')),
      Effect.scoped,
      // @effect-diagnostics-next-line strictEffectProvide:off -- offline command owns output and scoped storage clients
      Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.withConsoleError(Logger.formatJson)]))),
    ),
    { disableErrorReporting: true },
  )
