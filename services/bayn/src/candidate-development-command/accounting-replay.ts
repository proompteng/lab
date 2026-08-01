import { pipe, Result } from 'effect'
import { type CandidateDevelopmentPreflightInput, type CandidateDevelopmentReport } from '../candidate-development'
import { type DailyPerformancePoint } from '../evidence-contracts'
import { MICROS } from '../execution-model'
import { directVolatilityWeights, simulate, type SimulationTarget } from '../simulation'
import { reconcileMarkedEquity } from '../simulation-reconciliation'
import { type EvaluationResult, type IsoDate, type SimulationProtocol } from '../types'
import type {
  CandidateDevelopmentCommandEvaluation,
  CandidateDevelopmentCommandFailure,
  CandidateDevelopmentStrategyProtocol,
} from './contracts'
import {
  canonicalEvidenceHash,
  markedEquityFailure,
  performanceBaselineFromPoint,
  performanceEvidenceFailure,
  type CandidateDevelopmentPerformanceBaseline,
} from './evaluation-metrics'
import { requireCanonicalEvidenceEqual, type PreparedCandidateDevelopmentMarketData } from './market-data-binding'
import {
  bindRunIndependentDecisionPlansToEvents,
  decisionEventsInSimulationWindow,
  selectedTracePerformanceBaseline,
  signalDecisionsInSimulationWindow,
  validateAccountingCalendar,
  validateAccountingPrices,
  validateAccountingUniverse,
  validateCashYieldIntervals,
  validateDecisionEventBinding,
  validateRunIndependentDecisionPlans,
} from './accounting-evidence'

export interface CandidateDevelopmentAccountingValidation {
  readonly strategyPerformanceBaseline: CandidateDevelopmentPerformanceBaseline
  readonly stressedPerformanceBaseline: CandidateDevelopmentPerformanceBaseline
}

export interface CandidateDevelopmentRebuiltBenchmark {
  readonly series: readonly DailyPerformancePoint[]
  readonly performanceBaseline: CandidateDevelopmentPerformanceBaseline
}

export interface CandidateDevelopmentRebuiltBenchmarks {
  readonly buyAndHold: CandidateDevelopmentRebuiltBenchmark
  readonly directVolTiming: CandidateDevelopmentRebuiltBenchmark
}

export const decisionTarget = (
  decision: EvaluationResult['signalDecisions'][number],
  marketData: PreparedCandidateDevelopmentMarketData,
  weights: Readonly<Record<string, number>> = decision.targetWeights,
): Result.Result<SimulationTarget, CandidateDevelopmentCommandFailure> => {
  const signalIndex = marketData.sessionIndexByDate.get(decision.signalDate)
  const executionIndex = marketData.sessionIndexByDate.get(decision.executionDate)
  if (signalIndex === undefined || executionIndex === undefined) {
    return Result.fail(
      markedEquityFailure(
        'binding-mismatch',
        null,
        'benchmarks.schedule',
        'signal and execution dates in market-data witness',
        { signalDate: decision.signalDate, executionDate: decision.executionDate },
      ),
    )
  }
  const { decisionId: _, executionDate: __, ...plan } = decision
  return Result.succeed({ signalIndex, executionIndex, weights, decision: plan })
}

