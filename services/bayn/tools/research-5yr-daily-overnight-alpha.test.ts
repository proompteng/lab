import { expect, test } from 'bun:test'

import { parseTape, readTape, seriesFor, universes } from './daily-alpha-data'
import { economics } from './daily-alpha-metrics'
import { capital, netAt, replay } from './daily-alpha-replay'
import {
  flat,
  isSubmittable,
  neighbors,
  residualScore,
  signalPlanners,
  trialGrid,
  trialId,
} from './daily-alpha-signals'
import { verifyReproducedFreeze } from './research-5yr-daily-overnight-alpha'

const row = (symbol: string, date: string, open: number, close: number) =>
  [symbol, `${date}T05:00:00Z`, open, Math.max(open, close), Math.min(open, close), close, 100_000, close].join('\t')

const friday = '2025-02-21'
const monday = '2025-02-24'
const tuesday = '2025-02-25'

test('truncates before Holdout and discards predecessor, when-issued and WDC jump returns', () => {
  const input = [friday, monday, tuesday]
    .flatMap((date, i) => [
      row('SPY', date, 100, 100 + i),
      row('SNDK', date, 50 + i, 52 + i),
      row('WDC', date, i === 0 ? 100 : 50, i === 0 ? 100 : 50),
    ])
    .join('\n')
  const tape = parseTape(input, monday, ['SPY', 'SNDK', 'WDC'])
  expect(tape.dates).toEqual([friday, monday])
  expect(tape.excluded).toEqual({ SNDK: 1 })
  expect(seriesFor(tape, 'SNDK').bars[0]).toBeUndefined()
  expect(seriesFor(tape, 'SNDK').daily[1]).toBeNaN()
  expect(seriesFor(tape, 'WDC').overnight[1]).toBeNaN()
  expect(() => parseTape(`${input}\n${row('SNDK', friday, 30, 40)}`, monday, ['SPY', 'SNDK', 'WDC'])).toThrow(
    'duplicate SIP bar',
  )
  expect(() => readTape(new Uint8Array(), 'freeze')).toThrow('SHA-256')
})

test('requires paired continuous history and ignores all bars after the signal', () => {
  const series = new Float64Array([0.01, -0.01, 0.015, 0.004, -0.008, 100])
  const spy = new Float64Array([0.008, -0.008, 0.009, 0.002, -0.02, -100])
  const early = residualScore(series, spy, 4, 5, 2)
  expect(early?.volatility).toBeGreaterThan(0)
  series[5] = -1_000
  spy[5] = 1_000
  expect(residualScore(series, spy, 4, 5, 2)).toEqual(early)
  series[2] = NaN
  expect(residualScore(series, spy, 4, 5, 2)).toBeUndefined()
})

function etfFixture(scale: number) {
  const input = universes.etfs
    .flatMap((symbol, s) =>
      Array.from({ length: 70 }, (_, i) => {
        const date = new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10)
        const value = 100 * Math.exp(((s - 6) * i) / 10_000 + Math.sin(i / 2 - s) / 100)
        const changed = i >= 60 && s === 0 ? value * scale : value
        return row(symbol, date, changed, changed)
      }),
    )
    .join('\n')
  return parseTape(input, '2025-04-01', universes.etfs)
}

test('next-Open submits the previous-Close ranking and share sizes; same-Close is diagnostic', () => {
  const open = trialGrid().find(
    (trial) => trial.family === 'etf-rotation' && trial.execution === 'open-open' && trial.universe === 'etfs',
  )
  if (open === undefined) throw new Error('Missing rotation grid')
  const close = { ...open, execution: 'close-close' } as const
  const original = signalPlanners(etfFixture(1))
  const changed = signalPlanners(etfFixture(1.5))
  const nextOpen = original(open)(60, 'open')
  expect(nextOpen?.size).toBe(6)
  expect(changed(open)(60, 'open')).toEqual(nextOpen)
  expect(original(open)(60, 'close')).toBeUndefined()
  expect(original(close)(60, 'close')).not.toEqual(changed(close)(60, 'close'))
  expect(isSubmittable(open)).toBe(true)
  expect(isSubmittable(close)).toBe(false)
  const omitted = [...(nextOpen?.keys() ?? [])][0]
  const excluded = original(open)(60, 'open', omitted)
  expect(excluded?.has(omitted)).toBe(false)
  expect(excluded?.size).toBe(6)
})

