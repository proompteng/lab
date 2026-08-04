import { Result, pipe } from 'effect'

import { decodeDefaultProtocol } from '../protocol'
import type { DecisionPlan, Protocol } from '../types'
import { annualizedPortfolioVolatility } from './risk-balanced-trend/risk'
import {
  makeRiskBalancedTrendApplication,
  type RiskBalancedTrendMarketContext,
  type RiskBalancedTrendStrategyDefinition,
} from './risk-balanced-trend'
import { makeRiskBalancedTrendDecision } from './risk-balanced-trend/decision'
import { dailyReturns, WEIGHT_SCALE } from './risk-balanced-trend/shared'
import type { RiskBalancedTrendFailure } from '../risk-balanced-trend/model'

const protocol = Result.getOrThrow(decodeDefaultProtocol())

const sixMonthHorizon = 126
const rotationSymbols = ['DBC', 'VNQ'] as const
const defensiveSymbol = 'IEF' as const

const fail = <A = never>(failure: RiskBalancedTrendFailure): Result.Result<A, RiskBalancedTrendFailure> =>
  Result.fail(failure)

const invalidClose = (symbol: string, index: number, value: number): Result.Result<never, RiskBalancedTrendFailure> =>
  fail({
    _tag: 'InvalidRiskBalancedTrendClose',
    symbol,
    index,
    value,
  })

const closeHistory = (
  context: RiskBalancedTrendMarketContext,
  symbol: string,
): Result.Result<readonly number[], RiskBalancedTrendFailure> => {
  const closes = context.closes[symbol]
  if (closes === undefined || closes.length !== context.sessionDates.length) {
    return fail({
      _tag: 'RiskBalancedTrendCloseHistoryMismatch',
      symbol,
      expectedCount: context.sessionDates.length,
      observedCount: closes?.length ?? 0,
    })
  }
  const invalidIndex = closes.findIndex((close) => !Number.isFinite(close) || close <= 0)
  return invalidIndex < 0
    ? Result.succeed(closes)
    : invalidClose(symbol, invalidIndex, closes.at(invalidIndex) ?? Number.NaN)
}

const sixMonthReturn = (
  context: RiskBalancedTrendMarketContext,
  symbol: string,
): Result.Result<number, RiskBalancedTrendFailure> =>
  pipe(
    closeHistory(context, symbol),
    Result.flatMap((closes) => {
      const current = closes.at(-1)
      const prior = closes.at(-1 - sixMonthHorizon)
      if (current === undefined || prior === undefined) {
        return fail({
          _tag: 'MissingRiskBalancedTrendClose',
          symbol,
          horizonSessions: sixMonthHorizon,
        })
      }
      const value = current / prior - 1
      return Number.isFinite(value)
        ? Result.succeed(value)
        : fail({
            _tag: 'InvalidRiskBalancedTrendNumber',
            operation: 'horizon-return',
            value,
            symbol,
            reason: 'not-finite',
          })
    }),
  )

const selectedRotationSymbol = (returns: Readonly<Record<string, number>>): string | null => {
  const winner = [...rotationSymbols]
    .map((symbol) => ({ symbol, value: returns[symbol] ?? Number.NEGATIVE_INFINITY }))
    .sort((left, right) => right.value - left.value || left.symbol.localeCompare(right.symbol))
    .find(({ value }) => value > 0)
  return winner?.symbol ?? ((returns[defensiveSymbol] ?? Number.NEGATIVE_INFINITY) > 0 ? defensiveSymbol : null)
}

const candidate21Decision = (
  context: RiskBalancedTrendMarketContext,
  candidateProtocol: Protocol,
): Result.Result<DecisionPlan, RiskBalancedTrendFailure> =>
  pipe(
    makeRiskBalancedTrendDecision(context.signalDate, context.sessionDates, context.closes, candidateProtocol),
    Result.flatMap((baseDecision) =>
      pipe(
        Result.all(
          candidateProtocol.universe.map((symbol) =>
            pipe(
              sixMonthReturn(context, symbol),
              Result.map((value) => [symbol, value] as const),
            ),
          ),
        ),
        Result.flatMap((returnEntries) => {
          const returns = Object.fromEntries(returnEntries)
          const selected = selectedRotationSymbol(returns)
          const requestedTargetWeights = Object.fromEntries(
            candidateProtocol.universe.map((symbol) => [
              symbol,
              symbol === selected ? candidateProtocol.maximumSymbolWeight : 0,
            ]),
          )
          return pipe(
            Result.all(
              candidateProtocol.universe.map((symbol) =>
                pipe(
                  closeHistory(context, symbol),
                  Result.flatMap((closes) => dailyReturns(closes, candidateProtocol.volatilityWindow, symbol)),
                  Result.map((values) => [symbol, values] as const),
                ),
              ),
            ),
            Result.flatMap((returnSeries) =>
              pipe(
                annualizedPortfolioVolatility(requestedTargetWeights, Object.fromEntries(returnSeries)),
                Result.flatMap((estimatedAnnualizedPortfolioVolatility) => {
                  const exposureScale =
                    estimatedAnnualizedPortfolioVolatility === 0
                      ? 1
                      : Math.min(
                          1,
                          candidateProtocol.maximumPortfolioVolatility / estimatedAnnualizedPortfolioVolatility,
                        )
                  const targetWeights = Object.fromEntries(
                    Object.entries(requestedTargetWeights).map(([symbol, weight]) => [
                      symbol,
                      Math.floor(weight * exposureScale * WEIGHT_SCALE) / WEIGHT_SCALE,
                    ]),
                  )
                  return pipe(
                    annualizedPortfolioVolatility(targetWeights, Object.fromEntries(returnSeries)),
                    Result.flatMap((observedAnnualizedPortfolioVolatility) =>
                      observedAnnualizedPortfolioVolatility > candidateProtocol.maximumPortfolioVolatility + 1e-12
                        ? fail({
                            _tag: 'UnboundedRiskBalancedTrendWeights',
                            totalWeight: Object.values(targetWeights).reduce((total, weight) => total + weight, 0),
                            maximumSymbolWeight: candidateProtocol.maximumSymbolWeight,
                            maximumPortfolioVolatility: candidateProtocol.maximumPortfolioVolatility,
                            observedPortfolioVolatility: observedAnnualizedPortfolioVolatility,
                          })
                        : Result.succeed({
                            ...baseDecision,
                            estimatedAnnualizedPortfolioVolatility,
                            exposureScale,
                            targetWeights,
                            signals: baseDecision.signals.map((signal) => {
                              const score = returns[signal.symbol] ?? 0
                              const targetWeight = targetWeights[signal.symbol] ?? 0
                              return {
                                ...signal,
                                compositeScore: score,
                                positiveScore: Math.max(0, score),
                                eligible: signal.symbol === selected,
                                uncappedWeight: targetWeight,
                                cappedWeight: targetWeight,
                                targetWeight,
                              }
                            }),
                          }),
                    ),
                  )
                }),
              ),
            ),
          )
        }),
      ),
    ),
  )

const definition: RiskBalancedTrendStrategyDefinition = {
  name: 'candidate-21-six-month-rotation',
  parameters: protocol,
  decide: ({ market }) => candidate21Decision(market, protocol),
}

/** Candidate 21 is a result-blind, source-controlled application; its witness is supplied only by the adapter. */
export const strategyApplication = makeRiskBalancedTrendApplication(protocol, definition)
