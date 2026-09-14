import { ClickhouseClient } from '@effect/sql-clickhouse'
import { DateTime, Effect, FileSystem, Schema } from 'effect'
import { canonicalJsonV1Result, sha256 } from '../src/hash'
import {
  HistoricalDatasetFailure,
  decodeHistoricalManifest,
  readHistoricalChunk,
  readHistoricalDataset,
  type HistoricalDataset,
  type HistoricalChunk,
} from '../src/market-data/alpaca-history/dataset'
import { StoredHistoricalCaptureSchema, type StoredHistoricalCapture } from '../src/market-data/alpaca-history/model'
import { Sha256Schema, UnsignedMicrosSchema, strictParseOptions } from '../src/schemas'
import { writeImmutableDatasetFile } from './backfill'

const MarketRecordSchema = Schema.Struct({
  record_id: Sha256Schema,
  row_ordinal: UnsignedMicrosSchema,
  provider: Schema.Literal('alpaca'),
  transport: Schema.Literal('historical-rest'),
  feed: Schema.Literal('iex'),
  session_date: Schema.String,
  symbol: Schema.String,
  kind: Schema.Literals(['bars', 'quotes', 'trades']),
  event_at: Schema.String,
  retrieved_at: Schema.String,
  payload: Schema.String,
})
const decodeRecords = Schema.decodeUnknownEffect(Schema.Array(MarketRecordSchema), strictParseOptions)
const decodeMetadataRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ metadata: Schema.String })),
  strictParseOptions,
)
const storageBatchSize = 5000
const timestamp = (instant: string) => instant.replace('T', ' ').replace(/Z$/, '')
const encode = (value: unknown) => Effect.fromResult(canonicalJsonV1Result(value))
const readRecords = (datasetId: string, chunk: HistoricalChunk, first: number, last: number) =>
  Effect.gen(function* () {
    const sql = yield* ClickhouseClient.ClickhouseClient
    return yield* sql`
    SELECT DISTINCT record_id, toString(row_ordinal) AS row_ordinal, provider, transport, feed,
      toString(session_date) AS session_date, symbol, kind, toString(event_at) AS event_at,
      toString(retrieved_at) AS retrieved_at, payload
    FROM signal.historical_market_records_v1
    WHERE dataset_id = ${datasetId} AND query_hash = ${chunk.queryHash}
      AND toUInt64(row_ordinal) >= ${sql.param('UInt64', first)} AND toUInt64(row_ordinal) < ${sql.param('UInt64', last)}
    ORDER BY toUInt64(row_ordinal)
  `.pipe(Effect.flatMap(decodeRecords))
  })
const checkStoredBounds = (datasetId: string, chunk: HistoricalChunk, complete: boolean) =>
  Effect.gen(function* () {
    const sql = yield* ClickhouseClient.ClickhouseClient
    const rows =
      yield* sql`SELECT toString(uniqExact(row_ordinal)) AS records, toString(countIf(row_ordinal >= ${sql.param('UInt64', chunk.rowCount)})) AS outside
    FROM signal.historical_market_records_v1 WHERE dataset_id = ${datasetId} AND query_hash = ${chunk.queryHash}`.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ records: UnsignedMicrosSchema, outside: UnsignedMicrosSchema })),
            strictParseOptions,
          ),
        ),
      )
    const counts = rows[0]
    if (
      rows.length !== 1 ||
      counts === undefined ||
      counts.outside !== '0' ||
      (complete && counts.records !== String(chunk.rowCount))
    )
      return yield* new HistoricalDatasetFailure({ message: `Historical stored row bounds differ: ${chunk.queryHash}` })
  })
const expectedRecords = (
  dataset: HistoricalDataset,
  chunk: HistoricalChunk,
  capture: StoredHistoricalCapture,
  first: number,
) =>
  Effect.forEach(capture.rows.slice(first, first + storageBatchSize), (row, index) =>
    Effect.gen(function* () {
      const ordinal = first + index
      return {
        dataset_id: dataset.manifest.datasetId,
        query_hash: chunk.queryHash,
        record_id: sha256(`${dataset.manifest.datasetId}:${chunk.queryHash}:${ordinal}`),
        row_ordinal: String(ordinal),
        provider: 'alpaca' as const,
        transport: 'historical-rest' as const,
        feed: 'iex' as const,
        session_date: chunk.sessionDate,
        symbol: row.symbol,
        kind: capture.kind,
        event_at: timestamp(row.eventAt),
        retrieved_at: timestamp(capture.provenance.retrievedAt),
        payload: yield* encode(row),
      }
    }),
  )

