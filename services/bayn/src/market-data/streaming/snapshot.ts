import { Result } from 'effect'

import { canonicalHashV1Result } from '../../hash'
import type {
  ArchiveVerifiedIntradayMarketSnapshot,
  IntradayMarketSnapshot,
  IntradayRecordIdentity,
  IntradaySnapshotManifest,
  IntradaySnapshotQuery,
} from '../intraday/model'
import { IntradaySnapshotFailure } from '../intraday/model'
import { compareRecords, lineageOf, verifyIntradaySnapshotQuery } from '../intraday/verification'
import type { RollingMarketFeature } from '../features/contract'
import type { KafkaProjectionCut } from './kafka'
import type { KafkaBootstrapEvidence, KafkaPartitionPosition } from './bootstrap'
import { kafkaBootstrapComplete } from './bootstrap'
import { topicPartitionKey, type ObservedMarketValue } from './projection'
import { selectStreamingInputs } from './inputs'

export interface StreamingRecordReceipt {
  readonly sourceTopic: string
  readonly sourcePartition: number
  readonly sourceOffset: string
  readonly availableAtMs: number
  readonly sequence: number
  readonly contentHash: string
}
export interface StreamingFeatureReceipt {
  readonly topic: string
  readonly partition: number
  readonly offset: string
  readonly availableAtMs: number
  readonly sequence: number
  readonly value: RollingMarketFeature
}
export interface StreamingSnapshotEvidence {
  readonly schemaVersion: 'bayn.streaming-input-cut.v1'
  readonly bootstrap: KafkaBootstrapEvidence
  readonly positions: readonly KafkaPartitionPosition[]
  readonly sequence: number
  readonly records: readonly StreamingRecordReceipt[]
  readonly features: readonly StreamingFeatureReceipt[]
}
export interface StreamingSnapshotManifest extends Omit<
  IntradaySnapshotManifest,
  'schemaVersion' | 'archiveWatermarks'
> {
  readonly schemaVersion: 'bayn.streaming-market-snapshot.v1'
  readonly universe: readonly string[]
  readonly streaming: StreamingSnapshotEvidence
}
export interface StreamingMarketSnapshot extends Omit<IntradayMarketSnapshot, 'manifest'> {
  readonly manifest: StreamingSnapshotManifest
}
const StreamingVerifiedSnapshotTypeId: unique symbol = Symbol('StreamingVerifiedSnapshot')
export type StreamingVerifiedMarketSnapshot = StreamingMarketSnapshot & {
  readonly [StreamingVerifiedSnapshotTypeId]: true
}
export type StrategyMarketSnapshot = IntradayMarketSnapshot | StreamingMarketSnapshot
export type VerifiedStrategyMarketSnapshot = ArchiveVerifiedIntradayMarketSnapshot | StreamingVerifiedMarketSnapshot

const failure = (reason: IntradaySnapshotFailure['reason'], message: string, cause?: unknown) =>
  new IntradaySnapshotFailure({ reason, message, ...(cause === undefined ? {} : { cause }) })
const hash = (value: unknown) =>
  canonicalHashV1Result(value).pipe(
    Result.mapError((cause) => failure('hash', 'Streaming input is not canonical', cause)),
  )
const recordReceipt = (entry: ObservedMarketValue<IntradayRecordIdentity>) =>
  Result.map(
    hash(entry.value),
    (contentHash): StreamingRecordReceipt => ({
      sourceTopic: entry.value.sourceTopic,
      sourcePartition: entry.value.sourcePartition,
      sourceOffset: entry.value.sourceOffset,
      availableAtMs: entry.availableAtMs,
      sequence: entry.sequence,
      contentHash,
    }),
  )

