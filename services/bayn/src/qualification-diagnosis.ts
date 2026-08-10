import { canonicalHashV1 } from './hash'
import type { QualificationResult } from './qualification'
import type { EvaluationSummary, PerformanceMetrics } from './types'
import { Pipeable } from './pipeable'

const round = (value: number): number => Number.parseFloat(value.toFixed(12))

const nearestRank = (sorted: readonly number[], probability: number): number => {
  if (sorted.length === 0) return 0
  const rank = Math.max(1, Math.ceil(probability * sorted.length))
  return sorted.at(rank - 1) ?? 0
}

const distribution = (values: readonly number[], lowerBound: number) => {
  const sorted = [...values].sort((left, right) => left - right)
  const mean = values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length
  const positive = values.filter((value) => value > 0).length
  return {
    method: 'nearest-rank' as const,
    sampleCount: values.length,
    minimum: sorted.at(0) ?? 0,
    lowerBound,
    p05: nearestRank(sorted, 0.05),
    median: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    maximum: sorted.at(-1) ?? 0,
    mean: round(mean),
    positiveFraction: round(values.length === 0 ? 0 : positive / values.length),
  }
}

const totalTransactionCostMicros = (metrics: PerformanceMetrics): string =>
  (
    BigInt(metrics.totalFeesMicros) +
    BigInt(metrics.totalSpreadCostMicros) +
    BigInt(metrics.totalSlippageCostMicros)
  ).toString()

const metricFacts = (metrics: PerformanceMetrics) => ({
  observations: metrics.observations,
  annualizedReturn: metrics.annualizedReturn,
  annualizedVolatility: metrics.annualizedVolatility,
  sharpe: metrics.sharpe,
  maximumDrawdown: metrics.maximumDrawdown,
  annualTurnover: metrics.annualTurnover,
  totalTransactionCostMicros: totalTransactionCostMicros(metrics),
  totalCashYieldMicros: metrics.totalCashYieldMicros,
})

const makeQualificationDiagnosisDataFirst = (evaluation: EvaluationSummary, result: QualificationResult) => {
  const bootstrap = result.analysis.bootstrap
  const benchmarkMetrics =
    bootstrap.selectedBenchmark === 'buy-and-hold' ? evaluation.buyAndHold : evaluation.directVolTiming
  const material = {
    schemaVersion: 'bayn.qualification-diagnosis.v1' as const,
    runId: result.runId,
    candidateOrdinal: result.analysis.candidateOrdinal,
    verdict: result.verdict,
    reasonCodes: result.reasonCodes,
    candidate: metricFacts(evaluation.strategy),
    benchmark: {
      name: bootstrap.selectedBenchmark,
      ...metricFacts(benchmarkMetrics),
      qualificationSharpe: bootstrap.selectedBenchmarkSharpe,
    },
    economicPointSharpeDifference: round(evaluation.strategy.sharpe - benchmarkMetrics.sharpe),
    bootstrap: {
      adjustedOneSidedAlpha: bootstrap.adjustedOneSidedAlpha,
      tailSampleCount: bootstrap.tailSampleCount,
      minimumTailSamples: bootstrap.minimumTailSamples,
      tailResolutionSufficient: bootstrap.tailResolutionSufficient,
      sharpeDifference: distribution(bootstrap.sharpeDifferenceSamples, bootstrap.sharpeDifferenceLowerBound),
      annualizedExcessReturn: distribution(
        bootstrap.annualizedExcessReturnSamples,
        bootstrap.annualizedExcessReturnLowerBound,
      ),
    },
    power: {
      sufficient: result.analysis.power.sufficient,
      availableCompleteRebalanceBlocks: result.analysis.power.availableCompleteRebalanceBlocks,
      requiredCompleteRebalanceBlocks: result.analysis.power.requiredCompleteRebalanceBlocks,
      availableCompleteSessions: result.analysis.power.availableCompleteSessions,
      requiredSessions: result.analysis.power.requiredSessions,
    },
    walkForward: {
      sufficient: result.analysis.walkForward.sufficient,
      folds: result.analysis.walkForward.folds.length,
      requiredFolds: result.analysis.walkForward.requiredFolds,
      positiveFoldFraction: result.analysis.walkForward.positiveFoldFraction,
      requiredPositiveFoldFraction: result.analysis.walkForward.requiredPositiveFoldFraction,
      maximumFoldDrawdown: result.analysis.walkForward.maximumFoldDrawdown,
      maximumAllowedFoldDrawdown: result.analysis.policy.walkForward.maximumFoldDrawdown,
    },
  }
  return { ...material, diagnosisHash: canonicalHashV1(material) }
}

export const makeQualificationDiagnosis = Pipeable.dual(2, makeQualificationDiagnosisDataFirst)

export type QualificationDiagnosis = ReturnType<typeof makeQualificationDiagnosis>