/** Offline writer. A dataset is published only after every chunk has exact readback. */
export const publishHistoricalDataset = (directory: string, datasetId: string) =>
  Effect.gen(function* () {
    const sql = yield* ClickhouseClient.ClickhouseClient
    const dataset = yield* readHistoricalDataset(directory, datasetId)
    let inserted = 0
    for (const chunk of dataset.manifest.chunks) {
      const capture = yield* readHistoricalChunk(dataset, chunk)
      yield* checkStoredBounds(datasetId, chunk, false)
      let chunkInserted = 0
      for (let first = 0; first < chunk.rowCount; first += storageBatchSize) {
        const expected = yield* expectedRecords(dataset, chunk, capture, first)
        const present = yield* readRecords(datasetId, chunk, first, first + storageBatchSize)
        const presentOrdinals = new Set<string>()
        for (const row of present) {
          const expectedRow = expected[Number(row.row_ordinal) - first]
          if (expectedRow === undefined || presentOrdinals.has(row.row_ordinal))
            return yield* new HistoricalDatasetFailure({
              message: `Historical storage has unexpected or conflicting rows: ${chunk.queryHash}`,
            })
          const { dataset_id: _datasetId, query_hash: _queryHash, ...fields } = expectedRow
          if ((yield* encode(row)) !== (yield* encode(fields)))
            return yield* new HistoricalDatasetFailure({
              message: `Historical storage differs from its immutable dataset: ${chunk.queryHash}:${row.row_ordinal}`,
            })
          presentOrdinals.add(row.row_ordinal)
        }
        const missing = expected.filter((row) => !presentOrdinals.has(row.row_ordinal))
        if (missing.length > 0)
          yield* sql
            .insertQuery({ table: 'signal.historical_market_records_v1', values: missing, format: 'JSONEachRow' })
            .pipe(Effect.timeout('60 seconds'))
        chunkInserted += missing.length
        const verified = yield* readRecords(datasetId, chunk, first, first + storageBatchSize)
        if (verified.length !== expected.length)
          return yield* new HistoricalDatasetFailure({
            message: `Historical storage count differs after insertion: ${chunk.queryHash}`,
          })
        for (const [ordinal, row] of verified.entries()) {
          const expectedRow = expected[ordinal]
          if (expectedRow === undefined)
            return yield* new HistoricalDatasetFailure({
              message: 'Historical verification exceeded its declared count',
            })
          const { dataset_id: _datasetId, query_hash: _queryHash, ...fields } = expectedRow
          if ((yield* encode(row)) !== (yield* encode(fields)))
            return yield* new HistoricalDatasetFailure({
              message: `Historical storage readback differs: ${chunk.queryHash}:${ordinal}`,
            })
        }
      }
      yield* checkStoredBounds(datasetId, chunk, true)
      const metadata = yield* encode({
        kind: capture.kind,
        provenance: capture.provenance,
        provenanceHash: capture.provenanceHash,
      })
      const metadataRows =
        yield* sql`SELECT DISTINCT metadata FROM signal.historical_dataset_chunks_v1 WHERE dataset_id = ${datasetId} AND query_hash = ${chunk.queryHash}`.pipe(
          Effect.flatMap(decodeMetadataRows),
        )
      if (metadataRows.length > 1 || (metadataRows.length === 1 && metadataRows[0]?.['metadata'] !== metadata))
        return yield* new HistoricalDatasetFailure({
          message: `Historical chunk metadata conflicts: ${chunk.queryHash}`,
        })
      if (metadataRows.length === 0)
        yield* sql.insertQuery({
          table: 'signal.historical_dataset_chunks_v1',
          values: [{ dataset_id: datasetId, query_hash: chunk.queryHash, metadata }],
          format: 'JSONEachRow',
        })
      inserted += chunkInserted
      yield* Effect.logInfo('Historical chunk verified in ClickHouse').pipe(
        Effect.annotateLogs({
          sessionDate: chunk.sessionDate,
          kind: chunk.kind,
          records: chunk.rowCount,
          inserted: chunkInserted,
        }),
      )
    }
    const header = {
      dataset_id: datasetId,
      manifest: dataset.manifestText,
      coverage: dataset.coverageText,
      calendar: dataset.calendarText,
    }
    const existing = yield* readDatasetHeader(datasetId)
    if (
      existing.length > 1 ||
      (existing[0] !== undefined &&
        (existing[0].manifest !== header.manifest ||
          existing[0].coverage !== header.coverage ||
          existing[0].calendar !== header.calendar))
    )
      return yield* new HistoricalDatasetFailure({
        message: 'Published historical manifest conflicts with the frozen dataset',
      })
    if (existing.length === 0)
      yield* sql.insertQuery({
        table: 'signal.historical_datasets_v1',
        values: [{ ...header, archived_at: timestamp(DateTime.formatIso(yield* DateTime.now)) }],
        format: 'JSONEachRow',
      })
    const confirmed = yield* readDatasetHeader(datasetId)
    if (
      confirmed.length !== 1 ||
      confirmed[0]?.manifest !== header.manifest ||
      confirmed[0]?.coverage !== header.coverage ||
      confirmed[0]?.calendar !== header.calendar
    )
      return yield* new HistoricalDatasetFailure({
        message: 'Historical publication completion marker failed readback',
      })
    return {
      datasetId,
      insertedRecords: inserted,
      verifiedRecords: dataset.manifest.recordCount,
      chunks: dataset.manifest.chunks.length,
    }
  })
