import { expect, test } from 'bun:test'

import type { Bar, Day } from './noise-area-study-replay'
import {
  admitCandidates,
  PullbackEtf,
  type FactorRow,
  type TradingSession,
} from './research-10yr-etf-mean-reversion-data'
import {
  breakevenBp,
  factorResiduals,
  prepareSignals,
  replay,
  thresholds,
  wilderRsi2,
} from './research-10yr-etf-mean-reversion'
import { assets, universe, type Session } from './vol-regime-carry-data'

const dateAt = (t: number) => new Date(Date.UTC(2016, 0, 4 + t)).toISOString().slice(0, 10)
const pullback = [...Array.from({ length: 197 }, (_, t) => 100 + t / 10), 119, 118, 117]
const tape = (
  closes: readonly number[],
  mark: (t: number) => { open: number; close: number } = () => ({ open: 100, close: 100 }),
): TradingSession[] =>
  closes.map((signalClose, t) => ({ date: dateAt(t), quotes: [{ symbol: PullbackEtf.SPY, signalClose, ...mark(t) }] }))

test('Wilder RSI(2) seeds after two changes and smooths, including flat and exact-cutoff cases', () => {
  expect(wilderRsi2([100, 102, 101, 104, 102])).toEqual([null, null, 200 / 3, 800 / 9, 800 / 17])
  expect(wilderRsi2([5, 5, 5, 4, 4])).toEqual([null, null, 50, 0, 0])
  expect(wilderRsi2([10, 11, 2])).toEqual([null, null, 10])
  expect(thresholds).toEqual([10, 15, 20])
})

test('thresholds are strict and a deep pullback cannot bypass the long trend filter', () => {
  const prices = [...Array<number>(195).fill(50), 100, 100, 100, 100, 71.875, 70]
  const prepared = prepareSignals(tape(prices))
  expect(prepared[199].quotes[0]).toMatchObject({ rsi: 10, aboveTrend: true })
  expect(thresholds.map((threshold) => replay(prepared, threshold, 0).openLots.length)).toEqual([0, 1, 1])
  prices[199] = 49
  const belowTrend = prepareSignals(tape(prices))
  expect(belowTrend[199].quotes[0].aboveTrend).toBe(false)
  expect(thresholds.map((threshold) => replay(belowTrend, threshold, 0).openLots.length)).toEqual([0, 0, 0])
})

test('the 200th close places no fill; entry and rebound exit use the next regular open and charge both sides', () => {
  const prepared = prepareSignals(
    tape([...pullback, 124, 124], (t) => {
      if (t === 200) return { open: 100, close: 103 }
      if (t === 201) return { open: 110, close: 200 }
      return { open: 100, close: 100 }
    }),
  )
  const { days, trades, openLots } = replay(prepared, 10, 10)
  expect(days.slice(0, 200).every(({ net, oneWayTurnover }) => net === 0 && oneWayTurnover === 0)).toBe(true)
  expect(trades).toHaveLength(1)
  expect(trades[0]).toMatchObject({
    signalDate: dateAt(199),
    entryDate: dateAt(200),
    exitDate: dateAt(201),
    entryPrice: 100,
    exitPrice: 110,
    holdingSessions: 1,
  })
  expect(openLots).toHaveLength(0)
  const fee = 0.001
  const closeNav = 1.03 / (1 + fee)
  const exitNav = (1.1 * (1 - fee)) / (1 + fee)
  expect(days[200].net).toBeCloseTo(closeNav - 1, 14)
  expect(days[201].net).toBeCloseTo(exitNav / closeNav - 1, 14)
  expect(trades[0].netPnl).toBeCloseTo(exitNav - 1, 14)
  expect(days[200].oneWayTurnover).toBeCloseTo(0.5 / (1 + fee), 14)
  expect(days[201].oneWayTurnover).toBeCloseTo(0.5, 14)
})

test('inverse vol is frozen from completed closes and inactive names leave their weight in cash', () => {
  const series = tape([...pullback, 124, 126]).map((day, t) => ({
    ...day,
    quotes: [
      ...day.quotes,
      { symbol: PullbackEtf.QQQ, signalClose: 100 + t / 10 + (t % 2) / 5, open: 100, close: 100 },
    ],
  }))
  const revisedFuture = series.map((day, t) =>
    t < 200
      ? day
      : {
          ...day,
          quotes: day.quotes.map((quote) => ({ ...quote, signalClose: quote.signalClose * 5 })),
        },
  )
  const prepared = prepareSignals(series)
  const changed = prepareSignals(revisedFuture)
  expect(changed.slice(0, 200)).toEqual(prepared.slice(0, 200))
  const [spy, qqq] = prepared[199].quotes
  expect(spy.weight).toBeGreaterThan(0)
  expect(qqq.weight).toBeGreaterThan(spy.weight)
  expect(spy.weight + qqq.weight).toBeCloseTo(1, 14)
  const normal = replay(prepared, 10, 10)
  const altered = replay(changed, 10, 10)
  expect(altered.days.slice(0, 201)).toEqual(normal.days.slice(0, 201))
  expect(normal.days[200].net).toBeCloseTo(-spy.weight * 0.001, 14)
  expect(normal.days[200].oneWayTurnover).toBeCloseTo(spy.weight / 2, 14)
})

