import { DateTime, Option, Result, Schema } from 'effect'

import { canonicalHashV1Result, renderCanonicalJsonFailure } from '../../../hash'
import { PositiveFiniteSchema, StrictNonEmptyStringSchema, SymbolSchema } from '../../../schemas'
import {
  VendorHistoricalFailure,
  type AlpacaHistoricalKind,
  type AlpacaHistoricalQuery,
  type VendorHistoricalBar,
  type VendorHistoricalQuote,
  type VendorHistoricalRow,
  type VendorHistoricalTrade,
} from './model'

const providerTimestampPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/

const isProviderTimestamp = (value: string): boolean => {
  const match = providerTimestampPattern.exec(value)
  if (match === null) return false
  const seconds = match[1]
  const fraction = match[2] ?? '0'
  if (seconds === undefined || fraction.length > 9) return false
  const instant = DateTime.make(`${seconds}.${fraction.padEnd(3, '0').slice(0, 3)}Z`)
  return Option.isSome(instant) && DateTime.formatIso(instant.value).slice(0, 19) === seconds
}

const ProviderTimestampSchema = Schema.String.check(
  Schema.makeFilter(isProviderTimestamp, {
    expected: 'an Alpaca UTC timestamp with at most nanosecond precision',
  }),
)

const PositiveTradeSizeSchema = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegativeIntegerSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const NonNegativeFiniteSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
// CTA condition codes may be a single space (for example, a regular-sale code).
// Preserve the provider value exactly; only an empty string is invalid.
const ProviderConditionCodeSchema = Schema.String.check(Schema.isMinLength(1))

const HistoricalBarWireSchema = Schema.Struct({
  c: Schema.Finite,
  h: Schema.Finite,
  l: Schema.Finite,
  n: NonNegativeIntegerSchema,
  o: Schema.Finite,
  t: ProviderTimestampSchema,
  v: NonNegativeFiniteSchema,
  vw: Schema.NullOr(NonNegativeFiniteSchema),
})

const HistoricalQuoteWireSchema = Schema.Struct({
  ap: NonNegativeFiniteSchema,
  as: NonNegativeIntegerSchema,
  ax: StrictNonEmptyStringSchema,
  bp: NonNegativeFiniteSchema,
  bs: NonNegativeIntegerSchema,
  bx: StrictNonEmptyStringSchema,
  c: Schema.Array(ProviderConditionCodeSchema),
  t: ProviderTimestampSchema,
  z: StrictNonEmptyStringSchema,
})

const HistoricalTradeWireSchema = Schema.Struct({
  c: Schema.Array(ProviderConditionCodeSchema),
  i: Schema.Int,
  p: PositiveFiniteSchema,
  s: PositiveTradeSizeSchema,
  t: ProviderTimestampSchema,
  x: StrictNonEmptyStringSchema,
  z: StrictNonEmptyStringSchema,
})

const NextPageTokenSchema = Schema.optionalKey(Schema.NullOr(StrictNonEmptyStringSchema))

const HistoricalBarsResponseSchema = Schema.Struct({
  bars: Schema.Record(SymbolSchema, Schema.Array(HistoricalBarWireSchema)),
  next_page_token: NextPageTokenSchema,
})

const HistoricalQuotesResponseSchema = Schema.Struct({
  next_page_token: NextPageTokenSchema,
  quotes: Schema.Record(SymbolSchema, Schema.Array(HistoricalQuoteWireSchema)),
})

const HistoricalTradesResponseSchema = Schema.Struct({
  next_page_token: NextPageTokenSchema,
  trades: Schema.Record(SymbolSchema, Schema.Array(HistoricalTradeWireSchema)),
})

type HistoricalBarWire = typeof HistoricalBarWireSchema.Type
type HistoricalQuoteWire = typeof HistoricalQuoteWireSchema.Type
type HistoricalTradeWire = typeof HistoricalTradeWireSchema.Type

