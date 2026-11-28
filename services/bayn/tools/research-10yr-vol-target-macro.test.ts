import { describe, expect, test } from 'bun:test'

import {
  breakeven,
  closeSignals,
  outsideBand,
  passesPromotion,
  replayTrend,
  summarize,
  tickers,
  type TrendSession,
  trendPanel,
  trials,
} from './research-10yr-vol-target-macro'

const session = (n: number, ...bars: TrendSession['bars']): TrendSession => ({
  date: new Date(Date.UTC(2020, 0, n + 1)).toISOString().slice(0, 10),
  bars,
})
const bar = (open: number, close = open) => ({ open, close, high: Math.max(open, close), low: Math.min(open, close) })

describe('registered inputs and signals', () => {
  test('registers 30 unique paths without counting costs or the references', () => {
    expect(trials).toHaveLength(30)
    expect(new Set(trials.map(({ id }) => id)).size).toBe(30)
    expect(trials.filter(({ reference }) => reference === 'B0+F4+O1')).toHaveLength(6)
  })

  test('fails closed on missing coverage or duplicate dates instead of carrying price marks forward', () => {
    const bars = new Map(tickers.map((ticker) => [ticker, bar(100)]))
    const row = { date: '2020-01-02', bars }
    expect(trendPanel([row])[0].bars).toHaveLength(10)
    expect(() => trendPanel([row, row])).toThrow('Duplicate or out-of-order')
    bars.delete('DBC')
    expect(() => trendPanel([row])).toThrow('Missing or invalid trend bar: DBC 2020-01-02')
  })

  test('uses inverse volatility, includes covariance, and cannot trade before the 253rd completed close', () => {
    let a = 100
    let b = 100
    let negative = 100
    const sessions = Array.from({ length: 254 }, (_, i) => {
      const move = i % 2 === 0 ? 0.022 : 0.002
      a *= 1 + move
      b *= 1 + 2 * move
      negative *= 1 - move
      return session(i, bar(a), bar(b), bar(negative))
    })
    const signals = closeSignals(sessions)
    const first = signals[252]
    expect(signals.slice(0, 252).every((s) => s === undefined)).toBe(true)
    expect(first?.weights[0]).toBeCloseTo(2 / 3, 12)
    expect(first?.weights[1]).toBeCloseTo(1 / 3, 12)
    expect(first?.weights[2]).toBe(0)
    // With perfect positive correlation, portfolio vol is exactly the weighted sum of the two vols.
    const aDailySd = 0.02 * Math.sqrt((32 * 31) / (63 * 62))
    expect(first?.forecast).toBeCloseTo((4 / 3) * aDailySd * Math.sqrt(252), 12)
    const path = replayTrend(sessions, signals, 0.1, 0.1, 0)
    expect(path.slice(0, 253).every(({ net, turnover }) => net === 0 && turnover === 0)).toBe(true)
    expect(path[253].turnover).toBeCloseTo(0.1 / ((8 / 3) * aDailySd * Math.sqrt(252)), 12)
  })

  test('uses all four horizons and parks a nonpositive vote at zero weight', () => {
    const sessions = Array.from({ length: 253 }, (_, i) =>
      session(i, bar(i === 0 || i === 126 ? 90 : i === 189 || i === 231 ? 110 : 100), bar(90 + i / 25)),
    )
    expect(closeSignals(sessions).at(-1)?.weights).toEqual([0, 1])
  })
})

