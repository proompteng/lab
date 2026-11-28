import { Result, Schema } from 'effect'

import type { Order as BrokerOrder } from '../../broker/alpaca/model'
import { quantizeInstrumentPriceMicros } from '../../broker/alpaca-price'
import { OrderSide, OrderType } from '../../execution/contracts'
import { compareIntradayInstants } from '../../market-data/intraday/time'
import { quantityScale } from '../../quantity'
import { UtcSourceTimestampSchema } from '../../schemas'
import { BPS, MICROS } from '../execution-model/model'
import {
  type PassiveEntryExecutionError,
  type PassiveEntryMarket,
  type PassiveEntryPolicy,
  planPassiveEntryReanchor,
  pricePassiveEntry,
} from '../execution-model/passive-entry'
import { type EtfNoiseAreaPolicy, type EtfNoiseAreaSymbol, liveEtfNoiseAreaSymbols } from './policy'
import {
  NoiseAreaInputError,
  type NoiseAreaBreakout,
  type NoiseAreaExitSignal,
  type NoiseAreaPositionSide,
  type NoiseAreaVolatility,
} from './signals'

const ceilDiv = (numerator: bigint, denominator: bigint) => (numerator + denominator - 1n) / denominator
const min = (a: bigint, b: bigint) => (a < b ? a : b)
const exitSide = (side: NoiseAreaPositionSide) => (side === 'LONG' ? OrderSide.Sell : OrderSide.Buy)
const invalid = (message: string) => Result.fail(new NoiseAreaInputError({ message }))
const isUtc = Schema.is(UtcSourceTimestampSchema)

const passiveCohort = (policy: EtfNoiseAreaPolicy) => policy.symbols.length === liveEtfNoiseAreaSymbols.length

const inEntryCheckpoint = (signal: NoiseAreaBreakout, at: string) =>
  isUtc(at) &&
  isUtc(signal.checkpointAt) &&
  isUtc(signal.flattenAt) &&
  compareIntradayInstants(at, signal.checkpointAt) >= 0 &&
  compareIntradayInstants(at, signal.flattenAt) < 0 &&
  Date.parse(at) - Date.parse(signal.checkpointAt) < 60_000

const entryCollar = (policy: EtfNoiseAreaPolicy, signal: NoiseAreaBreakout) => {
  const { symbol, referencePriceMicros: reference } = signal
  const allowanceBps = BigInt(policy.entryLimitSlippageBps)
  const long = signal._tag === 'LongBreakout'
  const upside = reference * (BPS + allowanceBps)
  // Round into, not out of, the permitted collar. Reserve upside for either side.
  return {
    side: long ? OrderSide.Buy : OrderSide.Sell,
    grossReservePriceMicros: quantizeInstrumentPriceMicros(symbol, ceilDiv(upside, BPS), 'UP'),
    limitPriceMicros: long
      ? quantizeInstrumentPriceMicros(symbol, upside / BPS, 'DOWN')
      : quantizeInstrumentPriceMicros(symbol, ceilDiv(reference * (BPS - allowanceBps), BPS), 'UP'),
  } as const
}

export interface NoiseAreaEntryPlan {
  readonly symbol: EtfNoiseAreaSymbol
  readonly side: OrderSide
  readonly orderType: OrderType.Limit
  readonly limitPriceMicros: bigint
  readonly grossReservePriceMicros: bigint
  readonly quantityAtoms: bigint
  readonly reservedGrossMicros: bigint
  readonly checkpointAt: string
  readonly atr14Micros: bigint
  readonly exitRule: EtfNoiseAreaPolicy['exitRule']
  readonly flattenAt: string
}

const cohortWeights = (
  policy: EtfNoiseAreaPolicy,
  signals: ReadonlyMap<EtfNoiseAreaSymbol, NoiseAreaBreakout>,
  volatilityBySymbol: Readonly<Partial<Record<EtfNoiseAreaSymbol, NoiseAreaVolatility>>>,
) => {
  if (policy.sizing === 'equalWeight') return Result.succeed(policy.symbols.map(() => 1n))

  const values = []
  let commonDenominator = 1n
  for (const symbol of policy.symbols) {
    const value = signals.get(symbol) ?? volatilityBySymbol[symbol]
    if (value === undefined || value.sessionOpenPriceMicros <= 0n || value.atr14Micros <= 0n) {
      return invalid(`Inverse-volatility sizing requires causal open and ATR14 for ${symbol}`)
    }
    values.push(value)
    commonDenominator *= value.atr14Micros
  }
  // ATR as a fraction of the session open makes weights comparable across different share prices.
  return Result.succeed(
    values.map(({ atr14Micros, sessionOpenPriceMicros }) => (commonDenominator / atr14Micros) * sessionOpenPriceMicros),
  )
}