test('a persistent dip exits after five holding sessions, cannot reenter on that open, and is never liquidated at the tape end', () => {
  const prepared = prepareSignals(tape([...pullback, 116, 115, 114, 113, 112, 111, 110]))
  const unfinished = replay(prepared.slice(0, 205), 10, 5)
  expect(unfinished.trades).toHaveLength(0)
  expect(unfinished.openLots.map(({ entryDate }) => entryDate)).toEqual([dateAt(200)])
  const complete = replay(prepared, 10, 5)
  expect(complete.trades).toHaveLength(1)
  expect(complete.trades[0]).toMatchObject({
    entryDate: dateAt(200),
    exitDate: dateAt(205),
    holdingSessions: 5,
    exitReason: 'five-session-limit',
  })
  expect(complete.openLots.map(({ entryDate }) => entryDate)).toEqual([dateAt(206)])
})

const bar = (open: number, close: number): Bar => ({
  open,
  close,
  low: Math.min(open, close),
  high: Math.max(open, close),
  volume: 100,
  vwap: open,
})
const sourceDaily = (date: string): Session => ({ date, bars: universe.map(() => ({ open: 100, close: 103 })) })
const slots = 78
const intraday = (date: string, spy: readonly (Bar | undefined)[], qqq: readonly (Bar | undefined)[]): Day => ({
  date,
  slots,
  bars: new Map([
    ['SPY', spy],
    ['QQQ', qqq],
  ]),
})

test('coverage permits an observed early valuation only within the registered bounds and cannot substitute a missing opening slot', () => {
  const spy = Array.from({ length: slots }, () => bar(90, 95))
  const qqq = Array.from({ length: slots }, (_, i) => (i < slots - 6 ? bar(100, 102) : undefined))
  const outage = '2019-08-12'
  const accepted = admitCandidates([sourceDaily(outage)], [intraday(outage, spy, qqq)])
  expect(accepted.admitted).toEqual([PullbackEtf.SPY, PullbackEtf.QQQ])
  expect(accepted.sessions[0].quotes[1]).toEqual({ symbol: PullbackEtf.QQQ, signalClose: 103, open: 100, close: 102 })
  expect(accepted.coverage[1].earlyMarks).toEqual([{ date: outage, minutesBeforeClose: 30 }])

  const ordinary = '2019-08-13'
  const denied = admitCandidates([sourceDaily(ordinary)], [intraday(ordinary, spy, qqq)])
  expect(denied.admitted).toEqual([PullbackEtf.SPY])
  expect(denied.coverage[1].missing).toEqual([ordinary])
  expect(
    admitCandidates([sourceDaily(outage)], [intraday(outage, spy, [undefined, ...qqq.slice(1)])]).admitted,
  ).toEqual([PullbackEtf.SPY])
  expect(() => admitCandidates([sourceDaily(outage)], [intraday(outage, [undefined, ...spy.slice(1)], qqq)])).toThrow(
    'SPY pricing',
  )
  expect(() => admitCandidates([sourceDaily(outage)], [intraday(ordinary, spy, qqq)])).toThrow(
    'Session alignment mismatch',
  )
  const bad = sourceDaily(outage)
  bad.bars[assets.SPY] = { open: 100, close: Infinity }
  expect(() => admitCandidates([bad], [intraday(outage, spy, qqq)])).toThrow('Malformed price')
})

test('factor residuals freeze development exposures and reject unmatched sessions', () => {
  const controls: FactorRow[] = [
    { SPY: 0, B0: 0, F4: 0, O1: 0 },
    { SPY: 0.01, B0: 0, F4: 0, O1: 0 },
    { SPY: 0, B0: 0.02, F4: 0, O1: 0 },
    { SPY: 0, B0: 0, F4: 0.03, O1: 0 },
    { SPY: 0, B0: 0, F4: 0, O1: 0.04 },
    { SPY: 0.05, B0: 0.04, F4: 0.03, O1: 0.02 },
    { SPY: 0.01, B0: -0.04, F4: -0.03, O1: -0.02 },
  ].map((returns, t) => ({ date: dateAt(t), returns }))
  const returns = controls.map(({ date, returns: { SPY, B0, F4, O1 } }, t) => ({
    date,
    net: (t < 6 ? 0.001 : 0.004) + 0.2 * SPY - 0.5 * B0 + 0.3 * F4 + 0.4 * O1,
    oneWayTurnover: 0,
  }))
  const fit = factorResiduals(returns, controls, 6)
  expect(fit.developmentIntercept).toBeCloseTo(0.001, 14)
  expect(fit.betas['B0']).toBeCloseTo(-0.5, 14)
  expect(fit.residuals[6]).toBeCloseTo(0.004, 14)
  const changedHoldout = returns.map((row, t) => (t === 6 ? { ...row, net: 0.5 } : row))
  expect(factorResiduals(changedHoldout, controls, 6).betas).toEqual(fit.betas)
  expect(() => factorResiduals(returns, controls.slice(1), 6)).toThrow('Session count mismatch')
})

test('breakeven returns only a bracketed nonnegative cost', () => {
  expect(breakevenBp((bp) => 0.02 - bp * 0.001)).toBeCloseTo(20, 5)
  expect(breakevenBp(() => -0.01)).toBeNull()
  expect(breakevenBp(() => 0.01)).toBeNull()
})
