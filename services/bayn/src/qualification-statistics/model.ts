import { Schema } from 'effect'

import { IsoDateSchema, Sha256Schema } from '../contracts'
import { canonicalHashMatches } from '../qualification/hashing'
import {
  NonNegativeIntegerSchema as NonNegativeInteger,
  PositiveFiniteSchema as PositiveFinite,
  PositiveIntegerSchema as PositiveInteger,
  StrictNonEmptyStringSchema as NonEmptyString,
  UnitIntervalSchema as UnitInterval,
} from '../schemas'
import { canonicalOrderIssues } from './ordering'

const PositiveUnitInterval = Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThan(1))
const SimpleReturn = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(-1))
const Scalar = Schema.Union([Schema.Finite, Schema.Boolean, Schema.String])

const QualificationStatisticsPolicyFields = {
  annualizationSessions: Schema.Literal(252),
  confidence: Schema.Struct({
    familyOneSidedAlpha: Schema.Literal(0.05),
    multiplicityAdjustment: Schema.Literal('bonferroni'),
    minimumTailSamples: PositiveInteger,
  }),
  bootstrap: Schema.Struct({
    method: Schema.Literal('paired-complete-rebalance-blocks'),
    samples: Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 100_000 })),
    seedNamespace: NonEmptyString,
    lowerQuantile: Schema.Literal('nearest-rank'),
  }),
  power: Schema.Struct({
    method: Schema.Literal('normal-approximation-independent-rebalance-blocks'),
    oneSidedAlpha: Schema.Literal(0.05),
    targetPower: Schema.Literal(0.8),
    minimumDetectableAnnualizedExcessReturn: PositiveFinite,
    assumedAnnualizedTrackingVolatility: PositiveFinite,
    assumedSessionsPerRebalanceBlock: PositiveInteger,
    absoluteMinimumSessions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(504)),
    absoluteMinimumRebalanceBlocks: Schema.Int.check(Schema.isGreaterThanOrEqualTo(24)),
  }),
  walkForward: Schema.Struct({
    method: Schema.Literal('expanding-origin'),
    minimumTrainingSessions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(504)),
    testSessions: PositiveInteger,
    minimumFolds: PositiveInteger,
    minimumPositiveFoldFraction: PositiveUnitInterval,
    maximumFoldDrawdown: UnitInterval,
  }),
  cashReturn: Schema.Struct({
    method: Schema.Literal('actual-365-simple'),
  }),
} as const

export const QualificationStatisticsPolicySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.qualification-statistics-policy.v1'),
  ...QualificationStatisticsPolicyFields,
})
export type QualificationStatisticsPolicy = typeof QualificationStatisticsPolicySchema.Type

export const QualificationObservationSchema = Schema.Struct({
  sessionDate: IsoDateSchema,
  strategyReturn: SimpleReturn,
  cashReturn: SimpleReturn,
  buyAndHoldReturn: SimpleReturn,
  directVolatilityReturn: SimpleReturn,
})
export type QualificationObservation = typeof QualificationObservationSchema.Type

const QualificationSeriesBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.qualification-series.v1'),
  runId: Sha256Schema,
  observations: Schema.Array(QualificationObservationSchema).check(Schema.isMinLength(2)),
  rebalanceExecutionDates: Schema.Array(IsoDateSchema).check(Schema.isMinLength(1)),
})

export const QualificationSeriesSchema = QualificationSeriesBase.check(
  Schema.makeFilter((series: typeof QualificationSeriesBase.Type) => {
    const observationDates = series.observations.map((observation) => observation.sessionDate)
    const observed = new Set(observationDates)
    return [
      ...canonicalOrderIssues('observations', observationDates),
      ...canonicalOrderIssues('rebalanceExecutionDates', series.rebalanceExecutionDates),
      ...series.rebalanceExecutionDates.flatMap((date, index) =>
        observed.has(date)
          ? []
          : [{ path: ['rebalanceExecutionDates', index], issue: 'must identify an observed session' } as const],
      ),
    ]
  }),
)
export type QualificationSeries = typeof QualificationSeriesSchema.Type

