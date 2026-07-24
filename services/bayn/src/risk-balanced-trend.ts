import { Result, Schema } from 'effect'

import type { RuntimeProvenance } from './contracts'
import { MICROS, referencePriceMicros } from './execution-model'
import { ExecutionSessionBindingSchema, type ExecutionSessionBinding } from './execution-session'
import { canonicalHashV1 } from './hash'
import { strictParseOptions } from './schemas'
import {
  reconcileMarkedEquity,
  renderSimulationReconciliationIssue,
  type SimulationReconciliationIssue,
} from './simulation-reconciliation'
import {
  alignBars,
  buildVerdict,
  directVolatilityWeights,
  makeEvaluationIdentity,
  mean,
  roundWeight,
  sampleStandardDeviation,
  selectEvaluationWindow,
  simulate,
  TRADING_DAYS,
  type AlignedSession,
  type SimulationTarget,
} from './simulation'
import {
  ContractVersion,
  type DailyBar,
  type EvaluationResult,
  type EvaluationSummary,
  type InputManifest,
  type IsoDate,
  type DecisionPlan,
  type Protocol,
  type SignalDecision,
} from './types'

const WEIGHT_SCALE = 1_000_000_000_000

const requiredHistory = (protocol: Protocol): number => Math.max(protocol.volatilityWindow, ...protocol.horizons)

const requireFinite = (value: number, description: string): number => {
  if (!Number.isFinite(value)) throw new Error(`${description} is not finite`)
  return value
}

const dailyReturns = (closes: readonly number[], count: number, symbol: string): readonly number[] => {
  const window = closes.slice(-(count + 1))
  if (window.length !== count + 1) throw new Error(`risk-balanced trend requires ${count + 1} closes for ${symbol}`)
  return window
    .slice(1)
    .map((close, index) => requireFinite(close / window[index] - 1, `risk-balanced trend daily return for ${symbol}`))
}

const redistributeWithCap = (
  scores: Readonly<Record<string, number>>,
  maximumWeight: number,
): Readonly<Record<string, number>> => {
  const weights = Object.fromEntries(
    Object.keys(scores)
      .sort()
      .map((symbol) => [symbol, 0]),
  )
  let remainingWeight = 1
  let remainingSymbols = Object.keys(scores)
    .filter((symbol) => scores[symbol] > 0)
    .sort()

  while (remainingSymbols.length > 0 && remainingWeight > 0) {
    const remainingScore = remainingSymbols.reduce((total, symbol) => total + scores[symbol], 0)
    if (!Number.isFinite(remainingScore) || remainingScore <= 0) break
    const capped = remainingSymbols.filter(
      (symbol) => (remainingWeight * scores[symbol]) / remainingScore > maximumWeight,
    )
    if (capped.length === 0) {
      for (const symbol of remainingSymbols) {
        weights[symbol] = (remainingWeight * scores[symbol]) / remainingScore
      }
      break
    }
    for (const symbol of capped) {
      weights[symbol] = maximumWeight
      remainingWeight = Math.max(0, remainingWeight - maximumWeight)
    }
    const cappedSymbols = new Set(capped)
    remainingSymbols = remainingSymbols.filter((symbol) => !cappedSymbols.has(symbol))
  }

  return weights
}

const quantizeWeights = (
  weights: Readonly<Record<string, number>>,
  maximumSymbolWeight: number,
): Readonly<Record<string, number>> => {
  const maximumUnits = Math.floor(maximumSymbolWeight * WEIGHT_SCALE + Number.EPSILON)
  const units = Object.fromEntries(
    Object.keys(weights)
      .sort()
      .map((symbol) => {
        const weight = weights[symbol]
        if (!Number.isFinite(weight) || weight < 0) throw new Error(`invalid target weight for ${symbol}`)
        return [symbol, Math.min(maximumUnits, Math.max(0, Math.round(weight * WEIGHT_SCALE)))]
      }),
  )
  let totalUnits = Object.values(units).reduce((total, value) => total + value, 0)
  let excessUnits = Math.max(0, totalUnits - WEIGHT_SCALE)
  for (const symbol of Object.keys(units).sort().reverse()) {
    if (excessUnits === 0) break
    const removed = Math.min(units[symbol], excessUnits)
    units[symbol] -= removed
    excessUnits -= removed
    totalUnits -= removed
  }
  if (totalUnits > WEIGHT_SCALE || excessUnits > 0) throw new Error('target weights cannot be bounded at full exposure')
  return Object.fromEntries(Object.entries(units).map(([symbol, value]) => [symbol, value / WEIGHT_SCALE]))
}

