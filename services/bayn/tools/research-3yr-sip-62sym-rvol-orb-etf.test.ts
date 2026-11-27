import { describe, expect, test } from 'bun:test'

import { readTape, slotAt, type TapeDay } from './research-sip-momentum-data'
import {
  comboTrials,
  etfs,
  grossCap,
  neighbors,
  sleeveTrials,
  stocks,
  type Noise,
  type Orb,
} from './research-sip-momentum-protocol'
import { leaveOut, netAt, noiseBands, prepare, replay, simulateFill } from './research-sip-momentum-replay'
import { basic, blockP } from './research-sip-momentum-statistics'
import { requireFreezeMatch } from './research-sip-momentum-study'

const session = (date: string, hour: '13' | '14', minutes = 390) => ({
  date,
  openMs: Date.parse(`${date}T${hour}:30:00Z`),
  minutes,
})

const rows = async function* (lines: readonly string[]) {
  for (const line of lines) yield line
}
const row = (symbol: string, at: string, volume = 100) => `${symbol}\t${at}\t100\t103\t99\t102\t${volume}\t101`

const series = (slots: number, volume = 100) =>
  Float64Array.from(Array.from({ length: slots }, () => [100, 103, 99, 102, volume]).flat())
const at = (bars: Float64Array, slot: number, bar: readonly number[]) => bars.set([...bar, 100], slot * 5)

const orb: Orb = {
  engine: 'orb',
  id: 'test-orb',
  rangeBars: 1,
  rvol: 1.5,
  top: 1,
  filter: 'none',
  stop: 0.1,
  target: 'eod',
}
const noise: Noise = { engine: 'noise', id: 'test-noise', universe: 'pair', checkpoint: 6, band: 1, exit: 'opposite' }

describe('frozen SIP boundaries', () => {
  test('regular slots honor UTC offsets and early closes, and listings reject when-issued rows', async () => {
    const winter = session('2025-02-13', '14')
    const short = session('2025-07-03', '13', 210)
    expect(slotAt(winter, 14 * 60 + 30)).toBe(0)
    expect(slotAt(short, 16 * 60 + 55)).toBe(41)
    const tape = await readTape(
      [winter, short],
      short.date,
      rows([
        row('AAPL', '2025-02-13T13:30:00Z'),
        row('AAPL', '2025-02-13T14:30:00Z', 250),
        row('AAPL', '2025-07-03T16:55:00Z', 500),
        row('AAPL', '2025-07-03T17:00:00Z'),
        row('SNDK', '2025-02-13T14:30:00Z'),
      ]),
    )
    expect(tape.coverage).toMatchObject({ rows: 5, regular: 2, nonRegular: 2, preListing: 1 })
    expect(tape.days[0].bars.get('AAPL')?.[4]).toBe(250)
    expect(tape.days[1].bars.get('AAPL')?.[41 * 5 + 4]).toBe(500)
    expect(tape.days[0].bars.has('SNDK')).toBe(false)
    expect(tape.coverage.bySymbol['AAPL'].missing).toBe(118)
  })

  test('freeze does not decode Holdout; score does, and duplicates fail closed', async () => {
    const cal = [session('2026-03-31', '13'), session('2026-04-01', '13')]
    const dev = row('AAPL', '2026-03-31T13:30:00Z')
    const holdout = row('AAPL', '2026-04-01T13:30:00Z', -99)
    const tape = await readTape(cal, cal[0].date, rows([dev, holdout]))
    expect(tape.days).toHaveLength(1)
    expect(tape.row).toBe(2)
    const invalidHoldout = await readTape(cal, cal[1].date, rows([dev, holdout])).catch((error: unknown) => error)
    expect(invalidHoldout).toHaveProperty('message', expect.stringContaining('Invalid OHLCV'))
    const duplicate = await readTape(cal, cal[0].date, rows([dev, dev])).catch((error: unknown) => error)
    expect(duplicate).toHaveProperty('message', expect.stringContaining('Invalid symbol/time/order/shape'))
    expect(() => requireFreezeMatch({ data: 'a', trial: 'x' }, { data: 'b', trial: 'x' })).toThrow('does not match')
  })
})

