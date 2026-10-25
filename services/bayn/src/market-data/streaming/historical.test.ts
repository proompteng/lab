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
import { cryptoMarketProfile } from '../../jev/markets'
import { nativeArrival, nativeArrivalCaptureId } from './native-arrival'
import { nativeArrivalEpochFixture } from './native-arrival.test-support'
import { kafkaCaptureDisposition, emptyStreamingProjection, incorporateMarketRecord } from './projection'
import { sha256 } from '../../hash'
import { CaptureDisposition } from './transport-evidence'

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

const interleavedOriginalFixture = (order: readonly number[] = [0, 1, 1], equity = fixture()) => {
  const crypto = {
    universeId: cryptoMarketProfile.universeId,
    universeSymbolHash: cryptoMarketProfile.universeSymbolHash,
    symbols: cryptoMarketProfile.universe,
    topics: { ...cryptoMarketProfile.sourceTopics, features: cryptoMarketProfile.streamingInput.featureTopic },
  }
  const marketSources = [equity.universe, crypto] as const
  const material = { ...nativeArrivalEpochFixture, sources: marketSources }
  const epoch = {
    ...material,
    captureId: Result.getOrThrow(nativeArrivalCaptureId(material.build, material.bootstrap, marketSources)),
  }
  const at = equity.observedAtMs
  const cryptoQuote = {
    topic: crypto.topics.quotes,
    partition: 0,
    offset: '0',
    value: JSON.stringify({
      version: 2,
      provider: 'alpaca',
      feed: 'us',
      delayClass: 'real_time_crypto',
      marketSession: 'continuous',
      symbol: 'BTC/USD',
      channel: 'quotes',
      seq: 1,
      eventTs: new Date(at).toISOString(),
      ingestTs: new Date(at).toISOString(),
      payload: { T: 'q', S: 'BTC/USD', t: new Date(at).toISOString(), bp: 65000, ap: 65001, bs: 1, as: 1 },
    }),
  }
  let projection = emptyStreamingProjection(epoch.bootstrap.epoch)
  const deliveries = order.map((market, index) => {
    const record = market === 0 ? equity.event(0).record : cryptoQuote
    const before = projection
    projection = incorporateMarketRecord(projection, record, market === 0 ? equity.universe : crypto, at)
    const rawValue = Buffer.from(record.value)
    return nativeArrival(epoch, {
      record: {
        ...record,
        timestampMs: at,
        leaderEpoch: 1,
        rawValue,
        rawValueSha256: sha256(rawValue),
        rawByteLength: rawValue.byteLength,
      },
      availableAtMs: at,
      consumerSequence: index + 1,
      projectionSequence: projection.sequence,
      disposition: kafkaCaptureDisposition(before, projection),
      assignmentInvalidated: false,
    })
  })
  const source = {
    runId: '9'.repeat(64),
    sourceManifestHash: '8'.repeat(64),
    marketSources,
    deliveryModel: {
      schemaVersion: 'bayn.original-capture-arrivals.v1' as const,
      description: 'Synthetic interleaved consumer regression',
      tieBreak: 'availability-receipt-sequence' as const,
      captureId: epoch.captureId,
      consumerEpoch: epoch.bootstrap.epoch,
      exportManifestHash: '7'.repeat(64),
      intervalReceiptHash: '6'.repeat(64),
      finalConsumerSequence: deliveries.length,
    },
  }
  const empty = Result.getOrThrow(createHistoricalMarketCursor(source.runId, marketSources, undefined, source))
  return { empty, deliveries, at, equity }
}

test('one original cursor reproduces interleaved equity and crypto deliveries without filtering the other market', () => {
  const { empty, deliveries, equity } = interleavedOriginalFixture()
  let cursor: HistoricalMarketCursor = empty
  for (const delivery of deliveries) cursor = Result.getOrThrow(advanceHistoricalMarketCursor(cursor, delivery))
  expect(cursor.processedRecords).toBe(3)
  expect(cursor.projection.sequence).toBe(2)
  expect(cursor.projection.quotes.has(equity.symbol)).toBe(true)
  expect(cursor.projection.quotes.has('BTC/USD')).toBe(true)
  expect(cursor.projection.rejections.size).toBe(0)
  expect(Result.isFailure(advanceHistoricalMarketCursor(empty, deliveries[1]))).toBe(true)
  expect(
    Result.isFailure(
      advanceHistoricalMarketCursor(empty, {
        ...deliveries[0],
        receipt: { ...deliveries[0]?.receipt, projectionSequence: 2 },
      }),
    ),
  ).toBe(true)
})

