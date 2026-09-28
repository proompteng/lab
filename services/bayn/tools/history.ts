import { ClickhouseClient } from '@effect/sql-clickhouse'
import { NodeHttpClient, NodeRuntime, NodeServices } from '@effect/platform-node'
import { Config, Effect, FileSystem, Layer, Logger, Redacted, Schema, Stdio, Stream } from 'effect'
import { HistoricalDatasetFailure, HistoricalDatasetRequestSchema } from '../src/market-data/alpaca-history/dataset'
import { Sha256Schema, StrictNonEmptyStringSchema, strictParseOptions } from '../src/schemas'
import { canonicalJsonV1Result } from '../src/hash'
import { backfillAlpacaHistory, writeImmutableDatasetFile } from './backfill'
import { HistoricalExportRequestSchema, exportHistoricalDataset } from './history-export'
import { publishHistoricalDataset, restoreHistoricalDataset } from './history-store'

const HistoryJobSchema = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal('acquire'),
    request: HistoricalDatasetRequestSchema,
    outputDirectory: StrictNonEmptyStringSchema,
  }),
  Schema.Struct({
    operation: Schema.Literal('export'),
    request: HistoricalExportRequestSchema,
    datasetDirectory: StrictNonEmptyStringSchema,
    outputDirectory: StrictNonEmptyStringSchema,
    featureJar: StrictNonEmptyStringSchema,
  }),
  Schema.Struct({
    operation: Schema.Literal('publish'),
    datasetId: Sha256Schema,
    datasetDirectory: StrictNonEmptyStringSchema,
    receiptPath: StrictNonEmptyStringSchema,
  }),
  Schema.Struct({
    operation: Schema.Literal('restore'),
    datasetId: Sha256Schema,
    outputDirectory: StrictNonEmptyStringSchema,
  }),
])
export const runHistoryJob = (input: unknown) =>
  Effect.gen(function* () {
    const job = yield* Schema.decodeUnknownEffect(HistoryJobSchema, strictParseOptions)(input)
    if (job.operation === 'acquire') return yield* backfillAlpacaHistory(job.request, job.outputDirectory)
    if (job.operation === 'export')
      return yield* exportHistoricalDataset(job.request, job.datasetDirectory, job.outputDirectory, job.featureJar)
    const storage = yield* Config.all({
      url: Config.string('BAYN_HISTORY_CLICKHOUSE_URL'),
      username: Config.string('BAYN_HISTORY_CLICKHOUSE_USERNAME'),
      password: Config.redacted('BAYN_HISTORY_CLICKHOUSE_PASSWORD'),
    })
    const program = Effect.gen(function* () {
      if (job.operation === 'publish')
        return yield* publishHistoricalDataset(job.datasetDirectory, job.datasetId).pipe(
          Effect.tap((result) =>
            Effect.fromResult(
              canonicalJsonV1Result({
                schemaVersion: 'bayn.historical-publication-receipt.v1',
                datasetId: result.datasetId,
                verifiedRecords: result.verifiedRecords,
                chunks: result.chunks,
              }),
            ).pipe(Effect.flatMap((text) => writeImmutableDatasetFile(job.receiptPath, `${text}\n`))),
          ),
        )
      return yield* restoreHistoricalDataset(job.datasetId, job.outputDirectory)
    })
    return yield* program.pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- offline storage boundary owns the explicitly configured administrative client
      Effect.provide(
        ClickhouseClient.layer({
          url: storage.url,
          username: storage.username,
          password: Redacted.value(storage.password),
          request_timeout: 60_000,
          compression: { request: true, response: true },
        }),
      ),
    )
  })
const usage =
  'Usage: history --input <job.json> | --help. Job operation: acquire, publish, restore or export. This tool is outside the Bayn service image.'
const main = Effect.scoped(
  Effect.gen(function* () {
    const args = process.argv.slice(2)
    const stdio = yield* Stdio.Stdio
    if (args.length === 1 && args[0] === '--help') return yield* Stream.run(Stream.make(`${usage}\n`), stdio.stdout())
    if (args.length !== 2 || args[0] !== '--input' || args[1] === undefined || args[1].trim() === '')
      return yield* new HistoricalDatasetFailure({ message: usage })
    const fs = yield* FileSystem.FileSystem
    const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
      yield* fs.readFileString(args[1]),
    )
    const result = yield* runHistoryJob(input)
    yield* Effect.logInfo('Historical workflow completed').pipe(Effect.annotateLogs(result))
  }),
)
if (import.meta.main)
  NodeRuntime.runMain(
    main.pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- offline entry point owns platform, HTTP and scoped child process resources
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp, Logger.layer([Logger.consoleJson])),
      ),
    ),
  )
