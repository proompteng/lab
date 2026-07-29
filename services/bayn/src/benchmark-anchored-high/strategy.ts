import { pipe, Result } from 'effect'

import { officialMonthEndSignalDates, type CandidateDevelopmentPreflightPass } from '../candidate-development'
import { makeOrderOutcome } from '../execution-model'
import type { AlignedSession, SimulationTarget } from '../simulation'
import { ContractVersion, type DailyBar, type IsoDate } from '../types'
import {
  candidate10Protocol,
  candidate10SimulationProtocol,
  candidate10Specifications,
  candidate10Universe,
  type Candidate10Failure,
  type Candidate10Plan,
  type Candidate10Specification,
  type Candidate10Symbol,
} from './model'

export interface Candidate10SignalDecision {
  readonly signalDate: IsoDate
  readonly specification: Candidate10Specification
  readonly scores: Readonly<Record<Candidate10Symbol, number>>
  readonly challenger: Candidate10Symbol
  readonly selected: Candidate10Symbol
  readonly weights: Readonly<Record<Candidate10Symbol, number>>
}

const fail = <A>(operation: string, reason: string): Result.Result<A, Candidate10Failure> =>
  Result.fail({ _tag: 'Candidate10InvalidInput', operation, reason })

const validBar = (bar: DailyBar): boolean =>
  [bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0) &&
  Number.isFinite(bar.volume) &&
  bar.volume >= 0 &&
  bar.low <= Math.min(bar.open, bar.close) &&
  bar.high >= Math.max(bar.open, bar.close)

const exactSpecification = (
  specification: Candidate10Specification,
): Result.Result<Candidate10Specification, Candidate10Failure> => {
  const frozen = candidate10Specifications.find(({ id }) => id === specification.id)
  return frozen !== undefined && frozen.hurdle === specification.hurdle
    ? Result.succeed(frozen)
    : fail('specification', `unregistered specification ${specification.id}:${specification.hurdle}`)
}

export const trailingHighProximity = (history: readonly DailyBar[]): Result.Result<number, Candidate10Failure> => {
  if (history.length !== candidate10Protocol.feature.sessions) {
    return fail('high-proximity', `expected ${candidate10Protocol.feature.sessions} bars, observed ${history.length}`)
  }
  const first = history.at(0)
  if (first === undefined) return fail('high-proximity', 'history is empty')
  let previousDate: IsoDate | undefined
  let maximumClose = Number.NEGATIVE_INFINITY
  for (const bar of history) {
    if (!validBar(bar)) return fail('high-proximity', `malformed bar ${bar.symbol}:${bar.sessionDate}`)
    if (bar.symbol !== first.symbol) return fail('high-proximity', 'history contains multiple symbols')
    if (previousDate !== undefined && bar.sessionDate <= previousDate) {
      return fail('high-proximity', 'history is not strictly chronological')
    }
    previousDate = bar.sessionDate
    maximumClose = Math.max(maximumClose, bar.close)
  }
  const signalClose = history.at(-1)?.close
  if (signalClose === undefined || !Number.isFinite(maximumClose) || maximumClose <= 0) {
    return fail('high-proximity', 'signal or maximum close is invalid')
  }
  const score = signalClose / maximumClose
  return Number.isFinite(score) && score > 0 && score <= 1
    ? Result.succeed(Number.parseFloat(score.toFixed(12)))
    : fail('high-proximity', `score ${score} is outside (0,1]`)
}

