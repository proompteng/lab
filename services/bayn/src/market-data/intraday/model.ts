import { Context, Data, Effect } from 'effect'

import type { OperationalError } from '../../errors'
import type { IsoDate } from '../../schemas'
import type { MarketCalendarObservation } from '../../broker/alpaca/model'

export type IntradayFeed = 'iex' | 'sip' | 'delayed_sip'
export type IntradayDelayClass = 'real_time_exchange_only' | 'real_time_consolidated' | 'delayed_15m_consolidated'

export interface IntradaySnapshotQuery {
  readonly sessionDate: IsoDate
  readonly calendar: MarketCalendarObservation
  readonly rangeStartAt: string
  readonly rangeEndAt: string
  readonly observedAt: string
  readonly universeId: string
  readonly universeSymbolHash: string
  readonly universe: readonly string[]
  readonly feed: IntradayFeed
  readonly delayClass: IntradayDelayClass
  readonly sourceTopics: {
    readonly bars: string
    readonly quotes: string
    readonly trades: string
  }
  readonly maximumQuoteAgeMs: number
  readonly minimumWatermarkLagMs: number
}

export interface IntradayArchiveWatermark {
  readonly sourceTopic: string
  readonly sourcePartition: number
  readonly inclusiveLastOffset: string
}

export interface IntradaySnapshotRequest extends IntradaySnapshotQuery {
  /** Exact Kafka-backed archive version captured before this snapshot is loaded. */
  readonly archiveWatermarks: readonly IntradayArchiveWatermark[]
}

export interface IntradayLineage {
  readonly sourceTopic: string
  readonly sourcePartition: number
  readonly firstOffset: string
  readonly lastOffset: string
  readonly recordCount: number
}

export interface IntradayRecordIdentity {
  readonly provider: 'alpaca'
  readonly universeId: string
  readonly universeSymbolHash: string
  readonly feed: IntradayFeed
  readonly marketSession: 'regular'
  readonly delayClass: IntradayDelayClass
  readonly symbol: string
  readonly eventAt: string
  readonly ingestedAt: string
  readonly sourceTopic: string
  readonly sourcePartition: number
  readonly sourceOffset: string
  readonly schemaVersion: 1
}

export interface IntradayBar extends IntradayRecordIdentity {
  readonly channel: 'bars' | 'updatedBars'
  readonly final: boolean
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
  readonly vwap: number | null
  readonly tradeCount: string | null
}

export interface IntradayQuote extends IntradayRecordIdentity {
  readonly bidPrice: number
  readonly bidSize: number
  readonly askPrice: number
  readonly askSize: number
}

export interface IntradayTrade extends IntradayRecordIdentity {
  readonly price: number
  readonly size: number
}

export interface IntradaySnapshotManifest {
  readonly schemaVersion: 'bayn.intraday-market-snapshot.v1'
  readonly sessionDate: IsoDate
  readonly calendar: MarketCalendarObservation
  readonly rangeStartAt: string
  readonly rangeEndAt: string
  readonly observedAt: string
  readonly universeId: string
  readonly universeSymbolHash: string
  readonly symbols: readonly string[]
  readonly feed: IntradayFeed
  readonly delayClass: IntradayDelayClass
  readonly sourceTopics: IntradaySnapshotRequest['sourceTopics']
  readonly archiveWatermarks: readonly IntradayArchiveWatermark[]
  readonly maximumQuoteAgeMs: number
  readonly minimumWatermarkLagMs: number
  readonly barCount: number
  readonly quoteCount: number
  readonly tradeCount: number
  readonly barsContentHash: string
  readonly quotesContentHash: string
  readonly tradesContentHash: string
  readonly lineage: readonly IntradayLineage[]
  readonly contentHash: string
  readonly snapshotId: string
}

export interface IntradayMarketSnapshot {
  readonly bars: readonly IntradayBar[]
  readonly quotes: readonly IntradayQuote[]
  readonly trades: readonly IntradayTrade[]
  readonly latestQuotes: Readonly<Record<string, IntradayQuote>>
  readonly manifest: IntradaySnapshotManifest
}

declare const ArchiveVerifiedIntradayMarketSnapshotTypeId: unique symbol

/**
 * Opaque snapshot produced only after the immutable ClickHouse archive query
 * has selected each canonical quote and trade winner at the bound watermarks.
 * Persisted or caller-constructed snapshot documents must be reloaded through
 * IntradayMarketData before they can cross this boundary.
 */
export type ArchiveVerifiedIntradayMarketSnapshot = IntradayMarketSnapshot & {
  readonly [ArchiveVerifiedIntradayMarketSnapshotTypeId]: true
}

/**
 * Verified intraday market-data boundary. This service is introduced with the
 * verifier and its ClickHouse implementation so callers can never obtain a
 * materialized snapshot without the immutable-row checks in this layer.
 */
export interface IntradayMarketDataService {
  readonly captureVersion: (
    query: IntradaySnapshotQuery,
  ) => Effect.Effect<readonly IntradayArchiveWatermark[], OperationalError>
  readonly loadSnapshot: (
    request: IntradaySnapshotRequest,
  ) => Effect.Effect<ArchiveVerifiedIntradayMarketSnapshot, OperationalError>
  /** Re-query the bound immutable archive and reject a caller-provided snapshot that is not the canonical result. */
  readonly verifyArchiveSnapshot: (
    snapshot: IntradayMarketSnapshot,
  ) => Effect.Effect<ArchiveVerifiedIntradayMarketSnapshot, OperationalError>
}

export class IntradayMarketData extends Context.Service<IntradayMarketData, IntradayMarketDataService>()(
  '@proompteng/bayn/market-data/intraday/IntradayMarketData',
) {}

export type IntradaySnapshotFailureReason =
  | 'request'
  | 'rows'
  | 'identity'
  | 'ordering'
  | 'coverage'
  | 'freshness'
  | 'not-ready'
  | 'watermark'
  | 'lineage'
  | 'hash'

export class IntradaySnapshotFailure extends Data.TaggedError('IntradaySnapshotFailure')<{
  readonly reason: IntradaySnapshotFailureReason
  readonly message: string
  readonly facts?: Readonly<Record<string, unknown>>
  readonly cause?: unknown
}> {}