export const validateCandidateDevelopmentAccountingReplay = (
  field: 'baseline' | 'stressed',
  runId: string,
  signalDecisions: EvaluationResult['signalDecisions'],
  events: EvaluationResult['events'],
  simulation: EvaluationResult['simulation'],
  marketData: PreparedCandidateDevelopmentMarketData,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const firstMark = simulation.dailyMarks.at(0)
  const lastMark = simulation.dailyMarks.at(-1)
  const startIndex = firstMark === undefined ? undefined : marketData.sessionIndexByDate.get(firstMark.sessionDate)
  const endIndex = lastMark === undefined ? undefined : marketData.sessionIndexByDate.get(lastMark.sessionDate)
  if (startIndex === undefined || endIndex === undefined || endIndex < startIndex) {
    return Result.fail(
      markedEquityFailure(
        'binding-mismatch',
        null,
        `${field}.replay.window`,
        'bounded accounting window in market-data witness',
        { first: firstMark?.sessionDate ?? null, last: lastMark?.sessionDate ?? null },
      ),
    )
  }
  const targets = Result.all(signalDecisions.map((decision) => decisionTarget(decision, marketData)))
  if (Result.isFailure(targets)) return Result.fail(targets.failure)
  const replay = simulate(
    marketData.sessions.slice(0, endIndex + 1),
    targets.success,
    startIndex,
    strategyProtocol,
    BigInt(simulation.costMultiplierMicros),
    runId,
    true,
  )
  if (Result.isFailure(replay) || replay.success.simulation === null) {
    return Result.fail(
      markedEquityFailure(
        'reconstruction-failed',
        null,
        `${field}.replay`,
        'deterministic simulation replay from bound decisions and market data',
        null,
        Result.isFailure(replay) ? replay.failure : undefined,
      ),
    )
  }
  const monetaryEvents = events.filter((event) => event.kind !== 'decision')
  const replayedMonetaryEvents = replay.success.events.filter((event) => event.kind !== 'decision')
  const bindings = [
    [`${field}.replay.signalDecisions`, replay.success.signalDecisions, signalDecisions],
    [`${field}.replay.monetaryEvents`, replayedMonetaryEvents, monetaryEvents],
    [`${field}.replay.orders`, replay.success.simulation.orders, simulation.orders],
    [`${field}.replay.cashChanges`, replay.success.simulation.cashChanges, simulation.cashChanges],
    [`${field}.replay.dailyMarks`, replay.success.simulation.dailyMarks, simulation.dailyMarks],
  ] as const
  for (const [name, expected, observed] of bindings) {
    const binding = requireCanonicalEvidenceEqual(name, expected, observed)
    if (Result.isFailure(binding)) return Result.fail(binding.failure)
  }
  return Result.succeed(undefined)
}

export const selectRebuiltBenchmarkSeries = (
  series: readonly DailyPerformancePoint[],
  selectedSessions: readonly IsoDate[],
  name: 'buy-and-hold' | 'direct-volatility-timing',
): Result.Result<CandidateDevelopmentRebuiltBenchmark, CandidateDevelopmentCommandFailure> => {
  const bySession = new Map(series.map((point) => [point.sessionDate, point] as const))
  const selected = selectedSessions.map((sessionDate) => bySession.get(sessionDate))
  const missing = selected.findIndex((point) => point === undefined)
  if (missing >= 0) {
    return Result.fail(
      performanceEvidenceFailure(name, 'session-mismatch', missing, 'sessionDate', selectedSessions[missing], null),
    )
  }
  const complete = selected as readonly DailyPerformancePoint[]
  const first = complete.at(0)
  if (first === undefined) {
    return Result.fail(performanceEvidenceFailure(name, 'observations-insufficient', null, null, '>=2', 0))
  }
  const firstIndex = series.findIndex((point) => point.sessionDate === first.sessionDate)
  if (firstIndex !== 1) {
    return Result.fail(performanceEvidenceFailure(name, 'session-mismatch', null, 'predecessorCount', 1, firstIndex))
  }
  const predecessor = series[0]
  const normalizedReturn = Number(first.equityMicros) / Number(predecessor.equityMicros) - 1
  if (!Number.isFinite(normalizedReturn)) {
    return Result.fail(
      performanceEvidenceFailure(name, 'return-mismatch', 0, 'netReturn', 'finite normalized return', normalizedReturn),
    )
  }
  return Result.succeed({
    series: [{ ...first, netReturn: normalizedReturn }, ...complete.slice(1)],
    performanceBaseline: performanceBaselineFromPoint(predecessor),
  })
}