type HistoricalResponse =
  | {
      readonly kind: 'bars'
      readonly records: Readonly<Record<string, readonly HistoricalBarWire[]>>
      readonly nextPageToken?: string | null
    }
  | {
      readonly kind: 'quotes'
      readonly records: Readonly<Record<string, readonly HistoricalQuoteWire[]>>
      readonly nextPageToken?: string | null
    }
  | {
      readonly kind: 'trades'
      readonly records: Readonly<Record<string, readonly HistoricalTradeWire[]>>
      readonly nextPageToken?: string | null
    }

export interface NormalizedHistoricalPage {
  readonly kind: AlpacaHistoricalKind
  readonly rows: readonly VendorHistoricalRow[]
  readonly nextPageToken: string | undefined
  readonly normalizedHash: string
  readonly rowCountsBySymbol: Readonly<Record<string, number>>
}

const normalizationFailure = (
  message: string,
  pageIndex?: number,
  cause?: unknown,
): Result.Result<never, VendorHistoricalFailure> =>
  Result.fail(
    new VendorHistoricalFailure({
      reason: 'normalization',
      message,
      ...(pageIndex === undefined ? undefined : { pageIndex }),
      retryable: false,
      ...(cause === undefined ? undefined : { cause }),
    }),
  )

const decodeFailure = (kind: AlpacaHistoricalKind, cause: unknown, pageIndex?: number) =>
  new VendorHistoricalFailure({
    reason: 'decode',
    message: `Alpaca ${kind} historical response violates the vendor wire contract`,
    ...(pageIndex === undefined ? undefined : { pageIndex }),
    retryable: false,
    cause,
  })

const canonicalizeProviderTimestamp = (value: string): Result.Result<string, string> => {
  const match = providerTimestampPattern.exec(value)
  if (match === null) return Result.fail('invalid provider timestamp')
  const seconds = match[1]
  const fraction = match[2] ?? '0'
  if (seconds === undefined) return Result.fail('invalid provider timestamp')
  if (!isProviderTimestamp(value)) return Result.fail('invalid provider timestamp')
  return Result.succeed(`${seconds}.${fraction.padEnd(9, '0')}Z`)
}

const canonicalizeQueryTimestamp = (value: string): Result.Result<string, string> =>
  canonicalizeProviderTimestamp(value)

const normalizeBar = (
  symbol: string,
  wire: HistoricalBarWire,
  startAt: string,
  endAt: string,
): Result.Result<VendorHistoricalBar, VendorHistoricalFailure> => {
  const eventAt = canonicalizeProviderTimestamp(wire.t)
  if (Result.isFailure(eventAt)) return normalizationFailure(`bar ${symbol} has an invalid event timestamp`)
  if (eventAt.success < startAt || eventAt.success > endAt) {
    return normalizationFailure(`bar ${symbol} event timestamp is outside the requested interval`)
  }
  if (!eventAt.success.endsWith('.000000000Z') || eventAt.success.slice(17, 19) !== '00') {
    return normalizationFailure(`bar ${symbol} event timestamp is not aligned to a one-minute boundary`)
  }
  if (wire.h < Math.max(wire.o, wire.c, wire.l) || wire.l > Math.min(wire.o, wire.c, wire.h)) {
    return normalizationFailure(`bar ${symbol} has inconsistent OHLC values`)
  }
  return Result.succeed({
    symbol,
    eventAt: eventAt.success,
    open: wire.o,
    high: wire.h,
    low: wire.l,
    close: wire.c,
    volume: wire.v,
    vwap: wire.vw,
    tradeCount: wire.n,
  })
}

const normalizeQuote = (
  symbol: string,
  wire: HistoricalQuoteWire,
  startAt: string,
  endAt: string,
): Result.Result<VendorHistoricalQuote, VendorHistoricalFailure> => {
  const eventAt = canonicalizeProviderTimestamp(wire.t)
  if (Result.isFailure(eventAt)) return normalizationFailure(`quote ${symbol} has an invalid event timestamp`)
  if (eventAt.success < startAt || eventAt.success > endAt) {
    return normalizationFailure(`quote ${symbol} event timestamp is outside the requested interval`)
  }
  if (wire.bp > wire.ap) return normalizationFailure(`quote ${symbol} has a bid above its ask`)
  return Result.succeed({
    symbol,
    eventAt: eventAt.success,
    bidPrice: wire.bp,
    bidSize: wire.bs,
    askPrice: wire.ap,
    askSize: wire.as,
    bidExchange: wire.bx,
    askExchange: wire.ax,
    conditions: wire.c,
    tape: wire.z,
  })
}

