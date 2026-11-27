import { describe, expect, test } from 'bun:test'

import { historyStarts, readTape, rtxExit, rtxResume } from './clean-factors-data'
import type { Bar, Tape, Universe } from './clean-factors-data'
import { combinedGrid, equityGrid, neighbors, overlayGrid, priorTrials } from './clean-factors-grid'
import type { Candidate, Equity } from './clean-factors-grid'
import { alignedCorrelations, netSeries, stationaryP, summarize } from './clean-factors-metrics'
import { makeReplayer, scaleVol } from './clean-factors-replay'
import type { ReplayDay } from './clean-factors-replay'
import { buildSignals, equityWeights, overlayWeights, regression } from './clean-factors-signals'
import { develop } from './clean-factors-study'
import { parseArgs } from './research-10yr-sp100-clean-factors'

const etfs = [
  'SPY',
  'QQQ',
  'IWM',
  'SMH',
  'XLK',
  'XLF',
  'XLV',
  'XLY',
  'XLC',
  'XLI',
  'XLP',
  'XLE',
  'XLU',
  'XLRE',
  'XLB',
  'TLT',
  'IEF',
  'SHY',
  'HYG',
  'LQD',
  'GLD',
  'SLV',
  'USO',
  'DBC',
  'EFA',
  'EEM',
  'VNQ',
]
const bar = (open = 100, high = 110, close = 100): Bar => ({ open, high, close })

function fixture() {
  const dates = Array.from({ length: 256 }, (_, i) =>
    new Date(Date.UTC(2023, 0, 1 + i + (i >= 253 ? 2 : 0))).toISOString().slice(0, 10),
  )
  const universe: Universe = {
    sectorByStock: new Map([
      ['A', 'XLK'],
      ['B', 'XLK'],
      ['C', 'XLF'],
      ['D', 'XLF'],
    ]),
    etfs,
  }
  const bars = new Map(
    [...etfs, ...universe.sectorByStock.keys()].map((s, i) => [s, dates.map((): Bar | undefined => bar(100, 110 + i))]),
  )
  return { dates, universe, bars } satisfies Tape
}

const high: Equity = {
  id: 'high-test',
  family: 'high',
  factor: 'high',
  book: 'long',
  k: 1,
  cycle: 21,
  sma: 0,
  targetVol: 0,
}
const spec = (equity = high): Candidate => ({ id: equity.id, family: equity.family, equity, overlayShare: 0 })

describe('Wave 4I registration', () => {
  test('pins 85 candidate IDs, a cumulative 445-trial search and topology-preserving probes', () => {
    const equity = equityGrid[0].equity
    if (equity === undefined) throw new Error('Expected equity template')
    const candidates = [...equityGrid, ...overlayGrid, ...combinedGrid(equity)]
    expect(new Set(candidates.map((c) => c.id)).size).toBe(85)
    expect(priorTrials + candidates.length).toBe(445)
    expect(neighbors(equityGrid[0], candidates).map((c) => c.equity?.k)).toEqual([15, 20])
    expect(neighbors(candidates.at(-1) ?? equityGrid[0], candidates)).toHaveLength(3)
    expect(parseArgs(['--freeze', '--input-dir', '/tmp/data'])).toEqual({ mode: '--freeze', inputDir: '/tmp/data' })
    expect(() => parseArgs(['--score', '--input-dir', '/tmp/data', '--unseal'])).toThrow('Usage')
  })

  test('development ignores all future prices, excludes the predecessor, and rejects an unsealed tape', () => {
    const universe: Universe = { sectorByStock: new Map([['A', 'XLK']]), etfs: ['SPY', 'SHY'] }
    const one = (s: string, d: string) => `${s}\t${d}T05:00:00Z\t100\t110\t95\t101\t40\t102`
    const raw = [
      ...['SPY', 'SHY', 'A', 'MMC'].map((s) => one(s, '2023-12-29')),
      'A\t2024-01-02T05:00:00Z\tinvalid',
    ].join('\n')
    const development = readTape(raw, universe, '2023-12-29')
    expect(development.tape.dates).toEqual(['2023-12-29'])
    expect(development.mmcRows).toBe(1)
    expect([...development.tape.bars.keys()]).not.toContain('MMC')
    expect(() => readTape(raw, universe, '2024-01-02')).toThrow('A 2024-01-02')
    expect(() => develop(fixture())).toThrow('Development must stop at Validation')
  })

  test('RTX features restart only after the announced blackout, without discarding the exit Open', () => {
    const { universe } = fixture()
    const dates = ['2020-03-30', rtxExit, '2020-04-01', '2020-04-03', rtxResume]
    const bars = new Map([['RTX', dates.map(() => bar())]])
    expect(historyStarts({ dates, bars, universe }, 'RTX')).toEqual([0, 2, 3, 4, 4])
    expect(bars.get('RTX')?.[1].open).toBe(100)
  })
})

