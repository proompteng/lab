import { BarPublicationPolicy } from '../intraday/bar-publication'
import { Result, Schema } from 'effect'
import {
  SimulatedSnapshotSourceSchema,
  type StreamingSnapshotEvidenceSchema,
  type SimulatedSnapshotEvidenceSchema,
  type TechnicalSnapshotEvidenceSchema,
} from './evidence-schema'
import { strictParseOptions } from '../../schemas'
import type { WebullSnapshotEvidence } from './webull-projection'
import type { HistoricalMarketCursor } from './historical'

import { canonicalHashV1Result, canonicalJsonEqualV1 } from '../../hash'
import { freezeEvidence } from '../../immutable-evidence'
import type {
  IntradayMarketSnapshot,
  IntradayRecordIdentity,
  IntradaySnapshotManifest,
  IntradaySnapshotQuery,
} from '../intraday/model'
import { IntradaySnapshotFailure, IntradaySnapshotPurpose } from '../intraday/model'
import { compareRecords, lineageOf, replayedBarRow, verifyIntradaySnapshotQuery } from '../intraday/verification'
import type { NativeMarketFeature } from '../features/native-feature'
import type { KafkaProjectionCut } from './kafka'
import type { KafkaBootstrapEvidence, KafkaPartitionPosition } from './bootstrap'
import { kafkaBootstrapComplete, verifyKafkaSourceBounds } from './bootstrap'
import { topicPartitionKey, type StreamingProjection, type ObservedMarketValue } from './projection'
import { selectStreamingInputs } from './inputs'
import { InputReadinessReason } from '../intraday/input-readiness'
import { MarketFeatureDefinition } from '../features/contract'
import { intradayInstantNanos } from '../intraday/time'
import { isContinuousMarket } from '../../market-hours'
import { StrategySnapshotManifestSchema } from './manifest-schema'

