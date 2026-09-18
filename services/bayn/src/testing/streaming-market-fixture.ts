import { Effect, Result } from 'effect'
import { numberToMicros } from '../execution-model'
import type { StreamingVerifiedSnapshotReference } from '../market-data/streaming/reference'
import type { IntradayMarketDataService } from '../market-data/intraday/model'
import { reproduceStreamingSnapshot } from '../market-data/streaming/replay'
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
import type { IntradaySnapshotQuery, IntradaySnapshotRequest } from '../market-data/intraday/model'
import { verifyIntradaySnapshot, persistIntradayRecordRows } from '../market-data/intraday/verification'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import {
  defaultIntradayMomentumProtocolDocument as protocol,
  intradayMomentumFeatureTopic,
} from '../strategy/intraday-momentum/protocol'
import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { IntradaySnapshotPurpose } from '../market-data/intraday/model'

const rawPricingRequest: IntradaySnapshotRequest = {
  sessionDate: '2026-09-04',
  calendar: Result.getOrThrow(
    normalizeMarketCalendarResult([{ date: '2026-09-04', open: '09:30', close: '16:00' }], {
      start: '2026-09-04',
      end: '2026-09-04',
    }),
  ),
  rangeStartAt: '2026-09-04T14:29:00.000Z',
  rangeEndAt: '2026-09-04T14:30:00.000Z',
  observedAt: '2026-09-04T14:30:02.000Z',
  universeId: protocol.universeId,
  universeSymbolHash: protocol.universeSymbolHash,
  universe: protocol.universe,
  symbols: ['AAPL'],
  purpose: IntradaySnapshotPurpose.EntryPricing,
  feed: protocol.feed,
  delayClass: protocol.delayClass,
  sourceTopics: protocol.sourceTopics,
  maximumQuoteAgeMs: 2_000,
  minimumWatermarkLagMs: 0,
  archiveWatermarks: Object.values(protocol.sourceTopics)
    .toSorted()
    .map((sourceTopic) => ({
      sourceTopic,
      sourcePartition: 0,
      inclusiveLastOffset: '1000',
    })),
}

export const streamingFixture = (returns: Readonly<Record<string, number>> = { AAPL: 0.02, AMZN: 0.01 }) => {
  const { purpose: _purpose, ...baseRequest } = rawPricingRequest
  const request: IntradaySnapshotRequest = {
    ...baseRequest,
    rangeStartAt: '2026-09-04T14:00:00.000Z',
    maximumQuoteAgeMs: protocol.maximumQuoteAgeMs,
    minimumWatermarkLagMs: 2000,
    symbols: [...protocol.candidateSymbols, protocol.benchmarkSymbol].sort(),
    candidateSymbols: protocol.candidateSymbols,
  }
  const raw = makeIntradayMomentumTestSnapshot(protocol, request, returns)
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
  return { cut, query, snapshot, rows, archive, protocol }
}

export const streamingFixtureFromRaw = (
  raw: ReturnType<typeof makeIntradayMomentumTestSnapshot>,
  request: IntradaySnapshotQuery,
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
    if (bars.length !== 30) continue
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
        referencePriceMicros: Result.getOrThrow(numberToMicros(bars[0]?.open ?? 0, 'fixture open')).toString(),
        rangeHighPriceMicros: Result.getOrThrow(
          numberToMicros(Math.max(...bars.map((bar) => bar.high)), 'fixture high'),
        ).toString(),
        rangeLowPriceMicros: Result.getOrThrow(
          numberToMicros(Math.min(...bars.map((bar) => bar.low)), 'fixture low'),
        ).toString(),
        lastClosePriceMicros: Result.getOrThrow(numberToMicros(bars.at(-1)?.close ?? 0, 'fixture close')).toString(),
        totalVolumeMicros: Result.getOrThrow(
          numberToMicros(
            bars.reduce((total, bar) => total + bar.volume, 0),
            'fixture volume',
          ),
        ).toString(),
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

export const fixtureStreamingReference: IntradayMarketDataService['verifyReference'] = (snapshot) =>
  Effect.sync(() => {
    if (snapshot.manifest.schemaVersion !== 'bayn.streaming-market-snapshot.v1')
      throw new Error('Expected streaming test fixture')
    Result.getOrThrow(
      reproduceStreamingSnapshot(snapshot.manifest, Result.getOrThrow(persistIntradayRecordRows(snapshot))),
    )
    // This unit fixture supplies consumption authority; durable adapter tests use actual committed references.
    return {
      schemaVersion: 'bayn.streaming-snapshot-reference.v1',
      manifest: snapshot.manifest,
    } as StreamingVerifiedSnapshotReference
  })
