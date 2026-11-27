import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { sha256 } from '../../hash'
import { fixtureMarket, parityClose, regimeClose } from './fixtures.test-support'
import { decodeMacroCanaryEtfPolicy, defaultMacroCanaryEtfPolicy } from './policy'
import { compileMacroCanaryEtfSignal, makeMacroCanaryEtfDefinition } from './signals'

const receipt = defaultMacroCanaryEtfPolicy
const strategy = makeMacroCanaryEtfDefinition()
const run = (market: ReturnType<typeof fixtureMarket>) => strategy.decide({ market })
const atClose = (day: number, marks = parityClose) => Result.getOrThrow(run(fixtureMarket(day, marks)))

test('matches exact frozen research blend bytes on review at 252 + 21k', () => {
  // Computed by features() + targets(mix, ..., -1) at 06e85b0e59f70c8b09181266a883179c8c90b498.
  // Compare the canonical ETF vector before production concentration and SHY funding, not replay P&L.
  const expected = [
    [252, parityClose, '4ca220d6ef89d9e24aa53cea479848abc3842d6e14e23d15224337c6acba6022'],
    [273, parityClose, '047a87607df9599e3158002c0c3a43ce8552a40462422d58f42f9e44dee0ef91'],
    [378, parityClose, 'c3f0d0e60f0a0d3ba31f13d27209376583fd2001bf3906dfadd2b4c12399dbf0'],
    [252, regimeClose, '8db4771dc4e7ace6aca9d9f0cb68f7ac1dde5c3df3c904e0f2761323435ff745'],
    [273, regimeClose, '570f162b0cfa2bbb2e9612d3a91c15efe95ca8f8185e330011738f85c4257945'],
    [294, regimeClose, '97899a90088b9a7cb319be1919b1544d23f041097efdc3dc4ae55d0e674a0cdd'],
  ] as const
  expect(strategy.holdingPeriod).toBe('MULTI_SESSION')
  for (const [day, close, hash] of expected) {
    const signal = atClose(day, close)
    expect(signal.review).toBe(true)
    expect(sha256(JSON.stringify(Object.values(signal.attribution.ensembleWeights)))).toBe(hash)
  }
  const next = atClose(253)
  expect(next.review).toBe(false)
  expect(next.attribution.canary).toEqual(atClose(252).attribution.canary)
})

test('ignores next-open and later OHLCV bytes, but reacts to the previous close', () => {
  const market = fixtureMarket(273)
  const baseline = Result.getOrThrow(run(market))
  expect(baseline.signalSession).toBe(market.calendar[273])
  const bars = market.history.bars.map((bar) =>
    bar.session >= market.nextOpenSession ? { ...bar, open: -1000, high: NaN, close: 10_000_000, volume: -1 } : bar,
  )
  const futureChanged = Result.getOrThrow(run({ ...market, history: { ...market.history, bars } }))
  expect(JSON.stringify(futureChanged)).toBe(JSON.stringify(baseline))
  const priorChanged = bars.map((bar) =>
    bar.session === baseline.signalSession && bar.symbol === 'TLT'
      ? { ...bar, open: 500, high: 501, low: 499, close: 500 }
      : bar,
  )
  const changed = Result.getOrThrow(run({ ...market, history: { ...market.history, bars: priorChanged } }))
  expect(changed.targetWeights).not.toEqual(baseline.targetWeights)
})

test('rotates the macro arm smoothly from Goldilocks to Stagflation and Deflationary Crash', () => {
  const goldilocks = atClose(252, regimeClose).attribution.macro
  expect(goldilocks.regime).toBe('Goldilocks')
  expect(goldilocks.credit).toBeGreaterThan(0)
  expect(goldilocks.inflation).toBeLessThan(0)
  expect(goldilocks.unsmoothedWeights).toMatchObject({ QQQ: 0.25, SPY: 0.25, XLK: 0.25, IEF: 0.25, UUP: 0 })

  const firstStag = atClose(253, regimeClose).attribution.macro
  expect(firstStag.regime).toBe('Stagflation')
  expect(firstStag.credit).toBeLessThan(0)
  expect(firstStag.inflation).toBeGreaterThan(0)
  expect(firstStag.strongDollar).toBe(true)
  expect(firstStag.unsmoothedWeights).toMatchObject({ UUP: 0.4, DBC: 0.2, GLD: 0.2, SHY: 0.2, QQQ: 0 })
  expect(firstStag.weights.UUP).toBeCloseTo(0.4 / 3, 14)
  expect(firstStag.weights.QQQ).toBeCloseTo(goldilocks.weights.QQQ * (2 / 3), 14)
  const stag = atClose(280, regimeClose).attribution.macro
  expect(stag.weights.UUP).toBeGreaterThan(0.39)

  const crash = atClose(281, regimeClose).attribution.macro
  expect(crash.regime).toBe('DeflationaryCrash')
  expect(crash.inflation).toBeLessThan(0)
  expect(crash.unsmoothedWeights).toMatchObject({ TLT: 0.25, IEF: 0.25, GLD: 0.25, SHY: 0.25, UUP: 0 })
  expect(crash.weights.UUP).toBeCloseTo(stag.weights.UUP * (2 / 3), 14)
  expect(crash.weights.TLT).toBeGreaterThan(stag.weights.TLT)
  expect(atClose(294, regimeClose).attribution.macro.weights.TLT).toBeGreaterThan(0.24)
})