describe('signals and execution', () => {
  test('finds idiosyncratic volatility with a centered two-factor fit', () => {
    const spy = [-0.03, -0.02, -0.01, 0.01, 0.02, 0.03]
    const sector = [0.04, 0.01, -0.03, -0.01, 0.02, -0.02]
    const stock = spy.map((r, i) => 0.002 + 1.45 * r - 0.2 * sector[i])
    const fit = regression(stock, spy, 5, 6, sector)
    expect(fit?.beta).toBeCloseTo(1.45, 10)
    expect(fit?.residualVol).toBeCloseTo(0, 7)
    expect(regression(stock, spy, 5, 6, spy)).toBeUndefined()
  })

  test('matches sector long/short notionals and omits a sector from equity and ETF positions', () => {
    const tape = fixture()
    const signals = buildSignals(tape)
    const weights = equityWeights({ ...high, book: 'sector-neutral', k: 2 }, signals, 251, tape.dates[252], new Map())
    expect(Object.fromEntries(weights)).toEqual({ A: 0.25, B: -0.25, C: 0.25, D: -0.25 })
    const omit = equityWeights(
      { ...high, book: 'sector-neutral', k: 2 },
      signals,
      251,
      tape.dates[252],
      new Map(),
      'XLK',
    )
    expect(Object.fromEntries(omit)).toEqual({ C: 0.25, D: -0.25 })
    signals.features.get('XLK')?.trend126.fill(0.5)
    const overlay = overlayGrid[0].overlay
    expect(overlayWeights(overlay, signals, 251, new Map()).has('XLK')).toBe(true)
    expect(overlayWeights(overlay, signals, 251, new Map(), 'XLK').has('XLK')).toBe(false)
  })

  test('BAB never replaces trend-blocked short slots and scales on a completed unscaled volatility window', () => {
    const tape = fixture()
    const signals = buildSignals(tape)
    signals.stocks.forEach((stock, i) => {
      stock.beta[251] = 0.5 + i * 0.5
      stock.sma50[251] = stock.symbol === 'C' ? 101 : 99
    })
    const bab: Equity = { ...high, family: 'managed', factor: 'bab', book: 'dollar-neutral', sma: 50, targetVol: 0.08 }
    expect(equityWeights(bab, signals, 251, tape.dates[252], new Map()).size).toBe(0)
    const d = signals.stockFeatures.get('D')
    if (d === undefined) throw new Error('D missing')
    d.sma50[251] = 101
    const weights = equityWeights(bab, signals, 251, tape.dates[252], new Map())
    expect(weights.get('D')).toBeLessThan(0)
    const a = weights.get('A') ?? 0
    const short = weights.get('D') ?? 0
    expect(a * (0.67 * 0.5 + 0.33) + short * (0.67 * 2 + 0.33)).toBeCloseTo(0, 10)
    const path = Array.from({ length: 126 }, (_, i) => (i % 2 !== 0 ? 0.01 : -0.01))
    expect(scaleVol(path.slice(1), false, 0.08)).toBe(1)
    expect(scaleVol(path, true, 0.08)).toBeCloseTo(0.08 / (0.01 * Math.sqrt((126 / 125) * 252)) / 2, 10)
  })

  test('sizes orders at the preceding Close and realizes the next-Open gap only after owning the shares', () => {
    const tape = fixture()
    tape.bars.get('A')?.splice(252, 2, bar(105, 112, 107), bar(110, 120, 111))
    const result = makeReplayer(tape, buildSignals(tape))(spec(), { first: 252, last: 255 })
    expect(result.days[0].traded).toBe(750 * 105)
    expect(result.days[0].gross).toBe(0)
    expect(result.days[1].gross).toBe(750 * 5)
    expect(result.days[3].grossExposure).toBe(0)
    expect(result.gaps).toEqual([])
  })

  test('a missing held Open liquidates at the last actual Close, without inventing a future price or aborting other positions', () => {
    const tape = fixture()
    tape.bars.get('A')?.splice(252, 3, bar(105, 112, 108), undefined, bar(180, 190, 182))
    tape.bars.get('B')?.splice(252, 2, bar(100), bar(104))
    const result = makeReplayer(tape, buildSignals(tape))(spec({ ...high, k: 2 }), { first: 252, last: 255 })
    expect(result.gaps).toEqual([
      { date: tape.dates[253], symbol: 'A', reason: 'missing-open', lastClose: 108, liquidatedUnits: 375 },
    ])
    expect(result.days[1].gross).toBe(375 * (108 - 105) + 375 * (104 - 100))
    expect(result.days[1].sold).toBe(375 * 108)
    expect(result.days[2].gross).toBe(375 * (100 - 104))
    expect(historyStarts(tape, 'A')[254]).toBe(254)
  })

  test('an unregistered price splice uses the same diagnostic liquidation rather than booking a windfall', () => {
    const tape = fixture()
    tape.bars.get('A')?.splice(253, 1, bar(240, 245, 242))
    const result = makeReplayer(tape, buildSignals(tape))(spec(), { first: 252, last: 255 })
    expect(result.gaps[0]).toMatchObject({ reason: 'discontinuity', symbol: 'A', lastClose: 100 })
    expect(result.days[1].gross).toBe(0)
  })

  test('a managed short is covered outside its scheduled rebalance when its trend turns', () => {
    const tape = fixture()
    const signals = buildSignals(tape)
    signals.stocks.forEach((stock, i) => {
      stock.momentum[251] = 1 - i
      stock.sma50[251] = 101
      stock.sma50[252] = 99
    })
    const managed: Equity = { ...high, family: 'managed', factor: 'momentum', book: 'dollar-neutral', sma: 50 }
    const result = makeReplayer(tape, signals)(spec(managed), { first: 252, last: 255 })
    expect(result.days[0].sold).toBe(50_000)
    expect(result.days[1].traded).toBe(50_000)
    expect(result.days[1].sold).toBe(0)
    expect(result.days[1].grossExposure).toBe(50_000)
  })

  test('closes a held RTX position at the scheduled corporate-action Open outside a rebalance', () => {
    const tape = fixture()
    tape.dates.forEach((_, i) => {
      tape.dates[i] = new Date(Date.UTC(2020, 2, 31 - (253 - i))).toISOString().slice(0, 10)
    })
    tape.universe.sectorByStock.set('RTX', 'XLI')
    const rtxBars = tape.dates.map(() => bar(100, 101))
    rtxBars[253] = bar(103, 104)
    rtxBars[254] = bar(220, 223, 222)
    tape.bars.set('RTX', rtxBars)
    const result = makeReplayer(tape, buildSignals(tape))(spec(), { first: 252, last: 255 })
    expect(result.knownRtxExitUnits).toBe(750)
    expect(result.days[1].sold).toBe(750 * 103)
    expect(result.days[1].gross).toBe(750 * 3)
    expect(result.days[2].gross).toBe(0)
    expect(result.gaps).toEqual([])
  })

  test('charges borrow over elapsed calendar days and carries only unencumbered collateral', () => {
    const tape = fixture()
    tape.bars.get('SHY')?.splice(253, 1, bar(101))
    const result = makeReplayer(tape, buildSignals(tape))(spec({ ...high, book: 'dollar-neutral' }), {
      first: 252,
      last: 255,
    })
    expect(result.days[0].sold).toBe(50_000)
    expect(result.days[1].borrow).toBeCloseTo((50_000 * 0.015 * 3) / 365, 10)
    expect(result.days[1].carry).toBe(0)
    const long = makeReplayer(tape, buildSignals(tape))(spec(), { first: 252, last: 255 })
    expect(long.days[1].carry).toBeCloseTo(250, 10)
  })
})

