import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import { defaultExecutionModel } from '../execution-model'
import { simulateIntradayReplayIocCore } from '../intraday-replay/execution-core'
import { intradayMomentumExecutionModel } from '../strategy/intraday-momentum/protocol'
import { OrderSide, OrderType, TimeInForce } from './contracts'
import { deriveExecutionIntentPricing } from './intent-pricing'

const input = {
  side: OrderSide.Buy,
  orderType: OrderType.Market,
  timeInForce: TimeInForce.Day,
  quantityMicros: 2_000_000n,
  referencePriceMicros: 100_000_000n,
  executionModel: defaultExecutionModel,
  limitSlippageBps: 0n,
} as const

describe('execution intent pricing', () => {
  test('keeps an NVDA IOC marketable after the observed submission price move without exceeding the risk cap', () => {
    for (const [reference, expectedLimit, arrivalAsk] of [
      [215_410_000n, 215_620_000n, 215_490_000n],
      [215_660_000n, 215_870_000n, 215_720_000n],
    ] as const) {
      const pricing = Result.getOrThrow(
        deriveExecutionIntentPricing({
          ...input,
          orderType: OrderType.Limit,
          timeInForce: TimeInForce.ImmediateOrCancel,
          quantityMicros: 46_000_000n,
          referencePriceMicros: reference,
          limitSlippageBps: 10n,
          executionModel: intradayMomentumExecutionModel,
        }),
      )
      expect(pricing.expectedExecutionPriceMicros).toBe(expectedLimit)
      expect(pricing.expectedExecutionPriceMicros).toBeGreaterThanOrEqual(arrivalAsk)
      expect((pricing.expectedExecutionPriceMicros - reference) * 10_000n).toBeLessThanOrEqual(reference * 10n)
      expect(pricing.notionalLimitMicros).toBe(expectedLimit * 46n)
      const simulate = (limitPriceMicros: bigint, priceMicros: bigint = arrivalAsk) =>
        Result.getOrThrow(
          simulateIntradayReplayIocCore({
            order: { side: OrderSide.Buy, quantityMicros: 46_000_000n, limitPriceMicros },
            quote: { priceMicros, displayedQuantityMicros: 46_000_000n },
            executionModel: intradayMomentumExecutionModel,
            assumptions: { slippageBps: 0, availableLiquidityPpm: 1_000_000 },
          }),
        )
      expect(simulate(reference)).toMatchObject({ status: 'canceled', filledQuantityMicros: 0n })
      expect(simulate(pricing.expectedExecutionPriceMicros)).toMatchObject({
        status: 'filled',
        filledQuantityMicros: 46_000_000n,
        fillPriceMicros: arrivalAsk,
      })
      expect(simulate(pricing.expectedExecutionPriceMicros, expectedLimit + 10_000n)).toMatchObject({
        status: 'canceled',
        filledQuantityMicros: 0n,
      })
    }
  })

  test('rounds protected sell limits toward the quote to stay inside the slippage cap', () => {
    expect(
      deriveExecutionIntentPricing({
        ...input,
        side: OrderSide.Sell,
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.ImmediateOrCancel,
        referencePriceMicros: 215_410_000n,
        limitSlippageBps: 10n,
      }),
    ).toEqual(Result.succeed({ expectedExecutionPriceMicros: 215_200_000n, notionalLimitMicros: 430_400_000n }))
  })

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
    for (const limitSlippageBps of [-1n, 10_000n]) {
      expect(
        deriveExecutionIntentPricing({
          ...input,
          orderType: OrderType.Limit,
          timeInForce: TimeInForce.ImmediateOrCancel,
          limitSlippageBps,
        }),
      ).toMatchObject(Result.fail({ _tag: 'InvalidQuoteBoundIntent', reason: 'invalid-slippage' }))
    }
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
