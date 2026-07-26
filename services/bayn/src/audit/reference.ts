import { pipe, Result } from 'effect'

import { makeRunIdentity, makeStrategyProtocolHash, type RuntimeProvenance } from '../contracts'
import {
  MICROS,
  accrueCashYield,
  calculateSessionFees,
  desiredQuantityMicros,
  elapsedCalendarDays,
  makeFillTerms,
  makeOrderOutcome,
  microsToNumber,
  notionalMicros,
  ppm,
  referencePriceMicros,
  saleCostBasisMicros,
  scaleQuantityMicros,
  type ExecutionModelFailure,
  type FeeInput,
  type FillTerms,
} from '../execution-model'
import { canonicalHashV1 } from '../hash'
import type {
  CashChange,
  DailyBar,
  DailyPerformancePoint,
  DailyPositionMark,
  DecisionEvent,
  EconomicVerdict,
  EvaluationEvent,
  FeeEvent,
  FillEvent,
  GateResult,
  InputManifest,
  IsoDate,
  PerformanceMetrics,
  DecisionPlan,
  Protocol,
  SignalDecision,
  SimulatedOrder,
  SimulationProtocol,
  SimulationTrace,
} from '../types'

interface Session {
  readonly date: IsoDate
  readonly bars: Readonly<Record<string, DailyBar>>
}

interface Target {
  readonly signalIndex: number
  readonly executionIndex: number
  readonly weights: Readonly<Record<string, number>>
  readonly plan?: DecisionPlan
}

interface Position {
  readonly quantityMicros: bigint
  readonly costBasisMicros: bigint
}

export interface ReferenceReplayWork {
  readonly sessionsProcessed: number
  readonly positionStateCopies: number
  readonly positionWrites: number
}

interface Replay {
  readonly metrics: PerformanceMetrics
  readonly events: readonly EvaluationEvent[]
  readonly decisions: readonly SignalDecision[]
  readonly daily: readonly DailyPerformancePoint[]
  readonly trace: SimulationTrace | null
}

interface ReplayWithWork extends Replay {
  readonly work: ReferenceReplayWork
}

export interface ReferenceEvaluation {
  readonly runId: string
  readonly protocolHash: string
  readonly strategy: Replay
  readonly buyAndHold: Replay
  readonly directVolTiming: Replay
  readonly doubleCostStrategy: Replay
  readonly verdict: EconomicVerdict
}

export interface ReferenceEvaluationWork {
  readonly strategy: ReferenceReplayWork
  readonly buyAndHold: ReferenceReplayWork
  readonly directVolTiming: ReferenceReplayWork
  readonly doubleCostStrategy: ReferenceReplayWork
}

interface ReferenceEvaluationWithWork {
  readonly runId: string
  readonly protocolHash: string
  readonly strategy: ReplayWithWork
  readonly buyAndHold: ReplayWithWork
  readonly directVolTiming: ReplayWithWork
  readonly doubleCostStrategy: ReplayWithWork
  readonly verdict: EconomicVerdict
}

export type ReferenceEvaluationFailure =
  | ExecutionModelFailure
  | {
      readonly _tag: 'UnsupportedReferenceExecutionModel'
      readonly actual: string
      readonly required: 'bayn.execution-model.v2'
    }
  | {
      readonly _tag: 'ReferenceInputRowCountMismatch'
      readonly expected: number
      readonly actual: number
    }
  | {
      readonly _tag: 'ReferenceUnexpectedSymbol'
      readonly symbol: string
      readonly sessionDate: IsoDate
      readonly universe: readonly string[]
    }
  | {
      readonly _tag: 'ReferenceDuplicateBar'
      readonly symbol: string
      readonly sessionDate: IsoDate
    }
  | {
      readonly _tag: 'ReferenceIncompleteSession'
      readonly sessionDate: IsoDate
      readonly missingSymbols: readonly string[]
      readonly actualSymbolCount: number
      readonly expectedSymbolCount: number
    }
  | {
      readonly _tag: 'ReferenceManifestSessionMismatch'
      readonly expectedSessionCount: number
      readonly actualSessionCount: number
      readonly expectedFirstSession: IsoDate
      readonly actualFirstSession: IsoDate | null
      readonly expectedLastSession: IsoDate
      readonly actualLastSession: IsoDate | null
    }
  | {
      readonly _tag: 'ReferenceInvalidWeight'
      readonly symbol: string
      readonly weight: number
      readonly maximumWeight: number
    }
  | {
      readonly _tag: 'ReferenceWeightBoundingFailed'
      readonly totalUnits: number
      readonly excessUnits: number
      readonly weightScale: number
    }
  | {
      readonly _tag: 'ReferenceCovarianceInputMismatch'
      readonly leftLength: number
      readonly rightLength: number
    }
  | {
      readonly _tag: 'ReferenceCovarianceNotFinite'
      readonly leftLength: number
      readonly rightLength: number
      readonly covariance: number
    }
  | {
      readonly _tag: 'ReferencePortfolioVarianceInvalid'
      readonly dailyVariance: number
    }
  | {
      readonly _tag: 'ReferencePortfolioVolatilityInvalid'
      readonly dailyVariance: number
      readonly annualizedVolatility: number
    }
  | {
      readonly _tag: 'ReferenceInsufficientHistory'
      readonly signalIndex: number
      readonly requiredHistory: number
      readonly sessionCount: number
    }
  | {
      readonly _tag: 'ReferenceInvalidClose'
      readonly symbol: string
      readonly sessionDate: IsoDate
      readonly close: number
    }
  | {
      readonly _tag: 'ReferenceMissingCurrentClose'
      readonly symbol: string
      readonly signalIndex: number
    }
  | {
      readonly _tag: 'ReferenceInvalidReturn'
      readonly symbol: string
      readonly sessionDate: IsoDate
      readonly value: number
    }
  | {
      readonly _tag: 'ReferenceMissingPriorClose'
      readonly symbol: string
      readonly signalIndex: number
      readonly horizonSessions: number
    }
  | {
      readonly _tag: 'ReferenceInvalidHorizonSignal'
      readonly symbol: string
      readonly horizonSessions: number
      readonly return: number
      readonly normalizedTrend: number
    }
  | {
      readonly _tag: 'ReferenceInvalidScore'
      readonly symbol: string
      readonly annualizedVolatility: number
      readonly compositeScore: number
    }
  | {
      readonly _tag: 'ReferenceWeightsOutsideLimits'
      readonly totalWeight: number
      readonly maximumSymbolWeight: number
      readonly portfolioVolatility: number
      readonly maximumPortfolioVolatility: number
    }
  | {
      readonly _tag: 'ReferenceDirectVolatilityWindowInvalid'
      readonly signalIndex: number
      readonly requiredPriorIndex: number
      readonly sessionCount: number
    }
  | {
      readonly _tag: 'ReferenceInvalidEquityCurve'
      readonly observationCount: number
      readonly firstNonPositiveIndex: number | null
      readonly firstNonPositiveValueMicros: string | null
    }
  | {
      readonly _tag: 'ReferenceBuyFillRestrictionInvalid'
      readonly orderId: string
      readonly modeledQuantityMicros: string
      readonly permittedQuantityMicros: string
    }
  | {
      readonly _tag: 'ReferenceMissingDecisionPlan'
      readonly signalIndex: number
      readonly executionIndex: number
    }
  | {
      readonly _tag: 'ReferenceTargetSignalMissing'
      readonly signalIndex: number
      readonly executionIndex: number
      readonly sessionCount: number
    }
  | {
      readonly _tag: 'ReferenceNegativeCash'
      readonly sessionDate: IsoDate
      readonly cashMicros: string
    }
  | {
      readonly _tag: 'ReferenceNoEligibleSignal'
      readonly sessionCount: number
      readonly lookbackStart: IsoDate
      readonly evaluationStart: IsoDate
      readonly evaluationEnd: IsoDate
    }
  | {
      readonly _tag: 'ReferenceInsufficientObservations'
      readonly actual: number
      readonly required: number
      readonly startIndex: number
      readonly endExclusive: number
    }
  | {
      readonly _tag: 'ReferenceProvenanceMismatch'
      readonly requiredStrategyName: 'risk-balanced-trend'
      readonly actualStrategyName: string
      readonly expectedParameterHash: string
      readonly actualParameterHash: string
    }

