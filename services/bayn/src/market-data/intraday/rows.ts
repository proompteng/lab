import { Result, Schema, pipe } from 'effect'

import {
  DigitsSchema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  UtcOrderTimestampSchema,
  strictParseOptions,
} from '../../schemas'
import { IntradaySnapshotFailure } from './model'

const FiniteNumericStringSchema = Schema.String.check(
  Schema.makeFilter((value: string) => value.length > 0 && value.trim() === value && Number.isFinite(Number(value)), {
    expected: 'a finite numeric string',
  }),
)
const NumericSchema = Schema.Union([Schema.Finite, FiniteNumericStringSchema])
const numericValue = (value: number | string): number => (typeof value === 'number' ? value : Number(value))
const hasExpectedDelayClass = (row: {
  readonly feed: 'iex' | 'sip' | 'delayed_sip'
  readonly delay_class: string
}): boolean =>
  (row.feed === 'iex' && row.delay_class === 'real_time_exchange_only') ||
  (row.feed === 'sip' && row.delay_class === 'real_time_consolidated') ||
  (row.feed === 'delayed_sip' && row.delay_class === 'delayed_15m_consolidated')
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
}).check(
  Schema.makeFilter(
    (row) => {
      const open = numericValue(row.open)
      const high = numericValue(row.high)
      const low = numericValue(row.low)
      const close = numericValue(row.close)
      const vwap = row.vwap === null ? null : numericValue(row.vwap)
      return (
        hasExpectedDelayClass(row) &&
        open > 0 &&
        high > 0 &&
        low > 0 &&
        close > 0 &&
        high >= Math.max(open, close, low) &&
        low <= Math.min(open, close, high) &&
        numericValue(row.volume) >= 0 &&
        (vwap === null || vwap > 0)
      )
    },
    { expected: 'positive consistent OHLC, non-negative volume, and positive nullable VWAP' },
  ),
)

const IntradayQuoteRowSchema = Schema.Struct({
  ...identityFields,
  latest_payload_variants: DigitsSchema,
  bid_price: NumericSchema,
  bid_size: NumericSchema,
  ask_price: NumericSchema,
  ask_size: NumericSchema,
}).check(
  Schema.makeFilter(
    (row) =>
      hasExpectedDelayClass(row) &&
      numericValue(row.bid_price) > 0 &&
      numericValue(row.ask_price) > 0 &&
      numericValue(row.bid_size) >= 0 &&
      numericValue(row.ask_size) >= 0 &&
      numericValue(row.bid_price) <= numericValue(row.ask_price),
    { expected: 'positive uncrossed quote prices with non-negative sizes' },
  ),
)

const IntradayTradeRowSchema = Schema.Struct({
  ...identityFields,
  latest_payload_variants: DigitsSchema,
  price: NumericSchema,
  size: NumericSchema,
}).check(
  Schema.makeFilter((row) => hasExpectedDelayClass(row) && numericValue(row.price) > 0 && numericValue(row.size) > 0, {
    expected: 'positive trade price and size',
  }),
)

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
