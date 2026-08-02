import type { QualificationStatisticsPolicy } from './model'

export const qualificationStatisticsPolicySchemaVersion = 'bayn.qualification-statistics-policy.v1' as const
export const qualificationPolicyMaximumCandidateOrdinal = 25

const minimumBootstrapSamples = 1_000
const familyOneSidedAlpha = 0.05
const minimumTailSamples = 20

export interface QualificationStatisticsPolicyOptions {
  readonly maximumCandidateOrdinal: number
  readonly walkForward?: {
    readonly testSessions?: number
    readonly minimumFolds?: number
  }
}

const bootstrapSamplesForOrdinalHorizon = (maximumCandidateOrdinal: number): number =>
  Math.max(minimumBootstrapSamples, Math.ceil((minimumTailSamples * maximumCandidateOrdinal) / familyOneSidedAlpha))

export const makeQualificationStatisticsPolicy = ({
  maximumCandidateOrdinal,
  walkForward,
}: QualificationStatisticsPolicyOptions): QualificationStatisticsPolicy => ({
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
    testSessions: walkForward?.testSessions ?? 252,
    minimumFolds: walkForward?.minimumFolds ?? 5,
    minimumPositiveFoldFraction: 0.6,
    maximumFoldDrawdown: 0.35,
  },
  cashReturn: { method: 'actual-365-simple' },
})

export const defaultQualificationStatisticsPolicy = makeQualificationStatisticsPolicy({
  maximumCandidateOrdinal: qualificationPolicyMaximumCandidateOrdinal,
})

export interface QualificationOrdinalTailCapacity {
  readonly candidateOrdinal: number
  readonly adjustedOneSidedAlpha: number
  readonly tailSampleCount: number
  readonly minimumTailSamples: number
}

export const qualificationTailCapacityForOrdinal = (
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