export const rebuildCandidateDevelopmentBenchmarks = (
  evaluation: CandidateDevelopmentCommandEvaluation,
  marketData: PreparedCandidateDevelopmentMarketData,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
): Result.Result<CandidateDevelopmentRebuiltBenchmarks, CandidateDevelopmentCommandFailure> => {
  const { accounting, baseline } = evaluation
  const decisions = accounting.signalDecisions
  const terminal = decisions.at(-1)
  const firstMark = accounting.baselineSimulation.dailyMarks.at(0)
  const lastMark = accounting.baselineSimulation.dailyMarks.at(-1)
  if (terminal === undefined || firstMark === undefined || lastMark === undefined) {
    return Result.fail(
      markedEquityFailure(
        'binding-mismatch',
        null,
        'benchmarks.inputs',
        'nonempty decisions and accounting marks',
        null,
      ),
    )
  }
  if (Object.values(terminal.targetWeights).some((weight) => weight !== 0)) {
    return Result.fail(
      markedEquityFailure(
        'binding-mismatch',
        decisions.length - 1,
        'benchmarks.terminalDecision',
        'all-cash target weights',
        terminal.targetWeights,
      ),
    )
  }
  const benchmarkSymbol = strategyProtocol.benchmarks.symbol
  if (!strategyProtocol.universe.includes(benchmarkSymbol)) {
    return Result.fail(
      markedEquityFailure('binding-mismatch', null, 'benchmarks.symbol', strategyProtocol.universe, benchmarkSymbol),
    )
  }
  const startIndex = marketData.sessionIndexByDate.get(firstMark.sessionDate)
  const selectedFirstMark = baseline.simulation.dailyMarks.at(0)
  const selectedStartIndex =
    selectedFirstMark === undefined ? undefined : marketData.sessionIndexByDate.get(selectedFirstMark.sessionDate)
  const endIndex = marketData.sessionIndexByDate.get(lastMark.sessionDate)
  if (
    startIndex === undefined ||
    selectedStartIndex === undefined ||
    endIndex === undefined ||
    selectedStartIndex !== startIndex + 1 ||
    endIndex < selectedStartIndex
  ) {
    return Result.fail(
      markedEquityFailure(
        'binding-mismatch',
        null,
        'benchmarks.window',
        'one accounting predecessor followed by the selected benchmark window',
        {
          accountingFirst: firstMark.sessionDate,
          selectedFirst: selectedFirstMark?.sessionDate ?? null,
          last: lastMark.sessionDate,
        },
      ),
    )
  }
  const benchmarkProtocol: SimulationProtocol = { ...strategyProtocol, universe: [benchmarkSymbol] }
  const terminalTarget = decisionTarget(terminal, marketData, { [benchmarkSymbol]: 0 })
  if (Result.isFailure(terminalTarget)) return Result.fail(terminalTarget.failure)
  const directTargets = Result.all(
    decisions.slice(0, -1).map((decision, index) => {
      const signalIndex = marketData.sessionIndexByDate.get(decision.signalDate)
      if (signalIndex === undefined) {
        return Result.fail(
          markedEquityFailure(
            'binding-mismatch',
            index,
            'benchmarks.directVolatility.signalDate',
            'market session',
            decision.signalDate,
          ),
        )
      }
      return pipe(
        directVolatilityWeights(marketData.sessions, signalIndex, benchmarkProtocol),
        Result.mapError((cause) =>
          markedEquityFailure(
            'reconstruction-failed',
            index,
            'benchmarks.directVolatility',
            'governed direct-volatility weights',
            null,
            cause,
          ),
        ),
        Result.flatMap((weights) => decisionTarget(decision, marketData, weights)),
      )
    }),
  )
  if (Result.isFailure(directTargets)) return Result.fail(directTargets.failure)
  const benchmarkRunId = canonicalEvidenceHash('benchmarks.runId', {
    schemaVersion: 'bayn.candidate-development-benchmark-run.v1',
    candidateRunId: baseline.runId,
    marketDataContentHash: marketData.witness.contentHash,
    policy: strategyProtocol.benchmarks,
  })
  if (Result.isFailure(benchmarkRunId)) return Result.fail(benchmarkRunId.failure)
  const sessions = marketData.sessions.slice(0, endIndex + 1)
  const buyAndHold = simulate(
    sessions,
    [
      {
        signalIndex: startIndex,
        executionIndex: selectedStartIndex,
        weights: { [benchmarkSymbol]: 1 },
      },
      terminalTarget.success,
    ],
    startIndex,
    benchmarkProtocol,
    MICROS,
    benchmarkRunId.success,
    false,
  )
  if (Result.isFailure(buyAndHold)) {
    return Result.fail(
      markedEquityFailure(
        'reconstruction-failed',
        null,
        'benchmarks.buyAndHold',
        'governed benchmark replay',
        null,
        buyAndHold.failure,
      ),
    )
  }
  const directVolTiming = simulate(
    sessions,
    [...directTargets.success, terminalTarget.success],
    startIndex,
    benchmarkProtocol,
    MICROS,
    benchmarkRunId.success,
    false,
  )
  if (Result.isFailure(directVolTiming)) {
    return Result.fail(
      markedEquityFailure(
        'reconstruction-failed',
        null,
        'benchmarks.directVolatility',
        'governed benchmark replay',
        null,
        directVolTiming.failure,
      ),
    )
  }
  const selectedSessions = baseline.simulation.dailyMarks.map((mark) => mark.sessionDate)
  return Result.all({
    buyAndHold: selectRebuiltBenchmarkSeries(buyAndHold.success.dailyPerformance, selectedSessions, 'buy-and-hold'),
    directVolTiming: selectRebuiltBenchmarkSeries(
      directVolTiming.success.dailyPerformance,
      selectedSessions,
      'direct-volatility-timing',
    ),
  })
}

