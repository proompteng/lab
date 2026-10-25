import { instrumentMarket } from '../instruments'
import { orderRequestBody, orderPriceBoundaryMicros } from '../broker/alpaca-mutations/decisions'
import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import { intradayExecutionModel } from '../strategy/intraday-market'
import { simulateIntradayReplayExecution } from '../intraday-replay/execution-core'
import { intradayMomentumExecutionModel } from '../strategy/intraday-momentum/protocol'
import { OrderSide, OrderType, TimeInForce } from './contracts'
import { deriveExecutionIntentPricing } from './intent-pricing'

const input = {
  symbol: 'NVDA',
  side: OrderSide.Buy,
  orderType: OrderType.Market,
  timeInForce: TimeInForce.Day,
  quantityAtoms: 2000000000n,
  referencePriceMicros: 100_000_000n,
  executionModel: intradayExecutionModel,
  limitSlippageBps: 0n,
} as const

test.each(['AAPL', 'BTC/USD', 'ETH/USD', 'SOL/USD'])(
  '%s take-profit limits retain their minimum sell price when the quote changes',
  (symbol) => {
    const terms = {
      symbol,
      side: OrderSide.Sell,
      orderType: OrderType.Limit,
      timeInForce: symbol.includes('/') ? TimeInForce.ImmediateOrCancel : TimeInForce.Day,
      quantityAtoms: 2_000_000_000n,
      limitSlippageBps: 10n,
    }
    for (const referencePriceMicros of [100_210_000n, 99_000_000n]) {
      const pricing = Result.getOrThrow(
        deriveExecutionIntentPricing({
          ...terms,
          referencePriceMicros,
          minimumSellPriceMicros: 100_210_000n,
        }),
      )
      expect(pricing.expectedExecutionPriceMicros).toBe(100_210_000n)
      const request = Result.getOrThrow(
        orderRequestBody({
          ...terms,
          quantityAtoms: String(terms.quantityAtoms),
          clientOrderId: 'b1_' + 'A'.repeat(43),
          limitPriceMicros: String(pricing.expectedExecutionPriceMicros),
          notionalLimitMicros: String(pricing.notionalLimitMicros),
        }),
      )
      expect(request.limit_price).toBe('100.21')
      expect(request).toMatchObject({ side: 'sell' })
    }
    const favorable = { ...terms, referencePriceMicros: 101_000_000n }
    expect(
      Result.getOrThrow(deriveExecutionIntentPricing({ ...favorable, minimumSellPriceMicros: 100_210_000n })),
    ).toEqual(Result.getOrThrow(deriveExecutionIntentPricing(favorable)))
  },
)

test('a sell floor cannot be nonpositive or attached to a buy', () => {
  for (const minimumSellPriceMicros of [0n, -1n])
    expect(
      Result.isFailure(
        deriveExecutionIntentPricing({
          ...input,
          side: OrderSide.Sell,
          orderType: OrderType.Limit,
          minimumSellPriceMicros,
        }),
      ),
    ).toBe(true)
  expect(
    Result.isFailure(
      deriveExecutionIntentPricing({
        ...input,
        orderType: OrderType.Limit,
        minimumSellPriceMicros: 100_000_000n,
      }),
    ),
  ).toBe(true)
})