type ReferenceComputation<A> = Result.Result<A, ReferenceEvaluationFailure>

const tradingDays = 252

const roundWeight = (value: number): number => Number.parseFloat(value.toFixed(12))

const average = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length

const sampleDeviation = (values: readonly number[]): number => {
  if (values.length < 2) return 0
  const center = average(values)
  const variance = values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

const align = (
  bars: readonly DailyBar[],
  manifest: InputManifest,
  universe: readonly string[],
): ReferenceComputation<readonly Session[]> => {
  if (bars.length !== manifest.rowCount) {
    return Result.fail({
      _tag: 'ReferenceInputRowCountMismatch',
      expected: manifest.rowCount,
      actual: bars.length,
    })
  }
  const expected = new Set(universe)
  const grouped = new Map<IsoDate, Map<string, DailyBar>>()
  for (const bar of bars) {
    if (!expected.has(bar.symbol)) {
      return Result.fail({
        _tag: 'ReferenceUnexpectedSymbol',
        symbol: bar.symbol,
        sessionDate: bar.sessionDate,
        universe,
      })
    }
    const day = grouped.get(bar.sessionDate) ?? new Map<string, DailyBar>()
    if (day.has(bar.symbol)) {
      return Result.fail({ _tag: 'ReferenceDuplicateBar', symbol: bar.symbol, sessionDate: bar.sessionDate })
    }
    day.set(bar.symbol, bar)
    grouped.set(bar.sessionDate, day)
  }
  const sessions: Session[] = []
  for (const [date, day] of [...grouped.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const missingSymbols = universe.filter((symbol) => !day.has(symbol))
    if (day.size !== universe.length || missingSymbols.length > 0) {
      return Result.fail({
        _tag: 'ReferenceIncompleteSession',
        sessionDate: date,
        missingSymbols,
        actualSymbolCount: day.size,
        expectedSymbolCount: universe.length,
      })
    }
    const sessionBars: Record<string, DailyBar> = {}
    for (const symbol of universe) {
      const bar = day.get(symbol)
      if (bar === undefined) {
        return Result.fail({
          _tag: 'ReferenceIncompleteSession',
          sessionDate: date,
          missingSymbols: [symbol],
          actualSymbolCount: day.size,
          expectedSymbolCount: universe.length,
        })
      }
      sessionBars[symbol] = bar
    }
    sessions.push({ date, bars: sessionBars })
  }
  if (
    sessions.length !== manifest.sessionCount ||
    sessions[0]?.date !== manifest.firstSession ||
    sessions.at(-1)?.date !== manifest.lastSession
  ) {
    return Result.fail({
      _tag: 'ReferenceManifestSessionMismatch',
      expectedSessionCount: manifest.sessionCount,
      actualSessionCount: sessions.length,
      expectedFirstSession: manifest.firstSession,
      actualFirstSession: sessions[0]?.date ?? null,
      expectedLastSession: manifest.lastSession,
      actualLastSession: sessions.at(-1)?.date ?? null,
    })
  }
  return Result.succeed(sessions)
}

const monthEnds = (dates: readonly IsoDate[]): readonly number[] => {
  const result: number[] = []
  for (let index = 0; index < dates.length - 1; index += 1) {
    if (dates[index].slice(0, 7) !== dates[index + 1].slice(0, 7)) result.push(index)
  }
  return result
}

const riskBalancedHistoryLength = (protocol: Pick<Protocol, 'volatilityWindow' | 'horizons'>): number =>
  Math.max(protocol.volatilityWindow, ...protocol.horizons)

const allocateCapped = (
  scores: Readonly<Record<string, number>>,
  maximumWeight: number,
): Readonly<Record<string, number>> => {
  const weights: Record<string, number> = Object.fromEntries(
    Object.keys(scores)
      .sort()
      .map((symbol) => [symbol, 0]),
  )
  let unallocated = 1
  let available = Object.keys(scores)
    .filter((symbol) => scores[symbol] > 0)
    .sort()

  while (available.length > 0 && unallocated > 0) {
    const availableScore = available.reduce((total, symbol) => total + scores[symbol], 0)
    if (!Number.isFinite(availableScore) || availableScore <= 0) break
    const exceedsCap = available.filter((symbol) => (unallocated * scores[symbol]) / availableScore > maximumWeight)
    if (exceedsCap.length === 0) {
      for (const symbol of available) weights[symbol] = (unallocated * scores[symbol]) / availableScore
      break
    }
    for (const symbol of exceedsCap) {
      weights[symbol] = maximumWeight
      unallocated = Math.max(0, unallocated - maximumWeight)
    }
    const allocated = new Set(exceedsCap)
    available = available.filter((symbol) => !allocated.has(symbol))
  }

  return weights
}

const weightScale = 1_000_000_000_000

const quantizeCappedWeights = (
  weights: Readonly<Record<string, number>>,
  maximumWeight: number,
): ReferenceComputation<Readonly<Record<string, number>>> => {
  const maximumUnits = Math.floor(maximumWeight * weightScale + Number.EPSILON)
  const units: Record<string, number> = {}
  for (const symbol of Object.keys(weights).sort()) {
    const weight = weights[symbol]
    if (!Number.isFinite(weight) || weight < 0) {
      return Result.fail({ _tag: 'ReferenceInvalidWeight', symbol, weight, maximumWeight })
    }
    units[symbol] = Math.min(maximumUnits, Math.max(0, Math.round(weight * weightScale)))
  }
  let total = Object.values(units).reduce((sum, value) => sum + value, 0)
  let excess = Math.max(0, total - weightScale)
  for (const symbol of Object.keys(units).sort().reverse()) {
    if (excess === 0) break
    const reduction = Math.min(units[symbol], excess)
    units[symbol] -= reduction
    excess -= reduction
    total -= reduction
  }
  if (total > weightScale || excess > 0) {
    return Result.fail({ _tag: 'ReferenceWeightBoundingFailed', totalUnits: total, excessUnits: excess, weightScale })
  }
  return Result.succeed(
    Object.fromEntries(Object.entries(units).map(([symbol, value]) => [symbol, value / weightScale])),
  )
}

const sampleCovariance = (left: readonly number[], right: readonly number[]): ReferenceComputation<number> => {
  if (left.length !== right.length || left.length < 2) {
    return Result.fail({ _tag: 'ReferenceCovarianceInputMismatch', leftLength: left.length, rightLength: right.length })
  }
  const leftAverage = average(left)
  const rightAverage = average(right)
  const value =
    left.reduce((total, observation, index) => total + (observation - leftAverage) * (right[index] - rightAverage), 0) /
    (left.length - 1)
  if (!Number.isFinite(value)) {
    return Result.fail({
      _tag: 'ReferenceCovarianceNotFinite',
      leftLength: left.length,
      rightLength: right.length,
      covariance: value,
    })
  }
  return Result.succeed(value)
}

const portfolioVolatility = (
  weights: Readonly<Record<string, number>>,
  returns: Readonly<Record<string, readonly number[]>>,
): ReferenceComputation<number> => {
  const symbols = Object.keys(weights).sort()
  let dailyVariance = 0
  for (const left of symbols) {
    let innerVariance = 0
    for (const right of symbols) {
      const covariance = sampleCovariance(returns[left], returns[right])
      if (Result.isFailure(covariance)) return covariance
      innerVariance += weights[left] * weights[right] * covariance.success
    }
    dailyVariance += innerVariance
  }
  if (!Number.isFinite(dailyVariance) || dailyVariance < -1e-12) {
    return Result.fail({ _tag: 'ReferencePortfolioVarianceInvalid', dailyVariance })
  }
  const annualized = Math.sqrt(Math.max(0, dailyVariance) * tradingDays)
  if (!Number.isFinite(annualized)) {
    return Result.fail({
      _tag: 'ReferencePortfolioVolatilityInvalid',
      dailyVariance,
      annualizedVolatility: annualized,
    })
  }
  return Result.succeed(annualized)
}

const riskBalancedDecisionPlan = (
  signalIndex: number,
  sessions: readonly Session[],
  protocol: Protocol,
): ReferenceComputation<DecisionPlan> => {
  const requiredHistory = riskBalancedHistoryLength(protocol)
  if (signalIndex < requiredHistory || signalIndex >= sessions.length) {
    return Result.fail({
      _tag: 'ReferenceInsufficientHistory',
      signalIndex,
      requiredHistory,
      sessionCount: sessions.length,
    })
  }
  const history = sessions.slice(signalIndex - requiredHistory, signalIndex + 1)
  const sessionDates = history.map((session) => session.date)
  const returnsBySymbol: Record<string, readonly number[]> = {}
  const baseSignals: DecisionPlan['signals'][number][] = []
  for (const symbol of protocol.universe) {
    const closes = history.map((session) => session.bars[symbol].close)
    const invalidCloseIndex = closes.findIndex((close) => !Number.isFinite(close) || close <= 0)
    if (invalidCloseIndex !== -1) {
      return Result.fail({
        _tag: 'ReferenceInvalidClose',
        symbol,
        sessionDate: history[invalidCloseIndex].date,
        close: closes[invalidCloseIndex],
      })
    }
    const current = closes.at(-1)
    if (current === undefined) {
      return Result.fail({ _tag: 'ReferenceMissingCurrentClose', symbol, signalIndex })
    }
    const volatilityCloses = closes.slice(-(protocol.volatilityWindow + 1))
    const recentReturns = volatilityCloses.slice(1).map((close, index) => close / volatilityCloses[index] - 1)
    const invalidReturnIndex = recentReturns.findIndex((value) => !Number.isFinite(value))
    if (invalidReturnIndex !== -1) {
      const firstVolatilitySessionIndex = history.length - volatilityCloses.length
      return Result.fail({
        _tag: 'ReferenceInvalidReturn',
        symbol,
        sessionDate: history[firstVolatilitySessionIndex + invalidReturnIndex + 1].date,
        value: recentReturns[invalidReturnIndex],
      })
    }
    returnsBySymbol[symbol] = recentReturns
    const dailyVolatility = sampleDeviation(recentReturns)
    const annualizedVolatility = dailyVolatility * Math.sqrt(tradingDays)
    const horizons: DecisionPlan['signals'][number]['horizons'][number][] = []
    for (const horizonSessions of protocol.horizons) {
      const prior = closes[closes.length - 1 - horizonSessions]
      if (prior === undefined) {
        return Result.fail({ _tag: 'ReferenceMissingPriorClose', symbol, signalIndex, horizonSessions })
      }
      const value = current / prior - 1
      const normalizedTrend = dailyVolatility === 0 ? 0 : value / (dailyVolatility * Math.sqrt(horizonSessions))
      if (![value, normalizedTrend].every(Number.isFinite)) {
        return Result.fail({
          _tag: 'ReferenceInvalidHorizonSignal',
          symbol,
          horizonSessions,
          return: value,
          normalizedTrend,
        })
      }
      horizons.push({ horizonSessions, return: value, normalizedTrend })
    }
    const compositeScore = dailyVolatility === 0 ? 0 : average(horizons.map((horizon) => horizon.normalizedTrend))
    if (![annualizedVolatility, compositeScore].every(Number.isFinite)) {
      return Result.fail({
        _tag: 'ReferenceInvalidScore',
        symbol,
        annualizedVolatility,
        compositeScore,
      })
    }
    baseSignals.push({
      symbol,
      horizons,
      dailyVolatility,
      annualizedVolatility,
      compositeScore,
      positiveScore: Math.max(0, compositeScore),
      eligible: dailyVolatility > 0,
      uncappedWeight: 0,
      cappedWeight: 0,
      targetWeight: 0,
    })
  }

  const scores = Object.fromEntries(baseSignals.map((signal) => [signal.symbol, signal.positiveScore]))
  const scoreTotal = Object.values(scores).reduce((total, score) => total + score, 0)
  const uncappedWeights = Object.fromEntries(
    protocol.universe.map((symbol) => [symbol, scoreTotal === 0 ? 0 : scores[symbol] / scoreTotal]),
  )
  const cappedWeightsResult = quantizeCappedWeights(
    allocateCapped(scores, protocol.maximumSymbolWeight),
    protocol.maximumSymbolWeight,
  )
  if (Result.isFailure(cappedWeightsResult)) return Result.fail(cappedWeightsResult.failure)
  const cappedWeights = cappedWeightsResult.success
  const estimatedVolatilityResult = portfolioVolatility(cappedWeights, returnsBySymbol)
  if (Result.isFailure(estimatedVolatilityResult)) return Result.fail(estimatedVolatilityResult.failure)
  const estimatedAnnualizedPortfolioVolatility = estimatedVolatilityResult.success
  const exposureScale =
    estimatedAnnualizedPortfolioVolatility === 0
      ? 1
      : Math.min(1, protocol.maximumPortfolioVolatility / estimatedAnnualizedPortfolioVolatility)
  const targetWeightsResult = quantizeCappedWeights(
    Object.fromEntries(protocol.universe.map((symbol) => [symbol, cappedWeights[symbol] * exposureScale])),
    protocol.maximumSymbolWeight,
  )
  if (Result.isFailure(targetWeightsResult)) return Result.fail(targetWeightsResult.failure)
  let targetWeights = targetWeightsResult.success
  const scaledVolatilityResult = portfolioVolatility(targetWeights, returnsBySymbol)
  if (Result.isFailure(scaledVolatilityResult)) return Result.fail(scaledVolatilityResult.failure)
  const scaledVolatility = scaledVolatilityResult.success
  if (scaledVolatility > protocol.maximumPortfolioVolatility) {
    const correction = protocol.maximumPortfolioVolatility / scaledVolatility
    targetWeights = Object.fromEntries(
      Object.entries(targetWeights).map(([symbol, weight]) => [
        symbol,
        Math.floor(weight * correction * weightScale) / weightScale,
      ]),
    )
  }
  const totalWeight = Object.values(targetWeights).reduce((total, weight) => total + weight, 0)
  const finalVolatilityResult = portfolioVolatility(targetWeights, returnsBySymbol)
  if (Result.isFailure(finalVolatilityResult)) return Result.fail(finalVolatilityResult.failure)
  const finalVolatility = finalVolatilityResult.success
  if (
    totalWeight > 1 + 1e-12 ||
    Object.values(targetWeights).some(
      (weight) => !Number.isFinite(weight) || weight < 0 || weight > protocol.maximumSymbolWeight + 1e-12,
    ) ||
    finalVolatility > protocol.maximumPortfolioVolatility + 1e-12
  ) {
    return Result.fail({
      _tag: 'ReferenceWeightsOutsideLimits',
      totalWeight,
      maximumSymbolWeight: protocol.maximumSymbolWeight,
      portfolioVolatility: finalVolatility,
      maximumPortfolioVolatility: protocol.maximumPortfolioVolatility,
    })
  }

  const covarianceDates = sessionDates.slice(-protocol.volatilityWindow)
  const signalSession = sessions[signalIndex]
  const firstCovarianceSession = covarianceDates[0]
  if (signalSession === undefined || firstCovarianceSession === undefined) {
    return Result.fail({
      _tag: 'ReferenceInsufficientHistory',
      signalIndex,
      requiredHistory,
      sessionCount: sessions.length,
    })
  }
  return Result.succeed({
    schemaVersion: 'bayn.risk-balanced-trend-decision-plan.v1',
    signalDate: signalSession.date,
    covarianceWindow: {
      returnCount: protocol.volatilityWindow,
      firstSession: firstCovarianceSession,
      lastSession: covarianceDates.at(-1) ?? signalSession.date,
      sessionsHash: canonicalHashV1(covarianceDates),
    },
    estimatedAnnualizedPortfolioVolatility,
    exposureScale,
    targetWeights,
    signals: baseSignals.map((signal) => ({
      ...signal,
      uncappedWeight: roundWeight(uncappedWeights[signal.symbol]),
      cappedWeight: cappedWeights[signal.symbol],
      targetWeight: targetWeights[signal.symbol],
    })),
  })
}

const directVolatilityTarget = (
  sessions: readonly Session[],
  signalIndex: number,
  protocol: SimulationProtocol,
): ReferenceComputation<Readonly<Record<string, number>>> => {
  if (signalIndex < 63 || signalIndex >= sessions.length) {
    return Result.fail({
      _tag: 'ReferenceDirectVolatilityWindowInvalid',
      signalIndex,
      requiredPriorIndex: signalIndex - 63,
      sessionCount: sessions.length,
    })
  }
  const portfolioReturns: number[] = []
  for (let index = signalIndex - 62; index <= signalIndex; index += 1) {
    const session = sessions[index]
    const priorSession = sessions[index - 1]
    if (session === undefined || priorSession === undefined) {
      return Result.fail({
        _tag: 'ReferenceDirectVolatilityWindowInvalid',
        signalIndex,
        requiredPriorIndex: index - 1,
        sessionCount: sessions.length,
      })
    }
    const returns = protocol.universe.map((symbol) => session.bars[symbol].close / priorSession.bars[symbol].close - 1)
    const invalidReturnIndex = returns.findIndex((value) => !Number.isFinite(value))
    if (invalidReturnIndex !== -1) {
      return Result.fail({
        _tag: 'ReferenceInvalidReturn',
        symbol: protocol.universe[invalidReturnIndex],
        sessionDate: session.date,
        value: returns[invalidReturnIndex],
      })
    }
    portfolioReturns.push(average(returns))
  }
  const volatility = sampleDeviation(portfolioReturns) * Math.sqrt(tradingDays)
  const exposure = volatility <= 0 ? 0 : Math.min(1, protocol.directVolatilityTarget / volatility)
  const weight = roundWeight(exposure / protocol.universe.length)
  return Result.succeed(Object.fromEntries(protocol.universe.map((symbol) => [symbol, weight])))
}

const metrics = (
  equityMicros: readonly bigint[],
  turnoverMicros: bigint,
  feeMicros: bigint,
  spreadMicros: bigint,
  slippageMicros: bigint,
  yieldMicros: bigint,
  initialMicros: bigint,
): ReferenceComputation<PerformanceMetrics> => {
  const firstNonPositiveIndex = equityMicros.findIndex((value) => value <= 0n)
  if (equityMicros.length < 2 || firstNonPositiveIndex !== -1) {
    return Result.fail({
      _tag: 'ReferenceInvalidEquityCurve',
      observationCount: equityMicros.length,
      firstNonPositiveIndex: firstNonPositiveIndex === -1 ? null : firstNonPositiveIndex,
      firstNonPositiveValueMicros:
        firstNonPositiveIndex === -1 ? null : (equityMicros[firstNonPositiveIndex]?.toString() ?? null),
    })
  }
  const endingEquityMicros = equityMicros.at(-1)
  if (endingEquityMicros === undefined) {
    return Result.fail({
      _tag: 'ReferenceInvalidEquityCurve',
      observationCount: equityMicros.length,
      firstNonPositiveIndex: null,
      firstNonPositiveValueMicros: null,
    })
  }
  const equity = equityMicros.map(microsToNumber)
  const initial = microsToNumber(initialMicros)
  const endingEquity = microsToNumber(endingEquityMicros)
  const returns = equity.map((value, index) => value / (index === 0 ? initial : equity[index - 1]) - 1)
  const totalReturn = endingEquity / initial - 1
  const annualizedReturn = Math.pow(endingEquity / initial, tradingDays / equity.length) - 1
  const annualizedVolatility = sampleDeviation(returns) * Math.sqrt(tradingDays)
  const sharpe = annualizedVolatility === 0 ? 0 : (average(returns) * tradingDays) / annualizedVolatility
  let peak = initial
  let maximumDrawdown = 0
  for (const value of equity) {
    peak = Math.max(peak, value)
    maximumDrawdown = Math.max(maximumDrawdown, 1 - value / peak)
  }
  return Result.succeed({
    observations: equity.length,
    totalReturn,
    annualizedReturn,
    annualizedVolatility,
    sharpe,
    maximumDrawdown,
    annualTurnover: microsToNumber(turnoverMicros) / initial / (equity.length / tradingDays),
    totalFeesMicros: feeMicros.toString(),
    totalSpreadCostMicros: spreadMicros.toString(),
    totalSlippageCostMicros: slippageMicros.toString(),
    totalCashYieldMicros: yieldMicros.toString(),
    endingEquityMicros: endingEquityMicros.toString(),
  })
}

const order = (
  runId: string,
  decision: DecisionEvent,
  sessionDate: IsoDate,
  symbol: string,
  side: 'buy' | 'sell',
  requestedQuantityMicros: bigint,
  referencePrice: bigint,
  protocol: SimulationProtocol,
): ReferenceComputation<SimulatedOrder> =>
  pipe(
    makeOrderOutcome({
      identity: {
        schemaVersion: 'bayn.partial-fill-seed.v1',
        signalDate: decision.signalDate,
        executionDate: decision.executionDate,
        symbol,
        side,
      },
      side,
      requestedQuantityMicros,
      referencePriceMicros: referencePrice,
      model: protocol.executionModel,
    }),
    Result.map((outcome) => {
      const material = {
        decisionId: decision.id,
        sessionDate,
        symbol,
        side,
        requestedQuantityMicros: outcome.requestedQuantityMicros.toString(),
        filledQuantityMicros: outcome.filledQuantityMicros.toString(),
        status: outcome.status,
        rejectionReason: outcome.rejectionReason,
        unfilledRemainder: outcome.unfilledRemainder,
      }
      return { id: canonicalHashV1({ runId, kind: 'order', ...material }), ...material }
    }),
  )

export const restrictReferenceBuyFill = (
  runId: string,
  simulatedOrder: SimulatedOrder,
  permittedQuantity: bigint,
): ReferenceComputation<SimulatedOrder> => {
  const modeledQuantity = BigInt(simulatedOrder.filledQuantityMicros)
  if (modeledQuantity === 0n || modeledQuantity === permittedQuantity) return Result.succeed(simulatedOrder)
  if (permittedQuantity < 0n || permittedQuantity > modeledQuantity) {
    return Result.fail({
      _tag: 'ReferenceBuyFillRestrictionInvalid',
      orderId: simulatedOrder.id,
      modeledQuantityMicros: modeledQuantity.toString(),
      permittedQuantityMicros: permittedQuantity.toString(),
    })
  }
  const material = {
    decisionId: simulatedOrder.decisionId,
    sessionDate: simulatedOrder.sessionDate,
    symbol: simulatedOrder.symbol,
    side: simulatedOrder.side,
    requestedQuantityMicros: simulatedOrder.requestedQuantityMicros,
    filledQuantityMicros: permittedQuantity.toString(),
    status: permittedQuantity === 0n ? ('rejected' as const) : ('partially-filled' as const),
    rejectionReason: permittedQuantity === 0n ? ('insufficient-buying-power' as const) : null,
    unfilledRemainder: 'canceled' as const,
  }
  return Result.succeed({ id: canonicalHashV1({ runId, kind: 'order', ...material }), ...material })
}

const fill = (
  runId: string,
  decision: DecisionEvent,
  simulatedOrder: SimulatedOrder,
  terms: FillTerms,
  costBasisMicros: bigint,
): FillEvent => {
  const material = {
    orderId: simulatedOrder.id,
    decisionId: decision.id,
    sessionDate: simulatedOrder.sessionDate,
    symbol: simulatedOrder.symbol,
    side: simulatedOrder.side,
    quantityMicros: simulatedOrder.filledQuantityMicros,
    referencePriceMicros: terms.referencePriceMicros.toString(),
    priceMicros: terms.fillPriceMicros.toString(),
    notionalMicros: terms.notionalMicros.toString(),
    spreadCostMicros: terms.spreadCostMicros.toString(),
    slippageCostMicros: terms.slippageCostMicros.toString(),
    costBasisMicros: costBasisMicros.toString(),
  }
  return { kind: 'fill', id: canonicalHashV1({ runId, kind: 'fill', ...material }), ...material }
}

const cashChange = (
  runId: string,
  source:
    | Pick<FillEvent | FeeEvent, 'kind' | 'id' | 'sessionDate'>
    | { kind: 'cash-yield'; id: string; sessionDate: IsoDate },
  amountMicros: bigint,
  cashAfterMicros: bigint,
): CashChange => {
  const material = {
    sourceKind: source.kind,
    sourceId: source.id,
    sessionDate: source.sessionDate,
    amountMicros: amountMicros.toString(),
    cashAfterMicros: cashAfterMicros.toString(),
  }
  return { id: canonicalHashV1({ runId, kind: 'cash-change', ...material }), ...material }
}

const replayPrices = (
  session: Session,
  protocol: SimulationProtocol,
  price: (bar: DailyBar) => number,
): ReferenceComputation<Readonly<Record<string, bigint>>> =>
  pipe(
    Result.all(
      protocol.universe.map((symbol) =>
        pipe(
          referencePriceMicros(price(session.bars[symbol]), protocol.executionModel),
          Result.map((priceMicros) => [symbol, priceMicros] as const),
        ),
      ),
    ),
    Result.map((entries) => Object.fromEntries(entries)),
  )

const replayPositionValue = (
  prices: Readonly<Record<string, bigint>>,
  positions: ReadonlyMap<string, Position>,
  protocol: SimulationProtocol,
): ReferenceComputation<bigint> =>
  protocol.universe.reduce<ReferenceComputation<bigint>>(
    (total, symbol) =>
      pipe(
        total,
        Result.flatMap((value) =>
          pipe(
            notionalMicros(positions.get(symbol)?.quantityMicros ?? 0n, prices[symbol]),
            Result.map((notional) => value + notional),
          ),
        ),
      ),
    Result.succeed(0n),
  )

const replayDesiredQuantities = (
  equityMicros: bigint,
  weights: Readonly<Record<string, number>>,
  prices: Readonly<Record<string, bigint>>,
  protocol: SimulationProtocol,
): ReferenceComputation<Readonly<Record<string, bigint>>> =>
  pipe(
    Result.all(
      protocol.universe.map((symbol) =>
        pipe(
          desiredQuantityMicros(equityMicros, weights[symbol], prices[symbol], protocol.executionModel),
          Result.map((quantityMicros) => [symbol, quantityMicros] as const),
        ),
      ),
    ),
    Result.map((entries) => Object.fromEntries(entries)),
  )

interface ReferenceBuyCandidate {
  readonly symbol: string
  readonly quantityMicros: bigint
}

const replayBuyFeeInputs = (
  buys: readonly ReferenceBuyCandidate[],
  scalePpm: bigint,
  prices: Readonly<Record<string, bigint>>,
  protocol: SimulationProtocol,
  costMultiplierMicros: bigint,
  minimumNotionalMicros?: bigint,
): ReferenceComputation<readonly FeeInput[]> =>
  buys.reduce<ReferenceComputation<readonly FeeInput[]>>(
    (result, buy) =>
      pipe(
        result,
        Result.flatMap((inputs) =>
          pipe(
            scaleQuantityMicros(buy.quantityMicros, scalePpm, protocol.executionModel),
            Result.flatMap((quantityMicros) => {
              if (quantityMicros === 0n) return Result.succeed(inputs)
              return pipe(
                notionalMicros(quantityMicros, prices[buy.symbol]),
                Result.flatMap((referenceNotionalMicros) => {
                  if (minimumNotionalMicros !== undefined && referenceNotionalMicros < minimumNotionalMicros) {
                    return Result.succeed(inputs)
                  }
                  return pipe(
                    makeFillTerms(
                      'buy',
                      quantityMicros,
                      prices[buy.symbol],
                      protocol.executionModel,
                      costMultiplierMicros,
                    ),
                    Result.map((terms) => [
                      ...inputs,
                      { side: 'buy' as const, quantityMicros, notionalMicros: terms.notionalMicros },
                    ]),
                  )
                }),
              )
            }),
          ),
        ),
      ),
    Result.succeed([]),
  )

const replayBuysFitCash = (
  buys: readonly ReferenceBuyCandidate[],
  scalePpm: bigint,
  prices: Readonly<Record<string, bigint>>,
  protocol: SimulationProtocol,
  costMultiplierMicros: bigint,
  availableCashMicros: bigint,
  minimumNotionalMicros?: bigint,
): ReferenceComputation<boolean> =>
  pipe(
    replayBuyFeeInputs(buys, scalePpm, prices, protocol, costMultiplierMicros, minimumNotionalMicros),
    Result.flatMap((inputs) =>
      pipe(
        calculateSessionFees(inputs, protocol.executionModel, costMultiplierMicros),
        Result.map(
          (fees) =>
            inputs.reduce((total, candidate) => total + candidate.notionalMicros, 0n) + fees.totalMicros <=
            availableCashMicros,
        ),
      ),
    ),
  )

interface ReplayState {
  readonly positions: ReadonlyMap<string, Position>
  readonly cashMicros: bigint
  readonly turnoverMicros: bigint
  readonly feeMicros: bigint
  readonly spreadMicros: bigint
  readonly slippageMicros: bigint
  readonly cashYieldMicros: bigint
  readonly previousEquityMicros: bigint
  readonly peakEquityMicros: bigint
  readonly previousDate?: IsoDate
}

const replay = (
  sessions: readonly Session[],
  targets: readonly Target[],
  startIndex: number,
  protocol: SimulationProtocol,
  costMultiplierMicros: bigint,
  runId: string,
  retainTrace: boolean,
): ReferenceComputation<ReplayWithWork> => {
  if (protocol.executionModel.schemaVersion !== 'bayn.execution-model.v2') {
    return Result.fail({
      _tag: 'UnsupportedReferenceExecutionModel',
      actual: protocol.executionModel.schemaVersion,
      required: 'bayn.execution-model.v2',
    })
  }
  const targetBySession = new Map(targets.map((target) => [target.executionIndex, target]))
  const initial = BigInt(protocol.initialCapitalMicros)
  let state: ReplayState = {
    positions: new Map(),
    cashMicros: initial,
    turnoverMicros: 0n,
    feeMicros: 0n,
    spreadMicros: 0n,
    slippageMicros: 0n,
    cashYieldMicros: 0n,
    previousEquityMicros: initial,
    peakEquityMicros: initial,
  }
  let positionStateCopies = 0
  let positionWrites = 0
  const equity: bigint[] = []
  const events: EvaluationEvent[] = []
  const decisions: SignalDecision[] = []
  const orders: SimulatedOrder[] = []
  const changes: CashChange[] = []
  const marks: DailyPositionMark[] = []
  const daily: DailyPerformancePoint[] = []

  for (let index = startIndex; index < sessions.length; index += 1) {
    const session = sessions[index]
    const target = targetBySession.get(index)
    const beforeTurnover = state.turnoverMicros
    const beforeFees = state.feeMicros
    const beforeSpread = state.spreadMicros
    const beforeSlippage = state.slippageMicros
    const beforeYield = state.cashYieldMicros
    const planningCashSnapshot = state.cashMicros
    let cash = state.cashMicros
    let turnover = state.turnoverMicros
    let fees = state.feeMicros
    let spread = state.spreadMicros
    let slippage = state.slippageMicros
    let cashYield = state.cashYieldMicros
    let positions = state.positions
    let writablePositions: Map<string, Position> | undefined
    const writePosition = (symbol: string, position: Position): void => {
      if (writablePositions === undefined) {
        writablePositions = new Map(positions)
        positionStateCopies += 1
      }
      writablePositions.set(symbol, position)
      positions = writablePositions
      positionWrites += 1
    }

    if (state.previousDate !== undefined) {
      const elapsedDaysResult = elapsedCalendarDays(state.previousDate, session.date)
      if (Result.isFailure(elapsedDaysResult)) return Result.fail(elapsedDaysResult.failure)
      const elapsedDays = elapsedDaysResult.success
      const accruedResult = accrueCashYield(cash, elapsedDays, protocol.executionModel)
      if (Result.isFailure(accruedResult)) return Result.fail(accruedResult.failure)
      const accrued = accruedResult.success
      if (accrued > 0n) {
        cash += accrued
        cashYield += accrued
        if (retainTrace) {
          const material = {
            sessionDate: session.date,
            elapsedDays,
            annualYieldBps: protocol.executionModel.cash.annualYieldBps,
            amountMicros: accrued.toString(),
          }
          const event = {
            kind: 'cash-yield' as const,
            id: canonicalHashV1({ runId, kind: 'cash-yield', ...material }),
            ...material,
          }
          events.push(event)
          changes.push(cashChange(runId, event, accrued, cash))
        }
      }
    }

    if (target !== undefined) {
      const signalSession = sessions[target.signalIndex]
      if (signalSession === undefined) {
        return Result.fail({
          _tag: 'ReferenceTargetSignalMissing',
          signalIndex: target.signalIndex,
          executionIndex: target.executionIndex,
          sessionCount: sessions.length,
        })
      }
      const decisionMaterial = {
        signalDate: signalSession.date,
        executionDate: session.date,
        targetWeights: target.weights,
      }
      const decision: DecisionEvent = {
        kind: 'decision',
        id: canonicalHashV1({ runId, kind: 'decision', ...decisionMaterial }),
        ...decisionMaterial,
      }
      if (retainTrace) {
        if (target.plan === undefined) {
          return Result.fail({
            _tag: 'ReferenceMissingDecisionPlan',
            signalIndex: target.signalIndex,
            executionIndex: target.executionIndex,
          })
        }
        events.push(decision)
        decisions.push({ ...target.plan, decisionId: decision.id, executionDate: decision.executionDate })
      }

      const planPricesResult = replayPrices(signalSession, protocol, (bar) => bar.close)
      if (Result.isFailure(planPricesResult)) return Result.fail(planPricesResult.failure)
      const planPrices = planPricesResult.success
      const fillPricesResult = replayPrices(session, protocol, (bar) => bar.open)
      if (Result.isFailure(fillPricesResult)) return Result.fail(fillPricesResult.failure)
      const fillPrices = fillPricesResult.success
      const cashAvailableWhenPlanned = planningCashSnapshot
      const plannedPositionValue = replayPositionValue(planPrices, positions, protocol)
      if (Result.isFailure(plannedPositionValue)) return Result.fail(plannedPositionValue.failure)
      const planEquity = planningCashSnapshot + plannedPositionValue.success
      const desiredResult = replayDesiredQuantities(planEquity, target.weights, planPrices, protocol)
      if (Result.isFailure(desiredResult)) return Result.fail(desiredResult.failure)
      const desired = desiredResult.success
      const sessionFills: FillEvent[] = []

      const sellPlans = [...protocol.universe]
        .sort()
        .map((symbol) => {
          const held = positions.get(symbol)?.quantityMicros ?? 0n
          return { symbol, quantityMicros: desired[symbol] < held ? held - desired[symbol] : 0n }
        })
        .filter((candidate) => candidate.quantityMicros > 0n)
      const buyPlans = [...protocol.universe]
        .sort()
        .map((symbol) => {
          const held = positions.get(symbol)?.quantityMicros ?? 0n
          return { symbol, quantityMicros: desired[symbol] > held ? desired[symbol] - held : 0n }
        })
        .filter((candidate) => candidate.quantityMicros > 0n)
      const minimumBuyNotionalMicros = BigInt(protocol.executionModel.precision.minimumBuyNotionalMicros)
      let acceptedPlanScale = 0n
      let upperPlanScale = ppm
      while (acceptedPlanScale < upperPlanScale) {
        const midpoint = (acceptedPlanScale + upperPlanScale + 1n) / 2n
        const fitsCash = replayBuysFitCash(
          buyPlans,
          midpoint,
          planPrices,
          protocol,
          costMultiplierMicros,
          cashAvailableWhenPlanned,
          minimumBuyNotionalMicros,
        )
        if (Result.isFailure(fitsCash)) return Result.fail(fitsCash.failure)
        if (fitsCash.success) acceptedPlanScale = midpoint
        else upperPlanScale = midpoint - 1n
      }
      const sellOrdersResult = Result.all(
        sellPlans.map((candidate) =>
          order(
            runId,
            decision,
            session.date,
            candidate.symbol,
            'sell',
            candidate.quantityMicros,
            fillPrices[candidate.symbol],
            protocol,
          ),
        ),
      )
      if (Result.isFailure(sellOrdersResult)) return Result.fail(sellOrdersResult.failure)
      const sellOrders = sellOrdersResult.success
      const unboundedBuyOrders: SimulatedOrder[] = []
      for (const candidate of buyPlans) {
        const requested = scaleQuantityMicros(candidate.quantityMicros, acceptedPlanScale, protocol.executionModel)
        if (Result.isFailure(requested)) return Result.fail(requested.failure)
        if (requested.success === 0n) continue
        const requestedNotional = notionalMicros(requested.success, planPrices[candidate.symbol])
        if (Result.isFailure(requestedNotional)) return Result.fail(requestedNotional.failure)
        if (requestedNotional.success < minimumBuyNotionalMicros) continue
        const simulatedOrder = order(
          runId,
          decision,
          session.date,
          candidate.symbol,
          'buy',
          requested.success,
          fillPrices[candidate.symbol],
          protocol,
        )
        if (Result.isFailure(simulatedOrder)) return Result.fail(simulatedOrder.failure)
        unboundedBuyOrders.push(simulatedOrder.success)
      }
      const unboundedFillCandidates = unboundedBuyOrders.map((candidate) => ({
        symbol: candidate.symbol,
        quantityMicros: BigInt(candidate.filledQuantityMicros),
      }))
      let acceptedFillScale = 0n
      let upperFillScale = ppm
      while (acceptedFillScale < upperFillScale) {
        const midpoint = (acceptedFillScale + upperFillScale + 1n) / 2n
        const fitsCash = replayBuysFitCash(
          unboundedFillCandidates,
          midpoint,
          fillPrices,
          protocol,
          costMultiplierMicros,
          cashAvailableWhenPlanned,
        )
        if (Result.isFailure(fitsCash)) return Result.fail(fitsCash.failure)
        if (fitsCash.success) acceptedFillScale = midpoint
        else upperFillScale = midpoint - 1n
      }
      const buyOrders: SimulatedOrder[] = []
      for (const candidate of unboundedBuyOrders) {
        const permittedQuantity = scaleQuantityMicros(
          BigInt(candidate.filledQuantityMicros),
          acceptedFillScale,
          protocol.executionModel,
        )
        if (Result.isFailure(permittedQuantity)) return Result.fail(permittedQuantity.failure)
        const restricted = restrictReferenceBuyFill(runId, candidate, permittedQuantity.success)
        if (Result.isFailure(restricted)) return Result.fail(restricted.failure)
        buyOrders.push(restricted.success)
      }

      for (const simulatedOrder of sellOrders) {
        if (retainTrace) orders.push(simulatedOrder)
        const position = positions.get(simulatedOrder.symbol) ?? { quantityMicros: 0n, costBasisMicros: 0n }
        const quantity = BigInt(simulatedOrder.filledQuantityMicros)
        if (quantity === 0n) continue
        const termsResult = makeFillTerms(
          'sell',
          quantity,
          fillPrices[simulatedOrder.symbol],
          protocol.executionModel,
          costMultiplierMicros,
        )
        if (Result.isFailure(termsResult)) return Result.fail(termsResult.failure)
        const terms = termsResult.success
        const costBasisResult = saleCostBasisMicros(position.costBasisMicros, quantity, position.quantityMicros)
        if (Result.isFailure(costBasisResult)) return Result.fail(costBasisResult.failure)
        const costBasis = costBasisResult.success
        const event = fill(runId, decision, simulatedOrder, terms, costBasis)
        cash += terms.notionalMicros
        turnover += terms.notionalMicros
        spread += terms.spreadCostMicros
        slippage += terms.slippageCostMicros
        writePosition(simulatedOrder.symbol, {
          quantityMicros: position.quantityMicros - quantity,
          costBasisMicros: position.costBasisMicros - costBasis,
        })
        sessionFills.push(event)
        if (retainTrace) {
          events.push(event)
          changes.push(cashChange(runId, event, terms.notionalMicros, cash))
        }
      }

      for (const simulatedOrder of buyOrders) {
        if (retainTrace) orders.push(simulatedOrder)
        const quantity = BigInt(simulatedOrder.filledQuantityMicros)
        if (quantity === 0n) continue
        const termsResult = makeFillTerms(
          'buy',
          quantity,
          fillPrices[simulatedOrder.symbol],
          protocol.executionModel,
          costMultiplierMicros,
        )
        if (Result.isFailure(termsResult)) return Result.fail(termsResult.failure)
        const terms = termsResult.success
        const event = fill(runId, decision, simulatedOrder, terms, terms.notionalMicros)
        cash -= terms.notionalMicros
        turnover += terms.notionalMicros
        spread += terms.spreadCostMicros
        slippage += terms.slippageCostMicros
        const position = positions.get(simulatedOrder.symbol) ?? { quantityMicros: 0n, costBasisMicros: 0n }
        writePosition(simulatedOrder.symbol, {
          quantityMicros: position.quantityMicros + quantity,
          costBasisMicros: position.costBasisMicros + terms.notionalMicros,
        })
        sessionFills.push(event)
        if (retainTrace) {
          events.push(event)
          changes.push(cashChange(runId, event, -terms.notionalMicros, cash))
        }
      }

      const feeResult = calculateSessionFees(
        sessionFills.map((event) => ({
          side: event.side,
          quantityMicros: BigInt(event.quantityMicros),
          notionalMicros: BigInt(event.notionalMicros),
        })),
        protocol.executionModel,
        costMultiplierMicros,
      )
      if (Result.isFailure(feeResult)) return Result.fail(feeResult.failure)
      const fee = feeResult.success
      if (fee.totalMicros > 0n) {
        cash -= fee.totalMicros
        fees += fee.totalMicros
        if (retainTrace) {
          const material = {
            sessionDate: session.date,
            commissionMicros: fee.commissionMicros.toString(),
            secMicros: fee.secMicros.toString(),
            tafMicros: fee.tafMicros.toString(),
            catMicros: fee.catMicros.toString(),
            totalMicros: fee.totalMicros.toString(),
          }
          const event: FeeEvent = {
            kind: 'fee',
            id: canonicalHashV1({ runId, kind: 'fee', ...material }),
            ...material,
          }
          events.push(event)
          changes.push(cashChange(runId, event, -fee.totalMicros, cash))
        }
      }
      if (cash < 0n) {
        return Result.fail({ _tag: 'ReferenceNegativeCash', sessionDate: session.date, cashMicros: cash.toString() })
      }
    }

    const closesResult = replayPrices(session, protocol, (bar) => bar.close)
    if (Result.isFailure(closesResult)) return Result.fail(closesResult.failure)
    const closes = closesResult.success
    const closingPositionValue = replayPositionValue(closes, positions, protocol)
    if (Result.isFailure(closingPositionValue)) return Result.fail(closingPositionValue.failure)
    const closingEquity = cash + closingPositionValue.success
    equity.push(closingEquity)
    const peakEquity = state.peakEquityMicros > closingEquity ? state.peakEquityMicros : closingEquity
    const point: DailyPerformancePoint = {
      sessionDate: session.date,
      equityMicros: closingEquity.toString(),
      netReturn: Number(closingEquity) / Number(state.previousEquityMicros) - 1,
      turnoverMicros: (turnover - beforeTurnover).toString(),
      cumulativeTurnoverMicros: turnover.toString(),
      feeMicros: (fees - beforeFees).toString(),
      cumulativeFeesMicros: fees.toString(),
      spreadCostMicros: (spread - beforeSpread).toString(),
      cumulativeSpreadCostMicros: spread.toString(),
      slippageCostMicros: (slippage - beforeSlippage).toString(),
      cumulativeSlippageCostMicros: slippage.toString(),
      cashYieldMicros: (cashYield - beforeYield).toString(),
      cumulativeCashYieldMicros: cashYield.toString(),
      peakEquityMicros: peakEquity.toString(),
      drawdown: 1 - Number(closingEquity) / Number(peakEquity),
    }
    daily.push(point)
    if (retainTrace) {
      const markedPositions: DailyPositionMark['positions'][number][] = []
      for (const symbol of [...protocol.universe].sort()) {
        const position = positions.get(symbol) ?? { quantityMicros: 0n, costBasisMicros: 0n }
        const marketValue = notionalMicros(position.quantityMicros, closes[symbol])
        if (Result.isFailure(marketValue)) return Result.fail(marketValue.failure)
        markedPositions.push({
          symbol,
          quantityMicros: position.quantityMicros.toString(),
          costBasisMicros: position.costBasisMicros.toString(),
          priceMicros: closes[symbol].toString(),
          marketValueMicros: marketValue.success.toString(),
        })
      }
      marks.push({
        ...point,
        cashMicros: cash.toString(),
        positions: markedPositions,
      })
    }
    state = {
      positions,
      cashMicros: cash,
      turnoverMicros: turnover,
      feeMicros: fees,
      spreadMicros: spread,
      slippageMicros: slippage,
      cashYieldMicros: cashYield,
      previousEquityMicros: closingEquity,
      peakEquityMicros: peakEquity,
      previousDate: session.date,
    }
  }

  const metricsResult = metrics(
    equity,
    state.turnoverMicros,
    state.feeMicros,
    state.spreadMicros,
    state.slippageMicros,
    state.cashYieldMicros,
    initial,
  )
  if (Result.isFailure(metricsResult)) return Result.fail(metricsResult.failure)
  return Result.succeed({
    metrics: metricsResult.success,
    events,
    decisions,
    daily,
    trace: retainTrace
      ? {
          schemaVersion: 'bayn.simulation-trace.v3',
          executionModel: protocol.executionModel,
          costMultiplierMicros: costMultiplierMicros.toString(),
          orders,
          cashChanges: changes,
          dailyMarks: marks,
        }
      : null,
    work: {
      sessionsProcessed: daily.length,
      positionStateCopies,
      positionWrites,
    },
  })
}

const verdict = (
  strategy: PerformanceMetrics,
  buyAndHold: PerformanceMetrics,
  directVolTiming: PerformanceMetrics,
  doubleCost: PerformanceMetrics,
  protocol: SimulationProtocol,
): EconomicVerdict => {
  const threshold = protocol.thresholds
  const benchmarkSharpe = Math.max(buyAndHold.sharpe, directVolTiming.sharpe)
  const finite = [
    strategy.annualizedReturn,
    strategy.sharpe,
    strategy.maximumDrawdown,
    strategy.annualTurnover,
    doubleCost.annualizedReturn,
  ].every(Number.isFinite)
  const gates: GateResult[] = [
    { name: 'finite_metrics', passed: finite, actual: finite, required: true },
    {
      name: 'minimum_observations',
      passed: strategy.observations >= threshold.minimumObservations,
      actual: strategy.observations,
      required: threshold.minimumObservations,
    },
    {
      name: 'positive_net_return',
      passed: strategy.annualizedReturn > threshold.minimumAnnualizedReturn,
      actual: strategy.annualizedReturn,
      required: `>${threshold.minimumAnnualizedReturn}`,
    },
    {
      name: 'benchmark_sharpe_improvement',
      passed: strategy.sharpe - benchmarkSharpe > threshold.minimumSharpeImprovement,
      actual: strategy.sharpe - benchmarkSharpe,
      required: `>${threshold.minimumSharpeImprovement}`,
    },
    {
      name: 'maximum_drawdown',
      passed: strategy.maximumDrawdown <= threshold.maximumDrawdown,
      actual: strategy.maximumDrawdown,
      required: `<=${threshold.maximumDrawdown}`,
    },
    {
      name: 'maximum_turnover',
      passed: strategy.annualTurnover <= threshold.maximumAnnualTurnover,
      actual: strategy.annualTurnover,
      required: `<=${threshold.maximumAnnualTurnover}`,
    },
    {
      name: 'double_cost_return',
      passed: !threshold.requirePositiveDoubleCostReturn || doubleCost.annualizedReturn > 0,
      actual: doubleCost.annualizedReturn,
      required: threshold.requirePositiveDoubleCostReturn ? '>0' : 'not-required',
    },
  ]
  return { status: gates.every((gate) => gate.passed) ? 'PASS' : 'FAIL_CLOSED', gates }
}

const evaluateReferenceWithWork = (
  bars: readonly DailyBar[],
  manifest: InputManifest,
  protocol: Protocol,
  provenance: RuntimeProvenance,
): ReferenceComputation<ReferenceEvaluationWithWork> => {
  const sessionsResult = align(bars, manifest, protocol.universe)
  if (Result.isFailure(sessionsResult)) return Result.fail(sessionsResult.failure)
  const sessions = sessionsResult.success
  const dates = sessions.map((session) => session.date)
  const requiredHistory = riskBalancedHistoryLength(protocol)
  const eligibleSignals = monthEnds(dates).filter(
    (index) =>
      index >= requiredHistory &&
      index < dates.length - 1 &&
      dates[index - requiredHistory] >= manifest.bounds.lookbackStart &&
      dates[index + 1] >= manifest.bounds.evaluationStart &&
      dates[index + 1] <= manifest.bounds.evaluationEnd,
  )
  const firstEligibleSignal = eligibleSignals[0]
  if (firstEligibleSignal === undefined) {
    return Result.fail({
      _tag: 'ReferenceNoEligibleSignal',
      sessionCount: sessions.length,
      lookbackStart: manifest.bounds.lookbackStart,
      evaluationStart: manifest.bounds.evaluationStart,
      evaluationEnd: manifest.bounds.evaluationEnd,
    })
  }
  const startIndex = firstEligibleSignal + 1
  const firstAfterEnd = dates.findIndex((date) => date > manifest.bounds.evaluationEnd)
  const endExclusive = firstAfterEnd === -1 ? dates.length : firstAfterEnd
  const boundedSessions = sessions.slice(0, endExclusive)
  if (endExclusive - startIndex < protocol.thresholds.minimumObservations) {
    return Result.fail({
      _tag: 'ReferenceInsufficientObservations',
      actual: endExclusive - startIndex,
      required: protocol.thresholds.minimumObservations,
      startIndex,
      endExclusive,
    })
  }

  const parameterHash = canonicalHashV1(protocol)
  const strategyIdentity = {
    name: provenance.strategy.name,
    behaviorHash: provenance.strategy.behaviorHash,
    parameterHash,
    parameterSchemaVersion: protocol.schemaVersion,
  }
  if (parameterHash !== provenance.strategy.parameterHash || provenance.strategy.name !== 'risk-balanced-trend') {
    return Result.fail({
      _tag: 'ReferenceProvenanceMismatch',
      requiredStrategyName: 'risk-balanced-trend',
      actualStrategyName: provenance.strategy.name,
      expectedParameterHash: parameterHash,
      actualParameterHash: provenance.strategy.parameterHash,
    })
  }
  const runId = makeRunIdentity({
    schemaVersion: 'bayn.run-identity.v1',
    sourceRevision: provenance.sourceRevision,
    image: provenance.image,
    strategy: {
      name: provenance.strategy.name,
      behaviorHash: provenance.strategy.behaviorHash,
      parameters: protocol,
    },
    finalizedSnapshot: manifest.finalizedSnapshot,
    calendarVersion: manifest.finalizedSnapshot.calendarVersion,
    bounds: manifest.bounds,
  }).runId
  const protocolHash = makeStrategyProtocolHash(strategyIdentity)
  const candidateTargetsResult = Result.all(
    eligibleSignals.map((signalIndex) =>
      pipe(
        riskBalancedDecisionPlan(signalIndex, sessions, protocol),
        Result.map(
          (plan): Target => ({ signalIndex, executionIndex: signalIndex + 1, weights: plan.targetWeights, plan }),
        ),
      ),
    ),
  )
  if (Result.isFailure(candidateTargetsResult)) return Result.fail(candidateTargetsResult.failure)
  const candidateTargets = candidateTargetsResult.success
  const equalWeight = roundWeight(1 / protocol.universe.length)
  const buyAndHoldTargets: readonly Target[] = [
    {
      signalIndex: startIndex - 1,
      executionIndex: startIndex,
      weights: Object.fromEntries(protocol.universe.map((symbol) => [symbol, equalWeight])),
    },
  ]
  const directVolTargetsResult = Result.all(
    eligibleSignals.map((signalIndex) =>
      pipe(
        directVolatilityTarget(sessions, signalIndex, protocol),
        Result.map(
          (weights): Target => ({
            signalIndex,
            executionIndex: signalIndex + 1,
            weights,
          }),
        ),
      ),
    ),
  )
  if (Result.isFailure(directVolTargetsResult)) return Result.fail(directVolTargetsResult.failure)
  const directVolTargets = directVolTargetsResult.success
  const strategy = replay(boundedSessions, candidateTargets, startIndex, protocol, MICROS, runId, true)
  const buyAndHold = replay(boundedSessions, buyAndHoldTargets, startIndex, protocol, MICROS, runId, false)
  const directVolTiming = replay(boundedSessions, directVolTargets, startIndex, protocol, MICROS, runId, false)
  const doubleCostStrategy = replay(
    boundedSessions,
    candidateTargets,
    startIndex,
    protocol,
    BigInt(protocol.executionModel.doubleCostMultiplier) * MICROS,
    runId,
    false,
  )
  return pipe(
    Result.all({ strategy, buyAndHold, directVolTiming, doubleCostStrategy }),
    Result.map(
      ({ strategy, buyAndHold, directVolTiming, doubleCostStrategy }): ReferenceEvaluationWithWork => ({
        runId,
        protocolHash,
        strategy,
        buyAndHold,
        directVolTiming,
        doubleCostStrategy,
        verdict: verdict(
          strategy.metrics,
          buyAndHold.metrics,
          directVolTiming.metrics,
          doubleCostStrategy.metrics,
          protocol,
        ),
      }),
    ),
  )
}

const stripReplayWork = (replay: ReplayWithWork): Replay => ({
  metrics: replay.metrics,
  events: replay.events,
  decisions: replay.decisions,
  daily: replay.daily,
  trace: replay.trace,
})

export const evaluateReference = (
  bars: readonly DailyBar[],
  manifest: InputManifest,
  protocol: Protocol,
  provenance: RuntimeProvenance,
): ReferenceComputation<ReferenceEvaluation> =>
  pipe(
    evaluateReferenceWithWork(bars, manifest, protocol, provenance),
    Result.map((reference) => ({
      runId: reference.runId,
      protocolHash: reference.protocolHash,
      strategy: stripReplayWork(reference.strategy),
      buyAndHold: stripReplayWork(reference.buyAndHold),
      directVolTiming: stripReplayWork(reference.directVolTiming),
      doubleCostStrategy: stripReplayWork(reference.doubleCostStrategy),
      verdict: reference.verdict,
    })),
  )

export const measureReferenceEvaluationWork = (
  bars: readonly DailyBar[],
  manifest: InputManifest,
  protocol: Protocol,
  provenance: RuntimeProvenance,
): ReferenceComputation<ReferenceEvaluationWork> =>
  pipe(
    evaluateReferenceWithWork(bars, manifest, protocol, provenance),
    Result.map((reference) => ({
      strategy: reference.strategy.work,
      buyAndHold: reference.buyAndHold.work,
      directVolTiming: reference.directVolTiming.work,
      doubleCostStrategy: reference.doubleCostStrategy.work,
    })),
  )
