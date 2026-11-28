import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { type Bar, BarAdjustment, type Position, Side } from './macro-canary-runner/alpaca'
import { Mode, TimeInForce, type Options } from './macro-canary-runner/contract'
import { planRebalance as planCanary, type Snapshot } from './macro-canary-runner/planner'
import type { Allocation } from './macro-etf-core-runner/allocation'
import type { Market } from './macro-etf-core-runner/market'
import { planRebalance as planCore } from './macro-etf-core-runner/planner'

const prices = { SPY: 728, QQQ: 520, GLD: 334, TLT: 92, IEF: 92, HYG: 77, SHY: 82, UUP: 29 }
type Symbol = keyof typeof prices
const symbols = Object.keys(prices) as Symbol[]
const rawBars = symbols.map((symbol) => {
  const p = prices[symbol]
  return { symbol, bar: { t: '2026-11-25T05:00:00Z', o: p, h: p, l: p, c: p, v: 100_000 } satisfies Bar }
})
const window: Market['window'] = {
  sessions: [],
  lastDate: '2026-11-25',
  lastCloseAt: '2026-11-25T21:00:00Z',
  executionDate: '2026-11-27',
  executionOpenAt: '2026-11-27T14:30:00Z',
  cutoff: Date.parse('2026-11-27T14:28:00Z'),
  barEnd: '2026-11-25T21:00:00Z',
}
const market: Market = {
  window,
  rawBars,
  barSha256: 'a'.repeat(64),
  missingCandidates: [],
  evidence: {
    asOf: Date.parse('2026-11-27T14:00:00Z'),
    snapshotHash: 'b'.repeat(64),
    snapshot: {
      schema: 'bayn.macro-etf-core-close-snapshot.v1',
      datasetVersion: 'fixture',
      adjustment: BarAdjustment.All,
      calendar: [],
      bars: [],
    },
  },
}
const options = {
  mode: Mode.Shadow,
  tif: TimeInForce.Open,
  excludeSymbols: [],
  output: 'unused.json',
} satisfies Options
const book = (lots: Partial<Record<Symbol, number>> = {}, equity = 10_000, buyingPower?: number): Snapshot => {
  let cash = equity
  const positions = symbols.flatMap((symbol): Position[] => {
    const qty = lots[symbol]
    if (qty === undefined) return []
    const value = qty * prices[symbol]
    cash -= value
    return [{ symbol, side: 'long', qty: String(qty), qty_available: String(qty), market_value: String(value) }]
  })
  return {
    account: {
      id: '11111111-1234-4234-8123-000000000001',
      status: 'ACTIVE',
      currency: 'USD',
      equity: String(equity),
      cash: String(cash),
      buying_power: String(buyingPower ?? cash),
      account_blocked: false,
      trading_blocked: false,
      trade_suspended_by_user: false,
    },
    positions,
    openOrders: [],
  }
}
const targets = (weights: Partial<Record<Symbol, number>>) =>
  symbols.map((symbol) => ({ symbol, weight: weights[symbol] ?? 0 }))
const core = (snapshot: Snapshot, weights: Partial<Record<Symbol, number>> | null) => {
  const allocation: Allocation = {
    components: [],
    excludedSymbols: options.excludeSymbols,
    targets: weights === null ? null : targets(weights),
  }
  return Result.getOrThrow(planCore(snapshot, { tif: options.tif, capitalBudgetCents: 15_000_000 }, allocation, market))
}
const canary = (snapshot: Snapshot, weights: Partial<Record<Symbol, number>>, review = true) =>
  Result.getOrThrow(planCanary(snapshot, options, window.executionDate, review, targets(weights), rawBars))
const orders = (plan: ReturnType<typeof core> | ReturnType<typeof canary>) =>
  plan.orders.map(({ request: { symbol, side, qty, limit_price } }) => [symbol, side, qty, limit_price])

