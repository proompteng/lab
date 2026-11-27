import { Result, Schema } from 'effect'

import { quantizeInstrumentPriceMicros } from '../../broker/alpaca-price'
import { cryptoMaximumTakerFeeBps } from '../../broker/crypto-fees'
import { OrderSide, OrderType } from '../../execution/contracts'
import { deriveExecutionIntentPricing } from '../../execution/intent-pricing'
import { cashSpotLimitTimeInForce } from '../../execution/order-terms'
import { canonicalHashV1Result } from '../../hash'
import { instrumentMarket, MarketKind } from '../../instruments'
import { JevContractError } from '../../jev/contract'
import { jevExitLimitValue } from '../../jev/liquidation-economics'
import type { reproduceJevCandidateObservation } from '../../jev/observation'
import type { IntradayAlphaTrailingBaseline } from '../../market-data/intraday/trailing-baseline'
import { shortCoverCostMicros } from '../../jev/short-entry'
import { quantityScale } from '../../quantity'
import {
  PositiveIntegerSchema,
  PositiveMicrosSchema,
  Sha256Schema,
  SignedMicrosSchema,
  SymbolSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../../schemas'
import { calculateSessionFees } from '../execution-model/fees'
import { desiredQuantityAtoms, priceNumberToMicros } from '../execution-model/fixed-point'
import { IntradayAlphaPhase, IntradayAlphaSetup } from './constants'
import type { IntradayAlphaPolicyMaterial } from './policy'
import { intradayAlphaV21StopLimitPriceMicros, type IntradayAlphaPolicyV21 } from './policy-v2-1'
import type { SelectedAlphaLeg } from './signals'

const HoldingMinutesSchema = PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(390))

const AlphaPlanSourceSchema = Schema.Struct({
  observationHash: Sha256Schema,
  policyHash: Sha256Schema,
  quoteHash: Sha256Schema,
  phase: Schema.Literals([
    IntradayAlphaPhase.MorningOrb,
    IntradayAlphaPhase.MiddayReversion,
    IntradayAlphaPhase.NoiseAreaTrend,
  ]),
  setup: Schema.Enum(IntradayAlphaSetup),
})

export const IntradayAlphaLongExitLevelsSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.intraday-alpha-long-exit-levels.v1'),
  rule: Schema.Literal('TWO_PHASE_INTRADAY_ALPHA_BRACKET'),
  planId: Sha256Schema,
  source: AlphaPlanSourceSchema,
  symbol: SymbolSchema,
  sourceStartAt: UtcInstantSchema,
  sourceEndAt: UtcInstantSchema,
  maximumHoldingMinutes: HoldingMinutesSchema,
  maximumEntryPriceMicros: PositiveMicrosSchema,
  stopPriceMicros: PositiveMicrosSchema,
  stopLimitPriceMicros: PositiveMicrosSchema,
  profitLimitPriceMicros: PositiveMicrosSchema,
}).check(
  Schema.makeFilter((plan) => {
    const { planId, ...material } = plan
    const hash = canonicalHashV1Result(material)
    return Result.isSuccess(hash) &&
      hash.success === planId &&
      instrumentMarket(plan.symbol) === MarketKind.Equity &&
      BigInt(plan.stopLimitPriceMicros) <= BigInt(plan.stopPriceMicros) &&
      BigInt(plan.stopPriceMicros) < BigInt(plan.maximumEntryPriceMicros) &&
      BigInt(plan.maximumEntryPriceMicros) < BigInt(plan.profitLimitPriceMicros) &&
      plan.sourceStartAt < plan.sourceEndAt
      ? []
      : [{ path: [], issue: 'intraday alpha long exit levels must be ordered and reproduce planId' }]
  }),
)

export const IntradayAlphaLongFundedExitPlanSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.intraday-alpha-long-funded-exit-plan.v1'),
  levels: IntradayAlphaLongExitLevelsSchema,
  maximumQuantityAtoms: PositiveMicrosSchema,
  acquisitionCostMicros: PositiveMicrosSchema,
  estimatedStopNetMicros: PositiveMicrosSchema,
  estimatedTargetNetMicros: PositiveMicrosSchema,
}).check(
  Schema.makeFilter((plan) =>
    BigInt(plan.maximumQuantityAtoms) % quantityScale === 0n &&
    BigInt(plan.estimatedStopNetMicros) < BigInt(plan.acquisitionCostMicros) &&
    BigInt(plan.acquisitionCostMicros) < BigInt(plan.estimatedTargetNetMicros)
      ? []
      : [
          {
            path: [],
            issue: 'intraday alpha long plan must fund whole shares with positive net target and loss bound',
          },
        ],
  ),
)
export type IntradayAlphaLongFundedExitPlan = typeof IntradayAlphaLongFundedExitPlanSchema.Type

export const IntradayAlphaShortExitLevelsSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.intraday-alpha-short-exit-levels.v1'),
  positionSide: Schema.Literal('SHORT'),
  rule: Schema.Literal('TWO_PHASE_INTRADAY_ALPHA_BRACKET'),
  planId: Sha256Schema,
  source: AlphaPlanSourceSchema,
  symbol: SymbolSchema,
  sourceStartAt: UtcInstantSchema,
  sourceEndAt: UtcInstantSchema,
  maximumHoldingMinutes: HoldingMinutesSchema,
  minimumEntryPriceMicros: PositiveMicrosSchema,
  stopPriceMicros: PositiveMicrosSchema,
  stopLimitPriceMicros: PositiveMicrosSchema,
  profitLimitPriceMicros: PositiveMicrosSchema,
}).check(
  Schema.makeFilter((plan) => {
    const { planId, ...material } = plan
    const hash = canonicalHashV1Result(material)
    return Result.isSuccess(hash) &&
      hash.success === planId &&
      instrumentMarket(plan.symbol) === MarketKind.Equity &&
      BigInt(plan.profitLimitPriceMicros) < BigInt(plan.minimumEntryPriceMicros) &&
      BigInt(plan.minimumEntryPriceMicros) < BigInt(plan.stopPriceMicros) &&
      BigInt(plan.stopPriceMicros) <= BigInt(plan.stopLimitPriceMicros) &&
      plan.sourceStartAt < plan.sourceEndAt
      ? []
      : [{ path: [], issue: 'intraday alpha short exit levels must be ordered and reproduce planId' }]
  }),
)

export const IntradayAlphaShortFundedExitPlanSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.intraday-alpha-short-funded-exit-plan.v1'),
  levels: IntradayAlphaShortExitLevelsSchema,
  maximumQuantityAtoms: PositiveMicrosSchema,
  saleNetProceedsMicros: PositiveMicrosSchema,
  collateralMicros: PositiveMicrosSchema,
  estimatedStopPnlMicros: SignedMicrosSchema,
  estimatedTargetPnlMicros: SignedMicrosSchema,
}).check(
  Schema.makeFilter((plan) =>
    BigInt(plan.maximumQuantityAtoms) % quantityScale === 0n &&
    BigInt(plan.estimatedStopPnlMicros) < 0n &&
    BigInt(plan.estimatedTargetPnlMicros) > 0n
      ? []
      : [
          {
            path: [],
            issue: 'intraday alpha short plan must fund whole shares with positive target pnl and loss bound',
          },
        ],
  ),
)
export type IntradayAlphaShortFundedExitPlan = typeof IntradayAlphaShortFundedExitPlanSchema.Type

export type IntradayAlphaFundedExitPlan = IntradayAlphaLongFundedExitPlan | IntradayAlphaShortFundedExitPlan

export type IntradayAlphaFundingObservation = Pick<
  Result.Result.Success<ReturnType<typeof reproduceJevCandidateObservation>>,
  'snapshot' | 'portfolio' | 'observedAt' | 'contentHash'
> & { readonly trailingBaseline?: IntradayAlphaTrailingBaseline }

