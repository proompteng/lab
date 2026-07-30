import { Result } from 'effect'

import { officialMonthEndSignalDates, type CandidateDevelopmentPreflightPass } from '../../candidate-development'
import { canonicalHashV1Result } from '../../hash'
import type { AlignedSession, SimulationTarget } from '../../simulation'
import type { DailyBar, DecisionPlan, IsoDate } from '../../types'
import {
  candidate16Protocol,
  candidate16Specification,
  candidate16Universe,
  type Candidate16Failure,
  type Candidate16Feature,
  type Candidate16Plan,
  type Candidate16SignalDecision,
  type Candidate16State,
  type Candidate16Symbol,
} from './model'

const fail = <A>(operation: string, reason: string): Result.Result<A, Candidate16Failure> =>
  Result.fail({ _tag: 'Candidate16InvalidInput', operation, reason })

const round = (value: number): number => Number.parseFloat(value.toFixed(12))

const validBar = (bar: DailyBar): boolean =>
  [bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0) &&
  Number.isFinite(bar.volume) &&
  bar.volume > 0 &&
  bar.low <= Math.min(bar.open, bar.close) &&
  bar.high >= Math.max(bar.open, bar.close)

const barAt = (
  sessions: readonly AlignedSession[],
  index: number,
  symbol: Candidate16Symbol,
): Result.Result<DailyBar, Candidate16Failure> => {
  const session = sessions.at(index)
  if (session === undefined) return fail('feature-window', `session index ${index} is missing`)
  const bar = session.bars[symbol]
  if (bar === undefined) return fail('feature-window', `${symbol} is missing on ${session.date}`)
  if (bar.sessionDate !== session.date) {
    return fail('feature-window', `${symbol} bar date ${bar.sessionDate} differs from ${session.date}`)
  }
  return validBar(bar) ? Result.succeed(bar) : fail('feature-window', `malformed bar ${symbol}:${session.date}`)
}

const totalReturn = (
  sessions: readonly AlignedSession[],
  startIndex: number,
  signalIndex: number,
  symbol: Candidate16Symbol,
): Result.Result<number, Candidate16Failure> => {
  const start = barAt(sessions, startIndex, symbol)
  if (Result.isFailure(start)) return Result.fail(start.failure)
  const end = barAt(sessions, signalIndex, symbol)
  if (Result.isFailure(end)) return Result.fail(end.failure)
  const value = end.success.close / start.success.close - 1
  return Number.isFinite(value) ? Result.succeed(round(value)) : fail('feature-window', `${symbol} return is invalid`)
}

const selectedState = (
  returns: Readonly<Record<Candidate16Symbol, number>>,
): {
  readonly state: Candidate16State
  readonly selectedSymbol: 'DBC' | 'IEF' | 'SPY'
  readonly positiveRiskSleeves: number
} => {
  const positiveRiskSleeves = (['SPY', 'EFA', 'VNQ'] as const).filter((symbol) => returns[symbol] > 0).length
  if (positiveRiskSleeves >= candidate16Specification.requiredPositiveRiskSleeves && returns.SPY > 0) {
    return { state: 'GROWTH', selectedSymbol: 'SPY', positiveRiskSleeves }
  }
  return returns.DBC > returns.IEF
    ? { state: 'INFLATION_DEFENSE', selectedSymbol: 'DBC', positiveRiskSleeves }
    : { state: 'DEFLATION_DEFENSE', selectedSymbol: 'IEF', positiveRiskSleeves }
}

export const candidate16FeatureAtSignal = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
): Result.Result<Candidate16Feature, Candidate16Failure> => {
  const startIndex = signalIndex - candidate16Specification.lookbackSessions
  if (startIndex < 0) {
    return fail(
      'feature-window',
      `signal index ${signalIndex} lacks ${candidate16Specification.lookbackSessions} returns`,
    )
  }
  const returns: Partial<Record<Candidate16Symbol, number>> = {}
  for (const symbol of candidate16Universe) {
    const result = totalReturn(sessions, startIndex, signalIndex, symbol)
    if (Result.isFailure(result)) return Result.fail(result.failure)
    returns[symbol] = result.success
  }
  const completeReturns = returns as Readonly<Record<Candidate16Symbol, number>>
  const classification = selectedState(completeReturns)
  const windowStart = sessions.at(startIndex)?.date
  const windowEnd = sessions.at(signalIndex)?.date
  if (windowStart === undefined || windowEnd === undefined) return fail('feature-window', 'window boundary is missing')
  return Result.succeed({ windowStart, windowEnd, totalReturns: completeReturns, ...classification })
}

const selectedWeights = (selectedSymbol: 'DBC' | 'IEF' | 'SPY'): Readonly<Record<Candidate16Symbol, number>> =>
  Object.fromEntries(
    candidate16Universe.map((symbol) => [
      symbol,
      symbol === selectedSymbol ? candidate16Specification.grossExposure : 0,
    ]),
  ) as Readonly<Record<Candidate16Symbol, number>>

const allCashWeights = (): Readonly<Record<Candidate16Symbol, number>> =>
  Object.fromEntries(candidate16Universe.map((symbol) => [symbol, 0])) as Readonly<Record<Candidate16Symbol, number>>

