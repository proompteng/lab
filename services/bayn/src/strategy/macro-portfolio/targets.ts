import { Result, Schema } from 'effect'

import { crossAssetCanaries, crossAssetWeights } from '../macro-canary-etf/cross-asset-signals'
import {
  canaryPolicyV2,
  crossAssetV2,
  decodeMacroCanaryEtfPolicyV2,
  type CrossAssetEtf,
} from '../macro-canary-etf/policy'
import {
  asset,
  corePolicyV2,
  decodeMacroEtfCorePolicyV2,
  emptyWeights,
  evidenceFailure,
  MacroEtfCoreEvidenceError,
  Profile,
  strict,
} from '../macro-etf-core/policy'
import { readF4SignalHistory, SessionDate, type MacroEtfCoreSignal } from '../macro-etf-core/signals'
import {
  drawdownState,
  ewmaCovariance,
  grossLimitBps,
  macroRiskRules,
  MacroRiskState,
  portfolioVolatility,
  type MacroRiskConfig,
} from './risk'

export type MacroV2Target = MacroEtfCoreSignal & {
  readonly riskState: MacroRiskState
  readonly priorEquityMicros: bigint
}
type Schedule = Omit<MacroEtfCoreSignal, 'policyHash' | 'weights'>
type Basis = Readonly<{
  schedule: Schedule
  f4: readonly number[]
  o1: readonly number[]
  canaries: ReturnType<typeof crossAssetCanaries>
  covariance: ReturnType<typeof ewmaCovariance>
}>

const at = <A>(rows: readonly A[], i: number): A => {
  const row = rows[i]
  if (row === undefined) throw new RangeError(`Unbound macro history row ${i}`)
  return row
}

/** Prepare the same causal close-prefix decisions for a single observation or a walk-forward replay. */
export const prepareMacroPortfolioV2 = (risk: unknown, market: unknown) =>
  Result.gen(function* () {
    const f4 = yield* decodeMacroEtfCorePolicyV2({ schema: corePolicyV2, profile: Profile.F4, risk })
    const o1 = yield* decodeMacroCanaryEtfPolicyV2({ schemaVersion: canaryPolicyV2, risk }).pipe(
      Result.mapError((cause) => new MacroEtfCoreEvidenceError({ message: 'Invalid O1 v2 policy', cause })),
    )
    const { observations, closes, calendar, asOf, snapshotHash } = yield* readF4SignalHistory(market)
    const reviews = new Map(observations.map((row) => [row.signalDate, row.weights]))
    const basis: Basis[] = []
    const warmup = Math.max(...crossAssetV2.horizons, macroRiskRules.lookback)
    if (closes.length <= warmup) return yield* evidenceFailure('Insufficient coordinated macro warmup')

    let core: readonly number[] | undefined
    let canary: ReturnType<typeof crossAssetWeights> | undefined
    let priorCanaries: ReturnType<typeof crossAssetCanaries> | undefined
    for (const [t, row] of closes.entries()) {
      const session = at(calendar, t)
      core = reviews.get(session.date) ?? core
      if (t < warmup || core === undefined) continue
      const next = at(calendar, t + 1)
      const trend = (a: CrossAssetEtf, b: CrossAssetEtf, h: number) => {
        const prior = at(closes, t - h)
        // All ten canary inputs are required in the verified F4 close panel.
        return (
          Math.log(row[asset[a]] ?? NaN) -
          Math.log(prior[asset[a]] ?? NaN) -
          (Math.log(row[asset[b]] ?? NaN) - Math.log(prior[asset[b]] ?? NaN))
        )
      }
      const canaries = crossAssetCanaries(trend)
      if (
        canary === undefined ||
        (t - warmup) % crossAssetV2.cadence === 0 ||
        canaries.riskOff !== priorCanaries?.riskOff ||
        canaries.rateShock !== priorCanaries.rateShock
      ) {
        canary = crossAssetWeights(trend, canaries)
        priorCanaries = canaries
      }
      const window = closes.slice(t - macroRiskRules.lookback, t + 1)
      // A newly listed or over-late optional F4 ETF has no covariance estimate yet.
      // Do not impute its return or redistribute that weight before sizing.
      const f4Weights = core.map((weight, i) =>
        weight > 0 && window.every((close) => close[i] !== undefined) ? weight : 0,
      )
      const o1Weights = emptyWeights()
      for (const [symbol, weight] of canary) o1Weights[asset[symbol]] = weight
      const returns = window.slice(1).map((now, j) => {
        const before = at(window, j)
        let f4Return = 0
        let o1Return = 0
        for (const [i, f4Weight] of f4Weights.entries()) {
          const o1Weight = at(o1Weights, i)
          if (f4Weight === 0 && o1Weight === 0) continue
          const change = (now[i] ?? NaN) / (before[i] ?? NaN) - 1
          f4Return += f4Weight * change
          o1Return += o1Weight * change
        }
        return { f4: f4Return, o1: o1Return }
      })
      const covariance = ewmaCovariance(returns)
      if (!Object.values(covariance).every(Number.isFinite))
        return yield* evidenceFailure(`Nonfinite macro portfolio covariance: ${session.date}`)
      basis.push({
        schedule: {
          signalDate: session.date,
          signalCloseAt: session.closeAt,
          executionDate: next.date,
          executionOpenAt: next.openAt,
        },
        f4: f4Weights,
        o1: o1Weights,
        canaries,
        covariance,
      })
    }
    return { basis, asOf, snapshotHash, risk: f4.risk, f4PolicyHash: f4.hash, o1PolicyHash: o1.policyHash }
  })

