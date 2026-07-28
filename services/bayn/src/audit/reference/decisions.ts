import { Result } from 'effect'

import type { DailyBar, DecisionPlan, InputManifest, IsoDate, Protocol, SimulationProtocol } from '../../types'
import { hashReferenceMaterial } from './replay/identities'
import type { ReferenceComputation, Session } from './model'

export const tradingDays = 252

export const roundWeight = (value: number): number => Number.parseFloat(value.toFixed(12))

export const average = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right)
  const midpoint = Math.floor(sorted.length / 2)
  const upper = sorted.at(midpoint) ?? 0
  if (sorted.length % 2 === 1) return upper
  const lower = sorted.at(midpoint - 1) ?? upper
  return (lower + upper) / 2
}

export const sampleDeviation = (values: readonly number[]): number => {
  if (values.length < 2) return 0
  const center = average(values)
  const variance = values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

export const align = (
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

export const monthEnds = (dates: readonly IsoDate[]): readonly number[] => {
  const result: number[] = []
  for (let index = 0; index < dates.length - 1; index += 1) {
    if (dates[index].slice(0, 7) !== dates[index + 1].slice(0, 7)) result.push(index)
  }
  return result
}

export const riskBalancedHistoryLength = (protocol: Pick<Protocol, 'volatilityWindow' | 'horizons'>): number =>
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

export const riskBalancedDecisionPlan = (
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
    if (horizons.length === 0) {
      return Result.fail({
        _tag: 'ReferenceInvalidScore',
        symbol,
        annualizedVolatility,
        compositeScore: Number.NaN,
      })
    }
    let compositeScore = 0
    let positiveScore = 0
    let eligible = false
    if (dailyVolatility > 0 && protocol.schemaVersion === 'bayn.risk-balanced-trend.protocol.v4') {
      const cap = protocol.signal.normalizedTrendCap
      compositeScore = median(horizons.map(({ normalizedTrend }) => Math.max(-cap, Math.min(cap, normalizedTrend))))
      const positiveHorizons = horizons.filter(({ normalizedTrend }) => normalizedTrend > 0).length
      eligible = positiveHorizons >= protocol.signal.minimumPositiveHorizons && compositeScore > 0
      positiveScore = eligible ? compositeScore / annualizedVolatility : 0
    } else if (dailyVolatility > 0) {
      compositeScore = average(horizons.map((horizon) => horizon.normalizedTrend))
      positiveScore = Math.max(0, compositeScore)
      eligible = true
    }
    if (![annualizedVolatility, compositeScore, positiveScore].every(Number.isFinite)) {
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
      positiveScore,
      eligible,
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
  const sessionsHash = hashReferenceMaterial('covariance-sessions', covarianceDates)
  if (Result.isFailure(sessionsHash)) return Result.fail(sessionsHash.failure)
  return Result.succeed({
    schemaVersion: 'bayn.risk-balanced-trend-decision-plan.v1',
    signalDate: signalSession.date,
    covarianceWindow: {
      returnCount: protocol.volatilityWindow,
      firstSession: firstCovarianceSession,
      lastSession: covarianceDates.at(-1) ?? signalSession.date,
      sessionsHash: sessionsHash.success,
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

export const directVolatilityTarget = (
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
