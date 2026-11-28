import { describe, expect, test } from 'bun:test'

import { capital, createReplay, netAt, prepare, type Bar, type Day, type Ledger } from './noise-area-study-replay'
import {
  gates,
  grid,
  MomentumAnchor,
  openAfterFreeze,
  replayMomentum,
  replayPair,
  select,
  targetScale,
  verifyFileHashes,
} from './research-10yr-intraday-voltarget-moc'

const bar = (open: number, close = open): Bar => ({
  open,
  close,
  high: Math.max(open, close),
  low: Math.min(open, close),
  volume: 1,
  vwap: open,
})
const series = (slots = 78) => Array.from<Bar | undefined>({ length: slots }).fill(bar(100))
const day = (i: number, a: (Bar | undefined)[], b = series(a.length)): Day => ({
  date: `session-${i}`,
  slots: a.length,
  bars: new Map([
    ['QQQ', a],
    ['SMH', b],
  ]),
})
const ledger = (base: number, missingHeld = 0): Ledger => ({
  base,
  slope: 0,
  trades: 1,
  unresolved: 0,
  missingEntries: 0,
  missingHeld,
  grossUpperBound: 0,
})

describe('Wave 11B research replay', () => {
  test('registers only the frozen pure ETF grid, with bounded unique variants', () => {
    expect(['A', 'B', 'C'].map((family) => grid.filter((spec) => spec.family === family).length)).toEqual([12, 10, 8])
    expect(new Set(grid.map(({ id }) => id)).size).toBe(30)
    expect(grid.filter((spec) => spec.family === 'C').map(({ pair }) => pair.join('/'))).toEqual([
      'SMH/QQQ',
      'SMH/QQQ',
      'XLK/QQQ',
      'XLK/QQQ',
      'IWM/SPY',
      'IWM/SPY',
      'TLT/IEF',
      'TLT/IEF',
    ])
  })

  test('uses trailing sample volatility and caps only after a complete window', () => {
    const target = { targetAnnVol: 0.1, leverageCap: 2 }
    const prior = Array.from({ length: 14 }, (_, i) => ledger(i % 2 === 0 ? 1_000 : -1_000))
    const expected = 0.1 / (0.01 * Math.sqrt((252 * 14) / 13))
    expect(targetScale(prior, target)).toBeCloseTo(expected, 13)
    expect(targetScale(prior.slice(1), target)).toBe(0)
    expect(targetScale([...prior.slice(1), ledger(2000, 1)], target)).toBe(0)
    expect(
      targetScale(
        prior.map(() => ledger(0)),
        target,
      ),
    ).toBe(2)
    expect(
      targetScale(
        prior.map(({ base }) => ledger(base / 10)),
        { ...target, leverageCap: 1.5 },
      ),
    ).toBe(1.5)
  })

  test('Family A re-sizes whole shares before charging actual entry and exit notional', () => {
    const past = Array.from({ length: 14 }, (_, i) => {
      const bars = series()
      for (let slot = 0; slot < bars.length; slot++) bars[slot] = bar(100, 100.05 + 0.02 * (i % 2))
      return day(i, bars)
    })
    const now = series()
    now[5] = bar(100, 120)
    now[6] = bar(121)
    now[75] = bar(127)
    const prepared = [...prepare([...past, day(14, now)], ['QQQ'])].at(-1)
    if (prepared === undefined) throw new Error('missing fixture')
    const replay = createReplay(prepared)
    const trial = {
      id: 'B0',
      basket: 'B0',
      band: 1.4,
      minutes: 30,
      exit: 'opposite_band',
      sizing: 'inverse_vol_parity',
    } as const
    for (const scale of [1, 1.5, 2]) {
      const row = replay(trial, ['QQQ'], undefined, { budget: capital * scale })
      expect(row.trades).toBe(1)
      const shares = Math.floor((capital * scale) / (121 * 1.0005))
      for (const bp of [2, 5, 10]) {
        const buy = 121 * (1 + bp / 20_000)
        const sell = 127 * (1 - bp / 20_000)
        expect(netAt(row, bp)).toBeCloseTo(shares * (sell * (1 - 0.21 / 10_000) - buy), 8)
      }
    }
  })

  const priorDays = Array.from({ length: 15 }, (_, i) => {
    const a = series()
    const b = series()
    a[5] = bar(100, 100 + (i % 2 === 0 ? 1 : -1))
    a[6] = bar(100, 100 + (i % 2 === 0 ? 1 : -1))
    a[71] = bar(100, 100 + (i % 2 === 0 ? 1 : -1))
    a[77] = bar(100, 100 + (i % 2 === 0 ? 1 : -1))
    b[77] = bar(100, 100 + (i % 2 === 0 ? -1 : 1))
    return day(i, a, b)
  })

  test.each([78, 42])('close momentum uses the completed bar and exits at close minus five (%i bars)', (slots) => {
    const now = series(slots)
    now[slots - 7] = bar(100, 106)
    now[slots - 6] = bar(110, 80) // The execution bar's close must neither select a short nor prevent a long.
    now[slots - 1] = bar(115, 1) // The exit uses only this bar's open.
    const output = replayMomentum([...priorDays, day(15, now)], 15, ['QQQ'], MomentumAnchor.PreviousClose, 1)
    expect(output.trades).toBe(1)
    expect(netAt(output, 5)).toBeGreaterThan(4_000)
    now[slots - 7] = bar(100)
    expect(replayMomentum([...priorDays, day(15, now)], 15, ['QQQ'], MomentumAnchor.Open, 1).trades).toBe(0)
  })

  test('missing momentum exit stays unresolved instead of using the prior close', () => {
    const now = series()
    now[71] = bar(100, 107)
    now[77] = undefined
    const output = replayMomentum([...priorDays, day(15, now)], 15, ['QQQ'], MomentumAnchor.Open, 1)
    expect(output.unresolved).toBe(1)
    expect(netAt(output, 2)).toBeNull()
  })

  test('pairs enter atomically on the next common open and exit only after a completed crossing', () => {
    const a = series()
    const b = series()
    a[5] = bar(100, 110) // QQQ rich at 10:00; short QQQ and buy SMH.
    a[6] = bar(110, 80) // First crossing is observable at 10:05, after entry.
    a[7] = bar(90)
    b[7] = bar(104)
    const pair = ['QQQ', 'SMH'] as const
    const run = () => replayPair([...priorDays, day(15, a, b)], 15, pair, 1.5)
    expect(run().trades).toBe(2)
    expect(netAt(run(), 5)).toBeGreaterThan(10_000)
    expect(netAt(run(), 2)).toBeGreaterThan(netAt(run(), 10) ?? Infinity)
    b[6] = undefined
    expect(run()).toMatchObject({ trades: 0, missingEntries: 1 })
  })

  test('pairs cannot fabricate a final simultaneous exit when the early-close open is missing', () => {
    const a = series(42)
    const b = series(42)
    a[5] = bar(100, 110)
    for (let i = 6; i < 42; i++) a[i] = bar(110)
    b[41] = undefined
    const output = replayPair([...priorDays, day(15, a, b)], 15, ['QQQ', 'SMH'], 1.5)
    expect(output.unresolved).toBe(2)
    expect(netAt(output, 2)).toBeNull()
  })

  test('validation can only nominate a Train finalist and never replaces an ineligible candidate', () => {
    const row = (id: string, train: number, validation: number, safe = true) => ({
      id,
      train: { safe, sharpeDaily: train },
      validation: { safe, sharpeDaily: validation },
    })
    expect(
      select([row('A', 0.4, 0.2), row('B', 0.3, 0.4), row('C', 0.2, 0.3), row('D', 0.1, 0.9), row('E', 9, 9, false)]),
    ).toEqual({
      finalists: ['A', 'B', 'C'],
      selected: 'B',
    })
    expect(select([row('A', 9, 9, false)]).selected).toBeNull()
  })

  test('qualification requires both costs, significance, DSR, and strict correlation for B/C', () => {
    const row = (bp: number) => ({
      bp,
      holdout: { netUsd: 310, exTop10Usd: 110, bootstrapP: 0.0499, dsr: 0.95 },
      comparison: { dailyCorrelation: -0.299, stackSharpeLift: 0.001 },
    })
    const pass = [row(2), row(5)]
    expect(gates(true, true, pass).pass).toBe(true)
    expect(gates(true, true, [row(2)]).pass).toBe(false)
    expect(gates(true, false, pass).pass).toBe(false)
    const other = row(5)
    other.comparison.dailyCorrelation = -0.3
    expect(gates(true, true, [row(2), other]).pass).toBe(false)
    expect(gates(false, true, [row(2), other]).pass).toBe(true)
    other.holdout.bootstrapP = 0.05
    expect(gates(false, true, [row(2), other]).pass).toBe(false)
  })

  test('content fingerprints do not depend on Git history and tampering fails before opening Holdout', async () => {
    const files = { 'protocol.md': 'a'.repeat(64), 'runner.ts': 'b'.repeat(64) }
    const receipt = { schema: 'bayn.research.wave-11b.freeze.v1', files, selection: ['A'] }
    expect(() => verifyFileHashes(receipt, files)).not.toThrow()
    expect(() => verifyFileHashes(receipt, { ...files, 'runner.ts': 'c'.repeat(64) })).toThrow(
      'Freeze SHA-256 mismatch: runner.ts',
    )
    let opened = 0
    const open = () => Promise.resolve(++opened)
    expect(() => openAfterFreeze(receipt, { ...receipt, selection: ['B'] }, open)).toThrow('Holdout unopened')
    expect(opened).toBe(0)
    expect(await openAfterFreeze(receipt, { ...receipt }, open)).toBe(1)
  })
})
