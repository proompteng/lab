import { Result } from 'effect'

import type { IsoDate } from '../../schemas'
import type { StrategyDefinition, TargetPortfolio } from '../core'
import {
  defaultMacroCanaryEtfPolicy,
  macroCanaryEtfs,
  type MacroCanaryEtf,
  type MacroCanaryEtfPolicy,
  type MacroCanaryEtfPolicyReceipt,
} from './policy'

export interface AdjustedDailyBar {
  readonly session: IsoDate
  readonly symbol: MacroCanaryEtf
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
}

export interface MacroCanaryEtfMarket {
  readonly nextOpenSession: IsoDate
  /** Verified exchange calendar from a fixed origin, including the requested execution session. */
  readonly calendar: readonly IsoDate[]
  readonly history: {
    readonly adjustment: 'all' | 'raw' | 'split' | 'dividend'
    /** Independently verified point-in-time adjustment vintage, or null when unverified. */
    readonly corporateActionsThrough: IsoDate | null
    readonly bars: readonly AdjustedDailyBar[]
  }
}

export type MacroCanaryEtfSignalFailure =
  | { readonly _tag: 'InvalidCalendar'; readonly session: IsoDate }
  | { readonly _tag: 'InsufficientWarmup'; readonly required: number; readonly available: number }
  | { readonly _tag: 'UnverifiedAdjustments'; readonly signalSession: IsoDate }
  | { readonly _tag: 'MissingRequiredSymbol'; readonly symbol: MacroCanaryEtf; readonly session: IsoDate }
  | { readonly _tag: 'InvalidBar'; readonly symbol: string; readonly session: IsoDate }
  | { readonly _tag: 'InvalidSignalArithmetic'; readonly session: IsoDate }

type EtfWeights = Readonly<Record<MacroCanaryEtf, number>>
type MacroRegime = keyof MacroCanaryEtfPolicy['macro']['regimeBaskets']
type Arm = 'canary' | 'trend' | 'macro'

interface CanaryAttribution {
  readonly reviewedAt: IsoDate
  readonly offCount: number
  readonly defensiveBudget: number
  readonly scores: Readonly<Partial<EtfWeights>>
  readonly weights: EtfWeights
}

interface MacroAttribution {
  readonly regime: MacroRegime
  readonly credit: number
  readonly inflation: number
  readonly dollar: number
  readonly strongDollar: boolean
  readonly unsmoothedWeights: EtfWeights
  readonly weights: EtfWeights
}

export interface MacroCanaryEtfTarget extends TargetPortfolio {
  readonly signalSession: IsoDate
  readonly nextOpenSession: IsoDate
  /** Off cadence, weights are diagnostic; do not rebalance. */
  readonly review: boolean
  readonly policyHash: string
  readonly targetWeights: EtfWeights
  readonly attribution: {
    readonly canary: CanaryAttribution
    readonly trend: { readonly zScores: Readonly<Partial<EtfWeights>>; readonly weights: EtfWeights }
    readonly macro: MacroAttribution
    readonly blendWeights: Readonly<Record<Arm, number>>
    /** Exact Wave 5D blend, before production exposure limits and the idle SHY sweep. */
    readonly ensembleWeights: EtfWeights
    readonly idleShyWeight: number
    readonly unsweptCashWeight: number
  }
}

const n = macroCanaryEtfs.length
const indices = new Map(macroCanaryEtfs.map((symbol, index) => [symbol, index]))
const asset = (symbol: MacroCanaryEtf) => macroCanaryEtfs.indexOf(symbol)
const zero = () => new Float64Array(n)
const at = <A>(xs: { readonly [i: number]: A }, i: number): A => {
  const value = xs[i]
  if (value === undefined) throw new RangeError('Macro canary internal index out of bounds')
  return value
}
const gross = (w: Float64Array) => w.reduce((sum, x) => sum + Math.abs(x), 0)
const asWeights = (w: Float64Array): EtfWeights =>
  Object.fromEntries(macroCanaryEtfs.map((symbol, i) => [symbol, at(w, i)])) as EtfWeights

