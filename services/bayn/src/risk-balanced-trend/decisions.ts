import { pipe, Result } from 'effect'

import {
  TRADING_DAYS,
  canonicalHashResult,
  mean,
  requiredRecordValue,
  requiredSession,
  roundWeight,
  sampleStandardDeviation,
  type AlignedSession,
} from '../simulation'
import { ContractVersion, type IsoDate, type Protocol, type SymbolSignal } from '../types'
import type { RiskBalancedTrendDecision, RiskBalancedTrendFailure } from './model'

const WEIGHT_SCALE = 1_000_000_000_000
const compareKeys = ([left]: readonly [string, unknown], [right]: readonly [string, unknown]): number =>
  left < right ? -1 : left > right ? 1 : 0

const fail = <A = never>(failure: RiskBalancedTrendFailure): Result.Result<A, RiskBalancedTrendFailure> =>
  Result.fail(failure)

export const requiredHistory = (protocol: Protocol): number => Math.max(protocol.volatilityWindow, ...protocol.horizons)

const finite = (
  value: number,
  operation: Extract<RiskBalancedTrendFailure, { readonly _tag: 'InvalidRiskBalancedTrendNumber' }>['operation'],
  symbol: string | null = null,
): Result.Result<number, RiskBalancedTrendFailure> =>
  !Number.isFinite(value)
    ? fail({ _tag: 'InvalidRiskBalancedTrendNumber', operation, value, symbol, reason: 'not-finite' })
    : value < 0 && operation === 'portfolio-variance'
      ? fail({ _tag: 'InvalidRiskBalancedTrendNumber', operation, value, symbol, reason: 'negative' })
      : Result.succeed(value)

