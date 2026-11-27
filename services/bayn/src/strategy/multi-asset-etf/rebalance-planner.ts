import { Result } from 'effect'

import { quantizeAlpacaLimitPriceMicros } from '../../broker/alpaca-price'
import { equityShortIsEligible, type EquityShortEligibility } from '../../execution/equity-short'
import { OrderSide } from '../../execution/contracts'
import { WEIGHT_SCALE } from '../execution-model/model'
import { multiAssetEtfTradables, type MultiAssetEtfPolicy, type MultiAssetEtfTradable } from './policy'
import { capEtfPortfolio, type MultiAssetEtfSignal } from './signals'

const supported = new Set<string>(multiAssetEtfTradables)
const bpsScale = 10_000n
const abs = (amount: bigint) => (amount < 0n ? -amount : amount)
const min = (a: bigint, b: bigint) => (a < b ? a : b)
const max = (a: bigint, b: bigint) => (a > b ? a : b)
const positive = (amount: bigint) => max(amount, 0n)
const weightUnits = (weight: number) => BigInt(Math.floor(weight * Number(WEIGHT_SCALE)))

export interface EtfReferencePrice {
  /** Raw prices in the current share basis, never adjusted signal bars. */
  readonly kind: 'RAW_OPEN' | 'RAW_PRIOR_CLOSE'
  readonly session: string
  readonly priceMicros: bigint
}

export interface EtfRebalanceInput {
  readonly signal: Pick<
    MultiAssetEtfSignal,
    'policyHash' | 'signalSession' | 'executionSession' | 'targetWeights' | 'exclusions' | 'idleCashContribution'
  >
  readonly accountId: string
  readonly plannedAt: string
  /** Reconciled positions assigned to this strategy, in signed whole shares. */
  readonly positions: Readonly<Partial<Record<MultiAssetEtfTradable, bigint>>>
  readonly equityMicros: bigint
  /** Available, unreserved buying power for this strategy. Do not pass the shared account's full buying power. */
  readonly buyingPowerMicros: bigint
  readonly references: Readonly<Partial<Record<MultiAssetEtfTradable, EtfReferencePrice>>>
  readonly shortEligibility: Readonly<Partial<Record<MultiAssetEtfTradable, EquityShortEligibility>>>
}

type PositionEffect = 'COVER_SHORT' | 'SELL_LONG' | 'BUY_LONG' | 'SELL_SHORT'
type Constraint = 'MissingSymbolBar' | 'Deadband' | 'BorrowUnavailable' | 'BuyingPower' | 'RiskLimit' | 'IdleCashLimit'

export interface EtfRebalanceOrder {
  readonly symbol: MultiAssetEtfTradable
  readonly side: OrderSide.Buy | OrderSide.Sell
  readonly positionEffect: PositionEffect
  readonly shares: bigint
  readonly limitPriceMicros: bigint
  readonly referenceNotionalMicros: bigint
  readonly buyingPowerReservedMicros: bigint
}

export interface EtfRebalancePlan {
  readonly policyHash: string
  readonly executionSession: string
  /** Conditional sequence; reconcile after each order before using headroom freed by its fills. */
  readonly orders: readonly EtfRebalanceOrder[]
  readonly targetShares: Readonly<Partial<Record<MultiAssetEtfTradable, bigint>>>
  readonly restrictions: readonly { readonly symbol: MultiAssetEtfTradable; readonly reason: Constraint }[]
  readonly preTradeGrossAtCollarMicros: bigint
  readonly projectedGrossAtCollarMicros: bigint
  readonly projectedNetShortAtCollarMicros: bigint
  readonly projectedWithinRiskLimits: boolean
  /** Sum of absolute share deltas times raw references. Divide by 2 × equity for one-way turnover. */
  readonly turnoverNotionalMicros: bigint
  readonly turnoverEquityMicros: bigint
  readonly buyLimitNotionalMicros: bigint
  readonly buyingPowerReservedMicros: bigint
  readonly buyingPowerRemainingMicros: bigint
}

export type EtfRebalanceFailure =
  | { readonly _tag: 'InvalidRebalanceInput'; readonly field: string }
  | { readonly _tag: 'InvalidReferencePrice'; readonly symbol: MultiAssetEtfTradable }

interface Leg {
  readonly symbol: MultiAssetEtfTradable
  readonly reference: bigint
  readonly high: bigint
  readonly low: bigint
  readonly buyLimit: bigint
  readonly sellLimit: bigint
  readonly excluded: boolean
  shares: bigint
  desired: bigint
}

const mark = (leg: Leg) => abs(leg.shares) * leg.high
const netShort = (leg: Leg) => -leg.shares * (leg.shares < 0n ? leg.high : leg.low)

