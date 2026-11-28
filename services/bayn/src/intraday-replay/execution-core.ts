import { Result, Schema } from 'effect'

import { quantizeInstrumentPriceMicros } from '../broker/alpaca-price'
import { InstrumentSymbolSchema, instrumentMarket, type Instrument } from '../instruments'
import { OrderSide } from '../execution/contracts'
import { notionalMicros } from '../strategy/execution-model/fixed-point'
import { PositiveMicrosSchema } from '../schemas'
import type { IntradayMomentumProtocol } from '../strategy/intraday-momentum/protocol'

export interface ReplayExecutionAssumptions {
  readonly slippageBps: number
  readonly availableLiquidityPpm: number
}

const BPS = 10_000n
const PPM = 1_000_000n
const U128_MAX = (1n << 128n) - 1n
const isPositiveMicros = Schema.is(PositiveMicrosSchema)
export const ReplayInstrumentsSchema = Schema.Record(
  InstrumentSymbolSchema,
  Schema.Struct({
    minimumQuantityAtoms: PositiveMicrosSchema,
    quantityIncrementAtoms: PositiveMicrosSchema,
    priceIncrementAtoms: PositiveMicrosSchema,
  }),
)

export const replayInstrument = (
  symbol: string,
  instruments: typeof ReplayInstrumentsSchema.Type,
): Result.Result<Instrument, ReplayExecutionFailure> => {
  const terms = instruments[symbol]
  if (terms === undefined) return Result.fail(invalid('instrument', symbol, 'invalid-execution-model'))
  return Result.succeed({
    symbol,
    market: instrumentMarket(symbol),
    minimumQuantityAtoms: BigInt(terms.minimumQuantityAtoms),
    quantityIncrementAtoms: BigInt(terms.quantityIncrementAtoms),
    priceIncrementAtoms: BigInt(terms.priceIncrementAtoms),
  })
}

type CoreCancelReason = 'adverse-price-exceeds-limit' | 'no-displayed-liquidity' | 'zero-after-instrument-rounding'

export interface ReplayExecutionOrder {
  readonly side: OrderSide
  readonly quantityAtoms: bigint
  readonly limitPriceMicros: bigint
}

/** Executable quote values selected from one event-time market snapshot. */
export interface ReplayExecutionQuote {
  readonly priceMicros: bigint
  readonly displayedQuantityAtoms: bigint
}

export interface ReplayExecutionInput {
  readonly instrument: Instrument
  readonly order: ReplayExecutionOrder
  readonly quote: ReplayExecutionQuote
  readonly executionModel: IntradayMomentumProtocol['executionModel']
  readonly assumptions: ReplayExecutionAssumptions
}

export type ReplayExecutionOutcome =
  | {
      readonly status: 'filled'
      readonly requestedQuantityAtoms: bigint
      readonly filledQuantityAtoms: bigint
      readonly fillPriceMicros: bigint
      readonly fillNotionalMicros: bigint
      readonly remainingQuantityAtoms: bigint
    }
  | {
      readonly status: 'unfilled'
      readonly adversePriceMicros: bigint
      readonly requestedQuantityAtoms: bigint
      readonly filledQuantityAtoms: bigint
      readonly reason: 'adverse-price-exceeds-limit' | 'no-displayed-liquidity' | 'zero-after-instrument-rounding'
      readonly remainingQuantityAtoms: bigint
    }