const dailyReturns = (
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

interface ScoredSymbol {
  readonly symbol: string
  readonly score: number
}

interface WeightAllocation {
  readonly weights: Readonly<Record<string, number>>
  readonly remainingWeight: number
  readonly remaining: readonly ScoredSymbol[]
}

const allocateWeights = (
  maximumWeight: number,
  state: WeightAllocation,
): Result.Result<Readonly<Record<string, number>>, RiskBalancedTrendFailure> => {
  if (state.remaining.length === 0 || state.remainingWeight <= 0) {
    return Result.succeed(state.weights)
  }
  const remainingScore = state.remaining.reduce((total, candidate) => total + candidate.score, 0)
  if (!Number.isFinite(remainingScore)) {
    return fail({
      _tag: 'InvalidRiskBalancedTrendNumber',
      operation: 'weight-allocation',
      value: remainingScore,
      symbol: null,
      reason: 'not-finite',
    })
  }
  if (remainingScore <= 0) return Result.succeed(state.weights)
  const capped = state.remaining.filter(({ score }) => (state.remainingWeight * score) / remainingScore > maximumWeight)
  if (capped.length === 0) {
    return Result.succeed({
      ...state.weights,
      ...Object.fromEntries(
        state.remaining.map(({ symbol, score }) => [symbol, (state.remainingWeight * score) / remainingScore]),
      ),
    })
  }
  const cappedSymbols = new Set(capped.map(({ symbol }) => symbol))
  return allocateWeights(maximumWeight, {
    weights: {
      ...state.weights,
      ...Object.fromEntries(capped.map(({ symbol }) => [symbol, maximumWeight])),
    },
    remainingWeight: Math.max(0, state.remainingWeight - maximumWeight * capped.length),
    remaining: state.remaining.filter(({ symbol }) => !cappedSymbols.has(symbol)),
  })
}

const redistributeWithCap = (
  scores: Readonly<Record<string, number>>,
  maximumWeight: number,
): Result.Result<Readonly<Record<string, number>>, RiskBalancedTrendFailure> => {
  const candidates = Object.entries(scores)
    .sort(compareKeys)
    .map(([symbol, score]) => ({ symbol, score }))
  return allocateWeights(maximumWeight, {
    weights: Object.fromEntries(candidates.map(({ symbol }) => [symbol, 0])),
    remainingWeight: 1,
    remaining: candidates.filter(({ score }) => score > 0),
  })
}

interface QuantizedUnits {
  readonly units: Readonly<Record<string, number>>
  readonly totalUnits: number
}

const quantizedUnits = (
  weights: Readonly<Record<string, number>>,
  maximumUnits: number,
): Result.Result<QuantizedUnits, RiskBalancedTrendFailure> =>
  pipe(
    Result.all(
      Object.entries(weights)
        .sort(compareKeys)
        .map(([symbol, weight]) => {
          return !Number.isFinite(weight) || weight < 0
            ? fail({
                _tag: 'InvalidRiskBalancedTrendNumber',
                operation: 'weight-allocation',
                value: weight,
                symbol,
                reason: Number.isFinite(weight) ? 'negative' : 'not-finite',
              })
            : Result.succeed([symbol, Math.min(maximumUnits, Math.max(0, Math.round(weight * WEIGHT_SCALE)))] as const)
        }),
    ),
    Result.map((entries) => {
      const units = Object.fromEntries(entries)
      return {
        units,
        totalUnits: Object.values(units).reduce((total, value) => total + value, 0),
      }
    }),
  )

const removeExcessUnits = (
  input: QuantizedUnits,
): Result.Result<Readonly<Record<string, number>>, RiskBalancedTrendFailure> => {
  const initialExcess = Math.max(0, input.totalUnits - WEIGHT_SCALE)
  const bounded = Object.entries(input.units)
    .sort(compareKeys)
    .reverse()
    .reduce(
      (state, [symbol, units]) => {
        if (state.excess === 0) return state
        const removed = Math.min(units, state.excess)
        return {
          units: { ...state.units, [symbol]: units - removed },
          excess: state.excess - removed,
        }
      },
      { units: input.units, excess: initialExcess },
    )
  return bounded.excess === 0
    ? Result.succeed(
        Object.fromEntries(Object.entries(bounded.units).map(([symbol, value]) => [symbol, value / WEIGHT_SCALE])),
      )
    : fail({
        _tag: 'InvalidRiskBalancedTrendNumber',
        operation: 'weight-allocation',
        value: bounded.excess,
        symbol: null,
        reason: 'negative',
      })
}

const quantizeWeights = (
  weights: Readonly<Record<string, number>>,
  maximumSymbolWeight: number,
): Result.Result<Readonly<Record<string, number>>, RiskBalancedTrendFailure> =>
  pipe(
    quantizedUnits(weights, Math.floor(maximumSymbolWeight * WEIGHT_SCALE + Number.EPSILON)),
    Result.flatMap(removeExcessUnits),
  )

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
    Result.all({
      leftMean: mean(left),
      rightMean: mean(right),
    }),
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

const annualizedPortfolioVolatility = (
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

interface PreparedSignal {
  readonly signal: Omit<SymbolSignal, 'uncappedWeight' | 'cappedWeight' | 'targetWeight'>
  readonly returns: readonly number[]
}

const prepareSignal = (
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
                      return fail({
                        _tag: 'MissingRiskBalancedTrendClose',
                        symbol,
                        horizonSessions,
                      })
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
                    dailyVolatility === 0
                      ? Result.succeed(0)
                      : pipe(
                          mean(horizons.map((value) => value.normalizedTrend)),
                          Result.flatMap((value) => finite(value, 'composite-score', symbol)),
                        ),
                    Result.map((compositeScore) => ({
                      signal: {
                        symbol,
                        horizons,
                        dailyVolatility,
                        annualizedVolatility,
                        compositeScore,
                        positiveScore: Math.max(0, compositeScore),
                        eligible: dailyVolatility > 0,
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

const finalizeSignals = (
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

const assembleDecision = (
  signalDate: IsoDate,
  sessionDates: readonly IsoDate[],
  protocol: Protocol,
  prepared: readonly PreparedSignal[],
): RiskBalancedTrendDecision => {
  const positiveScores = Object.fromEntries(prepared.map(({ signal }) => [signal.symbol, signal.positiveScore]))
  const returnsBySymbol = Object.fromEntries(prepared.map(({ signal, returns }) => [signal.symbol, returns]))
  const totalPositiveScore = Object.values(positiveScores).reduce((total, score) => total + score, 0)
  const uncappedWeights = Object.fromEntries(
    prepared.map(({ signal }) => [
      signal.symbol,
      totalPositiveScore === 0 ? 0 : signal.positiveScore / totalPositiveScore,
    ]),
  )
  return pipe(
    redistributeWithCap(positiveScores, protocol.maximumSymbolWeight),
    Result.flatMap((rawCappedWeights) =>
      pipe(
        quantizeWeights(rawCappedWeights, protocol.maximumSymbolWeight),
        Result.flatMap((cappedWeights) =>
          pipe(
            annualizedPortfolioVolatility(cappedWeights, returnsBySymbol),
            Result.flatMap((estimatedAnnualizedPortfolioVolatility) => {
              const exposureScale =
                estimatedAnnualizedPortfolioVolatility === 0
                  ? 1
                  : Math.min(1, protocol.maximumPortfolioVolatility / estimatedAnnualizedPortfolioVolatility)
              return pipe(
                quantizeWeights(
                  Object.fromEntries(
                    Object.entries(cappedWeights).map(([symbol, weight]) => [symbol, weight * exposureScale]),
                  ),
                  protocol.maximumSymbolWeight,
                ),
                Result.flatMap((scaledWeights) =>
                  pipe(
                    annualizedPortfolioVolatility(scaledWeights, returnsBySymbol),
                    Result.flatMap((scaledVolatility) => {
                      const targetWeights =
                        scaledVolatility > protocol.maximumPortfolioVolatility
                          ? Object.fromEntries(
                              Object.entries(scaledWeights).map(([symbol, weight]) => [
                                symbol,
                                Math.floor(
                                  weight * (protocol.maximumPortfolioVolatility / scaledVolatility) * WEIGHT_SCALE,
                                ) / WEIGHT_SCALE,
                              ]),
                            )
                          : scaledWeights
                      return pipe(
                        annualizedPortfolioVolatility(targetWeights, returnsBySymbol),
                        Result.flatMap((observedPortfolioVolatility) => {
                          const totalWeight = Object.values(targetWeights).reduce((total, weight) => total + weight, 0)
                          if (
                            totalWeight > 1 + 1e-12 ||
                            Object.values(targetWeights).some(
                              (weight) =>
                                !Number.isFinite(weight) || weight < 0 || weight > protocol.maximumSymbolWeight + 1e-12,
                            ) ||
                            observedPortfolioVolatility > protocol.maximumPortfolioVolatility + 1e-12
                          ) {
                            return fail({
                              _tag: 'UnboundedRiskBalancedTrendWeights',
                              totalWeight,
                              maximumSymbolWeight: protocol.maximumSymbolWeight,
                              maximumPortfolioVolatility: protocol.maximumPortfolioVolatility,
                              observedPortfolioVolatility,
                            })
                          }
                          const covarianceDates = sessionDates.slice(-protocol.volatilityWindow)
                          const firstSession = covarianceDates.at(0)
                          if (firstSession === undefined) {
                            return fail({
                              _tag: 'RiskBalancedTrendSessionHistoryMismatch',
                              signalDate,
                              expectedCount: protocol.volatilityWindow,
                              observedDates: covarianceDates,
                            })
                          }
                          return pipe(
                            Result.all({
                              sessionsHash: canonicalHashResult('decision', covarianceDates),
                              signals: finalizeSignals(prepared, uncappedWeights, cappedWeights, targetWeights),
                            }),
                            Result.map(({ sessionsHash, signals }) => ({
                              schemaVersion: ContractVersion.DecisionPlan,
                              signalDate,
                              covarianceWindow: {
                                returnCount: protocol.volatilityWindow,
                                firstSession,
                                lastSession: covarianceDates.at(-1) ?? signalDate,
                                sessionsHash,
                              },
                              estimatedAnnualizedPortfolioVolatility,
                              exposureScale,
                              targetWeights,
                              signals,
                            })),
                          )
                        }),
                      )
                    }),
                  ),
                ),
              )
            }),
          ),
        ),
      ),
    ),
  )
}

export const makeRiskBalancedTrendDecision = (
  signalDate: IsoDate,
  sessionDates: readonly IsoDate[],
  closes: Readonly<Record<string, readonly number[]>>,
  protocol: Protocol,
): RiskBalancedTrendDecision => {
  const historyLength = requiredHistory(protocol) + 1
  if (
    sessionDates.length !== historyLength ||
    sessionDates.at(-1) !== signalDate ||
    sessionDates.some((date, index) => index > 0 && date <= (sessionDates.at(index - 1) ?? date))
  ) {
    return fail({
      _tag: 'RiskBalancedTrendSessionHistoryMismatch',
      signalDate,
      expectedCount: historyLength,
      observedDates: sessionDates,
    })
  }
  const observedUniverse = Object.keys(closes).sort()
  if (
    observedUniverse.length !== protocol.universe.length ||
    observedUniverse.some((symbol, index) => symbol !== protocol.universe.at(index))
  ) {
    return fail({
      _tag: 'RiskBalancedTrendUniverseMismatch',
      expected: protocol.universe,
      observed: observedUniverse,
    })
  }
  return pipe(
    Result.all(protocol.universe.map((symbol) => prepareSignal(symbol, closes, historyLength, protocol))),
    Result.flatMap((prepared) => assembleDecision(signalDate, sessionDates, protocol, prepared)),
  )
}

export const decisionFromAlignedSessions = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  protocol: Protocol,
): RiskBalancedTrendDecision =>
  pipe(
    requiredSession(sessions, signalIndex, 'signal-decision'),
    Result.flatMap((signalSession) => {
      const historySessions = requiredHistory(protocol)
      const history = sessions.slice(signalIndex - historySessions, signalIndex + 1)
      return pipe(
        Result.all(
          protocol.universe.map((symbol) =>
            pipe(
              Result.all(history.map((session) => requiredRecordValue(session.bars, symbol, 'bar', session.date))),
              Result.map((bars) => [symbol, bars.map((bar) => bar.close)] as const),
            ),
          ),
        ),
        Result.flatMap((closes) =>
          makeRiskBalancedTrendDecision(
            signalSession.date,
            history.map((session) => session.date),
            Object.fromEntries(closes),
            protocol,
          ),
        ),
      )
    }),
  )
