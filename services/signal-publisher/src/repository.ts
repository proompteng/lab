import { createHash } from 'node:crypto'

import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect, Schema } from 'effect'

import {
  adjustment,
  calendarTimeZone,
  IsoDateSchema,
  manifestSchemaVersion,
  MarketTimeSchema,
  provider,
  SnapshotIdSchema,
  type BarRow,
  type ManifestRow,
  type SessionRow,
} from './domain'
import { publicationError, type PublicationError } from './errors'

export interface SnapshotRepository {
  readonly loadBars: (snapshotId: string) => Effect.Effect<readonly BarRow[], PublicationError>
  readonly loadSessions: (snapshotId: string) => Effect.Effect<readonly SessionRow[], PublicationError>
  readonly loadManifests: (snapshotId: string) => Effect.Effect<readonly ManifestRow[], PublicationError>
  readonly insertBars: (snapshotId: string, rows: readonly BarRow[]) => Effect.Effect<void, PublicationError>
  readonly insertSessions: (snapshotId: string, rows: readonly SessionRow[]) => Effect.Effect<void, PublicationError>
  readonly insertManifest: (row: ManifestRow) => Effect.Effect<void, PublicationError>
}

const Symbol = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9.-]{0,14}$/))
const FixedDecimal = Schema.String.check(Schema.isPattern(/^(?:0|[1-9]\d*)\.\d{8}$/))
const Digits = Schema.String.check(Schema.isPattern(/^\d+$/))
const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const SourceRevision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))
const ImageRepository = Schema.String.check(Schema.isPattern(/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+$/))
const ImageDigest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/))
const NonEmptyString = Schema.Trim.check(Schema.isMinLength(1))
const FinalizedAt = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/))

const BarRowSchema = Schema.Struct({
  snapshot_id: SnapshotIdSchema,
  symbol: Symbol,
  session_date: IsoDateSchema,
  adjusted_open: FixedDecimal,
  adjusted_high: FixedDecimal,
  adjusted_low: FixedDecimal,
  adjusted_close: FixedDecimal,
  adjusted_volume: FixedDecimal,
  trade_count: Digits,
  vwap: Schema.NullOr(FixedDecimal),
  provider: Schema.Literal(provider),
  source_feed: Schema.Literals(['iex', 'sip']),
  adjustment: Schema.Literal(adjustment),
  publication_asof: IsoDateSchema,
})
const SessionRowSchema = Schema.Struct({
  snapshot_id: SnapshotIdSchema,
  calendar_version: NonEmptyString,
  session_date: IsoDateSchema,
  open_time: MarketTimeSchema,
  close_time: MarketTimeSchema,
  timezone: Schema.Literal(calendarTimeZone),
  provider: Schema.Literal(provider),
})
const Count = Schema.Union([Schema.Number, Digits])
const ManifestRowSchema = Schema.Struct({
  snapshot_id: SnapshotIdSchema,
  schema_version: Schema.Literal(manifestSchemaVersion),
  publisher_source_revision: SourceRevision,
  publisher_image_repository: ImageRepository,
  publisher_image_digest: ImageDigest,
  provider: Schema.Literal(provider),
  source_feed: Schema.Literals(['iex', 'sip']),
  adjustment: Schema.Literal(adjustment),
  calendar_version: NonEmptyString,
  requested_start: IsoDateSchema,
  publication_asof: IsoDateSchema,
  first_session: IsoDateSchema,
  last_session: IsoDateSchema,
  symbol_count: Count,
  session_count: Count,
  bar_count: Count,
  bars_content_hash: Hash,
  sessions_content_hash: Hash,
  manifest_content_hash: Hash,
  finalized_at: FinalizedAt,
})

const decodeBars = Schema.decodeUnknownSync(Schema.Array(BarRowSchema))
const decodeSessions = Schema.decodeUnknownSync(Schema.Array(SessionRowSchema))
const decodeManifests = Schema.decodeUnknownSync(Schema.Array(ManifestRowSchema))

