import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { NodeServices } from '@effect/platform-node'
import { Config, ConfigProvider, Effect, FileSystem, Layer, Option, Result, Schema } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
import { backfillAlpacaHistory } from '../../../tools/backfill'
import { publishHistoricalDataset, restoreHistoricalDataset } from '../../../tools/history-store'
import { exportHistoricalDataset } from '../../../tools/history-export'
import {
  openBacktestSource,
  validateBacktestSourceManifest,
  validateBacktestSourceReceipt,
} from '../../intraday-replay/source'
import { sha256 } from '../../hash'
import { readHistoricalDataset, readHistoricalChunk, HistoricalDatasetFailure } from './dataset'
import { baynTestClickhouseUrl, baynTestClickhouseGuardToken } from '../../test-environment.test-support'
import { historyFixtureCredentials, historyFixtureHttp, historyFixtureRequest } from './history-fixture.test-support'

const settings = Effect.runSync(
  Config.all({
    jar: Config.option(Config.string('BAYN_TEST_DORVUD_JAR')),
  }),
)
const featureTest = Option.isSome(settings.jar) ? test : test.skip
const storeTest = baynTestClickhouseUrl === undefined ? test.skip : test
const fixtureLayer = Layer.mergeAll(
  NodeServices.layer,
  Layer.succeed(HttpClient.HttpClient, historyFixtureHttp),
  Layer.succeed(ConfigProvider.ConfigProvider, historyFixtureCredentials),
)

const prepareHistoryStorageFixture = Effect.gen(function* () {
  if (baynTestClickhouseGuardToken === undefined || !/^[a-f0-9]{32}$/.test(baynTestClickhouseGuardToken))
    return yield* new HistoricalDatasetFailure({
      message: 'History integration requires the disposable ClickHouse endpoint guard',
    })
  const sql = yield* ClickhouseClient.ClickhouseClient
  const guard = yield* sql`SELECT toString(token) AS token FROM bayn_ci_guard.endpoint_identity`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ token: Schema.String })))),
  )
  if (guard.length !== 1 || guard[0]?.token !== baynTestClickhouseGuardToken)
    return yield* new HistoricalDatasetFailure({
      message: 'History integration endpoint identity differs from the disposable service',
    })
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(
    fileURLToPath(
      new URL(
        '../../../../../argocd/applications/torghut/clickhouse/historical-datasets-schema-job.yaml',
        import.meta.url,
      ),
    ),
  )
  const yaml = yield* Effect.try({
    try: (): unknown => Bun.YAML.parse(text),
    catch: (cause) => new HistoricalDatasetFailure({ message: 'Historical schema job YAML cannot be parsed', cause }),
  })
  const job = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      spec: Schema.Struct({
        template: Schema.Struct({
          spec: Schema.Struct({ containers: Schema.Array(Schema.Struct({ args: Schema.Array(Schema.String) })) }),
        }),
      }),
    }),
  )(yaml)
  const script = job.spec.template.spec.containers[0]?.args[0]
  if (script === undefined)
    return yield* new HistoricalDatasetFailure({ message: 'Historical schema job has no SQL script' })
  const first = script.indexOf('CREATE DATABASE IF NOT EXISTS signal'),
    last = script.indexOf('SELECT throwIf')
  if (first < 0 || last < first)
    return yield* new HistoricalDatasetFailure({ message: 'Historical schema job has no bounded DDL section' })
  const ddl = script
    .slice(first, last)
    .replaceAll(' ON CLUSTER default', '')
    .replace(/ReplicatedMergeTree\('[^']+', '[^']+'\)/g, 'MergeTree()')
  for (const statement of ddl
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean))
    yield* sql.asCommand(sql.unsafe(statement))
})