const decisionPlan = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  feature: Candidate16Feature,
  weights: Readonly<Record<Candidate16Symbol, number>>,
): Result.Result<DecisionPlan, Candidate16Failure> => {
  const startIndex = signalIndex - candidate16Specification.lookbackSessions
  const firstSession = sessions.at(startIndex + 1)?.date
  const lastSession = sessions.at(signalIndex)?.date
  if (firstSession === undefined || lastSession === undefined)
    return fail('decision-plan', 'window boundary is missing')
  const sessionsHash = canonicalHashV1Result({
    schemaVersion: 'bayn.candidate-16-macro-breadth-window.v1',
    sessions: sessions.slice(startIndex, signalIndex + 1).map((session) => session.date),
  })
  if (Result.isFailure(sessionsHash)) {
    return Result.fail({ _tag: 'Candidate16HashFailure', operation: 'decision-window', cause: sessionsHash.failure })
  }
  return Result.succeed({
    schemaVersion: 'bayn.risk-balanced-trend-decision-plan.v1',
    signalDate: lastSession,
    covarianceWindow: {
      returnCount: candidate16Specification.lookbackSessions,
      firstSession,
      lastSession,
      sessionsHash: sessionsHash.success,
    },
    estimatedAnnualizedPortfolioVolatility: 0,
    exposureScale: weights[feature.selectedSymbol],
    targetWeights: weights,
    signals: candidate16Universe.map((symbol) => {
      const targetWeight = weights[symbol]
      const value = feature.totalReturns[symbol]
      return {
        symbol,
        horizons: [
          {
            horizonSessions: candidate16Specification.lookbackSessions,
            return: value,
            normalizedTrend: value,
          },
        ],
        dailyVolatility: 0,
        annualizedVolatility: 0,
        compositeScore: value,
        positiveScore: Math.max(0, value),
        eligible: symbol === feature.selectedSymbol,
        uncappedWeight: targetWeight,
        cappedWeight: targetWeight,
        targetWeight,
      }
    }),
  })
}

export const candidate16DecisionAtSignal = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  terminal: boolean,
): Result.Result<Candidate16SignalDecision, Candidate16Failure> => {
  const signalDate = sessions.at(signalIndex)?.date
  const executionDate = sessions.at(signalIndex + 1)?.date
  if (signalDate === undefined || executionDate === undefined)
    return fail('signal', 'signal or execution session is missing')
  const feature = candidate16FeatureAtSignal(sessions, signalIndex)
  if (Result.isFailure(feature)) return Result.fail(feature.failure)
  const weights = terminal ? allCashWeights() : selectedWeights(feature.success.selectedSymbol)
  const plan = decisionPlan(sessions, signalIndex, feature.success, weights)
  if (Result.isFailure(plan)) return Result.fail(plan.failure)
  return Result.succeed({
    signalDate,
    executionDate,
    feature: feature.success,
    weights,
    decisionPlan: plan.success,
  })
}

export const buildCandidate16Plan = (
  sessions: readonly AlignedSession[],
  preflight: CandidateDevelopmentPreflightPass,
): Result.Result<Candidate16Plan, Candidate16Failure> => {
  if (sessions.length === 0) return fail('plan', 'sessions are empty')
  const simulationStartIndex = preflight.firstEligibleExecution.executionIndex
  const evaluationStartIndex = preflight.selectedObservationStartIndex
  const officialSignals = new Set(officialMonthEndSignalDates(sessions.map((session) => session.date)))
  const targets: SimulationTarget[] = []
  for (
    let signalIndex = preflight.firstEligibleExecution.signalIndex;
    signalIndex < sessions.length - 1;
    signalIndex += 1
  ) {
    const signalDate = sessions.at(signalIndex)?.date
    if (signalDate === undefined || !officialSignals.has(signalDate)) continue
    const terminal = signalDate === candidate16Protocol.schedule.terminalSignalDate
    const decision = candidate16DecisionAtSignal(sessions, signalIndex, terminal)
    if (Result.isFailure(decision)) return Result.fail(decision.failure)
    if (terminal && decision.success.executionDate !== candidate16Protocol.schedule.terminalExecutionDate) {
      return fail('plan', `terminal execution ${decision.success.executionDate} differs from the frozen schedule`)
    }
    targets.push({
      signalIndex,
      executionIndex: signalIndex + 1,
      weights: decision.success.weights,
      decision: decision.success.decisionPlan,
    })
  }
  const governedTargets = targets.filter((target) => {
    const executionDate = sessions.at(target.executionIndex)?.date
    return (
      executionDate !== undefined &&
      executionDate >= preflight.selectedObservationStart &&
      executionDate <= preflight.selectedObservationEnd
    )
  })
  const expectedSignals = preflight.expectedRebalanceSchedule.map((rebalance) => rebalance.signalDate)
  const observedSignals = governedTargets.map((target) => sessions.at(target.signalIndex)?.date)
  if (
    observedSignals.length !== expectedSignals.length ||
    observedSignals.some((date, index) => date !== expectedSignals.at(index))
  ) {
    return fail('plan', 'strategy targets differ from the preflight official schedule')
  }
  const last = targets.at(-1)
  if (
    last === undefined ||
    sessions.at(last.signalIndex)?.date !== candidate16Protocol.schedule.terminalSignalDate ||
    sessions.at(last.executionIndex)?.date !== candidate16Protocol.schedule.terminalExecutionDate
  ) {
    return fail('plan', 'terminal governed target is missing')
  }
  return Result.succeed({
    targets,
    rebalanceExecutionDates: targets
      .map((target) => sessions.at(target.executionIndex)?.date)
      .filter((date): date is IsoDate => date !== undefined && date >= preflight.selectedObservationStart),
    simulationStartIndex,
    evaluationStartIndex,
  })
}
