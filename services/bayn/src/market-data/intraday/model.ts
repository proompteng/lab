import { Context, Data, Effect } from 'effect'

import type { OperationalError } from '../../errors'
import type { IsoDate } from '../../schemas'

export type IntradayFeed = 'iex' | 'sip' | 'delayed_sip'
export type IntradayDelayClass = 'real_time_exchange_only' | 'real_time_consolidated' | 'delayed_15m_consolidated'

export interface IntradaySnapshotQuery {
  readonly sessionDate: IsoDate
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

export interface IntradayMarketDataService {
  readonly captureVersion: (
    query: IntradaySnapshotQuery,
  ) => Effect.Effect<readonly IntradayArchiveWatermark[], OperationalError>
  readonly loadSnapshot: (request: IntradaySnapshotRequest) => Effect.Effect<IntradayMarketSnapshot, OperationalError>
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
  | 'watermark'
  | 'lineage'
  | 'hash'

export class IntradaySnapshotFailure extends Data.TaggedError('IntradaySnapshotFailure')<{
  readonly reason: IntradaySnapshotFailureReason
  readonly message: string
  readonly facts?: Readonly<Record<string, unknown>>
  readonly cause?: unknown
}> {}
