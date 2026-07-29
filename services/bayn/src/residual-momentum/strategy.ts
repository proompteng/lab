import { pipe, Result } from 'effect'

import { officialMonthEndSignalDates, type CandidateDevelopmentPreflightPass } from '../candidate-development'
import { makeOrderOutcome } from '../execution-model'
import { canonicalHashV1Result } from '../hash'
import { mean, sampleStandardDeviation, type AlignedSession, type SimulationTarget } from '../simulation'
import { ContractVersion, type DailyBar, type DecisionPlan, type IsoDate } from '../types'
import {
  candidate13Protocol,
  candidate13SimulationProtocol,
  candidate13Specifications,
  candidate13Universe,
  type Candidate13Challenger,
  type Candidate13Failure,
  type Candidate13Feature,
  type Candidate13Plan,
  type Candidate13SignalDecision,
  type Candidate13Specification,
  type Candidate13Symbol,
} from './model'

const fail = <A>(operation: string, reason: string): Result.Result<A, Candidate13Failure> =>
  Result.fail({ _tag: 'Candidate13InvalidInput', operation, reason })

const round = (value: number): number => Number.parseFloat(value.toFixed(12))

const validBar = (bar: DailyBar): boolean =>
  [bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0) &&
  Number.isFinite(bar.volume) &&
  bar.volume >= 0 &&
  bar.low <= Math.min(bar.open, bar.close) &&
  bar.high >= Math.max(bar.open, bar.close)

const exactSpecification = (
  specification: Candidate13Specification,
): Result.Result<Candidate13Specification, Candidate13Failure> => {
  const frozen = candidate13Specifications.at(0)
  if (frozen === undefined) return fail('specification', 'frozen specification is missing')
  const matches = Object.entries(frozen).every(([key, value]) => Reflect.get(specification, key) === value)
  return matches && Object.keys(specification).length === Object.keys(frozen).length
    ? Result.succeed(frozen)
    : fail('specification', `unregistered specification ${specification.id}`)
}

interface ReturnWindow {
  readonly firstCloseDate: IsoDate
  readonly firstReturnDate: IsoDate
  readonly formationEndDate: IsoDate
  readonly lastReturnDate: IsoDate
  readonly spyReturns: readonly number[]
  readonly challengerReturns: readonly number[]
  readonly sessionDates: readonly IsoDate[]
}

const closeAt = (
  sessions: readonly AlignedSession[],
  index: number,
  symbol: Candidate13Symbol,
): Result.Result<number, Candidate13Failure> => {
  const session = sessions.at(index)
  if (session === undefined) return fail('feature-window', `session index ${index} is missing`)
  const bar = session.bars[symbol]
  if (bar === undefined) return fail('feature-window', `${symbol} is missing on ${session.date}`)
  if (bar.sessionDate !== session.date) {
    return fail('feature-window', `${symbol} bar date ${bar.sessionDate} differs from ${session.date}`)
  }
  return validBar(bar) ? Result.succeed(bar.close) : fail('feature-window', `malformed bar ${symbol}:${session.date}`)
}

const pairedReturnWindow = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  challenger: Candidate13Challenger,
  specification: Candidate13Specification,
): Result.Result<ReturnWindow, Candidate13Failure> => {
  const startIndex = signalIndex - specification.regressionReturnCount
  if (startIndex < 0) {
    return fail('feature-window', `signal index ${signalIndex} lacks ${specification.regressionReturnCount} returns`)
  }
  const spyReturns: number[] = []
  const challengerReturns: number[] = []
  for (let index = startIndex + 1; index <= signalIndex; index += 1) {
    const values = Result.all({
      previousSpy: closeAt(sessions, index - 1, 'SPY'),
      currentSpy: closeAt(sessions, index, 'SPY'),
      previousChallenger: closeAt(sessions, index - 1, challenger),
      currentChallenger: closeAt(sessions, index, challenger),
    })
    if (Result.isFailure(values)) return Result.fail(values.failure)
    const spyReturn = values.success.currentSpy / values.success.previousSpy - 1
    const challengerReturn = values.success.currentChallenger / values.success.previousChallenger - 1
    if (!Number.isFinite(spyReturn) || !Number.isFinite(challengerReturn)) {
      return fail('feature-window', `non-finite return for ${challenger} at index ${index}`)
    }
    spyReturns.push(spyReturn)
    challengerReturns.push(challengerReturn)
  }
  if (
    spyReturns.length !== specification.regressionReturnCount ||
    challengerReturns.length !== specification.regressionReturnCount
  ) {
    return fail('feature-window', `expected ${specification.regressionReturnCount} paired returns`)
  }
  const firstCloseDate = sessions.at(startIndex)?.date
  const firstReturnDate = sessions.at(startIndex + 1)?.date
  const formationEndDate = sessions.at(startIndex + specification.formationReturnCount)?.date
  const lastReturnDate = sessions.at(signalIndex)?.date
  if (
    firstCloseDate === undefined ||
    firstReturnDate === undefined ||
    formationEndDate === undefined ||
    lastReturnDate === undefined
  ) {
    return fail('feature-window', 'window boundary is missing')
  }
  return Result.succeed({
    firstCloseDate,
    firstReturnDate,
    formationEndDate,
    lastReturnDate,
    spyReturns,
    challengerReturns,
    sessionDates: sessions.slice(startIndex, signalIndex + 1).map((session) => session.date),
  })
}