describe('execution intent pricing', () => {
  test('keeps an NVDA limit marketable after the observed submission price move without exceeding the risk cap', () => {
    for (const [reference, expectedLimit, arrivalAsk] of [
      [215_410_000n, 215_620_000n, 215_490_000n],
      [215_660_000n, 215_870_000n, 215_720_000n],
    ] as const) {
      const pricing = Result.getOrThrow(
        deriveExecutionIntentPricing({
          ...input,
          orderType: OrderType.Limit,
          timeInForce: TimeInForce.Day,
          quantityAtoms: 46000000000n,
          referencePriceMicros: reference,
          limitSlippageBps: 10n,
        }),
      )
      expect(pricing.expectedExecutionPriceMicros).toBe(expectedLimit)
      expect(pricing.expectedExecutionPriceMicros).toBeGreaterThanOrEqual(arrivalAsk)
      expect((pricing.expectedExecutionPriceMicros - reference) * 10_000n).toBeLessThanOrEqual(reference * 10n)
      expect(pricing.notionalLimitMicros).toBe(expectedLimit * 46n)
      const simulate = (limitPriceMicros: bigint, priceMicros: bigint = arrivalAsk) =>
        Result.getOrThrow(
          simulateIntradayReplayExecution({
            instrument: {
              symbol: input.symbol,
              market: instrumentMarket(input.symbol),
              minimumQuantityAtoms: 1_000_000_000n,
              quantityIncrementAtoms: 1_000_000_000n,
              priceIncrementAtoms: 100_000n,
            },
            order: { side: OrderSide.Buy, quantityAtoms: 46000000000n, limitPriceMicros },
            quote: { priceMicros, displayedQuantityAtoms: 46000000000n },
            executionModel: intradayMomentumExecutionModel,
            assumptions: { slippageBps: 0, availableLiquidityPpm: 1_000_000 },
          }),
        )
      expect(simulate(reference)).toMatchObject({ status: 'unfilled', filledQuantityAtoms: 0n })
      expect(simulate(pricing.expectedExecutionPriceMicros)).toMatchObject({
        status: 'filled',
        filledQuantityAtoms: 46000000000n,
        fillPriceMicros: arrivalAsk,
      })
      expect(simulate(pricing.expectedExecutionPriceMicros, expectedLimit + 10_000n)).toMatchObject({
        status: 'unfilled',
        filledQuantityAtoms: 0n,
      })
    }
  })

  test('rounds protected sell limits toward the quote to stay inside the slippage cap', () => {
    expect(
      deriveExecutionIntentPricing({
        ...input,
        side: OrderSide.Sell,
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.Day,
        referencePriceMicros: 215_410_000n,
        limitSlippageBps: 10n,
      }),
    ).toEqual(Result.succeed({ expectedExecutionPriceMicros: 215_200_000n, notionalLimitMicros: 430_400_000n }))
  })

  test('fills the retained IWM exit within its allowance and rejects a worse arrival price', () => {
    const reference = 289_180_000n
    const quantity = 68_000_000_000n
    const pricing = Result.getOrThrow(
      deriveExecutionIntentPricing({
        ...input,
        side: OrderSide.Sell,
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.Day,
        referencePriceMicros: reference,
        quantityAtoms: quantity,
        limitSlippageBps: 10n,
      }),
    )
    expect(pricing.expectedExecutionPriceMicros).toBe(288_900_000n)
    const simulate = (limitPriceMicros: bigint, slippageBps: number, availableLiquidityPpm = 1_000_000) =>
      Result.getOrThrow(
        simulateIntradayReplayExecution({
          instrument: {
            symbol: input.symbol,
            market: instrumentMarket(input.symbol),
            minimumQuantityAtoms: 1_000_000_000n,
            quantityIncrementAtoms: 1_000_000_000n,
            priceIncrementAtoms: 100_000n,
          },
          order: { side: OrderSide.Sell, quantityAtoms: quantity, limitPriceMicros },
          quote: { priceMicros: reference, displayedQuantityAtoms: quantity },
          executionModel: intradayMomentumExecutionModel,
          assumptions: { slippageBps, availableLiquidityPpm },
        }),
      )
    expect(simulate(reference, 1)).toMatchObject({ status: 'unfilled', filledQuantityAtoms: 0n })
    expect(simulate(pricing.expectedExecutionPriceMicros, 1)).toMatchObject({
      status: 'filled',
      filledQuantityAtoms: quantity,
      fillPriceMicros: 289_150_000n,
    })
    expect(simulate(pricing.expectedExecutionPriceMicros, 1, 500_000)).toMatchObject({
      status: 'filled',
      filledQuantityAtoms: 34000000000n,
      fillPriceMicros: 289_150_000n,
      remainingQuantityAtoms: 34000000000n,
    })
    expect(simulate(pricing.expectedExecutionPriceMicros, 11)).toMatchObject({
      status: 'unfilled',
      filledQuantityAtoms: 0n,
    })
  })

  test('rejects retired MARKET/DAY pricing', () => {
    expect(deriveExecutionIntentPricing(input)).toEqual(
      Result.fail({
        _tag: 'UnsupportedExecutionTerms',
        orderType: OrderType.Market,
        timeInForce: TimeInForce.Day,
      }),
    )
  })

  test('uses a verified LIMIT/IOC quote boundary exactly once', () => {
    expect(
      deriveExecutionIntentPricing({
        ...input,
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.Day,
        quantityAtoms: 3000000000n,
        referencePriceMicros: 101_230_000n,
      }),
    ).toEqual(
      Result.succeed({
        expectedExecutionPriceMicros: 101_230_000n,
        notionalLimitMicros: 303_690_000n,
      }),
    )
  })

  test('allows fractional LIMIT/DAY quantities and rejects unsupported term pairs', () => {
    for (const limitSlippageBps of [-1n, 10_000n]) {
      expect(
        deriveExecutionIntentPricing({
          ...input,
          orderType: OrderType.Limit,
          timeInForce: TimeInForce.Day,
          limitSlippageBps,
        }),
      ).toMatchObject(Result.fail({ _tag: 'InvalidQuoteBoundIntent', reason: 'invalid-slippage' }))
    }
    expect(
      deriveExecutionIntentPricing({
        ...input,
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.Day,
        quantityAtoms: 1500000000n,
      }),
    ).toMatchObject(Result.succeed({ expectedExecutionPriceMicros: 100_000_000n, notionalLimitMicros: 150_000_000n }))
    expect(
      deriveExecutionIntentPricing({
        ...input,
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.ImmediateOrCancel,
      }),
    ).toEqual(
      Result.fail({
        _tag: 'UnsupportedExecutionTerms',
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.ImmediateOrCancel,
      }),
    )
  })
})