describe('next-open accounting and close deadband', () => {
  test('charges both legs at their own open and never attributes the entry gap to a new holding', () => {
    const sessions = [session(0, bar(100)), session(1, bar(200, 220)), session(2, bar(110, 500))]
    const path = replayTrend(
      sessions,
      [{ weights: [1], forecast: 0.05 }, { weights: [0], forecast: 0 }, undefined],
      0.1,
      0.1,
      5,
    )
    expect(path[0].net).toBe(0)
    expect(path[1].net).toBeCloseTo(1.1 / 1.0005 - 1, 12)
    expect(path[2].net).toBeCloseTo(0.5 * (1 - (5 + 0.21) / 10_000) - 1, 12)
    expect(path[2].turnover).toBe(0.5)
  })

  test('decides at the prior close, keeps shares through an opening gap, and trades at the threshold', () => {
    expect(outsideBand([0, 0.125], [0.125, 0], 0.125)).toBe(true)
    expect(outsideBand([0.3], [0.3], 0)).toBe(false)
    const sessions = [session(0, bar(100)), session(1, bar(100)), session(2, bar(25))]
    const signals = [{ weights: [1], forecast: 0.125 }, { weights: [1], forecast: 0.12 }, undefined]
    const skipped = replayTrend(sessions, signals, 0.1, 0.1, 0)
    expect(skipped[2].net).toBeCloseTo(-0.6, 12)
    expect(skipped[2].turnover).toBe(0)
    expect(replayTrend(sessions, signals, 0.1, 0, 0)[2].turnover).toBeGreaterThan(0)
  })

  test('changing an execution-day close can change future orders, not that morning’s fill', () => {
    const sessions = Array.from({ length: 255 }, (_, i) => session(i, bar(100 + i)))
    const altered = sessions.map((row, i) => (i === 253 ? session(i, bar(353, 5)) : row))
    const initial = replayTrend(sessions, closeSignals(sessions), 0.1, 0.1, 2)
    const shocked = replayTrend(altered, closeSignals(altered), 0.1, 0.1, 2)
    expect(initial[253].turnover).toBe(shocked[253].turnover)
    expect(initial[254].turnover).toBe(0)
    expect(shocked[254].turnover).toBe(0.5)
  })
})

const ledger = (net: number, turnover = 0) => ({ date: 'fixture', net, turnover, borrow: 0 })

test('uses net compounded NAV, a starting high-water mark and half-notional turnover', () => {
  const result = summarize([ledger(0.1, 0.2), ledger(-0.2), ledger(0.05, 0.1)])
  expect(result.netReturn).toBeCloseTo(1.1 * 0.8 * 1.05 - 1, 12)
  expect(result.maxDrawdown).toBeCloseTo(0.2, 12)
  expect(result.annualVol).toBeCloseTo(0.16072751268321592 * Math.sqrt(252), 12)
  expect(result.annualOneWayTurnover).toBeCloseTo(25.2, 12)
  expect(result.sharpe).toBeLessThan(0)
  expect(result.sortino).toBeLessThan(0)
  expect(result.calmar).toBeCloseTo(result.cagr / 0.2, 12)
  expect(summarize([ledger(0), ledger(0)]).sharpe).toBeNull()
  expect(() => summarize([ledger(-1)])).toThrow('Invalid return or turnover series')
})

test('solves absolute breakeven on the unrounded net path and labels edge cases', () => {
  const result = breakeven([ledger(0.001, 0.5)])
  expect(result.status).toBe('estimated')
  expect(result.bps).toBeCloseTo(10, 8)
  expect(breakeven([ledger(-0.01, 0.5)])).toEqual({ status: 'nonpositive-at-zero', bps: 0 })
  expect(breakeven([ledger(0.01)])).toEqual({ status: 'no-trades', bps: null })
  expect(breakeven([ledger(0.9, 0.5)])).toEqual({ status: 'above-bound', bps: 1000 })
})

test('disallows promotion if any registered stress tier is absent, unscorable or fails', () => {
  const measurement = (dsr: number | null) => ({
    cagrLift: 0.01,
    sharpeLift: 0.2,
    maxDrawdownImprovement: 0.01,
    stationaryP: 0.049,
    dsr,
  })
  const good = measurement(0.95)
  const all = [2, 5, 10].map((bp) => [bp, good] as const)
  expect(passesPromotion(new Map(all))).toBe(true)
  expect(passesPromotion(new Map(all.slice(0, 2)))).toBe(false)
  expect(passesPromotion(new Map([...all, [10, { ...good, stationaryP: 0.05 }]]))).toBe(false)
  expect(passesPromotion(new Map([...all, [10, measurement(null)]]))).toBe(false)
  expect(passesPromotion(new Map([...all, [5, { ...good, maxDrawdownImprovement: 0 }]]))).toBe(false)
})