export const validateCandidateDevelopmentAccounting = (
  report: CandidateDevelopmentReport,
  evaluation: CandidateDevelopmentCommandEvaluation,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
  officialSessions: CandidateDevelopmentPreflightInput['officialSessions'],
  marketData: PreparedCandidateDevelopmentMarketData,
): Result.Result<CandidateDevelopmentAccountingValidation, CandidateDevelopmentCommandFailure> => {
  const { accounting, baseline } = evaluation
  const scalarBindings = [
    ['runId', baseline.runId, accounting.runId],
    ['initialCapitalMicros', baseline.initialCapitalMicros, accounting.initialCapitalMicros],
    ['evaluatorEndingEquityMicros', baseline.strategy.endingEquityMicros, accounting.evaluatorEndingEquityMicros],
    [
      'stressedEvaluatorEndingEquityMicros',
      baseline.doubleCostStrategy.endingEquityMicros,
      accounting.stressedEvaluatorEndingEquityMicros,
    ],
  ] as const
  for (const [field, expected, observed] of scalarBindings) {
    if (expected !== observed) {
      return Result.fail(markedEquityFailure('binding-mismatch', null, field, expected, observed))
    }
  }
  const bindings = [
    ['events', baseline.events, accounting.events],
    ['baseline.orders', baseline.simulation.orders, accounting.baselineSimulation.orders],
    ['baseline.cashChanges', baseline.simulation.cashChanges, accounting.baselineSimulation.cashChanges],
    ['baseline.executionModel', baseline.simulation.executionModel, accounting.baselineSimulation.executionModel],
    [
      'baseline.costMultiplierMicros',
      baseline.simulation.costMultiplierMicros,
      accounting.baselineSimulation.costMultiplierMicros,
    ],
    ['stressed.orders', report.doubledCost.stressed.simulation.orders, accounting.stressedSimulation.orders],
    [
      'stressed.cashChanges',
      report.doubledCost.stressed.simulation.cashChanges,
      accounting.stressedSimulation.cashChanges,
    ],
    [
      'stressed.executionModel',
      report.doubledCost.stressed.simulation.executionModel,
      accounting.stressedSimulation.executionModel,
    ],
    [
      'stressed.costMultiplierMicros',
      report.doubledCost.stressed.simulation.costMultiplierMicros,
      accounting.stressedSimulation.costMultiplierMicros,
    ],
    ['equitySeries', baseline.equitySeries, accounting.equitySeries],
    ['markedEquityReconciliation', baseline.markedEquityReconciliation, accounting.markedEquityReconciliation],
  ] as const
  for (const [field, expected, observed] of bindings) {
    const binding = requireCanonicalEvidenceEqual(field, expected, observed)
    if (Result.isFailure(binding)) return Result.fail(binding.failure)
  }
  const selectedTraceBindings = Result.all({
    strategyPerformanceBaseline: selectedTracePerformanceBaseline(
      'baselineSimulation',
      accounting.baselineSimulation,
      baseline.simulation,
      accounting.events,
    ),
    stressedPerformanceBaseline: selectedTracePerformanceBaseline(
      'stressedSimulation',
      accounting.stressedSimulation,
      report.doubledCost.stressed.simulation,
      accounting.stressedEvents,
    ),
  })
  if (Result.isFailure(selectedTraceBindings)) return Result.fail(selectedTraceBindings.failure)
  const selectedBaselinePlans = signalDecisionsInSimulationWindow(accounting.signalDecisions, baseline.simulation)
  const selectedBaselineEvents = decisionEventsInSimulationWindow(accounting.events, baseline.simulation)
  const baselineDecisionBindings = Result.all({
    universe: validateAccountingUniverse(
      'baseline',
      strategyProtocol.universe,
      accounting.signalDecisions,
      accounting.events,
      accounting.baselineSimulation,
    ),
    selectedPlans: requireCanonicalEvidenceEqual(
      'baseline.signalDecisions',
      baseline.signalDecisions,
      selectedBaselinePlans,
    ),
    fullEvents: validateDecisionEventBinding('baseline', accounting.signalDecisions, accounting.events),
    selectedEvents: validateDecisionEventBinding('baseline', baseline.signalDecisions, selectedBaselineEvents),
  })
  if (Result.isFailure(baselineDecisionBindings)) return Result.fail(baselineDecisionBindings.failure)
  const stressedAccountingPlans = bindRunIndependentDecisionPlansToEvents(
    'stressed',
    accounting.signalDecisions,
    accounting.stressedEvents,
  )
  if (Result.isFailure(stressedAccountingPlans)) return Result.fail(stressedAccountingPlans.failure)
  const selectedStressedPlans = signalDecisionsInSimulationWindow(
    stressedAccountingPlans.success,
    report.doubledCost.stressed.simulation,
  )
  const selectedStressedEvents = decisionEventsInSimulationWindow(
    accounting.stressedEvents,
    report.doubledCost.stressed.simulation,
  )
  const domainBindings = Result.all({
    baselineCalendar: validateAccountingCalendar('baseline', officialSessions, accounting.baselineSimulation),
    stressedCalendar: validateAccountingCalendar('stressed', officialSessions, accounting.stressedSimulation),
    stressedUniverse: validateAccountingUniverse(
      'stressed',
      strategyProtocol.universe,
      stressedAccountingPlans.success,
      accounting.stressedEvents,
      accounting.stressedSimulation,
    ),
    baselineCashYield: validateCashYieldIntervals('baseline', accounting.events, accounting.baselineSimulation),
    stressedCashYield: validateCashYieldIntervals('stressed', accounting.stressedEvents, accounting.stressedSimulation),
    baselinePrices: validateAccountingPrices(
      'baseline',
      accounting.events,
      accounting.baselineSimulation,
      marketData,
      strategyProtocol,
    ),
    stressedPrices: validateAccountingPrices(
      'stressed',
      accounting.stressedEvents,
      accounting.stressedSimulation,
      marketData,
      strategyProtocol,
    ),
    baselineReplay: validateCandidateDevelopmentAccountingReplay(
      'baseline',
      accounting.runId,
      accounting.signalDecisions,
      accounting.events,
      accounting.baselineSimulation,
      marketData,
      strategyProtocol,
    ),
    stressedReplay: validateCandidateDevelopmentAccountingReplay(
      'stressed',
      accounting.stressedRunId,
      stressedAccountingPlans.success,
      accounting.stressedEvents,
      accounting.stressedSimulation,
      marketData,
      strategyProtocol,
    ),
  })
  if (Result.isFailure(domainBindings)) return Result.fail(domainBindings.failure)
  const decisionBindings = Result.all({
    stressedPlans: validateRunIndependentDecisionPlans(
      'stressed.signalDecisions',
      report.doubledCost.stressed.signalDecisions,
      selectedStressedPlans,
    ),
    stressedFull: validateDecisionEventBinding('stressed', stressedAccountingPlans.success, accounting.stressedEvents),
    stressedSelected: validateDecisionEventBinding(
      'stressed',
      report.doubledCost.stressed.signalDecisions,
      selectedStressedEvents,
    ),
  })
  if (Result.isFailure(decisionBindings)) return Result.fail(decisionBindings.failure)
  const proof = reconcileMarkedEquity({
    runId: accounting.runId,
    initialCapitalMicros: accounting.initialCapitalMicros,
    evaluatorTotalFeesMicros: accounting.evaluatorTotalFeesMicros,
    evaluatorEndingEquityMicros: accounting.evaluatorEndingEquityMicros,
    events: accounting.events,
    simulation: accounting.baselineSimulation,
  })
  if (Result.isFailure(proof)) {
    return Result.fail(
      markedEquityFailure('reconstruction-failed', null, 'accounting', 'reconciled marked equity', null, proof.failure),
    )
  }
  const proofBinding = requireCanonicalEvidenceEqual(
    'accounting.markedEquityProof',
    { reconciliation: accounting.markedEquityReconciliation, equitySeries: accounting.equitySeries },
    proof.success,
  )
  if (Result.isFailure(proofBinding)) {
    return Result.fail(
      markedEquityFailure(
        'proof-mismatch',
        null,
        'accounting.markedEquityProof',
        accounting.markedEquityReconciliation,
        proof.success.reconciliation,
        proofBinding.failure,
      ),
    )
  }
  const stressedProof = reconcileMarkedEquity({
    runId: accounting.stressedRunId,
    initialCapitalMicros: accounting.initialCapitalMicros,
    evaluatorTotalFeesMicros: accounting.stressedEvaluatorTotalFeesMicros,
    evaluatorEndingEquityMicros: accounting.stressedEvaluatorEndingEquityMicros,
    events: accounting.stressedEvents,
    simulation: accounting.stressedSimulation,
  })
  if (Result.isFailure(stressedProof)) {
    return Result.fail(
      markedEquityFailure(
        'reconstruction-failed',
        null,
        'accounting.stressed',
        'reconciled stressed marked equity',
        null,
        stressedProof.failure,
      ),
    )
  }
  const stressedProofBinding = requireCanonicalEvidenceEqual(
    'accounting.stressedMarkedEquityProof',
    {
      reconciliation: accounting.stressedMarkedEquityReconciliation,
      equitySeries: accounting.stressedEquitySeries,
    },
    stressedProof.success,
  )
  if (Result.isFailure(stressedProofBinding)) {
    return Result.fail(
      markedEquityFailure(
        'proof-mismatch',
        null,
        'accounting.stressedMarkedEquityProof',
        accounting.stressedMarkedEquityReconciliation,
        stressedProof.success.reconciliation,
        stressedProofBinding.failure,
      ),
    )
  }
  return Result.succeed(selectedTraceBindings.success)
}