export const spyResidualMomentumFeature = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  challenger: Candidate13Challenger,
  specification: Candidate13Specification,
): Result.Result<Candidate13Feature, Candidate13Failure> => {
  const frozen = exactSpecification(specification)
  if (Result.isFailure(frozen)) return Result.fail(frozen.failure)
  const window = pairedReturnWindow(sessions, signalIndex, challenger, frozen.success)
  if (Result.isFailure(window)) return Result.fail(window.failure)
  const averages = Result.all({
    spy: mean(window.success.spyReturns),
    challenger: mean(window.success.challengerReturns),
  })
  if (Result.isFailure(averages)) {
    return fail('residual-regression', `cannot calculate means: ${averages.failure._tag}`)
  }
  let covariance = 0
  let spySquaredDeviation = 0
  for (let index = 0; index < window.success.spyReturns.length; index += 1) {
    const spyReturn = window.success.spyReturns.at(index)
    const challengerReturn = window.success.challengerReturns.at(index)
    if (spyReturn === undefined || challengerReturn === undefined) {
      return fail('residual-regression', `paired return ${index} is missing`)
    }
    const spyDeviation = spyReturn - averages.success.spy
    covariance += spyDeviation * (challengerReturn - averages.success.challenger)
    spySquaredDeviation += spyDeviation * spyDeviation
  }
  if (!Number.isFinite(spySquaredDeviation) || spySquaredDeviation <= 0) {
    return fail('residual-regression', 'SPY return variance is not strictly positive')
  }
  const beta = covariance / spySquaredDeviation
  if (!Number.isFinite(beta)) return fail('residual-regression', 'estimated beta is not finite')
  const residualized = window.success.challengerReturns.map(
    (challengerReturn, index) => challengerReturn - beta * (window.success.spyReturns.at(index) ?? Number.NaN),
  )
  if (residualized.some((value) => !Number.isFinite(value))) {
    return fail('residual-regression', 'residualized return is not finite')
  }
  const formation = residualized.slice(0, frozen.success.formationReturnCount)
  if (
    formation.length !== frozen.success.formationReturnCount ||
    residualized.length - formation.length !== frozen.success.skippedRecentReturnCount
  ) {
    return fail('residual-regression', 'formation and skip lengths differ from the frozen specification')
  }
  const formationStatistics = Result.all({
    mean: mean(formation),
    standardDeviation: sampleStandardDeviation(formation),
  })
  if (Result.isFailure(formationStatistics)) {
    return fail('residual-regression', `cannot calculate formation statistics: ${formationStatistics.failure._tag}`)
  }
  if (formationStatistics.success.standardDeviation <= 0) {
    return fail('residual-regression', 'formation residual standard deviation is not strictly positive')
  }
  const score = formationStatistics.success.mean / formationStatistics.success.standardDeviation
  if (!Number.isFinite(score)) return fail('residual-regression', 'residual momentum score is not finite')
  return Result.succeed({
    symbol: challenger,
    regressionStart: window.success.firstReturnDate,
    regressionEnd: window.success.lastReturnDate,
    formationEnd: window.success.formationEndDate,
    beta: round(beta),
    formationMean: round(formationStatistics.success.mean),
    formationStandardDeviation: round(formationStatistics.success.standardDeviation),
    score: round(score),
    eligible: score > frozen.success.minimumScore,
  })
}

const selectedWeights = (
  selected: Candidate13Challenger | null,
  specification: Candidate13Specification,
): Readonly<Record<Candidate13Symbol, number>> =>
  Object.fromEntries(
    candidate13Universe.map((symbol) => {
      const weight =
        symbol === 'SPY'
          ? selected === null
            ? specification.fallbackSpyWeight
            : specification.spyCoreWeight
          : symbol === selected
            ? specification.challengerWeight
            : 0
      return [symbol, weight] as const
    }),
  ) as Readonly<Record<Candidate13Symbol, number>>

