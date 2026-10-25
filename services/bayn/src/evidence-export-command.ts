import { randomUUID } from 'node:crypto'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Config, Effect, Layer, Logger, Result, Schema, Stdio, Stream } from 'effect'

import { embeddedBuildMetadata } from './build'
import { PostgresClientLive } from './db/postgres-client'
import { evidenceReaderUrl } from './db/evidence-reader'
import {
  readNativeArrivalChunks,
  readNativeArrivalEnd,
  readNativeArrivalEpochRecord,
} from './db/native-arrival-postgres'
import { canonicalJsonV1Result } from './hash'
import { evidenceArchiveConfig, makeEvidenceArchive } from './research/evidence-archive'
import { exportNativeArrivalPrefix, NativeArrivalExportFailure } from './research/native-arrival-export'
import { IsoDateSchema, Sha256Schema, SourceRevisionSchema, strictParseOptions } from './schemas'
import { currentUtcInstant } from './time'

export const evidenceExportUsage =
  'Usage: bayn-evidence-export (--capture <sha256> | --arrivals-since YYYY-MM-DD) --maximum-pages <1..256> | --help'
type Command =
  | { readonly _tag: 'Help' }
  | {
      readonly _tag: 'Export'
      readonly selector: { readonly captureId: string } | { readonly since: string }
      readonly maximumPages: number
    }
export const parseEvidenceExportArgs = (
  args: readonly string[],
): Result.Result<Command, NativeArrivalExportFailure> => {
  if (args.length === 1 && args[0] === '--help') return Result.succeed({ _tag: 'Help' })
  const maximumPages = Number(args[3])
  const value = args[1]
  if (
    args.length !== 4 ||
    args[2] !== '--maximum-pages' ||
    value === undefined ||
    !/^[1-9][0-9]*$/.test(args[3] ?? '') ||
    maximumPages > 256 ||
    (args[0] === '--capture'
      ? !Schema.is(Sha256Schema)(value)
      : args[0] !== '--arrivals-since' || !Schema.is(IsoDateSchema)(value))
  )
    return Result.fail(new NativeArrivalExportFailure({ message: evidenceExportUsage }))
  return Result.succeed({
    _tag: 'Export',
    selector: args[0] === '--capture' ? { captureId: value } : { since: value },
    maximumPages,
  })
}
export const evidenceExportConfig = Config.all({
  sourceRevision:
    embeddedBuildMetadata === undefined
      ? Config.schema(SourceRevisionSchema, 'BAYN_CODE_REVISION')
      : Config.succeed(embeddedBuildMetadata.sourceRevision),
  url: Config.Redacted('BAYN_POSTGRES_URL'),
  tls: Config.Boolean('BAYN_POSTGRES_TLS').pipe(Config.withDefault(true)),
  caPath: Config.String('BAYN_POSTGRES_CA_PATH').pipe(Config.withDefault('/var/run/secrets/bayn/postgres/ca.crt')),
})
const encode = (value: unknown) =>
  canonicalJsonV1Result(value).pipe(Result.map((text) => new TextEncoder().encode(text)))
