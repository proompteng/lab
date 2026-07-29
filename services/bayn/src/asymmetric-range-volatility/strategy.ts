import { pipe, Result } from 'effect'

import { officialMonthEndSignalDates, type CandidateDevelopmentPreflightPass } from '../candidate-development'
import { makeOrderOutcome } from '../execution-model'
import { roundWeight, type AlignedSession, type SimulationTarget } from '../simulation'
import { ContractVersion, type DailyBar, type IsoDate } from '../types'
import {
  CANDIDATE_9_SYMBOL,
  candidate9Protocol,
  candidate9SimulationProtocol,
  type Candidate9Failure,
  type Candidate9Plan,
} from './model'

const fail = <A>(operation: string, reason: string): Result.Result<A, Candidate9Failure> =>
  Result.fail({ _tag: 'Candidate9InvalidInput', operation, reason })

const validBar = (bar: DailyBar): boolean =>
  [bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0) &&
  Number.isFinite(bar.volume) &&
  bar.volume >= 0 &&
  bar.low <= Math.min(bar.open, bar.close) &&
  bar.high >= Math.max(bar.open, bar.close)

export const asymmetricRangeForecastVariance = (
  history: readonly DailyBar[],
): Result.Result<number, Candidate9Failure> => {
  const required = candidate9Protocol.feature.sessions + 1
  if (history.length !== required) return fail('forecast', `expected ${required} bars, observed ${history.length}`)
  if (history.some((bar) => !validBar(bar))) return fail('forecast', 'history contains a malformed bar')
  const terms: number[] = []
  for (let index = 1; index < history.length; index += 1) {
    const previous = history[index - 1]
    const current = history[index]
    if (previous === undefined || current === undefined) return fail('forecast', 'history boundary is missing')
    const rangeVariance = Math.log(current.high / current.low) ** 2 / (4 * Math.log(2))
    const closeReturn = Math.log(current.close / previous.close)
    const negativeVariance = Math.min(closeReturn, 0) ** 2
    const term = rangeVariance + candidate9Protocol.feature.negativeSemivarianceMultiplier * negativeVariance
    if (!Number.isFinite(term) || term < 0) return fail('forecast', 'variance term is invalid')
    terms.push(term)
  }
  const forecast = terms.reduce((sum, value) => sum + value, 0) / terms.length
  return Number.isFinite(forecast) && forecast > 0
    ? Result.succeed(forecast)
    : fail('forecast', 'forecast variance must be finite and positive')
}

export const asymmetricRangeTargetWeight = (
  forecastDailyVariance: number,
): Result.Result<number, Candidate9Failure> => {
  if (!Number.isFinite(forecastDailyVariance) || forecastDailyVariance <= 0) {
    return fail('target-weight', 'forecast variance must be finite and positive')
  }
  const targetDailyVariance =
    candidate9Protocol.allocation.targetAnnualizedVariance / candidate9Protocol.feature.annualizationSessions
  const unrounded = Math.min(candidate9Protocol.allocation.maximumWeight, targetDailyVariance / forecastDailyVariance)
  return pipe(
    roundWeight(unrounded),
    Result.mapError(
      (cause): Candidate9Failure => ({
        _tag: 'Candidate9InvalidInput',
        operation: 'target-weight',
        reason: cause._tag,
      }),
    ),
  )
}

export const candidate9WeightAtSignal = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
): Result.Result<number, Candidate9Failure> => {
  const first = signalIndex - candidate9Protocol.feature.sessions
  if (first < 0 || signalIndex >= sessions.length)
    return fail('signal', `signal index ${signalIndex} lacks causal history`)
  const history: DailyBar[] = []
  for (let index = first; index <= signalIndex; index += 1) {
    const session = sessions[index]
    if (session === undefined) return fail('signal', `session ${index} is missing`)
    const bar = session.bars[CANDIDATE_9_SYMBOL]
    if (bar === undefined) return fail('signal', `${CANDIDATE_9_SYMBOL} is missing on ${session.date}`)
    if (bar.sessionDate !== session.date)
      return fail('signal', `bar date ${bar.sessionDate} differs from ${session.date}`)
    history.push(bar)
  }
  return pipe(asymmetricRangeForecastVariance(history), Result.flatMap(asymmetricRangeTargetWeight))
}

export const candidate9TerminalLiquidationIsComplete = (): Result.Result<boolean, Candidate9Failure> =>
  pipe(
    makeOrderOutcome({
      identity: {
        schemaVersion: ContractVersion.PartialFillSeed,
        signalDate: candidate9Protocol.schedule.terminalSignalDate,
        executionDate: candidate9Protocol.schedule.terminalExecutionDate,
        symbol: CANDIDATE_9_SYMBOL,
        side: 'sell',
      },
      side: 'sell',
      requestedQuantityMicros: 1n,
      referencePriceMicros: 1n,
      model: candidate9SimulationProtocol.executionModel,
    }),
    Result.mapError(
      (cause): Candidate9Failure => ({
        _tag: 'Candidate9InvalidInput',
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
  )

export const buildCandidate9Plan = (
  sessions: readonly AlignedSession[],
  preflight: CandidateDevelopmentPreflightPass,
): Result.Result<Candidate9Plan, Candidate9Failure> => {
  if (sessions.length === 0) return fail('plan', 'sessions are empty')
  const startIndex = preflight.selectedObservationStartIndex
  const signalDates = new Set(officialMonthEndSignalDates(sessions.map((session) => session.date)))
  const targets: SimulationTarget[] = []
  for (let signalIndex = startIndex; signalIndex < sessions.length - 1; signalIndex += 1) {
    const signal = sessions[signalIndex]
    const execution = sessions[signalIndex + 1]
    if (signal === undefined || execution === undefined || !signalDates.has(signal.date)) continue
    const weight = candidate9WeightAtSignal(sessions, signalIndex)
    if (Result.isFailure(weight)) return Result.fail(weight.failure)
    targets.push({
      signalIndex,
      executionIndex: signalIndex + 1,
      weights: { [CANDIDATE_9_SYMBOL]: weight.success },
    })
  }
  const terminalExecutionIndex = sessions.length - 1
  const terminalSignalIndex = terminalExecutionIndex - 1
  const terminalSignal = sessions[terminalSignalIndex]?.date
  const terminalExecution = sessions[terminalExecutionIndex]?.date
  if (
    terminalSignal !== candidate9Protocol.schedule.terminalSignalDate ||
    terminalExecution !== candidate9Protocol.schedule.terminalExecutionDate
  ) {
    return fail('plan', `terminal boundary is ${terminalSignal ?? 'missing'}->${terminalExecution ?? 'missing'}`)
  }
  targets.push({ signalIndex: terminalSignalIndex, executionIndex: terminalExecutionIndex, weights: { SPY: 0 } })
  if (targets.length < 2) return fail('plan', 'fewer than two rebalance targets')
  return Result.succeed({
    targets,
    rebalanceExecutionDates: targets
      .map((target) => sessions[target.executionIndex]?.date)
      .filter((date): date is IsoDate => date !== undefined),
    startIndex,
  })
}
