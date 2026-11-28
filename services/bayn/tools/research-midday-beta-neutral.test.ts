import { describe, expect, test } from 'bun:test'

import {
  dailySummaries,
  decodeRegularCalendar,
  parseBar,
  parseQuote,
  type Bar,
  type Quote,
  type Session,
  type Tape,
} from './midday-research-data'
import { executeBasket, executionPrice, legCollarBps, targetNotionals } from './midday-research-execution'
import {
  estimateBeta,
  prepareSignalHistory,
  selectMiddayBasket,
  type RankedLeg,
  type Selection,
  type SignalRow,
} from './midday-research-signal'
import { bootstrapPValue, deflatedSharpe, expectedMaximumSharpe, sessionEconomics } from './midday-research-statistics'
import { trialGrid } from './research-midday-beta-neutral'

const bar = (open: number, close = open): Bar => ({
  open,
  close,
  low: Math.min(open, close),
  high: Math.max(open, close),
  volume: 100,
  vwap: 100,
})
const quote = (bid: number, ask: number): Quote => ({
  firstBid: bid,
  firstAsk: ask,
  lastBid: bid,
  lastAsk: ask,
  medianBps: 20,
  p75Bps: 24,
})
const row = (symbol: string, vwapDevBps: number, beta20 = 1, atrBps = 200): SignalRow => ({
  symbol,
  close: 100,
  vwapDevBps,
  beta14: beta20,
  beta20,
  atrBps,
  completedQuote: quote(99.9, 100.1),
})

describe('frozen export boundaries', () => {
  test('uses exchange-local regular bounds across the clock change and an early close', () => {
    const calendar = decodeRegularCalendar({
      query: { start: '2026-10-30', end: '2026-11-27' },
      response: [
        { date: '2026-10-30', open: '09:30', close: '16:00' },
        { date: '2026-11-27', open: '09:30', close: '13:00' },
      ],
    })
    expect(
      calendar.providerSessions.map(({ regularOpenAt, regularCloseAt }) => [regularOpenAt, regularCloseAt]),
    ).toEqual([
      ['2026-10-30T13:30:00.000Z', '2026-10-30T20:00:00.000Z'],
      ['2026-11-27T14:30:00.000Z', '2026-11-27T18:00:00.000Z'],
    ])
  })

  test('decodes a minute bar and real L1 endpoints, rejects invalid timestamps and crossed quotes', () => {
    expect(parseBar('AMD\t2026-08-24T13:30:00Z\t100\t101\t99\t100\t100\t100').value.close).toBe(100)
    expect(parseQuote('AMD\t2026-08-24T13:30:00Z\t20\t99.9\t100.1\t100\t100.2\t20\t30').value.lastBid).toBe(100)
    expect(() => parseBar('AMD\tbad\t100\t101\t99\t100\t100\t100')).toThrow('Malformed')
    expect(() => parseQuote('AMD\t2026-08-24T13:30:00Z\t20\t101\t100\t100\t100.2\t20\t30')).toThrow('Invalid quote')
  })
})

