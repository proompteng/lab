import { describe, expect, test } from 'bun:test'

import { parseDailyBars } from './multi-asset-risk-premia-data'
import { etfs, indexOf, neighbors, trials } from './multi-asset-risk-premia-protocol'
import type { Trial } from './multi-asset-risk-premia-protocol'
import { blend, investedReturn, netReturn, replay } from './multi-asset-risk-premia-replay'
import { calendar, flat, makeFeatures, rsi2, signalBook } from './multi-asset-risk-premia-signals'
import type { Session } from './multi-asset-risk-premia-signals'
import { summarize } from './multi-asset-risk-premia-statistics'
import { stageFromArgs, verifyFreeze } from './research-10yr-multi-asset-risk-premia'

const bar = (open: number, close = open) => ({ open, high: Math.max(open, close), low: Math.min(open, close), close })
const session = (date: string, spy = 100, shy = 100): Session => ({
  date,
  bars: etfs.map((symbol) => bar(symbol === 'SPY' ? spy : symbol === 'SHY' ? shy : 100)),
})
const position = (value: number, symbol = indexOf('SPY')) => {
  const result = flat()
  result[symbol] = value
  return result
}

describe('Wave 3C execution', () => {
  test('uses only the previous target, drifts shares, and charges both open fills', () => {
    const sessions = [
      session('2024-01-02', 100),
      session('2024-01-03', 200),
      session('2024-01-04', 220),
      session('2024-01-05', 242),
    ]
    const w = position(0.5)
    const rows = replay(sessions, [w, w, flat(), w], 0, 3)
    expect(rows[0].pnl).toBe(0) // The large same-day gap cannot be captured.
    expect(rows[1].gross).toBeCloseTo(0.5)
    expect(rows[1].pnl).toBeCloseTo(0.05)
    expect(rows[2].slippageNotional).toBe(0)
    expect(rows[2].pnl).toBeCloseTo(0.055)
    expect(rows[3].sellNotional).toBeCloseTo(0.605)
    expect(rows[3].pnl).toBe(0)
    expect(netReturn(rows[1], 10)).toBeCloseTo(0.05 - 0.5 * 0.0005, 12)
    expect(netReturn(rows[3], 20)).toBeCloseTo(-0.605 * 0.001021, 12)
  })

  test('charges short borrow over the weekend without crediting short collateral', () => {
    const sessions = [session('2024-02-01'), session('2024-02-02', 100, 110), session('2024-02-05', 95, 121)]
    const rows = replay(sessions, [position(-1), flat(), flat()], 1, 2)
    expect(rows[0].pnl).toBeCloseTo(0.05)
    expect(rows[0].shortCarry).toBeCloseTo((0.015 * 3) / 365, 12)
    expect(rows[0].sellNotional).toBe(1)
    expect(rows[1].sellNotional).toBe(0) // Covering a short is a buy.
    expect(investedReturn(rows[0], 10)).toBe(netReturn(rows[0], 10))
  })

  test('keeps idle SHY in a separate ledger and expenses it at liquidation', () => {
    const sessions = [session('2024-01-02'), session('2024-01-03', 100, 102)]
    const rows = replay(sessions, [], 0, 1)
    expect(netReturn(rows[0], 10)).toBe(0)
    expect(investedReturn(rows[0], 10)).toBeCloseTo(0.02 - 0.0005, 12)
    expect(investedReturn(rows[1], 10)).toBeCloseTo(-1.02 * 0.000521, 12)
  })

  test('reapplies the gross cap when shares drift above it', () => {
    const sessions = [session('2024-01-02'), session('2024-01-03'), session('2024-01-04', 125), session('2024-01-05')]
    const rows = replay(
      sessions,
      sessions.map(() => position(2)),
      0,
      3,
    )
    expect(rows[1].gross).toBeCloseTo(1.8)
    expect(rows[2].capTrim).toBe(true)
    expect(rows[2].gross).toBeCloseTo(1.8)
    expect(rows[2].slippageNotional).toBeCloseTo(0.45)
  })

  test('fails instead of pricing an entry without an execution bar', () => {
    const start = session('2024-01-02')
    const end = session('2024-01-03')
    const bars = [...end.bars]
    bars[indexOf('QQQ')] = undefined
    expect(() => replay([start, { ...end, bars }, session('2024-01-04')], [position(1, indexOf('QQQ'))], 1, 2)).toThrow(
      'Missing execution open for QQQ on 2024-01-03',
    )
  })
})

