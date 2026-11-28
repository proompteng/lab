import { expect, test } from 'bun:test'

import { confirmBaseRoster } from './research-10yr-rates-credit-rotation'
import {
  blendPaths,
  buyAndHold,
  costs,
  metrics,
  pairedSharpeLower,
  promotion,
  replayRotation,
  Rule,
  Ticker,
  Verdict,
  type Bar,
  type Frame,
} from './research-10yr-rates-credit-rotation-core'
import { stationaryBootstrap } from './research-lib/statistics'

// Exact arithmetic inputs for the replay tests; no fixtures are used by the study runner.
const frame = (i: number, values: Partial<Record<Ticker, Bar>> = {}): Frame => ({
  date: new Date(Date.UTC(2016, 0, 4 + i)).toISOString().slice(0, 10),
  bars: new Map(Object.values(Ticker).map((ticker) => [ticker, values[ticker] ?? { open: 100, close: 100 }])),
})
const close = (value: number) => ({ open: 100, close: value })
const history = (changes: Readonly<Record<number, Partial<Record<Ticker, Bar>>>>) =>
  Array.from({ length: 131 }, (_, i) => frame(i, changes[i]))

test('admits only the preregistered roster from an adjusted base manifest', () => {
  const etfs = ['SHY', 'TLT', 'IEF', 'LQD', 'HYG', 'GLD', 'SPY', 'QQQ', 'XLE']
  const manifest = {
    schemaVersion: 'bayn.sip-10yr-sp100-manifest.v1',
    source: 'Alpaca Market Data API v2 (feed=sip, adjustment=all [split+dividend total return])',
    etfs,
  }
  expect(confirmBaseRoster(manifest)).toEqual([
    Ticker.TLT,
    Ticker.IEF,
    Ticker.HYG,
    Ticker.LQD,
    Ticker.GLD,
    Ticker.SHY,
    Ticker.SPY,
  ])
  expect(() => confirmBaseRoster({ ...manifest, etfs: etfs.filter((ticker) => ticker !== 'HYG') })).toThrow(
    'lacks required tickers: HYG',
  )
  expect(() => confirmBaseRoster({ ...manifest, etfs: [...etfs, 'SGOV'] })).toThrow('Unexpected TIP, BIL, or SGOV')
  expect(() => confirmBaseRoster({ ...manifest, source: 'unadjusted' })).toThrow()
})

test('observes the complete warmup and earns only the post-fill move on a new holding', () => {
  const days = history({
    126: { GLD: close(125) },
    127: { GLD: { open: 150, close: 165 }, HYG: close(180), SHY: { open: 102, close: 102 } },
  })
  const results = replayRotation(days, Rule.RelativeStrength, 0)
  expect(results.slice(0, 127).every(({ held }) => held.length === 1 && held[0] === Ticker.SHY)).toBe(true)
  expect(results[126].net).toBeCloseTo(0, 12)
  expect(results[127].held).toEqual([Ticker.GLD, Ticker.SHY])
  // Old SHY earns its gap. Half of the result earns the GLD day move, but never the GLD gap.
  const afterFee = (1 - 0.21 / 10_000) / (1 - 0.21 / 20_000)
  expect(results[127].net).toBeCloseTo(1.02 * afterFee * 1.05 - 1, 12)
  expect(replayRotation(days.slice(0, 128), Rule.RelativeStrength, 0)).toEqual(results.slice(0, 128))
  expect(results[128].held).toEqual([Ticker.HYG, Ticker.GLD])
})

test.each([
  ['equity stress', { TLT: close(130), HYG: close(125), GLD: close(120), IEF: close(110), SPY: close(95) }],
  ['credit stress', { TLT: close(130), TIP: close(125), GLD: close(120), IEF: close(110), HYG: close(99) }],
])('blocks risk assets at the next open on %s', (_, shock) => {
  const days = history({ 126: shock })
  const guarded = replayRotation(days, Rule.StressSwitch, 0)
  const plain = replayRotation(days, Rule.RelativeStrength, 0)
  expect(guarded[126].defensive).toBe(false)
  expect(guarded[127].defensive).toBe(true)
  expect(guarded[127].held).toEqual([Ticker.IEF, Ticker.GLD])
  expect(plain[127].held).not.toContain(Ticker.IEF)
  expect(plain[127].held).toContain(Ticker.TLT)
})

test('uses relative duration momentum even when neither stress trigger is active', () => {
  const days = history({
    63: { TLT: close(120) },
    126: { TLT: close(130), GLD: close(120), IEF: close(112), HYG: close(115) },
  })
  expect(replayRotation(days, Rule.RelativeStrength, 0)[127].held).toEqual([Ticker.TLT, Ticker.GLD])
  const row = replayRotation(days, Rule.StressSwitch, 0)[127]
  expect(row.defensive).toBe(false)
  expect(row.held).toEqual([Ticker.HYG, Ticker.GLD])
})

test('keeps incumbents inside the score deadband and does not react to open gaps', () => {
  const days = history({
    126: { HYG: close(112), GLD: close(110) },
    127: { HYG: close(112), GLD: close(110), TIP: close(110.3) },
    128: { HYG: close(112), GLD: { open: 220, close: 110 }, TIP: close(112) },
  })
  const results = replayRotation(days, Rule.RelativeStrength, 5)
  expect(results[127].rebalanced).toBe(true)
  expect(results[128].held).toEqual([Ticker.HYG, Ticker.GLD])
  expect(results[128].turnover).toBe(0)
  expect(results[129].held).toEqual([Ticker.TIP, Ticker.HYG])
  expect(results[129].turnover).toBeGreaterThan(0.1)
})