/**
 * Reserve gross across the full cohort, without reallocating an inactive member's budget.
 * Pass current absolute marked gross plus all outstanding entry reserves, including other strategies if any.
 * A short sale limit is a floor, not a maximum fill price: enforce actual gross again at execution/reconciliation.
 */
export const planNoiseAreaEntries = (input: {
  readonly policy: EtfNoiseAreaPolicy
  readonly signals: readonly NoiseAreaBreakout[]
  readonly capitalBudgetMicros: bigint
  readonly usedGrossMicros: bigint
  /** Inverse-volatility inputs for non-breakout cohort members, from the same decision snapshot. */
  readonly volatilityBySymbol?: Readonly<Partial<Record<EtfNoiseAreaSymbol, NoiseAreaVolatility>>>
  /** Separate opt-in; never included in frozen strategy parameters or inferred from exchange-only quotes. */
  readonly execution?: {
    readonly policy: PassiveEntryPolicy
    readonly marketBySymbol: Readonly<Partial<Record<EtfNoiseAreaSymbol, PassiveEntryMarket>>>
  }
}): Result.Result<readonly NoiseAreaEntryPlan[], NoiseAreaInputError | PassiveEntryExecutionError> =>
  Result.gen(function* () {
    const { policy, signals, capitalBudgetMicros, usedGrossMicros, execution } = input
    if (capitalBudgetMicros < 0n || usedGrossMicros < 0n)
      return yield* invalid('Gross budget and usage must be nonnegative')
    if (execution !== undefined && !passiveCohort(policy)) {
      return yield* invalid('Passive ETF entry execution requires the QQQ/SMH cohort')
    }
    const budget = min(capitalBudgetMicros, BigInt(policy.maximumGrossUsd) * MICROS)
    if (usedGrossMicros >= budget || signals.length === 0) return []

    const bySymbol = new Map<EtfNoiseAreaSymbol, NoiseAreaBreakout>()
    for (const signal of signals) {
      if (
        !policy.symbols.some((member) => member === signal.symbol) ||
        bySymbol.has(signal.symbol) ||
        signal.referencePriceMicros <= 0n ||
        signal.atr14Micros <= 0n ||
        signal.checkpointAt !== signals[0]?.checkpointAt ||
        signal.flattenAt !== signals[0]?.flattenAt ||
        signal.checkpointAt >= signal.flattenAt
      )
        return yield* invalid(`Invalid, mixed-checkpoint or duplicate breakout for ${signal.symbol}`)
      bySymbol.set(signal.symbol, signal)
    }
    const weights = yield* cohortWeights(policy, bySymbol, input.volatilityBySymbol ?? {})
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n)

    let remaining = budget - usedGrossMicros
    const plans: NoiseAreaEntryPlan[] = []
    for (const [index, symbol] of policy.symbols.entries()) {
      const signal = bySymbol.get(symbol)
      const weight = weights[index]
      if (signal === undefined || weight === undefined) continue
      const {
        side,
        limitPriceMicros: adverseLimitMicros,
        grossReservePriceMicros: collarReserve,
      } = entryCollar(policy, signal)
      let limitPriceMicros = adverseLimitMicros
      const reference = signal.referencePriceMicros
      if (
        limitPriceMicros <= 0n ||
        (side === OrderSide.Buy ? limitPriceMicros < reference : limitPriceMicros > reference)
      )
        continue
      if (execution !== undefined) {
        const market = execution.marketBySymbol[symbol]
        if (market === undefined || !inEntryCheckpoint(signal, market.cut.observedAt)) continue
        const price = yield* pricePassiveEntry({ policy: execution.policy, symbol, side, adverseLimitMicros, market })
        if (price._tag === 'Defer') continue
        limitPriceMicros = price.limitPriceMicros
      }
      // A better short-sale limit may itself exceed the original gross reserve.
      const grossReservePriceMicros = limitPriceMicros > collarReserve ? limitPriceMicros : collarReserve

      const shares = min((budget * weight) / totalWeight, remaining) / grossReservePriceMicros
      if (shares === 0n) continue
      const reservedGrossMicros = shares * grossReservePriceMicros
      const plan: NoiseAreaEntryPlan = {
        symbol,
        side,
        orderType: OrderType.Limit,
        limitPriceMicros,
        grossReservePriceMicros,
        quantityAtoms: shares * quantityScale,
        reservedGrossMicros,
        checkpointAt: signal.checkpointAt,
        atr14Micros: signal.atr14Micros,
        exitRule: policy.exitRule,
        flattenAt: signal.flattenAt,
      }
      if (Result.isFailure(planNoiseAreaProtection(policy, plan, limitPriceMicros))) continue
      plans.push(plan)
      remaining -= reservedGrossMicros
    }
    return plans
  })

