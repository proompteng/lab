import { pipe, Result } from 'effect'

import { roundWeight, type AlignedSession, type SimulationTarget } from '../simulation'
import type { IsoDate } from '../types'
import {
  CANDIDATE_7_DEVELOPMENT_END,
  CANDIDATE_7_EVALUATION_START,
  CANDIDATE_7_TERMINAL_SIGNAL,
  CANDIDATE_7_UNIVERSE,
  candidate7Protocol,
  type Candidate7Decision,
  type Candidate7Failure,
  type Candidate7Signal,
  type Candidate7Symbol,
} from './model'

const fail = <A>(failure: Candidate7Failure): Result.Result<A, Candidate7Failure> => Result.fail(failure)

const requiredSession = (
  sessions: readonly AlignedSession[],
  index: number,
  signalIndex: number,
): Result.Result<AlignedSession, Candidate7Failure> => {
  const session = sessions.at(index)
  return session === undefined
    ? fail({ _tag: 'Candidate7InvalidSignal', reason: `missing session index ${index}`, signalIndex })
    : Result.succeed(session)
}

const requiredClose = (
  sessions: readonly AlignedSession[],
  index: number,
  symbol: Candidate7Symbol,
  signalIndex: number,
): Result.Result<number, Candidate7Failure> =>
  pipe(
    requiredSession(sessions, index, signalIndex),
    Result.flatMap((session) => {
      const bar = Reflect.get(session.bars, symbol)
      return bar === undefined
        ? fail({ _tag: 'Candidate7MissingBar', symbol, sessionDate: session.date })
        : Number.isFinite(bar.close) && bar.close > 0
          ? Result.succeed(bar.close)
          : fail({
              _tag: 'Candidate7InvalidBar',
              reason: 'close must be finite and positive',
              symbol,
              sessionDate: session.date,
            })
    }),
  )

const scoreSymbol = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  symbol: Candidate7Symbol,
): Result.Result<{ readonly symbol: Candidate7Symbol; readonly score: number }, Candidate7Failure> =>
  pipe(
    Result.all({
      recent: requiredClose(sessions, signalIndex - candidate7Protocol.signal.skipRecentSessions, symbol, signalIndex),
      distant: requiredClose(sessions, signalIndex - candidate7Protocol.signal.lookbackSessions, symbol, signalIndex),
    }),
    Result.flatMap(({ distant, recent }) => {
      const score = recent / distant - 1
      return Number.isFinite(score)
        ? Result.succeed({ symbol, score })
        : fail({ _tag: 'Candidate7InvalidSignal', reason: `${symbol} score is not finite`, signalIndex })
    }),
  )

const symbolReturns = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  symbol: Candidate7Symbol,
): Result.Result<readonly number[], Candidate7Failure> =>
  Result.all(
    Array.from({ length: candidate7Protocol.risk.covarianceWindowSessions }, (_, offset) => {
      const currentIndex = signalIndex - candidate7Protocol.risk.covarianceWindowSessions + 1 + offset
      return pipe(
        Result.all({
          previous: requiredClose(sessions, currentIndex - 1, symbol, signalIndex),
          current: requiredClose(sessions, currentIndex, symbol, signalIndex),
        }),
        Result.flatMap(({ current, previous }) => {
          const value = current / previous - 1
          return Number.isFinite(value)
            ? Result.succeed(value)
            : fail({ _tag: 'Candidate7InvalidSignal', reason: `${symbol} return is not finite`, signalIndex })
        }),
      )
    }),
  )

const average = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length

const sampleCovariance = (left: readonly number[], right: readonly number[]): number => {
  if (left.length !== right.length || left.length < 2) return 0
  const leftAverage = average(left)
  const rightAverage = average(right)
  return (
    left.reduce(
      (total, value, index) => total + (value - leftAverage) * ((right.at(index) ?? rightAverage) - rightAverage),
      0,
    ) /
    (left.length - 1)
  )
}

const selectedPortfolioVolatility = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  selected: readonly Candidate7Symbol[],
): Result.Result<number, Candidate7Failure> => {
  if (selected.length === 0) return Result.succeed(0)
  return pipe(
    Result.all(selected.map((symbol) => symbolReturns(sessions, signalIndex, symbol))),
    Result.flatMap((returns) => {
      const weight = 1 / selected.length
      const dailyVariance = returns.reduce(
        (rowTotal, left) =>
          rowTotal +
          returns.reduce((columnTotal, right) => columnTotal + weight * weight * sampleCovariance(left, right), 0),
        0,
      )
      const annualized =
        Math.sqrt(Math.max(0, dailyVariance)) * Math.sqrt(candidate7Protocol.risk.annualizationSessions)
      return Number.isFinite(annualized)
        ? Result.succeed(annualized)
        : fail({ _tag: 'Candidate7InvalidSignal', reason: 'portfolio volatility is not finite', signalIndex })
    }),
  )
}

const canonicalZeroWeights = (): Readonly<Record<Candidate7Symbol, number>> =>
  Object.fromEntries(CANDIDATE_7_UNIVERSE.map((symbol) => [symbol, 0])) as Record<Candidate7Symbol, number>