const stopLimitPrice = (
  policy: IntradayAlphaPolicyMaterial | IntradayAlphaPolicyV21,
  observation: IntradayAlphaFundingObservation,
  leg: SelectedAlphaLeg,
  stop: bigint,
): bigint | null => {
  if (policy.schemaVersion === 'bayn.intraday-alpha-policy.v2_1') {
    const baseline = observation.trailingBaseline
    const volatility = baseline?.symbols[leg.symbol]
    if (
      baseline === undefined ||
      baseline.sessionDate !== observation.snapshot.manifest.sessionDate ||
      baseline.latestPriorSessionDate >= baseline.sessionDate ||
      baseline.lookbackSessions !== policy.trailingBaseline.lookbackSessions ||
      volatility === undefined ||
      volatility.priorSessions < policy.trailingBaseline.minimumSessions
    )
      return null
    return intradayAlphaV21StopLimitPriceMicros({
      collar: policy.stopLimitCollar,
      symbol: leg.symbol,
      direction: leg.direction,
      stopPriceMicros: stop,
      atr14Ratio: volatility.atr14Ratio,
    })
  }
  const slippage = BigInt(policy.entryLimitSlippageBps)
  return leg.direction === 'LONG'
    ? quantizeInstrumentPriceMicros(leg.symbol, (stop * (10_000n - slippage) + 9_999n) / 10_000n, 'UP')
    : quantizeInstrumentPriceMicros(leg.symbol, (stop * (10_000n + slippage)) / 10_000n, 'DOWN')
}

export const makeIntradayAlphaFundedExitPlan = (input: {
  readonly policy: IntradayAlphaPolicyMaterial | IntradayAlphaPolicyV21
  readonly observation: IntradayAlphaFundingObservation
  readonly leg: SelectedAlphaLeg
}): Result.Result<
  { readonly plan: IntradayAlphaFundedExitPlan; readonly signedWeight: number } | null,
  JevContractError
