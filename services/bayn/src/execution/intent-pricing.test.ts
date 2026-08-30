import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import { defaultExecutionModel } from '../execution-model'
import { OrderSide, OrderType, TimeInForce } from './contracts'
import { deriveExecutionIntentPricing } from './intent-pricing'

const input = {
  side: OrderSide.Buy,
  orderType: OrderType.Market,
  timeInForce: TimeInForce.Day,
  quantityMicros: 2_000_000n,
  referencePriceMicros: 100_000_000n,
  executionModel: defaultExecutionModel,
} as const

describe('execution intent pricing', () => {
  test('preserves the legacy adverse MARKET/DAY execution model', () => {
    expect(deriveExecutionIntentPricing(input)).toEqual(
      Result.succeed({
        expectedExecutionPriceMicros: 100_050_000n,
        notionalLimitMicros: 200_100_000n,
      }),
    )
  })

  test('uses a verified LIMIT/IOC quote boundary exactly once', () => {
    expect(
      deriveExecutionIntentPricing({
        ...input,
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.ImmediateOrCancel,
        quantityMicros: 3_000_000n,
        referencePriceMicros: 101_230_000n,
      }),
    ).toEqual(
      Result.succeed({
        expectedExecutionPriceMicros: 101_230_000n,
        notionalLimitMicros: 303_690_000n,
      }),
    )
  })

  test('rejects fractional LIMIT/IOC quantities and every unsupported term pair', () => {
    expect(
      deriveExecutionIntentPricing({
        ...input,
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.ImmediateOrCancel,
        quantityMicros: 1_500_000n,
      }),
    ).toMatchObject(Result.fail({ _tag: 'InvalidQuoteBoundIntent', reason: 'fractional-quantity' }))
    expect(
      deriveExecutionIntentPricing({
        ...input,
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.Day,
      }),
    ).toEqual(
      Result.fail({
        _tag: 'UnsupportedExecutionTerms',
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.Day,
      }),
    )
  })
})
