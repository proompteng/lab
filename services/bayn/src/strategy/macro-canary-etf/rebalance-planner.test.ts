import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { OrderSide } from '../../execution/contracts'
import { fixtureMarket } from './fixtures.test-support'
import { decodeMacroCanaryEtfPolicy, defaultMacroCanaryEtfPolicy, macroCanaryEtfs, type MacroCanaryEtf } from './policy'
import { planMacroCanaryEtfRebalance, type MacroCanaryEtfRebalanceInput } from './rebalance-planner'
import { compileMacroCanaryEtfSignal, type MacroCanaryEtfTarget } from './signals'

const receipt = defaultMacroCanaryEtfPolicy
const quote = { priceMicros: 100_000_000n, tickMicros: 10_000n, shortable: false }
const quotes = Object.fromEntries(macroCanaryEtfs.map((symbol) => [symbol, quote]))
const inputFor = (
  weights: Partial<Record<MacroCanaryEtf, number>>,
  override: Partial<MacroCanaryEtfRebalanceInput> = {},
): MacroCanaryEtfRebalanceInput => ({
  target: {
    policyHash: receipt.policyHash,
    signalSession: '2026-11-24',
    nextOpenSession: '2026-11-25',
    review: true,
    targetWeights: Object.fromEntries(
      macroCanaryEtfs.map((symbol) => [symbol, weights[symbol] ?? 0]),
    ) as MacroCanaryEtfTarget['targetWeights'],
  },
  executionSession: '2026-11-25',
  equityMicros: 100_000_000_000n,
  spendableCashMicros: 100_000_000_000n,
  references: { adjustment: 'raw', session: '2026-11-25', corporateActionsReconciled: true, quotes },
  positions: [],
  ordersClear: true,
  remainingOneWayTurnoverBps: 60_000,
  ...override,
})
const plan = (input: MacroCanaryEtfRebalanceInput) => planMacroCanaryEtfRebalance(receipt, input)
const planned = (input: MacroCanaryEtfRebalanceInput) => Result.getOrThrow(plan(input))

test('suppresses below-10pp drifts, trades at 10pp, and holds outside the review cadence', () => {
  const positions = [
    { symbol: 'SPY', shares: 200 },
    { symbol: 'SHY', shares: 350 },
  ] as const
  const below = inputFor({ SPY: 0.2999, SHY: 0.2501 }, { positions })
  expect(planned(below)).toEqual({ phase: 'hold', reason: 'NoWholeShareDrift' })
  const threshold = inputFor({ SPY: 0.3, SHY: 0.35 }, { positions })
  expect(planned(threshold)).toMatchObject({
    phase: 'increase',
    executionSession: '2026-11-25',
    policyHash: receipt.policyHash,
    orders: [{ symbol: 'SPY', side: OrderSide.Buy, shares: 100, limitPriceMicros: 100_150_000n }],
  })
  expect(planned({ ...threshold, target: { ...threshold.target, review: false } })).toEqual({
    phase: 'hold',
    reason: 'OutsideReview',
  })
})

test('plans a compiled review target, buying idle SHY on raw prices rather than adjusted bars', () => {
  const market = fixtureMarket(252, () => 20)
  const target = Result.getOrThrow(compileMacroCanaryEtfSignal(receipt, market))
  expect(target.review).toBe(true)
  expect(target.attribution.idleShyWeight).toBeGreaterThan(0)
  const input = inputFor({}, { target, executionSession: target.nextOpenSession })
  expect(planned({ ...input, references: { ...input.references, session: target.nextOpenSession } })).toMatchObject({
    phase: 'increase',
    orders: [{ symbol: 'SHY', side: OrderSide.Buy, shares: 499, limitPriceMicros: 100_150_000n }],
  })
})

test('separates reductions from additions; never spends proceeds until a fresh reconciliation', () => {
  const input = inputFor({ QQQ: 0.4 }, { positions: [{ symbol: 'SPY', shares: 400 }], spendableCashMicros: 0n })
  expect(planned(input)).toMatchObject({
    phase: 'reduce',
    orders: [{ symbol: 'SPY', side: OrderSide.Sell, shares: 400, limitPriceMicros: 99_850_000n }],
    reservedCashMicros: 0n,
  })
  expect(planned({ ...input, positions: [] })).toEqual({ phase: 'hold', reason: 'NoCapacity' })
  expect(planned({ ...input, positions: [], spendableCashMicros: 40_000_000_000n })).toMatchObject({
    phase: 'increase',
    orders: [{ symbol: 'QQQ', shares: 399 }],
    reservedCashMicros: 39_959_850_000n,
  })
})

test('prioritizes deterministically and reserves cash and two-way turnover at the collar', () => {
  const input = inputFor({ QQQ: 0.25, SPY: 0.25 }, { remainingOneWayTurnoverBps: 200 })
  expect(planned(input)).toMatchObject({
    phase: 'increase',
    orders: [{ symbol: 'SPY', shares: 39 }],
    reservedTwoWayTurnoverMicros: 3_905_850_000n,
  })
  expect(planned({ ...input, remainingOneWayTurnoverBps: 60_000, spendableCashMicros: 9_000_000_000n })).toMatchObject({
    phase: 'increase',
    orders: [{ symbol: 'SPY', shares: 89 }],
    reservedCashMicros: 8_913_350_000n,
  })
  expect(planned({ ...input, remainingOneWayTurnoverBps: 0 })).toEqual({ phase: 'hold', reason: 'NoCapacity' })
})

