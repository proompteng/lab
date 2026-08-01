import { Result } from 'effect'
import {
  buildCandidateDevelopmentComparisonSemanticsEvidence,
  preflightCandidateDevelopment,
  validateCandidateDevelopmentComparisonSeriesBinding,
} from '../candidate-development'
import { MICROS } from '../execution-model'
import { prepareQualificationSeries } from '../qualification-statistics'
import { buildVerdict } from '../simulation/metrics'
import { alignBars, directVolatilityWeights, simulate, type SimulationTarget } from '../simulation'
import { reconcileMarkedEquity } from '../simulation-reconciliation'
import { type EvaluationResult, type SimulationProtocol } from '../types'
import type {
  CandidateDevelopmentArtifactRuntimeInput,
  CandidateDevelopmentCommandEvaluation,
  CandidateDevelopmentCommandFailure,
  CandidateDevelopmentStrategyProtocol,
} from './contracts'
import {
  canonicalEvidenceHash,
  performanceBaselineFromPoint,
  recomputePerformanceMetrics,
  selectRebuiltBenchmarkSeries,
} from './evaluation'
import { candidateDevelopmentPlanFailure } from './plan-math'
import {
  selectedCandidateDevelopmentPerformance,
  selectedCandidateDevelopmentTrace,
  validateCandidateDevelopmentPlanInputManifest,
  validateCandidateDevelopmentStrategyPlan,
} from './plan-validation'

