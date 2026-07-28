import { Chunk, pipe, Result, Schema } from 'effect'

import { IsoDateSchema, Sha256Schema } from './contracts'
import { canonicalHashV1Result, renderCanonicalJsonFailure, type CanonicalJsonFailure } from './hash'
import {
  NonNegativeIntegerSchema as NonNegativeInteger,
  PositiveFiniteSchema as PositiveFinite,
  PositiveIntegerSchema as PositiveInteger,
  StrictNonEmptyStringSchema as NonEmptyString,
  UnitIntervalSchema as UnitInterval,
  strictParseOptions as StrictParseOptions,
} from './schemas'
import type { EvaluationResult, IsoDate } from './types'
import { decideQualification } from './qualification-statistics/decision'
import {
  annualizedSharpe,
  mean,
  nearestRankLowerQuantile,
  roundStatistic,
} from './qualification-statistics/numerical-methods'
import { calculateWalkForward } from './qualification-statistics/walk-forward'

const PositiveUnitInterval = Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThan(1))
const SimpleReturn = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(-1))
const Scalar = Schema.Union([Schema.Finite, Schema.Boolean, Schema.String])

export const QualificationStatisticsPolicySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.qualification-statistics-policy.v1'),
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
})
export type QualificationStatisticsPolicy = typeof QualificationStatisticsPolicySchema.Type

export const defaultQualificationStatisticsPolicy = {
  schemaVersion: 'bayn.qualification-statistics-policy.v1',
  annualizationSessions: 252,
  confidence: {
    familyOneSidedAlpha: 0.05,
    multiplicityAdjustment: 'bonferroni',
    minimumTailSamples: 20,
  },
  bootstrap: {
    method: 'paired-complete-rebalance-blocks',
    samples: 5_000,
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
    testSessions: 252,
    minimumFolds: 5,
    minimumPositiveFoldFraction: 0.6,
    maximumFoldDrawdown: 0.35,
  },
  cashReturn: { method: 'actual-365-simple' },
} as const satisfies QualificationStatisticsPolicy

