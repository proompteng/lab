import type { RuntimeProvenance } from './contracts'
import { MICROS } from './execution-model'
import { hashTsmomParameters } from './protocol'
import { reconcileMarkedEquity } from './simulation-reconciliation'
import {
  alignBars,
  buildVerdict,
  directVolatilityWeights,
  makeEvaluationIdentity,
  roundWeight,
  selectEvaluationWindow,
  simulate,
  type SimulationTarget,
} from './simulation'
import {
  ContractVersion,
  type DailyBar,
  type EvaluationResult,
  type EvaluationSummary,
  type InputManifest,
  type IsoDate,
  type TsmomDecisionPlan,
  type TsmomEvaluationResult,
  type TsmomProtocol,
} from './types'

export const makeTsmomDecision = (
  signalDate: IsoDate,
  closes: Readonly<Record<string, readonly number[]>>,
  protocol: TsmomProtocol,
): TsmomDecisionPlan => {
  const maximumLookback = Math.max(...protocol.lookbacks)
  const rawSignals = protocol.universe.map((symbol) => {
    const history = closes[symbol]
    if (history === undefined || history.length !== maximumLookback + 1) {
      throw new Error(`TSMOM decision requires ${maximumLookback + 1} ordered closes for ${symbol}`)
    }
    if (history.some((price) => !Number.isFinite(price) || price <= 0)) {
      throw new Error(`TSMOM decision contains an invalid close for ${symbol}`)
    }
    const current = history.at(-1)
    if (current === undefined) throw new Error(`TSMOM decision has no current close for ${symbol}`)
    const lookbacks = protocol.lookbacks.map((lookbackSessions) => {
      const prior = history[maximumLookback - lookbackSessions]
      if (prior === undefined) throw new Error(`TSMOM decision has no ${lookbackSessions}-session close for ${symbol}`)
      const value = current / prior - 1
      return {
        lookbackSessions,
        return: value,
        direction: value > 0 ? ('positive' as const) : ('non-positive' as const),
      }
    })
    const score = lookbacks.reduce((total, signal) => total + (signal.direction === 'positive' ? 1 : -1), 0)
    return { symbol, lookbacks, score, active: score > 0 }
  })
  const activeCount = rawSignals.filter((signal) => signal.active).length
  const activeWeight = activeCount === 0 ? 0 : roundWeight(1 / activeCount)
  const signals = rawSignals.map((signal) => ({
    ...signal,
    targetWeight: signal.active ? activeWeight : 0,
  }))
  return {
    schemaVersion: ContractVersion.TsmomDecisionPlan,
    signalDate,
    targetWeights: Object.fromEntries(signals.map((signal) => [signal.symbol, signal.targetWeight])),
    signals,
  }
}

export interface TsmomQualificationPrecommit {
  readonly candidateRunId: string
  readonly protocolHash: string
  readonly selectedSessionCount: number
  readonly selectedRebalanceCount: number
  readonly signalDates: readonly IsoDate[]
  readonly executionDates: readonly IsoDate[]
}

export const prepareTsmomQualification = (
  sessionDates: readonly IsoDate[],
  inputManifest: InputManifest,
  protocol: TsmomProtocol,
  provenance: RuntimeProvenance,
): TsmomQualificationPrecommit => {
  const { runId, protocolHash } = makeEvaluationIdentity(
    inputManifest,
    protocol,
    provenance,
    'tsmom',
    hashTsmomParameters(protocol),
  )
  const window = selectEvaluationWindow(
    sessionDates,
    inputManifest,
    Math.max(...protocol.lookbacks),
    protocol.thresholds.minimumObservations,
  )
  return {
    candidateRunId: runId,
    protocolHash,
    selectedSessionCount: window.evaluationEndExclusive - window.startIndex,
    selectedRebalanceCount: window.signalIndices.length,
    signalDates: window.signalIndices.map((index) => sessionDates[index]),
    executionDates: window.signalIndices.map((index) => sessionDates[index + 1]),
  }
}

