import { expect, test } from 'bun:test'

import { baskets, createReplay, prepare, type Bar, type Day } from './noise-area-study-replay'
import { delta, stationaryBootstrap } from './noise-area-study-statistics'
import {
  base,
  baseId,
  grid,
  noDegradation,
  qualifies,
  scoreAfterFreeze,
  select,
  verifyBaseline,
} from './research-10yr-qqq-smh-conditioning'

const bar = (open = 100, close = open, volume = 100, vwap = (open + close) / 2): Bar => ({
  open,
  close,
  volume,
  vwap,
  high: Math.max(open, close),
  low: Math.min(open, close),
})
const series = (slots = 78) => Array.from<Bar | undefined>({ length: slots }).fill(bar())
const day = (date: string, qqq: (Bar | undefined)[], smh = series(qqq.length)): Day => ({
  date,
  slots: qqq.length,
  bars: new Map([
    ['QQQ', qqq],
    ['SMH', smh],
  ]),
})
const priorDay = (i: number, qqqAmplitude: number, smhAmplitude: number, slots = 78) => {
  const qqq = series(slots)
  const smh = series(slots)
  for (let slot = 5; slot < slots - 1; slot += 6) qqq[slot] = smh[slot] = bar(100, 101)
  const sign = i % 2 === 0 ? 1 : -1
  qqq[slots - 1] = bar(100, 100 + sign * qqqAmplitude)
  smh[slots - 1] = bar(100, 100 + sign * smhAmplitude)
  return day(`history-${i}`, qqq, smh)
}
const history = (qqqAmplitude = 1, smhAmplitude = 1) =>
  Array.from({ length: 14 }, (_, i) => priorDay(i, qqqAmplitude, smhAmplitude))
const breakout = (side = 1) => {
  const bars = series()
  bars[5] = bar(100, 100 + side * 4)
  bars[6] = bar(100 + side * 5)
  bars[75] = bar(100 + side * 10)
  return bars
}
const replayDay = (today: Day, previous = history()) => {
  const features = [...prepare([...previous, today], baskets.B0)].at(-1)
  if (features === undefined) throw new Error('Expected a replay day')
  return createReplay(features)
}
const trial = (id: string) => {
  const result = grid.find((entry) => entry.id === id)
  if (result === undefined) throw new Error(`Missing trial: ${id}`)
  return result.conditioning
}
const entryShares = (budget: number, entry = 105, decision = 104) =>
  Math.floor(Math.min(budget / (entry * 1.0005), budget / decision))

test('registers all 27 combinations and the all-none replay is identical to unmodified Wave 6A B0', () => {
  expect(grid).toHaveLength(27)
  expect(new Set(grid.map(({ id }) => id)).size).toBe(27)
  expect(new Set(grid.map(({ conditioning }) => JSON.stringify(conditioning))).size).toBe(27)
  const replay = replayDay(day('today', breakout(), breakout(-1)))
  expect(replay(base, baskets.B0, trial(baseId))).toEqual(replay(base))
  expect(replay(base).trades).toBe(2)
})

test('V1 uses only lagged volatility and leaves the low-volatility allocation idle', () => {
  const previous = history(0.1, 2)
  const qqq = breakout()
  qqq[77] = bar(100, 400)
  const today = day('today', qqq, breakout())
  const replay = replayDay(today, previous)
  const control = replay(base)
  const gate = replay(base, baskets.B0, trial('V1/R0/X0'))
  expect(control.trades).toBe(2)
  expect(gate.trades).toBe(1)
  const calmVol = Math.sqrt(14 / 13) * 0.001
  const activeVol = Math.sqrt(14 / 13) * 0.02
  const shares = entryShares((100_000 * calmVol) / (calmVol + activeVol))
  expect(gate.grossUpperBound).toBeCloseTo(shares * 110 * 1.0005, 7)
  expect(replayDay(today, previous.slice(1))(base, baskets.B0, trial('V1/R0/X0')).trades).toBe(0)
})