describe('causal signal specifications', () => {
  test('fits with a demeaned market return, clamps large and negative exposures and withholds insufficient fits', () => {
    const fit = (slope: number) => estimateBeta(Array.from({ length: 14 }, (_, i) => [i, 17 + slope * i] as const))
    expect(fit(2.2)).toBeCloseTo(2.2, 10)
    expect(fit(9)).toBe(3)
    expect(fit(-1)).toBe(0.5)
    expect(
      estimateBeta([
        [1, 1],
        [2, 2],
      ]),
    ).toBeUndefined()
  })

  test('never uses the current full day in beta/ATR or a later minute in current VWAP', () => {
    const makeSession = (index: number, shock: number): Session => {
      const date = new Date(Date.UTC(2026, 6, index + 1)).toISOString().slice(0, 10)
      const marketClose = 100 + (index % 5)
      const tape = (close: number, midday: number): Tape => ({
        bars: new Map(
          Array.from({ length: 210 }, (_, minute) => [
            minute,
            bar(100, minute === 209 ? close : minute === 120 ? midday : minute === 121 ? shock : 100),
          ]),
        ),
        quotes: new Map(),
      })
      const tapes = new Map([
        ['SPY', tape(marketClose, 100)],
        ['AMD', tape(100 + 1.5 * (marketClose - 100) + (index === 20 ? shock : 0), 101)],
      ])
      return { date, tapes, minutes: 210, daily: dailySummaries(date, tapes) }
    }
    const fit = (shock: number) =>
      prepareSignalHistory(Array.from({ length: 21 }, (_, index) => makeSession(index, index === 20 ? shock : 100))).at(
        -1,
      )?.checkpoints[0]?.rows[0]
    const base = fit(100)
    expect(base?.beta20).toBeCloseTo(1.5, 10)
    expect(base?.vwapDevBps).toBeCloseTo(100)
    expect(base?.atrBps).toBeGreaterThan(0)
    expect(fit(900)).toEqual(base)
  })

  test('beta residual reverses the high-beta trend-day distortion, ATR changes ranking, and median recenters', () => {
    const point = {
      minute: 120,
      benchmarkDevBps: 40,
      rows: [row('AMD', 90, 3, 400), row('NVDA', 64, 2, 50), row('AAPL', 68), row('MSFT', 60)],
    }
    const choose = (signal: 'v2' | 'beta20' | 'beta-z' | 'median') =>
      selectMiddayBasket({
        point,
        signal,
        omitted: undefined,
        requireBeta: true,
        allowSingle: true,
        gateBps: null,
        priorDispersion: null,
      }).groups[0]
    expect(choose('v2')?.map(({ row: picked, direction }) => [picked.symbol, direction])).toEqual([['AMD', -1]])
    expect(choose('beta20')?.[0]?.row.symbol).toBe('AMD')
    expect(choose('beta-z')?.[0]?.row.symbol).toBe('NVDA')
    expect(choose('median')?.[0]?.row.symbol).toBe('NVDA')
  })

  test('re-pairs within clusters after omission, rejects flat dispersion and scales eligible gross causally', () => {
    const point = {
      minute: 120,
      benchmarkDevBps: 0,
      rows: [row('AMD', -100), row('NVDA', 5), row('AAPL', -5), row('MSFT', 100), row('WDC', -40)],
    }
    const common = { point, requireBeta: true, allowSingle: false, gateBps: null, priorDispersion: null }
    const semi = selectMiddayBasket({ ...common, signal: 'semi', omitted: 'AMD' })
    expect(semi.groups.map((group) => group.map(({ row: picked }) => picked.symbol))).toEqual([
      ['AAPL', 'MSFT'],
      ['WDC', 'NVDA'],
    ])
    expect(
      selectMiddayBasket({ ...common, signal: 'dispersion', gateBps: 80, priorDispersion: 60, omitted: 'AMD' }).groups,
    ).toEqual([])
    const disperse = selectMiddayBasket({
      ...common,
      signal: 'dispersion',
      gateBps: 40,
      priorDispersion: 60,
      omitted: undefined,
    })
    expect(disperse.groups.length).toBe(2)
    expect(disperse.grossScale).toBeCloseTo(45 / 120)
  })
})