const book = (days: number): TapeDay[] =>
  Array.from({ length: days }, (_, i) => ({
    date: `2024-01-${String(i + 2).padStart(2, '0')}`,
    slots: 78,
    bars: new Map([
      ['AAPL', series(78, i === 14 ? 360 : 100)],
      ['NVDA', series(78, i === 14 ? 300 : 100)],
      ['QQQ', series(78)],
      ['SMH', series(78)],
    ]),
  }))

describe('causal replay', () => {
  test('ranks by real opening volume against exactly 14 prior sessions and replaces the omitted winner', () => {
    const days = book(15)
    const today = days[14]
    for (const [symbol, price] of [
      ['AAPL', 105],
      ['NVDA', 110],
    ] as const) {
      const bars = today.bars.get(symbol)
      if (bars === undefined) throw new Error('Missing test tape')
      at(bars, 1, [102, 107, 102, 106]) // breakout completed
      at(bars, 2, [price, price + 1, price - 0.1, price + 0.5])
      for (let i = 3; i < 78; i++) at(bars, i, [price + 1, price + 2, price, price + 1])
    }
    const prepared = prepare(days)
    expect(prepared[13].ranked[1]).toHaveLength(0)
    expect(prepared[14].ranked[1].map(({ symbol, range }) => [symbol, range.rvol])).toEqual([
      ['AAPL', 3.6],
      ['NVDA', 3],
    ])
    const result = replay(prepared, orb, true)[14]
    expect(result.total.trades).toBe(1)
    expect(result.total.entryNotional).toBe(59_430)
    expect(leaveOut(result, 'AAPL').entryNotional).toBe(59_950)
    expect(leaveOut(result, 'NVDA')).toBe(result.total)
    const slippedBuy = 105 * 1.0001
    const slippedSell = 106 * 0.9999
    expect(netAt(result.total, 2)).toBeCloseTo(566 * (slippedSell - slippedBuy - slippedSell * 0.000021), 8)
    expect(netAt(result.total, 2)).toBeGreaterThan(netAt(result.total, 10))
  })

  test('does not bridge a missing prior session or use late-symbol history before it exists', () => {
    const sample = book(15)
    const bars = new Map(sample[7].bars)
    bars.delete('AAPL')
    sample[7] = { ...sample[7], bars }
    const last = prepare(sample).at(-1)
    expect(last?.ranked[1].map(({ symbol }) => symbol)).toEqual(['NVDA'])
  })

  test('uses the next open, stop-first intrabar, and the adverse open on a gap', () => {
    const bars = series(7)
    at(bars, 1, [104, 105, 103.5, 104.5])
    at(bars, 2, [104, 108, 102, 106])
    const entry = { side: 1, signal: 0, stop: { distance: 1 }, targetR: 2 } as const
    expect(simulateFill(bars, 7, entry)).toMatchObject({ entry: 104, exit: 103 })
    at(bars, 2, [101, 108, 100, 106])
    expect(simulateFill(bars, 7, entry)).toMatchObject({ entry: 104, exit: 101 })
    expect(simulateFill(bars, 7, { ...entry, stop: { at: 105 } })).toBeNull()
    at(bars, 1, [104, 104.5, 103.5, 104.2])
    at(bars, 2, [107, 108, 98, 106])
    expect(simulateFill(bars, 7, { ...entry, side: -1 })).toMatchObject({ entry: 104, exit: 107 })
  })

  test('uses scheduled exit at next open, not checkpoint close; timed exit is the last RTH open', () => {
    const bars = series(7)
    at(bars, 3, [108, 109, 107, 107])
    at(bars, 6, [111, 117, 110, 116])
    const entry = { side: 1, signal: 0, stop: null, targetR: null } as const
    expect(simulateFill(bars, 7, { ...entry, exitAt: (i) => i === 2 }, 4)).toMatchObject({ exit: 108 })
    expect(simulateFill(bars, 7, entry, 4)).toMatchObject({ exit: 111 })
    bars[3 * 5] = 0
    expect(simulateFill(bars, 7, entry, 4)).toMatchObject({ exit: null })
    bars[5] = 0
    expect(simulateFill(bars, 7, entry, 4)).toBe('missingEntry')
    expect(simulateFill(bars, 7, { ...entry, signal: 5 }, 4)).toBeNull()
  })

  test('ETF upper/lower bands use the correct gap anchors and combined sleeve caps are shared', () => {
    expect(noiseBands(102, 99, 0.01, 1)).toEqual({ upper: 103.02, lower: 98.01 })
    const days = book(15)
    const bars = days[14].bars.get('QQQ')
    if (bars === undefined) throw new Error('Missing test ETF tape')
    at(bars, 5, [102, 106, 100, 105]) // 30m signal with upper band 104.04
    at(bars, 6, [106, 108, 104, 106])
    at(bars, 11, [102, 103, 95, 96]) // opposite band
    at(bars, 12, [95, 98, 90, 94])
    const prepared = prepare(days)
    const result = replay(prepared, noise, true)[14]
    expect(result.total.trades).toBe(1)
    expect(netAt(result.total, 5)).toBeLessThan(0)
    expect(leaveOut(result, 'QQQ').trades).toBe(0)
    const combined = replay(prepared, comboTrials(orb, noise)[1], true)[14]
    expect(combined.total.entryNotional).toBeLessThan(grossCap)
    expect(combined.total.entryNotional).not.toBe(result.total.entryNotional / 2) // whole shares
  })
})