const covariance = (left: readonly number[], right: readonly number[]): number => {
  if (left.length !== right.length || left.length < 2) throw new Error('covariance inputs are not aligned')
  const leftMean = mean(left)
  const rightMean = mean(right)
  return requireFinite(
    left.reduce((total, value, index) => total + (value - leftMean) * (right[index] - rightMean), 0) /
      (left.length - 1),
    'risk-balanced trend covariance',
  )
}

const annualizedPortfolioVolatility = (
  weights: Readonly<Record<string, number>>,
  returns: Readonly<Record<string, readonly number[]>>,
): number => {
  const symbols = Object.keys(weights).sort()
  const dailyVariance = symbols.reduce(
    (outer, left) =>
      outer +
      symbols.reduce(
        (inner, right) => inner + weights[left] * weights[right] * covariance(returns[left], returns[right]),
        0,
      ),
    0,
  )
  if (!Number.isFinite(dailyVariance) || dailyVariance < -1e-12) {
    throw new Error('risk-balanced trend covariance produced an invalid portfolio variance')
  }
  return requireFinite(Math.sqrt(Math.max(0, dailyVariance) * TRADING_DAYS), 'annualized portfolio volatility')
}

export const makeRiskBalancedTrendDecision = (
  signalDate: IsoDate,
  sessionDates: readonly IsoDate[],
  closes: Readonly<Record<string, readonly number[]>>,
  protocol: Protocol,
): DecisionPlan => {
  const historyLength = requiredHistory(protocol) + 1
  if (
    sessionDates.length !== historyLength ||
    sessionDates.at(-1) !== signalDate ||
    sessionDates.some((date, index) => index > 0 && date <= sessionDates[index - 1])
  ) {
    throw new Error(`risk-balanced trend requires ${historyLength} ordered sessions ending on the signal date`)
  }
  if (canonicalHashV1(Object.keys(closes).sort()) !== canonicalHashV1(protocol.universe)) {
    throw new Error('risk-balanced trend close histories do not match the protocol universe')
  }

  const returnsBySymbol: Record<string, readonly number[]> = {}
  const rawSignals = protocol.universe.map((symbol) => {
    const history = closes[symbol]
    if (history === undefined || history.length !== historyLength) {
      throw new Error(`risk-balanced trend requires ${historyLength} ordered closes for ${symbol}`)
    }
    if (history.some((price) => !Number.isFinite(price) || price <= 0)) {
      throw new Error(`risk-balanced trend contains an invalid close for ${symbol}`)
    }
    const current = history.at(-1)
    if (current === undefined) throw new Error(`risk-balanced trend has no current close for ${symbol}`)
    const recentReturns = dailyReturns(history, protocol.volatilityWindow, symbol)
    returnsBySymbol[symbol] = recentReturns
    const dailyVolatility = sampleStandardDeviation(recentReturns)
    const annualizedVolatility = requireFinite(
      dailyVolatility * Math.sqrt(TRADING_DAYS),
      `annualized volatility for ${symbol}`,
    )
    const horizons = protocol.horizons.map((horizonSessions) => {
      const prior = history[history.length - 1 - horizonSessions]
      if (prior === undefined)
        throw new Error(`risk-balanced trend has no ${horizonSessions}-session close for ${symbol}`)
      const value = requireFinite(current / prior - 1, `${horizonSessions}-session return for ${symbol}`)
      const normalizedTrend =
        dailyVolatility === 0
          ? 0
          : requireFinite(value / (dailyVolatility * Math.sqrt(horizonSessions)), `normalized trend for ${symbol}`)
      return { horizonSessions, return: value, normalizedTrend }
    })
    const compositeScore =
      dailyVolatility === 0
        ? 0
        : requireFinite(mean(horizons.map((value) => value.normalizedTrend)), `composite score for ${symbol}`)
    return {
      symbol,
      horizons,
      dailyVolatility,
      annualizedVolatility,
      compositeScore,
      positiveScore: Math.max(0, compositeScore),
      eligible: dailyVolatility > 0,
    }
  })

  const positiveScores = Object.fromEntries(rawSignals.map((signal) => [signal.symbol, signal.positiveScore]))
  const totalPositiveScore = Object.values(positiveScores).reduce((total, score) => total + score, 0)
  const uncappedWeights = Object.fromEntries(
    protocol.universe.map((symbol) => [
      symbol,
      totalPositiveScore === 0 ? 0 : positiveScores[symbol] / totalPositiveScore,
    ]),
  )
  const rawCappedWeights = redistributeWithCap(positiveScores, protocol.maximumSymbolWeight)
  const cappedWeights = quantizeWeights(rawCappedWeights, protocol.maximumSymbolWeight)
  const estimatedAnnualizedPortfolioVolatility = annualizedPortfolioVolatility(cappedWeights, returnsBySymbol)
  const exposureScale =
    estimatedAnnualizedPortfolioVolatility === 0
      ? 1
      : Math.min(1, protocol.maximumPortfolioVolatility / estimatedAnnualizedPortfolioVolatility)
  let targetWeights = quantizeWeights(
    Object.fromEntries(protocol.universe.map((symbol) => [symbol, cappedWeights[symbol] * exposureScale])),
    protocol.maximumSymbolWeight,
  )
  const finalVolatility = annualizedPortfolioVolatility(targetWeights, returnsBySymbol)
  if (finalVolatility > protocol.maximumPortfolioVolatility) {
    const correction = protocol.maximumPortfolioVolatility / finalVolatility
    targetWeights = Object.fromEntries(
      Object.entries(targetWeights).map(([symbol, weight]) => [
        symbol,
        Math.floor(weight * correction * WEIGHT_SCALE) / WEIGHT_SCALE,
      ]),
    )
  }
  const finalWeightTotal = Object.values(targetWeights).reduce((total, weight) => total + weight, 0)
  if (
    finalWeightTotal > 1 + 1e-12 ||
    Object.values(targetWeights).some(
      (weight) => !Number.isFinite(weight) || weight < 0 || weight > protocol.maximumSymbolWeight + 1e-12,
    ) ||
    annualizedPortfolioVolatility(targetWeights, returnsBySymbol) > protocol.maximumPortfolioVolatility + 1e-12
  ) {
    throw new Error('risk-balanced trend produced weights outside the protocol limits')
  }

  const covarianceDates = sessionDates.slice(-protocol.volatilityWindow)
  const signals = rawSignals.map((signal) => ({
    ...signal,
    uncappedWeight: roundWeight(uncappedWeights[signal.symbol]),
    cappedWeight: cappedWeights[signal.symbol],
    targetWeight: targetWeights[signal.symbol],
  }))
  return {
    schemaVersion: ContractVersion.DecisionPlan,
    signalDate,
    covarianceWindow: {
      returnCount: protocol.volatilityWindow,
      firstSession: covarianceDates[0],
      lastSession: covarianceDates.at(-1) ?? signalDate,
      sessionsHash: canonicalHashV1(covarianceDates),
    },
    estimatedAnnualizedPortfolioVolatility,
    exposureScale,
    targetWeights,
    signals,
  }
}