export interface StreamingRecordReceipt {
  readonly sourceTopic: string
  readonly sourcePartition: number
  readonly sourceOffset: string
  readonly availableAtMs: number
  readonly sequence: number
  readonly contentHash: string
}
export interface StreamingFeatureReceipt<A = NativeMarketFeature> {
  readonly topic: string
  readonly partition: number
  readonly offset: string
  readonly availableAtMs: number
  readonly sequence: number
  readonly value: A
}
export interface StreamingSnapshotEvidence {
  readonly schemaVersion: 'bayn.streaming-input-cut.v1'
  readonly barPublicationPolicy: BarPublicationPolicy.ObservedHistory
  readonly bootstrap: KafkaBootstrapEvidence
  readonly positions: readonly KafkaPartitionPosition[]
  readonly sequence: number
  readonly records: readonly StreamingRecordReceipt[]
  readonly features: readonly StreamingFeatureReceipt[]
  readonly barPublications?: (typeof StreamingSnapshotEvidenceSchema.Type)['barPublications']
  readonly webull?: WebullSnapshotEvidence
  readonly technical?: typeof TechnicalSnapshotEvidenceSchema.Type
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
export interface SimulatedSnapshotManifest extends Omit<StreamingSnapshotManifest, 'schemaVersion' | 'streaming'> {
  readonly schemaVersion: 'bayn.simulated-market-snapshot.v2'
  readonly streaming: typeof SimulatedSnapshotEvidenceSchema.Type
}
export interface SimulatedMarketSnapshot extends Omit<IntradayMarketSnapshot, 'manifest'> {
  readonly manifest: SimulatedSnapshotManifest
}
const SimulatedVerifiedSnapshotTypeId: unique symbol = Symbol('SimulatedVerifiedSnapshot')
export type SimulatedVerifiedMarketSnapshot = SimulatedMarketSnapshot & {
  readonly [SimulatedVerifiedSnapshotTypeId]: true
}
export type StrategyMarketSnapshot = StreamingMarketSnapshot | SimulatedMarketSnapshot
export type VerifiedStrategyMarketSnapshot = StreamingVerifiedMarketSnapshot | SimulatedVerifiedMarketSnapshot

const ownedSnapshots = new WeakSet<StrategyMarketSnapshot>()

export const isOwnedMarketSnapshot = (snapshot: StrategyMarketSnapshot): snapshot is VerifiedStrategyMarketSnapshot =>
  ownedSnapshots.has(snapshot)

const decodeManifest = Schema.decodeUnknownResult(StrategySnapshotManifestSchema, strictParseOptions)

const ownSnapshot = <A extends VerifiedStrategyMarketSnapshot>(snapshot: A) =>
  Result.gen(function* () {
    const decoded = yield* decodeManifest(snapshot.manifest).pipe(
      Result.mapError(() => failure('watermark', 'Market snapshot manifest violates its retained schema')),
    )
    if (!canonicalJsonEqualV1(decoded, snapshot.manifest))
      return yield* Result.fail(failure('watermark', 'Market snapshot manifest differs from its retained encoding'))
    const owned = freezeEvidence(snapshot)
    ownedSnapshots.add(owned)
    return owned
  })

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

export const prepareStreamingSnapshotCut = (cut: KafkaProjectionCut, query: IntradaySnapshotQuery) =>
  Result.gen(function* () {
    const request = yield* verifyIntradaySnapshotQuery(query)
    const state = cut.projection
    const observedAtMs = Date.parse(request.observedAt)
    const source = state.sources.get(request.universeId)
    if (source === undefined) return yield* Result.fail(failure('not-ready', 'Market source has no incorporated input'))
    const sourceTopics = new Set(Object.values(source.topics))
    const sourceBootstrap = {
      ...cut.bootstrap,
      partitions: cut.bootstrap.partitions.filter((partition) => sourceTopics.has(partition.topic)),
    }
    const sourcePositions = cut.positions.filter((position) => sourceTopics.has(position.topic))
    yield* verifyKafkaSourceBounds(sourceBootstrap, sourcePositions).pipe(
      Result.mapError((cause) => failure('watermark', cause.message)),
    )
    const requiredPartitions =
      request.purpose === IntradaySnapshotPurpose.Liquidation
        ? sourceBootstrap.partitions.filter((partition) => partition.topic === request.sourceTopics.quotes)
        : sourceBootstrap.partitions
    const requiredTopics = new Set(requiredPartitions.map((partition) => partition.topic))
    if (
      state.availabilityMode !== 'observed' ||
      cut.bootstrap.epoch !== state.epoch ||
      requiredPartitions.length === 0 ||
      !kafkaBootstrapComplete(
        { ...cut.bootstrap, partitions: requiredPartitions },
        cut.positions.filter((position) => requiredTopics.has(position.topic)),
      ) ||
      cut.bootstrap.observedAtMs > observedAtMs
    )
      return yield* Result.fail(
        failure('not-ready', 'Streaming projection has no complete retained cut for this observation'),
      )
    return { request, sourceBootstrap, sourcePositions }
  })

export const constructStreamingSnapshot = (
  cut: KafkaProjectionCut,
  query: IntradaySnapshotQuery,
): Result.Result<StreamingVerifiedMarketSnapshot, IntradaySnapshotFailure> =>
  Result.gen(function* () {
    const { request, sourceBootstrap, sourcePositions } = yield* prepareStreamingSnapshotCut(cut, query)
    const state = cut.projection
    const snapshot = yield* constructSnapshotMaterial(state, request, sourcePositions, {
      schemaVersion: 'bayn.streaming-market-snapshot.v1',
      streaming: { schemaVersion: 'bayn.streaming-input-cut.v1', bootstrap: sourceBootstrap },
    })
    return yield* ownSnapshot({ ...structuredClone(snapshot), [StreamingVerifiedSnapshotTypeId]: true as const })
  })

type SnapshotProvenance =
  | {
      readonly schemaVersion: StreamingSnapshotManifest['schemaVersion']
      readonly streaming: Pick<StreamingSnapshotEvidence, 'schemaVersion' | 'bootstrap'>
    }
  | {
      readonly schemaVersion: SimulatedSnapshotManifest['schemaVersion']
      readonly streaming: typeof SimulatedSnapshotSourceSchema.Type & {
        readonly schemaVersion: 'bayn.simulated-input-cut.v2'
      }
    }

const constructSnapshotMaterial = <P extends SnapshotProvenance>(
  state: StreamingProjection,
  request: IntradaySnapshotQuery,
  positions: readonly KafkaPartitionPosition[],
  provenance: P,
) =>
  Result.gen(function* () {
    const {
      symbols,
      entries,
      featureReceipts,
      barPublications,
      technical,
      webull,
      bars,
      quotes,
      trades,
      availability,
      exclusions,
      excluded,
    } = yield* selectStreamingInputs(state, request)
    if (
      request.purpose === undefined &&
      request.candidateSymbols !== undefined &&
      request.candidateSymbols.length > 0 &&
      request.candidateSymbols.every((symbol) => excluded.has(symbol))
    )
      return yield* Result.fail(
        new IntradaySnapshotFailure({
          reason: 'not-ready',
          message: 'No candidate has complete raw data and a matching rolling feature',
          facts: {
            inputReadiness: {
              reason: InputReadinessReason.AllCandidatesExcluded,
              observedAt: request.observedAt,
              windowStartAt: request.rangeStartAt,
              windowEndAt: request.rangeEndAt,
              ...(isContinuousMarket(request.calendar)
                ? {}
                : { requiredFeatureDefinition: MarketFeatureDefinition.ObservedPriceWindow }),
              candidateCount: request.candidateSymbols.length,
              matchingFeatureCandidateCount: request.candidateSymbols.filter((symbol) =>
                featureReceipts.some((feature) => feature.value.material.symbol === symbol),
              ).length,
              completedBarCandidateCount: request.candidateSymbols.filter((symbol) =>
                bars.some(
                  (bar) =>
                    bar.symbol === symbol &&
                    intradayInstantNanos(bar.eventAt) === intradayInstantNanos(request.rangeEndAt) - 60_000_000_000n,
                ),
              ).length,
            },
          },
        }),
      )
    const sourcePositions = new Map(
      positions.map((position) => [topicPartitionKey(position.topic, position.partition), BigInt(position.offset)]),
    )
    const deliveries = [
      ...[...entries, ...barPublications].map(({ value, sequence, availableAtMs }) => ({
        topic: value.sourceTopic,
        partition: value.sourcePartition,
        offset: value.sourceOffset,
        sequence,
        availableAtMs,
      })),
      ...featureReceipts,
      ...(technical?.features ?? []),
      ...(webull?.captures ?? []).map(({ record, sequence, availableAtMs }) => ({
        ...record,
        sequence,
        availableAtMs,
      })),
    ].sort((a, b) => a.sequence - b.sequence)
    const priorOffsets = new Map<string, bigint>()
    const observedAtMs = Date.parse(request.observedAt)
    let priorSequence = 0
    for (const delivery of deliveries) {
      const partition = topicPartitionKey(delivery.topic, delivery.partition)
      const maximum = sourcePositions.get(partition)
      const offset = BigInt(delivery.offset)
      if (
        delivery.sequence <= priorSequence ||
        delivery.sequence > state.sequence ||
        delivery.availableAtMs > observedAtMs ||
        maximum === undefined ||
        offset >= maximum ||
        offset <= (priorOffsets.get(partition) ?? -1n)
      )
        return yield* Result.fail(failure('watermark', 'Streaming delivery is outside the incorporated source cut'))
      priorSequence = delivery.sequence
      priorOffsets.set(partition, offset)
    }
    const schemaVersion: P['schemaVersion'] = provenance.schemaVersion
    const streaming: P['streaming'] = provenance.streaming
    const material = {
      schemaVersion,
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
      ...(request.candidateEvidencePolicy === undefined
        ? {}
        : { candidateEvidencePolicy: request.candidateEvidencePolicy }),
      ...(request.benchmarkEvidencePolicy === undefined
        ? {}
        : { benchmarkEvidencePolicy: request.benchmarkEvidencePolicy }),
      ...(request.benchmarkSymbols === undefined ? {} : { benchmarkSymbols: request.benchmarkSymbols }),
      barCount: bars.length,
      quoteCount: quotes.length,
      tradeCount: trades.length,
      barsContentHash: yield* hash(bars),
      quotesContentHash: yield* hash(quotes),
      tradesContentHash: yield* hash(trades),
      lineage: yield* lineageOf([...bars, ...quotes, ...trades].toSorted(compareRecords)),
      streaming: {
        ...streaming,
        barPublicationPolicy: BarPublicationPolicy.ObservedHistory,
        ...(technical === undefined ? {} : { technical }),
        ...(webull === undefined ? {} : { webull }),
        ...(barPublications.length === 0
          ? {}
          : {
              barPublications: yield* Result.all(
                barPublications
                  .toSorted((a, b) => a.sequence - b.sequence)
                  .map((entry) => Result.all({ row: replayedBarRow(entry.value), receipt: recordReceipt(entry) })),
              ),
            }),
        positions,
        sequence: state.sequence,
        records: (yield* Result.all(entries.map(recordReceipt))).toSorted((a, b) => a.sequence - b.sequence),
        features:
          request.candidateEvidencePolicy !== undefined
            ? featureReceipts
            : featureReceipts.filter((feature) => !excluded.has(feature.value.material.symbol)),
      },
    } as const
    const contentHash = yield* hash(material)
    const snapshotId = yield* hash({ ...material, contentHash })
    return Object.freeze({
      bars: Object.freeze(bars),
      quotes: Object.freeze(quotes),
      trades: Object.freeze(trades),
      latestQuotes: availability.latest,
      manifest: Object.freeze({ ...material, contentHash, snapshotId }),
    })
  })

/** Simulation authority comes only from an ordered cursor and its frozen source manifest. */
export const constructSimulatedSnapshot = (
  cursor: HistoricalMarketCursor,
  source: typeof SimulatedSnapshotSourceSchema.Type,
  query: IntradaySnapshotQuery,
): Result.Result<SimulatedVerifiedMarketSnapshot, IntradaySnapshotFailure> =>
  Result.gen(function* () {
    const provenance = yield* Schema.decodeUnknownResult(
      SimulatedSnapshotSourceSchema,
      strictParseOptions,
    )(source).pipe(Result.mapError((cause) => failure('hash', 'Invalid simulated source provenance', cause)))
    const request = yield* verifyIntradaySnapshotQuery(query)
    const state = cursor.projection
    const observedAtMs = Date.parse(request.observedAt)
    const universe = provenance.marketSources.find((source) => source.universeId === request.universeId)
    if (
      universe === undefined ||
      state.availabilityMode !== 'simulated' ||
      (yield* hash(cursor.source ?? null)) !== (yield* hash(provenance)) ||
      cursor.runId !== provenance.runId ||
      state.epoch !== `historical-${provenance.runId}` ||
      (yield* hash(cursor.marketSources)) !== (yield* hash(provenance.marketSources)) ||
      universe.universeSymbolHash !== request.universeSymbolHash ||
      universe.topics.bars !== request.sourceTopics.bars ||
      universe.topics.quotes !== request.sourceTopics.quotes ||
      universe.topics.trades !== request.sourceTopics.trades ||
      universe.symbols.join(',') !== request.universe.join(',') ||
      cursor.regeneratedFeaturesRecordedAtMs !== provenance.regeneratedFeaturesRecordedAtMs ||
      cursor.regeneratedTechnicalFeaturesRecordedAtMs !== provenance.regeneratedTechnicalFeaturesRecordedAtMs ||
      (cursor.lastArrival !== null && cursor.lastArrival.availableAtMs > observedAtMs)
    )
      return yield* Result.fail(failure('not-ready', 'Historical cursor does not match the simulated observation'))
    const positions = [...state.offsets]
      .map(([key, offset]) => ({
        topic: key.slice(0, key.lastIndexOf(':')),
        partition: Number(key.slice(key.lastIndexOf(':') + 1)),
        offset: String(BigInt(offset) + 1n),
      }))
      .toSorted((a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition)
    const snapshot = yield* constructSnapshotMaterial(state, request, positions, {
      schemaVersion: 'bayn.simulated-market-snapshot.v2',
      streaming: { schemaVersion: 'bayn.simulated-input-cut.v2', ...provenance },
    })
    return yield* ownSnapshot({ ...structuredClone(snapshot), [SimulatedVerifiedSnapshotTypeId]: true as const })
  })
