import { equityMarketProfile } from '../jev/markets'
import { Result } from 'effect'
import { canonicalHashV1Result } from '../hash'
import { historicalStreamingFixture } from './historical-streaming-fixture'
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
