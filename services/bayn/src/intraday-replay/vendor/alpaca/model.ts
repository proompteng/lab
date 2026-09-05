import { Data, Redacted, Schema } from 'effect'

import type * as Effect from 'effect/Effect'
import type * as FileSystem from 'effect/FileSystem'
import type * as HttpClient from 'effect/unstable/http/HttpClient'

import {
  IsoDateSchema,
  SymbolSchema,
  TrimmedNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../../../schemas'

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

const isOrderedSessionQuery = (query: {
  readonly sessionDate: string
  readonly sessionOpenAt: string
  readonly sessionCloseAt: string
  readonly startAt: string
  readonly endAt: string
}): boolean => {
  const sessionDatePrefix = `${query.sessionDate}T`
  const timestamps = [query.sessionOpenAt, query.sessionCloseAt, query.startAt, query.endAt]
  return (
    timestamps.every((timestamp) => timestamp.startsWith(sessionDatePrefix)) &&
    query.sessionOpenAt < query.sessionCloseAt &&
    query.sessionOpenAt <= query.startAt &&
    query.startAt < query.endAt &&
    query.endAt <= query.sessionCloseAt
  )
}

export const AlpacaHistoricalQuerySchema = Schema.Struct({
  kind: AlpacaHistoricalKindSchema,
  sessionDate: IsoDateSchema,
  sessionOpenAt: UtcInstantSchema,
  sessionCloseAt: UtcInstantSchema,
  startAt: UtcInstantSchema,
  endAt: UtcInstantSchema,
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

export interface VendorHistoricalBar {
  readonly symbol: string
  readonly eventAt: string
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
  readonly vwap: number | null
  readonly tradeCount: number
}

export interface VendorHistoricalQuote {
  readonly symbol: string
  readonly eventAt: string
  readonly bidPrice: number
  readonly bidSize: number
  readonly askPrice: number
  readonly askSize: number
  readonly bidExchange: string
  readonly askExchange: string
  readonly conditions: readonly string[]
  readonly tape: string
}

export interface VendorHistoricalTrade {
  readonly symbol: string
  readonly eventAt: string
  readonly providerTradeId: string
  readonly price: number
  readonly size: number
  readonly exchange: string
  readonly conditions: readonly string[]
  readonly tape: string
}

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

export interface VendorHistoricalPageReceipt {
  readonly pageIndex: number
  readonly requestPageTokenHash: string | null
  readonly status: 200
  readonly retrievedAt: string
  readonly rawTextHash: string
  readonly normalizedHash: string
  readonly rowCount: number
  readonly nextPageTokenHash: string | null
  readonly nextPageTokenPresent: boolean
  readonly bodyPath: string
  readonly receiptPath: string
}

export interface VendorHistoricalProvenance {
  readonly schemaVersion: 'bayn.vendor-historical-provenance.v1'
  readonly source: 'alpaca-historical'
  readonly endpointPath: `/v2/stocks/${AlpacaHistoricalKind}`
  readonly feed: typeof alpacaHistoricalFeed
  readonly asof: string
  readonly marketSession: 'regular'
  readonly timeBasis: 'event-time-only'
  readonly completeness: 'complete'
  readonly sessionDate: string
  readonly requestedSymbols: readonly string[]
  readonly queryHash: string
  readonly normalizedHash: string
  readonly rowCountsBySymbol: Readonly<Record<string, number>>
  readonly pageReceipts: readonly VendorHistoricalPageReceipt[]
  /** Stable query cache key. The caller-supplied absolute cache directory is kept on the query only. */
  readonly cacheKey: string
  readonly retrievedAt: string
}

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