test('rebalances unchanged picks only once their prior-close weight drift reaches the band', () => {
  const days = history({
    126: { HYG: close(112), GLD: close(110) },
    127: { HYG: close(125), GLD: close(110) },
    128: { HYG: close(200), GLD: close(110) },
    129: { HYG: { open: 200, close: 200 }, GLD: { open: 110, close: 110 } },
  })
  const rows = replayRotation(days, Rule.RelativeStrength, 0)
  expect(rows[128].held).toEqual(rows[129].held)
  expect(rows[128].rebalanced).toBe(false)
  expect(rows[129].rebalanced).toBe(true)
  expect(rows[128].turnover).toBe(0)
  expect(rows[129].turnover).toBeGreaterThan(0)
})

test('charges half the round-trip spread on entry and keeps the sell levy in the zero-spread case', () => {
  const days = history({ 126: { GLD: close(125) } })
  const zero = replayRotation(days, Rule.RelativeStrength, 0)
  const ten = replayRotation(days, Rule.RelativeStrength, 10)
  expect(zero[0].net).toBe(0)
  expect(ten[0].net).toBeCloseTo(1 / 1.0005 - 1, 12)
  expect(zero[127].net).toBeLessThan(0)
  expect(ten[127].net).toBeLessThan(zero[127].net)
  const passive = buyAndHold(days.slice(0, 2), Ticker.SHY, 10)
  expect(passive[0].net).toBeCloseTo(ten[0].net, 12)
  expect(passive[1].net).toBe(0)
})

test('fails on missing or invalid prices, duplicate dates, and unpaired return calendars', () => {
  const bars = new Map(frame(0).bars)
  bars.delete(Ticker.TIP)
  expect(() => replayRotation([{ date: frame(0).date, bars }], Rule.StressSwitch, 5)).toThrow('TIP marks')
  expect(() => replayRotation([frame(0, { LQD: close(NaN) })], Rule.StressSwitch, 5)).toThrow('LQD marks')
  expect(() => replayRotation([frame(0), frame(0)], Rule.RelativeStrength, 5)).toThrow('Duplicate or out-of-order')
  const row = { date: '2016-01-04', net: 0, turnover: 0 }
  expect(() => blendPaths([[row], [{ ...row, date: '2016-01-05' }]], [0.5, 0.5], 5)).toThrow('alignment')
  expect(() => metrics([{ ...row, net: -1 }])).toThrow('insolvent')
})

test('represents funded blend rebalancing, net compounding, and sample volatility', () => {
  const dates = ['2016-01-04', '2016-01-05']
  const a = [
    { date: dates[0], net: 0.2, turnover: 0.1 },
    { date: dates[1], net: -0.04, turnover: 0 },
  ]
  const b = dates.map((date) => ({ date, net: 0, turnover: 0 }))
  const zero = blendPaths([a, b], [0.5, 0.5], 0)
  const ten = blendPaths([a, b], [0.5, 0.5], 10)
  expect(ten[0].net).toBeCloseTo(0.1, 12)
  expect(ten[1].turnover).toBeCloseTo(1 / 22, 12)
  expect(ten[1].net).toBeCloseTo((1 - 0.0005 / 11) * 0.98 - 1, 12)
  const summary = metrics(zero)
  expect(summary.totalReturn).toBeCloseTo(0.078, 12)
  expect(summary.annualizedVolatility).toBeCloseTo(0.12 * Math.sqrt(252 / 2), 12)
  expect(summary.maxDrawdown).toBeCloseTo(0.02, 12)
})

test('uses the same bootstrap blocks for the two legs and withholds undefined Sharpe lifts', () => {
  const net = Array.from({ length: 40 }, (_, i) => (i - 18) / 10_000)
  const plan = stationaryBootstrap(net.length, { draws: 100, meanBlock: 5, seed: 1234 })
  expect(pairedSharpeLower(net, net, plan)).toBe(0)
  expect(
    pairedSharpeLower(
      net.map((r) => r + 0.01),
      net,
      plan,
    ),
  ).toBeGreaterThan(0)
  expect(
    pairedSharpeLower(
      net,
      net.map(() => 0),
      plan,
    ),
  ).toBeNull()
  expect(() => pairedSharpeLower(net, net.slice(1), plan)).toThrow('Unaligned paired bootstrap')
})

test('requires one complete promotion route across all costs, without mixing routes', () => {
  const passing = costs.map((roundTripBp) => ({ roundTripBp, standalone: true, portfolio: false }))
  expect(promotion(passing).verdict).toBe(Verdict.Promote)
  expect(promotion(passing.slice(1)).verdict).toBe(Verdict.DoNotPromote)
  expect(promotion([...passing.slice(1), passing[3]]).verdict).toBe(Verdict.DoNotPromote)
  const mixed = passing.map((gate, i) => (i < 2 ? gate : { ...gate, standalone: false, portfolio: true }))
  expect(promotion(mixed).verdict).toBe(Verdict.DoNotPromote)
  expect(promotion(mixed.map((row) => ({ ...row, portfolio: true }))).verdict).toBe(Verdict.Promote)
})
