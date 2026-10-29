import { Result } from 'effect'
import { cryptoMaximumTakerFeeBps, cryptoTakerFeeBps, type CryptoFeeTier } from '../broker/crypto-fees'
import { quantizeInstrumentPriceMicros } from '../broker/alpaca-price'

import { deriveExecutionIntentPricing } from '../execution/intent-pricing'
import { OrderSide, OrderType } from '../execution/contracts'
import { cashSpotLimitTimeInForce } from '../execution/order-terms'
import { instrumentMarket, MarketKind } from '../instruments'
import { quantityScale } from '../quantity'
import { calculateSessionFees, receivedCryptoFee } from '../strategy/execution-model/fees'
import { JevContractError } from './contract'
import { maximumAllocatedBuyQuantities } from './entry-sizing'
import { jevBreakEvenExitBid, jevBreakEvenExitLimitPrice } from './liquidation-economics'
import type { JevProtocolMaterial } from './protocol'

export const jevEntryPriceAllowances = (protocol: JevProtocolMaterial, symbol: string) =>
  // Retired protocols retain their original price arithmetic for immutable financial evidence.
  protocol.schemaVersion === 'bayn.jev.protocol.v30' ||
  protocol.schemaVersion === 'bayn.jev.protocol.v29' ||
  protocol.schemaVersion === 'bayn.jev.protocol.v28' ||
  (protocol.schemaVersion === 'bayn.jev.protocol.v27' && instrumentMarket(symbol) === MarketKind.Crypto)
    ? { quoteDriftBps: 0, limitSlippageBps: 0 }
    : {
        quoteDriftBps: protocol.maximumEntryQuoteDriftBps,
        limitSlippageBps: protocol.maximumEntryLimitSlippageBps,
      }

export const jevMaximumEntryAskMicros = (
  protocol: JevProtocolMaterial,
  symbol: string,
  observedAsk: bigint,
): bigint => {
  const maximumAsk = (observedAsk * BigInt(10_000 + jevEntryPriceAllowances(protocol, symbol).quoteDriftBps)) / 10_000n
  return protocol.schemaVersion === 'bayn.jev.protocol.v30' ||
    protocol.schemaVersion === 'bayn.jev.protocol.v29' ||
    protocol.schemaVersion === 'bayn.jev.protocol.v28'
    ? quantizeInstrumentPriceMicros(symbol, maximumAsk, 'UP')
    : maximumAsk
}

export const jevEntryEconomics = (input: {
  readonly protocol: JevProtocolMaterial
  readonly symbol: string
  readonly bidMicros: bigint
  readonly askMicros: bigint
  readonly capitalMicros: string
  readonly cryptoFeeTier: CryptoFeeTier | null
}) =>
  Result.gen(function* () {
    const { protocol, symbol } = input
    const maximumAsk = jevMaximumEntryAskMicros(protocol, symbol, input.askMicros)
    const maximumEntryPrice = (yield* deriveExecutionIntentPricing({
      symbol,
      side: OrderSide.Buy,
      orderType: OrderType.Limit,
      timeInForce: cashSpotLimitTimeInForce(instrumentMarket(symbol)),
      quantityAtoms: quantityScale,
      referencePriceMicros: maximumAsk,
      limitSlippageBps: BigInt(jevEntryPriceAllowances(protocol, symbol).limitSlippageBps),
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
    const crypto = instrumentMarket(symbol) === MarketKind.Crypto
    const entryFeeTier = crypto ? input.cryptoFeeTier : null
    const entryTakerFeeBps = cryptoTakerFeeBps(entryFeeTier)
    const fees = yield* calculateSessionFees([buy], protocol.executionModel, 1_000_000n, entryTakerFeeBps)
    const received = quantity - receivedCryptoFee(buy, 1_000_000n, entryTakerFeeBps).quantityAtoms
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
      entryCryptoFeeTier: entryFeeTier,
      entryTakerFeeBps: crypto ? entryTakerFeeBps : 0,
      maximumExitTakerFeeBps: crypto ? cryptoMaximumTakerFeeBps : 0,
      holdingExitBreakEvenBidUsd: Number(breakEvenBid) / 1_000_000,
      holdingExitRequiredBidRiseBps: Number(((breakEvenBid - input.bidMicros) * 10_000_000n) / input.bidMicros) / 1000,
      takeProfitBreakEvenLimitUsd: Number(breakEvenLimit) / 1_000_000,
      takeProfitRequiredBidRiseBps: Number(((breakEvenLimit - input.bidMicros) * 10_000_000n) / input.bidMicros) / 1000,
      maximumHoldingMinutes: protocol.maximumHoldingMinutes,
      maximumEntryQuoteDriftBps: protocol.maximumEntryQuoteDriftBps,
      maximumEntryLimitSlippageBps: protocol.maximumEntryLimitSlippageBps,
      operatingCostCoverage: 'UNKNOWN',
    }
  }).pipe(
    Result.mapError((cause) => new JevContractError({ message: 'Jev entry economics could not be estimated', cause })),
  )

export type JevEntryEconomics = NonNullable<Result.Result.Success<ReturnType<typeof jevEntryEconomics>>>