const asCount = (value: string | number, name: string): number => {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is not a safe non-negative integer`)
  return parsed
}

const storage = <A>(message: string) =>
  Effect.mapError<A, PublicationError>((cause: A) => publicationError('storage', message, cause))

const decodeReadback = <A>(name: string, parse: () => A): Effect.Effect<A, PublicationError> =>
  Effect.try({ try: parse, catch: (cause) => publicationError('storage', `invalid ${name} readback`, cause) })

export const makeSnapshotRepository: Effect.Effect<SnapshotRepository, never, ClickhouseClient.ClickhouseClient> =
  Effect.gen(function* () {
    const sql = yield* ClickhouseClient.ClickhouseClient

    const loadBars = (snapshotId: string): Effect.Effect<readonly BarRow[], PublicationError> =>
      sql`
        SELECT
          snapshot_id,
          symbol,
          toString(session_date) AS session_date,
          toDecimalString(adjusted_open, 8) AS adjusted_open,
          toDecimalString(adjusted_high, 8) AS adjusted_high,
          toDecimalString(adjusted_low, 8) AS adjusted_low,
          toDecimalString(adjusted_close, 8) AS adjusted_close,
          toDecimalString(adjusted_volume, 8) AS adjusted_volume,
          toString(trade_count) AS trade_count,
          if(isNull(vwap), NULL, toDecimalString(vwap, 8)) AS vwap,
          provider,
          source_feed,
          adjustment,
          toString(publication_asof) AS publication_asof
        FROM signal.adjusted_daily_bars_v2
        WHERE snapshot_id = ${sql.param('String', snapshotId)}
        ORDER BY session_date, symbol
      `.pipe(
        storage('failed to read staged bars'),
        Effect.flatMap((rows) => decodeReadback('bar rows', () => decodeBars(rows) as readonly BarRow[])),
      )

    const loadSessions = (snapshotId: string): Effect.Effect<readonly SessionRow[], PublicationError> =>
      sql`
        SELECT
          snapshot_id,
          calendar_version,
          toString(session_date) AS session_date,
          open_time,
          close_time,
          timezone,
          provider
        FROM signal.exchange_sessions_v1
        WHERE snapshot_id = ${sql.param('String', snapshotId)}
        ORDER BY session_date
      `.pipe(
        storage('failed to read staged exchange sessions'),
        Effect.flatMap((rows) =>
          decodeReadback('exchange-session rows', () => decodeSessions(rows) as readonly SessionRow[]),
        ),
      )

    const loadManifests = (snapshotId: string): Effect.Effect<readonly ManifestRow[], PublicationError> =>
      sql`
        SELECT
          snapshot_id,
          schema_version,
          publisher_source_revision,
          publisher_image_repository,
          publisher_image_digest,
          provider,
          source_feed,
          adjustment,
          calendar_version,
          toString(requested_start) AS requested_start,
          toString(publication_asof) AS publication_asof,
          toString(first_session) AS first_session,
          toString(last_session) AS last_session,
          symbol_count,
          session_count,
          bar_count,
          bars_content_hash,
          sessions_content_hash,
          manifest_content_hash,
          toString(finalized_at) AS finalized_at
        FROM signal.snapshot_manifests_v1
        WHERE snapshot_id = ${sql.param('String', snapshotId)}
        ORDER BY finalized_at
      `.pipe(
        storage('failed to read snapshot manifest'),
        Effect.flatMap((rows) =>
          decodeReadback(
            'manifest rows',
            () =>
              decodeManifests(rows).map((row) => ({
                ...row,
                symbol_count: asCount(row.symbol_count, 'symbol_count'),
                session_count: asCount(row.session_count, 'session_count'),
                bar_count: asCount(row.bar_count, 'bar_count'),
              })) as readonly ManifestRow[],
          ),
        ),
      )

    const insert = <A>(table: string, snapshotId: string, kind: string, values: readonly A[]) =>
      values.length === 0
        ? Effect.void
        : sql.insertQuery({ table, values: [...values], format: 'JSONEachRow' }).pipe(
            sql.withQueryId(`signal-${kind}-${snapshotId.slice(-32)}`),
            sql.withClickhouseSettings({
              insert_deduplicate: 1,
              insert_deduplication_token: `${kind}-${snapshotId}-${createHash('sha256')
                .update(JSON.stringify(values))
                .digest('hex')}`,
            }),
            storage(`failed to insert ${kind}`),
            Effect.asVoid,
          )

    return {
      loadBars,
      loadSessions,
      loadManifests,
      insertBars: (snapshotId, rows) => insert('signal.adjusted_daily_bars_v2', snapshotId, 'bars', rows),
      insertSessions: (snapshotId, rows) => insert('signal.exchange_sessions_v1', snapshotId, 'sessions', rows),
      insertManifest: (row) => insert('signal.snapshot_manifests_v1', row.snapshot_id, 'manifest', [row]),
    }
  })