const decisionPlan = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  weights: Readonly<Record<Candidate13Symbol, number>>,
  features: readonly Candidate13Feature[],
): Result.Result<DecisionPlan, Candidate13Failure> => {
  const startIndex = signalIndex - candidate13Protocol.feature.declaredLookbackSessions
  const firstSession = sessions.at(startIndex)?.date
  const lastSession = sessions.at(signalIndex)?.date
  if (firstSession === undefined || lastSession === undefined) {
    return fail('decision-plan', 'lookback boundary is missing')
  }
  const sessionsHash = canonicalHashV1Result({
    schemaVersion: 'bayn.candidate-13-residual-window.v1',
    sessions: sessions.slice(startIndex, signalIndex + 1).map((session) => session.date),
  })
  if (Result.isFailure(sessionsHash)) {
    return Result.fail({ _tag: 'Candidate13HashFailure', operation: 'decision-window', cause: sessionsHash.failure })
  }
  const featureBySymbol = new Map(features.map((feature) => [feature.symbol, feature] as const))
  return Result.succeed({
    schemaVersion: 'bayn.risk-balanced-trend-decision-plan.v1',
    signalDate: lastSession,
    covarianceWindow: {
      returnCount: candidate13Protocol.feature.declaredLookbackSessions,
      firstSession,
      lastSession,
      sessionsHash: sessionsHash.success,
    },
    estimatedAnnualizedPortfolioVolatility: 0,
    exposureScale: candidate13Protocol.allocation.grossExposure,
    targetWeights: weights,
    signals: candidate13Universe.map((symbol) => {
      const feature = symbol === 'SPY' ? undefined : featureBySymbol.get(symbol)
      const targetWeight = weights[symbol]
      const score = feature?.score ?? 0
      const standardDeviation = feature?.formationStandardDeviation ?? 0
      return {
        symbol,
        horizons: [
          {
            horizonSessions: candidate13Protocol.feature.formationReturnCount,
            return: feature?.formationMean ?? 0,
            normalizedTrend: score,
          },
        ],
        dailyVolatility: standardDeviation,
        annualizedVolatility: standardDeviation * Math.sqrt(252),
        compositeScore: score,
        positiveScore: Math.max(0, score),
        eligible: symbol === 'SPY' || (feature?.eligible ?? false),
        uncappedWeight: targetWeight,
        cappedWeight: targetWeight,
        targetWeight,
      }
    }),
  })
}

export const candidate13DecisionAtSignal = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  specification: Candidate13Specification,
): Result.Result<Candidate13SignalDecision, Candidate13Failure> => {
  const frozen = exactSpecification(specification)
  if (Result.isFailure(frozen)) return Result.fail(frozen.failure)
  const signalDate = sessions.at(signalIndex)?.date
  const executionDate = sessions.at(signalIndex + 1)?.date
  if (signalDate === undefined || executionDate === undefined) {
    return fail('signal', 'signal or next execution session is missing')
  }
  const features = Result.all(
    candidate13Universe
      .filter((symbol): symbol is Candidate13Challenger => symbol !== 'SPY')
      .map((challenger) => spyResidualMomentumFeature(sessions, signalIndex, challenger, frozen.success)),
  )
  if (Result.isFailure(features)) return Result.fail(features.failure)
  const selectedSymbol =
    features.success
      .filter((feature) => feature.eligible)
      .toSorted((left, right) => right.score - left.score || left.symbol.localeCompare(right.symbol))
      .at(0)?.symbol ?? null
  const weights = selectedWeights(selectedSymbol, frozen.success)
  const plan = decisionPlan(sessions, signalIndex, weights, features.success)
  if (Result.isFailure(plan)) return Result.fail(plan.failure)
  return Result.succeed({
    signalDate,
    executionDate,
    specification: frozen.success,
    features: features.success,
    selectedSymbol,
    weights,
    decisionPlan: plan.success,
  })
}

const allCashWeights = (): Readonly<Record<Candidate13Symbol, number>> =>
  Object.fromEntries(candidate13Universe.map((symbol) => [symbol, 0] as const)) as Readonly<
    Record<Candidate13Symbol, number>
  >

const terminalDecisionPlan = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
): Result.Result<DecisionPlan, Candidate13Failure> => {
  const decision = candidate13DecisionAtSignal(sessions, signalIndex, candidate13Specifications[0])
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

export const candidate13TerminalLiquidationIsComplete = (): Result.Result<boolean, Candidate13Failure> =>
  pipe(
    Result.all(
      candidate13Universe.map((symbol) =>
        pipe(
          makeOrderOutcome({
            identity: {
              schemaVersion: ContractVersion.PartialFillSeed,
              signalDate: candidate13Protocol.schedule.terminalSignalDate,
              executionDate: candidate13Protocol.schedule.terminalExecutionDate,
              symbol,
              side: 'sell',
            },
            side: 'sell',
            requestedQuantityMicros: 1n,
            referencePriceMicros: 1n,
            model: candidate13SimulationProtocol.executionModel,
          }),
          Result.mapError(
            (cause): Candidate13Failure => ({
              _tag: 'Candidate13InvalidInput',
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

export const buildCandidate13Plan = (
  sessions: readonly AlignedSession[],
  preflight: CandidateDevelopmentPreflightPass,
  specification: Candidate13Specification,
): Result.Result<Candidate13Plan, Candidate13Failure> => {
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
    const decision = candidate13DecisionAtSignal(sessions, signalIndex, specification)
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
    terminalSignal !== candidate13Protocol.schedule.terminalSignalDate ||
    terminalExecution !== candidate13Protocol.schedule.terminalExecutionDate
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
