import { expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { canonicalHashV1 } from '../hash'
import { nativeJevFixture } from '../jev/native.test-support'
import type { StreamingMarketSnapshot } from '../market-data/streaming/snapshot'
import { checkProperty } from '../testing/property-test-support'
import {
  calculateResidualShock,
  residualShockDefinition,
  ResidualShockStatus,
  selectResidualShock,
} from './residual-shock'

const benchmark = Array<bigint>(30).fill(100_000_000n)
const stock = [...Array.from({ length: 29 }, (_, index) => 100_000_000n + BigInt(index % 2) * 10_000n), 99_000_000n]
const calculate = (prices = stock, market = benchmark) => Result.getOrThrow(calculateResidualShock(prices, market))
const number = (value: { numerator: string; denominator: string }) =>
  // Test-only diagnostic: divide before converting so large exact ratios cannot overflow Number.
  Number((BigInt(value.numerator) * 1_000_000_000_000n) / BigInt(value.denominator)) / 1_000_000_000_000

test('frozen falsification definition retains its preregistered hash', () => {
  expect(canonicalHashV1(residualShockDefinition)).toBe(
    '76afb9108e06eaacb0231bbfc6a1dc00861451f2677cc8b99aee263691af68d6',
  )
})

test('exact negative threshold is inclusive and excludes the signal from its sample baseline', () => {
  // These 28 returns have mean zero and sample variance one bp squared:
  // 2*3^2 + 2*2^2 + 4*(1/2)^2 = 27, divided by 27.
  const prefix = [300n, -300n, 200n, -200n, 50n, -50n, 50n, -50n, ...Array<bigint>(20).fill(0n)]
  const prices = (last: bigint) => {
    const output = [1_000_000n ** 29n]
    let current = output[0] ?? 1n
    for (const change of [...prefix, last]) {
      current = (current * (1_000_000n + change)) / 1_000_000n
      output.push(current)
    }
    return output
  }
  const boundary = calculate(prices(-309n))
  expect(boundary.baselineMeanBps).toEqual({ numerator: '0', denominator: '1' })
  expect(boundary.baselineSampleVarianceBpsSquared).toEqual({ numerator: '1', denominator: '1' })
  expect(boundary.squaredZ).toEqual({ numerator: '95481', denominator: '10000' })
  expect(boundary.status).toBe(ResidualShockStatus.Eligible)
  expect(calculate(prices(-308n)).status).toBe(ResidualShockStatus.NoShock)
  expect(calculate(prices(309n)).status).toBe(ResidualShockStatus.NoShock)
  expect(calculate(prices(-600n)).baselineSampleVarianceBpsSquared).toEqual(boundary.baselineSampleVarianceBpsSquared)
})

test('zero variation abstains while missing or nonpositive closes are unavailable', () => {
  expect(calculate(benchmark).status).toBe(ResidualShockStatus.ZeroVariance)
  expect(Result.isFailure(calculateResidualShock(stock.slice(1), benchmark))).toBeTrue()
  expect(Result.isFailure(calculateResidualShock([...stock.slice(0, 29), 0n], benchmark))).toBeTrue()
  const marketCrash = [...benchmark.slice(0, 29), 90_000_000n]
  expect(calculate(stock, marketCrash).status).toBe(ResidualShockStatus.NoShock)
})

const fixture = nativeJevFixture()
const snapshot = (): StreamingMarketSnapshot => ({
  ...fixture.snapshot,
  bars: fixture.snapshot.bars.map((bar) => {
    const index = (Date.parse(bar.eventAt) - Date.parse(fixture.snapshot.manifest.rangeStartAt)) / 60_000
    const prices = ['AAPL', 'AMZN'].includes(bar.symbol) ? stock : benchmark
    return { ...bar, close: Number(prices[index]) / 1_000_000 }
  }),
  latestQuotes: Object.fromEntries(
    Object.entries(fixture.snapshot.latestQuotes).map(([symbol, quote]) => [
      symbol,
      { ...quote, bidPrice: 99, askPrice: 99.02, bidSize: 1000, askSize: 1000 },
    ]),
  ),
})
const select = (value = snapshot()) => Result.getOrThrow(selectResidualShock(value, fixture.protocol))

test('selection ranks exact squared z and breaks ties by symbol without mutating evidence', () => {
  const source = snapshot()
  const saved = JSON.stringify(source)
  expect(select(source).selectedSymbol).toBe('AAPL')
  const stronger = {
    ...source,
    bars: source.bars.map((bar) =>
      bar.symbol === 'AMZN' && Date.parse(bar.eventAt) === Date.parse(source.manifest.rangeEndAt) - 60_000
        ? { ...bar, close: 98 }
        : bar,
    ),
  }
  expect(select(stronger).selectedSymbol).toBe('AMZN')
  expect(JSON.stringify(source)).toBe(saved)
})

test('source exclusions, quote freshness, positive sizes and exact spread boundary stay binding', () => {
  const source = snapshot()
  const quote = source.latestQuotes['AAPL']
  if (quote === undefined) throw new Error('AAPL fixture missing')
  const excluded = select({
    ...source,
    manifest: {
      ...source.manifest,
      candidateExclusions: [{ symbol: 'AAPL', reason: 'not-ready', message: 'No original bar witness' }],
    },
  })
  expect(excluded.selectedSymbol).toBe('AMZN')
  expect(excluded.candidates.find((entry) => entry.symbol === 'AAPL')?.status).toBe(ResidualShockStatus.SourceExcluded)
  for (const changed of [
    { ...quote, eventAt: new Date(Date.parse(source.manifest.observedAt) - 10_001).toISOString() },
    { ...quote, eventAt: new Date(Date.parse(source.manifest.observedAt) + 1).toISOString() },
    { ...quote, askSize: 0 },
    { ...quote, bidPrice: 99.975, askPrice: 100.025001 },
  ])
    expect(select({ ...source, latestQuotes: { ...source.latestQuotes, AAPL: changed } }).selectedSymbol).toBe('AMZN')
  expect(
    select({
      ...source,
      latestQuotes: { ...source.latestQuotes, AAPL: { ...quote, bidPrice: 99.975, askPrice: 100.025 } },
    }).selectedSymbol,
  ).toBe('AAPL')
})

test('malformed required evidence, missing bars and future windows remain unavailable', () => {
  const source = snapshot()
  const quote = source.latestQuotes['SPY']
  if (quote === undefined) throw new Error('SPY fixture missing')
  for (const changed of [
    { ...source, bars: source.bars.filter((bar) => bar.symbol !== 'SPY') },
    {
      ...source,
      bars: source.bars.filter((bar) => !(bar.symbol === 'AAPL' && bar.eventAt === source.manifest.rangeStartAt)),
    },
    { ...source, bars: [...source.bars, ...source.bars.slice(0, 1)] },
    { ...source, latestQuotes: { ...source.latestQuotes, SPY: { ...quote, bidPrice: Number.NaN } } },
    { ...source, manifest: { ...source.manifest, observedAt: source.manifest.rangeEndAt } },
  ])
    expect(Result.isFailure(selectResidualShock(changed, fixture.protocol))).toBeTrue()
})

test('property: exact signal math is invariant to independent positive price rescaling', () => {
  checkProperty(
    'residual-shock-scale',
    fc.property(
      fc.array(fc.integer({ min: 10_000, max: 2_000_000 }), { minLength: 30, maxLength: 30 }),
      fc.array(fc.integer({ min: 10_000, max: 2_000_000 }), { minLength: 30, maxLength: 30 }),
      fc.integer({ min: 1, max: 1000 }),
      fc.integer({ min: 1, max: 1000 }),
      (prices, market, a, b) => {
        const left = prices.map(BigInt)
        const right = market.map(BigInt)
        expect(
          calculate(
            left.map((value) => value * BigInt(a)),
            right.map((value) => value * BigInt(b)),
          ),
        ).toEqual(calculate(left, right))
      },
    ),
  )
})

test('property: exact sample statistics agree with an independent numerical oracle', () => {
  checkProperty(
    'residual-shock-oracle',
    fc.property(fc.array(fc.integer({ min: 990_000, max: 1_010_000 }), { minLength: 30, maxLength: 30 }), (prices) => {
      const returns = prices.slice(1).map((price, index) => 10_000 * (price / (prices[index] ?? 1) - 1))
      const prior = returns.slice(0, 28)
      const mean = prior.reduce((sum, value) => sum + value, 0) / 28
      const variance = prior.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 27
      const actual = calculate(prices.map(BigInt))
      expect(number(actual.baselineMeanBps)).toBeCloseTo(mean, 8)
      expect(number(actual.baselineSampleVarianceBpsSquared)).toBeCloseTo(variance, 6)
    }),
  )
})

test('large exact variance is finite when compared to the numerical test oracle', () => {
  const prices = [
    990002, 990003, 991161, 996441, 998878, 994471, 992062, 990004, 1000196, 992410, 1006306, 992937, 1008977, 992197,
    1001261, 996494, 990110, 996893, 991957, 991915, 990005, 990006, 990031, 1001521, 992019, 990001, 991067, 1000222,
    990000, 990000,
  ]
  expect(number(calculate(prices.map(BigInt)).baselineSampleVarianceBpsSquared)).toBeCloseTo(6607.837538171239, 6)
})

test('property: candidate order and raw bar order cannot change the selected symbol', () => {
  checkProperty(
    'residual-shock-selection-order',
    fc.property(fc.integer({ min: 0, max: 14 }), (shift) => {
      const source = snapshot()
      const candidates = fixture.protocol.candidateSymbols
      const rotated = [...candidates.slice(shift), ...candidates.slice(0, shift)]
      const result = Result.getOrThrow(
        selectResidualShock(
          { ...source, bars: [...source.bars].reverse() },
          { ...fixture.protocol, candidateSymbols: rotated },
        ),
      )
      expect(result.selectedSymbol).toBe(select(source).selectedSymbol)
    }),
  )
})
