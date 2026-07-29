import { pipe, Result } from 'effect'

import { officialMonthEndSignalDates, type CandidateDevelopmentPreflightPass } from '../candidate-development'
import { makeOrderOutcome } from '../execution-model'
import { canonicalHashV1Result } from '../hash'
import type { AlignedSession, SimulationTarget } from '../simulation'
import { ContractVersion, type DailyBar, type DecisionPlan, type IsoDate } from '../types'
import {
  candidate14Protocol,
  candidate14SimulationProtocol,
  candidate14Specifications,
  candidate14Universe,
  type Candidate14Challenger,
  type Candidate14Failure,
  type Candidate14Feature,
  type Candidate14Plan,
  type Candidate14SignalDecision,
  type Candidate14Specification,
  type Candidate14Symbol,
} from './model'

const fail = <A>(operation: string, reason: string): Result.Result<A, Candidate14Failure> =>
  Result.fail({ _tag: 'Candidate14InvalidInput', operation, reason })

const round = (value: number): number => Number.parseFloat(value.toFixed(12))

const validBar = (bar: DailyBar): boolean =>
  [bar.open, bar.high, bar.low, bar.close].every(
    (value) => Number.isFinite(value) && value >= candidate14Protocol.dataValidity.minimumAdjustedPrice,
  ) &&
  Number.isFinite(bar.volume) &&
  bar.volume > 0 &&
  bar.low <= Math.min(bar.open, bar.close) &&
  bar.high >= Math.max(bar.open, bar.close)

const exactSpecification = (
  specification: Candidate14Specification,
): Result.Result<Candidate14Specification, Candidate14Failure> => {
  const frozen = candidate14Specifications.at(0)
  if (frozen === undefined) return fail('specification', 'frozen specification is missing')
  const matches = Object.entries(frozen).every(([key, value]) => Reflect.get(specification, key) === value)
  return matches && Object.keys(specification).length === Object.keys(frozen).length
    ? Result.succeed(frozen)
    : fail('specification', `unregistered specification ${specification.id}`)
}

const barAt = (
  sessions: readonly AlignedSession[],
  index: number,
  symbol: Candidate14Symbol,
): Result.Result<DailyBar, Candidate14Failure> => {
  const session = sessions.at(index)
  if (session === undefined) return fail('feature-window', `session index ${index} is missing`)
  const bar = session.bars[symbol]
  if (bar === undefined) return fail('feature-window', `${symbol} is missing on ${session.date}`)
  if (bar.sessionDate !== session.date) {
    return fail('feature-window', `${symbol} bar date ${bar.sessionDate} differs from ${session.date}`)
  }
  return validBar(bar) ? Result.succeed(bar) : fail('feature-window', `malformed bar ${symbol}:${session.date}`)
}

interface IntradayWindow {
  readonly start: IsoDate
  readonly end: IsoDate
  readonly cumulativeReturn: number
}

const cumulativeIntradayReturn = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  symbol: Candidate14Symbol,
  lookbackSessions: number,
): Result.Result<IntradayWindow, Candidate14Failure> => {
  const startIndex = signalIndex - lookbackSessions + 1
  if (startIndex < 0) return fail('feature-window', `signal index ${signalIndex} lacks ${lookbackSessions} sessions`)
  let product = 1
  for (let index = startIndex; index <= signalIndex; index += 1) {
    const bar = barAt(sessions, index, symbol)
    if (Result.isFailure(bar)) return Result.fail(bar.failure)
    const grossReturn = bar.success.close / bar.success.open
    if (!Number.isFinite(grossReturn) || grossReturn <= 0) {
      return fail('feature-window', `invalid intraday gross return ${symbol}:${bar.success.sessionDate}`)
    }
    product *= grossReturn
    if (!Number.isFinite(product) || product <= 0) {
      return fail('feature-window', `invalid cumulative intraday product ${symbol}:${bar.success.sessionDate}`)
    }
  }
  const start = sessions.at(startIndex)?.date
  const end = sessions.at(signalIndex)?.date
  const cumulativeReturn = product - 1
  if (start === undefined || end === undefined || !Number.isFinite(cumulativeReturn)) {
    return fail('feature-window', `invalid intraday window for ${symbol}`)
  }
  return Result.succeed({ start, end, cumulativeReturn })
}

export const relativeIntradayContinuationFeature = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  challenger: Candidate14Challenger,
  specification: Candidate14Specification,
): Result.Result<Candidate14Feature, Candidate14Failure> => {
  const frozen = exactSpecification(specification)
  if (Result.isFailure(frozen)) return Result.fail(frozen.failure)
  const windows = Result.all({
    challenger: cumulativeIntradayReturn(sessions, signalIndex, challenger, frozen.success.lookbackSessions),
    spy: cumulativeIntradayReturn(sessions, signalIndex, 'SPY', frozen.success.lookbackSessions),
  })
  if (Result.isFailure(windows)) return Result.fail(windows.failure)
  if (
    windows.success.challenger.start !== windows.success.spy.start ||
    windows.success.challenger.end !== windows.success.spy.end
  ) {
    return fail('feature-window', `unaligned intraday windows for ${challenger}`)
  }
  const score = windows.success.challenger.cumulativeReturn - windows.success.spy.cumulativeReturn
  if (!Number.isFinite(score)) return fail('feature-window', `non-finite relative intraday return for ${challenger}`)
  return Result.succeed({
    symbol: challenger,
    windowStart: windows.success.challenger.start,
    windowEnd: windows.success.challenger.end,
    challengerCumulativeIntradayReturn: round(windows.success.challenger.cumulativeReturn),
    spyCumulativeIntradayReturn: round(windows.success.spy.cumulativeReturn),
    score: round(score),
    eligible: score > frozen.success.minimumRelativeIntradayReturn,
  })
}