export const planMultiAssetEtfRebalance = (
  policy: MultiAssetEtfPolicy,
  input: EtfRebalanceInput,
): Result.Result<EtfRebalancePlan, EtfRebalanceFailure> =>
  Result.gen(function* () {
    const { signal, equityMicros, buyingPowerMicros, positions } = input
    const invalid = (field: string) => Result.fail({ _tag: 'InvalidRebalanceInput', field } as const)
    if (signal.policyHash !== policy.policyHash || signal.signalSession >= signal.executionSession)
      return yield* invalid('signal')
    if (equityMicros <= 0n || buyingPowerMicros < 0n) return yield* invalid('equity or buying power')
    if (input.accountId === '' || !Number.isFinite(Date.parse(input.plannedAt)))
      return yield* invalid('account or plannedAt')
    if (Object.keys(positions).some((symbol) => !supported.has(symbol))) return yield* invalid('positions')
    if (
      Object.entries(signal.targetWeights).some(
        ([symbol, weight]) => !supported.has(symbol) || !Number.isFinite(weight),
      )
    ) {
      return yield* invalid('targetWeights')
    }

    const { maxGrossLeverage, maxSingleSymbolWeight, maxNetShortWeight, entryLimitCollarBps, minRebalanceDriftBps } =
      policy.risk
    const toNotionalCap = (weight: number) => (equityMicros * BigInt(Math.round(weight * Number(bpsScale)))) / bpsScale
    const grossCap = toNotionalCap(maxGrossLeverage)
    const symbolCap = toNotionalCap(maxSingleSymbolWeight)
    const shortCap = toNotionalCap(maxNetShortWeight)
    const collar = BigInt(entryLimitCollarBps)
    const excluded = new Set<MultiAssetEtfTradable>(signal.exclusions.map(({ symbol }) => symbol))
    const sweepSymbol = policy.idleCashSweep.enabled ? policy.idleCashSweep.symbol : undefined
    for (const [symbol, sweep] of Object.entries(signal.idleCashContribution)) {
      if (
        symbol !== sweepSymbol ||
        !Number.isFinite(sweep) ||
        sweep <= 0 ||
        sweep > (signal.targetWeights[sweepSymbol] ?? 0)
      )
        return yield* invalid('idleCashContribution')
    }
    if ((signal.targetWeights.SGOV ?? 0) !== (signal.idleCashContribution.SGOV ?? 0))
      return yield* invalid('SGOV sweep target')
    const weights = capEtfPortfolio(signal.targetWeights, policy)
    const legs: Leg[] = []
    const restrictions: { symbol: MultiAssetEtfTradable; reason: Constraint }[] = []
    for (const symbol of multiAssetEtfTradables) {
      const shares = positions[symbol] ?? 0n
      const blocked = excluded.has(symbol)
      const weight = weights[symbol] ?? 0
      if (blocked) restrictions.push({ symbol, reason: 'MissingSymbolBar' })
      if (shares === 0n && (blocked || weight === 0)) continue
      const reference = input.references[symbol]
      if (
        reference === undefined ||
        reference.priceMicros <= 0n ||
        (reference.kind !== 'RAW_OPEN' && reference.kind !== 'RAW_PRIOR_CLOSE') ||
        reference.session !== (reference.kind === 'RAW_OPEN' ? signal.executionSession : signal.signalSession)
      )
        return yield* Result.fail({ _tag: 'InvalidReferencePrice', symbol } as const)

      const price = reference.priceMicros
      const high = (price * (bpsScale + collar) + bpsScale - 1n) / bpsScale
      const low = (price * (bpsScale - collar)) / bpsScale
      // Buy maximum rounds down and sell minimum up, so tick quantization never widens the collar.
      const buyLimit = quantizeAlpacaLimitPriceMicros((price * (bpsScale + collar)) / bpsScale, 'DOWN')
      const sellLimit = quantizeAlpacaLimitPriceMicros((price * (bpsScale - collar) + bpsScale - 1n) / bpsScale, 'UP')
      if (low === 0n || buyLimit === 0n || buyLimit < sellLimit)
        return yield* Result.fail({ _tag: 'InvalidReferencePrice', symbol } as const)
      const desired = (equityMicros * weightUnits(Math.abs(weight))) / (WEIGHT_SCALE * high)
      legs.push({
        symbol,
        shares,
        excluded: blocked,
        desired: blocked ? shares : weight < 0 ? -desired : desired,
        reference: price,
        high,
        low,
        buyLimit,
        sellLimit,
      })
    }

    let gross = legs.reduce((sum, leg) => sum + mark(leg), 0n)
    let net = legs.reduce((sum, leg) => sum + netShort(leg), 0n)
    const preTradeGrossAtCollarMicros = gross
    const withinCaps = () => gross <= grossCap && net <= shortCap && legs.every((leg) => mark(leg) <= symbolCap)
    const sweepLeg = legs.find(({ symbol }) => symbol === sweepSymbol)
    if (sweepLeg !== undefined && !sweepLeg.excluded) {
      const symbol = sweepLeg.symbol
      const sweep = signal.idleCashContribution[symbol] ?? 0
      if (sweep > 0) {
        // Do not count expected reductions or short proceeds as idle cash.
        const otherGross = legs.reduce(
          (sum, leg) => (leg === sweepLeg ? sum : sum + max(mark(leg), abs(leg.desired) * leg.high)),
          0n,
        )
        const idleShareLimit = positive(min(equityMicros, grossCap) - otherGross) / sweepLeg.high
        const coreWeight = positive(weightUnits((signal.targetWeights[symbol] ?? 0) - sweep))
        const coreShares = (equityMicros * coreWeight) / (WEIGHT_SCALE * sweepLeg.high)
        const sweepLimit = max(coreShares, idleShareLimit)
        if (sweepLeg.desired > sweepLimit) {
          sweepLeg.desired = sweepLimit
          restrictions.push({ symbol, reason: 'IdleCashLimit' })
        }
      }
    }
    if (withinCaps()) {
      for (const leg of legs) {
        const { symbol, shares, desired, excluded } = leg
        if (
          excluded ||
          desired === shares ||
          shares === 0n ||
          desired === 0n ||
          (symbol === sweepSymbol && desired < shares) ||
          shares < 0n !== desired < 0n
        )
          continue
        const drift = abs(desired - shares) * leg.reference
        if (drift * bpsScale < equityMicros * BigInt(minRebalanceDriftBps)) {
          leg.desired = shares
          restrictions.push({ symbol, reason: 'Deadband' })
        }
      }
    }

    let buyingPowerRemainingMicros = buyingPowerMicros
    let turnoverNotionalMicros = 0n
    let buyLimitNotionalMicros = 0n
    const orders: EtfRebalanceOrder[] = []
    const place = (leg: Leg, effect: PositionEffect, desired: bigint) => {
      if (desired <= 0n) return
      const buy = effect === 'BUY_LONG' || effect === 'COVER_SHORT'
      const increases = effect === 'BUY_LONG' || effect === 'SELL_SHORT'
      const limitPriceMicros = buy ? leg.buyLimit : leg.sellLimit
      const unitReserve = buy ? leg.buyLimit : effect === 'SELL_SHORT' ? leg.high : 0n
      let shares = desired
      if (unitReserve > 0n) {
        shares = min(shares, buyingPowerRemainingMicros / unitReserve)
        if (shares < desired) restrictions.push({ symbol: leg.symbol, reason: 'BuyingPower' })
      }
      const budgeted = shares
      if (increases) {
        shares = withinCaps() ? min(shares, positive(min(grossCap - gross, symbolCap - mark(leg))) / leg.high) : 0n
      }
      // Selling longs or opening new shorts cannot consume unfilled hedge headroom.
      if (!buy) shares = min(shares, positive(shortCap - net) / (effect === 'SELL_LONG' ? leg.low : leg.high))
      if (shares < budgeted) restrictions.push({ symbol: leg.symbol, reason: 'RiskLimit' })
      if (shares === 0n) return

      gross -= mark(leg)
      net -= netShort(leg)
      leg.shares += buy ? shares : -shares
      gross += mark(leg)
      net += netShort(leg)
      const buyingPowerReservedMicros = shares * unitReserve
      const referenceNotionalMicros = shares * leg.reference
      buyingPowerRemainingMicros -= buyingPowerReservedMicros
      turnoverNotionalMicros += referenceNotionalMicros
      if (buy) buyLimitNotionalMicros += shares * limitPriceMicros
      orders.push({
        symbol: leg.symbol,
        side: buy ? OrderSide.Buy : OrderSide.Sell,
        positionEffect: effect,
        shares,
        limitPriceMicros,
        referenceNotionalMicros,
        buyingPowerReservedMicros,
      })
    }

    for (const leg of legs) {
      if (leg.shares < 0n) place(leg, 'COVER_SHORT', -leg.shares - positive(-leg.desired))
    }
    for (const leg of legs) {
      if (leg.shares > 0n) place(leg, 'SELL_LONG', leg.shares - positive(leg.desired))
    }
    for (const leg of legs) {
      if (leg.shares >= 0n) place(leg, 'BUY_LONG', leg.desired - leg.shares)
    }
    for (const leg of legs) {
      const shortDelta = leg.shares <= 0n ? leg.shares - leg.desired : 0n
      if (shortDelta <= 0n) continue
      if (!equityShortIsEligible(input.shortEligibility[leg.symbol], input.accountId, leg.symbol, input.plannedAt)) {
        restrictions.push({ symbol: leg.symbol, reason: 'BorrowUnavailable' })
        continue
      }
      place(leg, 'SELL_SHORT', shortDelta)
    }

    return {
      policyHash: policy.policyHash,
      executionSession: signal.executionSession,
      orders,
      targetShares: Object.fromEntries(legs.map(({ symbol, shares }) => [symbol, shares])),
      restrictions,
      preTradeGrossAtCollarMicros,
      projectedGrossAtCollarMicros: gross,
      projectedNetShortAtCollarMicros: positive(net),
      projectedWithinRiskLimits: withinCaps(),
      turnoverNotionalMicros,
      turnoverEquityMicros: equityMicros,
      buyLimitNotionalMicros,
      buyingPowerReservedMicros: buyingPowerMicros - buyingPowerRemainingMicros,
      buyingPowerRemainingMicros,
    }
  })
