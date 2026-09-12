import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../../hash'
import { strictParseOptions } from '../../schemas'
import { IntradaySnapshotFailure, type IntradaySnapshotQuery } from '../intraday/model'
import { decodeIntradayBarRows, decodeIntradayQuoteRows, decodeIntradayTradeRows } from '../intraday/rows'
import {
  normalizeBar,
  normalizeQuote,
  normalizeTrade,
  type PersistedIntradaySnapshotRows,
} from '../intraday/verification'
import { bootstrapKafkaPartitions, canonicalPositions } from './bootstrap'
import { StreamingSnapshotEvidenceSchema } from './evidence-schema'
import {
  emptyStreamingProjection,
  incorporateMarketRecord,
  incorporateRecordedMarketValue,
  topicPartitionKey,
} from './projection'
import { constructStreamingSnapshot, type StreamingMarketSnapshot, type StreamingSnapshotManifest } from './snapshot'
import type { StreamingUniverse } from './raw-events'

const fail = (message: string, cause?: unknown) =>
  new IntradaySnapshotFailure({ reason: 'hash', message, ...(cause === undefined ? {} : { cause }) })
const coordinate = (topic: string, partition: number, offset: string) =>
  `${topicPartitionKey(topic, partition)}:${offset}`

/** Reproduces a saved cut; this does not grant a replay document live source authority. */
export const reproduceStreamingSnapshot = (
  manifest: StreamingSnapshotManifest,
  rows: PersistedIntradaySnapshotRows,
): Result.Result<StreamingMarketSnapshot, IntradaySnapshotFailure> =>
  Result.gen(function* () {
    const evidence = yield* Schema.decodeUnknownResult(StreamingSnapshotEvidenceSchema)(
      manifest.streaming,
      strictParseOptions,
    ).pipe(Result.mapError((cause) => fail('Invalid recorded streaming evidence', cause)))
    const bounds = yield* Result.try({
      try: () =>
        bootstrapKafkaPartitions(
          evidence.bootstrap.partitions.map((partition) => ({ ...partition, offset: partition.logStartOffset })),
          evidence.bootstrap.partitions.map((partition) => ({ ...partition, offset: partition.endOffset })),
          evidence.bootstrap.partitions.map((partition) => ({ ...partition, offset: partition.startOffset })),
        ),
      catch: (cause) => fail('Invalid recorded Kafka bootstrap bounds', cause),
    })
    if (
      (yield* canonicalHashV1Result(bounds).pipe(
        Result.mapError((cause) => fail('Invalid bootstrap bounds hash', cause)),
      )) !==
        (yield* canonicalHashV1Result(evidence.bootstrap.partitions).pipe(
          Result.mapError((cause) => fail('Invalid recorded bootstrap hash', cause)),
        )) ||
      canonicalPositions(evidence.positions).some((position, index) => position !== evidence.positions[index])
    )
      return yield* Result.fail(fail('Recorded Kafka bounds are not canonical'))
    const decoded = yield* Result.all({
      bars: decodeIntradayBarRows(rows.bars).pipe(Result.flatMap((values) => Result.all(values.map(normalizeBar)))),
      quotes: decodeIntradayQuoteRows(rows.quotes).pipe(
        Result.flatMap((values) => Result.all(values.map(normalizeQuote))),
      ),
      trades: decodeIntradayTradeRows(rows.trades).pipe(
        Result.flatMap((values) => Result.all(values.map(normalizeTrade))),
      ),
    })
    const values = [...decoded.bars, ...decoded.quotes, ...decoded.trades]
    const byCoordinate = new Map(
      values.map((value) => [coordinate(value.sourceTopic, value.sourcePartition, value.sourceOffset), value]),
    )
    if (byCoordinate.size !== values.length || evidence.records.length !== values.length)
      return yield* Result.fail(fail('Recorded rows and receipts must have exactly one matching source coordinate'))
    const featureTopics = [...new Set(evidence.features.map((feature) => feature.topic))]
    const rawTopics = new Set(Object.values(manifest.sourceTopics))
    const bootstrapFeatureTopics = [
      ...new Set(evidence.bootstrap.partitions.map((partition) => partition.topic)),
    ].filter((topic) => !rawTopics.has(topic))
    const featureTopic = bootstrapFeatureTopics[0]
    if (
      bootstrapFeatureTopics.length !== 1 ||
      featureTopic === undefined ||
      featureTopics.some((topic) => topic !== featureTopic)
    )
      return yield* Result.fail(fail('Recorded feature source is not bound by the bootstrap topic set'))
    const universe: StreamingUniverse = {
      universeId: manifest.universeId,
      universeSymbolHash: manifest.universeSymbolHash,
      symbols: manifest.universe,
      topics: { ...manifest.sourceTopics, features: featureTopic },
    }
    let projection = emptyStreamingProjection(evidence.bootstrap.epoch)
    const receiptKeys = new Set<string>()
    const deliveries = [
      ...evidence.records.map((receipt) => ({ kind: 'raw' as const, receipt })),
      ...evidence.features.map((receipt) => ({ kind: 'feature' as const, receipt })),
    ].toSorted((a, b) => a.receipt.sequence - b.receipt.sequence)
    let previousSequence = 0
    for (const delivery of deliveries) {
      const receipt = delivery.receipt
      if (
        receipt.sequence <= previousSequence ||
        receipt.sequence > evidence.sequence ||
        receipt.availableAtMs > Date.parse(manifest.observedAt)
      )
        return yield* Result.fail(fail('Recorded delivery sequence or availability lies outside the snapshot cut'))
      previousSequence = receipt.sequence
      projection = { ...projection, sequence: receipt.sequence - 1 }
      if (delivery.kind === 'raw') {
        const raw = delivery.receipt
        const key = coordinate(raw.sourceTopic, raw.sourcePartition, raw.sourceOffset)
        const value = byCoordinate.get(key)
        if (value === undefined || receiptKeys.has(key))
          return yield* Result.fail(fail('Recorded source receipt is missing or duplicated'))
        receiptKeys.add(key)
        const contentHash = yield* canonicalHashV1Result(value).pipe(
          Result.mapError((cause) => fail('Recorded raw value is not canonical', cause)),
        )
        if (contentHash !== raw.contentHash)
          return yield* Result.fail(fail('Recorded raw content differs from its receipt'))
        projection = incorporateRecordedMarketValue(projection, value, universe, raw.availableAtMs)
      } else {
        const feature = delivery.receipt
        projection = incorporateMarketRecord(
          projection,
          {
            topic: feature.topic,
            partition: feature.partition,
            offset: feature.offset,
            value: JSON.stringify(feature.value),
          },
          universe,
          feature.availableAtMs,
        )
      }
    }
    projection = { ...projection, sequence: evidence.sequence }
    const query: IntradaySnapshotQuery = {
      sessionDate: manifest.sessionDate,
      calendar: manifest.calendar,
      rangeStartAt: manifest.rangeStartAt,
      rangeEndAt: manifest.rangeEndAt,
      observedAt: manifest.observedAt,
      universeId: manifest.universeId,
      universeSymbolHash: manifest.universeSymbolHash,
      universe: manifest.universe,
      symbols: manifest.symbols,
      ...(manifest.candidateSymbols === undefined ? {} : { candidateSymbols: manifest.candidateSymbols }),
      ...(manifest.purpose === undefined ? {} : { purpose: manifest.purpose }),
      feed: manifest.feed,
      delayClass: manifest.delayClass,
      sourceTopics: manifest.sourceTopics,
      maximumQuoteAgeMs: manifest.maximumQuoteAgeMs,
      minimumWatermarkLagMs: manifest.minimumWatermarkLagMs,
    }
    const reproduced = yield* constructStreamingSnapshot(
      { projection, bootstrap: evidence.bootstrap, positions: evidence.positions },
      query,
    )
    if (
      reproduced.manifest.contentHash !== manifest.contentHash ||
      reproduced.manifest.snapshotId !== manifest.snapshotId
    )
      return yield* Result.fail(fail('Recorded inputs do not reproduce the bound streaming snapshot'))
    return reproduced
  })
