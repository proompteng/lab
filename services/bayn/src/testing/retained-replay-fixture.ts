import { sha256 } from '../hash'
import { simulationFixture } from './simulated-streaming-fixture'
import { arrivalPosition, compareArrivalPositions } from '../market-data/streaming/historical'
import type { RetainedReplaySourceManifest } from '../intraday-replay/source'

export const retainedReplayFixture = () => {
  const input = simulationFixture()
  const events = input.input.arrivals.events.toSorted((a, b) =>
    compareArrivalPositions(arrivalPosition(a), arrivalPosition(b)),
  )
  const body = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  const positions = new Map<
    string,
    { topic: string; partition: number; startOffset: string; endOffsetExclusive: string }
  >()
  for (const { record } of events) {
    const key = `${record.topic}:${record.partition}`
    const previous = positions.get(key)
    positions.set(key, {
      topic: record.topic,
      partition: record.partition,
      startOffset: previous?.startOffset ?? record.offset,
      endOffsetExclusive: String(BigInt(record.offset) + 1n),
    })
  }
  const manifest: RetainedReplaySourceManifest = {
    schemaVersion: 'bayn.retained-replay-source.v1',
    dataSha256: sha256(body),
    recordCount: events.length,
    firstAvailableAtMs: events[0]?.availableAtMs ?? 0,
    lastAvailableAtMs: events.at(-1)?.availableAtMs ?? 0,
    coverageStartMs: events[0]?.availableAtMs ?? 0,
    coverageEndMs: events.at(-1)?.availableAtMs ?? 0,
    origin: 'deterministic unit fixture',
    positions: [...positions.values()].sort((a, b) =>
      a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : a.partition - b.partition,
    ),
    universe: input.cursor.universe,
    deliveryModel: input.source.deliveryModel,
  }
  return { body, manifest, events, input }
}
