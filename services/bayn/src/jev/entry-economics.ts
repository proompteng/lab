import { Result } from 'effect'

import { deriveExecutionIntentPricing } from '../execution/intent-pricing'
import { OrderSide, OrderType } from '../execution/contracts'
import { cashSpotLimitTimeInForce } from '../execution/order-terms'
import { instrumentMarket } from '../instruments'
import { quantityScale } from '../quantity'
import { calculateSessionFees, receivedCryptoFee } from '../strategy/execution-model/fees'
import { JevContractError } from './contract'
import { maximumAllocatedBuyQuantities } from './entry-sizing'
import { jevHoldingMinutesForSymbol } from './markets'
import { jevBreakEvenExitBid, jevBreakEvenExitLimitPrice, jevExitLimitValue } from './liquidation-economics'
import type { JevProtocol } from './protocol'
import type { JevFundedExitPlan, JevStrategyExitPlan } from './strategy-exit-plan'

export const jevMaximumEntryAskMicros = (protocol: JevProtocol, observedAsk: bigint): bigint =>
  (observedAsk * BigInt(10_000 + protocol.maximumEntryQuoteDriftBps)) / 10_000n

export const jevEntryEconomics = (input: {
  readonly protocol: JevProtocol
  readonly symbol: string
  readonly bidMicros: bigint
  readonly askMicros: bigint
  readonly capitalMicros: string
}) =>
  Result.gen(function* () {
    const { protocol, symbol } = input
    const maximumAsk = jevMaximumEntryAskMicros(protocol, input.askMicros)
    const maximumEntryPrice = (yield* deriveExecutionIntentPricing({
      symbol,
      side: OrderSide.Buy,
      orderType: OrderType.Limit,
      timeInForce: cashSpotLimitTimeInForce(instrumentMarket(symbol)),
      quantityAtoms: quantityScale,
      referencePriceMicros: maximumAsk,
      limitSlippageBps: BigInt(protocol.maximumEntryLimitSlippageBps),
    })).expectedExecutionPriceMicros
    const maximumTargetWeight = Math.min(protocol.maximumGrossWeight, protocol.maximumSymbolWeight)
    const quantities = yield* maximumAllocatedBuyQuantities({
      askPriceMicros: { [symbol]: maximumEntryPrice.toString() },
      targetWeights: { [symbol]: maximumTargetWeight },
      capitalMicros: input.capitalMicros,
      precision: protocol.executionModel.precision,
    })
    const quantity = BigInt(quantities[symbol] ?? '0')
    if (quantity <= 0n) return null
    const buy = {
      symbol,
      side: 'buy' as const,
      quantityAtoms: quantity,
      notionalMicros: (maximumEntryPrice * quantity + quantityScale - 1n) / quantityScale,
    }
    const fees = yield* calculateSessionFees([buy], protocol.executionModel, 1_000_000n)
    const received = quantity - receivedCryptoFee(buy, 1_000_000n).quantityAtoms
    if (received <= 0n) return null
    const acquisitionCost = buy.notionalMicros + fees.cashMicros
    const breakEvenBid = yield* jevBreakEvenExitBid({
      protocol,
      symbol,
      quantityAtoms: received,
      acquisitionCostMicros: acquisitionCost,
      upperBidMicros: maximumEntryPrice * 2n,
    })
    const breakEvenLimit = yield* jevBreakEvenExitLimitPrice({
      protocol,
      symbol,
      quantityAtoms: received,
      acquisitionCostMicros: acquisitionCost,
      upperLimitPriceMicros: maximumEntryPrice * 2n,
    })
    return {
      maximumEntryPriceMicros: maximumEntryPrice.toString(),
      maximumQuantityAtoms: quantity.toString(),
      maximumTargetWeight,
      acquisitionCostMicros: acquisitionCost.toString(),
      receivedQuantityAtoms: received.toString(),
      maximumEntryPriceUsd: Number(maximumEntryPrice) / 1_000_000,
      assumedEntryQuantity: Number(quantity) / Number(quantityScale),
      estimatedEntryFeesUsd: Number(fees.totalMicros) / 1_000_000,
      holdingExitBreakEvenBidUsd: Number(breakEvenBid) / 1_000_000,
      holdingExitRequiredBidRiseBps: Number(((breakEvenBid - input.bidMicros) * 10_000_000n) / input.bidMicros) / 1000,
      takeProfitBreakEvenLimitUsd: Number(breakEvenLimit) / 1_000_000,
      takeProfitRequiredBidRiseBps: Number(((breakEvenLimit - input.bidMicros) * 10_000_000n) / input.bidMicros) / 1000,
      maximumHoldingMinutes: jevHoldingMinutesForSymbol(protocol, symbol),
      maximumEntryQuoteDriftBps: protocol.maximumEntryQuoteDriftBps,
      maximumEntryLimitSlippageBps: protocol.maximumEntryLimitSlippageBps,
      operatingCostCoverage: 'UNKNOWN',
    }
  }).pipe(
    Result.mapError((cause) => new JevContractError({ message: 'Jev entry economics could not be estimated', cause })),
  )

export type JevEntryEconomics = NonNullable<Result.Result.Success<ReturnType<typeof jevEntryEconomics>>>

export const fundJevTradePlan = (input: {
  readonly protocol: JevProtocol
  readonly economics: JevEntryEconomics
  readonly levels: JevStrategyExitPlan
}) =>
  Result.gen(function* () {
    const { protocol, economics, levels } = input
    const liquidation = { protocol, symbol: levels.symbol, quantityAtoms: BigInt(economics.receivedQuantityAtoms) }
    const stop = yield* jevExitLimitValue({ ...liquidation, limitPriceMicros: BigInt(levels.stopLimitPriceMicros) })
    const target = yield* jevExitLimitValue({ ...liquidation, limitPriceMicros: BigInt(levels.profitLimitPriceMicros) })
    const acquisition = BigInt(economics.acquisitionCostMicros)
    if (
      stop.conservativeNetMicros <= 0n ||
      stop.conservativeNetMicros >= acquisition ||
      target.conservativeNetMicros <= acquisition
    )
      return null
    const exitPlan: JevFundedExitPlan = {
      schemaVersion: 'bayn.jev-funded-exit-plan.v3',
      levels,
      maximumQuantityAtoms: economics.maximumQuantityAtoms,
      acquisitionCostMicros: economics.acquisitionCostMicros,
      estimatedStopNetMicros: stop.conservativeNetMicros.toString(),
      estimatedTargetNetMicros: target.conservativeNetMicros.toString(),
    }
    return { maximumTargetWeight: economics.maximumTargetWeight, exitPlan }
  })
