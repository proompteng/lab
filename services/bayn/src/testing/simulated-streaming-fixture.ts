import { retainedEquityMarketProfile as equityMarketProfile } from '../jev/markets'
import { Result } from 'effect'
import { canonicalHashV1Result } from '../hash'
import { historicalStreamingFixture } from './historical-streaming-fixture'
import { historicalRawArrivals } from './historical-streaming-fixture'
import { nativeJevFixture } from '../jev/native.test-support'
import { jevBehaviorHash } from '../jev/protocol'
import {
  advanceHistoricalMarketCursor,
  createHistoricalMarketCursor,
  type HistoricalMarketCursor,
} from '../market-data/streaming/historical'

export const simulationFixture = (
  regeneratedAtMs?: number,
  technicalFeatureTopic?: string,
  returns?: Readonly<Record<string, number>>,
  observedTradePrices = false,
) => {
  const fixture = historicalStreamingFixture(returns, observedTradePrices)
  const { input, protocol } = fixture
  const universe = {
    universeId: equityMarketProfile.universeId,
    universeSymbolHash: equityMarketProfile.universeSymbolHash,
    symbols: protocol.universe,
    topics: {
      ...equityMarketProfile.sourceTopics,
      features: equityMarketProfile.streamingInput.featureTopic,
      ...(technicalFeatureTopic === undefined ? {} : { technicalFeatures: technicalFeatureTopic }),
    },
  }
  const source = {
    runId: input.arrivals.runId,
    sourceManifestHash: Result.getOrThrow(canonicalHashV1Result(input)),
    deliveryModel: {
      ...input.arrivals.deliveryModel,
      schemaVersion: 'bayn.supplied-arrival-times.v1' as const,
      tieBreak: 'availability-topic-partition-offset' as const,
    },
    marketSources: [universe] as const,
    ...(regeneratedAtMs === undefined ? {} : { regeneratedFeaturesRecordedAtMs: regeneratedAtMs }),
  }
  let cursor: HistoricalMarketCursor = Result.getOrThrow(
    createHistoricalMarketCursor(source.runId, source.marketSources, regeneratedAtMs, source),
  )
  const events = input.arrivals.events.toSorted(
    (a, b) =>
      a.availableAtMs - b.availableAtMs ||
      a.record.topic.localeCompare(b.record.topic) ||
      a.record.partition - b.record.partition ||
      Number(BigInt(a.record.offset) - BigInt(b.record.offset)),
  )
  for (const arrival of events) {
    const event =
      regeneratedAtMs !== undefined && arrival.record.topic === universe.topics.features
        ? {
            ...arrival,
            record: {
              ...arrival.record,
              value: JSON.stringify({ ...JSON.parse(arrival.record.value), computedAtMs: regeneratedAtMs }),
            },
          }
        : arrival
    cursor = Result.getOrThrow(advanceHistoricalMarketCursor(cursor, event))
  }
  return { ...fixture, source, cursor }
}

/** Current native lifecycle fixtures retain v3 arrivals; legacy simulationFixture stays frozen. */
export const nativeSimulationFixture = (
  _regeneratedAtMs?: undefined,
  _technicalFeatureTopic?: undefined,
  returns?: Readonly<Record<string, number>>,
  observedTradePrices = true,
) => {
  const fixture = nativeJevFixture(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    returns,
    undefined,
    observedTradePrices,
  )
  const observedAtMs = Date.parse(fixture.query.observedAt)
  const market = fixture.protocol.marketProfiles.find((profile) => profile.feed === 'iex')
  if (market === undefined) throw new Error('Native lifecycle fixture requires the equity source')
  const universe = {
    universeId: market.universeId,
    universeSymbolHash: market.universeSymbolHash,
    symbols: market.universe,
    topics: { ...market.sourceTopics, features: market.streamingInput.featureTopic },
  }
  const raw = historicalRawArrivals(fixture.snapshot, observedAtMs)
  const features = [...fixture.cut.projection.features.values()].flat().map((feature) => ({
    availableAtMs: observedAtMs,
    record: { topic: feature.topic, partition: 0, offset: feature.offset, value: JSON.stringify(feature.value) },
  }))
  const input = {
    schemaVersion: 'bayn.historical-streaming-strategy-input.v1',
    protocolHash: Result.getOrThrow(canonicalHashV1Result(fixture.protocol)),
    behaviorHash: jevBehaviorHash,
    sessionDate: '2026-09-04',
    calendar: [{ session_open: '0930', session_close: '1600', date: '2026-09-04', open: '09:30', close: '16:00' }],
    arrivals: {
      schemaVersion: 'bayn.historical-market-arrivals.v1',
      runId: 'a'.repeat(64),
      observedAtMs,
      deliveryModel: {
        schemaVersion: 'bayn.supplied-arrival-times.v1' as const,
        description: 'Native synthetic arrivals available at the supplied observation',
        tieBreak: 'availability-topic-partition-offset' as const,
      },
      events: [...raw, ...features],
    },
  }
  const source = {
    runId: input.arrivals.runId,
    sourceManifestHash: Result.getOrThrow(canonicalHashV1Result(input)),
    deliveryModel: input.arrivals.deliveryModel,
    marketSources: [universe] as const,
  }
  let cursor: HistoricalMarketCursor = Result.getOrThrow(
    createHistoricalMarketCursor(source.runId, source.marketSources, undefined, source),
  )
  for (const arrival of input.arrivals.events.toSorted(
    (a, b) =>
      a.availableAtMs - b.availableAtMs ||
      a.record.topic.localeCompare(b.record.topic) ||
      a.record.partition - b.record.partition ||
      Number(BigInt(a.record.offset) - BigInt(b.record.offset)),
  ))
    cursor = Result.getOrThrow(advanceHistoricalMarketCursor(cursor, arrival))
  return { ...fixture, input, source, cursor, raw, features }
}
