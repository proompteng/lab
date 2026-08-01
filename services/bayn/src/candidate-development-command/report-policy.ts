import { pipe, Result } from 'effect'
import { type CandidateDevelopmentPreflightInput, type CandidateDevelopmentReport } from '../candidate-development'
import {
  deriveCandidateDevelopmentDecision,
  type CandidateDevelopmentDecision as CandidateDevelopmentCommandDecision,
} from '../candidate-development-decision'
import { type DailyPerformancePoint } from '../evidence-contracts'
import { canonicalHashV1Result } from '../hash'
import { buildVerdict } from '../simulation/metrics'
import { type EvaluationResult, type PerformanceMetrics } from '../types'
import type {
  CandidateDevelopmentCommandEvaluation,
  CandidateDevelopmentCommandFailure,
  CandidateDevelopmentCommandReport,
  CandidateDevelopmentCommandReportMaterial,
  CandidateDevelopmentStrategyProtocol,
  CandidateDevelopmentVerifiedSource,
} from './contracts'
import {
  recomputePerformanceMetrics,
  terminalCash,
  validatePerformanceMetrics,
  validateSeriesSessions,
} from './evaluation-metrics'
import {
  prepareCandidateDevelopmentMarketData,
  requireCanonicalEvidenceEqual,
  validateCandidateDevelopmentStrategyProtocol,
  validateCandidateDevelopmentVerifiedSource,
} from './market-data-binding'
import {
  rebuildCandidateDevelopmentBenchmarks,
  type CandidateDevelopmentAccountingValidation,
  type CandidateDevelopmentRebuiltBenchmarks,
  validateCandidateDevelopmentAccounting,
} from './accounting-replay'

export interface CandidateDevelopmentRecomputedMetrics {
  readonly strategy: PerformanceMetrics
  readonly buyAndHold: PerformanceMetrics
  readonly directVolTiming: PerformanceMetrics
  readonly doubleCostStrategy: PerformanceMetrics
}

export const projectDailyPerformanceSeries = (
  marks: EvaluationResult['simulation']['dailyMarks'],
): readonly DailyPerformancePoint[] =>
  marks.map(({ cashMicros: _cashMicros, positions: _positions, ...performance }) => performance)

