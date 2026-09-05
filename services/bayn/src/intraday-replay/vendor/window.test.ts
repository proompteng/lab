import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { makeExecutionCalendarObservation } from '../../cycle/construction'
import { decodeDefaultIntradayMomentumProtocol } from '../../strategy/intraday-momentum/protocol'
import {
  validateVendorDecisionWindow,
  validateVendorQuoteWindow,
  type VendorBar,
  type VendorCalendarSession,
  type VendorDecisionWindowInput,
  type VendorQuote,
  type VendorTrade,
} from './window'

const value = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result)
const failure = <A, E>(result: Result.Result<A, E>): E => Result.getOrThrow(Result.flip(result))
const protocol = value(decodeDefaultIntradayMomentumProtocol())

const sessionMaterial = {
  date: '2026-08-18',
  openAt: '2026-08-18T13:30:00.000Z',
  closeAt: '2026-08-18T20:00:00.000Z',
}
const session: VendorCalendarSession = {
  ...sessionMaterial,
  calendarHash: value(
    makeExecutionCalendarObservation({
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
      source: 'alpaca-v2-calendar',
      ...sessionMaterial,
    }),
  ).executionCalendarHash,
}

const rangeStartAt = '2026-08-18T14:30:00.000Z'
const rangeEndAt = '2026-08-18T15:00:00.000Z'
const observedAt = '2026-08-18T15:00:02.500000000Z'
const symbols = [...protocol.candidateSymbols, protocol.benchmarkSymbol].sort()
const captureHashes = {
  bars: 'a'.repeat(64),
  quotes: 'b'.repeat(64),
  trades: 'c'.repeat(64),
} as const

const bars: readonly VendorBar[] = symbols.flatMap((symbol, symbolIndex) =>
  Array.from({ length: protocol.lookbackMinutes }, (_, minute) => ({
    symbol,
    eventAt: new Date(Date.parse(rangeStartAt) + minute * 60_000).toISOString(),
    open: 100 + symbolIndex,
    high: 101 + symbolIndex,
    low: 99 + symbolIndex,
  })),
)

const quotes: readonly VendorQuote[] = symbols.map((symbol, symbolIndex) => ({
  symbol,
  eventAt: '2026-08-18T15:00:01.500000000Z',
  bidPrice: 100 + symbolIndex,
  bidSize: 10,
  askPrice: 100.1 + symbolIndex,
  askSize: 12,
}))

const trades: readonly VendorTrade[] = symbols.map((symbol, symbolIndex) => ({
  symbol,
  eventAt: '2026-08-18T15:00:01.750000000Z',
  price: 100.05 + symbolIndex,
}))

const input = (overrides: Partial<VendorDecisionWindowInput> = {}): VendorDecisionWindowInput => ({
  protocol,
  session,
  rangeStartAt,
  rangeEndAt,
  observedAt,
  bars,
  quotes,
  trades,
  captureHashes,
  ...overrides,
})