const decisionFromAlignedSessions = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  protocol: Protocol,
): DecisionPlan => {
  const signalSession = sessions[signalIndex]
  if (signalSession === undefined) throw new Error('risk-balanced trend signal session is missing')
  const historySessions = requiredHistory(protocol)
  const history = sessions.slice(signalIndex - historySessions, signalIndex + 1)
  return makeRiskBalancedTrendDecision(
    signalSession.date,
    history.map((session) => session.date),
    Object.fromEntries(
      protocol.universe.map((symbol) => [symbol, history.map((session) => session.bars[symbol].close)]),
    ),
    protocol,
  )
}

export interface CurrentRiskBalancedTrendDecision {
  readonly decision: DecisionPlan
  readonly priceMicros: Readonly<Record<string, string>>
}

export type CurrentDecisionCycleBinding = ExecutionSessionBinding
const decodeCurrentDecisionCycleBinding = Schema.decodeUnknownSync(ExecutionSessionBindingSchema, strictParseOptions)

export const compileCurrentRiskBalancedTrendDecision = (
  bars: readonly DailyBar[],
  inputManifest: InputManifest,
  protocol: Protocol,
  cycleBinding: CurrentDecisionCycleBinding,
): CurrentRiskBalancedTrendDecision => {
  const binding = decodeCurrentDecisionCycleBinding(cycleBinding)
  const sessions = alignBars(bars, protocol.universe, inputManifest)
  const signalIndex = sessions.length - 1
  const terminalSession = sessions[signalIndex]
  if (
    terminalSession === undefined ||
    terminalSession.date !== inputManifest.finalizedSnapshot.lastSession ||
    terminalSession.date !== inputManifest.lastSession ||
    terminalSession.date !== binding.signal.sessionDate
  ) {
    throw new Error('current strategy decision must end on the due cycle Signal terminal session')
  }
  if (
    protocol.rebalance === 'month-end' &&
    binding.signal.sessionDate.slice(0, 7) === binding.executionSession.date.slice(0, 7)
  ) {
    throw new Error('current strategy decision requires a month-end due cycle')
  }
  const decision = decisionFromAlignedSessions(sessions, signalIndex, protocol)
  const priceMicros = Object.fromEntries(
    protocol.universe.map((symbol) => [
      symbol,
      referencePriceMicros(terminalSession.bars[symbol].close, protocol.executionModel).toString(),
    ]),
  )
  const priceSymbols = Object.keys(priceMicros)
  if (
    decision.signalDate !== terminalSession.date ||
    priceSymbols.length !== protocol.universe.length ||
    protocol.universe.some(
      (symbol) => !Object.hasOwn(priceMicros, symbol) || !/^[1-9][0-9]*$/.test(priceMicros[symbol]),
    )
  ) {
    throw new Error('current strategy decision and terminal closes do not cover one compiled universe session')
  }
  return { decision, priceMicros }
}

