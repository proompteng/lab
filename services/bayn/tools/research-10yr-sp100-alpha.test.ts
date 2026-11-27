import { describe, expect, test } from 'bun:test'

import { argumentsFor } from './research-10yr-sp100-alpha'
import { parseTape, type Tape } from './sp100-alpha-data'
import { grid, neighbors } from './sp100-alpha-protocol'
import { net, replay, summarize } from './sp100-alpha-replay'
import { features, gross, regress, riskParity, targetBook, TrailingVol } from './sp100-alpha-signals'
import { gates, plateau } from './sp100-alpha-study'

const date = (offset: number) => new Date(Date.UTC(2024, 0, 1 + offset)).toISOString().slice(0, 10)
const bar = (symbol: string, day: string, price: number) =>
  `${symbol}\t${day}T05:00:00Z\t${price}\t${price}\t${price}\t${price}\t100\t${price}`
const fixture = (n: number, price: (symbol: string, i: number) => number): Tape =>
  parseTape(
    ['STOCK', 'SPY', 'XLK']
      .flatMap((symbol) => Array.from({ length: n }, (_, i) => bar(symbol, date(i), price(symbol, i))))
      .join('\n'),
    [['STOCK']],
    [['SPY', 'XLK']],
    date(n - 1),
  )

describe('Wave 3A pre-registration', () => {
  test('allows exactly one stage and an optional local input directory', () => {
    expect(argumentsFor(['--freeze']).stage).toBe('--freeze')
    expect(argumentsFor(['--freeze']).input).toBeUndefined()
    expect(argumentsFor(['--score', '--input-dir', '/tmp/sample']).input).toBe('/tmp/sample')
    for (const args of [[], ['--freeze', '--score'], ['--score', '--input-dir'], ['--score', '--seed', '1']]) {
      expect(() => argumentsFor(args)).toThrow('Usage')
    }
  })

  test('registers every discrete level and uses symmetric adjacent plateau neighbors', () => {
    const trials = grid()
    expect(trials).toHaveLength(344)
    expect(new Set(trials.map(({ id }) => id)).size).toBe(344)
    const center = trials.find(({ id }) => id === 'momentum-120-120-10-10-sector-2')
    if (center === undefined) throw new Error('Missing center')
    const nearby = neighbors(center, trials)
    expect(nearby).toHaveLength(9)
    expect(nearby.some(({ id }) => id.endsWith('cross-10'))).toBe(false)
    expect(nearby.every((probe) => neighbors(probe, trials).some(({ id }) => id === center.id))).toBe(true)
  })

  test('development input does not parse malformed future prices and rejects duplicate eligible bars', () => {
    const day = date(0)
    const late = 'SPY\t2026-01-02T05:00:00Z\tnot-a-price'
    const before = ['STOCK', 'SPY', 'XLK'].map((symbol) => bar(symbol, day, 10)).join('\n')
    const decode = (content: string, through: string) => parseTape(content, [['STOCK']], [['SPY', 'XLK']], through)
    const bounded = decode(`${before}\n${late}`, day)
    expect(bounded.rows).toBe(3)
    expect(bounded.dataSha).toBe(decode(before, day).dataSha)
    expect(() => decode(`${before}\n${late}`, '2026-01-02')).toThrow('Invalid or unordered bar')
    expect(() => decode(`${before}\n${bar('STOCK', day, 10)}`, day)).toThrow('Invalid or unordered bar')
  })
})

describe('causal execution and costs', () => {
  test('uses prior Close for quantity, following Opens for fills and marks, and ACT/365 including weekends', () => {
    const tape = fixture(5, () => 100)
    tape.dates = ['2024-01-04', '2024-01-05', '2024-01-08', '2024-01-09', '2024-01-10']
    tape.series[0].open.set([100, 120, 108, 110, 110])
    tape.series[0].close.set([100, 115, 107, 119, 120])
    const targets = [
      [-0.1, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0.5, 0, 0],
      [0, 0, 0],
    ].map((row) => Float64Array.from(row))
    const run = replay(tape, targets, [tape.dates[0], tape.dates[3]])
    expect(run.errors).toBe(0)
    const [, entry, exit, final] = run.days
    expect(entry.pnl).toBe(0)
    expect(entry.traded).toBe(18_000)
    expect(entry.sellFee).toBeCloseTo(0.378)
    expect(net(entry, 5)).toBeCloseTo(-4.878)
    expect(net(entry, 10)).toBeCloseTo(-9.378)
    expect(net(entry, 20)).toBeCloseTo(-18.378)
    expect(exit.pnl).toBe(1800)
    expect(exit.borrow).toBeCloseTo((150 * 115 * 0.015 * 3) / 365, 8)
    expect(exit.traded).toBe(16_200)
    expect(exit.sellFee).toBe(0)
    expect(final.traded).toBe(0)
  })

  test('starts flat and liquidates with charged execution at the final Open regardless of target', () => {
    const tape = fixture(4, () => 100)
    const targets = tape.dates.map(() => Float64Array.of(0.1, 0, 0))
    const run = replay(tape, targets, [date(1), date(3)])
    expect(run.days.map(({ traded }) => traded)).toEqual([15_000, 0, 15_000])
    expect(run.days[2].sellFee).toBeCloseTo(0.315)
  })

  test('cannot pass with missing execution bars, unresolved price splices, or realized gross breaches', () => {
    const targets = Array.from({ length: 4 }, () => Float64Array.of(1, 0, 0))
    for (const [i, price, reason] of [
      [1, 0, 'missing execution'],
      [1, 122, 'gross exceeds'],
      [2, 40, 'mark discontinuity'],
    ] as const) {
      const tape = fixture(4, () => 100)
      tape.series[0].open[i] = price
      const run = replay(tape, targets, [date(0), date(3)])
      const summary = summarize(run, {})
      expect(summary.firstError ?? '').toContain(reason)
      expect(summary.costs).toEqual({ 5: null, 10: null, 20: null })
      const probes = { 10: plateau(summary, [], 10), 20: plateau(summary, [], 20) }
      expect(gates(summary, {}, probes, true)[10].netPositive).toBe(false)
    }
  })
})