describe('vendor intraday decision window', () => {
  test('returns event-only core input and a stable provenance hash', () => {
    const first = value(validateVendorDecisionWindow(input()))
    const reordered = value(
      validateVendorDecisionWindow(
        input({ bars: [...bars].reverse(), quotes: [...quotes].reverse(), trades: [...trades].reverse() }),
      ),
    )

    expect(reordered.provenanceHash).toBe(first.provenanceHash)
    expect(first.coreInput.bars).toHaveLength(protocol.lookbackMinutes * symbols.length)
    expect(first.coreInput.latestQuotes).toEqual(expect.objectContaining({ SPY: expect.any(Object) }))
    expect(first.coreInput.latestTrades).toEqual(expect.objectContaining({ SPY: expect.any(Object) }))
    expect(JSON.stringify(first.coreInput)).not.toContain('snapshotId')
    expect(JSON.stringify(first.coreInput)).not.toContain('ingest')
    expect(first.provenanceHash).toMatch(/^[a-f0-9]{64}$/)
  })

  test('requires the exact rolling window derived from observed time and decision delay', () => {
    const cause = failure(
      validateVendorDecisionWindow(
        input({
          rangeEndAt: '2026-08-18T15:00:00.001Z',
          rangeStartAt: '2026-08-18T14:30:00.001Z',
        }),
      ),
    )
    expect(cause).toMatchObject({ reason: 'window', field: 'rangeEndAt' })
  })

  test('fails closed when a required rolling-grid bar is missing', () => {
    const missingBaseline = bars.filter((bar) => !(bar.symbol === 'AAPL' && bar.eventAt === rangeStartAt))
    expect(failure(validateVendorDecisionWindow(input({ bars: missingBaseline })))).toMatchObject({
      reason: 'coverage',
      symbol: 'AAPL',
    })

    const interiorAt = '2026-08-18T14:45:00.000Z'
    const missingInterior = bars.filter((bar) => !(bar.symbol === 'AMZN' && bar.eventAt === interiorAt))
    expect(failure(validateVendorDecisionWindow(input({ bars: missingInterior })))).toMatchObject({
      reason: 'coverage',
      symbol: 'AMZN',
    })
  })

  test('rejects duplicate and misaligned bars instead of silently selecting one', () => {
    const duplicate = [...bars, bars[0]!]
    expect(failure(validateVendorDecisionWindow(input({ bars: duplicate })))).toMatchObject({
      reason: 'ambiguity',
      symbol: bars[0]!.symbol,
    })
    const misaligned = bars.map((bar) =>
      bar.symbol === 'IWM' && bar.eventAt === rangeStartAt ? { ...bar, eventAt: '2026-08-18T14:30:00.001Z' } : bar,
    )
    expect(failure(validateVendorDecisionWindow(input({ bars: misaligned })))).toMatchObject({
      reason: 'coverage',
      symbol: 'IWM',
    })
  })

  test('rejects future and ambiguous latest quote or trade evidence', () => {
    const futureQuote = [...quotes, { ...quotes[0]!, eventAt: '2026-08-18T15:00:02.500000001Z' }]
    expect(failure(validateVendorDecisionWindow(input({ quotes: futureQuote })))).toMatchObject({
      reason: 'window',
      symbol: 'AAPL',
    })
    const ambiguousTrade = [...trades, { ...trades[0]!, price: trades[0]!.price + 0.01 }]
    expect(failure(validateVendorDecisionWindow(input({ trades: ambiguousTrade })))).toMatchObject({
      reason: 'ambiguity',
      symbol: 'AAPL',
    })
  })

  test('requires fresh quote and trade evidence for all seven symbols', () => {
    const missingBenchmark = quotes.filter(({ symbol }) => symbol !== protocol.benchmarkSymbol)
    expect(failure(validateVendorDecisionWindow(input({ quotes: missingBenchmark })))).toMatchObject({
      reason: 'coverage',
      symbol: protocol.benchmarkSymbol,
    })
    const missingTrade = trades.filter(({ symbol }) => symbol !== protocol.benchmarkSymbol)
    expect(failure(validateVendorDecisionWindow(input({ trades: missingTrade })))).toMatchObject({
      reason: 'coverage',
      symbol: protocol.benchmarkSymbol,
    })
    const stale = quotes.map((quote) =>
      quote.symbol === 'SMH' ? { ...quote, eventAt: '2026-08-18T15:00:00.000000000Z' } : quote,
    )
    expect(failure(validateVendorDecisionWindow(input({ quotes: stale })))).toMatchObject({
      reason: 'freshness',
      symbol: 'SMH',
    })
  })

  test('accepts the exact freshness boundary and rejects one nanosecond beyond it', () => {
    const atBoundary = quotes.map((quote) =>
      quote.symbol === 'SMH' ? { ...quote, eventAt: '2026-08-18T15:00:00.500000000Z' } : quote,
    )
    expect(Result.isSuccess(validateVendorDecisionWindow(input({ quotes: atBoundary })))).toBe(true)

    const beyondBoundary = atBoundary.map((quote) =>
      quote.symbol === 'SMH' ? { ...quote, eventAt: '2026-08-18T15:00:00.499999999Z' } : quote,
    )
    expect(failure(validateVendorDecisionWindow(input({ quotes: beyondBoundary })))).toMatchObject({
      reason: 'freshness',
      symbol: 'SMH',
    })
  })

  test('validates quote-only windows for planning, arrival, and marks', () => {
    const latest = value(
      validateVendorQuoteWindow({
        protocol,
        session,
        symbols: ['AAPL', 'SPY'],
        rangeEndAt,
        observedAt,
        quotes: quotes.filter(({ symbol }) => symbol === 'AAPL' || symbol === 'SPY'),
        captureHashes,
      }),
    )
    expect(Object.keys(latest)).toEqual(['AAPL', 'SPY'])
    expect(latest['AAPL']?.eventAt).toBe('2026-08-18T15:00:01.500000000Z')
  })

  test('requires the quote observation to follow the completed minute', () => {
    const atRangeEnd = quotes
      .filter(({ symbol }) => symbol === 'AAPL' || symbol === 'SPY')
      .map((quote) => ({ ...quote, eventAt: rangeEndAt }))
    const cause = failure(
      validateVendorQuoteWindow({
        protocol,
        session,
        symbols: ['AAPL', 'SPY'],
        rangeEndAt,
        observedAt: rangeEndAt,
        quotes: atRangeEnd,
        captureHashes: { quotes: captureHashes.quotes },
      }),
    )
    expect(cause).toMatchObject({ reason: 'window', field: 'rangeEndAt' })
  })

  test('allows superseded equal-time quotes and selects the latest event deterministically', () => {
    const supersededTie: readonly VendorQuote[] = [
      {
        symbol: 'IWM',
        eventAt: '2026-08-18T15:00:00.045239185Z',
        bidPrice: 289.8,
        bidSize: 560,
        askPrice: 289.83,
        askSize: 200,
      },
      {
        symbol: 'IWM',
        eventAt: '2026-08-18T15:00:00.045239185Z',
        bidPrice: 289.8,
        bidSize: 680,
        askPrice: 289.83,
        askSize: 240,
      },
      {
        symbol: 'IWM',
        eventAt: '2026-08-18T15:00:01.997505311Z',
        bidPrice: 289.83,
        bidSize: 600,
        askPrice: 289.85,
        askSize: 240,
      },
    ]
    const first = value(
      validateVendorQuoteWindow({
        protocol,
        session,
        symbols: ['IWM'],
        rangeEndAt,
        observedAt,
        quotes: supersededTie,
        captureHashes: { quotes: captureHashes.quotes },
      }),
    )
    const reordered = value(
      validateVendorQuoteWindow({
        protocol,
        session,
        symbols: ['IWM'],
        rangeEndAt,
        observedAt,
        quotes: [...supersededTie].reverse(),
        captureHashes: { quotes: captureHashes.quotes },
      }),
    )
    expect(first).toEqual(reordered)
    expect(first['IWM']).toMatchObject({
      eventAt: '2026-08-18T15:00:01.997505311Z',
      bidPrice: 289.83,
      bidSize: 600,
      askPrice: 289.85,
      askSize: 240,
    })
  })

  test('rejects conflicting quotes tied at the selected latest event', () => {
    const latestTie: readonly VendorQuote[] = [
      {
        symbol: 'IWM',
        eventAt: '2026-08-18T15:00:01.997505311Z',
        bidPrice: 289.83,
        bidSize: 600,
        askPrice: 289.85,
        askSize: 240,
      },
      {
        symbol: 'IWM',
        eventAt: '2026-08-18T15:00:01.997505311Z',
        bidPrice: 289.84,
        bidSize: 600,
        askPrice: 289.86,
        askSize: 240,
      },
    ]
    const cause = failure(
      validateVendorQuoteWindow({
        protocol,
        session,
        symbols: ['IWM'],
        rangeEndAt,
        observedAt,
        quotes: latestTie,
        captureHashes: { quotes: captureHashes.quotes },
      }),
    )
    expect(cause).toMatchObject({ reason: 'ambiguity', symbol: 'IWM', field: 'quotes' })
  })

  test('preserves superseded and equivalent latest trade ties without choosing a conflicting latest price', () => {
    const supersededAndEquivalentTie: readonly VendorTrade[] = [
      ...trades.filter(({ symbol }) => symbol !== 'SPY'),
      {
        symbol: 'SPY',
        eventAt: '2026-08-18T15:00:00.045239185Z',
        price: 757.87,
      },
      {
        symbol: 'SPY',
        eventAt: '2026-08-18T15:00:00.045239185Z',
        price: 757.87,
      },
      {
        symbol: 'SPY',
        eventAt: '2026-08-18T15:00:01.997505311Z',
        price: 757.83,
      },
      {
        symbol: 'SPY',
        eventAt: '2026-08-18T15:00:01.997505311Z',
        price: 757.83,
      },
    ]
    const first = value(validateVendorDecisionWindow(input({ trades: supersededAndEquivalentTie })))
    const reordered = value(validateVendorDecisionWindow(input({ trades: [...supersededAndEquivalentTie].reverse() })))
    expect(reordered.provenanceHash).toBe(first.provenanceHash)
    expect(reordered.coreInput.latestTrades['SPY']).toEqual(first.coreInput.latestTrades['SPY'])
    expect(first.coreInput.latestTrades['SPY']).toMatchObject({
      eventAt: '2026-08-18T15:00:01.997505311Z',
      price: 757.83,
    })
  })

  test('rejects conflicting prices tied at the selected latest trade event', () => {
    const latestPriceTie: readonly VendorTrade[] = [
      ...trades.filter(({ symbol }) => symbol !== 'SPY'),
      {
        symbol: 'SPY',
        eventAt: '2026-08-18T15:00:01.997505311Z',
        price: 757.83,
      },
      {
        symbol: 'SPY',
        eventAt: '2026-08-18T15:00:01.997505311Z',
        price: 757.84,
      },
    ]
    const cause = failure(validateVendorDecisionWindow(input({ trades: latestPriceTie })))
    expect(cause).toMatchObject({ reason: 'ambiguity', symbol: 'SPY', field: 'trades' })
  })

  test('binds calendar identity and every underlying capture hash', () => {
    const badCalendar = failure(
      validateVendorDecisionWindow(input({ session: { ...session, calendarHash: 'c'.repeat(64) } })),
    )
    expect(badCalendar).toMatchObject({ reason: 'calendar', field: 'session.calendarHash' })
    const badCapture = failure(
      validateVendorDecisionWindow(input({ captureHashes: { ...captureHashes, bars: 'bad' } })),
    )
    expect(badCapture).toMatchObject({ reason: 'provenance', field: 'captureHashes.bars' })
    const badSource = failure(
      validateVendorDecisionWindow(input({ captureHashes: { ...captureHashes, quotes: 'bad' } })),
    )
    expect(badSource).toMatchObject({ reason: 'provenance', field: 'captureHashes.quotes' })
  })
})
