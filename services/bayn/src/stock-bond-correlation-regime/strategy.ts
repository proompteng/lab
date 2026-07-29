import { pipe, Result } from 'effect'

import { officialMonthEndSignalDates, type CandidateDevelopmentPreflightPass } from '../candidate-development'
import { makeOrderOutcome } from '../execution-model'
import { canonicalHashV1Result } from '../hash'
import type { AlignedSession, SimulationTarget } from '../simulation'
import { ContractVersion, type DailyBar, type DecisionPlan, type IsoDate } from '../types'
import {
  candidate15Protocol,
  candidate15SimulationProtocol,
  candidate15Specifications,
  candidate15Universe,
  type Candidate15Diversifier,
  type Candidate15Failure,
  type Candidate15Feature,
  type Candidate15Plan,
  type Candidate15SignalDecision,
  type Candidate15Specification,
  type Candidate15Symbol,
} from './model'

const fail = <A>(operation: string, reason: string): Result.Result<A, Candidate15Failure> =>
  Result.fail({ _tag: 'Candidate15InvalidInput', operation, reason })

const round = (value: number): number => Number.parseFloat(value.toFixed(12))

const validBar = (bar: DailyBar): boolean =>
  [bar.open, bar.high, bar.low, bar.close].every(
    (value) => Number.isFinite(value) && value >= candidate15Protocol.dataValidity.minimumAdjustedPrice,
  ) &&
  Number.isFinite(bar.volume) &&
  bar.volume > 0 &&
  bar.low <= Math.min(bar.open, bar.close) &&
  bar.high >= Math.max(bar.open, bar.close)

const exactSpecification = (
  specification: Candidate15Specification,
): Result.Result<Candidate15Specification, Candidate15Failure> => {
  const frozen = candidate15Specifications.at(0)
  if (frozen === undefined) return fail('specification', 'frozen specification is missing')
  const matches = Object.entries(frozen).every(([key, value]) => Reflect.get(specification, key) === value)
  return matches && Object.keys(specification).length === Object.keys(frozen).length
    ? Result.succeed(frozen)
    : fail('specification', `unregistered specification ${specification.id}`)
}

const barAt = (
  sessions: readonly AlignedSession[],
  index: number,
  symbol: 'SPY' | 'IEF',
): Result.Result<DailyBar, Candidate15Failure> => {
  const session = sessions.at(index)
  if (session === undefined) return fail('correlation-window', `session index ${index} is missing`)
  const bar = session.bars[symbol]
  if (bar === undefined) return fail('correlation-window', `${symbol} is missing on ${session.date}`)
  if (bar.sessionDate !== session.date) {
    return fail('correlation-window', `${symbol} bar date ${bar.sessionDate} differs from ${session.date}`)
  }
  return validBar(bar) ? Result.succeed(bar) : fail('correlation-window', `malformed bar ${symbol}:${session.date}`)
}

const simpleReturns = (
  closes: readonly number[],
  symbol: 'SPY' | 'IEF',
): Result.Result<readonly number[], Candidate15Failure> => {
  const returns: number[] = []
  for (let index = 1; index < closes.length; index += 1) {
    const previous = closes[index - 1]
    const current = closes[index]
    if (previous === undefined || current === undefined || previous <= 0 || current <= 0) {
      return fail('correlation-window', `${symbol} close pair ${index - 1}:${index} is invalid`)
    }
    const value = current / previous - 1
    if (!Number.isFinite(value)) return fail('correlation-window', `${symbol} return ${index - 1}:${index} is invalid`)
    returns.push(value)
  }
  return Result.succeed(returns)
}