test('charges both legs, sell fee and weekend borrow on prior close short dollars, then flattens at terminal Open', () => {
  const tape = parseTape([row('SPY', friday, 100, 100), row('SPY', monday, 80, 70)].join('\n'), monday, ['SPY'])
  const alwaysShort = new Map([['SPY', -0.005]])
  const run = replay(tape, { start: 0, end: 2 }, [
    { end: 'open', plan: (_, phase) => (phase === 'close' ? alwaysShort : flat) },
  ])
  if (run.error !== undefined) throw new Error(run.error)
  const [a, b] = run.days
  expect(a.sold).toBe(50_000)
  expect(b.sold).toBe(0)
  expect(b.traded).toBe(40_000)
  expect(b.pnl).toBe(10_000)
  expect(b.borrow).toBeCloseTo((50_000 * 0.015 * 3) / 365, 10)
  expect(netAt(a, 10) + netAt(b, 10)).toBeCloseTo(10_000 - 45 - 1.05 - b.borrow, 10)
})

test('nets sleeves at the actual order boundary and does not consume current P&L for risk sizing', () => {
  const tape = parseTape(
    [row('SPY', friday, 100, 100), row('SPY', monday, 80, 70), row('SPY', tuesday, 70, 75)].join('\n'),
    tuesday,
    ['SPY'],
  )
  const sleeves = [1, -1].map((sign) => ({
    end: 'close' as const,
    plan: (i: number) => (i === 0 ? undefined : new Map([['SPY', sign * 0.01]])),
  }))
  const result = replay(tape, { start: 0, end: 3 }, sleeves, undefined, {
    window: 2,
    histories: [
      [1, 2, 3],
      [-100, 2, 3],
    ],
  })
  if (result.error !== undefined) throw new Error(result.error)
  expect(result.days[1].traded).toBe(0)
  expect(result.days[1].pnl).toBe(0)
  expect(result.days[1].borrow).toBe(0)
})

test('does not mark a held position with a stale print', () => {
  const input = [
    row('SPY', friday, 100, 100),
    row('SPY', monday, 80, 70),
    row('SNDK', monday, 50, 51),
    row('SPY', tuesday, 70, 75),
  ].join('\n')
  const tape = parseTape(input, tuesday, ['SPY', 'SNDK'])
  const run = replay(tape, { start: 1, end: 3 }, [
    { end: 'open', plan: (_, phase) => (phase === 'close' ? new Map([['SNDK', 0.01]]) : flat) },
  ])
  expect(run.error).toBe('Missing held SNDK open 2025-02-25')
})

test('keeps the exact universe controls and enumerates one-step neighbors without duplicates', () => {
  expect(Object.values(universes).map(({ length }) => length)).toEqual([50, 18, 46, 17, 16, 4])
  const grid = trialGrid()
  expect(grid.length).toBe(824)
  expect(new Set(grid.map(trialId)).size).toBe(824)
  const center = grid.find(
    (trial) =>
      trial.family === 'momentum' &&
      trial.execution === 'open-open' &&
      trial.universe === 'live' &&
      trial.lookback === 10 &&
      trial.skip === 0 &&
      trial.k === 6 &&
      trial.hold === 5,
  )
  if (center === undefined) throw new Error('Missing center')
  const adjacent = neighbors(center, grid)
  expect(adjacent.length).toBe(7)
  expect(
    adjacent.every(
      (trial) => Object.values(trial).filter((value, index) => value !== Object.values(center)[index]).length === 1,
    ),
  ).toBe(true)
})

test('ex-top-five retains the small gains and all losses; the freeze requires exact receipts and ledger', () => {
  const values = [100, 80, 60, 40, 20, 10, -11]
  const performance = economics(values)
  expect(performance?.exTop5Usd).toBe(-1)
  expect(performance?.maxDrawdown).toBeCloseTo(11 / (capital + 310), 10)
  const frozen = { frozen: 'receipt', ledger: 'development' }
  expect(() => verifyReproducedFreeze(frozen, { ...frozen })).not.toThrow()
  expect(() => verifyReproducedFreeze(frozen, { ...frozen, ledger: 'changed' })).toThrow('refusing to open Holdout')
})
