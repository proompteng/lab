import { Result } from 'effect'
import { canonicalHashV1 } from '../hash'
import { historicalStreamingFixture } from './historical-streaming-fixture'
import {
  advanceHistoricalMarketCursor,
  createHistoricalMarketCursor,
  type HistoricalMarketCursor,
} from '../market-data/streaming/historical'

export const simulationFixture = (regeneratedAtMs?: number) => {
  const fixture = historicalStreamingFixture()
  const { input, protocol } = fixture
  const source = {
    runId: input.arrivals.runId,
    sourceManifestHash: canonicalHashV1(input),
    deliveryModel: {
      ...input.arrivals.deliveryModel,
      schemaVersion: 'bayn.supplied-arrival-times.v1' as const,
      tieBreak: 'availability-topic-partition-offset' as const,
    },
    featureTopic: protocol.streamingInput.featureTopic,
    ...(regeneratedAtMs === undefined ? {} : { regeneratedFeaturesRecordedAtMs: regeneratedAtMs }),
  }
  let cursor: HistoricalMarketCursor = Result.getOrThrow(
    createHistoricalMarketCursor(
      source.runId,
      {
        universeId: protocol.universeId,
        universeSymbolHash: protocol.universeSymbolHash,
        symbols: protocol.universe,
        topics: { ...protocol.sourceTopics, features: source.featureTopic },
      },
      regeneratedAtMs,
    ),
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
      regeneratedAtMs !== undefined && arrival.record.topic === source.featureTopic
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
