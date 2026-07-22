import { describe, expect, test } from 'bun:test'

import { Effect, Exit } from 'effect'

import { IntentState, OrderSide, OrderType, TimeInForce } from '../paper'
import { plan, type IntentPlan } from './intents'

const hash = (digit: string): string => digit.repeat(64)

const input: IntentPlan = {
  schemaVersion: 'bayn.paper-intent-plan.v1',
  strategyName: 'risk-balanced-trend',
  cycleId: hash('1'),
  decisionHash: hash('2'),
  policyHash: hash('3'),
  accountId: 'paper-account-1',
  symbol: 'NVDA',
  side: OrderSide.Buy,
  orderType: OrderType.Market,
  timeInForce: TimeInForce.Day,
  quantityMicros: '1000000',
  notionalLimitMicros: '200000000',
  createdAt: '2026-07-22T10:00:00.000Z',
}

describe('deterministic paper intents', () => {
  test('derives one stable full intent identity and Alpaca-bounded client order ID', async () => {
    const [first, second] = await Effect.runPromise(Effect.all([plan(input), plan({ ...input })]))

    expect(first).toEqual(second)
    expect(first.intentId).toMatch(/^[0-9a-f]{64}$/)
    expect(first.clientOrderId).toMatch(/^b1_[A-Za-z0-9_-]{43}$/)
    expect(first.clientOrderId).toHaveLength(46)
    expect(first.state).toBe(IntentState.Planned)
    expect(first.riskDecisionId).toBeUndefined()
  })

  test('binds account, strategy, cycle, decision, and target material', async () => {
    const baseline = await Effect.runPromise(plan(input))
    const variants: readonly IntentPlan[] = [
      { ...input, accountId: 'paper-account-2' },
      { ...input, strategyName: 'another-strategy' },
      { ...input, cycleId: hash('4') },
      { ...input, decisionHash: hash('5') },
      { ...input, symbol: 'AMD' },
      { ...input, side: OrderSide.Sell },
      { ...input, orderType: OrderType.Limit },
      { ...input, timeInForce: TimeInForce.GoodUntilCanceled },
      { ...input, quantityMicros: '2000000' },
      { ...input, notionalLimitMicros: '300000000' },
    ]
    const planned = await Effect.runPromise(Effect.forEach(variants, plan))

    expect(new Set(planned.map((intent) => intent.intentId)).size).toBe(variants.length)
    expect(planned.every((intent) => intent.intentId !== baseline.intentId)).toBe(true)
    expect(planned.every((intent) => intent.clientOrderId !== baseline.clientOrderId)).toBe(true)
  })

  test('keeps the order identity stable when policy or observation time drifts', async () => {
    const [baseline, changedPolicy, changedTime] = await Effect.runPromise(
      Effect.all([
        plan(input),
        plan({ ...input, policyHash: hash('6') }),
        plan({ ...input, createdAt: '2026-07-22T10:00:01.000Z' }),
      ]),
    )

    expect(changedPolicy.intentId).toBe(baseline.intentId)
    expect(changedPolicy.clientOrderId).toBe(baseline.clientOrderId)
    expect(changedTime.intentId).toBe(baseline.intentId)
    expect(changedTime.clientOrderId).toBe(baseline.clientOrderId)
  })

  test('rejects malformed plans before deriving an identity', async () => {
    const result = await Effect.runPromiseExit(
      plan({ ...input, cycleId: 'not-a-hash', quantityMicros: '0', extra: true }),
    )

    expect(Exit.isFailure(result)).toBe(true)
  })
})