> =>
  Result.gen(function* () {
    const { policy, observation, leg } = input
    const protocol = policy.sharedProtocol
    const symbol = leg.symbol
    if (instrumentMarket(symbol) !== MarketKind.Equity) return null
    const quote = observation.snapshot.latestQuotes[symbol]
    if (quote === undefined)
      return yield* Result.fail(
        new JevContractError({ message: `Intraday alpha funding requires live quote liveness for ${symbol}` }),
      )
    const expectedLatestBarMs = Date.parse(observation.snapshot.manifest.rangeEndAt) - 60_000
    const latestBar = observation.snapshot.bars.find(
      (bar) => bar.symbol === symbol && Date.parse(bar.eventAt) === expectedLatestBarMs,
    )
    if (latestBar === undefined || !Number.isFinite(latestBar.close) || latestBar.close <= 0) return null
    const capitalMicros = BigInt(observation.portfolio.brokerState.account.equityMicros)
    if (capitalMicros <= 0n) return null
    const limitSlippageBps = BigInt(policy.entryLimitSlippageBps)
    const policyHash = yield* canonicalHashV1Result(policy)
    const quoteHash = yield* canonicalHashV1Result(quote)
    const source = {
      observationHash: observation.contentHash,
      policyHash,
      quoteHash,
      phase: leg.phase,
      setup: leg.setup,
    }

    if (leg.direction === 'LONG') {
      const barCloseUp = quantizeInstrumentPriceMicros(
        symbol,
        yield* priceNumberToMicros(latestBar.close, 'alpha bar close', 'UP'),
        'UP',
      )
      if (barCloseUp <= 0n) return null
      const maximumEntryPrice = (yield* deriveExecutionIntentPricing({
        symbol,
        side: OrderSide.Buy,
        orderType: OrderType.Limit,
        timeInForce: cashSpotLimitTimeInForce(MarketKind.Equity),
        quantityAtoms: quantityScale,
        referencePriceMicros: barCloseUp,
        limitSlippageBps,
      })).expectedExecutionPriceMicros
      const shares =
        (yield* desiredQuantityAtoms(capitalMicros, leg.targetWeight, maximumEntryPrice, {
          precision: { ...protocol.executionModel.precision, quantityIncrementAtoms: quantityScale.toString() },
        })) / quantityScale
      if (shares <= 0n) return null
      const quantityAtoms = shares * quantityScale
      const stop = quantizeInstrumentPriceMicros(
        symbol,
        (maximumEntryPrice * BigInt(10_000 - leg.protectiveStopBps)) / 10_000n,
        'DOWN',
      )
      const stopLimit = stopLimitPrice(policy, observation, leg, stop)
      const target = quantizeInstrumentPriceMicros(
        symbol,
        (maximumEntryPrice * BigInt(10_000 + leg.profitTargetBps) + 9_999n) / 10_000n,
        'UP',
      )
      if (
        stopLimit === null ||
        stopLimit <= 0n ||
        stopLimit > stop ||
        stop >= barCloseUp ||
        target <= maximumEntryPrice
      )
        return null
      const buyNotional = (maximumEntryPrice * quantityAtoms + quantityScale - 1n) / quantityScale
      const buyFees = yield* calculateSessionFees(
        [{ symbol, side: 'buy', quantityAtoms, notionalMicros: buyNotional }],
        protocol.executionModel,
        1_000_000n,
        cryptoMaximumTakerFeeBps,
        observation.observedAt,
      )
      const acquisitionCost = buyNotional + buyFees.cashMicros
      const stopValue = yield* jevExitLimitValue({
        protocol,
        feeAt: observation.observedAt,
        symbol,
        quantityAtoms,
        limitPriceMicros: stopLimit,
      })
      const targetValue = yield* jevExitLimitValue({
        protocol,
        feeAt: observation.observedAt,
        symbol,
        quantityAtoms,
        limitPriceMicros: target,
      })
      if (
        stopValue.conservativeNetMicros <= 0n ||
        stopValue.conservativeNetMicros >= acquisitionCost ||
        targetValue.conservativeNetMicros <= acquisitionCost
      )
        return null
      const levelsMaterial = {
        schemaVersion: 'bayn.intraday-alpha-long-exit-levels.v1' as const,
        rule: 'TWO_PHASE_INTRADAY_ALPHA_BRACKET' as const,
        source,
        symbol,
        sourceStartAt: observation.snapshot.manifest.rangeStartAt,
        sourceEndAt: observation.snapshot.manifest.rangeEndAt,
        maximumHoldingMinutes: leg.maximumHoldingMinutes,
        maximumEntryPriceMicros: maximumEntryPrice.toString(),
        stopPriceMicros: stop.toString(),
        stopLimitPriceMicros: stopLimit.toString(),
        profitLimitPriceMicros: target.toString(),
      }
      const plan = yield* Schema.decodeUnknownResult(
        IntradayAlphaLongFundedExitPlanSchema,
        strictParseOptions,
      )({
        schemaVersion: 'bayn.intraday-alpha-long-funded-exit-plan.v1',
        levels: { ...levelsMaterial, planId: yield* canonicalHashV1Result(levelsMaterial) },
        maximumQuantityAtoms: quantityAtoms.toString(),
        acquisitionCostMicros: acquisitionCost.toString(),
        estimatedStopNetMicros: stopValue.conservativeNetMicros.toString(),
        estimatedTargetNetMicros: targetValue.conservativeNetMicros.toString(),
      })
      return { plan, signedWeight: leg.targetWeight }
    }

    // SHORT leg funding anchored to completed 1m bar close
    const barCloseDown = quantizeInstrumentPriceMicros(
      symbol,
      yield* priceNumberToMicros(latestBar.close, 'alpha bar close', 'DOWN'),
      'DOWN',
    )
    if (barCloseDown <= 0n) return null
    const minimumEntryPrice = (yield* deriveExecutionIntentPricing({
      symbol,
      side: OrderSide.Sell,
      orderType: OrderType.Limit,
      timeInForce: cashSpotLimitTimeInForce(MarketKind.Equity),
      quantityAtoms: quantityScale,
      referencePriceMicros: barCloseDown,
      limitSlippageBps,
    })).expectedExecutionPriceMicros
    if (minimumEntryPrice <= 0n) return null
    const sharesByWeight =
      (yield* desiredQuantityAtoms(capitalMicros, leg.targetWeight, minimumEntryPrice, {
        precision: { ...protocol.executionModel.precision, quantityIncrementAtoms: quantityScale.toString() },
      })) / quantityScale
    const sharesByCollateral = (capitalMicros * 2n) / (minimumEntryPrice * 3n)
    const shares = sharesByWeight < sharesByCollateral ? sharesByWeight : sharesByCollateral
    if (shares <= 0n) return null
    const quantityAtoms = shares * quantityScale
    const notional = shares * minimumEntryPrice
    const sellFees = yield* calculateSessionFees(
      [{ symbol, side: 'sell', quantityAtoms, notionalMicros: notional }],
      protocol.executionModel,
      1_000_000n,
      cryptoMaximumTakerFeeBps,
      observation.observedAt,
    )
    const saleNetProceeds = notional - sellFees.cashMicros
    if (saleNetProceeds <= 0n) return null
    const stop = quantizeInstrumentPriceMicros(
      symbol,
      (minimumEntryPrice * BigInt(10_000 + leg.protectiveStopBps) + 9_999n) / 10_000n,
      'UP',
    )
    const stopLimit = stopLimitPrice(policy, observation, leg, stop)
    const target = quantizeInstrumentPriceMicros(
      symbol,
      (minimumEntryPrice * BigInt(10_000 - leg.profitTargetBps)) / 10_000n,
      'DOWN',
    )
    if (target <= 0n || target >= minimumEntryPrice || stop <= barCloseDown || stopLimit === null || stopLimit < stop)
      return null
    const stopCover = yield* shortCoverCostMicros({
      protocol,
      symbol,
      feeAt: observation.observedAt,
      quantityAtoms,
      priceMicros: stopLimit,
    })
    const targetCover = yield* shortCoverCostMicros({
      protocol,
      symbol,
      feeAt: observation.observedAt,
      quantityAtoms,
      priceMicros: target,
    })
    const estimatedStopPnl = saleNetProceeds - stopCover
    const estimatedTargetPnl = saleNetProceeds - targetCover
    if (estimatedStopPnl >= 0n || estimatedTargetPnl <= 0n) return null
    const levelsMaterial = {
      schemaVersion: 'bayn.intraday-alpha-short-exit-levels.v1' as const,
      positionSide: 'SHORT' as const,
      rule: 'TWO_PHASE_INTRADAY_ALPHA_BRACKET' as const,
      source,
      symbol,
      sourceStartAt: observation.snapshot.manifest.rangeStartAt,
      sourceEndAt: observation.snapshot.manifest.rangeEndAt,
      maximumHoldingMinutes: leg.maximumHoldingMinutes,
      minimumEntryPriceMicros: minimumEntryPrice.toString(),
      stopPriceMicros: stop.toString(),
      stopLimitPriceMicros: stopLimit.toString(),
      profitLimitPriceMicros: target.toString(),
    }
    const plan = yield* Schema.decodeUnknownResult(
      IntradayAlphaShortFundedExitPlanSchema,
      strictParseOptions,
    )({
      schemaVersion: 'bayn.intraday-alpha-short-funded-exit-plan.v1',
      levels: { ...levelsMaterial, planId: yield* canonicalHashV1Result(levelsMaterial) },
      maximumQuantityAtoms: quantityAtoms.toString(),
      saleNetProceedsMicros: saleNetProceeds.toString(),
      collateralMicros: ((notional * 3n + 1n) / 2n).toString(),
      estimatedStopPnlMicros: estimatedStopPnl.toString(),
      estimatedTargetPnlMicros: estimatedTargetPnl.toString(),
    })
    return { plan, signedWeight: -leg.targetWeight }
  }).pipe(
    Result.mapError(
      (cause) => new JevContractError({ message: 'Intraday alpha entry funding could not be established', cause }),
    ),
  )