for (const symbol of ['BTC/USD', 'ETH/USD', 'SOL/USD']) {
  test(`${symbol} prices fractional IOC quantities through the same encoder within the slippage cap`, () => {
    for (const side of [OrderSide.Buy, OrderSide.Sell]) {
      const reference = 103_123_457n
      const terms = Result.getOrThrow(
        deriveExecutionIntentPricing({
          ...input,
          symbol,
          side,
          orderType: OrderType.Limit,
          timeInForce: TimeInForce.ImmediateOrCancel,
          quantityAtoms: 31_234_567n,
          referencePriceMicros: reference,
          limitSlippageBps: 10n,
        }),
      )
      const intent = {
        symbol,
        side,
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.ImmediateOrCancel,
        clientOrderId: 'b1_' + 'A'.repeat(43),
        quantityAtoms: '31234567',
        notionalLimitMicros: terms.notionalLimitMicros.toString(),
        limitPriceMicros: terms.expectedExecutionPriceMicros.toString(),
      }
      const body = Result.getOrThrow(orderRequestBody(intent))
      expect(body).toMatchObject({ symbol, qty: '0.031234567', type: 'limit', time_in_force: 'ioc' })
      expect(Result.getOrThrow(orderPriceBoundaryMicros(intent))).toBe(terms.expectedExecutionPriceMicros)
      const adverse =
        side === OrderSide.Buy
          ? terms.expectedExecutionPriceMicros - reference
          : reference - terms.expectedExecutionPriceMicros
      expect(adverse).toBeGreaterThan(0n)
      expect(adverse * 10_000n).toBeLessThanOrEqual(reference * 10n)
    }
    const close = Result.getOrThrow(
      deriveExecutionIntentPricing({
        ...input,
        symbol,
        side: OrderSide.Sell,
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.ImmediateOrCancel,
        quantityAtoms: 31_234_567n,
      }),
    )
    expect(close.notionalLimitMicros).toBeGreaterThan(0n)
  })
}
