import { expect, test } from 'bun:test'

import { Enhancement } from '../src/strategy/etf-noise-area/v4/policy'
import { capital, netAt } from './noise-area-study-replay'
import { armId, arms, type ReplayRow, type SessionReplay } from './noise-area-v4-replay'
import { annualFolds, costs, lockDevelopment, purgeSessions, scoreHoldout, select } from './noise-area-v4-walk-forward'
import { withDevelopmentReceipt } from './research-noise-area-v4'

const row = (base: number, slope: number): ReplayRow => ({
  base,
  slope,
  turnover: 0.4,
  trades: 1,
  unresolved: 0,
  missingEntries: 0,
  missingHeld: 0,
  grossUpperBound: 90_000,
})
const sample = (
  years: readonly number[],
  values: (arm: readonly Enhancement[], year: number, variation: number) => ReplayRow,
): SessionReplay[] =>
  years.flatMap((year) =>
    Array.from({ length: 100 }, (_, i) => ({
      date: new Date(Date.UTC(year, 0, i + 1)).toISOString().slice(0, 10),
      rows: new Map(arms.map((arm) => [armId(arm), values(arm, year, ((i % 7) - 3) * 7)])),
    })),
  )

const makeRow = (arm: readonly Enhancement[], variation: number) => {
  if (arm.length === 1 && arm.includes(Enhancement.Regime)) return row(210 + 2 * variation, 5)
  if (arm.length === 1 && arm.includes(Enhancement.Trailing)) return row(560 + 3 * variation, 3)
  return row(65 + variation, 4)
}
const factors = (holdout: readonly SessionReplay[]) => (bp: (typeof costs)[number]) =>
  holdout.map(({ date, rows }, i) => {
    const b0 = rows.get('B0')
    const pnl = b0 === undefined ? null : netAt(b0, bp)
    if (pnl === null) throw new Error('Expected known B0')
    return {
      date,
      returns: {
        B0: pnl / capital,
        F4: 0.003 * (i % 5),
        O1: 0.005 * (i % 13),
      },
    }
  })

test('selects only on the expanding purged fit and binds the complete development path to the receipt', () => {
  const years = [2018, 2019, 2020, 2021, 2022, 2023]
  const development = sample(years, (arm, year, variation) => {
    if (armId(arm) === Enhancement.Regime) return row(66 + variation, 4)
    if (armId(arm) === Enhancement.Trailing) return row((year === 2019 ? 84 : 60) + variation / 10, 4)
    return row(65 + variation, 4)
  })
  const [first, second] = annualFolds(development, 2019)
  expect(first.fit.length).toBe(100 - purgeSessions)
  expect(first.test[0]?.date).toBe('2019-01-01')
  expect(select(first.fit)).toEqual([Enhancement.Regime])
  expect(select(second.fit)).toEqual([Enhancement.Trailing])

  const start = development.slice(0, -purgeSessions)
  const bump = development.slice(-purgeSessions).map(({ date, rows }) => ({
    date,
    rows: new Map([...rows].map(([id, value]) => [id, { ...value, base: value.base + 90_000 }])),
  }))
  const prior = lockDevelopment(development, 'commit')
  const edited = lockDevelopment([...start, ...bump], 'commit')
  expect(prior.selected).toEqual(edited.selected)
  expect(prior.benchmark).toEqual(edited.benchmark)
  expect(prior.receipt).not.toBe(edited.receipt)
  expect(prior.receipt).not.toBe(lockDevelopment(development, 'different-commit').receipt)
  expect(() => annualFolds([...development, development[0]], 2019)).toThrow('out-of-order')
})

test('requires both target costs and never promotes a descriptive Holdout winner', () => {
  const lock = { selected: [Enhancement.Regime], benchmark: new Map(costs.map((bp) => [bp, 0])) }
  const years = [2024, 2025, 2026]
  const positive = sample(years, (arm, _, variation) => makeRow(arm, variation))
  const report = scoreHoldout(positive, lock, factors(positive))
  expect(report.passes).toBe(true)
  expect(report.scores[1].arms.find(({ id }) => id === Enhancement.Regime)?.correlations[0]).toBeCloseTo(1)

  const expensive = sample(years, (arm, _, variation) =>
    armId(arm) === Enhancement.Regime ? row(190 + 2 * variation, 21) : makeRow(arm, variation),
  )
  const failed = scoreHoldout(expensive, lock, factors(expensive))
  expect(failed.passes).toBe(false)
  expect(failed.scores[1].arms.find(({ id }) => id === Enhancement.Regime)?.deltaCagr).toBeGreaterThan(0)
  expect(failed.scores[2].arms.find(({ id }) => id === Enhancement.Regime)?.deltaCagr).toBeLessThan(0)
  expect(failed.scores[2].arms.find(({ id }) => id === Enhancement.Trailing)?.pairedP).toBeNull()

  const wrongDates = (bp: (typeof costs)[number]) => factors(positive)(bp).slice(1)
  expect(() => scoreHoldout(positive, lock, wrongDates)).toThrow('Session count mismatch')
})

test('rejects a locked combination with an unproven component even when the whole book lifts', () => {
  const selected = [Enhancement.Volatility, Enhancement.Regime]
  const holdout = sample([2024, 2025, 2026], (arm, _, variation) => {
    if (armId(arm) === armId(selected)) return row(450 + variation * 2, 5)
    if (armId(arm) === Enhancement.Volatility) return row(30 + variation, 5)
    return makeRow(arm, variation)
  })
  const report = scoreHoldout(holdout, { selected, benchmark: new Map(costs.map((bp) => [bp, 0])) }, factors(holdout))
  expect(report.scores[2].arms.find(({ id }) => id === armId(selected))?.deltaCagr).toBeGreaterThan(0.01)
  expect(report.components.find(({ part }) => part === Enhancement.Volatility)?.passes).toBe(false)
  expect(report.passes).toBe(false)
})

test('does not open Holdout after a receipt mismatch', async () => {
  let opened = 0
  const open = async () => ++opened
  expect(() => withDevelopmentReceipt('new', 'published', open)).toThrow('Holdout not opened')
  expect(opened).toBe(0)
  expect(await withDevelopmentReceipt('published', 'published', open)).toBe(1)
})
