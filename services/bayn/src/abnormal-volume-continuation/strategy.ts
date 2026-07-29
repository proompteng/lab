import { pipe, Result } from 'effect'

import { officialMonthEndSignalDates, type CandidateDevelopmentPreflightPass } from '../candidate-development'
import { makeOrderOutcome } from '../execution-model'
import type { AlignedSession, SimulationTarget } from '../simulation'
import { ContractVersion, type DailyBar, type IsoDate } from '../types'
import {
  candidate11Protocol,
  candidate11SimulationProtocol,
  candidate11Specifications,
  candidate11Universe,
  type Candidate11Failure,
  type Candidate11Plan,
  type Candidate11Specification,
  type Candidate11Symbol,
} from './model'

export interface Candidate11VolumeFeature {
  readonly abnormalDollarVolume: number
  readonly return21: number
}

export interface Candidate11ChallengerFeature extends Candidate11VolumeFeature {
  readonly symbol: Exclude<Candidate11Symbol, 'SPY'>
  readonly relativeReturn: number
  readonly eligible: boolean
}

export interface Candidate11SignalDecision {
  readonly signalDate: IsoDate
  readonly specification: Candidate11Specification
  readonly spy: Candidate11VolumeFeature
  readonly challengers: readonly Candidate11ChallengerFeature[]
  readonly selectedChallenger: Exclude<Candidate11Symbol, 'SPY'> | null
  readonly weights: Readonly<Record<Candidate11Symbol, number>>
}

const fail = <A>(operation: string, reason: string): Result.Result<A, Candidate11Failure> =>
  Result.fail({ _tag: 'Candidate11InvalidInput', operation, reason })

const round = (value: number): number => Number.parseFloat(value.toFixed(12))

const validBar = (bar: DailyBar): boolean =>
  [bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0) &&
  Number.isFinite(bar.volume) &&
  bar.volume >= 0 &&
  bar.low <= Math.min(bar.open, bar.close) &&
  bar.high >= Math.max(bar.open, bar.close)

const exactSpecification = (
  specification: Candidate11Specification,
): Result.Result<Candidate11Specification, Candidate11Failure> => {
  const frozen = candidate11Specifications.at(0)
  if (frozen === undefined) return fail('specification', 'frozen specification is missing')
  const matches = Object.entries(frozen).every(([key, value]) => Reflect.get(specification, key) === value)
  return matches && Object.keys(specification).length === Object.keys(frozen).length
    ? Result.succeed(frozen)
    : fail('specification', `unregistered specification ${specification.id}`)
}

const historyForSymbol = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  symbol: Candidate11Symbol,
): Result.Result<readonly DailyBar[], Candidate11Failure> => {
  const firstIndex = signalIndex - candidate11Protocol.feature.sessions + 1
  if (firstIndex < 0 || signalIndex >= sessions.length) {
    return fail('signal', `signal index ${signalIndex} lacks ${candidate11Protocol.feature.sessions} causal sessions`)
  }
  const bars: DailyBar[] = []
  for (let index = firstIndex; index <= signalIndex; index += 1) {
    const session = sessions.at(index)
    if (session === undefined) return fail('signal', `session ${index} is missing`)
    const bar = session.bars[symbol]
    if (bar === undefined) return fail('signal', `${symbol} is missing on ${session.date}`)
    if (bar.sessionDate !== session.date) {
      return fail('signal', `${symbol} bar date ${bar.sessionDate} differs from ${session.date}`)
    }
    bars.push(bar)
  }
  return Result.succeed(bars)
}

const averageDollarVolume = (
  history: readonly DailyBar[],
  operation: string,
): Result.Result<number, Candidate11Failure> => {
  if (history.length === 0) return fail(operation, 'dollar-volume window is empty')
  const values = history.map((bar) => bar.close * bar.volume)
  return values.every((value) => Number.isFinite(value) && value >= 0)
    ? Result.succeed(values.reduce((sum, value) => sum + value, 0) / values.length)
    : fail(operation, 'dollar-volume window contains a non-finite value')
}

