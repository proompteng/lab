import { expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'
import { streamingFixture } from '../../testing/streaming-market-fixture'
import { intradayMomentumFeatureTopic } from '../../strategy/intraday-momentum/protocol'
import {
  advanceHistoricalMarketCursor,
  arrivalPosition,
  compareArrivalPositions,
  createHistoricalMarketCursor,
  replayHistoricalMarketArrivals,
  type HistoricalMarketCursor,
} from './historical'
import { constructStreamingSnapshot } from './snapshot'
import { selectStreamingInputs } from './inputs'

const fixture = () => {
  const { cut, query, snapshot, protocol } = streamingFixture()
  const quote = snapshot.quotes[0]
  if (quote === undefined) throw new Error('missing fixture quote')
  const observedAtMs = Date.parse(snapshot.manifest.observedAt)
  const universe = {
    universeId: protocol.universeId,
    universeSymbolHash: protocol.universeSymbolHash,
    symbols: protocol.universe,
    topics: { ...protocol.sourceTopics, features: intradayMomentumFeatureTopic },
  }

  const value = JSON.stringify({
    version: 2,
    provider: quote.provider,
    feed: quote.feed,
    delayClass: quote.delayClass,
    marketSession: quote.marketSession,
    symbol: quote.symbol,
    channel: 'quotes',
    eventTs: quote.eventAt,
    ingestTs: quote.ingestedAt,
    payload: { t: quote.eventAt, bp: quote.bidPrice, ap: quote.askPrice, bs: quote.bidSize, as: quote.askSize },
  })
  const event = (offset: number) => ({
    availableAtMs: observedAtMs + offset,
    record: { topic: quote.sourceTopic, partition: quote.sourcePartition, offset: String(offset), value },
  })
  return { cut, query, universe, observedAtMs, event, symbol: quote.symbol }
}

test('original receipt version preserves same-millisecond consumer order across topics without invented time', () => {
  const { universe, observedAtMs, event } = fixture()
  const ordered = (topic: string, sequence: number) => ({
    ...event(0),
    availableAtMs: observedAtMs,
    schemaVersion: 'bayn.original-market-arrival.v1' as const,
    record: { ...event(0).record, topic },
    receipt: { captureId: 'capture-1', consumerEpoch: 'epoch-1', sequence },
  })
  const first = ordered('z-first-topic', 1)
  const second = ordered('a-second-topic', 2)
  expect(compareArrivalPositions(arrivalPosition(first), arrivalPosition(second))).toBe(-1)
  let cursor: HistoricalMarketCursor = Result.getOrThrow(createHistoricalMarketCursor('d'.repeat(64), universe))
  cursor = Result.getOrThrow(advanceHistoricalMarketCursor(cursor, first))
  cursor = Result.getOrThrow(advanceHistoricalMarketCursor(cursor, second))
  expect(cursor.processedRecords).toBe(2)
  expect(cursor.lastArrival?.availableAtMs).toBe(observedAtMs)
  expect(cursor.lastArrival?.receipt?.sequence).toBe(2)
  expect(Result.isFailure(advanceHistoricalMarketCursor(cursor, first))).toBe(true)
  expect(
    Result.isFailure(
      advanceHistoricalMarketCursor(cursor, {
        ...ordered('next', 3),
        receipt: { ...first.receipt, consumerEpoch: 'epoch-2', sequence: 3 },
      }),
    ),
  ).toBe(true)
  expect(Result.isFailure(advanceHistoricalMarketCursor(cursor, event(1)))).toBe(true)
})

test('property: original same-millisecond order never falls back to lexical topic order', () => {
  const { universe, observedAtMs, event } = fixture()
  fc.assert(
    fc.property(fc.array(fc.integer({ min: 0, max: 25 }), { minLength: 2, maxLength: 30 }), (topics) => {
      let cursor: HistoricalMarketCursor = Result.getOrThrow(createHistoricalMarketCursor('e'.repeat(64), universe))
      for (const [index, topic] of topics.entries()) {
        cursor = Result.getOrThrow(
          advanceHistoricalMarketCursor(cursor, {
            schemaVersion: 'bayn.original-market-arrival.v1',
            availableAtMs: observedAtMs,
            receipt: { captureId: 'capture-1', consumerEpoch: 'epoch-1', sequence: index + 1 },
            record: { ...event(index).record, topic: `topic-${topic}` },
          }),
        )
      }
      expect(cursor.processedRecords).toBe(topics.length)
      expect(cursor.lastArrival?.availableAtMs).toBe(observedAtMs)
    }),
    { numRuns: 1000 },
  )
})

test('incremental arrivals reproduce the existing replay projection across processing boundaries', () => {
  const { universe, observedAtMs, event } = fixture()
  const runId = 'a'.repeat(64)
  let cursor: HistoricalMarketCursor = Result.getOrThrow(createHistoricalMarketCursor(runId, universe))
  cursor = Result.getOrThrow(advanceHistoricalMarketCursor(cursor, event(0)))
  const first = cursor
  cursor = Result.getOrThrow(advanceHistoricalMarketCursor(cursor, event(1)))
  const existing = Result.getOrThrow(
    replayHistoricalMarketArrivals(
      {
        schemaVersion: 'bayn.historical-market-arrivals.v1',
        runId,
        observedAtMs: observedAtMs + 1,
        deliveryModel: {
          schemaVersion: 'bayn.supplied-arrival-times.v1',
          description: 'Recorded test arrivals',
          tieBreak: 'availability-topic-partition-offset',
        },
        events: [event(0), event(1)],
      },
      universe,
    ),
  )
  expect(cursor.projection).toEqual(existing.projection)
  expect(first.processedRecords).toBe(1)
  expect(first.projection.sequence).toBe(1)
  expect(cursor.processedRecords).toBe(2)
  expect(Result.isFailure(advanceHistoricalMarketCursor(cursor, event(0)))).toBe(true)
})

test('shared input selection preserves live identity and never turns a simulated cut into live authority', () => {
  const { cut, query } = fixture()
  const original = Result.getOrThrow(constructStreamingSnapshot(cut, query))
  const simulated = { ...cut.projection, availabilityMode: 'simulated' as const }
  expect(Result.getOrThrow(selectStreamingInputs(simulated, query))).toEqual(
    Result.getOrThrow(selectStreamingInputs(cut.projection, query)),
  )
  expect(Result.isFailure(constructStreamingSnapshot({ ...cut, projection: simulated }, query))).toBe(true)
  expect(Result.getOrThrow(constructStreamingSnapshot(cut, query)).manifest.snapshotId).toBe(
    original.manifest.snapshotId,
  )
})

test('rejected transport records still enforce supplied partition offset order', () => {
  const { universe, event } = fixture()
  const first = event(9)
  const cursor = Result.getOrThrow(
    advanceHistoricalMarketCursor(Result.getOrThrow(createHistoricalMarketCursor('c'.repeat(64), universe)), {
      ...first,
      record: { ...first.record, partition: 2_147_483_648 },
    }),
  )
  expect(cursor.projection.offsets.size).toBe(0)
  expect(
    Result.isFailure(
      advanceHistoricalMarketCursor(cursor, {
        ...first,
        availableAtMs: first.availableAtMs + 1,
        record: { ...first.record, partition: 2_147_483_648, offset: '8' },
      }),
    ),
  ).toBe(true)
})

test('incremental replay exceeds the whole-file limit while retaining bounded quote state', () => {
  const { universe, event, symbol } = fixture()
  let cursor: HistoricalMarketCursor = Result.getOrThrow(createHistoricalMarketCursor('b'.repeat(64), universe))
  for (let offset = 0; offset < 500_001; offset++)
    cursor = Result.getOrThrow(advanceHistoricalMarketCursor(cursor, event(offset)))
  expect(cursor.processedRecords).toBe(500_001)
  expect(cursor.projection.sequence).toBe(500_001)
  expect(cursor.projection.quoteHistory.get(symbol)).toHaveLength(512)
  expect(cursor.projection.rejections.size).toBe(0)
  expect(cursor.projection.availabilityMode).toBe('simulated')
}, 60_000)