export const recomputeCandidateDevelopmentMetrics = (
  report: CandidateDevelopmentReport,
  evaluation: CandidateDevelopmentCommandEvaluation,
  accounting: CandidateDevelopmentAccountingValidation,
  benchmarks: CandidateDevelopmentRebuiltBenchmarks,
): Result.Result<CandidateDevelopmentRecomputedMetrics, CandidateDevelopmentCommandFailure> => {
  const { baseline } = evaluation
  const strategyPoints = baseline.simulation.dailyMarks
  const stressedPoints = report.doubledCost.stressed.simulation.dailyMarks
  const stressedPerformance = projectDailyPerformanceSeries(stressedPoints)
  return pipe(
    Result.all({
      buyBinding: requireCanonicalEvidenceEqual(
        'benchmarks.buyAndHold',
        benchmarks.buyAndHold.series,
        baseline.benchmarkSeries.buyAndHold,
      ),
      directVolBinding: requireCanonicalEvidenceEqual(
        'benchmarks.directVolatilityTiming',
        benchmarks.directVolTiming.series,
        baseline.benchmarkSeries.directVolTiming,
      ),
      doubleCostBinding: requireCanonicalEvidenceEqual(
        'double-cost-series.replay',
        stressedPerformance,
        baseline.benchmarkSeries.doubleCostStrategy,
      ),
      buySessions: validateSeriesSessions(strategyPoints, benchmarks.buyAndHold.series, 'buy-and-hold'),
      volSessions: validateSeriesSessions(
        strategyPoints,
        benchmarks.directVolTiming.series,
        'direct-volatility-timing',
      ),
      doubleSessions: validateSeriesSessions(
        stressedPerformance,
        baseline.benchmarkSeries.doubleCostStrategy,
        'double-cost-series',
      ),
      stressedSessions: validateSeriesSessions(strategyPoints, stressedPoints, 'double-cost-stressed'),
      strategy: recomputePerformanceMetrics(
        'strategy',
        strategyPoints,
        baseline.initialCapitalMicros,
        accounting.strategyPerformanceBaseline,
      ),
      buyAndHold: recomputePerformanceMetrics(
        'buy-and-hold',
        benchmarks.buyAndHold.series,
        baseline.initialCapitalMicros,
        benchmarks.buyAndHold.performanceBaseline,
      ),
      directVolTiming: recomputePerformanceMetrics(
        'direct-volatility-timing',
        benchmarks.directVolTiming.series,
        baseline.initialCapitalMicros,
        benchmarks.directVolTiming.performanceBaseline,
      ),
      doubleCostSeries: recomputePerformanceMetrics(
        'double-cost-series',
        baseline.benchmarkSeries.doubleCostStrategy,
        baseline.initialCapitalMicros,
        accounting.stressedPerformanceBaseline,
      ),
      doubleCostStressed: recomputePerformanceMetrics(
        'double-cost-stressed',
        stressedPoints,
        baseline.initialCapitalMicros,
        accounting.stressedPerformanceBaseline,
      ),
    }),
    Result.flatMap(({ buyAndHold, directVolTiming, doubleCostSeries, doubleCostStressed, strategy }) =>
      pipe(
        Result.all({
          strategy: validatePerformanceMetrics('strategy', strategy, baseline.strategy),
          buyAndHold: validatePerformanceMetrics('buy-and-hold', buyAndHold, baseline.buyAndHold),
          directVolTiming: validatePerformanceMetrics(
            'direct-volatility-timing',
            directVolTiming,
            baseline.directVolTiming,
          ),
          doubleCostSeries: validatePerformanceMetrics(
            'double-cost-series',
            doubleCostSeries,
            baseline.doubleCostStrategy,
          ),
          doubleCostStressed: validatePerformanceMetrics(
            'double-cost-stressed',
            doubleCostStressed,
            baseline.doubleCostStrategy,
          ),
        }),
        Result.map(
          ({ buyAndHold: buy, directVolTiming: vol, doubleCostStressed: doubleCost, strategy: candidate }) => ({
            strategy: candidate,
            buyAndHold: buy,
            directVolTiming: vol,
            doubleCostStrategy: doubleCost,
          }),
        ),
      ),
    ),
  )
}

export const rebuildCandidateDevelopmentEconomicVerdict = (
  metrics: CandidateDevelopmentRecomputedMetrics,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
): EvaluationResult['verdict'] =>
  buildVerdict(
    metrics.strategy,
    metrics.buyAndHold,
    metrics.directVolTiming,
    metrics.doubleCostStrategy,
    strategyProtocol,
  )

export const economicGateEqual = (
  expected: EvaluationResult['verdict']['gates'][number],
  observed: EvaluationResult['verdict']['gates'][number],
): boolean =>
  expected.name === observed.name &&
  expected.passed === observed.passed &&
  Object.is(expected.actual, observed.actual) &&
  Object.is(expected.required, observed.required)

export const deriveCandidateDevelopmentEconomicPass = (
  baseline: EvaluationResult,
  metrics: CandidateDevelopmentRecomputedMetrics,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
): Result.Result<boolean, CandidateDevelopmentCommandFailure> => {
  const expectedVerdict = rebuildCandidateDevelopmentEconomicVerdict(metrics, strategyProtocol)
  const expectedGateNames = expectedVerdict.gates.map((gate) => gate.name)
  const observedGateNames = baseline.verdict.gates.map((gate) => gate.name)
  if (
    observedGateNames.length !== expectedGateNames.length ||
    expectedGateNames.some((expected, index) => observedGateNames[index] !== expected)
  ) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandEconomicGateSetInvalid',
      expectedGateNames,
      observedGateNames,
    })
  }
  for (let index = 0; index < expectedVerdict.gates.length; index += 1) {
    const expected = expectedVerdict.gates[index]
    const observed = baseline.verdict.gates[index]
    if (expected === undefined || observed === undefined || !economicGateEqual(expected, observed)) {
      if (expected !== undefined && observed !== undefined) {
        return Result.fail({
          _tag: 'CandidateDevelopmentCommandEconomicGateInvalid',
          index,
          expected,
          observed,
        })
      }
      return Result.fail({
        _tag: 'CandidateDevelopmentCommandEconomicGateSetInvalid',
        expectedGateNames,
        observedGateNames,
      })
    }
  }
  const economicPass = expectedVerdict.gates.every((gate) => gate.passed)
  const failedGateNames = expectedVerdict.gates.filter((gate) => !gate.passed).map((gate) => gate.name)
  const expectedStatus = economicPass ? 'PASS' : 'FAIL_CLOSED'
  return baseline.verdict.status === expectedStatus
    ? Result.succeed(economicPass)
    : Result.fail({
        _tag: 'CandidateDevelopmentCommandEconomicVerdictInvalid',
        expectedStatus,
        observedStatus: baseline.verdict.status,
        failedGateNames,
      })
}

