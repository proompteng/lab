import { Result } from 'effect'

import { canonicalHashV1Result } from '../../hash'
import { OpeningDriveQualificationFailure, type OpeningDriveQualificationPolicy } from './qualification-model'

export const defaultOpeningDriveQualificationPolicy: OpeningDriveQualificationPolicy = Object.freeze({
  schemaVersion: 'bayn.opening-drive.qualification-policy.v1',
  allocationMicros: '10000000000',
  annualizationSessions: 252,
  minimumSessions: 60,
  minimumTradeSessions: 20,
  power: Object.freeze({
    method: 'normal-approximation-independent-sessions',
    oneSidedAlpha: 0.05,
    targetPower: 0.8,
    minimumDetectableAnnualizedExcessReturn: 0.03,
    assumedAnnualizedTrackingVolatility: 0.1,
  }),
  bootstrap: Object.freeze({
    method: 'paired-circular-session-blocks',
    samples: 10_000,
    blockSessions: 5,
    familyOneSidedAlpha: 0.05,
    minimumTailSamples: 20,
    seedNamespace: 'bayn-opening-drive-qualification-v1',
  }),
  chronologicalFolds: Object.freeze({ count: 3, minimumPositiveFraction: 2 / 3 }),
  maximumDrawdown: 0.15,
})

const policyFailure = (message: string): OpeningDriveQualificationFailure =>
  new OpeningDriveQualificationFailure({ reason: 'policy', message })

export const validateOpeningDriveQualificationPolicy = (
  policy: OpeningDriveQualificationPolicy,
): Result.Result<OpeningDriveQualificationPolicy, OpeningDriveQualificationFailure> => {
  if (
    policy.schemaVersion !== 'bayn.opening-drive.qualification-policy.v1' ||
    policy.annualizationSessions !== 252 ||
    policy.power.method !== 'normal-approximation-independent-sessions' ||
    policy.power.oneSidedAlpha !== 0.05 ||
    policy.power.targetPower !== 0.8 ||
    policy.bootstrap.method !== 'paired-circular-session-blocks' ||
    policy.bootstrap.familyOneSidedAlpha !== 0.05 ||
    policy.bootstrap.seedNamespace !== 'bayn-opening-drive-qualification-v1'
  ) {
    return Result.fail(policyFailure('qualification fixed protocol parameters do not match the reviewed policy'))
  }
  const allocation = /^[0-9]+$/.test(policy.allocationMicros) ? BigInt(policy.allocationMicros) : 0n
  const positiveIntegers = [
    policy.minimumSessions,
    policy.minimumTradeSessions,
    policy.bootstrap.samples,
    policy.bootstrap.blockSessions,
    policy.bootstrap.minimumTailSamples,
    policy.chronologicalFolds.count,
  ]
  if (allocation <= 0n) return Result.fail(policyFailure('qualification allocation must be a positive integer'))
  if (positiveIntegers.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    return Result.fail(policyFailure('qualification count parameters must be positive safe integers'))
  }
  if (policy.bootstrap.samples < 1_000 || policy.bootstrap.samples > 100_000) {
    return Result.fail(policyFailure('qualification bootstrap samples must be between 1,000 and 100,000'))
  }
  if (policy.minimumTradeSessions > policy.minimumSessions) {
    return Result.fail(policyFailure('minimum trade sessions must not exceed minimum sessions'))
  }
  if (policy.bootstrap.blockSessions > policy.minimumSessions) {
    return Result.fail(policyFailure('bootstrap block length must not exceed minimum sessions'))
  }
  if (policy.chronologicalFolds.count > policy.minimumSessions) {
    return Result.fail(policyFailure('chronological fold count must not exceed minimum sessions'))
  }
  if (
    !Number.isFinite(policy.power.minimumDetectableAnnualizedExcessReturn) ||
    policy.power.minimumDetectableAnnualizedExcessReturn <= 0 ||
    !Number.isFinite(policy.power.assumedAnnualizedTrackingVolatility) ||
    policy.power.assumedAnnualizedTrackingVolatility <= 0
  ) {
    return Result.fail(policyFailure('qualification power assumptions must be positive and finite'))
  }
  const requiredSessions = openingDriveRequiredQualificationSessions(policy)
  if (!Number.isSafeInteger(requiredSessions) || requiredSessions <= 0) {
    return Result.fail(policyFailure('qualification power assumptions must produce a finite safe session count'))
  }
  if (
    policy.chronologicalFolds.minimumPositiveFraction <= 0 ||
    policy.chronologicalFolds.minimumPositiveFraction > 1 ||
    policy.maximumDrawdown < 0 ||
    policy.maximumDrawdown > 1
  ) {
    return Result.fail(policyFailure('qualification fractions must remain within their closed unit domains'))
  }
  return Result.succeed(policy)
}

const zPower80 = 0.8416212335729143

// Peter J. Acklam's rational approximation, evaluated in the lower tail so
// very small family-wise alphas do not lose precision through `1 - alpha`.
const upperNormalCriticalValue = (oneSidedAlpha: number): number => {
  if (!Number.isFinite(oneSidedAlpha) || oneSidedAlpha <= 0 || oneSidedAlpha >= 0.5) return Number.NaN
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1,
    2.506628277459239,
  ] as const
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1,
  ] as const
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783,
  ] as const
  const q = Math.sqrt(-2 * Math.log(oneSidedAlpha))
  const numerator = ((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]
  const denominator =
    (((7.784695709041462e-3 * q + 3.224671290700398e-1) * q + 2.445134137142996) * q + 3.754408661907416) * q + 1
  if (oneSidedAlpha < 0.02425) return -(numerator / denominator)
  const centered = oneSidedAlpha - 0.5
  const squared = centered * centered
  const centralNumerator =
    (((((a[0] * squared + a[1]) * squared + a[2]) * squared + a[3]) * squared + a[4]) * squared + a[5]) * centered
  const centralDenominator =
    ((((b[0] * squared + b[1]) * squared + b[2]) * squared + b[3]) * squared + b[4]) * squared + 1
  return -(centralNumerator / centralDenominator)
}

export const openingDriveRequiredQualificationSessions = (
  policy: OpeningDriveQualificationPolicy,
  adjustedOneSidedAlpha = policy.bootstrap.familyOneSidedAlpha / 2,
): number => {
  const standardizedEffect =
    policy.power.minimumDetectableAnnualizedExcessReturn / policy.power.assumedAnnualizedTrackingVolatility
  const alphaCriticalValue = upperNormalCriticalValue(adjustedOneSidedAlpha)
  return Math.max(
    policy.minimumSessions,
    Math.ceil(((alphaCriticalValue + zPower80) / standardizedEffect) ** 2 * policy.annualizationSessions),
  )
}

export const hashOpeningDriveQualificationPolicy = (
  policy: OpeningDriveQualificationPolicy,
): Result.Result<string, OpeningDriveQualificationFailure> =>
  Result.mapError(
    canonicalHashV1Result(policy),
    (cause) =>
      new OpeningDriveQualificationFailure({
        reason: 'canonicalization',
        message: 'opening-drive qualification policy is not canonically hashable',
        cause,
      }),
  )
