import { expect, test } from 'bun:test'

import { type Etf, universe } from '../src/strategy/macro-etf-core/policy'
import { RunnerProfile } from './macro-etf-core-runner/contract'
import { compareSizing, type SizingSession } from './research-10k-small-account-sizing'

const days = (prices: readonly (readonly (readonly [Etf, number, number])[])[]): SizingSession[] =>
  prices.map((values, i) => ({
    date: `2026-11-${10 + i}`,
    bars: new Map([
      ['SPY', { open: 600, close: 600 }],
      ['QQQ', { open: 510, close: 510 }],
      ['SHY', { open: 82, close: 82 }],
      ...values.map(([symbol, open, close]) => [symbol, { open, close }] as const),
    ]),
  }))
const weights = (targets: Partial<Record<Etf, number>>) => universe.map((symbol) => targets[symbol] ?? 0)

test.each([2, 5, 10])('paired returns and cash include exactly %i bp on filled opening notional', (bps) => {
  const tape = days([[], [['SPY', 600, 660]]])
  const report = compareSizing(tape, new Map([[tape[0].date, weights({ SPY: 1 })]]), RunnerProfile.F4, 10_000, bps)
  const rate = bps / 10_000
  const fractional = (10_000 * 660) / (600 * (1 + rate))
  const cash = 10_000 - 16 * 600 * (1 + rate)
  const whole = cash + 16 * 660
  expect(report.fractional.finalEquityUsd).toBeCloseTo(fractional, 9)
  expect(report.whole.finalEquityUsd).toBeCloseTo(whole, 9)
  expect(report.whole.avgUninvestedCashAfterFirstReviewPct).toBeCloseTo((100 * cash) / whole, 9)
  expect(report.whole.avgUninvestedCashPct).toBeCloseTo((100 + (100 * cash) / whole) / 2, 9)
  expect(report.trackingErrorAnnualizedPct).toBeCloseTo(((fractional - whole) / 100) * Math.sqrt(252 / 2), 9)
})

test('prior-close decisions ignore next-opening gaps and a final close has no in-sample execution', () => {
  const tape = days([[], [], [['SPY', 900, 900]]])
  const mix = weights({ SPY: 0.5, SHY: 0.5 })
  const reviews = new Map([
    [tape[0].date, mix],
    [tape[1].date, mix],
    [tape[2].date, weights({ QQQ: 1 })],
  ])
  const report = compareSizing(tape, reviews, RunnerProfile.F4, 10_000, 0)
  expect(report.reviews.whole).toMatchObject({ traded: 1, insideBand: 1, triggeredWithoutTradeDates: [] })
  expect(report.reviews.fractional).toEqual(report.reviews.whole)
  expect(report.whole.finalEquityUsd).toBe(12_400) // Retains eight SPY shares through the next open.
  expect(report.fractional.finalEquityUsd).toBeCloseTo(12_500, 9)
})

test('sells fund actual buys at the next open, and both sides of a rotation pay the cost', () => {
  const tape = days([
    [],
    [],
    [
      ['SPY', 660, 660],
      ['QQQ', 510, 400],
    ],
  ])
  const reviews = new Map([
    [tape[0].date, weights({ SPY: 1 })],
    [tape[1].date, weights({ QQQ: 1 })],
  ])
  const report = compareSizing(tape, reviews, 'O1', 10_000, 10)
  const cash = 10_000 - 16 * 600 * 1.001 + 16 * 660 * 0.999 - 21 * 510 * 1.001
  expect(report.whole.finalEquityUsd).toBeCloseTo(cash + 21 * 400, 9)
  expect(report.whole.maxDrawdownPct).toBeCloseTo(100 * (1 - (cash + 21 * 400) / 10_000), 9)
  expect(report.reviews.whole.traded).toBe(2)
})

test('at $600/$510 a triggered core can be stuck below both minimum lots, without chasing on repeat reviews', () => {
  const tape = days([[], [], [], []])
  const target = weights({ SPY: 0.059, QQQ: 0.05, SHY: 0.891 })
  const reviews = new Map(tape.map(({ date }) => [date, target]))
  const report = compareSizing(tape, reviews, RunnerProfile.Equal, 10_000, 5)
  expect(report.reviews.whole).toEqual({
    traded: 1,
    insideBand: 0,
    triggeredWithoutTradeDates: [tape[2].date, tape[3].date],
    maxConsecutiveTriggeredWithoutTrade: 2,
  })
  expect(report.reviews.fractional).toMatchObject({ traded: 1, insideBand: 2 })
  expect(report.reviews.wholeLotsBlockedDates).toEqual([tape[2].date, tape[3].date])
  expect(report.reviewsWithPriorSpyAtLeast600AndQqqAtLeast510).toEqual(report.reviews)
  expect(report.whole.avgUninvestedCashAfterFirstReviewPct).toBeGreaterThan(10)
})

test('a rounded SPY position can cause an extra review trade; O1 still uses a per-name band', () => {
  const tape = days([[], [], []])
  const reviews = new Map([
    [tape[0].date, weights({ SPY: 0.5, SHY: 0.5 })],
    [tape[1].date, weights({ SPY: 0.59, SHY: 0.41 })],
  ])
  const core = compareSizing(tape, reviews, RunnerProfile.F2, 10_000, 5)
  expect(core.reviews).toMatchObject({ onlyWholeTraded: 1, onlyFractionalTraded: 0 })
  expect(core.wholeMinusFractional.annualOneWayTurnover).toBeGreaterThan(0)

  const split = new Map([[tape[0].date, weights({ SPY: 0.06, QQQ: 0.05, SHY: 0.89 })]])
  const o1 = compareSizing(tape, split, 'O1', 10_000, 5)
  expect(o1.whole.finalEquityUsd).toBeCloseTo(10_000 - 121 * 82 * 0.0005, 9) // Only SHY is bought.
})

test('missing marks on an owned holding fail instead of dropping the exposure', () => {
  const tape = days([[], [], []])
  tape[2] = { date: tape[2].date, bars: new Map() }
  expect(() => compareSizing(tape, new Map([[tape[0].date, weights({ QQQ: 1 })]]), 'O1', 10_000, 5)).toThrow(
    `Missing or invalid close mark: QQQ ${tape[2].date}`,
  )
})