describe('spread-aware execution and orphan protection', () => {
  const long: RankedLeg = { row: row('AMD', -100, 2), direction: 1 }
  const short: RankedLeg = { row: row('AAPL', 100, 1), direction: -1 }
  const selection: Selection = { groups: [[long, short]], grossScale: 1 }
  const scenario = (shortOpenAtRescue: number, includesFlatten = true): Session => ({
    date: '2026-11-27',
    minutes: 210,
    daily: [],
    tapes: new Map([
      [
        'AMD',
        {
          bars: new Map([
            [120, bar(50)],
            [121, bar(100.05)],
            ...(includesFlatten
              ? [[122, bar(99.8)] as const, [123, bar(99.7)] as const, [206, bar(101)] as const]
              : []),
          ]),
          quotes: new Map(),
        },
      ],
      [
        'AAPL',
        {
          bars: new Map([
            [121, bar(99.7)],
            [122, bar(shortOpenAtRescue)],
            [206, bar(99)],
          ]),
          quotes: new Map(),
        },
      ],
    ]),
  })
  const settings = {
    minute: 120,
    selection,
    cost: 5,
    collar: { family: 'fixed', value: 10 },
    sizing: 'beta-dollar',
  } as const

  test('balances target beta dollars at the same gross budget, and defines both adaptive collars', () => {
    expect(targetNotionals([long, short], 'beta-dollar', 1)).toEqual([12_000, 24_000])
    expect(targetNotionals([long, short], 'equal-dollar', 1)).toEqual([18_000, 18_000])
    expect(legCollarBps(long, { family: 'spread', value: 1.5 })).toBe(30)
    expect(legCollarBps(long, { family: 'atr', value: 0.15 })).toBe(30)
    expect(
      legCollarBps({ ...long, row: { ...long.row, completedQuote: undefined } }, { family: 'spread', value: 1.5 }),
    ).toBeUndefined()
  })

  test('real quote uses executable side and its midpoint; there is no fallback to OHLC', () => {
    const tape: Tape = { bars: new Map([[122, bar(97)]]), quotes: new Map([[121, quote(99.9, 100.1)]]) }
    expect(executionPrice(tape, 121, 1, 'IEX')).toEqual({ minute: 121, reference: 100, price: 100.1 * 1.0001 })
    expect(executionPrice(tape, 121, -1, 'IEX')?.price).toBeCloseTo(99.9 * 0.9999, 10)
    expect(executionPrice(tape, 122, 1, 'IEX')).toBeUndefined()
  })

  test('gives no t fill and preserves transient and retained drift under an independent limit', () => {
    const result = executeBasket({ ...settings, session: scenario(99.85), protection: 'independent' })
    expect(result.filled).toBe(1)
    expect(result.oneSided).toBe(true)
    expect(result.initialResidualUsd).toBeCloseTo(119 * 100.05 * 1.00025, 5)
    expect(result.residualUsd).toBe(result.initialResidualUsd)
    expect(result.peakPairOrphanBetaUsd).toBeCloseTo(2 * result.residualUsd)
  })

  test('flattens an orphan at the next price rather than deleting the loss', () => {
    const result = executeBasket({ ...settings, session: scenario(99.85), protection: 'flatten' })
    expect(result.flattenCount).toBe(1)
    expect(result.oneSided).toBe(false)
    expect(result.orphanUsd).toBe(0)
    expect(result.residualUsd).toBe(0)
    expect(result.netUsd).toBeLessThan(0)
    expect(result.executionCostUsd).toBeGreaterThan(0)
  })

  test('widens only the missing leg; a failed rescue waits one minute before flattening', () => {
    const rescued = executeBasket({ ...settings, session: scenario(99.85), protection: 'requote' })
    expect(rescued.initialFilled).toBe(1)
    expect(rescued.rescueCount).toBe(1)
    expect(rescued.filled).toBe(2)
    expect(rescued.orphanUsd).toBe(0)
    expect(rescued.betaResidualUsd).toBeLessThan(200)
    expect(rescued.residualUsd).toBeGreaterThan(10_000)
    const failed = executeBasket({ ...settings, session: scenario(99.7), protection: 'requote' })
    const flatten = executeBasket({ ...settings, session: scenario(99.7), protection: 'flatten' })
    expect(failed.rescueCount).toBe(0)
    expect(failed.flattenCount).toBe(1)
    expect(failed.netUsd).toBeLessThan(flatten.netUsd ?? 0)
  })

  test('retains exposure and marks unavailable orphan exits unresolved', () => {
    const result = executeBasket({ ...settings, session: scenario(99.7, false), protection: 'flatten' })
    expect(result.unresolvedOrphans).toBe(1)
    expect(result.orphanUsd).toBeGreaterThan(0)
    expect(result.netUsd).toBeNull()
  })

  test('requires both completed quotes for paired IEX placement and enforces the executable limit', () => {
    const session: Session = {
      ...scenario(99.85),
      tapes: new Map([
        [
          'AMD',
          {
            bars: new Map(),
            quotes: new Map([
              [121, quote(100, 100.1)],
              [206, quote(103, 103.1)],
            ]),
          },
        ],
        [
          'AAPL',
          {
            bars: new Map(),
            quotes: new Map([
              [121, quote(100, 100.1)],
              [122, quote(99, 99.1)],
            ]),
          },
        ],
      ]),
    }
    const result = executeBasket({ ...settings, session, cost: 'IEX', protection: 'flatten' })
    expect(result.initialFilled).toBe(1) // Ask exactly equals the limit before the adverse allowance.
    expect(result.flattenCount).toBe(1)
    const missingPrior = executeBasket({
      ...settings,
      session,
      cost: 'IEX',
      protection: 'flatten',
      selection: { ...selection, groups: [[{ ...long, row: { ...long.row, completedQuote: undefined } }, short]] },
    })
    expect(missingPrior.entriesUnavailable).toBe(2)
    expect(missingPrior.filled).toBe(0)
  })

  test('activates a stop touched in the entry bucket without filling in that bucket', () => {
    const amd = {
      quotes: new Map(),
      bars: new Map([
        [121, { ...bar(100), low: 94 }],
        [122, bar(96)],
        [206, bar(101)],
      ]),
    }
    const base = scenario(99.85)
    const session = { ...base, tapes: new Map(base.tapes).set('AMD', amd) }
    const result = executeBasket({ ...settings, session, protection: 'independent' })
    expect(result.netUsd).toBeCloseTo(119 * (96 * 0.99975 * (1 - 0.21 / 10_000) - 100 * 1.00025), 8)
  })

  test('protection stays active during rescue and flattens the newly orphaned rescue leg', () => {
    const amd = {
      quotes: new Map(),
      bars: new Map([
        [121, { ...bar(100), low: 94 }],
        [122, bar(96)],
        [206, bar(101)],
      ]),
    }
    const aapl = {
      quotes: new Map(),
      bars: new Map([
        [121, bar(99.7)],
        [122, bar(99.85)],
        [123, bar(101)],
        [206, bar(99)],
      ]),
    }
    const session = {
      ...scenario(99.85),
      tapes: new Map([
        ['AMD', amd],
        ['AAPL', aapl],
      ]),
    }
    const result = executeBasket({ ...settings, session, protection: 'requote' })
    expect(result.rescueCount).toBe(1)
    expect(result.flattenCount).toBe(1)
    expect(result.residualUsd).toBe(0)
    expect(result.orphanUsd).toBe(0)
    const longPnl = 119 * (96 * 0.99975 * (1 - 0.21 / 10_000) - 100 * 1.00025)
    const shortPnl = 240 * (99.85 * 0.99975 * (1 - 0.21 / 10_000) - 101 * 1.00025)
    expect(result.netUsd).toBeCloseTo(longPnl + shortPnl, 8)
  })

  test('uses first price strictly after an early-close deadline and never fills a stop from a prior touch', () => {
    const base = scenario(99.85)
    const session: Session = {
      ...base,
      tapes: new Map([
        [
          'AMD',
          {
            quotes: new Map(),
            bars: new Map([
              [121, bar(100)],
              [130, bar(100, 92)],
              [131, bar(92)],
              [205, bar(92)],
              [206, bar(99)],
            ]),
          },
        ],
      ]),
    }
    const result = executeBasket({ ...settings, session, protection: 'independent' })
    expect(result.netUsd).toBeCloseTo(119 * (99 * 0.99975 * (1 - 0.21 / 10_000) - 100 * 1.00025), 8)
  })
})