const normalizeTrade = (
  symbol: string,
  wire: HistoricalTradeWire,
  startAt: string,
  endAt: string,
): Result.Result<VendorHistoricalTrade, VendorHistoricalFailure> => {
  const eventAt = canonicalizeProviderTimestamp(wire.t)
  if (Result.isFailure(eventAt)) return normalizationFailure(`trade ${symbol} has an invalid event timestamp`)
  if (eventAt.success < startAt || eventAt.success > endAt) {
    return normalizationFailure(`trade ${symbol} event timestamp is outside the requested interval`)
  }
  return Result.succeed({
    symbol,
    eventAt: eventAt.success,
    providerTradeId: String(wire.i),
    price: wire.p,
    size: wire.s,
    exchange: wire.x,
    conditions: wire.c,
    tape: wire.z,
  })
}

const isHistoricalTrade = (row: VendorHistoricalRow): row is VendorHistoricalTrade => 'providerTradeId' in row
const isHistoricalQuote = (row: VendorHistoricalRow): row is VendorHistoricalQuote => 'bidPrice' in row

const rowKey = (kind: AlpacaHistoricalKind, row: VendorHistoricalRow): string => {
  if (kind === 'quotes' && isHistoricalQuote(row)) {
    return `${row.symbol}\u001f${row.eventAt}\u001f${JSON.stringify(row)}`
  }
  if (kind === 'trades' && isHistoricalTrade(row)) {
    return `${row.symbol}\u001f${row.eventAt}\u001f${row.providerTradeId}`
  }
  return `${row.symbol}\u001f${row.eventAt}`
}

export const historicalRowKey = rowKey

const rowsEqual = (left: VendorHistoricalRow, right: VendorHistoricalRow): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

const decodeHistoricalResponse = (
  kind: AlpacaHistoricalKind,
  input: unknown,
  pageIndex?: number,
): Result.Result<HistoricalResponse, VendorHistoricalFailure> => {
  if (kind === 'bars') {
    const decoded = Schema.decodeUnknownResult(HistoricalBarsResponseSchema)(input)
    if (Result.isFailure(decoded)) return Result.fail(decodeFailure(kind, decoded.failure, pageIndex))
    return Result.succeed({
      kind,
      records: decoded.success.bars,
      ...(decoded.success.next_page_token === undefined ? {} : { nextPageToken: decoded.success.next_page_token }),
    })
  }
  if (kind === 'quotes') {
    const decoded = Schema.decodeUnknownResult(HistoricalQuotesResponseSchema)(input)
    if (Result.isFailure(decoded)) return Result.fail(decodeFailure(kind, decoded.failure, pageIndex))
    return Result.succeed({
      kind,
      records: decoded.success.quotes,
      ...(decoded.success.next_page_token === undefined ? {} : { nextPageToken: decoded.success.next_page_token }),
    })
  }
  const decoded = Schema.decodeUnknownResult(HistoricalTradesResponseSchema)(input)
  if (Result.isFailure(decoded)) return Result.fail(decodeFailure(kind, decoded.failure, pageIndex))
  return Result.succeed({
    kind,
    records: decoded.success.trades,
    ...(decoded.success.next_page_token === undefined ? {} : { nextPageToken: decoded.success.next_page_token }),
  })
}

const normalizeRecord = (
  kind: AlpacaHistoricalKind,
  symbol: string,
  wire: HistoricalBarWire | HistoricalQuoteWire | HistoricalTradeWire,
  startAt: string,
  endAt: string,
): Result.Result<VendorHistoricalRow, VendorHistoricalFailure> => {
  if (kind === 'bars') {
    if (!('o' in wire)) return normalizationFailure(`bar ${symbol} has an invalid wire record`)
    return normalizeBar(symbol, wire, startAt, endAt)
  }
  if (kind === 'quotes') {
    if (!('ap' in wire)) return normalizationFailure(`quote ${symbol} has an invalid wire record`)
    return normalizeQuote(symbol, wire, startAt, endAt)
  }
  if (!('i' in wire)) return normalizationFailure(`trade ${symbol} has an invalid wire record`)
  return normalizeTrade(symbol, wire, startAt, endAt)
}