test('registry covers the full Cartesian design and the plateau is one-axis', () => {
  expect([stocks.length, etfs.length, new Set([...stocks, ...etfs]).size]).toEqual([46, 16, 62])
  expect(sleeveTrials.length).toBe(2052)
  expect(new Set(sleeveTrials.map(({ id }) => id)).size).toBe(2052)
  const center = sleeveTrials.find(({ id }) => id === 'orb5/2.5/k3/none/0.25/5')
  if (center === undefined) throw new Error('Missing design point')
  const ids = neighbors(center).map(({ id }) => id)
  expect(ids).toContain('orb5/2/k3/none/0.25/5')
  expect(ids).toContain('orb5/2.5/k3/spy/0.25/5')
  expect(ids).not.toContain('orb15/2/k3/none/0.25/5')
  expect(ids).not.toContain('orb5/1.5/k3/none/0.25/5')
})

test('bootstraps mean-centered circular blocks and keeps incomplete windows out of promotion metrics', () => {
  const input = Array.from({ length: 23 }, (_, i) => (i % 5) - 1.8)
  // 3,922 upper-tail draws from the direct circular-resampling reference, including its partial final block.
  expect(blockP(input)).toBe(3923 / 10001)
  expect(blockP(Array.from({ length: 25 }, () => 1))).toBe(1 / 10001)
  expect(blockP(Array.from({ length: 25 }, () => 0))).toBe(1)
  expect(blockP(input.slice(0, 9))).toBeNull()
  const cash = { entryNotional: 0, turnoverAfterFee: 0, trades: 0, unresolved: 0, missingEntry: 0 }
  const daily = Array.from({ length: 12 }, (_, i) => ({ ...cash, netBeforeSlippage: i + 1 }))
  expect(basic(daily, 10)).toMatchObject({ net: 78, exTop5: 28, exTop10: 3 })
  expect(basic([...daily, { ...cash, netBeforeSlippage: 5, missingEntry: 1 }], 10)).toMatchObject({
    net: null,
    supportedNet: 83,
    exTop5: null,
    exTop10: null,
  })
})
