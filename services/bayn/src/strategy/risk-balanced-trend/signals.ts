import { Result, pipe } from 'effect'

import { TRADING_DAYS, requiredRecordValue, roundWeight, sampleStandardDeviation } from '../../simulation'
import type { Protocol, SymbolSignal } from '../../types'
import type { RiskBalancedTrendFailure } from '../../risk-balanced-trend/model'
import { dailyReturns, fail, finite } from './shared'

export interface PreparedSignal {
  readonly signal: Omit<SymbolSignal, 'uncappedWeight' | 'cappedWeight' | 'targetWeight'>
  readonly returns: readonly number[]
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right)
  const midpoint = Math.floor(sorted.length / 2)
  const upper = sorted.at(midpoint) ?? 0
  if (sorted.length % 2 === 1) return upper
  const lower = sorted.at(midpoint - 1) ?? upper
  return (lower + upper) / 2
}

const scoreSignal = (
  protocol: Protocol,
  horizons: readonly SymbolSignal['horizons'][number][],
  dailyVolatility: number,
  annualizedVolatility: number,
  symbol: string,
): Result.Result<Pick<SymbolSignal, 'compositeScore' | 'positiveScore' | 'eligible'>, RiskBalancedTrendFailure> => {
  if (horizons.length === 0) {
    return fail({
      _tag: 'InvalidRiskBalancedTrendNumber',
      operation: 'composite-score',
      value: Number.NaN,
      symbol,
      reason: 'not-finite',
    })
  }
  if (dailyVolatility === 0) {
    return Result.succeed({ compositeScore: 0, positiveScore: 0, eligible: false })
  }
  if (protocol.schemaVersion !== 'bayn.risk-balanced-trend.protocol.v4') {
    const total = horizons.reduce((sum, horizon) => sum + horizon.normalizedTrend, 0)
    return pipe(
      finite(total / horizons.length, 'composite-score', symbol),
      Result.map((compositeScore) => ({
        compositeScore,
        positiveScore: Math.max(0, compositeScore),
        eligible: true,
      })),
    )
  }
  const cap = protocol.signal.normalizedTrendCap
  const clipped = horizons.map(({ normalizedTrend }) => Math.max(-cap, Math.min(cap, normalizedTrend)))
  const compositeScore = median(clipped)
  const positiveHorizons = horizons.filter(({ normalizedTrend }) => normalizedTrend > 0).length
  const eligible = positiveHorizons >= protocol.signal.minimumPositiveHorizons && compositeScore > 0
  return pipe(
    Result.all({
      compositeScore: finite(compositeScore, 'composite-score', symbol),
      positiveScore: finite(eligible ? compositeScore / annualizedVolatility : 0, 'weight-allocation', symbol),
    }),
    Result.map(({ compositeScore: score, positiveScore }) => ({
      compositeScore: score,
      positiveScore,
      eligible,
    })),
  )
}

export const prepareSignal = (
  symbol: string,
  closes: Readonly<Record<string, readonly number[]>>,
  historyLength: number,
  protocol: Protocol,
): Result.Result<PreparedSignal, RiskBalancedTrendFailure> => {
  const history = Reflect.get(closes, symbol) as readonly number[] | undefined
  if (history === undefined || history.length !== historyLength) {
    return fail({
      _tag: 'RiskBalancedTrendCloseHistoryMismatch',
      symbol,
      expectedCount: historyLength,
      observedCount: history?.length ?? 0,
    })
  }
  const invalidIndex = history.findIndex((price) => !Number.isFinite(price) || price <= 0)
  if (invalidIndex >= 0) {
    return fail({
      _tag: 'InvalidRiskBalancedTrendClose',
      symbol,
      index: invalidIndex,
      value: history.at(invalidIndex) ?? Number.NaN,
    })
  }
  const current = history.at(-1)
  if (current === undefined) {
    return fail({ _tag: 'MissingRiskBalancedTrendClose', symbol, horizonSessions: null })
  }
  return pipe(
    dailyReturns(history, protocol.volatilityWindow, symbol),
    Result.flatMap((recentReturns) =>
      pipe(
        sampleStandardDeviation(recentReturns),
        Result.flatMap((dailyVolatility) =>
          pipe(
            finite(dailyVolatility * Math.sqrt(TRADING_DAYS), 'annualized-volatility', symbol),
            Result.flatMap((annualizedVolatility) =>
              pipe(
                Result.all(
                  protocol.horizons.map((horizonSessions) => {
                    const prior = history.at(history.length - 1 - horizonSessions)
                    if (prior === undefined) {
                      return fail({ _tag: 'MissingRiskBalancedTrendClose', symbol, horizonSessions })
                    }
                    return pipe(
                      finite(current / prior - 1, 'horizon-return', symbol),
                      Result.flatMap((value) =>
                        dailyVolatility === 0
                          ? Result.succeed({ horizonSessions, return: value, normalizedTrend: 0 })
                          : pipe(
                              finite(
                                value / (dailyVolatility * Math.sqrt(horizonSessions)),
                                'normalized-trend',
                                symbol,
                              ),
                              Result.map((normalizedTrend) => ({
                                horizonSessions,
                                return: value,
                                normalizedTrend,
                              })),
                            ),
                      ),
                    )
                  }),
                ),
                Result.flatMap((horizons) =>
                  pipe(
                    scoreSignal(protocol, horizons, dailyVolatility, annualizedVolatility, symbol),
                    Result.map((score) => ({
                      signal: {
                        symbol,
                        horizons,
                        dailyVolatility,
                        annualizedVolatility,
                        ...score,
                      },
                      returns: recentReturns,
                    })),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  )
}

export const finalizeSignals = (
  prepared: readonly PreparedSignal[],
  uncappedWeights: Readonly<Record<string, number>>,
  cappedWeights: Readonly<Record<string, number>>,
  targetWeights: Readonly<Record<string, number>>,
): Result.Result<readonly SymbolSignal[], RiskBalancedTrendFailure> =>
  Result.all(
    prepared.map(({ signal }) =>
      pipe(
        Result.all({
          uncappedWeight: pipe(
            requiredRecordValue(uncappedWeights, signal.symbol, 'target-weight', 'uncapped weights'),
            Result.flatMap(roundWeight),
          ),
          cappedWeight: requiredRecordValue(cappedWeights, signal.symbol, 'target-weight', 'capped weights'),
          targetWeight: requiredRecordValue(targetWeights, signal.symbol, 'target-weight', 'target weights'),
        }),
        Result.map((weights) => ({ ...signal, ...weights })),
      ),
    ),
  )
