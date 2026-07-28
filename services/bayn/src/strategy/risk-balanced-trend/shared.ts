import { Result } from 'effect'

import type { Protocol } from '../../types'
import type { RiskBalancedTrendFailure } from '../../risk-balanced-trend/model'

export const WEIGHT_SCALE = 1_000_000_000_000

export const compareKeys = ([left]: readonly [string, unknown], [right]: readonly [string, unknown]): number =>
  left < right ? -1 : left > right ? 1 : 0

export const fail = <A = never>(failure: RiskBalancedTrendFailure): Result.Result<A, RiskBalancedTrendFailure> =>
  Result.fail(failure)

export const requiredHistory = (protocol: Protocol): number => Math.max(protocol.volatilityWindow, ...protocol.horizons)

export const finite = (
  value: number,
  operation: Extract<RiskBalancedTrendFailure, { readonly _tag: 'InvalidRiskBalancedTrendNumber' }>['operation'],
  symbol: string | null = null,
): Result.Result<number, RiskBalancedTrendFailure> =>
  !Number.isFinite(value)
    ? fail({ _tag: 'InvalidRiskBalancedTrendNumber', operation, value, symbol, reason: 'not-finite' })
    : value < 0 && operation === 'portfolio-variance'
      ? fail({ _tag: 'InvalidRiskBalancedTrendNumber', operation, value, symbol, reason: 'negative' })
      : Result.succeed(value)

export const dailyReturns = (
  closes: readonly number[],
  count: number,
  symbol: string,
): Result.Result<readonly number[], RiskBalancedTrendFailure> => {
  const window = closes.slice(-(count + 1))
  if (window.length !== count + 1) {
    return fail({
      _tag: 'RiskBalancedTrendCloseHistoryMismatch',
      symbol,
      expectedCount: count + 1,
      observedCount: window.length,
    })
  }
  return Result.all(
    window.slice(1).map((close, index) => {
      const previous = window.at(index)
      return previous === undefined
        ? fail({
            _tag: 'RiskBalancedTrendCloseHistoryMismatch',
            symbol,
            expectedCount: count + 1,
            observedCount: index,
          })
        : finite(close / previous - 1, 'daily-return', symbol)
    }),
  )
}