const readDatasetHeader = (datasetId: string) =>
  Effect.gen(function* () {
    const sql = yield* ClickhouseClient.ClickhouseClient
    return yield* sql`SELECT DISTINCT manifest, coverage, calendar FROM signal.historical_datasets_v1 WHERE dataset_id = ${datasetId}`.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ manifest: Schema.String, coverage: Schema.String, calendar: Schema.String })),
          strictParseOptions,
        ),
      ),
    )
  })

/** Readback reconstructs the identical pinned source files; backtesting has no storage-specific engine. */
export const restoreHistoricalDataset = (datasetId: string, directory: string) =>
  Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(Sha256Schema)(datasetId)
    const sql = yield* ClickhouseClient.ClickhouseClient
    const fs = yield* FileSystem.FileSystem
    const rows = yield* readDatasetHeader(datasetId)
    const header = rows[0]
    if (rows.length !== 1 || header === undefined)
      return yield* new HistoricalDatasetFailure({
        message: 'Historical dataset is absent, unpublished or has conflicting manifests',
      })
    const manifest = yield* Effect.fromResult(decodeHistoricalManifest(header.manifest, datasetId))
    if (sha256(header.coverage) !== manifest.coverage.sha256 || sha256(header.calendar) !== manifest.calendar.sha256)
      return yield* new HistoricalDatasetFailure({ message: 'Stored historical coverage or calendar checksum differs' })
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
    yield* fs.makeDirectory(`${directory}/chunks`, { recursive: true, mode: 0o700 })
    yield* writeImmutableDatasetFile(`${directory}/calendar.json`, header.calendar)
    yield* writeImmutableDatasetFile(`${directory}/coverage.json`, header.coverage)
    yield* writeImmutableDatasetFile(`${directory}/request.json`, `${yield* encode(manifest.request)}\n`)
    for (const chunk of manifest.chunks) {
      const metadataRows =
        yield* sql`SELECT DISTINCT metadata FROM signal.historical_dataset_chunks_v1 WHERE dataset_id = ${datasetId} AND query_hash = ${chunk.queryHash}`.pipe(
          Effect.flatMap(decodeMetadataRows),
        )
      const metadataText = metadataRows[0]?.['metadata']
      if (metadataRows.length !== 1 || metadataText === undefined)
        return yield* new HistoricalDatasetFailure({
          message: `Historical chunk metadata is absent or ambiguous: ${chunk.queryHash}`,
        })
      const metadata = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
      )(metadataText)
      yield* checkStoredBounds(datasetId, chunk, true)
      const values: unknown[] = []
      for (let first = 0; first < chunk.rowCount; first += storageBatchSize) {
        const records = yield* readRecords(datasetId, chunk, first, first + storageBatchSize)
        const expected = Math.min(storageBatchSize, chunk.rowCount - first)
        if (
          records.length !== expected ||
          records.some(
            (row, index) =>
              row.row_ordinal !== String(first + index) ||
              row.record_id !== sha256(`${datasetId}:${chunk.queryHash}:${first + index}`),
          )
        )
          return yield* new HistoricalDatasetFailure({
            message: `Historical stored rows are incomplete or conflicting: ${chunk.queryHash}`,
          })
        for (const row of records)
          values.push(yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(row.payload))
      }
      const capture = yield* Schema.decodeUnknownEffect(
        StoredHistoricalCaptureSchema,
        strictParseOptions,
      )({ ...metadata, rows: values })
      const text = `${yield* encode(capture)}\n`
      if (sha256(text) !== chunk.sha256)
        return yield* new HistoricalDatasetFailure({
          message: `Reconstructed historical chunk checksum differs: ${chunk.queryHash}`,
        })
      yield* writeImmutableDatasetFile(`${directory}/${chunk.path}`, text)
    }
    yield* writeImmutableDatasetFile(`${directory}/dataset.json`, header.manifest)
    const dataset = yield* readHistoricalDataset(directory, datasetId)
    for (const chunk of dataset.manifest.chunks) yield* readHistoricalChunk(dataset, chunk)
    return { datasetId, records: manifest.recordCount, chunks: manifest.chunks.length }
  })
