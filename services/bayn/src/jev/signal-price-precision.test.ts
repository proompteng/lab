import { momentumControlCandidates } from '../intraday-replay/momentum-control'
import { expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { isCryptoMarketFeature } from '../market-data/features/crypto-contract'
import { cryptoMarketFixture } from '../testing/crypto-market-fixture'
import { checkProperty } from '../testing/property-test-support'
import { priceNumberToMicros } from '../strategy/execution-model/fixed-point'
import { deriveIntradayMomentumSignalMetrics } from '../strategy/intraday-momentum/decision-core'
import { commonMomentumPrices, jevBenchmarkSignalFor, jevSignalFor } from './trading-signals'

const observedPrices = (symbol: 'BTC/USD' | 'ETH/USD' | 'SOL/USD', price = 100.123456789012) => {
  const { snapshot } = cryptoMarketFixture(symbol)
  return {
    ...snapshot,
    bars: snapshot.bars.map((bar) => ({ ...bar, open: price, high: price, low: price, close: price })),
    trades: snapshot.trades.map((trade) => ({ ...trade, price: 103.123456789012 })),
    manifest: {
      ...snapshot.manifest,
      streaming: {
        ...snapshot.manifest.streaming,
        features: snapshot.manifest.streaming.features.map((entry) => {
          if (!isCryptoMarketFeature(entry.value)) throw new Error('Expected native crypto feature')
          return {
            ...entry,
            value: {
              ...entry.value,
              material: {
                ...entry.value.material,
                priceWindow: {
                  ...entry.value.material.priceWindow,
                  referencePrice: String(price),
                  rangeHighPrice: String(price),
                  rangeLowPrice: String(price),
                  lastClosePrice: String(price),
                },
              },
            },
          }
        }),
      },
    },
  }
}

test('crypto relative returns cannot treat an unmatched intraminute quote move as outperformance', () => {
  const snapshot = observedPrices('BTC/USD', 100)
  const candidate = Result.getOrThrow(jevSignalFor(snapshot, 'BTC/USD'))
  const benchmark = Result.getOrThrow(jevBenchmarkSignalFor(snapshot, 'ETH/USD'))
  const common = Result.getOrThrow(commonMomentumPrices(snapshot, 'BTC/USD', 'ETH/USD', candidate, benchmark))
  const { metrics } = Result.getOrThrow(
    deriveIntradayMomentumSignalMetrics(common.candidate, 'BTC/USD', common.benchmark),
  )
  expect(metrics.lookbackReturnBps).toBe(0)
  expect(metrics.benchmarkReturnBps).toBe(0)
  expect(metrics.excessReturnBps).toBe(0)
  expect(candidate.prices.bid).toBe(103123456n)
  expect(candidate.prices.ask).toBe(103123457n)
  expect(Result.getOrThrow(momentumControlCandidates(snapshot))).toEqual([])
})

test.each(['BTC/USD', 'ETH/USD', 'SOL/USD'] as const)(
  '%s rounds observed bar and trade signals without imposing executable price precision',
  (symbol) => {
    const snapshot = observedPrices(symbol)
    const candidate = Result.getOrThrow(jevSignalFor(snapshot, symbol))
    const benchmarkSymbol = symbol === 'BTC/USD' ? 'ETH/USD' : 'BTC/USD'
    const benchmark = Result.getOrThrow(jevBenchmarkSignalFor(snapshot, benchmarkSymbol))
    expect(candidate.prices).toMatchObject({
      reference: 100123457n,
      high: 100123457n,
      low: 100123457n,
      trade: 103123457n,
      bid: 103123456n,
      ask: 103123457n,
    })
    expect(benchmark.prices).toEqual({ reference: 100123457n, bid: 100123457n, ask: 100123457n })
    expect(candidate.state.bars1m[0]?.open).toBe(100.123456789012)
    expect(candidate.state.latestTrade.price).toBe(103.123456789012)
    expect(Result.getOrThrow(momentumControlCandidates(snapshot))).toEqual([])
  },
)

test.each([NaN, Infinity, -1, Number.MAX_VALUE])('invalid observed signal price %s still fails', (price) => {
  expect(Result.isFailure(jevSignalFor(observedPrices('BTC/USD', price), 'BTC/USD'))).toBe(true)
})

test('observed signal rounding does not accept an executable quote with excess precision', () => {
  const snapshot = observedPrices('BTC/USD')
  const quote = snapshot.latestQuotes['BTC/USD']
  if (quote === undefined) throw new Error('Expected verified candidate quote')
  expect(
    Result.isFailure(
      jevSignalFor(
        {
          ...snapshot,
          latestQuotes: { ...snapshot.latestQuotes, 'BTC/USD': { ...quote, bidPrice: 103.123456789012 } },
        },
        'BTC/USD',
      ),
    ),
  ).toBe(true)
})

test.each([16586.2835785, 34264.1846865, 68372.0828945])(
  'observed half-micro price %s keeps decimal rounding',
  (price) => {
    const benchmark = Result.getOrThrow(jevBenchmarkSignalFor(observedPrices('BTC/USD', price), 'ETH/USD'))
    expect(benchmark.prices.bid).toBe(Result.getOrThrow(priceNumberToMicros(price)))
  },
)

test('property: accepted nano prices retain their existing half-up signal rounding', () => {
  checkProperty(
    'jev-observed-price-rounding-equivalence',
    fc.property(fc.bigInt({ min: 70_000_000_000n, max: 100_000_000_000_000n }), (atoms) => {
      const price = Number(atoms) / 1_000_000_000
      const benchmark = Result.getOrThrow(jevBenchmarkSignalFor(observedPrices('BTC/USD', price), 'ETH/USD'))
      expect(benchmark.prices.bid).toBe(Result.getOrThrow(priceNumberToMicros(price)))
    }),
  )
}, 150_000)

test('property: sub-micro observed precision preserves normalized benchmark prices and original evidence', () => {
  checkProperty(
    'jev-observed-signal-price-precision',
    fc.property(fc.integer({ min: 1000, max: 100_000_000 }), fc.integer({ min: 1, max: 400_000 }), (ticks, extra) => {
      const base = ticks / 1000
      const precise = base + extra / 1_000_000_000_000
      const baseline = Result.getOrThrow(jevBenchmarkSignalFor(observedPrices('BTC/USD', base), 'ETH/USD'))
      const observed = Result.getOrThrow(jevBenchmarkSignalFor(observedPrices('BTC/USD', precise), 'ETH/USD'))
      expect(observed.prices).toEqual(baseline.prices)
      expect(observed.state.priceWindow.referencePrice).toBe(precise)
      expect(observed.state.bars1m[0]?.open).toBe(precise)
    }),
  )
}, 150_000)