export const PowerAnalysisSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.qualification-power.v1'),
  method: Schema.Literal('normal-approximation-independent-rebalance-blocks'),
  oneSidedAlpha: Schema.Literal(0.05),
  targetPower: Schema.Literal(0.8),
  minimumDetectableAnnualizedExcessReturn: PositiveFinite,
  assumedAnnualizedTrackingVolatility: PositiveFinite,
  standardizedEffect: PositiveFinite,
  requiredCompleteRebalanceBlocks: PositiveInteger,
  requiredSessions: PositiveInteger,
  availableCompleteRebalanceBlocks: NonNegativeInteger,
  availableCompleteSessions: NonNegativeInteger,
  sufficient: Schema.Boolean,
})
export type PowerAnalysis = typeof PowerAnalysisSchema.Type

export const CompleteBlockSchema = Schema.Struct({
  ordinal: NonNegativeInteger,
  startSession: IsoDateSchema,
  endSession: IsoDateSchema,
  nextRebalanceSession: IsoDateSchema,
  observationCount: PositiveInteger,
  contentHash: Sha256Schema,
})

export const BootstrapAnalysisSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.paired-block-bootstrap.v1'),
  method: Schema.Literal('paired-complete-rebalance-blocks'),
  selectedBenchmark: Schema.Literals(['buy-and-hold', 'direct-volatility-timing']),
  selectedBenchmarkSharpe: Schema.Finite,
  seedHash: Sha256Schema,
  requestedSamples: PositiveInteger,
  producedSamples: NonNegativeInteger,
  adjustedOneSidedAlpha: PositiveUnitInterval,
  tailSampleCount: NonNegativeInteger,
  minimumTailSamples: PositiveInteger,
  tailResolutionSufficient: Schema.Boolean,
  annualizedExcessReturnLowerBound: Schema.Finite,
  sharpeDifferenceLowerBound: Schema.Finite,
  annualizedExcessReturnSamples: Schema.Array(Schema.Finite),
  sharpeDifferenceSamples: Schema.Array(Schema.Finite),
  samplesHash: Sha256Schema,
})

export const WalkForwardFoldSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.walk-forward-fold.v1'),
  ordinal: NonNegativeInteger,
  trainingStart: IsoDateSchema,
  trainingEnd: IsoDateSchema,
  testStart: IsoDateSchema,
  testEnd: IsoDateSchema,
  testObservationCount: PositiveInteger,
  strategyReturn: Schema.Finite,
  cashReturn: Schema.Finite,
  excessReturn: Schema.Finite,
  maximumDrawdown: UnitInterval,
  positiveExcess: Schema.Boolean,
  drawdownWithinLimit: Schema.Boolean,
  contentHash: Sha256Schema,
})

export const WalkForwardAnalysisSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.walk-forward.v1'),
  method: Schema.Literal('expanding-origin'),
  folds: Schema.Array(WalkForwardFoldSchema),
  requiredFolds: PositiveInteger,
  positiveFolds: NonNegativeInteger,
  positiveFoldFraction: UnitInterval,
  requiredPositiveFoldFraction: PositiveUnitInterval,
  allDrawdownsWithinLimit: Schema.Boolean,
  maximumFoldDrawdown: UnitInterval,
  sufficient: Schema.Boolean,
})

export const QualificationGateSchema = Schema.Struct({
  name: NonEmptyString,
  passed: Schema.Boolean,
  actual: Scalar,
  required: Scalar,
})

export const QualificationAnalysisMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.qualification-analysis.v1'),
  runId: Sha256Schema,
  policy: QualificationStatisticsPolicySchema,
  priorTrialRunIds: Schema.Array(Sha256Schema),
  candidateOrdinal: PositiveInteger,
  completeBlocks: Schema.Array(CompleteBlockSchema),
  power: PowerAnalysisSchema,
  bootstrap: BootstrapAnalysisSchema,
  walkForward: WalkForwardAnalysisSchema,
  gates: Schema.Array(QualificationGateSchema),
  status: Schema.Literals(['PASS', 'REJECTED', 'INSUFFICIENT']),
  reasonCodes: Schema.Array(NonEmptyString),
})

