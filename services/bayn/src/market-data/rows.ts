import { Result, Schema, pipe } from 'effect'

import { decodeSignalCount } from './verification/shared'
import type { MarketDataVerificationError } from './verification/errors'
import {
  DigitsSchema,
  GitSourceRevisionSchema as SourceRevisionSchema,
  ImageDigestSchema,
  ImageRepositorySchema,
  IsoDateSchema,
  Sha256Schema as HashSchema,
  SignalRowSymbolSchema as SymbolSchema,
  UniverseIdSchema,
  strictParseOptions as StrictParseOptions,
} from '../schemas'
import { DataFeed, DataSource, PriceAdjustment, PublicationSchema } from '../types'

const calendarTimeZone = 'America/New_York' as const
const SnapshotIdSchema = HashSchema
const FixedDecimalSchema = Schema.String.check(Schema.isPattern(/^(?:0|[1-9]\d*)\.\d{8}$/))
const MarketTimeSchema = Schema.String.check(Schema.isPattern(/^(?:0\d|1\d|2[0-3]):[0-5]\d$/))
const CountSchema = Schema.Union([Schema.Finite, DigitsSchema])
const FinalizedAtSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}$/),
)

const SignalBarRowSchema = Schema.Struct({
  snapshot_id: SnapshotIdSchema,
  symbol: SymbolSchema,
  session_date: IsoDateSchema,
  adjusted_open: FixedDecimalSchema,
  adjusted_high: FixedDecimalSchema,
  adjusted_low: FixedDecimalSchema,
  adjusted_close: FixedDecimalSchema,
  adjusted_volume: FixedDecimalSchema,
  trade_count: DigitsSchema,
  vwap: Schema.NullOr(FixedDecimalSchema),
  provider: Schema.Enum(DataSource),
  source_feed: Schema.Enum(DataFeed),
  adjustment: Schema.Enum(PriceAdjustment),
  publication_asof: IsoDateSchema,
})
const SignalSessionRowSchema = Schema.Struct({
  snapshot_id: SnapshotIdSchema,
  calendar_version: Schema.Trim.check(Schema.isMinLength(1)),
  session_date: IsoDateSchema,
  open_time: MarketTimeSchema,
  close_time: MarketTimeSchema,
  timezone: Schema.Literal(calendarTimeZone),
  provider: Schema.Enum(DataSource),
})
const SignalManifestFields = {
  snapshot_id: SnapshotIdSchema,
  publisher_source_revision: SourceRevisionSchema,
  publisher_image_repository: ImageRepositorySchema,
  publisher_image_digest: ImageDigestSchema,
  provider: Schema.Enum(DataSource),
  source_feed: Schema.Enum(DataFeed),
  adjustment: Schema.Enum(PriceAdjustment),
  calendar_version: Schema.Trim.check(Schema.isMinLength(1)),
  requested_start: IsoDateSchema,
  publication_asof: IsoDateSchema,
  first_session: IsoDateSchema,
  last_session: IsoDateSchema,
  symbol_count: CountSchema,
  session_count: CountSchema,
  bar_count: CountSchema,
  bars_content_hash: HashSchema,
  sessions_content_hash: HashSchema,
  manifest_content_hash: HashSchema,
  finalized_at: FinalizedAtSchema,
} as const
const SignalManifestRowSchema = Schema.Struct({
  schema_version: Schema.Literal(PublicationSchema.AdjustedDailySnapshotV2),
  universe_id: UniverseIdSchema,
  universe_symbol_hash: HashSchema,
  ...SignalManifestFields,
})

export type SignalBarRow = typeof SignalBarRowSchema.Type
export type SignalSessionRow = typeof SignalSessionRowSchema.Type
export type SignalManifestRow = Omit<
  typeof SignalManifestRowSchema.Type,
  'symbol_count' | 'session_count' | 'bar_count'
> & {
  readonly symbol_count: number
  readonly session_count: number
  readonly bar_count: number
}

export interface SnapshotRows {
  readonly bars: readonly SignalBarRow[]
  readonly sessions: readonly SignalSessionRow[]
  readonly manifests: readonly SignalManifestRow[]
}

export const decodeBars = (
  rows: readonly unknown[],
): Result.Result<readonly SignalBarRow[], MarketDataVerificationError> =>
  pipe(
    Schema.decodeUnknownResult(Schema.Array(SignalBarRowSchema), StrictParseOptions)(rows),
    Result.mapError(
      (cause): MarketDataVerificationError => ({
        _tag: 'RowDecodeFailed',
        rows: 'bars',
        cause,
      }),
    ),
  )

export const decodeSessions = (
  rows: readonly unknown[],
): Result.Result<readonly SignalSessionRow[], MarketDataVerificationError> =>
  pipe(
    Schema.decodeUnknownResult(Schema.Array(SignalSessionRowSchema), StrictParseOptions)(rows),
    Result.mapError(
      (cause): MarketDataVerificationError => ({
        _tag: 'RowDecodeFailed',
        rows: 'sessions',
        cause,
      }),
    ),
  )

export const decodeManifests = (
  rows: readonly unknown[],
): Result.Result<readonly SignalManifestRow[], MarketDataVerificationError> =>
  pipe(
    Schema.decodeUnknownResult(Schema.Array(SignalManifestRowSchema), StrictParseOptions)(rows),
    Result.mapError(
      (cause): MarketDataVerificationError => ({
        _tag: 'RowDecodeFailed',
        rows: 'manifests',
        cause,
      }),
    ),
    Result.flatMap((manifests) =>
      Result.all(
        manifests.map((manifest) =>
          pipe(
            Result.all({
              symbol_count: decodeSignalCount(manifest.symbol_count, 'symbol_count'),
              session_count: decodeSignalCount(manifest.session_count, 'session_count'),
              bar_count: decodeSignalCount(manifest.bar_count, 'bar_count'),
            }),
            Result.map((counts): SignalManifestRow => ({ ...manifest, ...counts })),
          ),
        ),
      ),
    ),
  )

export const decodeSnapshotRows = (
  bars: readonly unknown[],
  sessions: readonly unknown[],
  manifests: readonly unknown[],
): Result.Result<SnapshotRows, MarketDataVerificationError> =>
  Result.all({
    bars: decodeBars(bars),
    sessions: decodeSessions(sessions),
    manifests: decodeManifests(manifests),
  })