test('boosts only the risk-off dollar hedge and shrinks risk-on exposure when the dollar rises', () => {
  const first = atClose(252, (day, symbol) => (symbol === 'UUP' && day >= 220 ? 110 : regimeClose(day, symbol)))
  expect(first.attribution.macro.regime).toBe('Goldilocks')
  expect(first.attribution.macro.strongDollar).toBe(true)
  expect(first.attribution.macro.unsmoothedWeights).toMatchObject({
    QQQ: 0.1875,
    SPY: 0.1875,
    XLK: 0.1875,
    IEF: 0.1875,
    UUP: 0,
  })
  const second = atClose(273, (day, symbol) => (symbol === 'UUP' ? 100 : regimeClose(day, symbol)))
  expect(second.attribution.macro.regime).toBe('Stagflation')
  expect(second.attribution.macro.strongDollar).toBe(false)
  expect(second.attribution.macro.unsmoothedWeights).toMatchObject({ UUP: 0, SHY: 1 / 3, DBC: 1 / 3, GLD: 1 / 3 })
})

test('discloses clipped exposure, unswept cash, and trend scores independently of portfolio weights', () => {
  const flat = atClose(252, () => 100)
  expect(flat.attribution.canary.offCount).toBe(4)
  expect(flat.attribution.canary.defensiveBudget).toBe(1)
  expect(flat.attribution.trend.zScores).toMatchObject({ SPY: 0, IEF: 0, UUP: 0 })
  expect(flat.targetWeights.SHY).toBe(0.5)
  expect(flat.attribution.idleShyWeight).toBeCloseTo(0.5 - flat.attribution.ensembleWeights.SHY, 14)
  expect(flat.attribution.unsweptCashWeight).toBeCloseTo(0.25, 14)
  expect(Object.values(flat.targetWeights).every((w) => w >= 0 && w <= 0.5)).toBe(true)

  const { policy } = receipt
  const signed = Result.getOrThrow(
    decodeMacroCanaryEtfPolicy({
      ...policy,
      trend: { ...policy.trend, book: { kind: 'signed', maxShortGrossWeight: 0.04 } },
    }),
  )
  const declining = fixtureMarket(252, (day) => 100 - day / 10)
  const output = Result.getOrThrow(compileMacroCanaryEtfSignal(signed, declining))
  expect(output.attribution.trend.weights.SPY).toBeLessThan(0)
  const shortGross = (weights: Readonly<Record<string, number>>) =>
    Object.values(weights).reduce((sum, w) => sum - Math.min(0, w), 0)
  expect(shortGross(output.attribution.trend.weights)).toBeCloseTo(0.04, 14)
  expect(shortGross(output.targetWeights)).toBeGreaterThan(0)
  expect(shortGross(output.targetWeights)).toBeLessThanOrEqual(0.04)
  expect(Object.values(output.targetWeights).reduce((sum, w) => sum + Math.abs(w), 0)).toBeLessThanOrEqual(1)
})

test('fails on insufficient warmup, a sliding calendar, a missing whole session or one required ETF', () => {
  expect(run(fixtureMarket(251))).toMatchObject({
    _tag: 'Failure',
    failure: { _tag: 'InsufficientWarmup', required: 253, available: 252 },
  })
  const market = fixtureMarket(273)
  const day = market.calendar[107]
  expect(run({ ...market, calendar: market.calendar.slice(1) })).toMatchObject({
    _tag: 'Failure',
    failure: { _tag: 'InvalidCalendar' },
  })
  for (const symbol of ['DIA', 'SHY', 'UUP'] as const) {
    const bars = market.history.bars.filter((bar) => bar.session !== day || bar.symbol !== symbol)
    expect(run({ ...market, history: { ...market.history, bars } })).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'MissingRequiredSymbol', symbol, session: day },
    })
  }
  const bars = market.history.bars.filter((bar) => bar.session !== day)
  expect(run({ ...market, history: { ...market.history, bars } })).toMatchObject({
    _tag: 'Failure',
    failure: { _tag: 'MissingRequiredSymbol', symbol: 'SPY', session: day },
  })
})

test('fails closed on raw, unverified or future-vintage corporate actions and malformed history', () => {
  const market = fixtureMarket(252)
  for (const update of [
    { adjustment: 'raw' as const },
    { corporateActionsThrough: null },
    { corporateActionsThrough: market.nextOpenSession },
    { corporateActionsThrough: market.calendar[251] },
  ]) {
    expect(run({ ...market, history: { ...market.history, ...update } })).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'UnverifiedAdjustments', signalSession: market.calendar[252] },
    })
  }
  const [first, ...rest] = market.history.bars
  for (const bars of [
    [first, first, ...rest],
    [{ ...first, close: first.high + 1 }, ...rest],
  ]) {
    expect(run({ ...market, history: { ...market.history, bars } })).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'InvalidBar', symbol: 'SPY', session: first.session },
    })
  }
})