const historyForSymbol = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  symbol: Candidate10Symbol,
): Result.Result<readonly DailyBar[], Candidate10Failure> => {
  const firstIndex = signalIndex - candidate10Protocol.feature.sessions + 1
  if (firstIndex < 0 || signalIndex >= sessions.length) {
    return fail('signal', `signal index ${signalIndex} lacks ${candidate10Protocol.feature.sessions} causal sessions`)
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

export const candidate10DecisionAtSignal = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  specification: Candidate10Specification,
): Result.Result<Candidate10SignalDecision, Candidate10Failure> => {
  const frozenSpecification = exactSpecification(specification)
  if (Result.isFailure(frozenSpecification)) return Result.fail(frozenSpecification.failure)
  const entries: [Candidate10Symbol, number][] = []
  for (const symbol of candidate10Universe) {
    const history = historyForSymbol(sessions, signalIndex, symbol)
    if (Result.isFailure(history)) return Result.fail(history.failure)
    const score = trailingHighProximity(history.success)
    if (Result.isFailure(score)) return Result.fail(score.failure)
    entries.push([symbol, score.success])
  }
  const scores = Object.fromEntries(entries) as Readonly<Record<Candidate10Symbol, number>>
  const challenger = candidate10Universe
    .filter((symbol) => symbol !== 'SPY')
    .toSorted((left, right) => scores[right] - scores[left] || left.localeCompare(right))
    .at(0)
  const signalDate = sessions.at(signalIndex)?.date
  if (challenger === undefined || signalDate === undefined) return fail('signal', 'decision boundary is missing')
  const selected = scores[challenger] > scores.SPY + frozenSpecification.success.hurdle ? challenger : ('SPY' as const)
  const weights = Object.fromEntries(
    candidate10Universe.map((symbol) => [symbol, symbol === selected ? 1 : 0] as const),
  ) as Readonly<Record<Candidate10Symbol, number>>
  return Result.succeed({
    signalDate,
    specification: frozenSpecification.success,
    scores,
    challenger,
    selected,
    weights,
  })
}

export const candidate10TerminalLiquidationIsComplete = (): Result.Result<boolean, Candidate10Failure> =>
  pipe(
    Result.all(
      candidate10Universe.map((symbol) =>
        pipe(
          makeOrderOutcome({
            identity: {
              schemaVersion: ContractVersion.PartialFillSeed,
              signalDate: candidate10Protocol.schedule.terminalSignalDate,
              executionDate: candidate10Protocol.schedule.terminalExecutionDate,
              symbol,
              side: 'sell',
            },
            side: 'sell',
            requestedQuantityMicros: 1n,
            referencePriceMicros: 1n,
            model: candidate10SimulationProtocol.executionModel,
          }),
          Result.mapError(
            (cause): Candidate10Failure => ({
              _tag: 'Candidate10InvalidInput',
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

const allCashWeights = (): Readonly<Record<Candidate10Symbol, number>> =>
  Object.fromEntries(candidate10Universe.map((symbol) => [symbol, 0] as const)) as Readonly<
    Record<Candidate10Symbol, number>
  >

export const buildCandidate10Plan = (
  sessions: readonly AlignedSession[],
  preflight: CandidateDevelopmentPreflightPass,
  specification: Candidate10Specification,
): Result.Result<Candidate10Plan, Candidate10Failure> => {
  if (sessions.length === 0) return fail('plan', 'sessions are empty')
  const simulationStartIndex = preflight.firstEligibleExecution.executionIndex
  const evaluationStartIndex = preflight.selectedObservationStartIndex
  if (simulationStartIndex >= evaluationStartIndex) {
    return fail('plan', `warm-up execution ${simulationStartIndex} must precede evaluation ${evaluationStartIndex}`)
  }
  const signalDates = new Set(officialMonthEndSignalDates(sessions.map((session) => session.date)))
  const targets: SimulationTarget[] = []
  const warmupDecision = candidate10DecisionAtSignal(
    sessions,
    preflight.firstEligibleExecution.signalIndex,
    specification,
  )
  if (Result.isFailure(warmupDecision)) return Result.fail(warmupDecision.failure)
  targets.push({
    signalIndex: preflight.firstEligibleExecution.signalIndex,
    executionIndex: simulationStartIndex,
    weights: warmupDecision.success.weights,
  })
  for (
    let signalIndex = preflight.firstEligibleExecution.signalIndex + 1;
    signalIndex < sessions.length - 1;
    signalIndex += 1
  ) {
    const signal = sessions.at(signalIndex)
    const execution = sessions.at(signalIndex + 1)
    if (signal === undefined || execution === undefined || !signalDates.has(signal.date)) continue
    const decision = candidate10DecisionAtSignal(sessions, signalIndex, specification)
    if (Result.isFailure(decision)) return Result.fail(decision.failure)
    targets.push({ signalIndex, executionIndex: signalIndex + 1, weights: decision.success.weights })
  }
  const terminalExecutionIndex = sessions.length - 1
  const terminalSignalIndex = terminalExecutionIndex - 1
  const terminalSignal = sessions.at(terminalSignalIndex)?.date
  const terminalExecution = sessions.at(terminalExecutionIndex)?.date
  if (
    terminalSignal !== candidate10Protocol.schedule.terminalSignalDate ||
    terminalExecution !== candidate10Protocol.schedule.terminalExecutionDate
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
