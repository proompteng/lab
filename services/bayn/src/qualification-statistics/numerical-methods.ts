import { pipe, Result } from 'effect'

import { statisticsFailure, type QualificationStatisticsFailure } from './failure'
import { Pipeable } from '../pipeable'

export const roundStatistic = (value: number): Result.Result<number, QualificationStatisticsFailure> =>
  Number.isFinite(value)
    ? Result.succeed(Number.parseFloat(value.toFixed(12)))
    : statisticsFailure({ _tag: 'QualificationStatisticNotFinite', operation: 'round', value })

export const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length

export const sampleStandardDeviation = (values: readonly number[]): number => {
  if (values.length < 2) return 0
  const average = mean(values)
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)
  return Math.sqrt(Math.max(0, variance))
}

const annualizedSharpeDataFirst = (returns: readonly number[], annualizationSessions: number): number => {
  const volatility = sampleStandardDeviation(returns)
  return volatility === 0 ? 0 : (mean(returns) / volatility) * Math.sqrt(annualizationSessions)
}

export const annualizedSharpe = Pipeable.dual(2, annualizedSharpeDataFirst)

const nearestRankLowerQuantileDataFirst = (values: readonly number[], probability: number): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.max(1, Math.ceil(probability * sorted.length))
  return sorted.at(rank - 1) ?? 0
}

export const nearestRankLowerQuantile = Pipeable.dual(2, nearestRankLowerQuantileDataFirst)

export const compoundedReturn = (returns: readonly number[]): number =>
  returns.reduce((growth, value) => growth * (1 + value), 1) - 1

export const maximumDrawdown = (returns: readonly number[]): Result.Result<number, QualificationStatisticsFailure> => {
  const state = returns.reduce(
    (current, value) => {
      const equity = current.equity * (1 + value)
      const peak = Math.max(current.peak, equity)
      return { equity, peak, drawdown: Math.max(current.drawdown, 1 - equity / peak) }
    },
    { equity: 1, peak: 1, drawdown: 0 },
  )
  return pipe(state.drawdown, roundStatistic)
}
