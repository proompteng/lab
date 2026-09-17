import { Result } from 'effect'

import { quantizeAlpacaLimitPriceMicros } from '../broker/alpaca-price'
import type { ExecutionModel } from '../execution-model-contract'
import { makeFillTerms, MICROS, notionalMicros, type ExecutionModelFailure } from '../execution-model'
import { OrderSide, OrderType, TimeInForce } from './contracts'

export interface ExecutionIntentPricingInput {
  readonly side: OrderSide
  readonly orderType: OrderType
  readonly timeInForce: TimeInForce
  readonly quantityMicros: bigint
  readonly referencePriceMicros: bigint
  readonly executionModel: ExecutionModel
  readonly limitSlippageBps: bigint
}

export interface ExecutionIntentPricing {
  readonly expectedExecutionPriceMicros: bigint
  readonly notionalLimitMicros: bigint
}

export type ExecutionIntentPricingFailure =
  | ExecutionModelFailure
  | {
      readonly _tag: 'UnsupportedExecutionTerms'
      readonly orderType: OrderType
      readonly timeInForce: TimeInForce
    }
  | {
      readonly _tag: 'InvalidQuoteBoundIntent'
      readonly reason: 'invalid-quantity-or-price' | 'fractional-quantity' | 'invalid-slippage'
      readonly quantityMicros: bigint
      readonly referencePriceMicros: bigint
    }

export const deriveExecutionIntentPricing = (
  input: ExecutionIntentPricingInput,
): Result.Result<ExecutionIntentPricing, ExecutionIntentPricingFailure> => {
  if (input.orderType === OrderType.Market && input.timeInForce === TimeInForce.Day) {
    return Result.map(
      makeFillTerms(
        input.side === OrderSide.Buy ? 'buy' : 'sell',
        input.quantityMicros,
        input.referencePriceMicros,
        input.executionModel,
        MICROS,
      ),
      (terms) => ({
        expectedExecutionPriceMicros: terms.fillPriceMicros,
        notionalLimitMicros: terms.notionalMicros,
      }),
    )
  }

  if (input.orderType !== OrderType.Limit || input.timeInForce !== TimeInForce.ImmediateOrCancel) {
    return Result.fail({
      _tag: 'UnsupportedExecutionTerms',
      orderType: input.orderType,
      timeInForce: input.timeInForce,
    })
  }
  if (input.quantityMicros <= 0n || input.referencePriceMicros <= 0n) {
    return Result.fail({
      _tag: 'InvalidQuoteBoundIntent',
      reason: 'invalid-quantity-or-price',
      quantityMicros: input.quantityMicros,
      referencePriceMicros: input.referencePriceMicros,
    })
  }
  if (input.quantityMicros % MICROS !== 0n) {
    return Result.fail({
      _tag: 'InvalidQuoteBoundIntent',
      reason: 'fractional-quantity',
      quantityMicros: input.quantityMicros,
      referencePriceMicros: input.referencePriceMicros,
    })
  }
  if (input.limitSlippageBps < 0n || input.limitSlippageBps >= 10_000n) {
    return Result.fail({
      _tag: 'InvalidQuoteBoundIntent',
      reason: 'invalid-slippage',
      quantityMicros: input.quantityMicros,
      referencePriceMicros: input.referencePriceMicros,
    })
  }
  const buy = input.side === OrderSide.Buy
  const boundary = input.referencePriceMicros * (10_000n + (buy ? input.limitSlippageBps : -input.limitSlippageBps))
  const price =
    input.limitSlippageBps === 0n
      ? input.referencePriceMicros
      : quantizeAlpacaLimitPriceMicros((boundary + (buy ? 0n : 9_999n)) / 10_000n, buy ? 'DOWN' : 'UP')
  return Result.map(notionalMicros(input.quantityMicros, price), (notionalLimitMicros) => ({
    expectedExecutionPriceMicros: price,
    notionalLimitMicros,
  }))
}