const QualificationObservationSchema = Schema.Struct({
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

const canonicalDates = (path: string, values: readonly string[]): readonly Schema.FilterIssue[] => {
  const canonical = [...new Set(values)].sort()
  if (canonical.length !== values.length) return [{ path: [path], issue: 'must not contain duplicates' }]
  if (canonical.some((value, index) => value !== values.at(index))) {
    return [{ path: [path], issue: 'must be strictly increasing' }]
  }
  return []
}

const canonicalHashMatches = (expected: string, value: unknown): boolean => {
  const result = canonicalHashV1Result(value)
  return Result.isSuccess(result) && result.success === expected
}

export const QualificationSeriesSchema = QualificationSeriesBase.check(
  Schema.makeFilter((series: typeof QualificationSeriesBase.Type) => {
    const observationDates = series.observations.map((observation) => observation.sessionDate)
    const observed = new Set(observationDates)
    return [
      ...canonicalDates('observations', observationDates),
      ...canonicalDates('rebalanceExecutionDates', series.rebalanceExecutionDates),
      ...series.rebalanceExecutionDates.flatMap((date, index) =>
        observed.has(date)
          ? []
          : [{ path: ['rebalanceExecutionDates', index], issue: 'must identify an observed session' } as const],
      ),
    ]
  }),
)
export type QualificationSeries = typeof QualificationSeriesSchema.Type

const PowerAnalysisSchema = Schema.Struct({
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

const CompleteBlockSchema = Schema.Struct({
  ordinal: NonNegativeInteger,
  startSession: IsoDateSchema,
  endSession: IsoDateSchema,
  nextRebalanceSession: IsoDateSchema,
  observationCount: PositiveInteger,
  contentHash: Sha256Schema,
})

const BootstrapAnalysisSchema = Schema.Struct({
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

const WalkForwardFoldSchema = Schema.Struct({
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

const WalkForwardAnalysisSchema = Schema.Struct({
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

const QualificationGateSchema = Schema.Struct({
  name: NonEmptyString,
  passed: Schema.Boolean,
  actual: Scalar,
  required: Scalar,
})

const QualificationAnalysisMaterial = Schema.Struct({
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
  ...QualificationAnalysisMaterial.fields,
  analysisHash: Sha256Schema,
})

export const QualificationAnalysisSchema = QualificationAnalysisBase.check(
  Schema.makeFilter((analysis: typeof QualificationAnalysisBase.Type) => {
    const { analysisHash, ...material } = analysis
    const issues = [...canonicalDates('priorTrialRunIds', analysis.priorTrialRunIds)]
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

export type QualificationStatisticsFailure =
  | {
      readonly _tag: 'QualificationStatisticsSchemaInvalid'
      readonly operation: 'analysis' | 'policy' | 'power' | 'prior-trial-run-ids' | 'series'
      readonly cause: Schema.SchemaError
    }
  | {
      readonly _tag: 'QualificationStatisticsCanonicalizationFailed'
      readonly operation: 'analysis' | 'bootstrap-samples' | 'bootstrap-seed' | 'complete-block' | 'walk-forward-fold'
      readonly cause: CanonicalJsonFailure
    }
  | {
      readonly _tag: 'QualificationStatisticNotFinite'
      readonly operation: 'power' | 'round'
      readonly value: number
    }
  | {
      readonly _tag: 'QualificationDateOrderInvalid'
      readonly previous: IsoDate
      readonly current: IsoDate
    }
  | {
      readonly _tag: 'QualificationSeriesAlignmentFailed'
      readonly reason:
        | 'duplicate-buy-and-hold-date'
        | 'duplicate-direct-volatility-date'
        | 'missing-buy-and-hold-observation'
        | 'missing-direct-volatility-observation'
        | 'observation-count-mismatch'
      readonly sessionDate: IsoDate | null
      readonly strategyCount: number
      readonly buyAndHoldCount: number
      readonly directVolatilityCount: number
    }
  | {
      readonly _tag: 'QualificationLineageInvalid'
      readonly priorTrialRunIds: readonly string[]
    }
  | {
      readonly _tag: 'QualificationRandomIndexInvalid'
      readonly maximum: number
    }
  | {
      readonly _tag: 'QualificationSamplingBlockMissing'
      readonly index: number
      readonly blockCount: number
    }
  | {
      readonly _tag: 'QualificationWalkForwardBoundaryMissing'
      readonly testStart: number
      readonly testSessions: number
      readonly observationCount: number
    }

export const renderQualificationStatisticsFailure = (failure: QualificationStatisticsFailure): string => {
  switch (failure._tag) {
    case 'QualificationStatisticsSchemaInvalid':
      return `${failure.operation} schema validation failed: ${failure.cause.message}`
    case 'QualificationStatisticsCanonicalizationFailed':
      return `${failure.operation} canonicalization failed: ${renderCanonicalJsonFailure(failure.cause)}`
    case 'QualificationStatisticNotFinite':
      return `${failure.operation} statistic is not finite: ${failure.value}`
    case 'QualificationDateOrderInvalid':
      return `qualification dates are not increasing: ${failure.previous} then ${failure.current}`
    case 'QualificationSeriesAlignmentFailed':
      return `qualification series ${failure.reason} at ${failure.sessionDate ?? 'no session'} (strategy=${failure.strategyCount}, buy-and-hold=${failure.buyAndHoldCount}, direct-volatility=${failure.directVolatilityCount})`
    case 'QualificationLineageInvalid':
      return `prior qualification run IDs are not canonical: ${failure.priorTrialRunIds.join(',')}`
    case 'QualificationRandomIndexInvalid':
      return `bootstrap random index maximum must be positive: ${failure.maximum}`
    case 'QualificationSamplingBlockMissing':
      return `bootstrap block ${failure.index} is outside ${failure.blockCount} blocks`
    case 'QualificationWalkForwardBoundaryMissing':
      return `walk-forward test window ${failure.testStart}+${failure.testSessions} exceeds ${failure.observationCount} observations`
  }
}

interface BlockWork {
  readonly evidence: typeof CompleteBlockSchema.Type
  readonly observations: readonly QualificationObservation[]
}

const Z_ONE_SIDED_95 = 1.6448536269514722
const Z_POWER_80 = 0.8416212335729143

const fail = <A = never>(failure: QualificationStatisticsFailure): Result.Result<A, QualificationStatisticsFailure> =>
  Result.fail(failure)

const canonicalHashResult = (
  operation: Extract<
    QualificationStatisticsFailure,
    { readonly _tag: 'QualificationStatisticsCanonicalizationFailed' }
  >['operation'],
  value: unknown,
): Result.Result<string, QualificationStatisticsFailure> =>
  pipe(
    canonicalHashV1Result(value),
    Result.mapError(
      (cause): QualificationStatisticsFailure => ({
        _tag: 'QualificationStatisticsCanonicalizationFailed',
        operation,
        cause,
      }),
    ),
  )

const finiteStatistic = (
  operation: Extract<QualificationStatisticsFailure, { readonly _tag: 'QualificationStatisticNotFinite' }>['operation'],
  value: number,
): Result.Result<number, QualificationStatisticsFailure> =>
  Number.isFinite(value) ? Result.succeed(value) : fail({ _tag: 'QualificationStatisticNotFinite', operation, value })

const daysBetween = (left: IsoDate, right: IsoDate): Result.Result<number, QualificationStatisticsFailure> => {
  const milliseconds = Date.parse(`${right}T00:00:00.000Z`) - Date.parse(`${left}T00:00:00.000Z`)
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? Result.succeed(Math.round(milliseconds / 86_400_000))
    : fail({ _tag: 'QualificationDateOrderInvalid', previous: left, current: right })
}

const dailyCashReturn = (annualYieldBps: number, elapsedDays: number): number =>
  (annualYieldBps / 10_000) * (elapsedDays / 365)

const decodeSeriesResult = Schema.decodeUnknownResult(QualificationSeriesSchema, StrictParseOptions)
const decodePolicyResult = Schema.decodeUnknownResult(QualificationStatisticsPolicySchema, StrictParseOptions)
const decodePowerResult = Schema.decodeUnknownResult(PowerAnalysisSchema, StrictParseOptions)
const decodeAnalysisResult = Schema.decodeUnknownResult(QualificationAnalysisSchema, StrictParseOptions)
const decodePriorTrialRunIdsResult = Schema.decodeUnknownResult(Schema.Array(Sha256Schema), StrictParseOptions)

const schemaFailure =
  (
    operation: Extract<
      QualificationStatisticsFailure,
      { readonly _tag: 'QualificationStatisticsSchemaInvalid' }
    >['operation'],
  ) =>
  (cause: Schema.SchemaError): QualificationStatisticsFailure => ({
    _tag: 'QualificationStatisticsSchemaInvalid',
    operation,
    cause,
  })

const duplicateDate = (points: readonly { readonly sessionDate: IsoDate }[]): IsoDate | null =>
  points.find((point, index) => points.findIndex((candidate) => candidate.sessionDate === point.sessionDate) !== index)
    ?.sessionDate ?? null

export const prepareQualificationSeries = (
  evaluation: EvaluationResult,
): Result.Result<QualificationSeries, QualificationStatisticsFailure> => {
  const duplicateBuyAndHoldDate = duplicateDate(evaluation.benchmarkSeries.buyAndHold)
  if (duplicateBuyAndHoldDate !== null) {
    return fail({
      _tag: 'QualificationSeriesAlignmentFailed',
      reason: 'duplicate-buy-and-hold-date',
      sessionDate: duplicateBuyAndHoldDate,
      strategyCount: evaluation.simulation.dailyMarks.length,
      buyAndHoldCount: evaluation.benchmarkSeries.buyAndHold.length,
      directVolatilityCount: evaluation.benchmarkSeries.directVolTiming.length,
    })
  }
  const duplicateDirectVolatilityDate = duplicateDate(evaluation.benchmarkSeries.directVolTiming)
  if (duplicateDirectVolatilityDate !== null) {
    return fail({
      _tag: 'QualificationSeriesAlignmentFailed',
      reason: 'duplicate-direct-volatility-date',
      sessionDate: duplicateDirectVolatilityDate,
      strategyCount: evaluation.simulation.dailyMarks.length,
      buyAndHoldCount: evaluation.benchmarkSeries.buyAndHold.length,
      directVolatilityCount: evaluation.benchmarkSeries.directVolTiming.length,
    })
  }
  const buyAndHold = new Map(
    evaluation.benchmarkSeries.buyAndHold.map((point) => [point.sessionDate, point.netReturn] as const),
  )
  const directVolatility = new Map(
    evaluation.benchmarkSeries.directVolTiming.map((point) => [point.sessionDate, point.netReturn] as const),
  )
  const observations = Result.all(
    evaluation.simulation.dailyMarks.map((point, index) => {
      const buyAndHoldReturn = buyAndHold.get(point.sessionDate)
      if (buyAndHoldReturn === undefined) {
        return fail({
          _tag: 'QualificationSeriesAlignmentFailed',
          reason: 'missing-buy-and-hold-observation',
          sessionDate: point.sessionDate,
          strategyCount: evaluation.simulation.dailyMarks.length,
          buyAndHoldCount: buyAndHold.size,
          directVolatilityCount: directVolatility.size,
        })
      }
      const directVolatilityReturn = directVolatility.get(point.sessionDate)
      if (directVolatilityReturn === undefined) {
        return fail({
          _tag: 'QualificationSeriesAlignmentFailed',
          reason: 'missing-direct-volatility-observation',
          sessionDate: point.sessionDate,
          strategyCount: evaluation.simulation.dailyMarks.length,
          buyAndHoldCount: buyAndHold.size,
          directVolatilityCount: directVolatility.size,
        })
      }
      const previousDate = evaluation.simulation.dailyMarks.at(index - 1)?.sessionDate
      const elapsedDays =
        index === 0 || previousDate === undefined ? Result.succeed(1) : daysBetween(previousDate, point.sessionDate)
      return pipe(
        elapsedDays,
        Result.map((days) => ({
          sessionDate: point.sessionDate,
          strategyReturn: point.netReturn,
          cashReturn: dailyCashReturn(evaluation.simulation.executionModel.cash.annualYieldBps, days),
          buyAndHoldReturn,
          directVolatilityReturn,
        })),
      )
    }),
  )
  if (Result.isFailure(observations)) return fail(observations.failure)
  if (buyAndHold.size !== observations.success.length || directVolatility.size !== observations.success.length) {
    return fail({
      _tag: 'QualificationSeriesAlignmentFailed',
      reason: 'observation-count-mismatch',
      sessionDate: null,
      strategyCount: observations.success.length,
      buyAndHoldCount: buyAndHold.size,
      directVolatilityCount: directVolatility.size,
    })
  }
  return pipe(
    decodeSeriesResult({
      schemaVersion: 'bayn.qualification-series.v1',
      runId: evaluation.runId,
      observations: observations.success,
      rebalanceExecutionDates: evaluation.signalDecisions.map((decision) => decision.executionDate),
    }),
    Result.mapError(schemaFailure('series')),
  )
}

export const calculateQualificationPower = (
  policy: QualificationStatisticsPolicy,
  availableCompleteRebalanceBlocks: number,
  availableCompleteSessions: number,
): Result.Result<PowerAnalysis, QualificationStatisticsFailure> =>
  pipe(
    decodePolicyResult(policy),
    Result.mapError(schemaFailure('policy')),
    Result.flatMap((decoded) => {
      const standardizedEffect =
        decoded.power.minimumDetectableAnnualizedExcessReturn / decoded.power.assumedAnnualizedTrackingVolatility
      const estimatedBlocks = Math.ceil(((Z_ONE_SIDED_95 + Z_POWER_80) / standardizedEffect) ** 2)
      const requiredCompleteRebalanceBlocks = Math.max(decoded.power.absoluteMinimumRebalanceBlocks, estimatedBlocks)
      const requiredSessions = Math.max(
        decoded.power.absoluteMinimumSessions,
        requiredCompleteRebalanceBlocks * decoded.power.assumedSessionsPerRebalanceBlock,
      )
      return pipe(
        Result.all({
          standardizedEffect: roundStatistic(standardizedEffect),
          requiredCompleteRebalanceBlocks: pipe(
            finiteStatistic('power', requiredCompleteRebalanceBlocks),
            Result.map(Math.trunc),
          ),
          requiredSessions: pipe(finiteStatistic('power', requiredSessions), Result.map(Math.trunc)),
        }),
        Result.flatMap((values) =>
          pipe(
            decodePowerResult({
              schemaVersion: 'bayn.qualification-power.v1',
              method: decoded.power.method,
              oneSidedAlpha: decoded.power.oneSidedAlpha,
              targetPower: decoded.power.targetPower,
              minimumDetectableAnnualizedExcessReturn: decoded.power.minimumDetectableAnnualizedExcessReturn,
              assumedAnnualizedTrackingVolatility: decoded.power.assumedAnnualizedTrackingVolatility,
              standardizedEffect: values.standardizedEffect,
              requiredCompleteRebalanceBlocks: values.requiredCompleteRebalanceBlocks,
              requiredSessions: values.requiredSessions,
              availableCompleteRebalanceBlocks,
              availableCompleteSessions,
              sufficient:
                availableCompleteRebalanceBlocks >= values.requiredCompleteRebalanceBlocks &&
                availableCompleteSessions >= values.requiredSessions,
            }),
            Result.mapError(schemaFailure('power')),
          ),
        ),
      )
    }),
  )

const buildCompleteBlocks = (
  series: QualificationSeries,
): Result.Result<readonly BlockWork[], QualificationStatisticsFailure> =>
  Array.from({ length: Math.max(0, series.rebalanceExecutionDates.length - 1) }, (_, index) => index).reduce<
    Result.Result<readonly BlockWork[], QualificationStatisticsFailure>
  >(
    (accumulated, index) =>
      pipe(
        accumulated,
        Result.flatMap((blocks) => {
          const startSession = series.rebalanceExecutionDates.at(index)
          const nextRebalanceSession = series.rebalanceExecutionDates.at(index + 1)
          if (startSession === undefined || nextRebalanceSession === undefined) {
            return Result.succeed(blocks)
          }
          const observations = series.observations.filter(
            (observation) => observation.sessionDate >= startSession && observation.sessionDate < nextRebalanceSession,
          )
          if (observations.length === 0 || observations.at(0)?.sessionDate !== startSession) {
            return Result.succeed(blocks)
          }
          const lastObservation = observations.at(-1)
          if (lastObservation === undefined) return Result.succeed(blocks)
          const material = {
            schemaVersion: 'bayn.qualification-block.v1',
            ordinal: blocks.length,
            startSession,
            endSession: lastObservation.sessionDate,
            nextRebalanceSession,
            observations,
          }
          return pipe(
            canonicalHashResult('complete-block', material),
            Result.map((contentHash) => [
              ...blocks,
              {
                evidence: {
                  ordinal: material.ordinal,
                  startSession,
                  endSession: material.endSession,
                  nextRebalanceSession,
                  observationCount: observations.length,
                  contentHash,
                },
                observations,
              },
            ]),
          )
        }),
      ),
    Result.succeed([]),
  )

const strongerBenchmark = (
  observations: readonly QualificationObservation[],
  annualizationSessions: number,
): { readonly name: 'buy-and-hold' | 'direct-volatility-timing'; readonly sharpe: number } => {
  const buyAndHold = annualizedSharpe(
    observations.map((observation) => observation.buyAndHoldReturn - observation.cashReturn),
    annualizationSessions,
  )
  const directVolatility = annualizedSharpe(
    observations.map((observation) => observation.directVolatilityReturn - observation.cashReturn),
    annualizationSessions,
  )
  return directVolatility > buyAndHold
    ? { name: 'direct-volatility-timing', sharpe: directVolatility }
    : { name: 'buy-and-hold', sharpe: buyAndHold }
}

interface RandomState {
  readonly value: number
}

const initialRandomState = (seedHash: string): RandomState => ({
  value: Number.parseInt(seedHash.slice(0, 8), 16) || 0x9e3779b9,
})

const drawRandom = (state: RandomState): RandomState => {
  const shiftedLeft = state.value ^ (state.value << 13)
  const shiftedRight = shiftedLeft ^ (shiftedLeft >>> 17)
  return { value: (shiftedRight ^ (shiftedRight << 5)) >>> 0 }
}

const drawRandomIndex = (
  state: RandomState,
  maximum: number,
): Result.Result<{ readonly index: number; readonly state: RandomState }, QualificationStatisticsFailure> => {
  if (!Number.isInteger(maximum) || maximum <= 0) {
    return fail({ _tag: 'QualificationRandomIndexInvalid', maximum })
  }
  const limit = Math.floor(0x1_0000_0000 / maximum) * maximum
  const select = (current: RandomState): { readonly index: number; readonly state: RandomState } => {
    const next = drawRandom(current)
    return next.value >= limit ? select(next) : { index: next.value % maximum, state: next }
  }
  return Result.succeed(select(state))
}

interface BootstrapAccumulator {
  readonly random: RandomState
  readonly annualizedExcessReturnSamples: Chunk.Chunk<number>
  readonly sharpeDifferenceSamples: Chunk.Chunk<number>
}

const sampleBlocks = (
  random: RandomState,
  blocks: readonly BlockWork[],
): Result.Result<
  {
    readonly random: RandomState
    readonly observations: readonly QualificationObservation[]
  },
  QualificationStatisticsFailure
> =>
  Array.from({ length: blocks.length })
    .reduce<
      Result.Result<
        {
          readonly random: RandomState
          readonly selected: Chunk.Chunk<BlockWork>
        },
        QualificationStatisticsFailure
      >
    >(
      (accumulated) =>
        pipe(
          accumulated,
          Result.flatMap((state) =>
            pipe(
              drawRandomIndex(state.random, blocks.length),
              Result.flatMap(({ index, state: nextRandom }) => {
                const block = blocks.at(index)
                return block === undefined
                  ? fail({
                      _tag: 'QualificationSamplingBlockMissing',
                      index,
                      blockCount: blocks.length,
                    })
                  : Result.succeed({
                      random: nextRandom,
                      selected: Chunk.append(state.selected, block),
                    })
              }),
            ),
          ),
        ),
      Result.succeed({ random, selected: Chunk.empty() }),
    )
    .pipe(
      Result.map(({ random: nextRandom, selected }) => ({
        random: nextRandom,
        observations: Chunk.toReadonlyArray(selected).flatMap((block) => block.observations),
      })),
    )

const runBootstrap = (
  series: QualificationSeries,
  blocks: readonly BlockWork[],
  policy: QualificationStatisticsPolicy,
  priorTrialCount: number,
): Result.Result<typeof BootstrapAnalysisSchema.Type, QualificationStatisticsFailure> => {
  const benchmark = strongerBenchmark(series.observations, policy.annualizationSessions)
  const adjustedOneSidedAlpha = policy.confidence.familyOneSidedAlpha / (priorTrialCount + 1)
  const tailSampleCount = Math.floor(policy.bootstrap.samples * adjustedOneSidedAlpha)
  return pipe(
    canonicalHashResult('bootstrap-seed', {
      schemaVersion: 'bayn.qualification-bootstrap-seed.v1',
      namespace: policy.bootstrap.seedNamespace,
      runId: series.runId,
    }),
    Result.flatMap((seedHash) => {
      const sampled =
        blocks.length === 0
          ? Result.succeed<BootstrapAccumulator>({
              random: initialRandomState(seedHash),
              annualizedExcessReturnSamples: Chunk.empty(),
              sharpeDifferenceSamples: Chunk.empty(),
            })
          : Array.from({ length: policy.bootstrap.samples }).reduce<
              Result.Result<BootstrapAccumulator, QualificationStatisticsFailure>
            >(
              (accumulated) =>
                pipe(
                  accumulated,
                  Result.flatMap((state) =>
                    pipe(
                      sampleBlocks(state.random, blocks),
                      Result.flatMap(({ random, observations }) => {
                        const candidateReturns = observations.map(
                          (observation) => observation.strategyReturn - observation.cashReturn,
                        )
                        const benchmarkReturns = observations.map(
                          (observation) =>
                            (benchmark.name === 'buy-and-hold'
                              ? observation.buyAndHoldReturn
                              : observation.directVolatilityReturn) - observation.cashReturn,
                        )
                        return pipe(
                          Result.all({
                            annualizedExcessReturn: roundStatistic(
                              mean(candidateReturns) * policy.annualizationSessions,
                            ),
                            sharpeDifference: roundStatistic(
                              annualizedSharpe(candidateReturns, policy.annualizationSessions) -
                                annualizedSharpe(benchmarkReturns, policy.annualizationSessions),
                            ),
                          }),
                          Result.map(({ annualizedExcessReturn, sharpeDifference }) => ({
                            random,
                            annualizedExcessReturnSamples: Chunk.append(
                              state.annualizedExcessReturnSamples,
                              annualizedExcessReturn,
                            ),
                            sharpeDifferenceSamples: Chunk.append(state.sharpeDifferenceSamples, sharpeDifference),
                          })),
                        )
                      }),
                    ),
                  ),
                ),
              Result.succeed({
                random: initialRandomState(seedHash),
                annualizedExcessReturnSamples: Chunk.empty(),
                sharpeDifferenceSamples: Chunk.empty(),
              }),
            )
      return pipe(
        sampled,
        Result.flatMap((samples) => {
          const annualizedExcessReturnSamples = Chunk.toReadonlyArray(samples.annualizedExcessReturnSamples)
          const sharpeDifferenceSamples = Chunk.toReadonlyArray(samples.sharpeDifferenceSamples)
          return pipe(
            Result.all({
              selectedBenchmarkSharpe: roundStatistic(benchmark.sharpe),
              annualizedExcessReturnLowerBound: roundStatistic(
                nearestRankLowerQuantile(annualizedExcessReturnSamples, adjustedOneSidedAlpha),
              ),
              sharpeDifferenceLowerBound: roundStatistic(
                nearestRankLowerQuantile(sharpeDifferenceSamples, adjustedOneSidedAlpha),
              ),
              samplesHash: canonicalHashResult('bootstrap-samples', {
                schemaVersion: 'bayn.qualification-bootstrap-samples.v1',
                annualizedExcessReturnSamples,
                sharpeDifferenceSamples,
              }),
            }),
            Result.map((values) => ({
              schemaVersion: 'bayn.paired-block-bootstrap.v1' as const,
              method: policy.bootstrap.method,
              selectedBenchmark: benchmark.name,
              selectedBenchmarkSharpe: values.selectedBenchmarkSharpe,
              seedHash,
              requestedSamples: policy.bootstrap.samples,
              producedSamples: annualizedExcessReturnSamples.length,
              adjustedOneSidedAlpha,
              tailSampleCount,
              minimumTailSamples: policy.confidence.minimumTailSamples,
              tailResolutionSufficient: tailSampleCount >= policy.confidence.minimumTailSamples,
              annualizedExcessReturnLowerBound: values.annualizedExcessReturnLowerBound,
              sharpeDifferenceLowerBound: values.sharpeDifferenceLowerBound,
              annualizedExcessReturnSamples,
              sharpeDifferenceSamples,
              samplesHash: values.samplesHash,
            })),
          )
        }),
      )
    }),
  )
}

export const analyzeQualification = (
  input: QualificationSeries,
  policyInput: QualificationStatisticsPolicy,
  priorTrialRunIdsInput: readonly string[],
): Result.Result<QualificationAnalysis, QualificationStatisticsFailure> =>
  pipe(
    Result.all({
      series: pipe(decodeSeriesResult(input), Result.mapError(schemaFailure('series'))),
      policy: pipe(decodePolicyResult(policyInput), Result.mapError(schemaFailure('policy'))),
      priorTrialRunIds: pipe(
        decodePriorTrialRunIdsResult(priorTrialRunIdsInput),
        Result.mapError(schemaFailure('prior-trial-run-ids')),
      ),
    }),
    Result.flatMap(({ policy, priorTrialRunIds, series }) => {
      if (canonicalDates('priorTrialRunIds', priorTrialRunIds).length > 0) {
        return fail({ _tag: 'QualificationLineageInvalid', priorTrialRunIds })
      }
      return pipe(
        buildCompleteBlocks(series),
        Result.flatMap((blocks) => {
          const availableCompleteSessions = blocks.reduce((total, block) => total + block.evidence.observationCount, 0)
          return pipe(
            Result.all({
              power: calculateQualificationPower(policy, blocks.length, availableCompleteSessions),
              bootstrap: runBootstrap(series, blocks, policy, priorTrialRunIds.length),
              walkForward: calculateWalkForward(series, policy),
            }),
            Result.flatMap(({ bootstrap, power, walkForward }) => {
              const { gates, reasonCodes, status } = decideQualification({ policy, power, bootstrap, walkForward })
              const material = {
                schemaVersion: 'bayn.qualification-analysis.v1' as const,
                runId: series.runId,
                policy,
                priorTrialRunIds,
                candidateOrdinal: priorTrialRunIds.length + 1,
                completeBlocks: blocks.map((block) => block.evidence),
                power,
                bootstrap,
                walkForward,
                gates,
                status,
                reasonCodes,
              }
              return pipe(
                canonicalHashResult('analysis', material),
                Result.flatMap((analysisHash) =>
                  pipe(decodeAnalysisResult({ ...material, analysisHash }), Result.mapError(schemaFailure('analysis'))),
                ),
              )
            }),
          )
        }),
      )
    }),
  )