featureTest(
  'REST acquisition and shared Dorvud feature production produce a verified two-session engine source',
  async () => {
    if (Option.isNone(settings.jar)) throw new Error('feature jar must be configured')
    const jar = settings.jar.value
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        const datasetDirectory = `${directory}/dataset`,
          output = `${directory}/export`
        const captured = yield* backfillAlpacaHistory(
          { ...historyFixtureRequest, symbols: [...historyFixtureRequest.symbols].reverse() },
          datasetDirectory,
        )
        const universe = {
          universeId: 'history-integration',
          universeSymbolHash: sha256('AAPL,AMD,SPY'),
          symbols: ['AAPL', 'AMD', 'SPY'],
          topics: {
            bars: 'bars',
            quotes: 'quotes',
            trades: 'trades',
            features: 'features',
            technicalFeatures: 'technical-features',
          },
        }
        const exported = yield* exportHistoricalDataset(
          {
            schemaVersion: 'bayn.alpaca-history-export.v1',
            datasetId: captured.datasetId,
            sessionDates: ['2026-09-10', '2026-09-11'],
            universe,
            rawDeliveryDelayMs: 1,
            barFinalizationDelayMs: 10,
            featureProcessingDelayMs: 5,
            featureProducerRevision: '1'.repeat(40),
            featureJarSha256: createHash('sha256')
              .update(yield* fs.readFile(jar))
              .digest('hex'),
          },
          datasetDirectory,
          output,
          jar,
        )
        const manifest = yield* Effect.fromResult(
          validateBacktestSourceManifest(
            yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
              yield* fs.readFileString(`${output}/source.json`),
            ),
          ),
        )
        const receipt = yield* Effect.fromResult(
          validateBacktestSourceReceipt(
            yield* fs.readFileString(`${output}/source-receipt.json`),
            exported.sourceReceiptHash,
          ),
        )
        expect(manifest.transport).toBe('alpaca-rest')
        expect(receipt.value).toMatchObject({
          schemaVersion: 'bayn.alpaca-rest-replay-receipt.v2',
          acquiredSymbols: ['AAPL', 'SPY'],
          unacquiredSymbols: ['AMD'],
        })
        const receiptText = yield* fs.readFileString(`${output}/source-receipt.json`)
        const hiddenMissing = receiptText.replace('"unacquiredSymbols":["AMD"]', '"unacquiredSymbols":[]')
        expect(Result.isFailure(validateBacktestSourceReceipt(hiddenMissing, sha256(hiddenMissing)))).toBe(true)
        expect(manifest.positions).toHaveLength(5)
        for (const topic of [universe.topics.features, universe.topics.technicalFeatures])
          expect(
            Number(manifest.positions.find((position) => position.topic === topic)?.endOffsetExclusive),
          ).toBeGreaterThan(0)
        const source = yield* openBacktestSource(`${output}/arrivals.ndjson.gz`, manifest, '2'.repeat(64), receipt)
        yield* source.finish
        expect(exported.boundaryRecordsExcluded).toBe(0)
        const modified = yield* fs.readFileString(`${output}/source-receipt.json`)
        expect(
          Result.isFailure(
            validateBacktestSourceReceipt(modified.replace('NOT_OBSERVED', 'OBSERVED'), exported.sourceReceiptHash),
          ),
        ).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(fixtureLayer)),
    )
  },
  60_000,
)

