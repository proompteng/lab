import { describe, expect, test } from 'bun:test'

import {
  capital,
  createAccount,
  frictionBps,
  maintenanceFor,
  reservationScale,
  noIntraday,
  tiers,
  type Sleeve,
} from './master-portfolio-account'
import { replay3B } from './master-portfolio-intraday'
import type { Order, PreparedDay } from './master-portfolio-intraday-signals'
import { mmcLastSession, mmcSuccessorStart } from './master-portfolio-sp100'
import { correlation, stationaryBootstrap, summarize } from './master-portfolio-statistics'

const market = (date: string, shy = 0, spy = 0, ief = 0) => ({ date, shy, spy, ief })
const account = { weight: 0, tier: tiers.realistic, equity: 'fixed', cash: 'zero' } as const
const marked = (positions: readonly [string, number][]): Sleeve => ({
  weight: 1,
  mark: () => 100,
  open: () => ({ unit: 'dollars', positions: new Map(positions) }),
})
const exampleDay = '2024-01-02'

describe('unified cash and buying power', () => {
  test('caps overnight Reg T orders and passes only remaining gross and prior-close DTBP to intraday', () => {
    const step = createAccount({
      ...account,
      weight: 0.5,
      overnight: [marked([['SPY', 2]])],
      intraday: ({ capacity, budget, overnightGross, dtbp, overnightSymbols }) => {
        expect(budget).toBe(50_000)
        expect(capacity).toBeCloseTo(30_000, 5)
        expect(overnightGross).toBeCloseTo(150_000, 5)
        expect(dtbp).toBeGreaterThan(capacity)
        expect([...overnightSymbols]).toEqual(['SPY'])
        return { ...noIntraday, peakGross: capacity }
      },
    })
    const friday = step(market('2024-01-05'))
    const monday = step(market('2024-01-08'))
    expect(friday.overnightTrim).toBe(true)
    expect(monday.peakCombined).toBe(180_000)
    expect(monday.debit).toBeCloseTo(((150_000 - (capital - 7.5)) * 0.065 * 3) / 360, 8)
  })

  test('charges spread by instrument tier and sell fee by order side; borrow uses ACT/365', () => {
    const step = createAccount({
      ...account,
      cash: 'shy',
      overnight: [
        marked([
          ['SPY', 0.4],
          ['AAPL', -0.4],
        ]),
      ],
    })
    const friday = step(market('2024-01-05'))
    const monday = step(market('2024-01-08', 0.001))
    expect(friday.costs).toBeCloseTo((40_000 * 1 + 40_000 * 3) / 20_000, 8)
    expect(friday.sellFees).toBeCloseTo((40_000 * 0.21) / 10_000, 8)
    expect(monday.borrow).toBeCloseTo((40_000 * 0.015 * 3) / 365, 8)
    expect(monday.carry).toBeCloseTo((monday.startEquity - 80_000) * 0.001, 8)
    expect(monday.costs).toBe(0)
    expect(frictionBps('SMH', tiers.brutal)).toBe(10)
    expect(frictionBps('AAPL', tiers.brutal)).toBe(15)
  })

  test('low-priced short maintenance gates DTBP even if a position exits at the open', () => {
    const sleeve: Sleeve = {
      ...marked([]),
      mark: () => 2,
      open: (date) => ({
        unit: 'dollars',
        positions: date === exampleDay ? new Map([['AAPL', -0.79]]) : new Map(),
      }),
    }
    expect(maintenanceFor(-10, 2)).toBe(25)
    expect(maintenanceFor(-10, 10)).toBe(50)
    const step = createAccount({
      ...account,
      overnight: [sleeve],
      intraday: ({ date, dtbp, capacity }) => {
        if (date !== exampleDay) {
          expect(dtbp).toBeLessThan(5_000)
          expect(capacity).toBe(dtbp)
        }
        return noIntraday
      },
    })
    step(market(exampleDay))
    step(market('2024-01-03'))
  })

  test('flat-overnight strategies earn the cash proxy once and compound only from prior P&L', () => {
    const budgets: number[] = []
    const step = createAccount({
      ...account,
      equity: 'compounded',
      cash: 'shy',
      weight: 1,
      overnight: [],
      intraday: ({ budget }) => {
        budgets.push(budget)
        return { ...noIntraday, net: 200 }
      },
    })
    const first = step(market(exampleDay, 0.001))
    const second = step(market('2024-01-03', -0.001, -0.02, 0.005))
    expect(budgets).toEqual([100_000, 100_300])
    expect(first.carry).toBe(100)
    expect(second.carry).toBe(-100.3)
    expect(second.borrow + second.debit).toBe(0)
    expect(second.sixtyForty).toBeCloseTo(-0.01, 10)
  })
})