export const stockBondCorrelationFeature = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  specification: Candidate15Specification,
): Result.Result<Candidate15Feature, Candidate15Failure> => {
  const frozen = exactSpecification(specification)
  if (Result.isFailure(frozen)) return Result.fail(frozen.failure)
  const startIndex = signalIndex - frozen.success.lookbackSessions
  if (startIndex < 0) {
    return fail('correlation-window', `signal index ${signalIndex} lacks ${frozen.success.lookbackSessions} returns`)
  }
  const spyCloses: number[] = []
  const iefCloses: number[] = []
  for (let index = startIndex; index <= signalIndex; index += 1) {
    const bars = Result.all({ spy: barAt(sessions, index, 'SPY'), ief: barAt(sessions, index, 'IEF') })
    if (Result.isFailure(bars)) return Result.fail(bars.failure)
    spyCloses.push(bars.success.spy.close)
    iefCloses.push(bars.success.ief.close)
  }
  if (
    spyCloses.length !== frozen.success.lookbackSessions + 1 ||
    iefCloses.length !== frozen.success.lookbackSessions + 1
  ) {
    return fail('correlation-window', 'close window length differs from the frozen specification')
  }
  const returns = Result.all({ spy: simpleReturns(spyCloses, 'SPY'), ief: simpleReturns(iefCloses, 'IEF') })
  if (Result.isFailure(returns)) return Result.fail(returns.failure)
  const count = returns.success.spy.length
  if (count !== frozen.success.lookbackSessions || returns.success.ief.length !== count || count < 2) {
    return fail('correlation-window', `return count ${count} differs from ${frozen.success.lookbackSessions}`)
  }
  const spyMean = returns.success.spy.reduce((sum, value) => sum + value, 0) / count
  const iefMean = returns.success.ief.reduce((sum, value) => sum + value, 0) / count
  let covarianceSum = 0
  let spyVarianceSum = 0
  let iefVarianceSum = 0
  for (let index = 0; index < count; index += 1) {
    const spy = returns.success.spy[index]
    const ief = returns.success.ief[index]
    if (spy === undefined || ief === undefined) return fail('correlation-window', `return ${index} is missing`)
    const spyDeviation = spy - spyMean
    const iefDeviation = ief - iefMean
    covarianceSum += spyDeviation * iefDeviation
    spyVarianceSum += spyDeviation * spyDeviation
    iefVarianceSum += iefDeviation * iefDeviation
  }
  const divisor = count - 1
  const sampleCovariance = covarianceSum / divisor
  const spySampleVariance = spyVarianceSum / divisor
  const iefSampleVariance = iefVarianceSum / divisor
  if (
    !Number.isFinite(sampleCovariance) ||
    !Number.isFinite(spySampleVariance) ||
    !Number.isFinite(iefSampleVariance) ||
    spySampleVariance <= 0 ||
    iefSampleVariance <= 0
  ) {
    return fail('correlation-window', 'sample covariance or variance is undefined')
  }
  const correlation = sampleCovariance / Math.sqrt(spySampleVariance * iefSampleVariance)
  if (!Number.isFinite(correlation)) return fail('correlation-window', 'correlation is not finite')
  const roundedCorrelation = round(correlation)
  const selectedDiversifier: Candidate15Diversifier =
    roundedCorrelation > frozen.success.positiveCorrelationThreshold
      ? candidate15Protocol.allocation.positiveRegimeDiversifier
      : candidate15Protocol.allocation.nonPositiveRegimeDiversifier
  const windowStart = sessions.at(startIndex)?.date
  const windowEnd = sessions.at(signalIndex)?.date
  if (windowStart === undefined || windowEnd === undefined)
    return fail('correlation-window', 'window boundary is missing')
  return Result.succeed({
    windowStart,
    windowEnd,
    spyMeanReturn: round(spyMean),
    iefMeanReturn: round(iefMean),
    sampleCovariance: round(sampleCovariance),
    spySampleVariance: round(spySampleVariance),
    iefSampleVariance: round(iefSampleVariance),
    correlation: roundedCorrelation,
    selectedDiversifier,
  })
}

const selectedWeights = (
  selectedDiversifier: Candidate15Diversifier,
  specification: Candidate15Specification,
): Readonly<Record<Candidate15Symbol, number>> =>
  Object.fromEntries(
    candidate15Universe.map((symbol) => [
      symbol,
      symbol === 'SPY' ? specification.spyWeight : symbol === selectedDiversifier ? specification.diversifierWeight : 0,
    ]),
  ) as Readonly<Record<Candidate15Symbol, number>>

