import { Result } from 'effect'

import {
  qualificationStatisticsMaximumBootstrapSamples,
  qualificationStatisticsMinimumBootstrapSamples,
  type QualificationStatisticsPolicy,
} from './model'
import { Pipeable } from '../pipeable'

export const qualificationStatisticsPolicySchemaVersion = 'bayn.qualification-statistics-policy.v1' as const
export const qualificationPolicyMaximumCandidateOrdinal = 25

const familyOneSidedAlpha = 0.05
const minimumTailSamples = 20
const defaultWalkForwardTestSessions = 252
const defaultWalkForwardMinimumFolds = 5
const maximumCandidateOrdinalSupportedByBootstrapSchema = Math.floor(
  (qualificationStatisticsMaximumBootstrapSamples * familyOneSidedAlpha) / minimumTailSamples,
)

export interface QualificationStatisticsPolicyOptions {
  readonly maximumCandidateOrdinal: number
  readonly walkForward?: {
    readonly testSessions?: number
    readonly minimumFolds?: number
  }
}

export type QualificationStatisticsPolicyConstructionFailure = {
  readonly _tag: 'QualificationStatisticsPolicyOptionInvalid'
  readonly field: 'maximumCandidateOrdinal' | 'walkForward.testSessions' | 'walkForward.minimumFolds'
  readonly value: number
  readonly reason: 'must-be-positive-safe-integer' | 'exceeds-bootstrap-schema-cap'
  readonly maximum?: number
}

export type QualificationStatisticsPolicyResult = Result.Result<
  QualificationStatisticsPolicy,
  QualificationStatisticsPolicyConstructionFailure
>

const bootstrapSamplesForOrdinalHorizon = (maximumCandidateOrdinal: number): number =>
  Math.max(
    qualificationStatisticsMinimumBootstrapSamples,
    Math.ceil((minimumTailSamples * maximumCandidateOrdinal) / familyOneSidedAlpha),
  )

const positiveSafeIntegerOption = (
  field: Extract<QualificationStatisticsPolicyConstructionFailure['field'], `walkForward.${string}`>,
  value: number,
): Result.Result<number, QualificationStatisticsPolicyConstructionFailure> =>
  Number.isSafeInteger(value) && value > 0
    ? Result.succeed(value)
    : Result.fail({
        _tag: 'QualificationStatisticsPolicyOptionInvalid',
        field,
        value,
        reason: 'must-be-positive-safe-integer',
      })

const validateQualificationStatisticsPolicyOptions = ({
  maximumCandidateOrdinal,
  walkForward,
}: QualificationStatisticsPolicyOptions): Result.Result<
  {
    readonly maximumCandidateOrdinal: number
    readonly testSessions: number
    readonly minimumFolds: number
  },
  QualificationStatisticsPolicyConstructionFailure
> => {
  if (!Number.isSafeInteger(maximumCandidateOrdinal) || maximumCandidateOrdinal <= 0) {
    return Result.fail({
      _tag: 'QualificationStatisticsPolicyOptionInvalid',
      field: 'maximumCandidateOrdinal',
      value: maximumCandidateOrdinal,
      reason: 'must-be-positive-safe-integer',
    })
  }
  if (maximumCandidateOrdinal > maximumCandidateOrdinalSupportedByBootstrapSchema) {
    return Result.fail({
      _tag: 'QualificationStatisticsPolicyOptionInvalid',
      field: 'maximumCandidateOrdinal',
      value: maximumCandidateOrdinal,
      reason: 'exceeds-bootstrap-schema-cap',
      maximum: maximumCandidateOrdinalSupportedByBootstrapSchema,
    })
  }

  const testSessions = walkForward?.testSessions ?? defaultWalkForwardTestSessions
  const minimumFolds = walkForward?.minimumFolds ?? defaultWalkForwardMinimumFolds
  return Result.all({
    maximumCandidateOrdinal: Result.succeed(maximumCandidateOrdinal),
    testSessions: positiveSafeIntegerOption('walkForward.testSessions', testSessions),
    minimumFolds: positiveSafeIntegerOption('walkForward.minimumFolds', minimumFolds),
  })
}

export const makeQualificationStatisticsPolicy = ({
  maximumCandidateOrdinal,
  walkForward,
}: QualificationStatisticsPolicyOptions): QualificationStatisticsPolicyResult =>
  Result.map(
    validateQualificationStatisticsPolicyOptions({
      maximumCandidateOrdinal,
      ...(walkForward === undefined ? {} : { walkForward }),
    }),
    ({ testSessions, minimumFolds }) => ({
      schemaVersion: qualificationStatisticsPolicySchemaVersion,
      annualizationSessions: 252,
      confidence: {
        familyOneSidedAlpha,
        multiplicityAdjustment: 'bonferroni',
        minimumTailSamples,
      },
      bootstrap: {
        method: 'paired-complete-rebalance-blocks',
        samples: bootstrapSamplesForOrdinalHorizon(maximumCandidateOrdinal),
        seedNamespace: 'bayn-risk-balanced-trend-qualification-v1',
        lowerQuantile: 'nearest-rank',
      },
      power: {
        method: 'normal-approximation-independent-rebalance-blocks',
        oneSidedAlpha: 0.05,
        targetPower: 0.8,
        minimumDetectableAnnualizedExcessReturn: 0.03,
        assumedAnnualizedTrackingVolatility: 0.1,
        assumedSessionsPerRebalanceBlock: 21,
        absoluteMinimumSessions: 504,
        absoluteMinimumRebalanceBlocks: 24,
      },
      walkForward: {
        method: 'expanding-origin',
        minimumTrainingSessions: 504,
        testSessions,
        minimumFolds,
        minimumPositiveFoldFraction: 0.6,
        maximumFoldDrawdown: 0.35,
      },
      cashReturn: { method: 'actual-365-simple' },
    }),
  )

export const defaultQualificationStatisticsPolicy = Result.getOrThrow(
  makeQualificationStatisticsPolicy({
    maximumCandidateOrdinal: qualificationPolicyMaximumCandidateOrdinal,
  }),
)

export interface QualificationOrdinalTailCapacity {
  readonly candidateOrdinal: number
  readonly adjustedOneSidedAlpha: number
  readonly tailSampleCount: number
  readonly minimumTailSamples: number
}

const qualificationTailCapacityForOrdinalDataFirst = (
  policy: QualificationStatisticsPolicy,
  candidateOrdinal: number,
): QualificationOrdinalTailCapacity => {
  const adjustedOneSidedAlpha = policy.confidence.familyOneSidedAlpha / candidateOrdinal
  return {
    candidateOrdinal,
    adjustedOneSidedAlpha,
    tailSampleCount: Math.floor(policy.bootstrap.samples * adjustedOneSidedAlpha),
    minimumTailSamples: policy.confidence.minimumTailSamples,
  }
}

export const qualificationTailCapacityForOrdinal = Pipeable.dual(2, qualificationTailCapacityForOrdinalDataFirst)