test('the predecessor must be closed at its last available mark, never imputed through the missing opening', () => {
  const mmc: Sleeve = {
    ...marked([['MMC', 0.5]]),
    mark: (_symbol, date, phase) => (date === mmcSuccessorStart ? undefined : phase === 'open' ? 100 : 101),
    open: (date) => ({ unit: 'dollars', positions: date === mmcLastSession ? new Map([['MMC', 0.5]]) : new Map() }),
  }
  const original = createAccount({ ...account, overnight: [mmc] })
  original(market(mmcLastSession))
  expect(() => original(market(mmcSuccessorStart))).toThrow(`Missing MMC open price on ${mmcSuccessorStart}`)
  const corrected = createAccount({
    ...account,
    overnight: [{ ...mmc, closeExit: (symbol, date) => symbol === 'MMC' && date === mmcLastSession }],
  })
  const last = corrected(market(mmcLastSession))
  expect(last.closeGross).toBe(0)
  expect(last.overnightNet).toBeCloseTo(500 - (100_500 * 3) / 20_000 - (50_500 * 0.21) / 10_000, 8)
  expect(corrected(market(mmcSuccessorStart)).net).toBe(0)
})

const order = (symbol: string, side: 1 | -1, entry: number, exit: number | null): Order => ({
  symbol,
  engine: 'reversion',
  side,
  start: 30,
  reference: entry,
  riskDistance: null,
  fill: { entry, exit, exitSlot: 77, exitAtOpen: true, gaps: 0 },
})
const reversionOnly = (orders: readonly Order[]): PreparedDay => ({
  date: exampleDay,
  orb: () => [],
  noise: () => [],
  reversion: (trial, excluded) => {
    expect(trial.signalSlot).toBe(29)
    expect(trial.minBps).toBe(100)
    return orders.some(({ symbol }) => excluded.has(symbol)) ? [] : orders
  },
})
const legs = [
  order('AAPL', 1, 100, 104),
  order('AMD', 1, 100, 104),
  order('COHR', -1, 100, 96),
  order('NVDA', -1, 100, 96),
]

test('one common ratio scales a four-leg reversion intent at the next open, independent of its exits', () => {
  const day = {
    date: exampleDay,
    budget: capital,
    capacity: 20_000,
    overnightGross: 145_000,
    dtbp: 20_000,
    overnightSymbols: new Set<string>(),
    tier: tiers.realistic,
  }
  const outcome = (orders: readonly Order[]) => replay3B(new Map([[exampleDay, reversionOnly(orders)]]), 3)(day)
  const trimmed = outcome(legs)
  expect(trimmed.trades).toBe(4)
  expect(trimmed.scaled && trimmed.grossCapHit && trimmed.dtbpHit).toBe(true)
  expect(trimmed.peakGross).toBeCloseTo(20_000, 8)
  const losing = outcome(legs.map((leg) => order(leg.symbol, leg.side, 100, leg.side === 1 ? 96 : 104)))
  expect(losing.peakGross).toBe(trimmed.peakGross)
  expect(losing.net).toBeLessThan(0)
  expect(trimmed.net).toBeGreaterThan(0)
  expect(reservationScale(45_000, 10_000, 30_000)).toBeCloseTo(20 / 45)
  expect(() => outcome([order('AAPL', 1, 100, null), ...legs.slice(1)])).toThrow('Unresolved Wave 3B exit')
  expect(outcome([{ ...legs[0], fill: 'missing' }, ...legs.slice(1)]).trades).toBe(0)
})

test('analytics retain paired benchmarks, dollar attribution and deterministic bootstrap tails', () => {
  const step = createAccount({ ...account, cash: 'shy', overnight: [] })
  const days = [step(market('2024-12-31', 0.01, 0.02)), step(market('2025-01-02', -0.02, -0.02))]
  const summary = summarize(days, 'fixed', false)
  expect(summary.netUsd).toBe(-1_000)
  expect(summary.versus.shy.excessNetUsd).toBe(20)
  expect(summary.exTop5NetUsd).toBe(-2_000)
  expect(summary.calendarYears['2025'].netUsd).toBe(-2_000)
  expect(summary.downSpy.netUsd).toBe(-2_000)
  expect(summary.maxDrawdown).toBeCloseTo(2_000 / 101_000, 10)
  expect(correlation([1, 2, 3], [-2, -4, -6])).toBe(-1)
  expect(correlation([1, 1], [-1, 1])).toBeNull()
  const boot = stationaryBootstrap([0.03, -0.05, 0.02], [0.02, -0.06, 0.01], 'compounded', 1000)
  expect(boot).toEqual(stationaryBootstrap([0.03, -0.05, 0.02], [0.02, -0.06, 0.01], 'compounded', 1000))
  expect(boot.pValue).toBeGreaterThan(0)
  expect(boot.maxDrawdownCVaR95).toBeGreaterThanOrEqual(boot.maxDrawdownVaR95)
})