test('receipt-only v1 and mixed original/supplied deliveries cannot claim current original availability', () => {
  const { empty, deliveries, equity } = interleavedOriginalFixture()
  expect(
    Result.isFailure(
      advanceHistoricalMarketCursor(empty, {
        ...equity.event(0),
        schemaVersion: 'bayn.original-market-arrival.v1',
        receipt: { captureId: 'retired', consumerEpoch: 'retired', sequence: 1 },
      }),
    ),
  ).toBe(true)
  const first = deliveries[0]
  if (first === undefined) throw new Error('Missing synthetic original delivery')
  const cursor = Result.getOrThrow(advanceHistoricalMarketCursor(empty, first))
  expect(Result.isFailure(advanceHistoricalMarketCursor(cursor, first))).toBe(true)
  expect(Result.isFailure(advanceHistoricalMarketCursor(cursor, equity.event(1)))).toBe(true)
  expect(
    Result.isFailure(
      advanceHistoricalMarketCursor(empty, { ...first, receipt: { ...first.receipt, consumerEpoch: 'another' } }),
    ),
  ).toBe(true)
})

test('property: original same-millisecond consumer order spans markets and never falls back to lexical topics', () => {
  const equity = fixture()
  fc.assert(
    fc.property(fc.array(fc.integer({ min: 0, max: 1 }), { minLength: 2, maxLength: 30 }), (order) => {
      const { empty, deliveries, at } = interleavedOriginalFixture(order, equity)
      let cursor: HistoricalMarketCursor = empty
      for (const [index, delivery] of deliveries.entries()) {
        const previous = deliveries[index - 1]
        if (previous !== undefined)
          expect(compareArrivalPositions(arrivalPosition(previous), arrivalPosition(delivery))).toBeLessThan(0)
        cursor = Result.getOrThrow(advanceHistoricalMarketCursor(cursor, delivery))
      }
      expect(cursor.processedRecords).toBe(deliveries.length)
      expect(cursor.projection.sequence).toBe(new Set(order).size)
      expect(cursor.lastArrival?.availableAtMs).toBe(at)
      expect(Result.isFailure(advanceHistoricalMarketCursor(empty, deliveries[1]))).toBe(true)
    }),
    { numRuns: 1000 },
  )
})

test('incremental arrivals reproduce the existing replay projection across processing boundaries', () => {
  const { universe, observedAtMs, event } = fixture()
  const runId = 'a'.repeat(64)
  let cursor: HistoricalMarketCursor = Result.getOrThrow(createHistoricalMarketCursor(runId, [universe]))
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
      [universe],
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
    advanceHistoricalMarketCursor(Result.getOrThrow(createHistoricalMarketCursor('c'.repeat(64), [universe])), {
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
  let cursor: HistoricalMarketCursor = Result.getOrThrow(createHistoricalMarketCursor('b'.repeat(64), [universe]))
  for (let offset = 0; offset < 500_001; offset++)
    cursor = Result.getOrThrow(advanceHistoricalMarketCursor(cursor, event(offset)))
  expect(cursor.processedRecords).toBe(500_001)
  expect(cursor.projection.sequence).toBe(500_001)
  expect(cursor.projection.quoteHistory.get(symbol)).toHaveLength(512)
  expect(cursor.projection.rejections.size).toBe(0)
  expect(cursor.projection.availabilityMode).toBe('simulated')
}, 60_000)

test('new capture receipts reproduce withdrawals while prior rejection receipts cannot be reclassified', () => {
  const equity = fixture()
  const event = (offset: number) => {
    const original = equity.event(offset)
    const envelope = JSON.parse(original.record.value)
    return {
      ...original,
      record: {
        ...original.record,
        value: JSON.stringify({ ...envelope, payload: { ...envelope.payload, ap: 0, as: 0 } }),
      },
    }
  }
  const { empty, deliveries } = interleavedOriginalFixture([0], { ...equity, event })
  const arrival = deliveries[0]
  if (arrival === undefined) throw new Error('Missing withdrawal delivery')
  expect(arrival.receipt.disposition).toBe(CaptureDisposition.Accepted)
  const replayed = Result.getOrThrow(advanceHistoricalMarketCursor(empty, arrival))
  expect(replayed.projection.quotes.get(equity.symbol)?.value.askPrice).toBe(0)
  expect(replayed.projection.rejections.size).toBe(0)
  const rejected = advanceHistoricalMarketCursor(empty, {
    ...arrival,
    receipt: { ...arrival.receipt, disposition: CaptureDisposition.Rejected },
  })
  expect(Result.isFailure(rejected)).toBe(true)
  if (Result.isFailure(rejected))
    expect(rejected.failure.message).toContain('does not reproduce its captured reducer disposition')
})