export const abnormalVolumeFeature = (
  history: readonly DailyBar[],
): Result.Result<Candidate11VolumeFeature, Candidate11Failure> => {
  const feature = candidate11Protocol.feature
  if (history.length !== feature.sessions) {
    return fail('abnormal-volume', `expected ${feature.sessions} bars, observed ${history.length}`)
  }
  const first = history.at(0)
  if (first === undefined) return fail('abnormal-volume', 'history is empty')
  let previousDate: IsoDate | undefined
  for (const bar of history) {
    if (!validBar(bar)) return fail('abnormal-volume', `malformed bar ${bar.symbol}:${bar.sessionDate}`)
    if (bar.symbol !== first.symbol) return fail('abnormal-volume', 'history contains multiple symbols')
    if (previousDate !== undefined && bar.sessionDate <= previousDate) {
      return fail('abnormal-volume', 'history is not strictly chronological')
    }
    previousDate = bar.sessionDate
  }
  const baseline = history.slice(0, feature.baselineDollarVolumeSessions)
  const recent = history.slice(-feature.recentDollarVolumeSessions)
  if (
    baseline.length !== feature.baselineDollarVolumeSessions ||
    recent.length !== feature.recentDollarVolumeSessions
  ) {
    return fail('abnormal-volume', 'frozen dollar-volume windows are incomplete')
  }
  const returnStartIndex = history.length - 1 - feature.relativeReturnSessions
  const returnStart = history.at(returnStartIndex)?.close
  const returnEnd = history.at(-1)?.close
  if (returnStart === undefined || returnEnd === undefined || returnStart <= 0) {
    return fail('abnormal-volume', 'return boundary is missing')
  }
  return pipe(
    Result.all({
      baselineAverage: averageDollarVolume(baseline, 'baseline-dollar-volume'),
      recentAverage: averageDollarVolume(recent, 'recent-dollar-volume'),
    }),
    Result.flatMap(({ baselineAverage, recentAverage }) => {
      if (baselineAverage <= 0) return fail('abnormal-volume', 'baseline dollar volume must be positive')
      const abnormalDollarVolume = recentAverage / baselineAverage
      const return21 = returnEnd / returnStart - 1
      return Number.isFinite(abnormalDollarVolume) && Number.isFinite(return21)
        ? Result.succeed({ abnormalDollarVolume: round(abnormalDollarVolume), return21: round(return21) })
        : fail('abnormal-volume', 'feature result is not finite')
    }),
  )
}

const fallbackWeights = (): Readonly<Record<Candidate11Symbol, number>> =>
  Object.fromEntries(candidate11Universe.map((symbol) => [symbol, symbol === 'SPY' ? 1 : 0] as const)) as Readonly<
    Record<Candidate11Symbol, number>
  >

const challengerWeights = (
  challenger: Exclude<Candidate11Symbol, 'SPY'>,
): Readonly<Record<Candidate11Symbol, number>> =>
  Object.fromEntries(
    candidate11Universe.map(
      (symbol) =>
        [
          symbol,
          symbol === 'SPY'
            ? candidate11Protocol.allocation.anchorWeight
            : symbol === challenger
              ? candidate11Protocol.allocation.challengerWeight
              : 0,
        ] as const,
    ),
  ) as Readonly<Record<Candidate11Symbol, number>>