describe('causal factor and portfolio math', () => {
  test('recovers both partial slopes and refuses a collinear fit', () => {
    expect(regress(2, 5, 1, 3, -8)).toEqual([23 / 9, -19 / 9])
    expect(regress(1, 1, 1, 2, 2)).toBeNull()
  })

  test('trailing volatility expires old marks without leaking future observations', () => {
    const vol = new TrailingVol(2)
    vol.push(0)
    expect(vol.annualized()).toBe(0)
    vol.push(0.02)
    expect(vol.annualized()).toBeCloseTo(Math.sqrt(252) * 0.01)
    vol.push(0.02)
    expect(vol.annualized()).toBe(0)
  })

  test('trend and ensemble targets are prefix invariant and omit the selected sector ETF', () => {
    const n = 300
    const price = (symbol: string, i: number) =>
      100 * Math.exp((symbol === 'XLK' ? -1 : 1) * 0.001 * i + 0.01 * Math.sin(i))
    const short = fixture(n, price)
    const long = fixture(n + 1, (symbol, i) => (i === n ? 1 : price(symbol, i)))
    const config = grid().find(({ id }) => id === 'trend-vol-long-short-0')
    if (config === undefined) throw new Error('Missing trend')
    const pure = (tape: Tape) => targetBook(tape, config, features(tape))
    const baseline = pure(short)
    const extended = pure(long)
    expect(baseline).toEqual(extended.slice(0, n))
    expect(baseline[n - 1][short.spy]).toBeGreaterThan(0)
    expect(baseline[n - 1][short.sectorEtfs[0]]).toBeLessThan(0)
    expect(gross(baseline[n - 1])).toBeLessThanOrEqual(1)
    const omit = targetBook(short, config, features(short), 0)
    expect(omit[n - 1][short.sectorEtfs[0]]).toBe(0)
    expect(riskParity(short, [baseline, omit])).toEqual(
      riskParity(long, [extended, targetBook(long, config, features(long), 0)]).slice(0, n),
    )
  })
})

test('sector momentum is dollar-neutral in stock targets and SPY-hedged after sizing', () => {
  const n = 190
  const symbols = ['A', 'B', 'SPY', 'XLK']
  const market = (i: number) => 0.02 * Math.sin(i * 0.7)
  const sector = (i: number) => 0.015 * Math.sin(i * 1.1)
  const stock = (symbol: string, i: number) => {
    const residual = (symbol === 'A' ? 1 : -1) * (Math.max(0, i - 100) * 0.002 + 0.003 * Math.sin(i * 2.1))
    return (symbol === 'A' ? 2 : 0.5) * market(i) + sector(i) + residual
  }
  const content = symbols
    .flatMap((symbol) =>
      Array.from({ length: n }, (_, i) => {
        const log = symbol === 'SPY' ? market(i) : symbol === 'XLK' ? sector(i) : stock(symbol, i)
        return bar(symbol, date(i), 100 * Math.exp(log))
      }),
    )
    .join('\n')
  const tape = parseTape(content, [['A', 'B']], [['SPY', 'XLK']], date(n - 1))
  const spec = grid().find(({ id }) => id === 'momentum-60-60-5-5-sector-1')
  if (spec === undefined) throw new Error('Missing momentum')
  const f = features(tape)
  const positions = targetBook(tape, spec, f)
  const i = tape.dates.length - 1
  const [long, short, overlay] = positions[i]
  expect(long).toBeGreaterThan(0)
  expect(short).toBeLessThan(0)
  expect(long + short).toBeCloseTo(0, 12)
  expect(long * f.beta[0][i] + short * f.beta[1][i] + overlay).toBeCloseTo(0, 12)
  expect(gross(positions[i])).toBeLessThanOrEqual(1)
  expect(gross(targetBook(tape, spec, f, 0)[i])).toBe(0)
})

test('a positive primary-cost holdout does not override the stress-cost or sector gate', () => {
  const run = {
    firstError: null,
    errors: 0,
    days: Array.from({ length: 60 }, (_, i) => ({
      date: date(i),
      traded: 10_000,
      pnl: 6 + (i % 3),
      spy: i % 2 === 0 ? 0.01 : -0.01,
      gross: 20_000,
      borrow: 0,
      sellFee: 0,
    })),
  }
  const s = summarize(run, {})
  const probes = [
    { id: 'a', result: s },
    { id: 'b', result: s },
  ]
  const checks = gates(s, {}, { 10: plateau(s, probes, 10), 20: plateau(s, probes, 20) }, true)
  expect(checks[10]).toEqual({
    netPositive: true,
    exTop5Positive: true,
    bootstrap: true,
    allSectorsPositive: false,
    neighboringPlateau: true,
  })
  expect(checks[20].netPositive).toBe(false)
  expect(checks[20].neighboringPlateau).toBe(false)
})
