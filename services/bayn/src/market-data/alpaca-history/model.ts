import { Data, Redacted, Schema } from 'effect'

import type * as Effect from 'effect/Effect'
import type * as FileSystem from 'effect/FileSystem'
import type * as HttpClient from 'effect/unstable/http/HttpClient'

import {
  IsoDateSchema,
  NonNegativeFiniteSchema,
  NonNegativeIntegerSchema,
  PositiveFiniteSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcOrderTimestampSchema,
  SymbolSchema,
  TrimmedNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../../schemas'

export const alpacaHistoricalDataOrigin = 'https://data.alpaca.markets' as const
export const alpacaHistoricalFeed = 'iex' as const
export const alpacaHistoricalPageLimit = 10_000 as const
export const alpacaHistoricalRateLimitPerMinute = 180 as const
export const alpacaHistoricalMaximumRetryAttempts = 3 as const
export const alpacaHistoricalMaximumRetryDelayMs = 30_000 as const
export const alpacaHistoricalRequestTimeoutMs = 30_000 as const
export const alpacaHistoricalMaximumPages = 100_000 as const

export enum AlpacaHistoricalKind {
  Bars = 'bars',
  Quotes = 'quotes',
  Trades = 'trades',
}

const AlpacaHistoricalKindSchema = Schema.Enum(AlpacaHistoricalKind)

const UniqueSymbolsSchema = Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isUnique())
const HistoricalQueryTimestampSchema = Schema.Union([UtcInstantSchema, UtcOrderTimestampSchema])
const orderTimestamp = (value: string) =>
  value.replace(/\.([0-9]{3})Z$/, (_match, millis: string) => `.${millis}000000Z`)

const isOrderedSessionQuery = (query: {
  readonly sessionDate: string
  readonly sessionOpenAt: string
  readonly sessionCloseAt: string
  readonly startAt: string
  readonly endAt: string
}): boolean => {
  const sessionDatePrefix = `${query.sessionDate}T`
  const timestamps = [query.sessionOpenAt, query.sessionCloseAt, query.startAt, query.endAt]
  const sessionOpenAt = orderTimestamp(query.sessionOpenAt)
  const sessionCloseAt = orderTimestamp(query.sessionCloseAt)
  const startAt = orderTimestamp(query.startAt)
  const endAt = orderTimestamp(query.endAt)
  return (
    timestamps.every((timestamp) => timestamp.startsWith(sessionDatePrefix)) &&
    sessionOpenAt < sessionCloseAt &&
    sessionOpenAt <= startAt &&
    startAt < endAt &&
    endAt <= sessionCloseAt
  )
}

export const AlpacaHistoricalQuerySchema = Schema.Struct({
  kind: AlpacaHistoricalKindSchema,
  sessionDate: IsoDateSchema,
  sessionOpenAt: UtcInstantSchema,
  sessionCloseAt: UtcInstantSchema,
  startAt: HistoricalQueryTimestampSchema,
  endAt: HistoricalQueryTimestampSchema,
  symbols: UniqueSymbolsSchema,
  cacheDirectory: TrimmedNonEmptyStringSchema,
}).check(
  Schema.makeFilter(isOrderedSessionQuery, {
    expected: 'a non-empty query interval contained by the regular session',
  }),
)

export type AlpacaHistoricalQuery = typeof AlpacaHistoricalQuerySchema.Type

export const decodeAlpacaHistoricalQuery = Schema.decodeUnknownResult(AlpacaHistoricalQuerySchema, strictParseOptions)

export interface AlpacaHistoricalCredentials {
  readonly key: Redacted.Redacted<string>
  readonly secret: Redacted.Redacted<string>
}