export const candidate11DecisionAtSignal = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  specification: Candidate11Specification,
): Result.Result<Candidate11SignalDecision, Candidate11Failure> => {
  const frozenSpecification = exactSpecification(specification)
  if (Result.isFailure(frozenSpecification)) return Result.fail(frozenSpecification.failure)
  const signalDate = sessions.at(signalIndex)?.date
  if (signalDate === undefined) return fail('signal', `signal index ${signalIndex} is missing`)
  const spyHistory = historyForSymbol(sessions, signalIndex, 'SPY')
  if (Result.isFailure(spyHistory)) return Result.fail(spyHistory.failure)
  const spy = abnormalVolumeFeature(spyHistory.success)
  if (Result.isFailure(spy)) return Result.fail(spy.failure)

  const challengers: Candidate11ChallengerFeature[] = []
  for (const symbol of candidate11Universe) {
    if (symbol === 'SPY') continue
    const history = historyForSymbol(sessions, signalIndex, symbol)
    if (Result.isFailure(history)) return Result.fail(history.failure)
    const feature = abnormalVolumeFeature(history.success)
    if (Result.isFailure(feature)) return Result.fail(feature.failure)
    const relativeReturn = round(feature.success.return21 - spy.success.return21)
    challengers.push({
      symbol,
      ...feature.success,
      relativeReturn,
      eligible:
        feature.success.abnormalDollarVolume >= frozenSpecification.success.abnormalDollarVolumeThreshold &&
        relativeReturn > 0,
    })
  }
  const selectedChallenger =
    challengers
      .filter((challenger) => challenger.eligible)
      .toSorted(
        (left, right) =>
          right.abnormalDollarVolume - left.abnormalDollarVolume ||
          right.relativeReturn - left.relativeReturn ||
          left.symbol.localeCompare(right.symbol),
      )
      .at(0)?.symbol ?? null
  return Result.succeed({
    signalDate,
    specification: frozenSpecification.success,
    spy: spy.success,
    challengers,
    selectedChallenger,
    weights: selectedChallenger === null ? fallbackWeights() : challengerWeights(selectedChallenger),
  })
}

export const candidate11TerminalLiquidationIsComplete = (): Result.Result<boolean, Candidate11Failure> =>
  pipe(
    Result.all(
      candidate11Universe.map((symbol) =>
        pipe(
          makeOrderOutcome({
            identity: {
              schemaVersion: ContractVersion.PartialFillSeed,
              signalDate: candidate11Protocol.schedule.terminalSignalDate,
              executionDate: candidate11Protocol.schedule.terminalExecutionDate,
              symbol,
              side: 'sell',
            },
            side: 'sell',
            requestedQuantityMicros: 1n,
            referencePriceMicros: 1n,
            model: candidate11SimulationProtocol.executionModel,
          }),
          Result.mapError(
            (cause): Candidate11Failure => ({
              _tag: 'Candidate11InvalidInput',
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

const allCashWeights = (): Readonly<Record<Candidate11Symbol, number>> =>
  Object.fromEntries(candidate11Universe.map((symbol) => [symbol, 0] as const)) as Readonly<
    Record<Candidate11Symbol, number>
  >

export const buildCandidate11Plan = (
  sessions: readonly AlignedSession[],
  preflight: CandidateDevelopmentPreflightPass,
  specification: Candidate11Specification,
): Result.Result<Candidate11Plan, Candidate11Failure> => {
  if (sessions.length === 0) return fail('plan', 'sessions are empty')
  const simulationStartIndex = preflight.firstEligibleExecution.executionIndex
  const evaluationStartIndex = preflight.selectedObservationStartIndex
  if (simulationStartIndex >= evaluationStartIndex) {
    return fail('plan', `warm-up execution ${simulationStartIndex} must precede evaluation ${evaluationStartIndex}`)
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
    const decision = candidate11DecisionAtSignal(sessions, signalIndex, specification)
    if (Result.isFailure(decision)) return Result.fail(decision.failure)
    targets.push({ signalIndex, executionIndex: signalIndex + 1, weights: decision.success.weights })
  }
  const terminalExecutionIndex = sessions.length - 1
  const terminalSignalIndex = terminalExecutionIndex - 1
  const terminalSignal = sessions.at(terminalSignalIndex)?.date
  const terminalExecution = sessions.at(terminalExecutionIndex)?.date
  if (
    terminalSignal !== candidate11Protocol.schedule.terminalSignalDate ||
    terminalExecution !== candidate11Protocol.schedule.terminalExecutionDate
  ) {
    return fail('plan', `terminal boundary is ${terminalSignal ?? 'missing'}->${terminalExecution ?? 'missing'}`)
  }
  targets.push({ signalIndex: terminalSignalIndex, executionIndex: terminalExecutionIndex, weights: allCashWeights() })
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
