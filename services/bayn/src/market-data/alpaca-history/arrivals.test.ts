import { expect, test } from 'bun:test'
import { Result } from 'effect'
import { canonicalHashV1 } from '../../hash'
import { advanceHistoricalMarketCursor, createHistoricalMarketCursor } from '../streaming/historical'
import { decodeRawMarketRecord, RawMarketEventKind } from '../streaming/raw-events'
import { restCaptureArrivals } from './arrivals'
import type { StoredHistoricalCapture, VendorHistoricalProvenance } from './model'

const universe = {
  universeId: 'rest-fixture',
  universeSymbolHash: canonicalHashV1(['AAPL', 'SPY']),
  symbols: ['AAPL', 'SPY'],
  topics: {
    bars: 'bars',
    quotes: 'quotes',
    trades: 'trades',
    features: 'features',
    technicalFeatures: 'technical-features',
  },
}
const provenance: VendorHistoricalProvenance = {
  schemaVersion: 'bayn.vendor-historical-provenance.v1',
  source: 'alpaca-historical',
  endpointPath: '/v2/stocks/quotes',
  feed: 'iex',
  asof: '2026-09-11',
  marketSession: 'regular',
  timeBasis: 'event-time-only',
  completeness: 'complete',
  sessionDate: '2026-09-11',
  requestedSymbols: universe.symbols,
  queryHash: '1'.repeat(64),
  normalizedHash: '2'.repeat(64),
  rowCountsBySymbol: { AAPL: 1, SPY: 1 },
  pageReceipts: [],
  cacheKey: 'fixture',
  retrievedAt: '2026-09-13T00:00:00.000Z',
}
const base = {
  datasetId: '3'.repeat(64),
  topics: universe.topics,
  sessionOpenAt: '2026-09-11T13:30:00.000Z',
  sessionCloseAt: '2026-09-11T20:00:00.000Z',
  rawDeliveryDelayMs: 0,
  barFinalizationDelayMs: 10,
}
const quote = {
  symbol: 'AAPL',
  eventAt: '2026-09-11T13:30:00.000000001Z',
  bidPrice: 100,
  bidSize: 5,
  askPrice: 100.1,
  askSize: 8,
  bidExchange: 'V',
  askExchange: 'V',
  conditions: ['R'],
  tape: 'C',
}

test('REST normalization rounds nanoseconds up and preserves modeled provenance through the live decoder', () => {
  const capture: StoredHistoricalCapture = {
    kind: 'quotes',
    rows: [{ ...quote, symbol: 'SPY' }, quote],
    provenance,
    provenanceHash: '4'.repeat(64),
  }
  const events = [...Result.getOrThrow(restCaptureArrivals({ ...base, capture })).arrivals]
  expect(events.map((event) => event.record.offset)).toEqual(['0', '1'])
  expect(events[0]?.availableAtMs).toBe(Date.parse('2026-09-11T13:30:00.001Z'))
  for (const event of events) {
    const decoded = Result.getOrThrow(decodeRawMarketRecord(event.record, universe))
    expect(decoded.kind).toBe(RawMarketEventKind.Quote)
    expect(JSON.parse(event.record.value).provenance).toMatchObject({
      transport: 'historical-rest',
      ingestionTime: 'MODELED',
      originalStreamAvailability: 'NOT_OBSERVED',
    })
  }
  expect(JSON.parse(events[0]?.record.value ?? '').symbol).toBe('AAPL')
})

test.each(['bid', 'ask', 'both'] as const)('preserves absent %s prices as rejected native records', (side) => {
  const retained = {
    ...quote,
    ...(side === 'ask' || side === 'both' ? { askPrice: 0, askSize: 0 } : {}),
    ...(side === 'bid' || side === 'both' ? { bidPrice: 0, bidSize: 0 } : {}),
  }
  const capture: StoredHistoricalCapture = {
    kind: 'quotes',
    rows: [retained],
    provenance,
    provenanceHash: '4'.repeat(64),
  }
  const arrivals = Result.getOrThrow(restCaptureArrivals({ ...base, capture }))
  expect(arrivals.count).toBe(1)
  const [event] = [...arrivals.arrivals]
  if (event === undefined) throw new Error('expected the retained one-sided quote')
  expect(JSON.parse(event.record.value).payload).toMatchObject({
    bp: retained.bidPrice,
    bs: retained.bidSize,
    ap: retained.askPrice,
    as: retained.askSize,
  })
  const decoded = decodeRawMarketRecord(event.record, universe)
  expect(Result.isFailure(decoded)).toBe(true)
  if (Result.isFailure(decoded)) expect(decoded.failure.message).toBe('invalid raw quote row')
  const cursor = Result.getOrThrow(
    advanceHistoricalMarketCursor(Result.getOrThrow(createHistoricalMarketCursor('5'.repeat(64), universe)), event),
  )
  expect(cursor.processedRecords).toBe(1)
  expect(cursor.projection.quoteHistory.size).toBe(0)
  expect(cursor.projection.rejections.get('quotes:0')).toMatchObject([
    { availableAtMs: event.availableAtMs, offset: '0' },
  ])
})

test('minute bars arrive only after completion and inclusive endpoint rows remain outside the regular session', () => {
  const bar = {
    symbol: 'AAPL',
    eventAt: '2026-09-11T19:59:00.000000000Z',
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 10,
    vwap: 100,
    tradeCount: 1,
  }
  const capture: StoredHistoricalCapture = {
    kind: 'bars',
    rows: [bar, { ...bar, eventAt: '2026-09-11T20:00:00.000000000Z' }],
    provenance: { ...provenance, endpointPath: '/v2/stocks/bars' },
    provenanceHash: '4'.repeat(64),
  }
  const events = [...Result.getOrThrow(restCaptureArrivals({ ...base, capture })).arrivals]
  expect(events).toHaveLength(1)
  expect(events[0]?.availableAtMs).toBe(Date.parse('2026-09-11T20:00:00.010Z'))
  const delayed = [...Result.getOrThrow(restCaptureArrivals({ ...base, capture, rawDeliveryDelayMs: 25 })).arrivals]
  expect(delayed[0]?.availableAtMs).toBe(Date.parse('2026-09-11T20:00:00.035Z'))
  expect(JSON.parse(delayed[0]?.record.value ?? '').ingestTs).toBe('2026-09-11T20:00:00.035Z')
  const event = events[0]
  if (event === undefined) throw new Error('expected a bar')
  expect(Result.getOrThrow(decodeRawMarketRecord(event.record, universe)).kind).toBe(RawMarketEventKind.Bar)
  expect(Result.isFailure(restCaptureArrivals({ ...base, capture, rawDeliveryDelayMs: -1 }))).toBe(true)
  expect(
    Result.isFailure(
      restCaptureArrivals({
        ...base,
        capture: { ...capture, rows: [{ ...bar, eventAt: '2026-09-11T19:59:01.000000000Z' }] },
      }),
    ),
  ).toBe(true)
})
