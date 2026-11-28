import { gzipSync } from 'node:zlib'
import { describe, expect, test } from 'bun:test'

import { stationaryPlan } from './8yr-unseen-intraday-statistics'
import { sum } from './midday-research-statistics'
import { splits } from './noise-area-study-replay'
import { blend, metrics, pairedSharpe, underwater } from './orthogonal-pillar3-metrics'
import {
  assets,
  commodities,
  grid,
  model,
  replay,
  sectorTarget,
  sectors,
  universe,
  type Symbol,
} from './orthogonal-pillar3-replay'
import { attachTip, verifyTip } from './orthogonal-pillar3-tip'
import { freezeDevelopment, qualifies, representative, scoreAfterFreeze } from './research-10yr-orthogonal-pillar3'
import { hash, type Session } from './vol-regime-carry-data'

const date = (i: number) => new Date(Date.UTC(2022, 0, i + 1)).toISOString().slice(0, 10)
const day = (stamp: string, marks: Partial<Record<Symbol, readonly [number, number]>> = {}): Session => ({
  date: stamp,
  bars: universe.map((symbol) => {
    const [open, close] = marks[symbol] ?? [100, 100]
    return { open, close }
  }),
})
const weights = (bySymbol: Partial<Record<Symbol, number>>) => universe.map((ticker) => bySymbol[ticker] ?? 0)

describe('registered trades', () => {
  const sessions = Array.from({ length: 400 }, (_, i) =>
    day(date(i), {
      TLT: [100, 100 + i],
      TIP: [100, 100 + i],
      HYG: [100, 100 + i],
      GLD: [100, 100 + i],
      SLV: [100, 100 - i / 6],
      USO: [100, 100 - i / 6],
    }),
  )
  test('caps the grid and keeps A/B non-equity; negative trends are short only in B long/short', () => {
    expect(grid.filter(({ family }) => family === 'A')).toHaveLength(16)
    expect(grid.filter(({ family }) => family === 'B')).toHaveLength(4)
    expect(grid.filter(({ family }) => family === 'C')).toHaveLength(12)
    expect(new Set(grid.map(({ id }) => id)).size).toBe(32)
    const orders = model(sessions)
    for (const trial of grid) {
      const target = orders(trial)[377]
      if (target === undefined) throw new Error('Fixture must be a scheduled review')
      const held = universe.filter((_, i) => target[i] !== 0)
      if (trial.family === 'A') {
        expect(target[assets.SHY]).toBeGreaterThanOrEqual(0.2)
        expect(held.every((ticker) => ['SHY', 'IEF', 'TLT', 'TIP', 'LQD', 'HYG'].includes(ticker))).toBe(true)
      } else if (trial.family === 'B') {
        expect(held.every((ticker) => ticker === 'SHY' || commodities.some((commodity) => commodity === ticker))).toBe(
          true,
        )
        expect(target[assets.GLD]).toBeGreaterThan(0)
        if (trial.mode === 'long-short') expect(target[assets.SLV]).toBeLessThan(0)
        else expect(target[assets.SLV]).toBe(0)
        expect(sum(target.map(Math.abs))).toBeCloseTo(1, 12)
      }
    }
  })

  test('signals and booked returns before the cutoff are invariant to future data', () => {
    const dev = sessions.slice(0, 300)
    const changed = [
      ...dev,
      ...sessions.slice(300).map(({ date: stamp }) => day(stamp, { TLT: [500, 600], GLD: [30, 25] })),
    ]
    for (const trial of grid) {
      const early = model(dev)(trial)
      const full = model(changed)(trial)
      expect(full.slice(0, dev.length)).toEqual(early)
      expect(replay(changed, full, 10, 0.01).slice(0, dev.length)).toEqual(replay(dev, early, 10, 0.01))
    }
  })

  test('only ranks sectors with contiguous history and distinguishes reversal', () => {
    const tape = Array.from({ length: 168 }, (_, i) => {
      const drift = 0.0004 * i
      const market = 0.014 * Math.sin(i)
      const session = day(date(i), { SPY: [100, 100 * Math.exp(drift + market)] })
      sectors.forEach((sector, j) => {
        if ((sector === 'XLC' && i < 100) || (sector === 'XLRE' && i === 130)) {
          session.bars[assets[sector]] = undefined
        } else {
          const rate = j < 5 ? j : j - 5
          const price = 100 * Math.exp(0.08 * (j - 5) * drift + (0.65 + 0.1 * rate) * market)
          session.bars[assets[sector]] = { open: price, close: price }
        }
      })
      return session
    })
    const momentum = model(tape)({ family: 'C', signal: 63, cadence: 21, id: 'momentum', names: 3 })[167]
    const reversal = model(tape)({ family: 'C', signal: -21, cadence: 21, id: 'reversal', names: 3 })[167]
    if (momentum === undefined || reversal === undefined) throw new Error('Fixture must be a scheduled review')
    for (const target of [momentum, reversal]) {
      expect(target[assets.XLC]).toBe(0)
      expect(target[assets.XLRE]).toBe(0)
      expect(target.filter((value) => value < 0)).toHaveLength(3)
    }
    expect(momentum).not.toEqual(reversal)
  })
})

