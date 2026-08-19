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

const zOneSided95 = 1.6448536269514722
const zPower80 = 0.8416212335729143

export const openingDriveRequiredQualificationSessions = (policy: OpeningDriveQualificationPolicy): number => {
  const standardizedEffect =
    policy.power.minimumDetectableAnnualizedExcessReturn / policy.power.assumedAnnualizedTrackingVolatility
  return Math.max(policy.minimumSessions, Math.ceil(((zOneSided95 + zPower80) / standardizedEffect) ** 2))
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
