import type { SimulatedMarketSnapshot, SimulatedVerifiedMarketSnapshot } from '../streaming/snapshot'
import type { SimulatedSnapshotReference } from '../streaming/simulation-service'
import type { StreamingMarketSnapshot, StreamingVerifiedMarketSnapshot } from '../streaming/snapshot'
import type { StreamingVerifiedSnapshotReference } from '../streaming/reference'
import { Context, Data, Effect } from 'effect'

import type { OperationalError } from '../../errors'
import type { IsoDate } from '../../schemas'
import type { MarketCalendarObservation } from '../../broker/alpaca/model'

export type IntradayFeed = 'iex' | 'sip' | 'delayed_sip'
export type IntradayDelayClass = 'real_time_exchange_only' | 'real_time_consolidated' | 'delayed_15m_consolidated'
export enum IntradaySnapshotPurpose {
  EntryPricing = 'ENTRY_PRICING',
  Liquidation = 'LIQUIDATION',
}

export enum IntradayCandidateEvidencePolicy {
  QuoteWithWindowTrade = 'bayn.candidate-evidence.quote-window-trade.v1',
}

export interface IntradaySnapshotQuery {
  readonly sessionDate: IsoDate
  readonly calendar: MarketCalendarObservation
  readonly rangeStartAt: string
  readonly rangeEndAt: string
  readonly observedAt: string
  readonly universeId: string
  readonly universeSymbolHash: string
  /** Full source-universe membership bound by universeSymbolHash. */
  readonly universe: readonly string[]
  /** Canonical subset required by this snapshot. Omission means the full universe. */
  readonly symbols?: readonly string[]
  /** Decision candidates whose unavailable data is recorded separately from the required benchmark. */
  readonly candidateSymbols?: readonly string[]
  readonly candidateEvidencePolicy?: IntradayCandidateEvidencePolicy
  /** Quote-only execution evidence; omission keeps the full decision-time bar and trade contract. */
  readonly purpose?: IntradaySnapshotPurpose
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

export const usesCandidateWindowTrade = (
  request: Pick<IntradaySnapshotQuery, 'candidateEvidencePolicy' | 'candidateSymbols'>,
  symbol: string,
): boolean =>
  request.candidateEvidencePolicy === IntradayCandidateEvidencePolicy.QuoteWithWindowTrade &&
  request.candidateSymbols?.includes(symbol) === true

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

export interface IntradayCandidateExclusion {
  readonly symbol: string
  readonly reason: 'not-ready' | 'freshness'
  readonly message: string
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
  /** Added for subset snapshots; omitted only by legacy v1 material. */
  readonly universe?: readonly string[]
  readonly symbols: readonly string[]
  readonly candidateSymbols?: readonly string[]
  readonly candidateEvidencePolicy?: IntradayCandidateEvidencePolicy
  readonly candidateExclusions?: readonly IntradayCandidateExclusion[]
  readonly purpose?: IntradaySnapshotPurpose
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

export type VerifiedMarketSnapshot = StreamingVerifiedMarketSnapshot | SimulatedVerifiedMarketSnapshot
export type MarketSnapshotReference = StreamingVerifiedSnapshotReference | SimulatedSnapshotReference

export interface IntradayMarketDataService {
  readonly check: Effect.Effect<void, OperationalError>
  readonly loadSnapshot: (query: IntradaySnapshotQuery) => Effect.Effect<VerifiedMarketSnapshot, OperationalError>
  readonly verifyReference: (
    snapshot: StreamingMarketSnapshot | SimulatedMarketSnapshot,
  ) => Effect.Effect<MarketSnapshotReference, OperationalError>
}

export class MarketDataHealth extends Context.Service<MarketDataHealth, Pick<IntradayMarketDataService, 'check'>>()(
  'bayn/MarketDataHealth',
) {}

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

export enum IntradayIngestionDelayDirection {
  BelowMinimum = 'below-minimum',
  AboveMaximum = 'above-maximum',
}

export class IntradaySnapshotFailure extends Data.TaggedError('IntradaySnapshotFailure')<{
  readonly reason: IntradaySnapshotFailureReason
  readonly message: string
  readonly ingestionDelayDirection?: IntradayIngestionDelayDirection
  readonly facts?: Readonly<Record<string, unknown>>
  readonly cause?: unknown
}> {}

export const intradaySnapshotSymbols = (query: IntradaySnapshotQuery): readonly string[] =>
  query.symbols ?? query.universe
