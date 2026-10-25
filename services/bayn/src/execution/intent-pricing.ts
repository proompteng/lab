import { cashSpotLimitTimeInForce } from './order-terms'
import { Result } from 'effect'
import { quantityScale } from '../quantity'

import { quantizeInstrumentPriceMicros } from '../broker/alpaca-price'
import { instrumentMarket } from '../instruments'
import { OrderSide, OrderType, TimeInForce } from './contracts'

export interface ExecutionIntentPricingInput {
  readonly symbol: string
  readonly side: OrderSide
  readonly orderType: OrderType
  readonly timeInForce: TimeInForce
  readonly quantityAtoms: bigint
  readonly referencePriceMicros: bigint
  readonly limitSlippageBps: bigint
  readonly minimumSellPriceMicros?: bigint
}

export interface ExecutionIntentPricing {
  readonly expectedExecutionPriceMicros: bigint
  readonly notionalLimitMicros: bigint
}

export type ExecutionIntentPricingFailure =
  | {
      readonly _tag: 'UnsupportedExecutionTerms'
      readonly orderType: OrderType
      readonly timeInForce: TimeInForce
    }
  | {
      readonly _tag: 'InvalidQuoteBoundIntent'
      readonly reason: 'invalid-quantity-or-price' | 'invalid-slippage' | 'invalid-sell-floor'
      readonly quantityAtoms: bigint
      readonly referencePriceMicros: bigint
    }

export const deriveExecutionIntentPricing = (
  input: ExecutionIntentPricingInput,
): Result.Result<ExecutionIntentPricing, ExecutionIntentPricingFailure> => {
  if (
    input.orderType !== OrderType.Limit ||
    input.timeInForce !== cashSpotLimitTimeInForce(instrumentMarket(input.symbol))
  ) {
    return Result.fail({
      _tag: 'UnsupportedExecutionTerms',
      orderType: input.orderType,
      timeInForce: input.timeInForce,
    })
  }
  if (input.quantityAtoms <= 0n || input.referencePriceMicros <= 0n) {
    return Result.fail({
      _tag: 'InvalidQuoteBoundIntent',
      reason: 'invalid-quantity-or-price',
      quantityAtoms: input.quantityAtoms,
      referencePriceMicros: input.referencePriceMicros,
    })
  }
  if (input.limitSlippageBps < 0n || input.limitSlippageBps >= 10_000n) {
    return Result.fail({
      _tag: 'InvalidQuoteBoundIntent',
      reason: 'invalid-slippage',
      quantityAtoms: input.quantityAtoms,
      referencePriceMicros: input.referencePriceMicros,
    })
  }
  const buy = input.side === OrderSide.Buy
  if (input.minimumSellPriceMicros !== undefined && (buy || input.minimumSellPriceMicros <= 0n)) {
    return Result.fail({
      _tag: 'InvalidQuoteBoundIntent',
      reason: 'invalid-sell-floor',
      quantityAtoms: input.quantityAtoms,
      referencePriceMicros: input.referencePriceMicros,
    })
  }
  const boundary = input.referencePriceMicros * (10_000n + (buy ? input.limitSlippageBps : -input.limitSlippageBps))
  const quotePrice = quantizeInstrumentPriceMicros(
    input.symbol,
    (boundary + (buy ? 0n : 9_999n)) / 10_000n,
    buy ? 'DOWN' : 'UP',
  )
  const floor =
    input.minimumSellPriceMicros === undefined
      ? quotePrice
      : quantizeInstrumentPriceMicros(input.symbol, input.minimumSellPriceMicros, 'UP')
  const price = quotePrice < floor ? floor : quotePrice
  const notionalLimitMicros = (input.quantityAtoms * price + (buy ? quantityScale - 1n : 0n)) / quantityScale
  if (price <= 0n || notionalLimitMicros <= 0n)
    return Result.fail({
      _tag: 'InvalidQuoteBoundIntent',
      reason: 'invalid-quantity-or-price',
      quantityAtoms: input.quantityAtoms,
      referencePriceMicros: input.referencePriceMicros,
    })
  return Result.succeed({ expectedExecutionPriceMicros: price, notionalLimitMicros })
}
