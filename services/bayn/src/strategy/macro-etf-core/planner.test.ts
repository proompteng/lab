import { expect, test } from 'bun:test'

import { Result } from 'effect'

import { evidence, fixture, preset } from './fixtures.test-support'
import { MacroRiskMode, MacroRiskState } from '../macro-portfolio/risk'
import { planMacroEtfCoreRebalance, planMacroEtfCoreRebalanceV2, wholeShareCost } from './planner'
import {
  asset,
  corePolicyV2,
  decodeMacroEtfCorePolicyV2,
  emptyWeights,
  MacroEtfCoreEvidenceError,
  Profile,
} from './policy'
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

const v2 = (mode: MacroRiskMode) => ({
  schema: corePolicyV2,
  profile: Profile.F4,
  risk: { mode, targetVolatility: 0.1 },
})

test('v2 cash never borrows or sweeps residual exposure into SHY', () => {
  const { book, signal } = setup(0.4)
  const policy = v2(MacroRiskMode.Cash)
  const { hash } = Result.getOrThrow(decodeMacroEtfCorePolicyV2(policy))
  const target = {
    ...signal,
    policyHash: hash,
    riskState: MacroRiskState.Normal,
    priorEquityMicros: book.priorEquityMicros,
  }
  const sleeve = { ...book, settledCashMicros: 0n, debitCapMicros: usd(50_000) }
  const plan = Result.getOrThrow(planMacroEtfCoreRebalanceV2(policy, target, sleeve))
  expect(plan.orders.map(({ symbol, side }) => [symbol, side])).toEqual([['SHY', 'sell']])
  expect(plan.grossMicros).toBe(0n)
  const unsettled = { ...sleeve, cashMicros: plan.cashMicros, positions: [] }
  expect(Result.getOrThrow(planMacroEtfCoreRebalanceV2(policy, target, unsettled)).orders).toHaveLength(0)
  const funded = { ...unsettled, settledCashMicros: plan.cashMicros }
  expect(
    Result.isFailure(
      planMacroEtfCoreRebalanceV2(policy, target, {
        ...funded,
        priorEquityMicros: funded.priorEquityMicros + 1n,
      }),
    ),
  ).toBe(true)
  const purchase = Result.getOrThrow(planMacroEtfCoreRebalanceV2(policy, target, funded))
  expect(purchase.orders.map(({ symbol, side }) => [symbol, side])).toEqual([['SPY', 'buy']])
  expect(purchase.grossMicros).toBeLessThanOrEqual(usd(40_000))
  expect(purchase.cashMicros).toBeGreaterThan(usd(59_000))
  target.weights[asset.QQQ] = 0.7
  expect(Result.isFailure(planMacroEtfCoreRebalanceV2(policy, target, sleeve))).toBe(true)
})

test('v2 margin is opt-in, obeys broker debit and caps gross against post-fee equity', () => {
  const { book, signal, mark } = setup(0.8)
  signal.weights[asset.QQQ] = 0.7
  const policy = v2(MacroRiskMode.Margin)
  const { hash } = Result.getOrThrow(decodeMacroEtfCorePolicyV2(policy))
  const target = {
    ...signal,
    policyHash: hash,
    riskState: MacroRiskState.Normal,
    priorEquityMicros: book.priorEquityMicros,
  }
  const sleeve = {
    ...book,
    marks: [...book.marks, mark('QQQ')],
    positions: [],
    cashMicros: usd(100_000),
    settledCashMicros: usd(100_000),
    debitCapMicros: usd(50_000),
  }
  const plan = Result.getOrThrow(planMacroEtfCoreRebalanceV2(policy, target, sleeve))
  expect(plan.grossMicros).toBeGreaterThan(usd(145_000))
  expect(plan.grossMicros * 2n <= 3n * (plan.cashMicros + plan.grossMicros)).toBe(true)
  expect(plan.cashMicros >= -usd(50_000)).toBe(true)
  expect(Result.isFailure(planMacroEtfCoreRebalanceV2(v2(MacroRiskMode.Cash), target, sleeve))).toBe(true)
  expect(Result.isFailure(planMacroEtfCoreRebalance(preset(), target, sleeve))).toBe(true)
})