export const evaluateTsmom = (
  bars: readonly DailyBar[],
  inputManifest: InputManifest,
  protocol: TsmomProtocol,
  provenance: RuntimeProvenance,
): TsmomEvaluationResult => {
  const { runId, protocolHash } = makeEvaluationIdentity(
    inputManifest,
    protocol,
    provenance,
    'tsmom',
    hashTsmomParameters(protocol),
  )
  const sessions = alignBars(bars, protocol.universe, inputManifest)
  const sessionDates = sessions.map((session) => session.date)
  const window = selectEvaluationWindow(
    sessionDates,
    inputManifest,
    Math.max(...protocol.lookbacks),
    protocol.thresholds.minimumObservations,
  )
  const maximumLookback = Math.max(...protocol.lookbacks)
  const { signalIndices, startIndex } = window
  const evaluationSessions = sessions.slice(0, window.evaluationEndExclusive)

  const strategyTargets: SimulationTarget[] = signalIndices.map((signalIndex) => {
    const closes = Object.fromEntries(
      protocol.universe.map((symbol) => [
        symbol,
        sessions.slice(signalIndex - maximumLookback, signalIndex + 1).map((session) => session.bars[symbol].close),
      ]),
    )
    const decision = makeTsmomDecision(sessions[signalIndex].date, closes, protocol)
    return {
      signalIndex,
      executionIndex: signalIndex + 1,
      weights: decision.targetWeights,
      decision,
    }
  })
  const equalWeight = roundWeight(1 / protocol.universe.length)
  const buyAndHoldTargets: SimulationTarget[] = [
    {
      signalIndex: startIndex - 1,
      executionIndex: startIndex,
      weights: Object.fromEntries(protocol.universe.map((symbol) => [symbol, equalWeight])),
    },
  ]
  const directVolTargets: SimulationTarget[] = signalIndices.map((signalIndex) => ({
    signalIndex,
    executionIndex: signalIndex + 1,
    weights: directVolatilityWeights(sessions, signalIndex, protocol),
  }))
  const strategy = simulate(evaluationSessions, strategyTargets, startIndex, protocol, MICROS, runId, true)
  const buyAndHold = simulate(evaluationSessions, buyAndHoldTargets, startIndex, protocol, MICROS, runId, false)
  const directVolTiming = simulate(evaluationSessions, directVolTargets, startIndex, protocol, MICROS, runId, false)
  const doubleCost = simulate(
    evaluationSessions,
    strategyTargets,
    startIndex,
    protocol,
    BigInt(protocol.executionModel.doubleCostMultiplier) * MICROS,
    runId,
    false,
  )
  if (strategy.simulation === null) throw new Error('candidate simulation did not retain its evidence trace')
  const signalDecisions = strategy.signalDecisions.map((decision) => {
    if (decision.schemaVersion !== ContractVersion.TsmomDecisionPlan) {
      throw new Error('TSMOM simulation retained a decision from another strategy')
    }
    return decision
  })
  const markedEquity = reconcileMarkedEquity({
    runId,
    initialCapitalMicros: protocol.initialCapitalMicros,
    evaluatorTotalFeesMicros: strategy.metrics.totalFeesMicros,
    evaluatorEndingEquityMicros: strategy.metrics.endingEquityMicros,
    events: strategy.events,
    simulation: strategy.simulation,
  })

  return {
    schemaVersion: ContractVersion.Evaluation,
    runId,
    codeRevision: provenance.sourceRevision,
    protocolHash,
    initialCapitalMicros: protocol.initialCapitalMicros,
    inputManifest,
    strategy: strategy.metrics,
    buyAndHold: buyAndHold.metrics,
    directVolTiming: directVolTiming.metrics,
    doubleCostStrategy: doubleCost.metrics,
    verdict: buildVerdict(strategy.metrics, buyAndHold.metrics, directVolTiming.metrics, doubleCost.metrics, protocol),
    events: strategy.events,
    signalDecisions,
    simulation: strategy.simulation,
    benchmarkSeries: {
      buyAndHold: buyAndHold.dailyPerformance,
      directVolTiming: directVolTiming.dailyPerformance,
      doubleCostStrategy: doubleCost.dailyPerformance,
    },
    equitySeries: markedEquity.equitySeries,
    markedEquityReconciliation: markedEquity.reconciliation,
  }
}

export const summarizeEvaluation = (evaluation: EvaluationResult): EvaluationSummary => {
  const summary = {
    runId: evaluation.runId,
    codeRevision: evaluation.codeRevision,
    protocolHash: evaluation.protocolHash,
    initialCapitalMicros: evaluation.initialCapitalMicros,
    input: {
      snapshotId: evaluation.inputManifest.finalizedSnapshot.snapshotId,
      publicationId: evaluation.inputManifest.finalizedSnapshot.publicationId,
      manifestHash: evaluation.inputManifest.hash,
      bounds: evaluation.inputManifest.bounds,
      rowCount: evaluation.inputManifest.rowCount,
      sessionCount: evaluation.inputManifest.sessionCount,
      symbols: evaluation.inputManifest.symbols.map((coverage) => coverage.symbol),
    },
    strategy: evaluation.strategy,
    buyAndHold: evaluation.buyAndHold,
    directVolTiming: evaluation.directVolTiming,
    doubleCostStrategy: evaluation.doubleCostStrategy,
    verdict: evaluation.verdict,
    eventCount: evaluation.events.length,
    signalDecisionCount: evaluation.signalDecisions.length,
    orderCount: evaluation.simulation.orders.length,
    cashChangeCount: evaluation.simulation.cashChanges.length,
    dailyMarkCount: evaluation.simulation.dailyMarks.length,
    benchmarkSeriesCounts: {
      buyAndHold: evaluation.benchmarkSeries.buyAndHold.length,
      directVolTiming: evaluation.benchmarkSeries.directVolTiming.length,
      doubleCostStrategy: evaluation.benchmarkSeries.doubleCostStrategy.length,
    },
    markedEquityReconciliation: evaluation.markedEquityReconciliation,
  }
  return evaluation.schemaVersion === ContractVersion.Evaluation
    ? {
        ...summary,
        schemaVersion: ContractVersion.EvaluationSummary,
        evaluationSchemaVersion: ContractVersion.Evaluation,
      }
    : {
        ...summary,
        schemaVersion: ContractVersion.RiskBalancedTrendEvaluationSummary,
        evaluationSchemaVersion: ContractVersion.RiskBalancedTrendEvaluation,
      }
}
