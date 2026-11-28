import { expect, test } from 'bun:test'

import { Result } from 'effect'

import { evidence, fixture, preset } from './fixtures.test-support'
import { planMacroEtfCoreRebalance, wholeShareCost } from './planner'
import { asset, emptyWeights, MacroEtfCoreEvidenceError } from './policy'
import { computeMacroEtfCoreSignal } from './signals'

const usd = (n: number) => BigInt(n * 1_000_000)
const setup = (spyWeight = 1) => {
  const observed = Result.getOrThrow(computeMacroEtfCoreSignal(preset(), evidence(fixture(100))))
  if (observed === undefined) throw new Error('Expected first signal')
  const weights = emptyWeights()
  weights[asset.SPY] = spyWeight
  const signal = { ...observed, weights }
  const asOf = signal.executionOpenAt
  const mark = (symbol: 'SPY' | 'SHY' | 'QQQ') => ({
    symbol,
    openAt: asOf,
    availableAt: asOf,
    priorCloseAt: signal.signalCloseAt,
    openMicros: usd(100),
    priorCloseMicros: usd(100),
    marginable: true,
  })
  const book = {
    asOf,
    priorEquityMicros: usd(100_000),
    cashMicros: usd(0),
    debitCapMicros: usd(0),
    grossCapMicros: usd(150_000),
    oneWayBps: 10,
    positions: [{ symbol: 'SHY' as const, shares: 1_000n }],
    marks: [mark('SPY'), mark('SHY')],
    protectedSymbols: ['AAPL'],
  }
  return { signal, book, mark }
}

test('sells before buys, rounds whole shares and preserves integer cash after costs', () => {
  const { signal, book } = setup()
  const plan = Result.getOrThrow(planMacroEtfCoreRebalance(preset(), signal, book))
  expect(plan.orders.map(({ symbol, side, shares }) => [symbol, side, shares])).toEqual([
    ['SHY', 'sell', 1_000n],
    ['SPY', 'buy', 997n],
  ])
  expect(plan.cashMicros + plan.grossMicros + plan.orders.reduce((s, order) => s + order.costMicros, 0n)).toBe(
    usd(100_000),
  )
  expect(plan.cashMicros).toBeGreaterThanOrEqual(0n)
  expect(plan.grossMicros).toBe(usd(99_700))
  expect(wholeShareCost(usd(100_000), 'sell', 10)).toBe(102_097_900n)
  expect(
    Result.getOrThrow(planMacroEtfCoreRebalance(preset(), signal, { ...book, marks: book.marks.toReversed() })),
  ).toEqual(plan)
})

test('deadband is measured at the prior close, even when the opening marks gap', () => {
  const { signal, book } = setup(0.09)
  book.marks[1].openMicros = usd(90)
  expect(Result.getOrThrow(planMacroEtfCoreRebalance(preset(), signal, book))).toMatchObject({
    orders: [],
    deadband: true,
  })
  const atBand = setup(0.1)
  expect(Result.getOrThrow(planMacroEtfCoreRebalance(preset(), atBand.signal, atBand.book)).deadband).toBe(false)
})

test('blocks overlapping foreign symbols without consuming or routing their prices', () => {
  const { signal, book, mark } = setup()
  const plan = Result.getOrThrow(
    planMacroEtfCoreRebalance(preset(), signal, {
      ...book,
      marks: [...book.marks.slice(1), mark('QQQ')],
      protectedSymbols: ['SPY', 'QQQ', 'AAPL'],
    }),
  )
  expect(plan.blocked).toEqual(['SPY'])
  expect(plan.orders.map(({ symbol }) => symbol)).toEqual(['SHY'])
})

test('caps are enforced and protected positions cannot be sold to repair a breach', () => {
  const { signal, book } = setup()
  const constrained = { ...book, grossCapMicros: usd(50_000) }
  const plan = Result.getOrThrow(planMacroEtfCoreRebalance(preset(), signal, constrained))
  expect(plan.grossMicros).toBe(usd(50_000))
  const blocked = { ...constrained, protectedSymbols: ['SHY'] }
  expect(Result.isFailure(planMacroEtfCoreRebalance(preset(), signal, blocked))).toBe(true)
})

test('missing and malformed prices are typed global failures, even inside the deadband', () => {
  const { book, signal, mark } = setup(0.09)
  const { priorCloseMicros: _priorClose, ...openOnly } = book.marks[1]
  for (const marks of [
    book.marks.slice(0, 1),
    book.marks.slice(1),
    [...book.marks, { ...mark('QQQ'), openMicros: 0n }],
    [...book.marks, { ...mark('QQQ'), openAt: book.asOf - 1 }],
    [...book.marks, { ...mark('QQQ'), availableAt: book.asOf + 1 }],
    [...book.marks, { ...mark('QQQ'), priorCloseAt: signal.signalCloseAt - 1 }],
    [...book.marks, mark('SHY')],
    [book.marks[0], openOnly],
  ]) {
    const plan = planMacroEtfCoreRebalance(preset(), signal, { ...book, marks })
    expect(Result.isFailure(plan) && plan.failure).toBeInstanceOf(MacroEtfCoreEvidenceError)
  }
})

test('applies the debit limit without treating non-marginable inventory as collateral', () => {
  const { book, signal } = setup()
  const limited = { ...book, debitCapMicros: usd(500) }
  const marginable = Result.getOrThrow(planMacroEtfCoreRebalance(preset(), signal, limited))
  expect(marginable.cashMicros).toBeLessThan(0n)
  expect(marginable.cashMicros).toBeGreaterThanOrEqual(-usd(500))
  book.marks[0].marginable = false
  const unmarginable = Result.getOrThrow(planMacroEtfCoreRebalance(preset(), signal, limited))
  expect(unmarginable.cashMicros).toBeGreaterThanOrEqual(0n)
})