/** Keep discretionary repricing within the original checkpoint lease, never extending an entry's lifetime. */
export const planNoiseAreaEntryReanchor = (input: {
  readonly policy: EtfNoiseAreaPolicy
  readonly signal: NoiseAreaBreakout
  readonly executionPolicy: PassiveEntryPolicy
  readonly market: PassiveEntryMarket
  readonly order: BrokerOrder
}) => {
  const { policy, signal, executionPolicy, market, order } = input
  if (
    !passiveCohort(policy) ||
    !policy.symbols.some((symbol) => symbol === signal.symbol) ||
    !inEntryCheckpoint(signal, market.cut.observedAt) ||
    order.submittedAt === undefined ||
    !inEntryCheckpoint(signal, order.submittedAt)
  )
    return Result.succeed({ _tag: 'Keep' } as const)

  const { side, limitPriceMicros: adverseLimitMicros } = entryCollar(policy, signal)
  return planPassiveEntryReanchor({
    policy: executionPolicy,
    symbol: signal.symbol,
    side,
    adverseLimitMicros,
    market,
    order,
  })
}

/** Protective leg for the reconciled fill, not the signal close or an assumed fill at the entry limit. */
export const planNoiseAreaProtection = (
  policy: EtfNoiseAreaPolicy,
  entry: NoiseAreaEntryPlan,
  fillPriceMicros: bigint,
) => {
  if (fillPriceMicros <= 0n || entry.atr14Micros <= 0n) return invalid('Protection requires a positive fill and ATR14')
  const long = entry.side === OrderSide.Buy
  const stopMultipleTenths = BigInt(policy.protectiveStopAtrMultiple * 10)
  const distance = (entry.atr14Micros * stopMultipleTenths) / 10n
  const rawStop = long ? fillPriceMicros - distance : fillPriceMicros + distance
  if (rawStop <= 0n) return invalid('ATR14 leaves no positive protective trigger')
  const stopPriceMicros = quantizeInstrumentPriceMicros(entry.symbol, rawStop, long ? 'UP' : 'DOWN')
  if (long ? stopPriceMicros >= fillPriceMicros : stopPriceMicros <= fillPriceMicros) {
    return invalid('No executable protective trigger between the ATR level and the fill')
  }

  // max(50 bp of the trigger, quarter ATR), capped at 150 bp of the trigger. Keep fractional bps until tick rounding.
  const floor = stopPriceMicros * BigInt(policy.minimumStopLimitCollarBps)
  const cap = stopPriceMicros * BigInt(policy.maximumStopLimitCollarBps)
  const adaptive = entry.atr14Micros * BigInt(policy.stopLimitAtrMultiple * Number(BPS))
  const collar = min(cap, adaptive > floor ? adaptive : floor)
  const rawLimit = stopPriceMicros * BPS + (long ? -collar : collar)
  const stopLimitPriceMicros = quantizeInstrumentPriceMicros(
    entry.symbol,
    long ? ceilDiv(rawLimit, BPS) : rawLimit / BPS,
    long ? 'UP' : 'DOWN',
  )
  return Result.succeed({
    symbol: entry.symbol,
    side: exitSide(long ? 'LONG' : 'SHORT'),
    orderType: OrderType.StopLimit as const,
    stopPriceMicros,
    stopLimitPriceMicros,
    flattenAt: entry.flattenAt,
  })
}

/** The owner must cancel/reconcile working orders and reprice the remaining reduction before submission. */
export const planNoiseAreaExit = (signal: NoiseAreaExitSignal) =>
  ({
    symbol: signal.symbol,
    side: exitSide(signal.side),
    reason: signal._tag,
    reduceOnly: true,
    flattenAt: signal.flattenAt,
  }) as const
