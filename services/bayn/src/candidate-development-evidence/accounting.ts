import { Result } from 'effect'

import {
  candidateDevelopmentComparisonSemantics,
  preflightCandidateDevelopment,
  validateCandidateDevelopmentComparisonSemanticsEvidence,
  validateCandidateDevelopmentComparisonSeriesBinding,
  validateCandidateDevelopmentDoubledCostCausalPath,
  type CandidateDevelopmentDoubledCostRun,
  type CandidateDevelopmentPreflightPass,
  type CandidateDevelopmentReport,
} from '../candidate-development'
import {
  validateCandidateDevelopmentCommandEvaluation,
  type CandidateDevelopmentCommandEvaluation,
} from '../candidate-development-command'
import { deriveCandidateDevelopmentDecision } from '../candidate-development-decision'
import { canonicalHashV1Result } from '../hash'
import { prepareQualificationSeries } from '../qualification-statistics'
import { buildVerdict, calculateExactPerformanceMetrics } from '../simulation/metrics'
import type { DailyPerformancePoint, EvaluationResult, PerformanceMetrics } from '../types'
import { collectCanonicalBinding, collectCanonicalBindings, sameCanonical } from './bindings'
import type {
  CandidateDevelopmentEvidenceIssue,
  CandidateDevelopmentImmutableEvidence,
  CandidateDevelopmentValidatedEvidence,
} from './model'

export interface CandidateDevelopmentCompleteEvidenceValidation {
  readonly value: CandidateDevelopmentValidatedEvidence | null
  readonly issues: readonly CandidateDevelopmentEvidenceIssue[]
}

const fullMetricFields = [
  'observations',
  'totalReturn',
  'annualizedReturn',
  'annualizedVolatility',
  'sharpe',
  'maximumDrawdown',
  'annualTurnover',
  'totalFeesMicros',
  'totalSpreadCostMicros',
  'totalSlippageCostMicros',
  'totalCashYieldMicros',
  'endingEquityMicros',
] as const satisfies readonly (keyof PerformanceMetrics)[]

type ExactPerformancePoint = Pick<
  DailyPerformancePoint,
  | 'equityMicros'
  | 'cumulativeTurnoverMicros'
  | 'cumulativeFeesMicros'
  | 'cumulativeSpreadCostMicros'
  | 'cumulativeSlippageCostMicros'
  | 'cumulativeCashYieldMicros'
>

const exactMetricsFromPoints = (
  field: string,
  points: readonly ExactPerformancePoint[],
  initialCapitalMicros: string,
): Result.Result<PerformanceMetrics, CandidateDevelopmentEvidenceIssue> => {
  const last = points.at(-1)
  const values = [
    initialCapitalMicros,
    ...(last === undefined
      ? []
      : [
          last.cumulativeTurnoverMicros,
          last.cumulativeFeesMicros,
          last.cumulativeSpreadCostMicros,
          last.cumulativeSlippageCostMicros,
          last.cumulativeCashYieldMicros,
        ]),
    ...points.map((point) => point.equityMicros),
  ]
  const invalid = values.find((value) => !/^\d+$/.test(value))
  if (last === undefined || invalid !== undefined) {
    return Result.fail({
      _tag: 'CandidateDevelopmentEvidenceEconomicInvalid',
      field,
      expected: 'nonempty performance series with unsigned integer micros',
      observed: invalid ?? null,
    })
  }
  return Result.mapError(
    calculateExactPerformanceMetrics(
      points.map((point) => BigInt(point.equityMicros)),
      BigInt(last.cumulativeTurnoverMicros),
      BigInt(last.cumulativeFeesMicros),
      BigInt(last.cumulativeSpreadCostMicros),
      BigInt(last.cumulativeSlippageCostMicros),
      BigInt(last.cumulativeCashYieldMicros),
      BigInt(initialCapitalMicros),
    ),
    (cause): CandidateDevelopmentEvidenceIssue => ({
      _tag: 'CandidateDevelopmentEvidenceEconomicInvalid',
      field,
      expected: 'metrics reproducible from the bound equity and cumulative accounting series',
      observed: null,
      cause,
    }),
  )
}

