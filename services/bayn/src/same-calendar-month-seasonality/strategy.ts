import { pipe, Result } from 'effect'

import { officialMonthEndSignalDates, type CandidateDevelopmentPreflightPass } from '../candidate-development'
import { makeOrderOutcome } from '../execution-model'
import type { AlignedSession, SimulationTarget } from '../simulation'
import { ContractVersion, type DailyBar, type IsoDate } from '../types'
import {
  candidate12Protocol,
  candidate12SimulationProtocol,
  candidate12Specifications,
  candidate12Universe,
  type Candidate12Failure,
  type Candidate12Plan,
  type Candidate12Specification,
  type Candidate12Symbol,
} from './model'

export interface Candidate12SeasonalMonthFeature {
  readonly symbol: Candidate12Symbol
  readonly sourceMonth: string
  readonly firstSession: IsoDate
  readonly lastSession: IsoDate
  readonly seasonalReturn: number
}

export interface Candidate12ChallengerFeature extends Candidate12SeasonalMonthFeature {
  readonly symbol: Exclude<Candidate12Symbol, 'SPY'>
  readonly seasonalExcess: number
  readonly eligible: boolean
}

export interface Candidate12SignalDecision {
  readonly signalDate: IsoDate
  readonly executionDate: IsoDate
  readonly targetMonth: string
  readonly sourceMonth: string
  readonly specification: Candidate12Specification
  readonly spy: Candidate12SeasonalMonthFeature
  readonly challengers: readonly Candidate12ChallengerFeature[]
  readonly selectedSymbol: Candidate12Symbol
  readonly weights: Readonly<Record<Candidate12Symbol, number>>
}

const fail = <A>(operation: string, reason: string): Result.Result<A, Candidate12Failure> =>
  Result.fail({ _tag: 'Candidate12InvalidInput', operation, reason })

const round = (value: number): number => Number.parseFloat(value.toFixed(12))

const validBar = (bar: DailyBar): boolean =>
  [bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0) &&
  Number.isFinite(bar.volume) &&
  bar.volume >= 0 &&
  bar.low <= Math.min(bar.open, bar.close) &&
  bar.high >= Math.max(bar.open, bar.close)

const exactSpecification = (
  specification: Candidate12Specification,
): Result.Result<Candidate12Specification, Candidate12Failure> => {
  const frozen = candidate12Specifications.at(0)
  if (frozen === undefined) return fail('specification', 'frozen specification is missing')
  const matches = Object.entries(frozen).every(([key, value]) => Reflect.get(specification, key) === value)
  return matches && Object.keys(specification).length === Object.keys(frozen).length
    ? Result.succeed(frozen)
    : fail('specification', `unregistered specification ${specification.id}`)
}

const calendarMonth = (date: IsoDate): string => date.slice(0, 7)

const priorSeasonMonth = (
  executionDate: IsoDate,
  annualLagYears: number,
): Result.Result<string, Candidate12Failure> => {
  const executionYear = Number(executionDate.slice(0, 4))
  if (!Number.isSafeInteger(executionYear) || !Number.isSafeInteger(annualLagYears) || annualLagYears <= 0) {
    return fail('seasonal-month', 'execution year and annual lag must be positive integers')
  }
  return Result.succeed(`${String(executionYear - annualLagYears).padStart(4, '0')}-${executionDate.slice(5, 7)}`)
}

const seasonalMonthBars = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  symbol: Candidate12Symbol,
  sourceMonth: string,
): Result.Result<readonly DailyBar[], Candidate12Failure> => {
  if (!Number.isSafeInteger(signalIndex) || signalIndex < 0 || signalIndex >= sessions.length) {
    return fail('seasonal-month', `signal index ${signalIndex} is outside the session calendar`)
  }

  const bars: DailyBar[] = []
  let firstSourceIndex: number | undefined
  for (let index = 0; index <= signalIndex; index += 1) {
    const session = sessions.at(index)
    if (session === undefined || calendarMonth(session.date) !== sourceMonth) continue
    const bar = session.bars[symbol]
    if (bar === undefined) return fail('seasonal-month', `${symbol} is missing on ${session.date}`)
    if (bar.sessionDate !== session.date) {
      return fail('seasonal-month', `${symbol} bar date ${bar.sessionDate} differs from ${session.date}`)
    }
    if (!validBar(bar)) return fail('seasonal-month', `malformed bar ${symbol}:${session.date}`)
    firstSourceIndex ??= index
    bars.push(bar)
  }

  if (bars.length === 0 || firstSourceIndex === undefined) {
    return fail('seasonal-month', `${symbol} has no finalized bars for ${sourceMonth}`)
  }
  const lagSessions = signalIndex - firstSourceIndex
  if (lagSessions > candidate12Protocol.feature.declaredLookbackSessions) {
    return fail(
      'seasonal-month',
      `${sourceMonth} begins ${lagSessions} sessions before the signal, exceeding ${candidate12Protocol.feature.declaredLookbackSessions}`,
    )
  }
  return Result.succeed(bars)
}