export const runEvidenceExportCommand = (args: readonly string[]) =>
  Effect.gen(function* () {
    const command = yield* Effect.fromResult(parseEvidenceExportArgs(args))
    const stdio = yield* Stdio.Stdio
    const print = (text: string) => Stream.run(Stream.make(`${text}\n`), stdio.stdout())
    if (command._tag === 'Help') return yield* print(evidenceExportUsage)
    const config = yield* evidenceExportConfig
    const reader = { ...config, url: yield* Effect.fromResult(evidenceReaderUrl(config.url)) }
    const storage = yield* evidenceArchiveConfig
    const archive = yield* makeEvidenceArchive(storage)
    const id = yield* Effect.sync(randomUUID)
    const prefix = `native-evidence/v1/attempts/${id}/`
    const started = {
      schemaVersion: 'bayn.native-evidence-attempt.v1',
      sourceRevision: config.sourceRevision,
      startedAt: yield* currentUtcInstant,
      selector: command.selector,
      maximumPages: command.maximumPages,
      scope: 'NATIVE_ARRIVALS',
      qualification: 'UNQUALIFIED',
    } as const
    yield* archive.retain(`${prefix}started.json`, yield* Effect.fromResult(encode(started)))
    const program = Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const captures =
        'captureId' in command.selector
          ? [{ captureId: command.selector.captureId }]
          : yield* Schema.decodeUnknownEffect(
              Schema.Array(Schema.Struct({ captureId: Sha256Schema })),
              strictParseOptions,
            )(
              yield* sql`
      SELECT epoch.capture_id AS "captureId" FROM native_arrival_epochs AS epoch
      LEFT JOIN LATERAL (
        SELECT header::jsonb->>'lastAvailableAtMs' AS last_ms FROM native_arrival_chunks
        WHERE capture_id=epoch.capture_id ORDER BY ordinal DESC LIMIT 1
      ) AS tail ON true
      WHERE epoch.recorded_at >= ${`${command.selector.since}T00:00:00.000Z`}::timestamptz
        OR tail.last_ms::numeric >= extract(epoch FROM ${`${command.selector.since}T00:00:00.000Z`}::timestamptz) * 1000
      ORDER BY epoch.recorded_at,epoch.capture_id LIMIT 1025
    `,
            )
      if (captures.length > 1024)
        return yield* new NativeArrivalExportFailure({
          message: 'Native capture catalog exceeds its complete inventory bound',
        })
      const catalog = {
        schemaVersion: 'bayn.native-arrival-export-catalog.v1',
        observedAt: yield* currentUtcInstant,
        selector: command.selector,
        captures,
        qualification: 'UNQUALIFIED',
      } as const
      yield* archive.retain(`${prefix}catalog.json`, yield* Effect.fromResult(encode(catalog)))
      const receipts: {
        readonly captureId: string
        readonly receiptHash: string
        readonly caughtUpToReadCut: boolean
      }[] = []
      let remaining = command.maximumPages
      for (const capture of captures) {
        if (remaining === 0) break
        const receipt = yield* exportNativeArrivalPrefix(
          {
            epoch: readNativeArrivalEpochRecord(sql, capture.captureId),
            chunks: (after) => readNativeArrivalChunks(sql, capture.captureId, after, 8),
            end: readNativeArrivalEnd(sql, capture.captureId),
          },
          archive,
          remaining,
        )
        remaining -= receipt.pagesWritten
        receipts.push({
          captureId: capture.captureId,
          receiptHash: receipt.receiptHash,
          caughtUpToReadCut: receipt.caughtUpToReadCut,
        })
      }
      const completed = {
        ...started,
        finishedAt: yield* currentUtcInstant,
        captures: receipts,
        deferredCaptureIds: captures.slice(receipts.length).map((capture) => capture.captureId),
        pagesWritten: command.maximumPages - remaining,
        completeSessionCoverage: false,
      }
      yield* archive.retain(`${prefix}completed.json`, yield* Effect.fromResult(encode(completed)))
      return {
        attempt: prefix,
        captureCount: captures.length,
        exportedCaptures: receipts.length,
        pagesWritten: completed.pagesWritten,
        qualification: completed.qualification,
        completeSessionCoverage: false,
      }
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- independent export owns its bounded read-only database connection
      Effect.provide(
        PostgresClientLive(
          { operationTimeoutMs: 15_000, postgres: reader },
          { maxConnections: 1, applicationName: 'bayn-evidence-export' },
        ),
      ),
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          if (exit._tag === 'Success') return
          const body = yield* Effect.fromResult(
            encode({
              ...started,
              failedAt: yield* currentUtcInstant,
              outcome: 'INCOMPLETE',
              failure: 'Export did not complete; inspect the exact retained attempt and previous checkpoints.',
            }),
          )
          yield* archive.retain(`${prefix}failed.json`, body)
        }).pipe(
          Effect.timeout('15 seconds'),
          Effect.catchCause(() =>
            Effect.logError('Evidence attempt remains incomplete; its started receipt is retained'),
          ),
        ),
      ),
      Effect.timeout('3 minutes'),
    )
    yield* print(JSON.stringify(yield* program))
  })

if (import.meta.main)
  NodeRuntime.runMain(
    runEvidenceExportCommand(process.argv.slice(2)).pipe(
      Effect.tapError(() =>
        Effect.logError('Native evidence export did not complete; no financial operation was requested'),
      ),
      Effect.scoped,
      // @effect-diagnostics-next-line strictEffectProvide:off -- command owns standard output, files and scoped SDK clients
      Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.withConsoleError(Logger.formatJson)]))),
    ),
    { disableErrorReporting: true },
  )
