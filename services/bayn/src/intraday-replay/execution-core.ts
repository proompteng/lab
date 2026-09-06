import { Result, Schema } from 'effect'

import { quantizeAlpacaLimitPriceMicros } from '../broker/alpaca-price'
import { OrderSide } from '../execution/contracts'
import { MICROS, notionalMicros } from '../execution-model'
import { PositiveMicrosSchema } from '../schemas'
import type { IntradayMomentumProtocol } from '../strategy/intraday-momentum/protocol'
import type { IntradayReplayIocAssumptions } from './execution'

const BPS = 10_000n
const PPM = 1_000_000n
const U128_MAX = (1n << 128n) - 1n
const isPositiveMicros = Schema.is(PositiveMicrosSchema)
type CoreCancelReason = 'adverse-price-exceeds-limit' | 'no-displayed-liquidity' | 'zero-after-whole-share-rounding'

export interface IntradayReplayIocCoreOrder {
  readonly side: OrderSide
  readonly quantityMicros: bigint
  readonly limitPriceMicros: bigint
}

/** Executable quote values selected from one event-time market snapshot. */
export interface IntradayReplayIocCoreQuote {
  readonly priceMicros: bigint
  readonly displayedQuantityMicros: bigint
}

export interface IntradayReplayIocCoreInput {
  readonly order: IntradayReplayIocCoreOrder
  readonly quote: IntradayReplayIocCoreQuote
  readonly executionModel: IntradayMomentumProtocol['executionModel']
  readonly assumptions: IntradayReplayIocAssumptions
}

export type IntradayReplayIocCoreOutcome =
  | {
      readonly status: 'filled'
      readonly requestedQuantityMicros: bigint
      readonly filledQuantityMicros: bigint
      readonly fillPriceMicros: bigint
      readonly fillNotionalMicros: bigint
      readonly unfilledRemainder: 'none' | 'canceled'
    }
  | {
      readonly status: 'canceled'
      readonly requestedQuantityMicros: bigint
      readonly filledQuantityMicros: bigint
      readonly reason: 'adverse-price-exceeds-limit' | 'no-displayed-liquidity' | 'zero-after-whole-share-rounding'
      readonly unfilledRemainder: 'canceled'
    }

export interface IntradayReplayIocCoreFailure {
  readonly _tag: 'InvalidIntradayReplayCoreInput'
  readonly field: string
  readonly value: unknown
  readonly reason:
    | 'invalid-order'
    | 'invalid-quote'
    | 'invalid-assumptions'
    | 'invalid-execution-model'
    | 'invalid-notional'
}

const invalid = (
  field: string,
  value: unknown,
  reason: IntradayReplayIocCoreFailure['reason'],
): IntradayReplayIocCoreFailure => ({ _tag: 'InvalidIntradayReplayCoreInput', field, value, reason })

const modelQuantityIncrement = (value: string): bigint | undefined => {
  if (!isPositiveMicros(value)) return undefined
  const parsed = BigInt(value)
  return parsed <= U128_MAX ? parsed : undefined
}

export const simulateIntradayReplayIocCore = (
  input: IntradayReplayIocCoreInput,
): Result.Result<IntradayReplayIocCoreOutcome, IntradayReplayIocCoreFailure> => {
  const { order, quote, assumptions, executionModel: model } = input
  if (
    (order.side !== OrderSide.Buy && order.side !== OrderSide.Sell) ||
    order.quantityMicros <= 0n ||
    order.quantityMicros % MICROS !== 0n ||
    order.limitPriceMicros <= 0n
  ) {
    return Result.fail(invalid('order', order, 'invalid-order'))
  }
  if (quote.priceMicros <= 0n || quote.displayedQuantityMicros < 0n) {
    return Result.fail(invalid('quote', quote, 'invalid-quote'))
  }
  if (
    !Number.isSafeInteger(assumptions.slippageBps) ||
    assumptions.slippageBps < 0 ||
    assumptions.slippageBps > 10_000 ||
    !Number.isSafeInteger(assumptions.availableLiquidityPpm) ||
    assumptions.availableLiquidityPpm <= 0 ||
    assumptions.availableLiquidityPpm > 1_000_000
  ) {
    return Result.fail(invalid('assumptions', assumptions, 'invalid-assumptions'))
  }
  const quantityIncrement = modelQuantityIncrement(model.precision.quantityIncrementMicros)
  if (
    model.schemaVersion !== 'bayn.execution-model.v5' ||
    model.venue !== 'alpaca-us-equity' ||
    model.assetClass !== 'us-equity' ||
    model.order.type !== 'limit' ||
    model.order.timeInForce !== 'ioc' ||
    model.order.extendedHours !== false ||
    quantityIncrement !== MICROS ||
    model.precision.priceIncrementMicros !== '100'
  ) {
    return Result.fail(invalid('executionModel', model, 'invalid-execution-model'))
  }

  const slippage = BigInt(assumptions.slippageBps)
  const adverseNumerator = quote.priceMicros * (order.side === OrderSide.Buy ? BPS + slippage : BPS - slippage)
  const adversePrice =
    order.side === OrderSide.Buy
      ? quantizeAlpacaLimitPriceMicros((adverseNumerator + BPS - 1n) / BPS, 'UP')
      : quantizeAlpacaLimitPriceMicros(adverseNumerator / BPS, 'DOWN')
  const cancel = (
    reason: CoreCancelReason,
  ): Result.Result<IntradayReplayIocCoreOutcome, IntradayReplayIocCoreFailure> =>
    Result.succeed({
      status: 'canceled',
      requestedQuantityMicros: order.quantityMicros,
      filledQuantityMicros: 0n,
      reason,
      unfilledRemainder: 'canceled',
    })
  if (
    (order.side === OrderSide.Buy && adversePrice > order.limitPriceMicros) ||
    (order.side === OrderSide.Sell && adversePrice < order.limitPriceMicros)
  ) {
    return cancel('adverse-price-exceeds-limit')
  }
  const liquidity = (quote.displayedQuantityMicros * BigInt(assumptions.availableLiquidityPpm)) / PPM
  const fillQuantity = (liquidity / quantityIncrement) * quantityIncrement
  const requestedOrAvailable = fillQuantity < order.quantityMicros ? fillQuantity : order.quantityMicros
  if (requestedOrAvailable === 0n) {
    return cancel(liquidity === 0n ? 'no-displayed-liquidity' : 'zero-after-whole-share-rounding')
  }
  return notionalMicros(requestedOrAvailable, adversePrice).pipe(
    Result.mapError(() =>
      invalid('notional', { quantityMicros: requestedOrAvailable, priceMicros: adversePrice }, 'invalid-notional'),
    ),
    Result.map(
      (fillNotionalMicros): IntradayReplayIocCoreOutcome => ({
        status: 'filled',
        requestedQuantityMicros: order.quantityMicros,
        filledQuantityMicros: requestedOrAvailable,
        fillPriceMicros: adversePrice,
        fillNotionalMicros,
        unfilledRemainder: requestedOrAvailable < order.quantityMicros ? 'canceled' : 'none',
      }),
    ),
  )
}