export const makeCandidate7Decision = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
): Result.Result<Candidate7Decision, Candidate7Failure> => {
  if (!Number.isSafeInteger(signalIndex) || signalIndex < candidate7Protocol.signal.lookbackSessions) {
    return fail({ _tag: 'Candidate7InvalidSignal', reason: 'insufficient lookback history', signalIndex })
  }
  return pipe(
    Result.all({
      signalSession: requiredSession(sessions, signalIndex, signalIndex),
      executionSession: requiredSession(sessions, signalIndex + 1, signalIndex),
      covarianceStart: requiredSession(
        sessions,
        signalIndex - candidate7Protocol.risk.covarianceWindowSessions,
        signalIndex,
      ),
      ranked: pipe(
        Result.all(CANDIDATE_7_UNIVERSE.map((symbol) => scoreSymbol(sessions, signalIndex, symbol))),
        Result.map((scores) =>
          scores.toSorted((left, right) => right.score - left.score || left.symbol.localeCompare(right.symbol)),
        ),
      ),
    }),
    Result.flatMap(({ covarianceStart, executionSession, ranked, signalSession }) => {
      if (executionSession.date > CANDIDATE_7_DEVELOPMENT_END) {
        return fail({ _tag: 'Candidate7InvalidSignal', reason: 'execution crosses development boundary', signalIndex })
      }
      const selected = ranked
        .filter(({ score }) => score > 0)
        .slice(0, candidate7Protocol.signal.selectedAssetCount)
        .map(({ symbol }) => symbol)
      return pipe(
        selectedPortfolioVolatility(sessions, signalIndex, selected),
        Result.flatMap((estimatedAnnualizedVolatility) => {
          const exposureScale =
            selected.length === 0 || estimatedAnnualizedVolatility <= 0
              ? 0
              : Math.min(1, candidate7Protocol.risk.targetAnnualizedVolatility / estimatedAnnualizedVolatility)
          const rawWeight = selected.length === 0 ? 0 : exposureScale / selected.length
          const boundedWeight = Math.min(candidate7Protocol.risk.maximumSymbolWeight, rawWeight)
          return pipe(
            roundWeight(boundedWeight),
            Result.mapError(
              (cause): Candidate7Failure => ({
                _tag: 'Candidate7InvalidSignal',
                reason: `weight quantization failed: ${cause._tag}`,
                signalIndex,
              }),
            ),
            Result.map((weight) => {
              const targetWeights = {
                ...canonicalZeroWeights(),
                ...Object.fromEntries(selected.map((symbol) => [symbol, weight])),
              } as Readonly<Record<Candidate7Symbol, number>>
              const selectedSet = new Set(selected)
              const signals: Candidate7Signal[] = ranked.map(({ score, symbol }, index) => ({
                symbol,
                score,
                rank: index + 1,
                selected: selectedSet.has(symbol),
                targetWeight: targetWeights[symbol],
              }))
              return {
                signalDate: signalSession.date,
                executionDate: executionSession.date,
                covarianceStart: covarianceStart.date,
                covarianceEnd: signalSession.date,
                estimatedAnnualizedVolatility,
                exposureScale,
                signals,
                targetWeights,
              }
            }),
          )
        }),
      )
    }),
  )
}

const isMonthEndSignal = (sessions: readonly AlignedSession[], index: number): boolean => {
  const current = sessions.at(index)
  const next = sessions.at(index + 1)
  return current !== undefined && next !== undefined && current.date.slice(0, 7) !== next.date.slice(0, 7)
}

export interface Candidate7Plan {
  readonly decisions: readonly Candidate7Decision[]
  readonly targets: readonly SimulationTarget[]
  readonly rebalanceExecutionDates: readonly IsoDate[]
  readonly startIndex: number
}

export const buildCandidate7Plan = (
  sessions: readonly AlignedSession[],
): Result.Result<Candidate7Plan, Candidate7Failure> => {
  const signalIndices = sessions
    .map((_, index) => index)
    .filter(
      (index) =>
        index >= candidate7Protocol.signal.lookbackSessions &&
        isMonthEndSignal(sessions, index) &&
        (sessions.at(index + 1)?.date ?? '') >= CANDIDATE_7_EVALUATION_START &&
        (sessions.at(index + 1)?.date ?? '') < CANDIDATE_7_DEVELOPMENT_END,
    )
  return pipe(
    Result.all(signalIndices.map((index) => makeCandidate7Decision(sessions, index))),
    Result.flatMap((decisions) => {
      const terminalSignalIndex = sessions.findIndex((session) => session.date === CANDIDATE_7_TERMINAL_SIGNAL)
      const terminalExecutionIndex = sessions.findIndex((session) => session.date === CANDIDATE_7_DEVELOPMENT_END)
      const firstExecutionIndex = signalIndices.at(0) === undefined ? -1 : (signalIndices.at(0) ?? -2) + 1
      if (terminalSignalIndex < 0 || terminalExecutionIndex !== terminalSignalIndex + 1 || firstExecutionIndex < 1) {
        return fail({
          _tag: 'Candidate7InvalidSignal',
          reason: 'development schedule lacks an eligible start or terminal liquidation',
          signalIndex: terminalSignalIndex,
        })
      }
      const targets: SimulationTarget[] = [
        ...decisions.map((decision, index) => ({
          signalIndex: signalIndices.at(index) ?? -1,
          executionIndex: (signalIndices.at(index) ?? -2) + 1,
          weights: decision.targetWeights,
        })),
        {
          signalIndex: terminalSignalIndex,
          executionIndex: terminalExecutionIndex,
          weights: canonicalZeroWeights(),
        },
      ]
      return Result.succeed({
        decisions,
        targets,
        rebalanceExecutionDates: targets
          .map((target) => sessions.at(target.executionIndex)?.date ?? '')
          .filter(Boolean) as IsoDate[],
        startIndex: firstExecutionIndex,
      })
    }),
  )
}
