import { Result, pipe } from 'effect'

import { TRADING_DAYS, mean, requiredRecordValue } from '../../simulation'
import type { RiskBalancedTrendFailure } from '../../risk-balanced-trend/model'
import { fail, finite } from './shared'

const covariance = (
  left: readonly number[],
  right: readonly number[],
): Result.Result<number, RiskBalancedTrendFailure> => {
  if (left.length !== right.length || left.length < 2) {
    return fail({
      _tag: 'CovarianceInputMismatch',
      leftCount: left.length,
      rightCount: right.length,
      minimumCount: 2,
    })
  }
  return pipe(
    Result.all({ leftMean: mean(left), rightMean: mean(right) }),
    Result.flatMap(({ leftMean, rightMean }) =>
      pipe(
        Result.all(
          left.map((value, index) => {
            const paired = right.at(index)
            return paired === undefined
              ? fail({
                  _tag: 'CovarianceInputMismatch',
                  leftCount: left.length,
                  rightCount: index,
                  minimumCount: 2,
                })
              : Result.succeed((value - leftMean) * (paired - rightMean))
          }),
        ),
        Result.flatMap((products) =>
          finite(products.reduce((total, product) => total + product, 0) / (left.length - 1), 'covariance'),
        ),
      ),
    ),
  )
}

const portfolioVarianceRow = (
  left: string,
  symbols: readonly string[],
  weights: Readonly<Record<string, number>>,
  returns: Readonly<Record<string, readonly number[]>>,
): Result.Result<number, RiskBalancedTrendFailure> =>
  pipe(
    Result.all({
      leftReturns: requiredRecordValue(returns, left, 'price', 'portfolio returns'),
      leftWeight: requiredRecordValue(weights, left, 'target-weight', 'portfolio weights'),
    }),
    Result.flatMap(({ leftReturns, leftWeight }) =>
      pipe(
        Result.all(
          symbols.map((right) =>
            pipe(
              Result.all({
                covariance: pipe(
                  requiredRecordValue(returns, right, 'price', 'portfolio returns'),
                  Result.flatMap((rightReturns) => covariance(leftReturns, rightReturns)),
                ),
                rightWeight: requiredRecordValue(weights, right, 'target-weight', 'portfolio weights'),
              }),
              Result.map(({ covariance: value, rightWeight }) => leftWeight * rightWeight * value),
            ),
          ),
        ),
        Result.map((terms) => terms.reduce((total, term) => total + term, 0)),
      ),
    ),
  )

export const annualizedPortfolioVolatility = (
  weights: Readonly<Record<string, number>>,
  returns: Readonly<Record<string, readonly number[]>>,
): Result.Result<number, RiskBalancedTrendFailure> => {
  const symbols = Object.keys(weights).sort()
  return pipe(
    Result.all(symbols.map((left) => portfolioVarianceRow(left, symbols, weights, returns))),
    Result.flatMap((rows) => {
      const dailyVariance = rows.reduce((total, row) => total + row, 0)
      if (!Number.isFinite(dailyVariance) || dailyVariance < -1e-12) {
        return fail({
          _tag: 'InvalidRiskBalancedTrendNumber',
          operation: 'portfolio-variance',
          value: dailyVariance,
          symbol: null,
          reason: Number.isFinite(dailyVariance) ? 'negative' : 'not-finite',
        })
      }
      return finite(Math.sqrt(Math.max(0, dailyVariance) * TRADING_DAYS), 'annualized-portfolio-volatility')
    }),
  )
}
