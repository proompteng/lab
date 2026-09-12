import { Result } from 'effect'

import { canonicalHashV1Result } from '../../hash'
import type {
  ArchiveVerifiedIntradayMarketSnapshot,
  IntradayBar,
  IntradayCandidateExclusion,
  IntradayMarketSnapshot,
  IntradayQuote,
  IntradayRecordIdentity,
  IntradaySnapshotManifest,
  IntradaySnapshotQuery,
  IntradayTrade,
} from '../intraday/model'
import { IntradaySnapshotFailure } from '../intraday/model'
import { intradayInstantNanos } from '../intraday/time'
import {
  candidateAvailability,
  compareRecords,
  lineageOf,
  validateBarStructure,
  validateIdentity,
  validateSourceTopics,
  verifyIntradaySnapshotQuery,
} from '../intraday/verification'
import { featureMatchesBars, marketFeatureClockSkewAllowanceMs, type RollingMarketFeature } from '../features/contract'
import type { KafkaProjectionCut } from './kafka'
import type { KafkaBootstrapEvidence, KafkaPartitionPosition } from './bootstrap'
import { kafkaBootstrapComplete } from './bootstrap'
import { topicPartitionKey, type ObservedMarketValue } from './projection'

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
const observedWithin = <A>(entry: ObservedMarketValue<A>, observedAtMs: number) => entry.availableAtMs <= observedAtMs
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
    const start = intradayInstantNanos(request.rangeStartAt)
    const end = intradayInstantNanos(request.rangeEndAt)
    if (
      cut.bootstrap.epoch !== state.epoch ||
      !kafkaBootstrapComplete(cut.bootstrap, cut.positions) ||
      cut.bootstrap.observedAtMs > observedAtMs ||
      state.minimumObservationMs > observedAtMs ||
      Date.parse(request.rangeStartAt) <= state.discardedRejectionsThroughMs
    )
      return yield* Result.fail(
        failure('not-ready', 'Streaming projection has no complete retained cut for this observation'),
      )
    const session = request.calendar.sessions.find((entry) => entry.date === request.sessionDate)
    if (session === undefined)
      return yield* Result.fail(failure('request', 'Streaming snapshot has no bound exchange session'))
    const symbols = request.symbols ?? request.universe
    const candidates = new Set(request.candidateSymbols)
    const entries: ObservedMarketValue<IntradayBar | IntradayQuote | IntradayTrade>[] = []
    const featureReceipts: StreamingFeatureReceipt[] = []
    const featureExclusions: IntradayCandidateExclusion[] = []
    const sourcePositions = new Map(
      cut.positions.map((position) => [topicPartitionKey(position.topic, position.partition), BigInt(position.offset)]),
    )
    for (const [key, history] of state.rejections) {
      const rejection = history.find(
        (entry) => entry.availableAtMs >= Date.parse(request.rangeStartAt) && entry.availableAtMs <= observedAtMs,
      )
      if (rejection !== undefined && sourcePositions.has(key))
        return yield* Result.fail(
          failure('rows', `Streaming partition ${key} contains rejected input: ${rejection.reason}`),
        )
    }
    for (const symbol of symbols) {
      const bars = (state.bars.get(symbol) ?? []).filter(
        (entry) =>
          observedWithin(entry, observedAtMs) &&
          intradayInstantNanos(entry.value.eventAt) >= start &&
          intradayInstantNanos(entry.value.eventAt) < end,
      )
      const quote = state.quoteHistory.get(symbol)?.findLast((entry) => observedWithin(entry, observedAtMs))
      const trade = state.tradeHistory.get(symbol)?.findLast((entry) => observedWithin(entry, observedAtMs))
      if (request.purpose === undefined) entries.push(...bars)
      if (quote !== undefined) entries.push(quote)
      if (request.purpose === undefined && trade !== undefined) entries.push(trade)
      if (request.purpose !== undefined) continue
      let selected: StreamingFeatureReceipt | undefined
      for (const candidate of state.features.get(symbol) ?? []) {
        if (
          candidate.availableAtMs > observedAtMs ||
          candidate.value.material.sessionDate !== request.sessionDate ||
          candidate.value.material.windowStartMs !== Date.parse(request.rangeStartAt) ||
          candidate.value.material.windowEndMs !== Date.parse(request.rangeEndAt)
        )
          continue
        const matches = yield* featureMatchesBars(
          candidate.value,
          bars.map((entry) => entry.value),
        ).pipe(Result.mapError((cause) => failure('identity', 'Streaming feature inputs failed verification', cause)))
        if (!matches) continue
        selected = {
          topic: candidate.topic,
          partition: candidate.partition,
          offset: candidate.offset,
          availableAtMs: candidate.availableAtMs,
          sequence: candidate.sequence,
          value: candidate.value,
        }
        break
      }
      if (selected !== undefined) featureReceipts.push(selected)
      else if (candidates.has(symbol))
        featureExclusions.push({
          symbol,
          reason: 'not-ready',
          message: 'matching complete rolling feature is unavailable',
        })
      else return yield* Result.fail(failure('not-ready', `Required rolling feature is unavailable for ${symbol}`))
    }
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
    const bars = entries
      .map((entry) => entry.value)
      .filter((value): value is IntradayBar => 'open' in value)
      .toSorted(compareRecords)
    const quotes = entries
      .map((entry) => entry.value)
      .filter((value): value is IntradayQuote => 'bidPrice' in value)
      .toSorted(compareRecords)
    const trades = entries
      .map((entry) => entry.value)
      .filter((value): value is IntradayTrade => 'price' in value)
      .toSorted(compareRecords)
    yield* validateSourceTopics(request, bars, quotes, trades)
    yield* validateIdentity(request, bars, request.rangeEndAt, false, undefined, marketFeatureClockSkewAllowanceMs)
    yield* validateIdentity(
      request,
      [...quotes, ...trades],
      session.closeAt,
      true,
      undefined,
      marketFeatureClockSkewAllowanceMs,
    )
    yield* validateBarStructure(request, bars, marketFeatureClockSkewAllowanceMs)
    const availability = yield* candidateAvailability(request, bars, quotes, trades, marketFeatureClockSkewAllowanceMs)
    const exclusions = new Map(availability.exclusions.map((exclusion) => [exclusion.symbol, exclusion]))
    for (const exclusion of featureExclusions)
      if (!exclusions.has(exclusion.symbol)) exclusions.set(exclusion.symbol, exclusion)
    const excluded = new Set(exclusions.keys())
    if (request.purpose === undefined && candidates.size > 0 && [...candidates].every((symbol) => excluded.has(symbol)))
      return yield* Result.fail(
        failure('not-ready', 'No candidate has complete raw data and a matching rolling feature'),
      )
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