test('sector targets keep both dollar and beta neutrality or remain in collateral', () => {
  const ranked = [
    { symbol: 'XLK', score: 4, beta: 0.4 },
    { symbol: 'XLF', score: 3, beta: 1.6 },
    { symbol: 'XLE', score: 2, beta: 1.0 },
    { symbol: 'XLV', score: 1, beta: 1.8 },
  ] as const
  const target = sectorTarget(ranked, 2)
  const signed = ranked.map(({ symbol }) => target[assets[symbol]])
  expect(signed.filter((value) => value > 0)).toHaveLength(2)
  expect(signed.filter((value) => value < 0)).toHaveLength(2)
  expect(sum(signed)).toBeCloseTo(0, 12)
  expect(sum(signed.map((value, i) => value * ranked[i].beta))).toBeCloseTo(0, 12)
  expect(target[assets.SHY]).toBe(1)
  expect(
    sectorTarget(
      ranked.map((name, i) => ({ ...name, beta: i })),
      2,
    ),
  ).toEqual(weights({ SHY: 1 }))
})

test('replay uses next open, charges both trade sides and does not fill inside the deadband', () => {
  const tape = [day('2022-01-03'), day('2022-01-04', { TLT: [200, 300] }), day('2022-01-05', { TLT: [300, 330] })]
  const result = replay(tape, [weights({ TLT: 1 }), weights({ TLT: 0.91, SHY: 0.09 })], 10, 0.01)
  expect(result[0].net).toBeCloseTo(1 / 1.001 - 1, 12)
  expect(result[1].net).toBeCloseTo((1.5 * (1 - 0.001 - 0.000021)) / 1.001 - 1, 12)
  expect(result[2].net).toBeCloseTo(0.1, 12)
  expect(result[2].turnover).toBe(0)
  const missing = tape.map((session) => ({ ...session, bars: [...session.bars] }))
  missing[2].bars[assets.TLT] = undefined
  expect(() => replay(missing, [weights({ TLT: 1 })], 10, 0.01)).toThrow('Missing open mark for TLT')
})

test('borrow charges both the session and carried calendar days and halves with the rate', () => {
  const tape = [day('2022-01-06'), day('2022-01-07'), day('2022-01-10')]
  const orders = [weights({ SHY: 1, XLK: 0.5, XLF: -0.5 })]
  const high = replay(tape, orders, 2, 0.01)
  const low = replay(tape, orders, 2, 0.005)
  expect(high[0].borrow).toBe(0)
  expect(high[1].borrow).toBeCloseTo(2 * low[1].borrow, 12)
  expect(high[2].borrow / high[1].borrow).toBeCloseTo(3, 2)
  expect(high[2].net).toBeLessThan(low[2].net)
})

test('portfolio capital-reset cost uses prior-close drift, not same-day return', () => {
  const ledger = (values: number[]) => values.map((net) => ({ net, turnover: 0, borrow: 0 }))
  const path = blend([ledger([0.2, 0]), ledger([0, 0])], [0.5, 0.5], 10)
  expect(path[0].net).toBeCloseTo(0.1, 12)
  expect(path[0].turnover).toBe(0)
  expect(path[1].turnover).toBeCloseTo(0.5 - 1 / 2.2, 12)
  expect(path[1].net).toBeCloseTo(-2 * path[1].turnover * 0.001, 12)
})

test('bootstrap pairs the exact same draws and labels all SPY underwater sessions', () => {
  const control = Array.from({ length: 60 }, (_, i) => Math.sin(i))
  const plan = stationaryPlan(control.length, 500)
  expect(pairedSharpe(control, control, plan)).toEqual({ sharpeLift: 0, lower95: 0, p: 1 })
  const lift = pairedSharpe(
    control.map((v) => v + 0.2),
    control,
    plan,
  )
  expect(lift?.lower95).toBeGreaterThan(0)
  expect(lift?.p).toBeLessThan(0.05)
  expect(underwater([0.1, -0.2, 0.1, 0.2])).toEqual([false, true, true, false])
})

test('development ranking prefers structural passes and common portfolio allocation gates cannot switch at each cost', () => {
  const row = metrics([{ net: 0.1, turnover: 0, borrow: 0 }], [0], [0])
  const viable = { ...row, excessSharpe: 0.5 }
  const unstable = { ...row, excessSharpe: 2, turnover: 6 }
  expect(
    representative([
      [unstable, unstable],
      [viable, viable],
      [viable, viable],
    ]),
  ).toBe(1)
  const pass = { standalone: true, orthogonal: true, allocations: [true, false] }
  expect(qualifies([pass, pass, pass])).toBe(true)
  expect(qualifies([pass, { ...pass, orthogonal: false }, pass])).toBe(false)
  expect(qualifies([pass, { ...pass, allocations: [false, true] }, pass])).toBe(false)
  expect(qualifies([pass, pass])).toBe(false)
})