const selectedWeights = (
  selected: Candidate14Challenger | null,
  specification: Candidate14Specification,
): Readonly<Record<Candidate14Symbol, number>> => {
  const selectedSymbol: Candidate14Symbol = selected ?? candidate14Protocol.allocation.fallbackSymbol
  return Object.fromEntries(
    candidate14Universe.map(
      (symbol) => [symbol, symbol === selectedSymbol ? specification.selectedWeight : 0] as const,
    ),
  ) as Readonly<Record<Candidate14Symbol, number>>
}

const decisionPlan = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  weights: Readonly<Record<Candidate14Symbol, number>>,
  features: readonly Candidate14Feature[],
): Result.Result<DecisionPlan, Candidate14Failure> => {
  const startIndex = signalIndex - candidate14Protocol.feature.declaredLookbackSessions + 1
  const firstSession = sessions.at(startIndex)?.date
  const lastSession = sessions.at(signalIndex)?.date
  if (firstSession === undefined || lastSession === undefined) {
    return fail('decision-plan', 'lookback boundary is missing')
  }
  const sessionsHash = canonicalHashV1Result({
    schemaVersion: 'bayn.candidate-14-intraday-window.v1',
    sessions: sessions.slice(startIndex, signalIndex + 1).map((session) => session.date),
  })
  if (Result.isFailure(sessionsHash)) {
    return Result.fail({ _tag: 'Candidate14HashFailure', operation: 'decision-window', cause: sessionsHash.failure })
  }
  const featureBySymbol = new Map(features.map((feature) => [feature.symbol, feature] as const))
  const spyCumulative = features.at(0)?.spyCumulativeIntradayReturn ?? 0
  return Result.succeed({
    schemaVersion: 'bayn.risk-balanced-trend-decision-plan.v1',
    signalDate: lastSession,
    covarianceWindow: {
      returnCount: candidate14Protocol.feature.declaredLookbackSessions,
      firstSession,
      lastSession,
      sessionsHash: sessionsHash.success,
    },
    estimatedAnnualizedPortfolioVolatility: 0,
    exposureScale: candidate14Protocol.allocation.grossExposure,
    targetWeights: weights,
    signals: candidate14Universe.map((symbol) => {
      const feature = symbol === 'SPY' ? undefined : featureBySymbol.get(symbol)
      const targetWeight = weights[symbol]
      const score = feature?.score ?? 0
      return {
        symbol,
        horizons: [
          {
            horizonSessions: candidate14Protocol.feature.declaredLookbackSessions,
            return: feature?.challengerCumulativeIntradayReturn ?? spyCumulative,
            normalizedTrend: score,
          },
        ],
        dailyVolatility: 0,
        annualizedVolatility: 0,
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

export const candidate14DecisionAtSignal = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  specification: Candidate14Specification,
): Result.Result<Candidate14SignalDecision, Candidate14Failure> => {
  const frozen = exactSpecification(specification)
  if (Result.isFailure(frozen)) return Result.fail(frozen.failure)
  const signalDate = sessions.at(signalIndex)?.date
  const executionDate = sessions.at(signalIndex + 1)?.date
  if (signalDate === undefined || executionDate === undefined) {
    return fail('signal', 'signal or next execution session is missing')
  }
  const features = Result.all(
    candidate14Universe
      .filter((symbol): symbol is Candidate14Challenger => symbol !== 'SPY')
      .map((challenger) => relativeIntradayContinuationFeature(sessions, signalIndex, challenger, frozen.success)),
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

const allCashWeights = (): Readonly<Record<Candidate14Symbol, number>> =>
  Object.fromEntries(candidate14Universe.map((symbol) => [symbol, 0] as const)) as Readonly<
    Record<Candidate14Symbol, number>
  >

const terminalDecisionPlan = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
): Result.Result<DecisionPlan, Candidate14Failure> => {
  const decision = candidate14DecisionAtSignal(sessions, signalIndex, candidate14Specifications[0])
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

export const candidate14TerminalLiquidationIsComplete = (): Result.Result<boolean, Candidate14Failure> =>
  pipe(
    Result.all(
      candidate14Universe.map((symbol) =>
        pipe(
          makeOrderOutcome({
            identity: {
              schemaVersion: ContractVersion.PartialFillSeed,
              signalDate: candidate14Protocol.schedule.terminalSignalDate,
              executionDate: candidate14Protocol.schedule.terminalExecutionDate,
              symbol,
              side: 'sell',
            },
            side: 'sell',
            requestedQuantityMicros: 1n,
            referencePriceMicros: 1n,
            model: candidate14SimulationProtocol.executionModel,
          }),
          Result.mapError(
            (cause): Candidate14Failure => ({
              _tag: 'Candidate14InvalidInput',
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

export const buildCandidate14Plan = (
  sessions: readonly AlignedSession[],
  preflight: CandidateDevelopmentPreflightPass,
  specification: Candidate14Specification,
): Result.Result<Candidate14Plan, Candidate14Failure> => {
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
    const decision = candidate14DecisionAtSignal(sessions, signalIndex, specification)
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
    terminalSignal !== candidate14Protocol.schedule.terminalSignalDate ||
    terminalExecution !== candidate14Protocol.schedule.terminalExecutionDate
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