const collectMetricBinding = (
  issues: CandidateDevelopmentEvidenceIssue[],
  field: string,
  expected: PerformanceMetrics,
  observed: PerformanceMetrics,
): void => {
  const expectedProjection = Object.fromEntries(fullMetricFields.map((key) => [key, expected[key]]))
  const observedProjection = Object.fromEntries(fullMetricFields.map((key) => [key, observed[key]]))
  const equal = sameCanonical(expectedProjection, observedProjection)
  if (Result.isFailure(equal)) {
    issues.push({ _tag: 'CandidateDevelopmentEvidenceHashFailed', cause: equal.failure })
    return
  }
  if (!equal.success) {
    issues.push({
      _tag: 'CandidateDevelopmentEvidenceEconomicInvalid',
      field,
      expected: expectedProjection,
      observed: observedProjection,
    })
  }
}

const terminalCash = (simulation: EvaluationResult['simulation']): boolean =>
  simulation.dailyMarks.at(-1)?.positions.every((position) => position.quantityMicros === '0') ?? false

const buildDevelopmentReport = (
  preflight: CandidateDevelopmentPreflightPass,
  evaluation: CandidateDevelopmentCommandEvaluation,
): CandidateDevelopmentReport => ({
  schemaVersion: candidateDevelopmentComparisonSemantics.evidence.reportSchemaVersion,
  protocolIdentity: preflight.protocolIdentity,
  comparisonSemantics: evaluation.comparisonSemantics,
  doubledCostContract: preflight.doubledCostContract,
  doubledCost: {
    baseline: {
      signalDecisions: evaluation.baseline.signalDecisions,
      simulation: evaluation.baseline.simulation,
    },
    stressed: evaluation.stressed,
  },
})

const invalidCompleteEvidence = (
  issues: readonly CandidateDevelopmentEvidenceIssue[],
): CandidateDevelopmentCompleteEvidenceValidation => ({
  value: null,
  issues,
})