const decisionPlan = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  weights: Readonly<Record<Candidate15Symbol, number>>,
  feature: Candidate15Feature,
): Result.Result<DecisionPlan, Candidate15Failure> => {
  const startIndex = signalIndex - candidate15Protocol.feature.declaredLookbackSessions
  const firstReturnSession = sessions.at(startIndex + 1)?.date
  const lastSession = sessions.at(signalIndex)?.date
  if (firstReturnSession === undefined || lastSession === undefined) {
    return fail('decision-plan', 'return boundary is missing')
  }
  const sessionsHash = canonicalHashV1Result({
    schemaVersion: 'bayn.candidate-15-stock-bond-correlation-window.v1',
    sessions: sessions.slice(startIndex, signalIndex + 1).map((session) => session.date),
  })
  if (Result.isFailure(sessionsHash)) {
    return Result.fail({ _tag: 'Candidate15HashFailure', operation: 'decision-window', cause: sessionsHash.failure })
  }
  return Result.succeed({
    schemaVersion: 'bayn.risk-balanced-trend-decision-plan.v1',
    signalDate: lastSession,
    covarianceWindow: {
      returnCount: candidate15Protocol.feature.declaredLookbackSessions,
      firstSession: firstReturnSession,
      lastSession,
      sessionsHash: sessionsHash.success,
    },
    estimatedAnnualizedPortfolioVolatility: 0,
    exposureScale: candidate15Protocol.allocation.grossExposure,
    targetWeights: weights,
    signals: candidate15Universe.map((symbol) => {
      const score =
        symbol === candidate15Protocol.allocation.positiveRegimeDiversifier
          ? feature.correlation
          : symbol === candidate15Protocol.allocation.nonPositiveRegimeDiversifier
            ? -feature.correlation
            : 0
      const targetWeight = weights[symbol]
      return {
        symbol,
        horizons: [
          {
            horizonSessions: candidate15Protocol.feature.declaredLookbackSessions,
            return: feature.correlation,
            normalizedTrend: score,
          },
        ],
        dailyVolatility: 0,
        annualizedVolatility: 0,
        compositeScore: score,
        positiveScore: Math.max(0, score),
        eligible: symbol === 'SPY' || symbol === feature.selectedDiversifier,
        uncappedWeight: targetWeight,
        cappedWeight: targetWeight,
        targetWeight,
      }
    }),
  })
}

export const candidate15DecisionAtSignal = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  specification: Candidate15Specification,
): Result.Result<Candidate15SignalDecision, Candidate15Failure> => {
  const frozen = exactSpecification(specification)
  if (Result.isFailure(frozen)) return Result.fail(frozen.failure)
  const signalDate = sessions.at(signalIndex)?.date
  const executionDate = sessions.at(signalIndex + 1)?.date
  if (signalDate === undefined || executionDate === undefined) {
    return fail('signal', 'signal or next execution session is missing')
  }
  const feature = stockBondCorrelationFeature(sessions, signalIndex, frozen.success)
  if (Result.isFailure(feature)) return Result.fail(feature.failure)
  const weights = selectedWeights(feature.success.selectedDiversifier, frozen.success)
  const plan = decisionPlan(sessions, signalIndex, weights, feature.success)
  if (Result.isFailure(plan)) return Result.fail(plan.failure)
  return Result.succeed({
    signalDate,
    executionDate,
    specification: frozen.success,
    feature: feature.success,
    selectedDiversifier: feature.success.selectedDiversifier,
    weights,
    decisionPlan: plan.success,
  })
}

const allCashWeights = (): Readonly<Record<Candidate15Symbol, number>> =>
  Object.fromEntries(candidate15Universe.map((symbol) => [symbol, 0] as const)) as Readonly<
    Record<Candidate15Symbol, number>
  >

const terminalDecisionPlan = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
): Result.Result<DecisionPlan, Candidate15Failure> => {
  const decision = candidate15DecisionAtSignal(sessions, signalIndex, candidate15Specifications[0])
  if (Result.isFailure(decision)) return Result.fail(decision.failure)
  const weights = allCashWeights()
  return Result.succeed({
    ...decision.success.decisionPlan,
    exposureScale: 0,
    targetWeights: weights,
    signals: decision.success.decisionPlan.signals.map((signal) => ({
      ...signal,
      uncappedWeight: 0,
      cappedWeight: 0,
      targetWeight: 0,
    })),
  })
}