export const sameCalendarMonthReturn = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  executionIndex: number,
  symbol: Candidate12Symbol,
  annualLagYears: number,
): Result.Result<Candidate12SeasonalMonthFeature, Candidate12Failure> => {
  if (executionIndex !== signalIndex + 1) {
    return fail('seasonal-return', `execution index ${executionIndex} is not one session after signal ${signalIndex}`)
  }
  const signal = sessions.at(signalIndex)
  const execution = sessions.at(executionIndex)
  if (signal === undefined || execution === undefined)
    return fail('seasonal-return', 'signal or execution session is missing')
  if (execution.date <= signal.date) return fail('seasonal-return', 'execution session is not after the signal session')

  const sourceMonth = priorSeasonMonth(execution.date, annualLagYears)
  if (Result.isFailure(sourceMonth)) return Result.fail(sourceMonth.failure)
  const bars = seasonalMonthBars(sessions, signalIndex, symbol, sourceMonth.success)
  if (Result.isFailure(bars)) return Result.fail(bars.failure)
  const first = bars.success.at(0)
  const last = bars.success.at(-1)
  if (first === undefined || last === undefined) return fail('seasonal-return', `${sourceMonth.success} is empty`)
  const seasonalReturn = last.close / first.open - 1
  return Number.isFinite(seasonalReturn)
    ? Result.succeed({
        symbol,
        sourceMonth: sourceMonth.success,
        firstSession: first.sessionDate,
        lastSession: last.sessionDate,
        seasonalReturn: round(seasonalReturn),
      })
    : fail('seasonal-return', `${sourceMonth.success} return is not finite`)
}

const selectedWeights = (selected: Candidate12Symbol): Readonly<Record<Candidate12Symbol, number>> =>
  Object.fromEntries(candidate12Universe.map((symbol) => [symbol, symbol === selected ? 1 : 0] as const)) as Readonly<
    Record<Candidate12Symbol, number>
  >

export const candidate12DecisionAtSignal = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  specification: Candidate12Specification,
): Result.Result<Candidate12SignalDecision, Candidate12Failure> => {
  const frozenSpecification = exactSpecification(specification)
  if (Result.isFailure(frozenSpecification)) return Result.fail(frozenSpecification.failure)
  const signalDate = sessions.at(signalIndex)?.date
  const executionIndex = signalIndex + 1
  const executionDate = sessions.at(executionIndex)?.date
  if (signalDate === undefined || executionDate === undefined)
    return fail('signal', 'signal or next execution is missing')

  const spy = sameCalendarMonthReturn(
    sessions,
    signalIndex,
    executionIndex,
    'SPY',
    frozenSpecification.success.annualLagYears,
  )
  if (Result.isFailure(spy)) return Result.fail(spy.failure)

  const challengers: Candidate12ChallengerFeature[] = []
  for (const symbol of candidate12Universe) {
    if (symbol === 'SPY') continue
    const feature = sameCalendarMonthReturn(
      sessions,
      signalIndex,
      executionIndex,
      symbol,
      frozenSpecification.success.annualLagYears,
    )
    if (Result.isFailure(feature)) return Result.fail(feature.failure)
    const seasonalExcess = round(feature.success.seasonalReturn - spy.success.seasonalReturn)
    challengers.push({
      ...feature.success,
      symbol,
      seasonalExcess,
      eligible: seasonalExcess > frozenSpecification.success.minimumSeasonalExcess,
    })
  }

  const selectedSymbol =
    challengers
      .filter((challenger) => challenger.eligible)
      .toSorted(
        (left, right) =>
          right.seasonalExcess - left.seasonalExcess ||
          right.seasonalReturn - left.seasonalReturn ||
          left.symbol.localeCompare(right.symbol),
      )
      .at(0)?.symbol ?? 'SPY'

  return Result.succeed({
    signalDate,
    executionDate,
    targetMonth: calendarMonth(executionDate),
    sourceMonth: spy.success.sourceMonth,
    specification: frozenSpecification.success,
    spy: spy.success,
    challengers,
    selectedSymbol,
    weights: selectedWeights(selectedSymbol),
  })
}

export const candidate12TerminalLiquidationIsComplete = (): Result.Result<boolean, Candidate12Failure> =>
  pipe(
    Result.all(
      candidate12Universe.map((symbol) =>
        pipe(
          makeOrderOutcome({
            identity: {
              schemaVersion: ContractVersion.PartialFillSeed,
              signalDate: candidate12Protocol.schedule.terminalSignalDate,
              executionDate: candidate12Protocol.schedule.terminalExecutionDate,
              symbol,
              side: 'sell',
            },
            side: 'sell',
            requestedQuantityMicros: 1n,
            referencePriceMicros: 1n,
            model: candidate12SimulationProtocol.executionModel,
          }),
          Result.mapError(
            (cause): Candidate12Failure => ({
              _tag: 'Candidate12InvalidInput',
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

const allCashWeights = (): Readonly<Record<Candidate12Symbol, number>> =>
  Object.fromEntries(candidate12Universe.map((symbol) => [symbol, 0] as const)) as Readonly<
    Record<Candidate12Symbol, number>
  >

export const buildCandidate12Plan = (
  sessions: readonly AlignedSession[],
  preflight: CandidateDevelopmentPreflightPass,
  specification: Candidate12Specification,
): Result.Result<Candidate12Plan, Candidate12Failure> => {
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
    const decision = candidate12DecisionAtSignal(sessions, signalIndex, specification)
    if (Result.isFailure(decision)) return Result.fail(decision.failure)
    targets.push({ signalIndex, executionIndex: signalIndex + 1, weights: decision.success.weights })
  }

  const terminalExecutionIndex = sessions.length - 1
  const terminalSignalIndex = terminalExecutionIndex - 1
  const terminalSignal = sessions.at(terminalSignalIndex)?.date
  const terminalExecution = sessions.at(terminalExecutionIndex)?.date
  if (
    terminalSignal !== candidate12Protocol.schedule.terminalSignalDate ||
    terminalExecution !== candidate12Protocol.schedule.terminalExecutionDate
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