export interface ReplayExecutionFailure {
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

const invalid = (field: string, value: unknown, reason: ReplayExecutionFailure['reason']): ReplayExecutionFailure => ({
  _tag: 'InvalidIntradayReplayCoreInput',
  field,
  value,
  reason,
})

const modelQuantityIncrement = (value: string): bigint | undefined => {
  if (!isPositiveMicros(value)) return undefined
  const parsed = BigInt(value)
  return parsed <= U128_MAX ? parsed : undefined
}

export const simulateIntradayReplayExecution = (
  input: ReplayExecutionInput,
): Result.Result<ReplayExecutionOutcome, ReplayExecutionFailure> => {
  const { order, quote, assumptions, executionModel: model, instrument } = input
  const quantityIncrement = instrument.quantityIncrementAtoms
  if (
    (order.side !== OrderSide.Buy && order.side !== OrderSide.Sell) ||
    order.quantityAtoms <= 0n ||
    quantityIncrement <= 0n ||
    order.quantityAtoms % quantityIncrement !== 0n ||
    order.limitPriceMicros <= 0n ||
    (order.side === OrderSide.Buy && order.quantityAtoms < instrument.minimumQuantityAtoms)
  ) {
    return Result.fail(invalid('order', order, 'invalid-order'))
  }
  if (quote.priceMicros <= 0n || quote.displayedQuantityAtoms < 0n) {
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
  const modelIncrement = modelQuantityIncrement(model.precision.quantityIncrementAtoms)
  if (
    model.schemaVersion !== 'bayn.execution-model.v6' ||
    model.venue !== 'alpaca-cash-spot' ||
    model.assetClass !== 'cash-spot' ||
    model.order.type !== 'limit' ||
    model.order.timeInForce !== 'asset-session' ||
    model.order.extendedHours !== 'equity-data-session' ||
    modelIncrement !== 1n ||
    quantityIncrement === undefined ||
    model.precision.priceIncrementMicros !== '100'
  ) {
    return Result.fail(invalid('executionModel', model, 'invalid-execution-model'))
  }

  if (
    instrument.priceIncrementAtoms <= 0n ||
    (instrument.priceIncrementAtoms >= 1000n && instrument.priceIncrementAtoms % 1000n !== 0n)
  )
    return Result.fail(
      invalid('instrument.priceIncrementAtoms', instrument.priceIncrementAtoms, 'invalid-execution-model'),
    )
  const priceIncrement = instrument.priceIncrementAtoms < 1000n ? 1n : instrument.priceIncrementAtoms / 1000n
  const slippage = BigInt(assumptions.slippageBps)
  const adverseNumerator = quote.priceMicros * (order.side === OrderSide.Buy ? BPS + slippage : BPS - slippage)
  const quotedAdversePrice =
    order.side === OrderSide.Buy
      ? quantizeInstrumentPriceMicros(instrument.symbol, (adverseNumerator + BPS - 1n) / BPS, 'UP')
      : quantizeInstrumentPriceMicros(instrument.symbol, adverseNumerator / BPS, 'DOWN')
  const adversePrice =
    order.side === OrderSide.Buy
      ? ((quotedAdversePrice + priceIncrement - 1n) / priceIncrement) * priceIncrement
      : (quotedAdversePrice / priceIncrement) * priceIncrement
  const cancel = (reason: CoreCancelReason): Result.Result<ReplayExecutionOutcome, ReplayExecutionFailure> =>
    Result.succeed({
      status: 'unfilled',
      adversePriceMicros: adversePrice,
      requestedQuantityAtoms: order.quantityAtoms,
      filledQuantityAtoms: 0n,
      reason,
      remainingQuantityAtoms: order.quantityAtoms,
    })
  if (
    (order.side === OrderSide.Buy && adversePrice > order.limitPriceMicros) ||
    (order.side === OrderSide.Sell && adversePrice < order.limitPriceMicros)
  ) {
    return cancel('adverse-price-exceeds-limit')
  }
  const liquidity = (quote.displayedQuantityAtoms * BigInt(assumptions.availableLiquidityPpm)) / PPM
  const fillQuantity = (liquidity / quantityIncrement) * quantityIncrement
  const requestedOrAvailable = fillQuantity < order.quantityAtoms ? fillQuantity : order.quantityAtoms
  if (requestedOrAvailable === 0n) {
    return cancel(liquidity === 0n ? 'no-displayed-liquidity' : 'zero-after-instrument-rounding')
  }
  return notionalMicros(requestedOrAvailable, adversePrice).pipe(
    Result.mapError(() =>
      invalid('notional', { quantityAtoms: requestedOrAvailable, priceMicros: adversePrice }, 'invalid-notional'),
    ),
    Result.map(
      (fillNotionalMicros): ReplayExecutionOutcome => ({
        status: 'filled',
        requestedQuantityAtoms: order.quantityAtoms,
        filledQuantityAtoms: requestedOrAvailable,
        fillPriceMicros: adversePrice,
        fillNotionalMicros,
        remainingQuantityAtoms: order.quantityAtoms - requestedOrAvailable,
      }),
    ),
  )
}