export const VendorHistoricalBarSchema = Schema.Struct({
  symbol: SymbolSchema,
  eventAt: UtcOrderTimestampSchema,
  open: Schema.Finite,
  high: Schema.Finite,
  low: Schema.Finite,
  close: Schema.Finite,
  volume: NonNegativeFiniteSchema,
  vwap: Schema.NullOr(NonNegativeFiniteSchema),
  tradeCount: NonNegativeIntegerSchema,
})
export type VendorHistoricalBar = typeof VendorHistoricalBarSchema.Type

const ProviderConditionsSchema = Schema.Array(Schema.String.check(Schema.isMinLength(1)))
export const VendorHistoricalQuoteSchema = Schema.Struct({
  symbol: SymbolSchema,
  eventAt: UtcOrderTimestampSchema,
  bidPrice: NonNegativeFiniteSchema,
  bidSize: NonNegativeIntegerSchema,
  askPrice: NonNegativeFiniteSchema,
  askSize: NonNegativeIntegerSchema,
  bidExchange: StrictNonEmptyStringSchema,
  askExchange: StrictNonEmptyStringSchema,
  conditions: ProviderConditionsSchema,
  tape: StrictNonEmptyStringSchema,
})
export type VendorHistoricalQuote = typeof VendorHistoricalQuoteSchema.Type

export const VendorHistoricalTradeSchema = Schema.Struct({
  symbol: SymbolSchema,
  eventAt: UtcOrderTimestampSchema,
  providerTradeId: Schema.String.check(Schema.isPattern(/^-?[0-9]+$/)),
  price: PositiveFiniteSchema,
  size: PositiveIntegerSchema,
  exchange: StrictNonEmptyStringSchema,
  conditions: ProviderConditionsSchema,
  tape: StrictNonEmptyStringSchema,
})
export type VendorHistoricalTrade = typeof VendorHistoricalTradeSchema.Type

export type VendorHistoricalRow = VendorHistoricalBar | VendorHistoricalQuote | VendorHistoricalTrade

export interface VendorHistoricalQueryIdentity {
  readonly schemaVersion: 'bayn.vendor-historical-query.v1'
  readonly kind: AlpacaHistoricalKind
  readonly endpointPath: `/v2/stocks/${AlpacaHistoricalKind}`
  readonly symbols: readonly string[]
  readonly start: string
  readonly end: string
  readonly asof: string
  readonly feed: typeof alpacaHistoricalFeed
  readonly sort: 'asc'
  readonly limit: typeof alpacaHistoricalPageLimit
  readonly timeframe?: '1Min'
  readonly adjustment?: 'raw'
}

export const VendorHistoricalPageReceiptSchema = Schema.Struct({
  pageIndex: NonNegativeIntegerSchema,
  requestPageTokenHash: Schema.NullOr(Sha256Schema),
  status: Schema.Literal(200),
  retrievedAt: UtcInstantSchema,
  rawTextHash: Sha256Schema,
  normalizedHash: Sha256Schema,
  rowCount: NonNegativeIntegerSchema,
  nextPageTokenHash: Schema.NullOr(Sha256Schema),
  nextPageTokenPresent: Schema.Boolean,
  bodyPath: Schema.String.check(Schema.isPattern(/^page-[0-9]{8}\.body\.json$/)),
  receiptPath: Schema.String.check(Schema.isPattern(/^page-[0-9]{8}\.receipt\.json$/)),
})
export type VendorHistoricalPageReceipt = typeof VendorHistoricalPageReceiptSchema.Type

export const VendorHistoricalProvenanceSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.vendor-historical-provenance.v1'),
  source: Schema.Literal('alpaca-historical'),
  endpointPath: Schema.Literals(['/v2/stocks/bars', '/v2/stocks/quotes', '/v2/stocks/trades']),
  feed: Schema.Literal(alpacaHistoricalFeed),
  asof: IsoDateSchema,
  marketSession: Schema.Literal('regular'),
  timeBasis: Schema.Literal('event-time-only'),
  completeness: Schema.Literal('complete'),
  sessionDate: IsoDateSchema,
  requestedSymbols: Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isUnique()),
  queryHash: Sha256Schema,
  normalizedHash: Sha256Schema,
  rowCountsBySymbol: Schema.Record(SymbolSchema, NonNegativeIntegerSchema),
  pageReceipts: Schema.Array(VendorHistoricalPageReceiptSchema).check(Schema.isMinLength(1)),
  cacheKey: StrictNonEmptyStringSchema,
  retrievedAt: UtcInstantSchema,
})
export type VendorHistoricalProvenance = typeof VendorHistoricalProvenanceSchema.Type

export const StoredHistoricalCaptureSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('bars'),
    rows: Schema.Array(VendorHistoricalBarSchema),
    provenance: VendorHistoricalProvenanceSchema,
    provenanceHash: Sha256Schema,
  }),
  Schema.Struct({
    kind: Schema.Literal('quotes'),
    rows: Schema.Array(VendorHistoricalQuoteSchema),
    provenance: VendorHistoricalProvenanceSchema,
    provenanceHash: Sha256Schema,
  }),
  Schema.Struct({
    kind: Schema.Literal('trades'),
    rows: Schema.Array(VendorHistoricalTradeSchema),
    provenance: VendorHistoricalProvenanceSchema,
    provenanceHash: Sha256Schema,
  }),
])
export type StoredHistoricalCapture = typeof StoredHistoricalCaptureSchema.Type

export interface VendorHistoricalCaptureBase {
  readonly query: AlpacaHistoricalQuery
  readonly queryHash: string
  readonly provenance: VendorHistoricalProvenance
  readonly provenanceHash: string
}

export interface VendorHistoricalBarsCapture extends VendorHistoricalCaptureBase {
  readonly kind: 'bars'
  readonly rows: readonly VendorHistoricalBar[]
}

export interface VendorHistoricalQuotesCapture extends VendorHistoricalCaptureBase {
  readonly kind: 'quotes'
  readonly rows: readonly VendorHistoricalQuote[]
}

export interface VendorHistoricalTradesCapture extends VendorHistoricalCaptureBase {
  readonly kind: 'trades'
  readonly rows: readonly VendorHistoricalTrade[]
}

export type VendorHistoricalCapture =
  | VendorHistoricalBarsCapture
  | VendorHistoricalQuotesCapture
  | VendorHistoricalTradesCapture

export type VendorHistoricalFailureReason =
  | 'invalid-query'
  | 'invalid-credentials'
  | 'request'
  | 'timeout'
  | 'status'
  | 'decode'
  | 'normalization'
  | 'pagination'
  | 'cache'
  | 'hash'

export class VendorHistoricalFailure extends Data.TaggedError('VendorHistoricalFailure')<{
  readonly reason: VendorHistoricalFailureReason
  readonly message: string
  readonly status?: number
  readonly pageIndex?: number
  readonly retryable: boolean
  readonly cause?: unknown
}> {}

export interface AlpacaHistoricalClientOptions {
  /** Total attempts per page, including the first request. */
  readonly maximumAttempts?: number
  /** Per-attempt request timeout. Interruption cancels the underlying client request. */
  readonly requestTimeoutMs?: number
  /** Upper bound for a provider Retry-After delay. */
  readonly maximumRetryDelayMs?: number
  /** Safety bound for a single query's page chain. */
  readonly maximumPages?: number
}

export interface AlpacaHistoricalClient {
  readonly capture: (
    query: AlpacaHistoricalQuery,
  ) => Effect.Effect<VendorHistoricalCapture, VendorHistoricalFailure, FileSystem.FileSystem>
}

export interface AlpacaHistoricalClientFactory {
  readonly make: (
    httpClient: HttpClient.HttpClient,
    credentials: AlpacaHistoricalCredentials,
    options?: AlpacaHistoricalClientOptions,
  ) => Effect.Effect<AlpacaHistoricalClient, VendorHistoricalFailure>
}