export const validateCandidateDevelopmentCompleteEvidence = (
  evidence: CandidateDevelopmentImmutableEvidence,
): CandidateDevelopmentCompleteEvidenceValidation => {
  const issues: CandidateDevelopmentEvidenceIssue[] = []

  const strategyProtocolHash = canonicalHashV1Result(evidence.strategyProtocol)
  if (Result.isFailure(strategyProtocolHash)) {
    issues.push({ _tag: 'CandidateDevelopmentEvidenceHashFailed', cause: strategyProtocolHash.failure })
  } else if (strategyProtocolHash.success !== evidence.bindings.strategyProtocolHash) {
    issues.push({
      _tag: 'CandidateDevelopmentEvidenceBindingMismatch',
      field: 'strategyProtocol',
      expected: evidence.bindings.strategyProtocolHash,
      observed: strategyProtocolHash.success,
    })
  }

  const preflightResult = preflightCandidateDevelopment(evidence.input)
  if (Result.isFailure(preflightResult) || preflightResult.success.status !== 'PASS') {
    issues.push({
      _tag: 'CandidateDevelopmentEvidencePreflightInvalid',
      cause: Result.isFailure(preflightResult) ? preflightResult.failure : preflightResult.success,
    })
    return invalidCompleteEvidence(issues)
  }
  const preflight = preflightResult.success
  collectCanonicalBindings(issues, [
    [
      'preflight.candidateDevelopmentProtocolHash',
      evidence.bindings.candidateDevelopmentProtocolHash,
      preflight.protocolIdentity.candidateDevelopmentProtocolHash,
    ],
    ['preflight.strategyProtocolHash', evidence.bindings.strategyProtocolHash, preflight.expectedStrategyProtocolHash],
  ])

  const evaluationResult = validateCandidateDevelopmentCommandEvaluation(evidence.evaluation)
  if (Result.isFailure(evaluationResult)) {
    issues.push({ _tag: 'CandidateDevelopmentEvidenceEvaluationInvalid', cause: evaluationResult.failure })
    return invalidCompleteEvidence(issues)
  }
  const evaluation = evaluationResult.success
  collectCanonicalBindings(issues, [
    ['evaluation.baseline.codeRevision', evidence.verifiedSource.sourceRevision, evaluation.baseline.codeRevision],
    ['evaluation.baseline.runId', evidence.verifiedSource.baselineRunId, evaluation.baseline.runId],
    ['evaluation.accounting.runId', evidence.verifiedSource.baselineRunId, evaluation.accounting.runId],
    ['evaluation.accounting.stressedRunId', evidence.verifiedSource.stressedRunId, evaluation.accounting.stressedRunId],
    ['evaluation.baseline.protocolHash', evidence.bindings.strategyProtocolHash, evaluation.baseline.protocolHash],
    ['evaluation.marketData.snapshotId', evidence.bindings.marketData.snapshotId, evaluation.marketData.snapshotId],
    [
      'evaluation.marketData.contentHash',
      evidence.bindings.marketData.boundedContentHash,
      evaluation.marketData.contentHash,
    ],
    [
      'evaluation.baseline.inputManifest.hash',
      evidence.bindings.marketData.inputManifestHash,
      evaluation.baseline.inputManifest.hash,
    ],
    [
      'evaluation.baseline.inputManifest.finalizedSnapshot.contentHash',
      evidence.bindings.marketData.finalizedSnapshotContentHash,
      evaluation.baseline.inputManifest.finalizedSnapshot.contentHash,
    ],
  ])

  const series = prepareQualificationSeries(evaluation.baseline)
  if (Result.isFailure(series)) {
    issues.push({ _tag: 'CandidateDevelopmentEvidenceComparisonInvalid', cause: series.failure })
    return invalidCompleteEvidence(issues)
  }
  const seriesBinding = validateCandidateDevelopmentComparisonSeriesBinding(
    preflight,
    evaluation.baseline,
    series.success,
  )
  if (Result.isFailure(seriesBinding)) {
    issues.push({ _tag: 'CandidateDevelopmentEvidenceComparisonInvalid', cause: seriesBinding.failure })
    return invalidCompleteEvidence(issues)
  }
  const comparison = validateCandidateDevelopmentComparisonSemanticsEvidence(
    preflight,
    seriesBinding.success,
    evaluation.comparisonSemantics,
  )
  if (Result.isFailure(comparison)) {
    issues.push({ _tag: 'CandidateDevelopmentEvidenceComparisonInvalid', cause: comparison.failure })
    return invalidCompleteEvidence(issues)
  }

  const initialCapitalMicros = evaluation.baseline.initialCapitalMicros
  const metrics = Result.all({
    strategy: exactMetricsFromPoints(
      'economic.strategy',
      evaluation.baseline.simulation.dailyMarks,
      initialCapitalMicros,
    ),
    buyAndHold: exactMetricsFromPoints(
      'economic.buyAndHold',
      evaluation.baseline.benchmarkSeries.buyAndHold,
      initialCapitalMicros,
    ),
    directVolTiming: exactMetricsFromPoints(
      'economic.directVolTiming',
      evaluation.baseline.benchmarkSeries.directVolTiming,
      initialCapitalMicros,
    ),
    doubleCostStrategy: exactMetricsFromPoints(
      'economic.doubleCostStrategy',
      evaluation.stressed.simulation.dailyMarks,
      initialCapitalMicros,
    ),
    recordedDoubleCostSeries: exactMetricsFromPoints(
      'economic.recordedDoubleCostSeries',
      evaluation.baseline.benchmarkSeries.doubleCostStrategy,
      initialCapitalMicros,
    ),
  })
  if (Result.isFailure(metrics)) {
    issues.push(metrics.failure)
    return invalidCompleteEvidence(issues)
  }
  collectMetricBinding(issues, 'economic.strategy', metrics.success.strategy, evaluation.baseline.strategy)
  collectMetricBinding(issues, 'economic.buyAndHold', metrics.success.buyAndHold, evaluation.baseline.buyAndHold)
  collectMetricBinding(
    issues,
    'economic.directVolTiming',
    metrics.success.directVolTiming,
    evaluation.baseline.directVolTiming,
  )
  collectMetricBinding(
    issues,
    'economic.doubleCostStrategy',
    metrics.success.doubleCostStrategy,
    evaluation.baseline.doubleCostStrategy,
  )
  collectMetricBinding(
    issues,
    'economic.doubleCostSeries',
    metrics.success.doubleCostStrategy,
    metrics.success.recordedDoubleCostSeries,
  )

  const expectedVerdict = buildVerdict(
    metrics.success.strategy,
    metrics.success.buyAndHold,
    metrics.success.directVolTiming,
    metrics.success.doubleCostStrategy,
    evidence.strategyProtocol,
  )
  collectCanonicalBinding(issues, 'economic.verdict', expectedVerdict, evaluation.baseline.verdict)

  const baselineRun: CandidateDevelopmentDoubledCostRun = {
    signalDecisions: evaluation.baseline.signalDecisions,
    simulation: evaluation.baseline.simulation,
  }
  const causalPath = validateCandidateDevelopmentDoubledCostCausalPath(baselineRun, evaluation.stressed)
  if (Result.isFailure(causalPath)) {
    issues.push({ _tag: 'CandidateDevelopmentEvidenceDoubledCostInvalid', cause: causalPath.failure })
  }

  const decision = deriveCandidateDevelopmentDecision({
    comparison: comparison.success.analysis,
    doubledCostAnnualizedReturn: metrics.success.doubleCostStrategy.annualizedReturn,
    economicPass: expectedVerdict.gates.every((gate) => gate.passed),
    baselineTerminalCash: terminalCash(evaluation.baseline.simulation),
    stressedTerminalCash: terminalCash(evaluation.stressed.simulation),
  })

  const reviewedMetrics: readonly (readonly [string, number, number])[] = [
    [
      'reviewedTerminalSummary.strategyAnnualizedReturn',
      Number(metrics.success.strategy.annualizedReturn.toFixed(5)),
      evidence.reviewedTerminalSummary.strategyAnnualizedReturn,
    ],
    [
      'reviewedTerminalSummary.buyAndHoldAnnualizedReturn',
      Number(metrics.success.buyAndHold.annualizedReturn.toFixed(6)),
      evidence.reviewedTerminalSummary.buyAndHoldAnnualizedReturn,
    ],
  ]
  for (const [field, expected, observed] of reviewedMetrics) {
    if (!Object.is(expected, observed)) {
      issues.push({ _tag: 'CandidateDevelopmentEvidenceEconomicInvalid', field, expected, observed })
    }
  }
  const reviewedStatistics: readonly (readonly [string, number])[] = [
    [
      'reviewedTerminalSummary.annualizedReturnDifferenceLowerBound',
      evidence.reviewedTerminalSummary.annualizedReturnDifferenceLowerBound,
    ],
    ['reviewedTerminalSummary.sharpeDifferenceLowerBound', evidence.reviewedTerminalSummary.sharpeDifferenceLowerBound],
  ]
  for (const [field, value] of reviewedStatistics) {
    if (!Number.isFinite(value)) {
      issues.push({
        _tag: 'CandidateDevelopmentEvidenceEconomicInvalid',
        field,
        expected: 'finite reviewed development statistic',
        observed: value,
      })
    }
  }

  return {
    value: {
      preflight,
      evaluation,
      decision,
      development: buildDevelopmentReport(preflight, evaluation),
    },
    issues,
  }
}
