import { expect, test } from 'bun:test'
import { Result } from 'effect'
import { streamingFixture } from '../../testing/streaming-market-fixture'
import { intradayMomentumFeatureTopic } from '../../strategy/intraday-momentum/protocol'
import {
  advanceHistoricalMarketCursor,
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