const readCloses = (
  market: MacroCanaryEtfMarket,
  signalSession: IsoDate,
  calendar: readonly IsoDate[],
): Result.Result<readonly Float64Array[], MacroCanaryEtfSignalFailure> => {
  const { adjustment, corporateActionsThrough, bars } = market.history
  if (adjustment !== 'all' || corporateActionsThrough !== signalSession)
    return Result.fail({ _tag: 'UnverifiedAdjustments', signalSession })
  const bySession = new Map(calendar.map((session) => [session, zero()]))
  const first = at(calendar, 0)
  for (const bar of bars) {
    const { session } = bar
    if (session > signalSession || session < first) continue
    const { symbol, open, high, low, close, volume } = bar
    const day = bySession.get(session)
    const i = indices.get(symbol)
    if (
      day === undefined ||
      i === undefined ||
      day[i] !== 0 ||
      ![open, high, low, close, volume].every((x) => Number.isFinite(x) && x > 0) ||
      low > Math.min(open, close) ||
      high < Math.max(open, close)
    )
      return Result.fail({ _tag: 'InvalidBar', symbol, session })
    day[i] = close
  }
  for (const [session, close] of bySession) {
    const missing = close.findIndex((price) => price === 0)
    if (missing !== -1)
      return Result.fail({ _tag: 'MissingRequiredSymbol', symbol: at(macroCanaryEtfs, missing), session })
  }
  return Result.succeed([...bySession.values()])
}

const covarianceOf = (a: Float64Array, b: Float64Array, covariance: Float64Array) => {
  let v = 0
  for (let i = 0; i < n; i++)
    if (at(a, i) !== 0)
      for (let j = 0; j < n; j++) if (at(b, j) !== 0) v += at(a, i) * at(b, j) * at(covariance, i * n + j)
  return v
}

const allocate = (
  target: Float64Array,
  basket: readonly MacroCanaryEtf[],
  count: number,
  score: (i: number) => number,
  weight: (i: number) => number,
  budget: number,
) => {
  if (budget === 0) return
  const ranked = basket
    .map(asset)
    .map((i) => ({ i, score: score(i), weight: weight(i) }))
    .filter((entry) => Number.isFinite(entry.score) && Number.isFinite(entry.weight) && entry.weight > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, count)
  const total = ranked.reduce((sum, entry) => sum + entry.weight, 0)
  for (const { i, weight } of ranked) target[i] = at(target, i) + (budget * weight) / total
}

const canaryWeights = (
  policy: MacroCanaryEtfPolicy,
  returns: readonly Float64Array[],
  vol: Float64Array,
  reviewedAt: IsoDate,
) => {
  const [a, b, c, d] = policy.canary.momentumCoefficients
  const r1 = at(returns, 0)
  const r3 = at(returns, 1)
  const r6 = at(returns, 2)
  const r12 = at(returns, 3)
  const momentum = Float64Array.from(r1, (_, i) => a * at(r1, i) + b * at(r3, i) + c * at(r6, i) + d * at(r12, i))
  const scores = policy.canaryAssets.map((symbol) => [symbol, at(momentum, asset(symbol))] as const)
  const offCount = scores.filter(([, score]) => score <= 0).length
  const defensiveBudget = offCount / scores.length
  const w = zero()
  allocate(
    w,
    policy.offensiveAssets,
    policy.canary.offensiveCount,
    (i) => at(momentum, i),
    (i) => 1 / Math.max(at(vol, i), policy.features.volFloor),
    1 - defensiveBudget,
  )
  allocate(
    w,
    policy.defensiveSafeHavens,
    policy.canary.defensiveCount,
    (i) => (at(momentum, i) > 0 ? at(momentum, i) : NaN),
    () => 1,
    defensiveBudget,
  )
  return { w, attribution: { reviewedAt, scores: Object.fromEntries(scores), offCount, defensiveBudget } }
}