storeTest(
  'historical batch readback uses bounded indexed reads for a large quote capture',
  async () => {
    const quotes = HttpClient.make((request) => {
      const url = new URL(request.url)
      for (const [key, value] of request.urlParams) url.searchParams.set(key, value)
      if (!url.pathname.endsWith('/quotes')) return historyFixtureHttp.execute(request)
      const page = Number(url.searchParams.get('page_token') ?? '0')
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              quotes: {
                SPY: Array.from({ length: 10_000 }, (_, index) => ({
                  t: new Date(Date.parse('2026-09-11T13:30:00Z') + page * 10_000 + index).toISOString(),
                  bp: 100,
                  bs: 10,
                  ap: 100.1,
                  as: 20,
                  bx: 'V',
                  ax: 'V',
                  c: ['R'],
                  z: 'C',
                })),
              },
              next_page_token: page < 9 ? String(page + 1) : null,
            }),
            { status: 200 },
          ),
        ),
      )
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* prepareHistoryStorageFixture
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        const captured = yield* backfillAlpacaHistory(
          { ...historyFixtureRequest, symbols: ['SPY'], executionSessions: ['2026-09-11'] },
          directory,
        )
        yield* publishHistoricalDataset(directory, captured.datasetId)
        const sql = yield* ClickhouseClient.ClickhouseClient
        const queryId = sha256(directory)
        const verified = yield* publishHistoricalDataset(directory, captured.datasetId).pipe(
          sql.withQueryId(queryId),
          sql.withClickhouseSettings({ log_queries: 1 }),
        )
        expect(verified.insertedRecords).toBe(0)
        expect(verified.verifiedRecords).toBe(captured.records)
        yield* sql.asCommand(sql`SYSTEM FLUSH LOGS`)
        const reads = yield* sql`SELECT toString(sum(read_rows)) AS rows FROM system.query_log
          WHERE query_id = ${queryId} AND type = 'QueryFinish' AND query_kind = 'Select'`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ rows: Schema.String })))),
        )
        expect(reads).toHaveLength(1)
        expect(Number(reads[0]?.rows)).toBeGreaterThan(0)
        expect(Number(reads[0]?.rows)).toBeLessThan(captured.records * 15)
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(HttpClient.HttpClient, quotes),
            Layer.succeed(ConfigProvider.ConfigProvider, historyFixtureCredentials),
            ClickhouseClient.layer({
              url: baynTestClickhouseUrl ?? 'http://127.0.0.1:8123',
              username: 'default',
              password: '',
              request_timeout: 10_000,
              compression: { request: true, response: true },
            }),
          ),
        ),
      ),
    )
  },
  120_000,
)

storeTest(
  'ClickHouse publication is resumable, verifies exact records, and restores the identical frozen dataset',
  async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* prepareHistoryStorageFixture
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        const source = `${directory}/source`,
          restored = `${directory}/restored`
        const captured = yield* backfillAlpacaHistory(historyFixtureRequest, source)
        const first = yield* publishHistoricalDataset(source, captured.datasetId)
        expect(first.insertedRecords).toBe(captured.records)
        const second = yield* publishHistoricalDataset(source, captured.datasetId)
        expect(second.insertedRecords).toBe(0)
        expect(second.verifiedRecords).toBe(captured.records)
        const readback = yield* restoreHistoricalDataset(captured.datasetId, restored)
        expect(readback.records).toBe(captured.records)
        const dataset = yield* readHistoricalDataset(restored, captured.datasetId)
        expect(yield* fs.readFileString(`${restored}/dataset.json`)).toBe(
          yield* fs.readFileString(`${source}/dataset.json`),
        )
        const chunk = dataset.manifest.chunks[0]
        if (chunk === undefined) throw new Error('expected a historical chunk')
        yield* fs.writeFileString(`${restored}/${chunk.path}`, '{}')
        expect(Result.isFailure(yield* Effect.result(readHistoricalChunk(dataset, chunk)))).toBe(true)
        const sql = yield* ClickhouseClient.ClickhouseClient
        const conflict = { dataset_id: captured.datasetId, query_hash: chunk.queryHash, metadata: '{}' }
        yield* sql.insertQuery({
          table: 'signal.historical_dataset_chunks_v1',
          values: [conflict],
          format: 'JSONEachRow',
        })
        expect(Result.isFailure(yield* Effect.result(publishHistoricalDataset(source, captured.datasetId)))).toBe(true)
        expect(
          Result.isFailure(
            yield* Effect.result(restoreHistoricalDataset(captured.datasetId, `${directory}/conflicting`)),
          ),
        ).toBe(true)
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            fixtureLayer,
            ClickhouseClient.layer({
              url: baynTestClickhouseUrl ?? 'http://127.0.0.1:8123',
              username: 'default',
              password: '',
              request_timeout: 10_000,
              compression: { request: true, response: true },
            }),
          ),
        ),
      ),
    )
  },
  60_000,
)