test('V2 scales down correlated past returns, respects the cap in calm or hedged history, and rejects incomplete history', () => {
  const today = day('today', breakout(), breakout())
  const high = replayDay(today, history(2, 2))
  const target = trial('V2/R0/X0')
  const annualVol = 0.02 * Math.sqrt((14 * 252) / 13)
  const quantity = entryShares((50_000 * 0.1) / annualVol)
  expect(high(base, baskets.B0, target).grossUpperBound).toBeCloseTo(2 * quantity * 110 * 1.0005, 7)
  expect(high(base, baskets.B0, target).grossUpperBound).toBeLessThan(high(base).grossUpperBound)
  for (const previous of [history(0.1, 0.1), history(2, -2)]) {
    const replay = replayDay(today, previous)
    expect(replay(base, baskets.B0, target)).toEqual(replay(base))
  }
  const incomplete = history()
  incomplete[0] = day('missing-smh-close', series(), series(77))
  const replay = replayDay(today, incomplete)
  expect(replay(base).trades).toBe(1)
  expect(replay(base, baskets.B0, target).trades).toBe(0)
})

test('R1 compares only completed equal-clock prefixes and never repairs a prefix with later volume', () => {
  const qqq = breakout()
  const rvol = trial('V0/R1/X0')
  expect(replayDay(day('today', qqq))(base, baskets.B0, rvol).trades).toBe(1) // exactly 1×
  qqq[0] = bar(100, 100, 99)
  qqq[6] = bar(105, 105, 100_000)
  expect(replayDay(day('today', qqq))(base, baskets.B0, rvol).trades).toBe(0)
  qqq[11] = bar(100, 104)
  qqq[12] = bar(107)
  expect(replayDay(day('today', qqq))(base, baskets.B0, rvol).trades).toBe(1)
  qqq[2] = undefined
  expect(replayDay(day('today', qqq))(base, baskets.B0, rvol).trades).toBe(0)
  expect(replayDay(day('today', qqq))(base).trades).toBe(1)
})

test('R1 skips scheduled early closes for later clocks but not a missing bar on a regular session', () => {
  const qqq = series()
  qqq[65] = bar(100, 104)
  qqq[66] = bar(105)
  const today = day('today', qqq)
  const rvol = trial('V0/R1/X0')
  const previous = [priorDay(0, 1, 1, 42), ...history()]
  expect(replayDay(today, previous)(base, baskets.B0, rvol).trades).toBe(1)
  const missing = series()
  missing[0] = undefined
  missing[65] = bar(100, 101)
  previous[1] = day('missing-prefix', missing)
  expect(replayDay(today, previous)(base, baskets.B0, rvol).trades).toBe(0)
})

test('R2 checks the strict side of completed cumulative VWAP (both signs)', () => {
  for (const sign of [1, -1]) {
    const qqq = breakout(sign)
    const vwap = trial('V0/R2/X0')
    qqq[6] = bar(100 + sign * 5, 100, 100_000)
    expect(replayDay(day('today', qqq))(base, baskets.B0, vwap).trades).toBe(1)
    for (let i = 0; i < 6; i++) qqq[i] = bar(100 + sign * 4)
    // Retain the opening anchor while exactly equaling VWAP through the checkpoint.
    qqq[0] = bar(100, 100 + sign * 4, 100, 100 + sign * 4)
    expect(replayDay(day('today', qqq))(base).trades).toBe(1)
    expect(replayDay(day('today', qqq))(base, baskets.B0, vwap).trades).toBe(0)
  }
})

test('X1 uses prior ATR for both directions and takes the next open, not the stop mark', () => {
  for (const side of [1, -1]) {
    const qqq = breakout(side)
    qqq[7] = bar(100 + side * 5, 100 - side * 8)
    qqq[8] = bar(100 - side * 9)
    const replay = replayDay(day('today', qqq))
    const entry = 100 + side * 5
    const exit = 100 - side * 9
    const shares = entryShares(50_000, entry, 100 + side * 4)
    const sell = side === 1 ? exit : entry
    expect(replay(base, baskets.B0, trial('V0/R0/X1')).base).toBeCloseTo(shares * (-14 - sell * 0.000021), 7)
    expect(replay(base).base).toBeGreaterThan(0)
  }
})