export const decideCandidateDevelopment = (
  report: CandidateDevelopmentReport,
  baseline: EvaluationResult,
  doubledCostAnnualizedReturn: number,
  economicPass: boolean,
): CandidateDevelopmentCommandDecision =>
  deriveCandidateDevelopmentDecision({
    comparison: report.comparisonSemantics.analysis,
    doubledCostAnnualizedReturn,
    economicPass,
    baselineTerminalCash: terminalCash(baseline.simulation.dailyMarks),
    stressedTerminalCash: terminalCash(report.doubledCost.stressed.simulation.dailyMarks),
  })

export const buildCandidateDevelopmentCommandReport = (
  report: CandidateDevelopmentReport,
  evaluation: CandidateDevelopmentCommandEvaluation,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
  officialSessions: CandidateDevelopmentPreflightInput['officialSessions'],
  verifiedSource: CandidateDevelopmentVerifiedSource,
): Result.Result<CandidateDevelopmentCommandReport, CandidateDevelopmentCommandFailure> =>
  pipe(
    Result.all({
      protocol: validateCandidateDevelopmentStrategyProtocol(report, evaluation, strategyProtocol),
      source: validateCandidateDevelopmentVerifiedSource(evaluation, verifiedSource),
    }),
    Result.flatMap(() =>
      prepareCandidateDevelopmentMarketData(evaluation, strategyProtocol, officialSessions, verifiedSource),
    ),
    Result.flatMap((marketData) =>
      pipe(
        Result.all({
          accounting: validateCandidateDevelopmentAccounting(
            report,
            evaluation,
            strategyProtocol,
            officialSessions,
            marketData,
          ),
          benchmarks: rebuildCandidateDevelopmentBenchmarks(evaluation, marketData, strategyProtocol),
        }),
        Result.flatMap(({ accounting, benchmarks }) =>
          recomputeCandidateDevelopmentMetrics(report, evaluation, accounting, benchmarks),
        ),
      ),
    ),
    Result.flatMap((metrics) =>
      pipe(
        Result.all({
          economicPass: deriveCandidateDevelopmentEconomicPass(evaluation.baseline, metrics, strategyProtocol),
        }),
        Result.map(({ economicPass }) => ({
          doubledCostAnnualizedReturn: metrics.doubleCostStrategy.annualizedReturn,
          economicPass,
        })),
      ),
    ),
    Result.flatMap(({ doubledCostAnnualizedReturn, economicPass }) => {
      const material: CandidateDevelopmentCommandReportMaterial = {
        schemaVersion: 'bayn.candidate-development-command-report.v6',
        candidateOrdinal: report.protocolIdentity.candidateOrdinal,
        priorTrialCount: report.protocolIdentity.priorTrialCount,
        strategyProtocolHash: report.comparisonSemantics.strategyProtocolHash,
        strategyProtocol,
        officialSessions,
        marketData: evaluation.marketData,
        verifiedSource,
        decision: decideCandidateDevelopment(report, evaluation.baseline, doubledCostAnnualizedReturn, economicPass),
        baseline: evaluation.baseline,
        accounting: evaluation.accounting,
        development: report,
      }
      return pipe(
        canonicalHashV1Result(material),
        Result.mapError(
          (cause): CandidateDevelopmentCommandFailure => ({
            _tag: 'CandidateDevelopmentCommandHashFailed',
            cause,
          }),
        ),
        Result.map((contentHash) => ({ ...material, contentHash })),
      )
    }),
  )