const capShorts = (w: Float64Array, book: MacroCanaryEtfPolicy['trend']['book']) => {
  if (book.kind !== 'signed') return w
  const short = w.reduce((sum, x) => sum - Math.min(x, 0), 0)
  return short > book.maxShortGrossWeight ? w.map((x) => (x < 0 ? x * (book.maxShortGrossWeight / short) : x)) : w
}

const trendWeights = (
  policy: MacroCanaryEtfPolicy,
  returns: readonly Float64Array[],
  covariance: Float64Array,
  vol: Float64Array,
) => {
  const { trend, features } = policy
  const w = zero()
  const zScores: Partial<Record<MacroCanaryEtf, number>> = {}
  for (const sleeve of trend.sleeves) {
    for (const symbol of sleeve) {
      const i = asset(symbol)
      const sigma = Math.max(at(vol, i), features.volFloor)
      const z =
        returns.reduce(
          (sum, r, h) =>
            sum + Math.log1p(at(r, i)) / (sigma * Math.sqrt(at(features.horizons, h) / features.annualSessions)),
          0,
        ) / features.horizons.length
      zScores[symbol] = z
      const signal = Math.min(1, Math.max(-1, z))
      w[i] =
        ((trend.book.kind === 'longOnly' ? Math.max(signal, 0) : signal) * (1 / sigma)) /
        (sleeve.length * trend.sleeves.length)
    }
  }
  const total = gross(w)
  const sigma = Math.sqrt(Math.max(0, covarianceOf(w, w, covariance)))
  const scale =
    total > 0 ? Math.min(trend.targetVolatility / Math.max(sigma, trend.minVolatility), trend.maxGross / total) : 0
  const scaled = w.map((x) => x * scale)
  return { w: capShorts(scaled, trend.book), zScores }
}

const macroWeights = (policy: MacroCanaryEtfPolicy, returns: Float64Array) => {
  const relative = ([a, b]: readonly [MacroCanaryEtf, MacroCanaryEtf]) =>
    Math.log1p(at(returns, asset(a))) - Math.log1p(at(returns, asset(b)))
  const credit = relative(policy.creditPair)
  const pairs = policy.inflationPairs.map(relative)
  const inflation = pairs.reduce((sum, x) => sum + x, 0) / pairs.length
  const regime: MacroRegime =
    credit > 0 ? (inflation > 0 ? 'Reflation' : 'Goldilocks') : inflation > 0 ? 'Stagflation' : 'DeflationaryCrash'
  const dollar = at(returns, asset(policy.dollarProxy))
  const strongDollar = dollar > 0
  const budget = credit > 0 && strongDollar ? policy.macro.strongDollarRiskOnBudget : 1
  const basket = policy.macro.regimeBaskets[regime].filter((symbol) => symbol !== policy.dollarProxy || strongDollar)
  const w = zero()
  allocate(
    w,
    basket,
    basket.length,
    () => 0,
    (i) => (i === asset(policy.dollarProxy) ? policy.macro.strongDollarHedgeWeight : 1),
    budget,
  )
  return { w, credit, inflation, regime, dollar, strongDollar }
}

const blend = (
  policy: MacroCanaryEtfPolicy,
  arms: readonly { readonly arm: Arm; readonly w: Float64Array }[],
  covariance: Float64Array,
) => {
  const { ensemble } = policy
  const active = arms.flatMap(({ arm, w }, index) =>
    gross(w) > ensemble.minActiveGross ? [{ arm, w, riskBudget: at(ensemble.relativeRiskBudgets, index) }] : [],
  )
  const cov = active.map(({ w: a }, i) =>
    active.map(
      ({ w: b }, j) =>
        covarianceOf(a, b, covariance) * (i === j ? 1 : ensemble.offDiagonalScale) +
        (i === j ? ensemble.diagonalVolFloor ** 2 : 0),
    ),
  )
  // Wave 5D cyclic coordinate descent: equal risk budgets, not equal capital weights.
  const w = cov.map((row, i) => 1 / Math.sqrt(at(row, i)))
  for (let pass = 0; pass < ensemble.riskParityPasses; pass++) {
    for (let i = 0; i < w.length; i++) {
      const row = at(cov, i)
      const a = at(row, i)
      const b = row.reduce((sum, c, j) => sum + (i === j ? 0 : c * at(w, j)), 0)
      const budget = at(active, i).riskBudget
      const root = Math.sqrt(b * b + 4 * a * budget)
      w[i] = b >= 0 ? (2 * budget) / (b + root) : (root - b) / (2 * a)
    }
  }
  const sum = w.reduce((s, x) => s + x, 0)
  const weights = w.map((x) => x / sum)
  const blendWeights = { canary: 0, trend: 0, macro: 0 }
  for (const [i, { arm }] of active.entries()) blendWeights[arm] = (at(weights, i) * active.length) / arms.length
  const ensembleWeights = Float64Array.from(
    macroCanaryEtfs,
    (_, i) => (active.reduce((s, { w }, k) => s + at(weights, k) * at(w, i), 0) * active.length) / arms.length,
  )
  return { blendWeights, ensembleWeights }
}

