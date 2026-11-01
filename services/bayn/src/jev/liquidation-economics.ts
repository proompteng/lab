import { cryptoMaximumTakerFeeBps } from '../broker/crypto-fees'
import { Result } from 'effect'

import { OrderSide, OrderType } from '../execution/contracts'
import { deriveExecutionIntentPricing } from '../execution/intent-pricing'
import { cashSpotLimitTimeInForce } from '../execution/order-terms'
import { instrumentMarket, MarketKind } from '../instruments'
import { quantityScale } from '../quantity'
import { calculateSessionFees, cryptoTakerFeeSchedule } from '../strategy/execution-model/fees'
import { scaledNumber } from '../strategy/execution-model/fixed-point'
import { JevContractError } from './contract'
import type { JevProtocolMaterial } from './protocol'

interface LiquidationInput {
  readonly protocol: JevProtocolMaterial
  readonly symbol: string
  readonly costMultiplierMicros?: bigint
  readonly quantityAtoms: bigint
}

export const jevExitLimitValue = (input: LiquidationInput & { readonly limitPriceMicros: bigint }) =>
  Result.gen(function* () {
    if (input.limitPriceMicros <= 0n || input.quantityAtoms <= 0n)
      return yield* Result.fail(new JevContractError({ message: 'An exit limit and quantity must be positive' }))
    const proceedsMicros = (input.limitPriceMicros * input.quantityAtoms) / quantityScale
    const fees = yield* calculateSessionFees(
      [{ symbol: input.symbol, side: 'sell', quantityAtoms: input.quantityAtoms, notionalMicros: proceedsMicros }],
      input.protocol.executionModel,
      input.costMultiplierMicros ?? 1_000_000n,
      cryptoMaximumTakerFeeBps,
    )
    const schedule = input.protocol.executionModel.fees
    const crypto = instrumentMarket(input.symbol) === MarketKind.Crypto
    const variableRate = crypto
      ? BigInt(cryptoTakerFeeSchedule.takerBps) * 1_000_000n
      : (yield* scaledNumber(schedule.commissionBps, 'commission bps')) +
        (yield* scaledNumber(schedule.secSellBps, 'SEC sell bps'))
    const roundingReserve = crypto
      ? BigInt(cryptoTakerFeeSchedule.cashRoundingMicros)
      : BigInt(schedule.roundingIncrementMicros) *
        BigInt(Number(schedule.commissionBps > 0) + Number(schedule.secSellBps > 0))
    const fixedFees = crypto ? 0n : fees.cashMicros - fees.commissionMicros - fees.secMicros
    // One combined linear rate plus rounding reserves bounds stepped fees without making net cash decrease.
    const conservativeFees =
      fixedFees +
      (proceedsMicros * variableRate * (input.costMultiplierMicros ?? 1_000_000n)) / 10_000_000_000_000_000n +
      roundingReserve
    return {
      proceedsMicros,
      feesMicros: fees.cashMicros,
      netMicros: proceedsMicros - fees.cashMicros,
      conservativeNetMicros: proceedsMicros - conservativeFees,
    }
  }).pipe(
    Result.mapError(
      (cause) => new JevContractError({ message: 'Jev exit-limit economics could not be estimated', cause }),
    ),
  )

export const jevLiquidationValue = (input: LiquidationInput & { readonly bidMicros: bigint }) =>
  Result.gen(function* () {
    const pricing = yield* deriveExecutionIntentPricing({
      symbol: input.symbol,
      side: OrderSide.Sell,
      orderType: OrderType.Limit,
      timeInForce: cashSpotLimitTimeInForce(instrumentMarket(input.symbol)),
      quantityAtoms: input.quantityAtoms,
      referencePriceMicros: input.bidMicros,
      limitSlippageBps: BigInt(input.protocol.maximumEntryLimitSlippageBps),
    })
    return yield* jevExitLimitValue({ ...input, limitPriceMicros: pricing.expectedExecutionPriceMicros })
  }).pipe(
    Result.mapError(
      (cause) => new JevContractError({ message: 'Jev liquidation economics could not be estimated', cause }),
    ),
  )

const breakEvenExitPrice = (
  acquisitionCostMicros: bigint,
  upperPriceMicros: bigint,
  value: (price: bigint) => ReturnType<typeof jevExitLimitValue>,
  unavailableMessage: string,
) =>
  Result.gen(function* () {
    let low = 1n
    let high = upperPriceMicros
    if ((yield* value(high)).conservativeNetMicros < acquisitionCostMicros)
      return yield* Result.fail(new JevContractError({ message: unavailableMessage }))
    while (low < high) {
      const middle = (low + high) / 2n
      if ((yield* value(middle)).conservativeNetMicros >= acquisitionCostMicros) high = middle
      else low = middle + 1n
    }
    return low
  })

export const jevBreakEvenExitBid = (
  input: LiquidationInput & { readonly acquisitionCostMicros: bigint; readonly upperBidMicros: bigint },
) =>
  breakEvenExitPrice(
    input.acquisitionCostMicros,
    input.upperBidMicros,
    (bidMicros) => jevLiquidationValue({ ...input, bidMicros }),
    'Liquidation has no bounded break-even bid',
  )

export const jevBreakEvenExitLimitPrice = (
  input: LiquidationInput & { readonly acquisitionCostMicros: bigint; readonly upperLimitPriceMicros: bigint },
) =>
  breakEvenExitPrice(
    input.acquisitionCostMicros,
    input.upperLimitPriceMicros,
    (limitPriceMicros) => jevExitLimitValue({ ...input, limitPriceMicros }),
    'Exit limit has no bounded break-even price',
  )
