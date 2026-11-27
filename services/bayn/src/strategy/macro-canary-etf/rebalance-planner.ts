import { Result } from 'effect'

import { OrderSide } from '../../execution/contracts'
import type { IsoDate } from '../../schemas'
import { BPS, WEIGHT_SCALE } from '../execution-model/model'
import { macroCanaryEtfs, type MacroCanaryEtf, type MacroCanaryEtfPolicyReceipt } from './policy'
import type { MacroCanaryEtfTarget } from './signals'

export interface RawEtfReference {
  readonly priceMicros: bigint
  readonly tickMicros: bigint
  readonly shortable: boolean
}

export interface MacroCanaryEtfRebalanceInput {
  readonly target: Pick<
    MacroCanaryEtfTarget,
    'signalSession' | 'nextOpenSession' | 'policyHash' | 'review' | 'targetWeights'
  >
  readonly executionSession: IsoDate
  /** Dedicated sleeve equity; must not include another strategy's allocation. */
  readonly equityMicros: bigint
  /** Reconciled, unreserved cash after fees and collateral. Never infer buying power from sales. */
  readonly spendableCashMicros: bigint
  readonly references: {
    readonly adjustment: 'raw'
    readonly session: IsoDate
    readonly corporateActionsReconciled: boolean
    readonly quotes: Readonly<Partial<Record<MacroCanaryEtf, RawEtfReference>>>
  }
  readonly positions: readonly { readonly symbol: MacroCanaryEtf; readonly shares: number }[]
  /** Includes pending, unacknowledged and indeterminate mutations. */
  readonly ordersClear: boolean
  /** Remaining rolling-year budget in one-way bps, rounded down by the account owner. */
  readonly remainingOneWayTurnoverBps: number
}

export interface MacroCanaryEtfLimitOrder {
  readonly symbol: MacroCanaryEtf
  readonly side: OrderSide
  readonly shares: number
  readonly limitPriceMicros: bigint
}

export type MacroCanaryEtfPlan =
  | { readonly phase: 'hold'; readonly reason: 'OutsideReview' | 'NoWholeShareDrift' | 'NoCapacity' }
  | {
      readonly phase: 'reduce' | 'increase'
      readonly executionSession: IsoDate
      readonly policyHash: string
      readonly orders: readonly MacroCanaryEtfLimitOrder[]
      readonly reservedTwoWayTurnoverMicros: bigint
      readonly reservedCashMicros: bigint
    }

export type MacroCanaryEtfPlanFailure =
  | { readonly _tag: 'TargetBindingMismatch' }
  | { readonly _tag: 'UnreconciledOrders' }
  | { readonly _tag: 'UnreconciledCorporateActions' }
  | { readonly _tag: 'InvalidAccount' }
  | { readonly _tag: 'InvalidPosition'; readonly symbol: string }
  | { readonly _tag: 'InvalidReference'; readonly symbol: MacroCanaryEtf }
  | { readonly _tag: 'InvalidTargetExposure' }
  | { readonly _tag: 'ExistingExposureLimit' }
  | { readonly _tag: 'ShortUnavailable'; readonly symbol: MacroCanaryEtf }

// Round weight magnitudes toward zero at the float-to-money boundary. All money, limits
// and share sizing after that boundary are exact integer micros.
const scaledWeight = (x: number) => BigInt(Math.trunc(x * Number(WEIGHT_SCALE)))
const abs = (x: bigint) => (x < 0n ? -x : x)
const min = (a: bigint, b: bigint) => (a < b ? a : b)
const ceilDiv = (n: bigint, d: bigint) => (n + d - 1n) / d