test('v2 margin reduces inventory when a lower debit limit binds after a favorable opening gap', () => {
  const { book, signal, mark } = setup(0.8)
  signal.weights[asset.QQQ] = 0.7
  const policy = v2(MacroRiskMode.Margin)
  const { hash } = Result.getOrThrow(decodeMacroEtfCorePolicyV2(policy))
  const plan = Result.getOrThrow(
    planMacroEtfCoreRebalanceV2(
      policy,
      { ...signal, policyHash: hash, riskState: MacroRiskState.Normal, priorEquityMicros: book.priorEquityMicros },
      {
        ...book,
        marks: [mark('SPY'), mark('QQQ')].map((row) => ({ ...row, openMicros: usd(110) })),
        positions: [
          { symbol: 'SPY', shares: 800n },
          { symbol: 'QQQ', shares: 700n },
        ],
        cashMicros: -usd(50_000),
        settledCashMicros: 0n,
        grossCapMicros: usd(250_000),
        debitCapMicros: usd(49_000),
      },
    ),
  )
  expect(plan.orders.length).toBeGreaterThan(0)
  expect(plan.orders.every(({ side }) => side === 'sell')).toBe(true)
  expect(plan.cashMicros).toBeGreaterThanOrEqual(-usd(49_000))
})

test('v2 margin forces reductions when existing holdings become non-marginable', () => {
  const { book, signal, mark } = setup(0.8)
  signal.weights[asset.QQQ] = 0.7
  const policy = v2(MacroRiskMode.Margin)
  const { hash } = Result.getOrThrow(decodeMacroEtfCorePolicyV2(policy))
  const plan = Result.getOrThrow(
    planMacroEtfCoreRebalanceV2(
      policy,
      { ...signal, policyHash: hash, riskState: MacroRiskState.Normal, priorEquityMicros: book.priorEquityMicros },
      {
        ...book,
        marks: [mark('SPY'), mark('QQQ')].map((row) => ({ ...row, marginable: false })),
        positions: [
          { symbol: 'SPY', shares: 800n },
          { symbol: 'QQQ', shares: 700n },
        ],
        cashMicros: -usd(50_000),
        settledCashMicros: 0n,
        debitCapMicros: usd(50_000),
        oneWayBps: 0,
      },
    ),
  )
  expect(plan.deadband).toBe(false)
  expect(plan.orders.map(({ symbol, side, shares }) => [symbol, side, shares])).toEqual([
    ['SPY', 'sell', 267n],
    ['QQQ', 'sell', 234n],
  ])
  expect(plan.cashMicros).toBeGreaterThanOrEqual(0n)
})

test('v2 brake bypasses the deadband, reduces only, and halts in cash', () => {
  const { book, signal } = setup(0.04)
  const sleeve = { ...book, settledCashMicros: 0n }
  signal.weights[asset.SHY] = 0.46
  const policy = v2(MacroRiskMode.Cash)
  const { hash } = Result.getOrThrow(decodeMacroEtfCorePolicyV2(policy))
  const target = {
    ...signal,
    policyHash: hash,
    riskState: MacroRiskState.Brake,
    priorEquityMicros: book.priorEquityMicros,
  }
  const plan = Result.getOrThrow(planMacroEtfCoreRebalanceV2(policy, target, sleeve))
  expect(plan.deadband).toBe(false)
  expect(plan.orders).toHaveLength(1)
  expect(plan.orders[0]).toMatchObject({ symbol: 'SHY', side: 'sell' })
  expect(plan.grossMicros * 2n <= plan.cashMicros + plan.grossMicros).toBe(true)
  const protectedBook = { ...sleeve, protectedSymbols: ['SHY'] }
  expect(Result.isFailure(planMacroEtfCoreRebalanceV2(policy, target, protectedBook))).toBe(true)
  const stopped = Result.getOrThrow(
    planMacroEtfCoreRebalanceV2(policy, { ...target, riskState: MacroRiskState.Halt, weights: emptyWeights() }, sleeve),
  )
  expect(stopped.grossMicros).toBe(0n)
})