export const candidate15TerminalLiquidationIsComplete = (): Result.Result<boolean, Candidate15Failure> =>
  pipe(
    Result.all(
      candidate15Universe.map((symbol) =>
        pipe(
          makeOrderOutcome({
            identity: {
              schemaVersion: ContractVersion.PartialFillSeed,
              signalDate: candidate15Protocol.schedule.terminalSignalDate,
              executionDate: candidate15Protocol.schedule.terminalExecutionDate,
              symbol,
              side: 'sell',
            },
            side: 'sell',
            requestedQuantityMicros: 1n,
            referencePriceMicros: 1n,
            model: candidate15SimulationProtocol.executionModel,
          }),
          Result.mapError(
            (cause): Candidate15Failure => ({
              _tag: 'Candidate15InvalidInput',
              operation: 'terminal-liquidation',
              reason: cause._tag,
            }),
          ),
          Result.map(
            (outcome) =>
              outcome.status === 'filled' &&
              outcome.filledQuantityMicros === outcome.requestedQuantityMicros &&
              outcome.unfilledRemainder === 'none',
          ),
        ),
      ),
    ),
    Result.map((outcomes) => outcomes.every(Boolean)),
  )

export const buildCandidate15Plan = (
  sessions: readonly AlignedSession[],
  preflight: CandidateDevelopmentPreflightPass,
  specification: Candidate15Specification,
): Result.Result<Candidate15Plan, Candidate15Failure> => {
  if (sessions.length === 0) return fail('plan', 'sessions are empty')
  const simulationStartIndex = preflight.firstEligibleExecution.executionIndex
  const evaluationStartIndex = preflight.selectedObservationStartIndex
  if (simulationStartIndex > evaluationStartIndex) {
    return fail('plan', `first execution ${simulationStartIndex} must not follow evaluation ${evaluationStartIndex}`)
  }
  const signalDates = new Set(officialMonthEndSignalDates(sessions.map((session) => session.date)))
  const targets: SimulationTarget[] = []
  for (
    let signalIndex = preflight.firstEligibleExecution.signalIndex;
    signalIndex < sessions.length - 1;
    signalIndex += 1
  ) {
    const signal = sessions.at(signalIndex)
    if (signal === undefined || !signalDates.has(signal.date)) continue
    const decision = candidate15DecisionAtSignal(sessions, signalIndex, specification)
    if (Result.isFailure(decision)) return Result.fail(decision.failure)
    targets.push({
      signalIndex,
      executionIndex: signalIndex + 1,
      weights: decision.success.weights,
      decision: decision.success.decisionPlan,
    })
  }
  const terminalExecutionIndex = sessions.length - 1
  const terminalSignalIndex = terminalExecutionIndex - 1
  const terminalSignal = sessions.at(terminalSignalIndex)?.date
  const terminalExecution = sessions.at(terminalExecutionIndex)?.date
  if (
    terminalSignal !== candidate15Protocol.schedule.terminalSignalDate ||
    terminalExecution !== candidate15Protocol.schedule.terminalExecutionDate
  ) {
    return fail('plan', `terminal boundary is ${terminalSignal ?? 'missing'}->${terminalExecution ?? 'missing'}`)
  }
  const liquidationDecision = terminalDecisionPlan(sessions, terminalSignalIndex)
  if (Result.isFailure(liquidationDecision)) return Result.fail(liquidationDecision.failure)
  targets.push({
    signalIndex: terminalSignalIndex,
    executionIndex: terminalExecutionIndex,
    weights: allCashWeights(),
    decision: liquidationDecision.success,
  })
  if (targets.length < 2) return fail('plan', 'fewer than two rebalance targets')
  return Result.succeed({
    specification,
    targets,
    rebalanceExecutionDates: targets
      .map((target) => sessions.at(target.executionIndex)?.date)
      .filter((date): date is IsoDate => date !== undefined && date >= preflight.selectedObservationStart),
    simulationStartIndex,
    evaluationStartIndex,
  })
}