export interface QualificationPrecommit {
  readonly candidateRunId: string
  readonly protocolHash: string
  readonly selectedSessionCount: number
  readonly selectedRebalanceCount: number
  readonly signalDates: readonly IsoDate[]
  readonly executionDates: readonly IsoDate[]
}

export const prepareRiskBalancedTrendQualification = (
  sessionDates: readonly IsoDate[],
  inputManifest: InputManifest,
  protocol: Protocol,
  provenance: RuntimeProvenance,
): QualificationPrecommit => {
  const { runId, protocolHash } = makeEvaluationIdentity(inputManifest, protocol, provenance)
  const window = selectEvaluationWindow(
    sessionDates,
    inputManifest,
    requiredHistory(protocol),
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

export interface RiskBalancedTrendCompatibilityFailure {
  readonly _tag: 'RiskBalancedTrendCompatibilityFailure'
  readonly phase: 'finalize' | 'prepare'
  readonly cause: unknown
}

export type RiskBalancedTrendEvaluationIssue = SimulationReconciliationIssue | RiskBalancedTrendCompatibilityFailure

interface PreparedEvaluation {
  readonly runId: string
  readonly protocolHash: string
  readonly strategy: ReturnType<typeof simulate>
  readonly buyAndHold: ReturnType<typeof simulate>
  readonly directVolTiming: ReturnType<typeof simulate>
  readonly doubleCost: ReturnType<typeof simulate>
  readonly simulation: NonNullable<ReturnType<typeof simulate>['simulation']>
  readonly signalDecisions: readonly SignalDecision[]
}

// PROOMPT-419 owns replacing this compatibility boundary with total strategy and simulation functions.
const prepareEvaluation = (
  bars: readonly DailyBar[],
  inputManifest: InputManifest,
  protocol: Protocol,
  provenance: RuntimeProvenance,
): PreparedEvaluation => {
  const { runId, protocolHash } = makeEvaluationIdentity(inputManifest, protocol, provenance)
  const sessions = alignBars(bars, protocol.universe, inputManifest)
  const sessionDates = sessions.map((session) => session.date)
  const window = selectEvaluationWindow(
    sessionDates,
    inputManifest,
    requiredHistory(protocol),
    protocol.thresholds.minimumObservations,
  )
  const evaluationSessions = sessions.slice(0, window.evaluationEndExclusive)
  const strategyTargets: SimulationTarget[] = window.signalIndices.map((signalIndex) => {
    const decision = decisionFromAlignedSessions(sessions, signalIndex, protocol)
    return { signalIndex, executionIndex: signalIndex + 1, weights: decision.targetWeights, decision }
  })
  const equalWeight = roundWeight(1 / protocol.universe.length)
  const buyAndHoldTargets: SimulationTarget[] = [
    {
      signalIndex: window.startIndex - 1,
      executionIndex: window.startIndex,
      weights: Object.fromEntries(protocol.universe.map((symbol) => [symbol, equalWeight])),
    },
  ]
  const directVolTargets: SimulationTarget[] = window.signalIndices.map((signalIndex) => ({
    signalIndex,
    executionIndex: signalIndex + 1,
    weights: directVolatilityWeights(sessions, signalIndex, protocol),
  }))
  const strategy = simulate(evaluationSessions, strategyTargets, window.startIndex, protocol, MICROS, runId, true)
  const buyAndHold = simulate(evaluationSessions, buyAndHoldTargets, window.startIndex, protocol, MICROS, runId, false)
  const directVolTiming = simulate(
    evaluationSessions,
    directVolTargets,
    window.startIndex,
    protocol,
    MICROS,
    runId,
    false,
  )
  const doubleCost = simulate(
    evaluationSessions,
    strategyTargets,
    window.startIndex,
    protocol,
    BigInt(protocol.executionModel.doubleCostMultiplier) * MICROS,
    runId,
    false,
  )
  if (strategy.simulation === null) throw new Error('candidate simulation did not retain its evidence trace')
  const signalDecisions = strategy.signalDecisions.map((decision) => {
    if (decision.schemaVersion !== ContractVersion.DecisionPlan) {
      throw new Error('risk-balanced trend simulation retained a decision from another strategy')
    }
    return decision
  })
  return {
    runId,
    protocolHash,
    strategy,
    buyAndHold,
    directVolTiming,
    doubleCost,
    simulation: strategy.simulation,
    signalDecisions,
  }
}

export const riskBalancedTrendCompatibilityFailure = (
  phase: RiskBalancedTrendCompatibilityFailure['phase'],
  cause: unknown,
): readonly RiskBalancedTrendEvaluationIssue[] =>
  Object.freeze([Object.freeze({ _tag: 'RiskBalancedTrendCompatibilityFailure' as const, phase, cause })])

const renderCompatibilityCause = (cause: unknown): string => {
  const rendered = Result.try({
    try: () => String(cause instanceof Error ? cause.message : cause),
    catch: () => undefined,
  })
  return Result.isSuccess(rendered) ? rendered.success : 'unrenderable cause'
}

export const renderRiskBalancedTrendEvaluationIssues = (issues: readonly RiskBalancedTrendEvaluationIssue[]): string =>
  issues
    .map((issue) => {
      if (issue._tag === 'RiskBalancedTrendCompatibilityFailure') return renderCompatibilityCause(issue.cause)
      return renderSimulationReconciliationIssue(issue)
    })
    .join('; ')

export const evaluateRiskBalancedTrend = (
  bars: readonly DailyBar[],
  inputManifest: InputManifest,
  protocol: Protocol,
  provenance: RuntimeProvenance,
): Result.Result<EvaluationResult, readonly RiskBalancedTrendEvaluationIssue[]> => {
  const prepared = Result.try({
    try: () => prepareEvaluation(bars, inputManifest, protocol, provenance),
    catch: (cause) => riskBalancedTrendCompatibilityFailure('prepare', cause),
  })
  if (Result.isFailure(prepared)) return Result.fail(prepared.failure)
  const markedEquity = reconcileMarkedEquity({
    runId: prepared.success.runId,
    initialCapitalMicros: protocol.initialCapitalMicros,
    evaluatorTotalFeesMicros: prepared.success.strategy.metrics.totalFeesMicros,
    evaluatorEndingEquityMicros: prepared.success.strategy.metrics.endingEquityMicros,
    events: prepared.success.strategy.events,
    simulation: prepared.success.simulation,
  })
  if (Result.isFailure(markedEquity)) return Result.fail(markedEquity.failure)

  return Result.try({
    try: (): EvaluationResult => ({
      schemaVersion: ContractVersion.Evaluation,
      runId: prepared.success.runId,
      codeRevision: provenance.sourceRevision,
      protocolHash: prepared.success.protocolHash,
      initialCapitalMicros: protocol.initialCapitalMicros,
      inputManifest,
      strategy: prepared.success.strategy.metrics,
      buyAndHold: prepared.success.buyAndHold.metrics,
      directVolTiming: prepared.success.directVolTiming.metrics,
      doubleCostStrategy: prepared.success.doubleCost.metrics,
      verdict: buildVerdict(
        prepared.success.strategy.metrics,
        prepared.success.buyAndHold.metrics,
        prepared.success.directVolTiming.metrics,
        prepared.success.doubleCost.metrics,
        protocol,
      ),
      events: prepared.success.strategy.events,
      signalDecisions: prepared.success.signalDecisions,
      simulation: prepared.success.simulation,
      benchmarkSeries: {
        buyAndHold: prepared.success.buyAndHold.dailyPerformance,
        directVolTiming: prepared.success.directVolTiming.dailyPerformance,
        doubleCostStrategy: prepared.success.doubleCost.dailyPerformance,
      },
      equitySeries: markedEquity.success.equitySeries,
      markedEquityReconciliation: markedEquity.success.reconciliation,
    }),
    catch: (cause) => riskBalancedTrendCompatibilityFailure('finalize', cause),
  })
}

export const summarizeEvaluation = (evaluation: EvaluationResult): EvaluationSummary => ({
  schemaVersion: ContractVersion.EvaluationSummary,
  evaluationSchemaVersion: ContractVersion.Evaluation,
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
})