test('does not free gross room from positions inside the drift band or cross a concentration cap', () => {
  const { policy } = receipt
  const capped = Result.getOrThrow(
    decodeMacroCanaryEtfPolicy({
      ...policy,
      execution: { ...policy.execution, maxGrossLeverage: 0.7 },
    }),
  )
  const input = inputFor(
    { SPY: 0.27, QQQ: 0.18, GLD: 0.25 },
    {
      positions: [
        { symbol: 'SPY', shares: 350 },
        { symbol: 'QQQ', shares: 250 },
      ],
    },
  )
  const bound = { ...input, target: { ...input.target, policyHash: capped.policyHash } }
  const decision = Result.getOrThrow(planMacroCanaryEtfRebalance(capped, bound))
  expect(decision).toMatchObject({ phase: 'increase', orders: [{ symbol: 'GLD', shares: 98 }] })
  expect(
    Result.getOrThrow(planMacroCanaryEtfRebalance(capped, { ...bound, positions: [...bound.positions].reverse() })),
  ).toEqual(decision)
  expect(planned(inputFor({ SPY: 0.5 }, { positions: [{ symbol: 'SPY', shares: 400 }] }))).toMatchObject({
    phase: 'increase',
    orders: [{ symbol: 'SPY', shares: 99 }],
  })
})

test('the signed option needs borrow and a fresh reconciliation between crossing zero', () => {
  const { policy } = receipt
  const signed = Result.getOrThrow(
    decodeMacroCanaryEtfPolicy({
      ...policy,
      trend: { ...policy.trend, book: { kind: 'signed', maxShortGrossWeight: 0.2 } },
    }),
  )
  const base = inputFor({ SPY: -0.2 }, { positions: [{ symbol: 'SPY', shares: 120 }] })
  expect(plan(base)).toMatchObject({ _tag: 'Failure', failure: { _tag: 'InvalidTargetExposure' } })
  const input = { ...base, target: { ...base.target, policyHash: signed.policyHash } }
  const replan = (i: MacroCanaryEtfRebalanceInput) => planMacroCanaryEtfRebalance(signed, i)
  expect(Result.getOrThrow(replan(input))).toMatchObject({
    phase: 'reduce',
    orders: [{ symbol: 'SPY', side: OrderSide.Sell, shares: 120 }],
  })
  expect(replan({ ...input, positions: [] })).toMatchObject({
    _tag: 'Failure',
    failure: { _tag: 'ShortUnavailable', symbol: 'SPY' },
  })
  expect(
    Result.getOrThrow(
      replan({
        ...input,
        positions: [],
        references: { ...input.references, quotes: { SPY: { ...quote, shortable: true } } },
      }),
    ),
  ).toMatchObject({ phase: 'increase', orders: [{ symbol: 'SPY', side: OrderSide.Sell, shares: 199 }] })
})

test('quantizes inward and fails closed on stale, missing or unreconciled execution inputs', () => {
  const input = inputFor({ SPY: 0.2 })
  const withPrice = (priceMicros: bigint, tickMicros: bigint) => ({
    ...input,
    references: { ...input.references, quotes: { SPY: { ...quote, priceMicros, tickMicros } } },
  })
  expect(planned(withPrice(100_123_456n, 10_000n))).toMatchObject({
    orders: [{ symbol: 'SPY', limitPriceMicros: 100_270_000n }],
  })
  const sell = { ...withPrice(100_123_456n, 10_000n), positions: [{ symbol: 'SPY', shares: 400 }] as const }
  expect(planned(sell)).toMatchObject({ orders: [{ symbol: 'SPY', limitPriceMicros: 99_980_000n }] })
  const failures = [
    [withPrice(100_500_000n, 1_000_000n), 'InvalidReference'],
    [{ ...input, references: { ...input.references, quotes: {} } }, 'InvalidReference'],
    [{ ...input, references: { ...input.references, session: '2026-11-24' as const } }, 'TargetBindingMismatch'],
    [{ ...input, target: { ...input.target, policyHash: '0'.repeat(64) } }, 'TargetBindingMismatch'],
    [
      { ...input, references: { ...input.references, corporateActionsReconciled: false } },
      'UnreconciledCorporateActions',
    ],
    [{ ...input, ordersClear: false }, 'UnreconciledOrders'],
    [{ ...input, positions: [{ symbol: 'SPY', shares: -1 }] as const }, 'InvalidPosition'],
    [{ ...input, positions: [{ symbol: 'SPY', shares: 5.5 }] as const }, 'InvalidPosition'],
    [{ ...input, positions: [{ symbol: 'SPY', shares: 510 }] as const }, 'ExistingExposureLimit'],
  ] as const
  for (const [snapshot, _tag] of failures) expect(plan(snapshot)).toMatchObject({ _tag: 'Failure', failure: { _tag } })
})