export const normalizeAlpacaHistoricalPage = (
  kind: AlpacaHistoricalKind,
  input: unknown,
  query: AlpacaHistoricalQuery,
  pageIndex = 0,
): Result.Result<NormalizedHistoricalPage, VendorHistoricalFailure> => {
  const startAt = canonicalizeQueryTimestamp(query.startAt)
  const endAt = canonicalizeQueryTimestamp(query.endAt)
  if (Result.isFailure(startAt) || Result.isFailure(endAt)) {
    return normalizationFailure('historical query boundaries are invalid', pageIndex)
  }
  const response = decodeHistoricalResponse(kind, input, pageIndex)
  if (Result.isFailure(response)) return Result.fail(response.failure)

  const rows: VendorHistoricalRow[] = []
  const rowCountsBySymbol: Record<string, number> = Object.fromEntries(query.symbols.map((symbol) => [symbol, 0]))
  const seenKeys = new Map<string, VendorHistoricalRow>()

  for (const symbol of Object.keys(response.success.records).sort()) {
    if (!query.symbols.includes(symbol))
      return normalizationFailure(`response contains unrequested symbol ${symbol}`, pageIndex)
    const wireRows = response.success.records[symbol]
    if (wireRows === undefined)
      return normalizationFailure(`response symbol ${symbol} has no row collection`, pageIndex)
    let previousEventAt: string | undefined
    for (const wire of wireRows) {
      const normalized = normalizeRecord(kind, symbol, wire, startAt.success, endAt.success)
      if (Result.isFailure(normalized)) {
        const { reason, message, retryable, cause, status } = normalized.failure
        return Result.fail(
          new VendorHistoricalFailure({
            reason,
            message,
            retryable,
            pageIndex: normalized.failure.pageIndex ?? pageIndex,
            ...(cause === undefined ? {} : { cause }),
            ...(status === undefined ? {} : { status }),
          }),
        )
      }
      const row = normalized.success
      if (previousEventAt !== undefined && row.eventAt < previousEventAt) {
        return normalizationFailure(`response rows for ${symbol} are not sorted by event time`, pageIndex)
      }
      previousEventAt = row.eventAt
      const key = rowKey(kind, row)
      const previous = seenKeys.get(key)
      if (previous !== undefined) {
        return normalizationFailure(
          rowsEqual(previous, row)
            ? `duplicate ${kind} record ${symbol} at ${row.eventAt}`
            : `ambiguous ${kind} record ${symbol} at ${row.eventAt}`,
          pageIndex,
        )
      }
      seenKeys.set(key, row)
      rows.push(row)
      rowCountsBySymbol[symbol] = (rowCountsBySymbol[symbol] ?? 0) + 1
    }
  }

  const normalizedHash = canonicalHashV1Result(rows)
  if (Result.isFailure(normalizedHash)) {
    return Result.fail(
      new VendorHistoricalFailure({
        reason: 'hash',
        message: `normalized ${kind} rows cannot be canonically hashed: ${renderCanonicalJsonFailure(normalizedHash.failure)}`,
        pageIndex,
        retryable: false,
        cause: normalizedHash.failure,
      }),
    )
  }
  return Result.succeed({
    kind,
    rows,
    nextPageToken: response.success.nextPageToken ?? undefined,
    normalizedHash: normalizedHash.success,
    rowCountsBySymbol,
  })
}

export const normalizedRowsHashResult = (
  rows: readonly VendorHistoricalRow[],
): Result.Result<string, VendorHistoricalFailure> => {
  const hash = canonicalHashV1Result(rows)
  return Result.isFailure(hash)
    ? Result.fail(
        new VendorHistoricalFailure({
          reason: 'hash',
          message: `normalized rows cannot be canonically hashed: ${renderCanonicalJsonFailure(hash.failure)}`,
          retryable: false,
          cause: hash.failure,
        }),
      )
    : Result.succeed(hash.success)
}