export const buildCandidateDevelopmentPlanEvaluation = (
  planValue: unknown,
  inputManifestValue: unknown,
  runtimeInput: CandidateDevelopmentArtifactRuntimeInput,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
): Result.Result<CandidateDevelopmentCommandEvaluation, CandidateDevelopmentCommandFailure> => {
  const preflight = preflightCandidateDevelopment(runtimeInput.preflightInput)
  if (Result.isFailure(preflight) || preflight.success.status !== 'PASS') {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.plan.preflight', {
        expected: 'PASS',
        observed: Result.isFailure(preflight) ? preflight.failure : preflight.success,
      }),
    )
  }
  const manifest = validateCandidateDevelopmentPlanInputManifest(
    inputManifestValue,
    runtimeInput,
    strategyProtocol,
    preflight.success,
  )
  if (Result.isFailure(manifest)) return Result.fail(manifest.failure)
  const aligned = alignBars(runtimeInput.marketData.bars, strategyProtocol.universe, manifest.success)
  if (Result.isFailure(aligned)) {
    return Result.fail(candidateDevelopmentPlanFailure('artifact.plan.marketData', aligned.failure))
  }
  const plan = validateCandidateDevelopmentStrategyPlan(
    planValue,
    preflight.success,
    strategyProtocol,
    runtimeInput.preflightInput.officialSessions,
    runtimeInput.preflightInput.signalSessionDates,
    aligned.success,
  )
  if (Result.isFailure(plan)) return Result.fail(plan.failure)
  const sessions = aligned.success
  const sessionIndexByDate = new Map(sessions.map((session, index) => [session.date, index] as const))
  const selectedStartIndex = sessionIndexByDate.get(preflight.success.selectedObservationStart)
  const selectedEndIndex = sessionIndexByDate.get(preflight.success.selectedObservationEnd)
  if (
    selectedStartIndex === undefined ||
    selectedStartIndex < 1 ||
    selectedEndIndex === undefined ||
    selectedEndIndex < selectedStartIndex
  ) {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.plan.evaluationWindow', {
        selectedStart: preflight.success.selectedObservationStart,
        selectedEnd: preflight.success.selectedObservationEnd,
      }),
    )
  }
  const targets: SimulationTarget[] = []
  for (let index = 0; index < plan.success.decisions.length; index += 1) {
    const planned = plan.success.decisions[index]
    const signalIndex = sessionIndexByDate.get(planned.signalDate)
    const executionIndex = sessionIndexByDate.get(planned.executionDate)
    if (signalIndex === undefined || executionIndex === undefined || executionIndex !== signalIndex + 1) {
      return Result.fail(
        candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].indices`, {
          expected: 'adjacent governed sessions',
          observed: { signalIndex, executionIndex },
        }),
      )
    }
    const { executionDate: _, ...decision } = planned
    targets.push({ signalIndex, executionIndex, weights: planned.targetWeights, decision })
  }
  const accountingStartIndex = selectedStartIndex - 1
  const evaluationSessions = sessions.slice(0, selectedEndIndex + 1)
  const baselineSimulation = simulate(
    evaluationSessions,
    targets,
    accountingStartIndex,
    strategyProtocol,
    MICROS,
    runtimeInput.baselineRunId,
    true,
  )
  if (Result.isFailure(baselineSimulation) || baselineSimulation.success.simulation === null) {
    return Result.fail(
      candidateDevelopmentPlanFailure(
        'artifact.plan.baselineSimulation',
        Result.isFailure(baselineSimulation) ? baselineSimulation.failure : 'missing trace',
      ),
    )
  }
  const stressedSimulation = simulate(
    evaluationSessions,
    targets,
    accountingStartIndex,
    strategyProtocol,
    MICROS * 2n,
    runtimeInput.stressedRunId,
    true,
  )
  if (Result.isFailure(stressedSimulation) || stressedSimulation.success.simulation === null) {
    return Result.fail(
      candidateDevelopmentPlanFailure(
        'artifact.plan.stressedSimulation',
        Result.isFailure(stressedSimulation) ? stressedSimulation.failure : 'missing trace',
      ),
    )
  }
  const selectedSessions = preflight.success.selectedObservationSessions
  const baselineTrace = selectedCandidateDevelopmentTrace(baselineSimulation.success.simulation, selectedSessions)
  const stressedTrace = selectedCandidateDevelopmentTrace(stressedSimulation.success.simulation, selectedSessions)
  const strategySeries = selectedCandidateDevelopmentPerformance(
    baselineSimulation.success.dailyPerformance,
    selectedSessions,
    'artifact.plan.strategySeries',
  )
  const stressedSeries = selectedCandidateDevelopmentPerformance(
    stressedSimulation.success.dailyPerformance,
    selectedSessions,
    'artifact.plan.stressedSeries',
  )
  if (Result.isFailure(baselineTrace)) return Result.fail(baselineTrace.failure)
  if (Result.isFailure(stressedTrace)) return Result.fail(stressedTrace.failure)
  if (Result.isFailure(strategySeries)) return Result.fail(strategySeries.failure)
  if (Result.isFailure(stressedSeries)) return Result.fail(stressedSeries.failure)
  const initialCapitalMicros = strategyProtocol.initialCapitalMicros
  const baselinePredecessor = baselineSimulation.success.simulation.dailyMarks[0]
  const stressedPredecessor = stressedSimulation.success.simulation.dailyMarks[0]
  if (baselinePredecessor === undefined || stressedPredecessor === undefined) {
    return Result.fail(candidateDevelopmentPlanFailure('artifact.plan.accountingPredecessor', 'missing'))
  }
  const strategyMetrics = recomputePerformanceMetrics(
    'strategy',
    strategySeries.success,
    initialCapitalMicros,
    performanceBaselineFromPoint(baselinePredecessor),
  )
  const stressedMetrics = recomputePerformanceMetrics(
    'double-cost-stressed',
    stressedSeries.success,
    initialCapitalMicros,
    performanceBaselineFromPoint(stressedPredecessor),
  )
  if (Result.isFailure(strategyMetrics)) return Result.fail(strategyMetrics.failure)
  if (Result.isFailure(stressedMetrics)) return Result.fail(stressedMetrics.failure)
  const terminalTarget = targets.at(-1)
  if (terminalTarget === undefined) {
    return Result.fail(candidateDevelopmentPlanFailure('artifact.plan.terminalTarget', 'missing'))
  }
  const benchmarkSymbol = strategyProtocol.benchmarks.symbol
  const benchmarkProtocol: SimulationProtocol = { ...strategyProtocol, universe: [benchmarkSymbol] }
  const directTargets: SimulationTarget[] = []
  for (let index = 0; index < targets.length - 1; index += 1) {
    const target = targets[index]
    const weights = directVolatilityWeights(sessions, target.signalIndex, benchmarkProtocol)
    if (Result.isFailure(weights)) {
      return Result.fail(candidateDevelopmentPlanFailure(`artifact.plan.directVolatility[${index}]`, weights.failure))
    }
    directTargets.push({
      signalIndex: target.signalIndex,
      executionIndex: target.executionIndex,
      weights: weights.success,
    })
  }
  const benchmarkRunId = canonicalEvidenceHash('benchmarks.runId', {
    schemaVersion: 'bayn.candidate-development-benchmark-run.v1',
    candidateRunId: runtimeInput.baselineRunId,
    marketDataContentHash: runtimeInput.marketData.contentHash,
    policy: strategyProtocol.benchmarks,
  })
  if (Result.isFailure(benchmarkRunId)) return Result.fail(benchmarkRunId.failure)
  const buyAndHoldSimulation = simulate(
    evaluationSessions,
    [
      {
        signalIndex: accountingStartIndex,
        executionIndex: selectedStartIndex,
        weights: { [benchmarkSymbol]: 1 },
      },
      {
        signalIndex: terminalTarget.signalIndex,
        executionIndex: terminalTarget.executionIndex,
        weights: { [benchmarkSymbol]: 0 },
      },
    ],
    accountingStartIndex,
    benchmarkProtocol,
    MICROS,
    benchmarkRunId.success,
    false,
  )
  const directVolatilitySimulation = simulate(
    evaluationSessions,
    [
      ...directTargets,
      {
        signalIndex: terminalTarget.signalIndex,
        executionIndex: terminalTarget.executionIndex,
        weights: { [benchmarkSymbol]: 0 },
      },
    ],
    accountingStartIndex,
    benchmarkProtocol,
    MICROS,
    benchmarkRunId.success,
    false,
  )
  if (Result.isFailure(buyAndHoldSimulation)) {
    return Result.fail(candidateDevelopmentPlanFailure('artifact.plan.buyAndHold', buyAndHoldSimulation.failure))
  }
  if (Result.isFailure(directVolatilitySimulation)) {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.plan.directVolatility', directVolatilitySimulation.failure),
    )
  }
  const buyAndHoldSeries = selectRebuiltBenchmarkSeries(
    buyAndHoldSimulation.success.dailyPerformance,
    selectedSessions,
    'buy-and-hold',
  )
  const directVolatilitySeries = selectRebuiltBenchmarkSeries(
    directVolatilitySimulation.success.dailyPerformance,
    selectedSessions,
    'direct-volatility-timing',
  )
  if (Result.isFailure(buyAndHoldSeries)) return Result.fail(buyAndHoldSeries.failure)
  if (Result.isFailure(directVolatilitySeries)) return Result.fail(directVolatilitySeries.failure)
  const buyAndHoldMetrics = recomputePerformanceMetrics(
    'buy-and-hold',
    buyAndHoldSeries.success.series,
    initialCapitalMicros,
    buyAndHoldSeries.success.performanceBaseline,
  )
  const directVolatilityMetrics = recomputePerformanceMetrics(
    'direct-volatility-timing',
    directVolatilitySeries.success.series,
    initialCapitalMicros,
    directVolatilitySeries.success.performanceBaseline,
  )
  if (Result.isFailure(buyAndHoldMetrics)) return Result.fail(buyAndHoldMetrics.failure)
  if (Result.isFailure(directVolatilityMetrics)) return Result.fail(directVolatilityMetrics.failure)
  const baselineAccountingTerminal = baselineSimulation.success.simulation.dailyMarks.at(-1)
  const stressedAccountingTerminal = stressedSimulation.success.simulation.dailyMarks.at(-1)
  if (baselineAccountingTerminal === undefined || stressedAccountingTerminal === undefined) {
    return Result.fail(candidateDevelopmentPlanFailure('artifact.plan.accountingTerminal', 'missing'))
  }
  const baselineProof = reconcileMarkedEquity({
    runId: runtimeInput.baselineRunId,
    initialCapitalMicros,
    evaluatorTotalFeesMicros: baselineAccountingTerminal.cumulativeFeesMicros,
    evaluatorEndingEquityMicros: strategyMetrics.success.endingEquityMicros,
    events: baselineSimulation.success.events,
    simulation: baselineSimulation.success.simulation,
  })
  const stressedProof = reconcileMarkedEquity({
    runId: runtimeInput.stressedRunId,
    initialCapitalMicros,
    evaluatorTotalFeesMicros: stressedAccountingTerminal.cumulativeFeesMicros,
    evaluatorEndingEquityMicros: stressedMetrics.success.endingEquityMicros,
    events: stressedSimulation.success.events,
    simulation: stressedSimulation.success.simulation,
  })
  if (Result.isFailure(baselineProof)) {
    return Result.fail(candidateDevelopmentPlanFailure('artifact.plan.baselineReconciliation', baselineProof.failure))
  }
  if (Result.isFailure(stressedProof)) {
    return Result.fail(candidateDevelopmentPlanFailure('artifact.plan.stressedReconciliation', stressedProof.failure))
  }
  const selectedObservationStart = preflight.success.selectedObservationStart
  const selectedObservationEnd = preflight.success.selectedObservationEnd
  const selectedBaselineSignalDecisions = baselineSimulation.success.signalDecisions.filter(
    ({ executionDate }) => executionDate >= selectedObservationStart && executionDate <= selectedObservationEnd,
  )
  const selectedStressedSignalDecisions = stressedSimulation.success.signalDecisions.filter(
    ({ executionDate }) => executionDate >= selectedObservationStart && executionDate <= selectedObservationEnd,
  )
  const protocolHash = canonicalEvidenceHash('strategyProtocol', strategyProtocol)
  if (Result.isFailure(protocolHash)) return Result.fail(protocolHash.failure)
  const baseline: EvaluationResult = {
    schemaVersion: 'bayn.evaluation.v6',
    runId: runtimeInput.baselineRunId,
    codeRevision: runtimeInput.sourceRevision,
    protocolHash: protocolHash.success,
    initialCapitalMicros,
    inputManifest: manifest.success,
    strategy: strategyMetrics.success,
    buyAndHold: buyAndHoldMetrics.success,
    directVolTiming: directVolatilityMetrics.success,
    doubleCostStrategy: stressedMetrics.success,
    verdict: buildVerdict(
      strategyMetrics.success,
      buyAndHoldMetrics.success,
      directVolatilityMetrics.success,
      stressedMetrics.success,
      strategyProtocol,
    ),
    events: baselineSimulation.success.events,
    signalDecisions: selectedBaselineSignalDecisions,
    simulation: baselineTrace.success,
    benchmarkSeries: {
      buyAndHold: buyAndHoldSeries.success.series,
      directVolTiming: directVolatilitySeries.success.series,
      doubleCostStrategy: stressedSeries.success,
    },
    equitySeries: baselineProof.success.equitySeries,
    markedEquityReconciliation: baselineProof.success.reconciliation,
  }
  const comparisonSeries = prepareQualificationSeries(baseline)
  if (Result.isFailure(comparisonSeries)) {
    return Result.fail(candidateDevelopmentPlanFailure('artifact.plan.comparisonSeries', comparisonSeries.failure))
  }
  const boundComparisonSeries = validateCandidateDevelopmentComparisonSeriesBinding(
    preflight.success,
    baseline,
    comparisonSeries.success,
  )
  if (Result.isFailure(boundComparisonSeries)) {
    return Result.fail(candidateDevelopmentPlanFailure('artifact.plan.comparisonSeries', boundComparisonSeries.failure))
  }
  const comparisonSemantics = buildCandidateDevelopmentComparisonSemanticsEvidence(
    preflight.success,
    boundComparisonSeries.success,
  )
  if (Result.isFailure(comparisonSemantics)) {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.plan.comparisonSemantics', comparisonSemantics.failure),
    )
  }
  return Result.succeed({
    baseline,
    comparisonSemantics: comparisonSemantics.success,
    stressed: {
      signalDecisions: selectedStressedSignalDecisions,
      simulation: stressedTrace.success,
    },
    accounting: {
      schemaVersion: 'bayn.candidate-development-accounting-evidence.v2',
      runId: runtimeInput.baselineRunId,
      initialCapitalMicros,
      evaluatorTotalFeesMicros: baselineAccountingTerminal.cumulativeFeesMicros,
      evaluatorEndingEquityMicros: strategyMetrics.success.endingEquityMicros,
      events: baselineSimulation.success.events,
      baselineSimulation: baselineSimulation.success.simulation,
      equitySeries: baselineProof.success.equitySeries,
      markedEquityReconciliation: baselineProof.success.reconciliation,
      signalDecisions: baselineSimulation.success.signalDecisions,
      stressedRunId: runtimeInput.stressedRunId,
      stressedEvaluatorTotalFeesMicros: stressedAccountingTerminal.cumulativeFeesMicros,
      stressedEvaluatorEndingEquityMicros: stressedMetrics.success.endingEquityMicros,
      stressedEvents: stressedSimulation.success.events,
      stressedSimulation: stressedSimulation.success.simulation,
      stressedEquitySeries: stressedProof.success.equitySeries,
      stressedMarkedEquityReconciliation: stressedProof.success.reconciliation,
    },
    marketData: runtimeInput.marketData,
  })
}