const QualificationAnalysisBase = Schema.Struct({
  ...QualificationAnalysisMaterialSchema.fields,
  analysisHash: Sha256Schema,
})

export const QualificationAnalysisSchema = QualificationAnalysisBase.check(
  Schema.makeFilter((analysis: typeof QualificationAnalysisBase.Type) => {
    const { analysisHash, ...material } = analysis
    const issues = [...canonicalOrderIssues('priorTrialRunIds', analysis.priorTrialRunIds)]
    const bootstrapSamples = {
      schemaVersion: 'bayn.qualification-bootstrap-samples.v1',
      annualizedExcessReturnSamples: analysis.bootstrap.annualizedExcessReturnSamples,
      sharpeDifferenceSamples: analysis.bootstrap.sharpeDifferenceSamples,
    }
    if (analysis.candidateOrdinal !== analysis.priorTrialRunIds.length + 1) {
      issues.push({ path: ['candidateOrdinal'], issue: 'must follow every prior trial' })
    }
    if (
      analysis.bootstrap.producedSamples !== analysis.bootstrap.annualizedExcessReturnSamples.length ||
      analysis.bootstrap.producedSamples !== analysis.bootstrap.sharpeDifferenceSamples.length
    ) {
      issues.push({ path: ['bootstrap', 'producedSamples'], issue: 'must match both sample distributions' })
    }
    if (!canonicalHashMatches(analysis.bootstrap.samplesHash, bootstrapSamples)) {
      issues.push({ path: ['bootstrap', 'samplesHash'], issue: 'must match the bootstrap sample distributions' })
    }
    if (
      analysis.completeBlocks.some(
        (block, index) =>
          block.ordinal !== index ||
          block.startSession > block.endSession ||
          block.endSession >= block.nextRebalanceSession,
      )
    ) {
      issues.push({ path: ['completeBlocks'], issue: 'must be ordinal and have increasing boundaries' })
    }
    if (
      analysis.walkForward.folds.some((fold, index) => {
        const { contentHash, ...foldMaterial } = fold
        return fold.ordinal !== index || !canonicalHashMatches(contentHash, foldMaterial)
      })
    ) {
      issues.push({ path: ['walkForward', 'folds'], issue: 'must be ordinal and match their content hashes' })
    }
    const positiveFolds = analysis.walkForward.folds.filter((fold) => fold.positiveExcess).length
    const allDrawdownsWithinLimit = analysis.walkForward.folds.every((fold) => fold.drawdownWithinLimit)
    if (
      analysis.walkForward.positiveFolds !== positiveFolds ||
      analysis.walkForward.allDrawdownsWithinLimit !== allDrawdownsWithinLimit
    ) {
      issues.push({ path: ['walkForward'], issue: 'summary must match the fold evidence' })
    }
    if (!canonicalHashMatches(analysisHash, material)) {
      issues.push({ path: ['analysisHash'], issue: 'must match the canonical analysis content hash' })
    }
    return issues
  }),
)
export type QualificationAnalysis = typeof QualificationAnalysisSchema.Type

export interface QualificationAnalysisInput {
  readonly series: QualificationSeries
  readonly policy: QualificationStatisticsPolicy
  readonly priorTrialRunIds: readonly string[]
}

export type BootstrapAnalysis = QualificationAnalysis['bootstrap']
export type CompleteBlockEvidence = QualificationAnalysis['completeBlocks'][number]
export type QualificationGate = QualificationAnalysis['gates'][number]
export type QualificationStatus = QualificationAnalysis['status']
export type WalkForwardAnalysis = QualificationAnalysis['walkForward']