export const planMacroCanaryEtfRebalance = (
  receipt: MacroCanaryEtfPolicyReceipt,
  input: MacroCanaryEtfRebalanceInput,
): Result.Result<MacroCanaryEtfPlan, MacroCanaryEtfPlanFailure> => {
  const { policy, policyHash } = receipt
  const { target, executionSession, references, equityMicros: equity, remainingOneWayTurnoverBps } = input
  if (
    target.policyHash !== policyHash ||
    target.nextOpenSession !== executionSession ||
    target.signalSession >= executionSession ||
    references.adjustment !== 'raw' ||
    references.session !== executionSession
  )
    return Result.fail({ _tag: 'TargetBindingMismatch' })
  if (!input.ordersClear) return Result.fail({ _tag: 'UnreconciledOrders' })
  if (!target.review) return Result.succeed({ phase: 'hold', reason: 'OutsideReview' })
  if (!references.corporateActionsReconciled) return Result.fail({ _tag: 'UnreconciledCorporateActions' })

  const { execution, trend } = policy
  if (
    equity <= 0n ||
    input.spendableCashMicros < 0n ||
    !Number.isSafeInteger(remainingOneWayTurnoverBps) ||
    remainingOneWayTurnoverBps < 0 ||
    remainingOneWayTurnoverBps > execution.annualOneWayTurnoverBps
  )
    return Result.fail({ _tag: 'InvalidAccount' })

  const positions = new Map<MacroCanaryEtf, bigint>()
  for (const { symbol, shares } of input.positions) {
    if (
      !macroCanaryEtfs.includes(symbol) ||
      positions.has(symbol) ||
      !Number.isSafeInteger(shares) ||
      (trend.book.kind === 'longOnly' && shares < 0)
    )
      return Result.fail({ _tag: 'InvalidPosition', symbol })
    positions.set(symbol, BigInt(shares))
  }
  const grossWeight = scaledWeight(execution.maxGrossLeverage)
  const symbolWeight = scaledWeight(execution.maxEtfWeight)
  const shortWeight = scaledWeight(trend.book.kind === 'signed' ? trend.book.maxShortGrossWeight : 0)
  const grossCap = (equity * grossWeight) / WEIGHT_SCALE
  const symbolCap = (equity * symbolWeight) / WEIGHT_SCALE
  const shortCap = (equity * shortWeight) / WEIGHT_SCALE
  const collar = BigInt(execution.limitCollarBps)
  const driftBps = BigInt(execution.minDriftBps)
  const candidates: {
    symbol: MacroCanaryEtf
    held: bigint
    delta: bigint
    drift: bigint
    quote: RawEtfReference
    high: bigint
    reducing: boolean
  }[] = []
  let heldGross = 0n
  let heldShort = 0n
  let targetGross = 0n
  let targetShort = 0n
  for (const symbol of macroCanaryEtfs) {
    const weight = target.targetWeights[symbol]
    if (!Number.isFinite(weight) || Math.abs(weight) > execution.maxEtfWeight || (weight < 0 && shortWeight === 0n))
      return Result.fail({ _tag: 'InvalidTargetExposure' })
    const desired = scaledWeight(weight)
    targetGross += abs(desired)
    if (desired < 0n) targetShort -= desired
    const held = positions.get(symbol) ?? 0n
    if (held === 0n && desired === 0n) continue
    const quote = references.quotes[symbol]
    if (quote === undefined || quote.priceMicros <= 0n || quote.tickMicros <= 0n)
      return Result.fail({ _tag: 'InvalidReference', symbol })
    const high = ceilDiv(quote.priceMicros * (BPS + collar), BPS)
    const marked = abs(held) * high
    if (marked > symbolCap) return Result.fail({ _tag: 'ExistingExposureLimit' })
    heldGross += marked
    if (held < 0n) heldShort += marked

    const targetValue = desired * equity
    const drift = abs(targetValue - held * quote.priceMicros * WEIGHT_SCALE)
    if (drift * BPS < driftBps * equity * WEIGHT_SCALE) continue
    const targetShares = targetValue / (quote.priceMicros * WEIGHT_SCALE)
    const reducing = held !== 0n && (targetShares * held <= 0n || abs(targetShares) < abs(held))
    // Close to flat first before considering the opposite side on a later reconciliation.
    const delta = reducing && targetShares * held <= 0n ? -held : targetShares - held
    if (delta !== 0n) candidates.push({ symbol, held, delta, drift, quote, high, reducing })
  }
  if (targetGross > grossWeight || targetShort > shortWeight) return Result.fail({ _tag: 'InvalidTargetExposure' })
  if (heldGross > grossCap || heldShort > shortCap) return Result.fail({ _tag: 'ExistingExposureLimit' })
  if (candidates.length === 0) return Result.succeed({ phase: 'hold', reason: 'NoWholeShareDrift' })

  // Never assume a reducing order fills or reuse its expected proceeds. Each returned batch
  // is safe at these marks even when any subset fills. Reconcile before planning again.
  const reducing = candidates.some((candidate) => candidate.reducing)
  const orders: MacroCanaryEtfLimitOrder[] = []
  const turnoverBudget = (2n * equity * BigInt(remainingOneWayTurnoverBps)) / BPS
  let reservedTurnover = 0n
  let reservedCash = 0n
  candidates.sort((a, b) => (a.drift > b.drift ? -1 : a.drift < b.drift ? 1 : 0))
  for (const candidate of candidates) {
    if (candidate.reducing !== reducing) continue
    const {
      symbol,
      held,
      delta,
      high,
      quote: { priceMicros, tickMicros, shortable },
    } = candidate
    const buy = delta > 0n
    const upper = (priceMicros * (BPS + collar)) / BPS
    const limit = buy
      ? (upper / tickMicros) * tickMicros
      : ceilDiv(priceMicros * (BPS - collar), BPS * tickMicros) * tickMicros
    // Round inward; if the tick grid has no legal price inside the collar, do not trade.
    if (limit <= 0n || limit * BPS < priceMicros * (BPS - collar) || limit > upper)
      return Result.fail({ _tag: 'InvalidReference', symbol })
    let shares = min(abs(delta), (turnoverBudget - reservedTurnover) / high)
    if (buy) shares = min(shares, (input.spendableCashMicros - reservedCash) / limit)
    if (!reducing) {
      shares = min(shares, (grossCap - heldGross) / high)
      shares = min(shares, (symbolCap - abs(held) * high) / high)
      if (!buy) shares = min(shares, (shortCap - heldShort) / high)
    }
    if (shares === 0n) continue
    if (!reducing && !buy && !shortable) return Result.fail({ _tag: 'ShortUnavailable', symbol })
    if (
      shares > BigInt(Number.MAX_SAFE_INTEGER) ||
      abs(held + (buy ? shares : -shares)) > BigInt(Number.MAX_SAFE_INTEGER)
    )
      return Result.fail({ _tag: 'InvalidPosition', symbol })
    if (!reducing) {
      heldGross += shares * high
      if (!buy) heldShort += shares * high
    }
    reservedTurnover += shares * high
    if (buy) reservedCash += shares * limit
    orders.push({ symbol, side: buy ? OrderSide.Buy : OrderSide.Sell, shares: Number(shares), limitPriceMicros: limit })
  }
  if (orders.length === 0) return Result.succeed({ phase: 'hold', reason: 'NoCapacity' })
  return Result.succeed({
    phase: reducing ? 'reduce' : 'increase',
    executionSession,
    policyHash,
    orders,
    reservedTwoWayTurnoverMicros: reservedTurnover,
    reservedCashMicros: reservedCash,
  })
}
