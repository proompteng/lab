import { Result, Schema, pipe } from 'effect'

import {
  DigitsSchema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  UtcOrderTimestampSchema,
  strictParseOptions,
} from '../../schemas'
import { IntradaySnapshotFailure } from './model'

const NumericSchema = Schema.Union([Schema.Finite, Schema.String])
const BooleanIntegerSchema = Schema.Union([Schema.Literals([0, 1]), Schema.Literals(['0', '1'])])
const PartitionSchema = Schema.Union([Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), DigitsSchema])
const SchemaVersionSchema = Schema.Union([Schema.Literal(1), Schema.Literal('1')])

const identityFields = {
  provider: Schema.Literal('alpaca'),
  universe_id: StrictNonEmptyStringSchema,
  universe_symbol_hash: Schema.String,
  feed: Schema.Literals(['iex', 'sip', 'delayed_sip']),
  market_session: Schema.Literal('regular'),
  delay_class: Schema.Literals(['real_time_exchange_only', 'real_time_consolidated', 'delayed_15m_consolidated']),
  symbol: Schema.String,
  // Bars use millisecond precision while raw SIP quotes and trades retain the
  // provider's nanosecond ordering timestamp. Both remain canonical UTC wire values.
  event_at: Schema.Union([UtcInstantSchema, UtcOrderTimestampSchema]),
  ingested_at: Schema.Union([UtcInstantSchema, UtcOrderTimestampSchema]),
  source_topic: StrictNonEmptyStringSchema,
  source_partition: PartitionSchema,
  source_offset: DigitsSchema,
  schema_version: SchemaVersionSchema,
} as const

const IntradayBarRowSchema = Schema.Struct({
  ...identityFields,
  channel: Schema.Literals(['bars', 'updatedBars']),
  is_final: BooleanIntegerSchema,
  open: NumericSchema,
  high: NumericSchema,
  low: NumericSchema,
  close: NumericSchema,
  volume: NumericSchema,
  vwap: Schema.NullOr(NumericSchema),
  trade_count: Schema.NullOr(DigitsSchema),
})

const IntradayQuoteRowSchema = Schema.Struct({
  ...identityFields,
  bid_price: NumericSchema,
  bid_size: NumericSchema,
  ask_price: NumericSchema,
  ask_size: NumericSchema,
})

const IntradayTradeRowSchema = Schema.Struct({
  ...identityFields,
  price: NumericSchema,
  size: NumericSchema,
})

const IntradayArchiveWatermarkRowSchema = Schema.Struct({
  source_topic: StrictNonEmptyStringSchema,
  source_partition: PartitionSchema,
  inclusive_last_offset: DigitsSchema,
})

export type IntradayBarRow = typeof IntradayBarRowSchema.Type
export type IntradayQuoteRow = typeof IntradayQuoteRowSchema.Type
export type IntradayTradeRow = typeof IntradayTradeRowSchema.Type
export type IntradayArchiveWatermarkRow = typeof IntradayArchiveWatermarkRowSchema.Type

const decodeRows = <A>(
  kind: 'bars' | 'quotes' | 'trades' | 'watermarks',
  schema: Schema.Codec<readonly A[], readonly A[]>,
  rows: readonly unknown[],
): Result.Result<readonly A[], IntradaySnapshotFailure> =>
  pipe(
    Schema.decodeUnknownResult(schema, strictParseOptions)(rows),
    Result.mapError(
      (cause) =>
        new IntradaySnapshotFailure({
          reason: 'rows',
          message: `intraday ${kind} rows do not match the archive contract`,
          cause,
        }),
    ),
  )

export const decodeIntradayBarRows = (
  rows: readonly unknown[],
): Result.Result<readonly IntradayBarRow[], IntradaySnapshotFailure> =>
  decodeRows('bars', Schema.Array(IntradayBarRowSchema), rows)

export const decodeIntradayQuoteRows = (
  rows: readonly unknown[],
): Result.Result<readonly IntradayQuoteRow[], IntradaySnapshotFailure> =>
  decodeRows('quotes', Schema.Array(IntradayQuoteRowSchema), rows)

export const decodeIntradayTradeRows = (
  rows: readonly unknown[],
): Result.Result<readonly IntradayTradeRow[], IntradaySnapshotFailure> =>
  decodeRows('trades', Schema.Array(IntradayTradeRowSchema), rows)

export const decodeIntradayArchiveWatermarkRows = (
  rows: readonly unknown[],
): Result.Result<readonly IntradayArchiveWatermarkRow[], IntradaySnapshotFailure> =>
  decodeRows('watermarks', Schema.Array(IntradayArchiveWatermarkRowSchema), rows)