describe('evidence statistics', () => {
  const day = (index: number, fields: Partial<ReplayDay> = {}): ReplayDay => ({
    date: `2024-01-${index + 10}`,
    traded: 0,
    sold: 0,
    borrow: 0,
    carry: 0,
    gross: 0,
    spy: 0,
    shyOpen: 100,
    previousShyOpen: 100,
    grossExposure: 0,
    ...fields,
  })

  test('prices round trips per leg, subtracts the true compounded SHY benchmark and separates positive-day removals', () => {
    const days = [
      day(0, { gross: 32, traded: 10_000, sold: 6_000, borrow: 1, carry: 20, spy: -0.01, shyOpen: 101 }),
      day(1, { gross: -12, spy: 0.01, previousShyOpen: 101, shyOpen: 103 }),
    ]
    const views = netSeries(days, 20)
    expect(views.zeroCash[0]).toBeCloseTo(32 - 10 - 0.126 - 1, 10)
    expect(views.shyCash[0] - views.zeroCash[0]).toBeCloseTo(20, 10)
    expect(views.shyExcess[0]).toBeCloseTo(views.shyCash[0] - 1_000, 10)
    expect(views.shyExcess[1]).toBeCloseTo(-2_012, 10)
    const result = summarize(days)
    expect(result.shyBuyHoldUsd).toBeCloseTo(3_000, 10)
    expect(result.costs[20].zeroCash.exTop5Usd).toBeCloseTo(-12, 10)
    expect(result.costs[20].zeroCash.exTop10Usd).toBeCloseTo(-12, 10)
    expect(result.costs[20].zeroCash.downSpyNetUsd).toBeCloseTo(views.zeroCash[0], 10)
    expect(result.turnoverPerYear).toBeCloseTo(6.3, 10)
  })

  test('stationary circular bootstrap is deterministic, positive-tail and unavailable for degenerate paths', () => {
    const values = Array.from({ length: 25 }, (_, i) => 3 + (i % 3))
    expect(stationaryP(values)).toBe(1 / 10_001)
    expect(stationaryP(values.map((x) => -x))).toBe(1)
    const mixed = Array.from({ length: 40 }, (_, i) => Math.sin(i / 3) + 0.02)
    const p = stationaryP(mixed) ?? 0
    expect(p).toBeGreaterThan(0.1)
    expect(p).toBeLessThan(0.9)
    expect(stationaryP(mixed)).toBe(p)
    expect(stationaryP(values.map(() => 1))).toBeNull()
  })

  test('requires identical correlation calendars rather than pairwise dropping dates', () => {
    const control = [day(0, { gross: 1 }), day(1, { gross: 2 }), day(2, { gross: 3 })]
    const opposite = control.map((d) => ({ ...d, gross: -d.gross }))
    expect(alignedCorrelations(control, opposite)[0].zeroCash).toBeCloseTo(-1, 10)
    expect(() => alignedCorrelations(control, opposite.slice(1))).toThrow('identical session calendars')
  })
})