const project = (policy: MacroCanaryEtfPolicy, weights: Float64Array) => {
  const { maxEtfWeight, maxGrossLeverage } = policy.execution
  const clipped = weights.map((x) => Math.sign(x) * Math.min(Math.abs(x), maxEtfWeight))
  const w = capShorts(clipped, policy.trend.book)
  const total = gross(w)
  if (total > maxGrossLeverage) for (let i = 0; i < n; i++) w[i] = at(w, i) * (maxGrossLeverage / total)
  const shy = asset(policy.cashProxy)
  const idleShyWeight = Math.max(0, Math.min(maxEtfWeight - at(w, shy), maxGrossLeverage - gross(w)))
  w[shy] = Math.min(maxEtfWeight, at(w, shy) + idleShyWeight)
  return { targetWeights: asWeights(w), idleShyWeight, unsweptCashWeight: Math.max(0, 1 - gross(w)) }
}

export const macroCanaryEtfReviewOffset = (policy: MacroCanaryEtfPolicy, completedSessions: number) =>
  (completedSessions - Math.max(...policy.features.horizons) - 1) % policy.ensemble.reviewCadence

export const compileMacroCanaryEtfSignal = (
  receipt: MacroCanaryEtfPolicyReceipt,
  market: MacroCanaryEtfMarket,
): Result.Result<MacroCanaryEtfTarget, MacroCanaryEtfSignalFailure> => {
  const { policy, policyHash } = receipt
  const t = market.calendar.indexOf(market.nextOpenSession)
  const calendar = market.calendar.slice(0, t)
  if (
    t < 1 ||
    calendar[0] !== policy.historyStartSession ||
    market.calendar.lastIndexOf(market.nextOpenSession) !== t ||
    calendar.some((date, i) => i > 0 && date <= at(calendar, i - 1))
  )
    return Result.fail({ _tag: 'InvalidCalendar', session: market.nextOpenSession })
  const warmup = Math.max(...policy.features.horizons)
  if (t <= warmup) return Result.fail({ _tag: 'InsufficientWarmup', required: warmup + 1, available: t })
  const signalSession = at(calendar, t - 1)
  const closes = readCloses(market, signalSession, calendar)
  if (Result.isFailure(closes)) return Result.fail(closes.failure)

  const { riskWindow, annualSessions, horizons } = policy.features
  const returnsAt = (day: number, h: number) =>
    Float64Array.from(at(closes.success, day), (c, i) => c / at(at(closes.success, day - h), i) - 1)
  const logs = closes.success.map((close, day) =>
    day === 0 ? zero() : Float64Array.from(close, (price, i) => Math.log(price / at(at(closes.success, day - 1), i))),
  )
  if (logs.some((day) => day.some((value) => !Number.isFinite(value))))
    return Result.fail({ _tag: 'InvalidSignalArithmetic', session: signalSession })
  const finiteReturns = (r: Float64Array) => r.every((x) => Number.isFinite(x) && x > -1)
  const sums = zero()
  const cross = new Float64Array(n * n)
  const covariance = new Float64Array(n * n)
  const vol = zero()
  const last = t - 1
  let macroHeld = zero()
  let macro: ReturnType<typeof macroWeights> | undefined
  let canary: ReturnType<typeof canaryWeights> | undefined
  for (let day = 0; day <= last; day++) {
    if (day >= policy.macro.lookback) {
      const returns = returnsAt(day, policy.macro.lookback)
      if (!finiteReturns(returns)) return Result.fail({ _tag: 'InvalidSignalArithmetic', session: at(calendar, day) })
      const current = macroWeights(policy, returns)
      macro = current
      macroHeld = macroHeld.map((value, i) => value + (at(current.w, i) - value) / ((policy.macro.emaSpan + 1) / 2))
    }

    const add = at(logs, day)
    const drop = logs[day - riskWindow]
    for (let i = 0; i < n; i++) {
      const x = at(add, i)
      const old = drop === undefined ? 0 : at(drop, i)
      sums[i] = at(sums, i) + (x - old)
      for (let j = 0; j <= i; j++) {
        const k = i * n + j
        cross[k] = at(cross, k) + (x * at(add, j) - (drop === undefined ? 0 : old * at(drop, j)))
      }
    }
    const canaryReview = day >= warmup && (day - warmup) % policy.canary.cadence === 0
    if (!canaryReview && day !== last) continue
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        const value =
          (annualSessions / (riskWindow - 1)) * (at(cross, i * n + j) - (at(sums, i) * at(sums, j)) / riskWindow)
        covariance[i * n + j] = covariance[j * n + i] = value
      }
      vol[i] = Math.sqrt(Math.max(0, at(covariance, i * n + i)))
    }
    if (canaryReview) {
      const returns = horizons.map((h) => returnsAt(day, h))
      if (!returns.every(finiteReturns))
        return Result.fail({ _tag: 'InvalidSignalArithmetic', session: at(calendar, day) })
      canary = canaryWeights(policy, returns, vol, at(calendar, day))
    }
  }
  const returns = horizons.map((h) => returnsAt(last, h))
  if (macro === undefined || canary === undefined || !returns.every(finiteReturns))
    return Result.fail({ _tag: 'InvalidSignalArithmetic', session: signalSession })
  const trend = trendWeights(policy, returns, covariance, vol)
  const { blendWeights, ensembleWeights } = blend(
    policy,
    [
      { arm: 'canary', w: canary.w },
      { arm: 'trend', w: trend.w },
      { arm: 'macro', w: macroHeld },
    ],
    covariance,
  )
  if (!ensembleWeights.every(Number.isFinite))
    return Result.fail({ _tag: 'InvalidSignalArithmetic', session: signalSession })
  const { targetWeights, idleShyWeight, unsweptCashWeight } = project(policy, ensembleWeights)
  return Result.succeed({
    signalSession,
    nextOpenSession: market.nextOpenSession,
    review: macroCanaryEtfReviewOffset(policy, t) === 0,
    policyHash,
    targetWeights,
    attribution: {
      canary: { ...canary.attribution, weights: asWeights(canary.w) },
      trend: { zScores: trend.zScores, weights: asWeights(trend.w) },
      macro: {
        regime: macro.regime,
        credit: macro.credit,
        inflation: macro.inflation,
        dollar: macro.dollar,
        strongDollar: macro.strongDollar,
        unsmoothedWeights: asWeights(macro.w),
        weights: asWeights(macroHeld),
      },
      blendWeights,
      ensembleWeights: asWeights(ensembleWeights),
      idleShyWeight,
      unsweptCashWeight,
    },
  })
}

export const makeMacroCanaryEtfDefinition = (
  receipt = defaultMacroCanaryEtfPolicy,
): StrategyDefinition<
  MacroCanaryEtfMarket,
  MacroCanaryEtfSignalFailure,
  MacroCanaryEtfTarget,
  MacroCanaryEtfPolicy
> => ({
  name: 'macro-canary-etf',
  holdingPeriod: 'MULTI_SESSION',
  parameters: receipt.policy,
  decide: ({ market }) => compileMacroCanaryEtfSignal(receipt, market),
})