type Prepared = Result.Result.Success<ReturnType<typeof prepareMacroPortfolioV2>>
type Policies = Pick<Prepared, 'risk' | 'f4PolicyHash' | 'o1PolicyHash'>

const PositiveMicros = Schema.BigInt.check(
  Schema.isGreaterThanBigInt(0n),
  Schema.isLessThanOrEqualToBigInt(BigInt(Number.MAX_SAFE_INTEGER)),
)
const PairedClose = Schema.Struct({
  signalDate: SessionDate,
  f4EquityMicros: PositiveMicros,
  o1EquityMicros: PositiveMicros,
  // The account owner preserves the flow-adjusted high-water mark across restarts.
  highWaterMicros: PositiveMicros,
})

const boundedScale = (desired: number, weights: readonly number[], cap: number, symbolCap: number) => {
  const gross = weights.reduce((sum, weight) => sum + weight, 0)
  return gross > 0 ? Math.min(desired, cap / gross, symbolCap / Math.max(...weights)) : 0
}

export const sizeMacroPortfolioV2 = (policies: Policies, basis: Basis, closeInput: unknown) => {
  const close = Schema.decodeUnknownResult(PairedClose)(closeInput, strict)
  if (Result.isFailure(close)) return evidenceFailure('Invalid paired macro equity evidence', close.failure)
  const { signalDate, f4EquityMicros, o1EquityMicros, highWaterMicros } = close.success
  const equity = f4EquityMicros + o1EquityMicros
  if (signalDate !== basis.schedule.signalDate || highWaterMicros < equity)
    return evidenceFailure('Macro equity observation does not bind to the signal close or high-water mark')
  const risk: MacroRiskConfig = policies.risk
  const fraction = { f4: Number(f4EquityMicros) / Number(equity), o1: Number(o1EquityMicros) / Number(equity) }
  const baseVolatility = portfolioVolatility(basis.covariance, fraction)
  const desired = risk.targetVolatility / Math.max(baseVolatility, macroRiskRules.volatilityFloor)
  const cap = grossLimitBps(risk.mode) / 10_000
  const f4Scale = boundedScale(desired, basis.f4, cap, 1)
  const o1Scale = boundedScale(desired, basis.o1, cap, crossAssetV2.maxEtfWeight)
  const cappedVolatility = portfolioVolatility(basis.covariance, {
    f4: fraction.f4 * f4Scale,
    o1: fraction.o1 * o1Scale,
  })
  if (!Number.isFinite(cappedVolatility)) return evidenceFailure(`Invalid sized macro volatility: ${signalDate}`)
  // Clipping one diversifier can increase volatility when the cross term is
  // negative. Recheck the joint book before applying the drawdown brake.
  const correction = Math.min(1, risk.targetVolatility / Math.max(cappedVolatility, macroRiskRules.volatilityFloor))
  const riskState = drawdownState(equity, highWaterMicros)
  const throttle =
    riskState === MacroRiskState.Normal
      ? 1
      : riskState === MacroRiskState.Brake
        ? macroRiskRules.brakeGrossMultiplier
        : 0
  const make = (
    policyHash: string,
    weights: readonly number[],
    scale: number,
    priorEquityMicros: bigint,
  ): MacroV2Target => ({
    ...basis.schedule,
    policyHash,
    riskState,
    priorEquityMicros,
    weights: weights.map((weight) => weight * scale * correction * throttle),
  })
  return Result.succeed({
    f4: make(policies.f4PolicyHash, basis.f4, f4Scale, f4EquityMicros),
    o1: make(policies.o1PolicyHash, basis.o1, o1Scale, o1EquityMicros),
    canaries: basis.canaries,
    forecastVolatility: cappedVolatility * correction * throttle,
  })
}

/** The live-shaped entry point admits only the latest paired close for the next opening. */
export const compileMacroPortfolioV2 = (risk: unknown, market: unknown, pairedClose: unknown) =>
  Result.gen(function* () {
    const prepared = yield* prepareMacroPortfolioV2(risk, market)
    const latest = prepared.basis.at(-1)
    if (latest === undefined || prepared.asOf > latest.schedule.executionOpenAt)
      return yield* evidenceFailure('Missed coordinated macro next-open cutoff')
    const sized = yield* sizeMacroPortfolioV2(prepared, latest, pairedClose)
    return { ...sized, snapshotHash: prepared.snapshotHash }
  })