describe('complete trial ledger and performance diagnostics', () => {
  test('retains every predeclared configuration once', () => {
    const grid = trialGrid()
    expect(grid.length).toBe(47)
    expect(new Set(grid.map((trial) => JSON.stringify(trial))).size).toBe(grid.length)
  })

  test('keeps no-trade dates, removes exactly five highest days, and withholds unavailable period economics', () => {
    const outcomes = Array.from({ length: 66 }, (_, i) => (i < 5 ? 100 : 1))
    expect(sessionEconomics(outcomes)).toMatchObject({ netUsd: 561, exTop5Usd: 61, foldNetUsd: [517, 22, 22] })
    expect(sessionEconomics([null, ...outcomes.slice(1)])).toMatchObject({
      netUsd: null,
      exTop5Usd: null,
      foldNetUsd: [null, 22, 22],
      bootstrapPValue: null,
    })
  })

  test('bootstrap is seeded and one-sided; deflation penalizes an elevated trial benchmark', () => {
    const positive = [9, 10, 11, 12, 10, 9, 12, 10, 11, 10, 9]
    expect(bootstrapPValue(positive)).toBe(1 / 10_001)
    expect(bootstrapPValue(positive.map((value) => -value))).toBe(1)
    const distribution = [-0.4, -0.2, 0, 0.1, 0.3]
    expect(expectedMaximumSharpe(distribution)).toBeCloseTo(0.318, 2)
    const variable = [-2, 3, 1, -2, 4, -1, 2]
    expect(deflatedSharpe(variable, 0)).toBeGreaterThan(deflatedSharpe(variable, 0.4) ?? 1)
    expect(deflatedSharpe([0, 0, 0], 0)).toBeNull()
  })
})