test('core $10k rounds within its collar and does not chase unreachable targets on the next review', () => {
  const weights = { SPY: 0.06, QQQ: 0.05, GLD: 0.24, TLT: 0.15, IEF: 0.14, HYG: 0.1, SHY: 0.16, UUP: 0.1 }
  const plan = core(book(), weights)
  expect(orders(plan)).toEqual([
    ['GLD', Side.Buy, '7', '334.50'],
    ['TLT', Side.Buy, '16', '92.13'],
    ['IEF', Side.Buy, '15', '92.13'],
    ['HYG', Side.Buy, '12', '77.11'],
    ['SHY', Side.Buy, '19', '82.12'],
    ['UUP', Side.Buy, '34', '29.04'],
  ])
  expect(plan).toMatchObject({
    budgetCents: 1_000_000,
    rebalanceDue: true,
    buyLimitNotionalCents: 867_049,
    maximumProjectedGrossCents: 867_049,
  })
  // Mark the previously bought shares at the unchanged reference price, with the rest still in cash.
  const held = book({ GLD: 7, TLT: 16, IEF: 15, HYG: 12, SHY: 19, UUP: 34 })
  expect(core(held, weights)).toMatchObject({ rebalanceDue: true, orders: [] })
  expect(core(held, null)).toMatchObject({ reviewDue: false, rebalanceDue: false, orders: [] })
  expect(core(book({ SHY: 120 }), { SHY: 0.92, SPY: 0.08 })).toMatchObject({ rebalanceDue: false, orders: [] })
})

test('canary $10k sweeps in-band UUP weight into SHY without protecting QQQ on its isolated account', () => {
  const weights = { SPY: 0.2, QQQ: 0.12, GLD: 0.16, TLT: 0.14, IEF: 0.12, HYG: 0.1, SHY: 0.07, UUP: 0.09 }
  const plan = canary(book(), weights)
  expect(orders(plan)).toEqual([
    ['SPY', Side.Buy, '2', '729.09'],
    ['QQQ', Side.Buy, '2', '520.78'],
    ['GLD', Side.Buy, '4', '334.50'],
    ['TLT', Side.Buy, '15', '92.13'],
    ['IEF', Side.Buy, '13', '92.13'],
    ['HYG', Side.Buy, '12', '77.11'],
    ['SHY', Side.Buy, '19', '82.12'],
  ])
  expect(plan).toMatchObject({
    excludedSymbols: [],
    budgetCents: 1_000_000,
    rebalanceDue: true,
    buyLimitNotionalCents: 890_298,
  })
  expect(canary(book(), weights, false)).toMatchObject({ rebalanceDue: false, orders: [] })
})

test('neither $10k planner spends pending proceeds or assumes gross released by sells', () => {
  const held = book({ SHY: 100, UUP: 60 })
  const weights = { SPY: 0.46, QQQ: 0.4, SHY: 0.14 }
  const corePlan = core(held, weights)
  const canaryPlan = canary(held, weights)
  expect(orders(corePlan)).toEqual([
    ['SHY', Side.Sell, '83', '81.88'],
    ['UUP', Side.Sell, '60', '28.96'],
  ])
  expect(orders(canaryPlan)).toEqual([
    ['SHY', Side.Sell, '82', '81.88'],
    ['UUP', Side.Sell, '60', '28.96'],
  ])
  for (const plan of [corePlan, canaryPlan])
    expect(plan).toMatchObject({
      budgetCents: 1_000_000,
      cashCents: 6_000,
      buyLimitNotionalCents: 0,
      maximumProjectedGrossCents: 994_000,
    })
})

test('an isolated $10k canary review can buy an affordable lot when proportional floors would erase both one-lot buys', () => {
  const weights = { SPY: 0.11, QQQ: 0.1, GLD: 0.28, TLT: 0.14, IEF: 0.14, HYG: 0.2, SHY: 0.03 }
  const positions = { GLD: 10, TLT: 20, IEF: 20, HYG: 29 }
  const plan = canary(book(positions), weights)
  expect(plan).toMatchObject({ rebalanceDue: true, cashCents: 74_700, maximumProjectedGrossCents: 998_209 })
  expect(orders(plan)).toEqual([['SPY', Side.Buy, '1', '729.09']])
  expect(orders(canary(book(positions, 10_000, 700), weights))).toEqual([['QQQ', Side.Buy, '1', '520.78']])
  expect(canary(book(positions, 10_000, 519.99), weights)).toMatchObject({ rebalanceDue: true, orders: [] })
})

test('the canary keeps the existing proportional $100k sizing, even with artificially tight buying power', () => {
  const positions = { GLD: 100, TLT: 200, IEF: 200, HYG: 290 }
  const weights = { SPY: 0.11, QQQ: 0.1, GLD: 0.28, TLT: 0.14, IEF: 0.14, HYG: 0.2, SHY: 0.03 }
  expect(orders(canary(book(positions, 100_000), weights))).toEqual([
    ['SPY', Side.Buy, '5', '729.09'],
    ['QQQ', Side.Buy, '6', '520.78'],
  ])
  expect(canary(book(positions, 100_000, 747), weights)).toMatchObject({ rebalanceDue: true, orders: [] })
})