export const constructStreamingSnapshot = (
  cut: KafkaProjectionCut,
  query: IntradaySnapshotQuery,
): Result.Result<StreamingVerifiedMarketSnapshot, IntradaySnapshotFailure> =>
  Result.gen(function* () {
    const request = yield* verifyIntradaySnapshotQuery(query)
    const state = cut.projection
    const observedAtMs = Date.parse(request.observedAt)
    if (
      state.availabilityMode !== 'observed' ||
      cut.bootstrap.epoch !== state.epoch ||
      !kafkaBootstrapComplete(cut.bootstrap, cut.positions) ||
      cut.bootstrap.observedAtMs > observedAtMs ||
      state.minimumObservationMs > observedAtMs ||
      Date.parse(request.rangeStartAt) <= state.discardedRejectionsThroughMs
    )
      return yield* Result.fail(
        failure('not-ready', 'Streaming projection has no complete retained cut for this observation'),
      )
    const { symbols, entries, featureReceipts, bars, quotes, trades, availability, exclusions, excluded } =
      yield* selectStreamingInputs(state, request)
    const sourcePositions = new Map(
      cut.positions.map((position) => [topicPartitionKey(position.topic, position.partition), BigInt(position.offset)]),
    )
    for (const entry of entries) {
      const maximum = sourcePositions.get(topicPartitionKey(entry.value.sourceTopic, entry.value.sourcePartition))
      if (entry.sequence > state.sequence || maximum === undefined || BigInt(entry.value.sourceOffset) >= maximum)
        return yield* Result.fail(failure('watermark', 'Streaming row is outside the incorporated source cut'))
    }
    for (const feature of featureReceipts) {
      const maximum = sourcePositions.get(topicPartitionKey(feature.topic, feature.partition))
      if (feature.sequence > state.sequence || maximum === undefined || BigInt(feature.offset) >= maximum)
        return yield* Result.fail(failure('watermark', 'Streaming feature is outside the incorporated source cut'))
    }
    const material = {
      schemaVersion: 'bayn.streaming-market-snapshot.v1',
      sessionDate: request.sessionDate,
      calendar: request.calendar,
      rangeStartAt: request.rangeStartAt,
      rangeEndAt: request.rangeEndAt,
      observedAt: request.observedAt,
      universeId: request.universeId,
      universeSymbolHash: request.universeSymbolHash,
      universe: request.universe,
      symbols,
      ...(request.candidateSymbols === undefined
        ? {}
        : {
            candidateSymbols: request.candidateSymbols,
            candidateExclusions: [...exclusions.values()].toSorted((a, b) => a.symbol.localeCompare(b.symbol)),
          }),
      ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
      feed: request.feed,
      delayClass: request.delayClass,
      sourceTopics: {
        bars: request.sourceTopics.bars,
        quotes: request.sourceTopics.quotes,
        trades: request.sourceTopics.trades,
      },
      maximumQuoteAgeMs: request.maximumQuoteAgeMs,
      minimumWatermarkLagMs: request.minimumWatermarkLagMs,
      barCount: bars.length,
      quoteCount: quotes.length,
      tradeCount: trades.length,
      barsContentHash: yield* hash(bars),
      quotesContentHash: yield* hash(quotes),
      tradesContentHash: yield* hash(trades),
      lineage: yield* lineageOf([...bars, ...quotes, ...trades].toSorted(compareRecords)),
      streaming: {
        schemaVersion: 'bayn.streaming-input-cut.v1',
        bootstrap: cut.bootstrap,
        positions: cut.positions,
        sequence: state.sequence,
        records: (yield* Result.all(entries.map(recordReceipt))).toSorted((a, b) => a.sequence - b.sequence),
        features: featureReceipts.filter((feature) => !excluded.has(feature.value.material.symbol)),
      },
    } as const
    const contentHash = yield* hash(material)
    const snapshotId = yield* hash({ ...material, contentHash })
    return Object.freeze({
      [StreamingVerifiedSnapshotTypeId]: true as const,
      bars: Object.freeze(bars),
      quotes: Object.freeze(quotes),
      trades: Object.freeze(trades),
      latestQuotes: availability.latest,
      manifest: Object.freeze({ ...material, contentHash, snapshotId }),
    })
  })