describe('Wave 3C locked trial inputs', () => {
  test('does not decode Holdout prices during development, but rejects malformed execution data there at score', () => {
    const day = '2023-12-29'
    const valid = etfs.map((symbol) => `${symbol}\t${day}T05:00:00Z\t100\t101\t99\t100\t1000\t100\n`).join('')
    const raw = new TextEncoder().encode(`${valid}SPY\t2024-01-02T05:00:00Z\tunknown\n`)
    expect(parseDailyBars(raw, day, 28)).toEqual([
      {
        date: day,
        bars: etfs.map(() => ({ open: 100, high: 101, low: 99, close: 100 })),
      },
    ])
    expect(() => parseDailyBars(raw, '2024-01-02', 28)).toThrow('Invalid daily bar SPY')
  })

  test('accepts only a single stage and rejects uncommitted or irreproducible freezes', () => {
    expect(stageFromArgs(['--freeze'])).toBe('freeze')
    expect(stageFromArgs(['--score'])).toBe('score')
    expect(() => stageFromArgs(['--freeze', '--score'])).toThrow('Usage')
    expect(() => verifyFreeze('modified', 'committed', 'committed')).toThrow('match a committed')
    expect(() => verifyFreeze('committed', 'committed', 'replayed')).toThrow('does not reproduce')
    expect(() => verifyFreeze('committed', 'committed', 'committed')).not.toThrow()
  })

  test('enumerates direct grid neighbors only', () => {
    const all = [...trials()]
    expect(all).toHaveLength(102)
    const center: Trial = { kind: 'trend', direction: 'long', horizon: 60, vol: 0.12 }
    const expected: Trial[] = [
      { ...center, direction: 'signed' },
      { ...center, horizon: 20 },
      { ...center, horizon: 120 },
      { ...center, vol: 0.1 },
      { ...center, vol: 0.15 },
    ]
    expect(neighbors(center, all)).toHaveLength(expected.length)
    expect(neighbors(center, all)).toEqual(expect.arrayContaining(expected))
  })

  test('counts scheduled month-end offsets correctly with missing future prices', () => {
    const october = '2026-10-30'
    expect(calendar([october, '2026-11-25', '2026-11-27', '2026-11-30'])).toEqual([
      { fromStart: 1, toEnd: 0, monthBase: -1 },
      { fromStart: 1, toEnd: -2, monthBase: 0 },
      { fromStart: 2, toEnd: -1, monthBase: 0 },
      { fromStart: 3, toEnd: 0, monthBase: 0 },
    ])
  })

  test('computes Wilder RSI(2) and resets across unavailable history', () => {
    const rsi = rsi2([NaN, 1, -1, -1, 3, NaN, 0, 0])
    expect(rsi[2]).toBe(50)
    expect(rsi[3]).toBe(25)
    expect(rsi[4]).toBeCloseTo(81.25)
    expect(rsi[5]).toBeNaN()
    expect(rsi[7]).toBe(50)
  })

  test('never uses future opens or closes for a sleeve decision or inverse-risk blend', () => {
    const history: Session[] = Array.from({ length: 250 }, (_, i) => {
      const date = new Date(Date.UTC(2016, 0, i + 1)).toISOString().slice(0, 10)
      return { date, bars: etfs.map((_, j) => bar(100 + i * 0.07 + Math.sin(i + j), 100 + i * 0.07 + Math.cos(i + j))) }
    })
    const altered = history.map((s, i) => (i <= 225 ? s : { ...s, bars: etfs.map(() => bar(1)) }))
    const grid = [...trials()]
    const makeBooks = (sessions: Session[]) => {
      const f = makeFeatures(sessions, [])
      return grid.map((trial) => signalBook(f, trial))
    }
    const normal = makeBooks(history)
    const changed = makeBooks(altered)
    expect(normal.some((book) => book[225].some((weight) => weight !== 0))).toBe(true)
    for (const [i, book] of normal.entries()) expect(book.slice(0, 226)).toEqual(changed[i].slice(0, 226))
    expect(blend(normal.slice(0, 5), history).slice(0, 226)).toEqual(blend(changed.slice(0, 5), altered).slice(0, 226))
  })

  test('pension rotates into the laggard and has no trade when a required leg is withheld', () => {
    const dates = ['2024-01-31', '2024-02-01', '2024-02-02', '2024-02-05', '2024-02-06', '2024-02-07']
    const f = makeFeatures(
      dates.map((date, i) => session(date, 100 + 2 * i)),
      [],
    )
    const trial: Trial = { kind: 'pension', signal: -3, threshold: 0.02, direction: 'spread' }
    expect(signalBook(f, trial)[2][indexOf('SPY')]).toBe(-0.5)
    expect(signalBook(f, trial)[2][indexOf('TLT')]).toBe(0.5)
    expect(signalBook(f, trial)[5]).toEqual(flat())
    expect(signalBook(f, trial, 'TLT')).toEqual(dates.map(flat))
  })

  test('reports zero-cash Ex-Top days and deterministic inference separately from idle SHY', () => {
    const sessions = Array.from({ length: 16 }, (_, i) =>
      session(`2024-01-${String(i + 1).padStart(2, '0')}`, 100 + i, 100 + i),
    )
    const replayed = replay(
      sessions,
      sessions.map(() => position(0.5)),
      1,
      15,
    )
    const metrics = summarize(replayed, 10, 0.02)
    expect(metrics.net).toBeGreaterThan(metrics.exTop5Net ?? Infinity)
    expect(metrics.exTop5Net).toBeGreaterThan(metrics.exTop10Net ?? Infinity)
    expect(metrics.investedIdleShyTotalReturn).toBeGreaterThan(metrics.excessReturn)
    expect(metrics.blockP).toBeLessThan(0.05)
    expect(metrics.deflatedSharpe).toBeGreaterThan(0)
    expect(summarize(replayed, 10, 0.02)).toEqual(metrics)
  })
})