test('X2 does not trigger on the arm bar, then exits a later retest through the next available open', () => {
  for (const side of [1, -1]) {
    const qqq = breakout(side)
    const entry = 100 + side * 5
    const lock = trial('V0/R0/X2')
    qqq[6] = {
      ...bar(entry, entry + side * 5),
      high: side === 1 ? entry + 5 : entry + 0.25,
      low: side === 1 ? entry - 0.25 : entry - 5,
    }
    qqq[7] = bar(entry + side * 2, entry + side)
    qqq[8] = bar(entry + side, entry)
    qqq[9] = undefined
    const exit = entry - side * 0.5
    qqq[10] = bar(exit)
    const result = replayDay(day('today', qqq))(base, baskets.B0, lock)
    const shares = entryShares(50_000, entry, 100 + side * 4)
    expect(result.missingHeld).toBe(1)
    expect(result.base).toBeCloseTo(shares * (-0.5 - (side === 1 ? exit : entry) * 0.000021), 7)
  }
})

const ledger = (baseUsd: number, unresolved = 0) => ({
  base: baseUsd,
  slope: 0,
  trades: 1,
  unresolved,
  missingEntries: 0,
  missingHeld: 0,
  grossUpperBound: 10_000,
})

test('paired differences keep daily alignment and unresolved sessions withhold inference', () => {
  const control = [10, 1_000, -300, 35, 25].map((n) => ledger(n))
  const candidate = control.map((row, i) => ledger(row.base + i + 1))
  const bootstrap = stationaryBootstrap(control.length)
  expect(delta(candidate, control, 5, bootstrap)).toEqual({ netUsd: 15, p: bootstrap([1, 2, 3, 4, 5]) })
  expect(delta(candidate, candidate, 5, bootstrap)).toEqual({ netUsd: 0, p: 1 })
  candidate[2] = ledger(0, 1)
  expect(delta(candidate, control, 5, bootstrap)).toEqual({ netUsd: null, p: null })
  expect(() => verifyBaseline(control, 'train')).toThrow('Wave 6A baseline mismatch')
})

test('selection is train shortlist then validation, with no baseline or unsafe candidate admission', () => {
  const score = (id: string, train: number, validation: number, eligible = true) => ({
    id,
    train: { dailySharpe: train, eligible },
    validation: { dailySharpe: validation, eligible },
  })
  expect(
    select([
      score(baseId, 100, 100),
      score('unsafe', 90, 90, false),
      score('a', 5, 2),
      score('b', 5, 3),
      score('c', 4, 1),
      score('d', 3, 80),
    ]),
  ).toEqual({ finalists: ['a', 'b', 'c'], selected: 'b' })
  expect(select([score(baseId, 100, 100)]).selected).toBeNull()
})

test('published freeze mismatch aborts before invoking the Holdout reader', async () => {
  let reads = 0
  const open = async () => ++reads
  expect(() => scoreAfterFreeze({ selected: 'a' }, '{"selected":"b"}', open)).toThrow('Committed freeze differs')
  expect(reads).toBe(0)
  expect(await scoreAfterFreeze({ selected: 'a' }, '{ "selected": "a" }', open)).toBe(1)
})

test('both costs must independently clear strict paired significance, inclusive DSR and execution safety', () => {
  const pass = { alpha: { dsr: 0.95, netUsd: 150, exTop10Usd: 50 }, paired: { netUsd: 20, p: 0.04999 } }
  const two = { ...pass, bp: 2 as const }
  const five = { ...pass, bp: 5 as const }
  expect(qualifies([two, five], true)).toBeTrue()
  expect(qualifies([two, two], true)).toBeFalse()
  expect(qualifies([two, five], false)).toBeFalse()
  expect(qualifies([two, { ...five, paired: { ...five.paired, p: 0.05 } }], true)).toBeFalse()
  expect(qualifies([two, { ...five, paired: { ...five.paired, netUsd: -1 } }], true)).toBeFalse()
  expect(qualifies([two, { ...five, alpha: { ...five.alpha, dsr: 0.94999 } }], true)).toBeFalse()
  expect(qualifies([two, { ...five, alpha: { ...five.alpha, exTop10Usd: 0 } }], true)).toBeFalse()
  const metrics = { netUsd: 10, sharpeAnnualized: 1, maxDrawdownUsd: 1 }
  expect(noDegradation(metrics, metrics)).toBeTrue()
  expect(noDegradation({ ...metrics, maxDrawdownUsd: 2 }, metrics)).toBeFalse()
})