test('only reproduced committed content can open Holdout, without an ancestry or branch dependency', async () => {
  const freeze = { id: 'test', finalists: ['A'] }
  const committed = JSON.stringify(freeze, null, 2) + '\n'
  let opened = 0
  const holdout = async () => ++opened
  expect(() => scoreAfterFreeze({ ...freeze, finalists: ['B'] }, committed, committed, holdout)).toThrow(
    'Holdout unopened',
  )
  expect(() => scoreAfterFreeze(freeze, committed, JSON.stringify(freeze), holdout)).toThrow('Holdout unopened')
  expect(opened).toBe(0)
  expect(await scoreAfterFreeze(freeze, committed, committed, holdout)).toBe(1)
})

test('TIP evidence binds the provider, adjustment, hashes, and exact calendar without reading future prices', () => {
  const tape = [
    { date: '2023-12-29', bars: day('2023-12-29').bars.slice(0, assets.TIP) },
    { date: '2024-01-02', bars: day('2024-01-02').bars.slice(0, assets.TIP) },
  ]
  const raw = Buffer.from('TIP\t2023-12-29T05:00:00Z\t100\t102\t98\t101\t80\t101\nTIP\t2024-01-02T05:00:00Z\tbroken\n')
  const gzip = gzipSync(raw)
  const manifest = {
    schema: 'bayn.wave10d.tip.v1',
    symbol: 'TIP',
    feed: 'sip',
    adjustment: 'all',
    timeframe: '1Day',
    first: '2016-01-04',
    last: '2026-11-25',
    sessions: 2741,
    gzipSha256: hash(gzip),
    rawSha256: hash(raw),
  }
  const bytes = Buffer.from(JSON.stringify(manifest))
  const input = verifyTip(bytes, gzip, hash(bytes))
  expect(attachTip(tape.slice(0, 1), input.raw)[0].bars[assets.TIP]).toEqual({ open: 100, close: 101 })
  expect(() => attachTip(tape, input.raw)).toThrow('Invalid TIP daily bar: 2024-01-02')
  expect(() => attachTip([{ ...tape[0], date: '2023-12-28' }], input.raw)).toThrow('TIP daily calendar')
  expect(() => verifyTip(bytes, gzip, 'wrong')).toThrow('TIP manifest SHA-256 mismatch')
  expect(() => verifyTip(bytes, gzipSync(''), hash(bytes))).toThrow('TIP gzip SHA-256 mismatch')
  const unadjusted = Buffer.from(JSON.stringify({ ...manifest, adjustment: 'split' }))
  expect(() => verifyTip(unadjusted, gzip, hash(unadjusted))).toThrow()
})

test('the development freeze binds all 34 trials and the fixed ensemble weights without Holdout', () => {
  const windows = [splits.train, splits.validation]
  const tape = windows.flatMap(({ first, last, count }, fold) => {
    const start = Date.parse(first)
    const end = Date.parse(last)
    return Array.from({ length: count }, (_, i) => {
      const t = fold * splits.train.count + i
      const stamp = new Date(start + ((end - start) * i) / (count - 1)).toISOString().slice(0, 10)
      return {
        date: stamp,
        bars: universe.map((_, j) => {
          const price = 100 * Math.exp((j / 100_000) * t + (0.04 + j / 2000) * Math.sin(t / 30 + j / 3))
          return { open: price, close: price }
        }),
      }
    })
  })
  const tip = {
    schema: 'bayn.wave10d.tip.v1',
    symbol: 'TIP',
    feed: 'sip',
    adjustment: 'all',
    timeframe: '1Day',
    first: '2016-01-04',
    last: '2026-11-25',
    sessions: 2741,
    manifestSha256: '0'.repeat(64),
    gzipSha256: '1'.repeat(64),
    rawSha256: '2'.repeat(64),
  } as const
  const freeze = freezeDevelopment(tape, {}, tip)
  expect(freeze.trials).toHaveLength(34)
  expect(freeze.finalists.map((id) => id[0])).toEqual(['A', 'B', 'C', 'D', 'D'])
  expect(freeze.development.sessions).toBe(2012)
  expect(freeze.identities.tip).toEqual(tip)
  expect(freeze.dsrNull.every((value) => value !== null && Number.isFinite(value))).toBe(true)
  for (const [i, ensemble] of freeze.members.entries()) {
    expect(ensemble.ids).toEqual(freeze.finalists.slice(0, 2 + i))
    expect(sum(ensemble.weights)).toBeCloseTo(1, 12)
  }
  expect(() => freezeDevelopment([...tape, day(splits.holdout.first)], {}, tip)).toThrow(
    'only registered Train and Validation',
  )
  const withoutTip = tape.map((session) => ({ ...session, bars: session.bars.slice(0, assets.TIP) }))
  expect(() => freezeDevelopment(withoutTip, {}, tip)).toThrow('requires exact TIP coverage')
})
