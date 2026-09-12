import { Result } from 'effect'
import { canonicalHashV1 } from '../hash'
import {
  featureBarContentHash,
  decodeRollingMarketFeature,
  MarketFeatureContract,
  MarketFeatureDefinition,
  MarketFeatureSessionPolicy,
} from '../market-data/features/contract'
import {
  incorporateRecordedMarketValue,
  incorporateMarketRecord,
  emptyStreamingProjection,
} from '../market-data/streaming/projection'
import { KafkaBootstrapTimestampPolicy } from '../market-data/streaming/bootstrap'
import { constructStreamingSnapshot } from '../market-data/streaming/snapshot'
import { intradayInstantNanos } from '../market-data/intraday/time'
import type {
  ArchiveVerifiedIntradayMarketSnapshot,
  IntradaySnapshotQuery,
  IntradaySnapshotRequest,
} from '../market-data/intraday/model'
import { verifyIntradaySnapshot, persistIntradayRecordRows } from '../market-data/intraday/verification'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import {
  defaultIntradayMomentumProtocolDocument as protocol,
  intradayMomentumFeatureTopic,
} from '../strategy/intraday-momentum/protocol'
import { availabilityRequest } from './archive-availability-fixture'

export const streamingFixture = () => {
  const { purpose: _purpose, ...baseRequest } = availabilityRequest
  const request: IntradaySnapshotRequest = {
    ...baseRequest,
    rangeStartAt: '2026-09-04T14:00:00.000Z',
    maximumQuoteAgeMs: protocol.maximumQuoteAgeMs,
    minimumWatermarkLagMs: 2000,
    symbols: [...protocol.candidateSymbols, protocol.benchmarkSymbol].sort(),
    candidateSymbols: protocol.candidateSymbols,
  }
  const raw = makeIntradayMomentumTestSnapshot(protocol, request, { AAPL: 0.02, AMZN: 0.01 })
  const { cut, query, snapshot, rows } = streamingFixtureFromRaw(raw, request)
  const archive = Result.getOrThrow(
    verifyIntradaySnapshot(request, {
      ...rows,
      archiveWatermarks: request.archiveWatermarks.map((value) => ({
        source_topic: value.sourceTopic,
        source_partition: value.sourcePartition,
        inclusive_last_offset: value.inclusiveLastOffset,
      })),
    }),
  )
  return { cut, query, snapshot, rows, archive: archive as ArchiveVerifiedIntradayMarketSnapshot, protocol }
}

export const streamingFixtureFromRaw = (
  raw: ReturnType<typeof makeIntradayMomentumTestSnapshot>,
  request: IntradaySnapshotRequest,
) => {
  const universe = {
    universeId: protocol.universeId,
    universeSymbolHash: protocol.universeSymbolHash,
    symbols: protocol.universe,
    topics: { ...protocol.sourceTopics, features: intradayMomentumFeatureTopic },
  }
  const observed = Date.parse(request.observedAt)
  let projection = emptyStreamingProjection('fixture-epoch')
  for (const record of [...raw.bars, ...raw.quotes, ...raw.trades].sort(
    (a, b) => a.sourceTopic.localeCompare(b.sourceTopic) || Number(BigInt(a.sourceOffset) - BigInt(b.sourceOffset)),
  ))
    projection = incorporateRecordedMarketValue(projection, record, universe, observed)
  let offset = 0
  for (const symbol of request.purpose === undefined ? (request.symbols ?? []) : []) {
    const bars = raw.bars.filter((bar) => bar.symbol === symbol)
    const material = {
      schemaVersion: MarketFeatureContract.V1,
      definitionId: MarketFeatureDefinition.RollingPrice30m,
      definitionHash: protocol.streamingInput.requiredDefinitionHash,
      provider: 'alpaca',
      feed: 'iex',
      delayClass: 'real_time_exchange_only',
      universeId: protocol.universeId,
      universeSymbolHash: protocol.universeSymbolHash,
      symbol,
      sessionDate: request.sessionDate,
      sessionPolicy: MarketFeatureSessionPolicy.RegularNewYork,
      windowStartMs: Date.parse(request.rangeStartAt),
      windowEndMs: Date.parse(request.rangeEndAt),
      inputs: bars.map((bar) => ({
        eventTimeNanos: intradayInstantNanos(bar.eventAt).toString(),
        ingestionTimeNanos: intradayInstantNanos(bar.ingestedAt).toString(),
        sourceTopic: bar.sourceTopic,
        sourcePartition: bar.sourcePartition,
        sourceOffset: bar.sourceOffset,
        contentHash: Result.getOrThrow(featureBarContentHash(bar)),
      })),
      values: {
        referencePriceMicros: '100000000',
        rangeHighPriceMicros: '101000000',
        rangeLowPriceMicros: '99000000',
        lastClosePriceMicros: '100000000',
        totalVolumeMicros: '30000000000',
      },
    }
    const feature = Result.getOrThrow(
      decodeRollingMarketFeature({
        material,
        featureId: canonicalHashV1(material),
        computedAtMs: observed,
        producerRevision: 'fixture',
      }),
    )
    projection = incorporateMarketRecord(
      projection,
      { topic: intradayMomentumFeatureTopic, partition: 0, offset: String(offset++), value: JSON.stringify(feature) },
      universe,
      observed,
    )
  }
  const positions = Object.values(universe.topics)
    .sort()
    .map((topic) => ({
      topic,
      partition: 0,
      offset: String(BigInt(projection.offsets.get(`${topic}:0`) ?? '-1') + 1n),
    }))
  const cut = {
    projection,
    positions,
    bootstrap: {
      schemaVersion: 'bayn.kafka-bootstrap.v1' as const,
      epoch: projection.epoch,
      observedAtMs: observed - 1000,
      lowerTimestampMs: Date.parse(request.rangeStartAt) - 5000,
      timestampPolicy: KafkaBootstrapTimestampPolicy.ProducerClock,
      partitions: positions.map((position) => ({
        topic: position.topic,
        partition: position.partition,
        logStartOffset: '0',
        startOffset: '0',
        endOffset: position.offset,
      })),
    },
  }
  const query: IntradaySnapshotQuery = request
  const snapshot = Result.getOrThrow(constructStreamingSnapshot(cut, query))
  const rows = Result.getOrThrow(persistIntradayRecordRows(snapshot))
  return { cut, query, snapshot, rows }
}
