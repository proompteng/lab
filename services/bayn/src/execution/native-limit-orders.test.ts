import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { orderRequestBody } from '../broker/alpaca-mutations/decisions'
import { IntentSchema, OrderSide, OrderType, TimeInForce } from './contracts'
import { deriveExecutionIntentPricing } from './intent-pricing'
import { intentIdForPlan } from './intents/domain'

const request = {
  symbol: 'AAPL',
  side: OrderSide.Buy,
  orderType: OrderType.Limit,
  timeInForce: TimeInForce.Day,
  clientOrderId: 'b1_' + 'A'.repeat(43),
  quantityAtoms: '1000',
  limitPriceMicros: '100010000',
  notionalLimitMicros: '101',
} as const

const currentIntent = {
  schemaVersion: 'bayn.execution-intent.v5' as const,
  authorityGenerationHash: '4'.repeat(64),
  intentId: '5'.repeat(64),
  strategyName: 'native-limit-test',
  cycleId: '1'.repeat(64),
  decisionHash: '2'.repeat(64),
  policyHash: '3'.repeat(64),
  accountId: 'paper-test',
  createdAt: '2026-10-18T12:00:00.000Z',
  state: 'PLANNED',
  ...request,
}

test('fractional equity LIMIT/DAY preserves its explicit price through currency rounding', () => {
  const pricing = Result.getOrThrow(
    deriveExecutionIntentPricing({
      ...request,
      quantityAtoms: BigInt(request.quantityAtoms),
      referencePriceMicros: BigInt(request.limitPriceMicros),
      limitSlippageBps: 0n,
    }),
  )
  expect(pricing.expectedExecutionPriceMicros).toBe(100010000n)
  expect(pricing.notionalLimitMicros).toBe(101n)
  expect(Result.getOrThrow(orderRequestBody(request))).toMatchObject({
    qty: '0.000001',
    type: 'limit',
    time_in_force: 'day',
    limit_price: '100.01',
    extended_hours: true,
  })
})

test('the explicit limit price is part of intent identity even when rounded notional is unchanged', () => {
  const plan = {
    schemaVersion: 'bayn.intent-plan.v3' as const,
    strategyName: 'native-limit-test',
    cycleId: '1'.repeat(64),
    decisionHash: '2'.repeat(64),
    policyHash: '3'.repeat(64),
    accountId: 'paper-test',
    createdAt: '2026-10-18T12:00:00.000Z',
    ...request,
  }
  const { clientOrderId: _, ...input } = plan
  expect(Result.getOrThrow(intentIdForPlan(input))).not.toBe(
    Result.getOrThrow(intentIdForPlan({ ...input, limitPriceMicros: '100020000' })),
  )
})

test('native submission rejects implicit prices, mismatched rounded notionals and MARKET/GTC', () => {
  expect(Result.isFailure(orderRequestBody({ ...request, notionalLimitMicros: '100' }))).toBe(true)
  const { limitPriceMicros: _, ...implicit } = currentIntent
  expect(Result.isSuccess(Schema.decodeUnknownResult(IntentSchema)(currentIntent))).toBe(true)
  expect(Result.isFailure(Schema.decodeUnknownResult(IntentSchema)(implicit))).toBe(true)
  expect(
    Result.isFailure(
      orderRequestBody({
        ...request,
        symbol: 'BTC/USD',
        orderType: OrderType.Market,
        timeInForce: TimeInForce.GoodUntilCanceled,
      }),
    ),
  ).toBe(true)
})

test('the current intent codec rejects retired implicit-price execution contracts', () => {
  const decoded = Schema.decodeUnknownResult(IntentSchema)({ ...currentIntent, schemaVersion: 'bayn.paper-intent.v3' })
  expect(Result.isFailure(decoded)).toBe(true)
})
