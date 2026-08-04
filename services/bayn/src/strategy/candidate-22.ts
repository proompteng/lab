import { Result, pipe } from 'effect'

import { annualizedPortfolioVolatility } from './risk-balanced-trend/risk'
import {
  makeRiskBalancedTrendApplication,
  type RiskBalancedTrendMarketContext,
  type RiskBalancedTrendStrategyDefinition,
} from './risk-balanced-trend'
import { makeRiskBalancedTrendDecision } from './risk-balanced-trend/decision'
import { dailyReturns, WEIGHT_SCALE } from './risk-balanced-trend/shared'
import { decodeDefaultProtocol } from '../protocol'
import type { RiskBalancedTrendFailure } from '../risk-balanced-trend/model'
import type { DecisionPlan, Protocol } from '../types'

const protocol = Result.getOrThrow(decodeDefaultProtocol())

const momentumHorizon = 252
const momentumSkip = 21
const dispersionHorizon = 21
const dispersionObservationCount = 12
const activeWeight = 0.35
const baselineWeight = 0.1
const neutralWeight = 0.2

/**
 * Frozen hypothesis: recent cross-sectional dispersion is a negative state variable for momentum, so the strategy
 * adds a bounded 12-minus-1 tilt only below its trailing dispersion median. See Stivers and Sun (2010),
 * doi:10.1017/S0022109010000384, and Asness, Moskowitz, and Pedersen (2013), doi:10.1111/jofi.12021.
 */

const fail = <A = never>(failure: RiskBalancedTrendFailure): Result.Result<A, RiskBalancedTrendFailure> =>
  Result.fail(failure)

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
    : fail({
        _tag: 'InvalidRiskBalancedTrendClose',
        symbol,
        index: invalidIndex,
        value: closes.at(invalidIndex) ?? Number.NaN,
      })
}

const returnEndingAt = (
  closes: readonly number[],
  symbol: string,
  endIndex: number,
  horizon: number,
): Result.Result<number, RiskBalancedTrendFailure> => {
  const current = closes.at(endIndex)
  const prior = closes.at(endIndex - horizon)
  if (current === undefined || prior === undefined) {
    return fail({ _tag: 'MissingRiskBalancedTrendClose', symbol, horizonSessions: horizon })
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
}

const sampleDispersion = (values: readonly number[]): number => {
  const mean = values.reduce((total, value) => total + value, 0) / values.length
  return Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1))
}

const dispersionEndingAt = (
  context: RiskBalancedTrendMarketContext,
  endIndex: number,
  candidateProtocol: Protocol,
): Result.Result<number, RiskBalancedTrendFailure> =>
  pipe(
    Result.all(
      candidateProtocol.universe.map((symbol) =>
        pipe(
          closeHistory(context, symbol),
          Result.flatMap((closes) => returnEndingAt(closes, symbol, endIndex, dispersionHorizon)),
        ),
      ),
    ),
    Result.map(sampleDispersion),
  )

const median = (values: readonly number[]): number => {
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.floor(ordered.length / 2)] ?? Number.NaN
}

const lowDispersionRegime = (
  context: RiskBalancedTrendMarketContext,
  candidateProtocol: Protocol,
): Result.Result<boolean, RiskBalancedTrendFailure> => {
  const lastIndex = context.sessionDates.length - 1
  return pipe(
    Result.all(
      Array.from({ length: dispersionObservationCount }, (_, offset) =>
        dispersionEndingAt(context, lastIndex - offset * dispersionHorizon, candidateProtocol),
      ),
    ),
    Result.map(([current, ...history]) => current !== undefined && current < median(history)),
  )
}

const momentumScores = (
  context: RiskBalancedTrendMarketContext,
  candidateProtocol: Protocol,
): Result.Result<Readonly<Record<string, number>>, RiskBalancedTrendFailure> => {
  const endIndex = context.sessionDates.length - 1 - momentumSkip
  return pipe(
    Result.all(
      candidateProtocol.universe.map((symbol) =>
        pipe(
          closeHistory(context, symbol),
          Result.flatMap((closes) => returnEndingAt(closes, symbol, endIndex, momentumHorizon - momentumSkip)),
          Result.map((score) => [symbol, score] as const),
        ),
      ),
    ),
    Result.map(Object.fromEntries),
  )
}

const requestedWeights = (
  scores: Readonly<Record<string, number>>,
  tiltMomentum: boolean,
  candidateProtocol: Protocol,
): Readonly<Record<string, number>> => {
  if (!tiltMomentum) return Object.fromEntries(candidateProtocol.universe.map((symbol) => [symbol, neutralWeight]))
  const leaders = new Set(
    [...candidateProtocol.universe]
      .sort(
        (left, right) =>
          (scores[right] ?? Number.NEGATIVE_INFINITY) - (scores[left] ?? Number.NEGATIVE_INFINITY) ||
          left.localeCompare(right),
      )
      .slice(0, 2),
  )
  return Object.fromEntries(
    candidateProtocol.universe.map((symbol) => [symbol, leaders.has(symbol) ? activeWeight : baselineWeight]),
  )
}

const volatilityScaledWeights = (
  context: RiskBalancedTrendMarketContext,
  weights: Readonly<Record<string, number>>,
  candidateProtocol: Protocol,
): Result.Result<
  {
    readonly estimatedAnnualizedPortfolioVolatility: number
    readonly exposureScale: number
    readonly targetWeights: Readonly<Record<string, number>>
  },
  RiskBalancedTrendFailure
> =>
  pipe(
    Result.all(
      candidateProtocol.universe.map((symbol) =>
        pipe(
          closeHistory(context, symbol),
          Result.flatMap((closes) => dailyReturns(closes, candidateProtocol.volatilityWindow, symbol)),
          Result.map((returns) => [symbol, returns] as const),
        ),
      ),
    ),
    Result.flatMap((returnEntries) => {
      const returnSeries = Object.fromEntries(returnEntries)
      return pipe(
        annualizedPortfolioVolatility(weights, returnSeries),
        Result.flatMap((estimatedAnnualizedPortfolioVolatility) => {
          const exposureScale =
            estimatedAnnualizedPortfolioVolatility === 0
              ? 1
              : Math.min(1, candidateProtocol.maximumPortfolioVolatility / estimatedAnnualizedPortfolioVolatility)
          const targetWeights = Object.fromEntries(
            Object.entries(weights).map(([symbol, weight]) => [
              symbol,
              Math.floor(weight * exposureScale * WEIGHT_SCALE) / WEIGHT_SCALE,
            ]),
          )
          return pipe(
            annualizedPortfolioVolatility(targetWeights, returnSeries),
            Result.flatMap((observedAnnualizedPortfolioVolatility) =>
              observedAnnualizedPortfolioVolatility > candidateProtocol.maximumPortfolioVolatility + 1e-12
                ? fail({
                    _tag: 'UnboundedRiskBalancedTrendWeights',
                    totalWeight: Object.values(targetWeights).reduce((total, weight) => total + weight, 0),
                    maximumSymbolWeight: candidateProtocol.maximumSymbolWeight,
                    maximumPortfolioVolatility: candidateProtocol.maximumPortfolioVolatility,
                    observedPortfolioVolatility: observedAnnualizedPortfolioVolatility,
                  })
                : Result.succeed({ estimatedAnnualizedPortfolioVolatility, exposureScale, targetWeights }),
            ),
          )
        }),
      )
    }),
  )

const candidate22Decision = (
  context: RiskBalancedTrendMarketContext,
  candidateProtocol: Protocol,
): Result.Result<DecisionPlan, RiskBalancedTrendFailure> =>
  pipe(
    Result.all({
      base: makeRiskBalancedTrendDecision(context.signalDate, context.sessionDates, context.closes, candidateProtocol),
      lowDispersion: lowDispersionRegime(context, candidateProtocol),
      scores: momentumScores(context, candidateProtocol),
    }),
    Result.flatMap(({ base, lowDispersion, scores }) => {
      const weights = requestedWeights(scores, lowDispersion, candidateProtocol)
      return pipe(
        volatilityScaledWeights(context, weights, candidateProtocol),
        Result.map(({ estimatedAnnualizedPortfolioVolatility, exposureScale, targetWeights }) => ({
          ...base,
          estimatedAnnualizedPortfolioVolatility,
          exposureScale,
          targetWeights,
          signals: base.signals.map((signal) => {
            const score = scores[signal.symbol] ?? 0
            const targetWeight = targetWeights[signal.symbol] ?? 0
            return {
              ...signal,
              compositeScore: score,
              positiveScore: Math.max(0, score),
              eligible: true,
              uncappedWeight: weights[signal.symbol] ?? 0,
              cappedWeight: weights[signal.symbol] ?? 0,
              targetWeight,
            }
          }),
        })),
      )
    }),
  )

const definition: RiskBalancedTrendStrategyDefinition = {
  name: 'candidate-22-low-dispersion-momentum-tilt',
  parameters: protocol,
  decide: ({ market }) => candidate22Decision(market, protocol),
}

/** Result-blind low-dispersion momentum tilt; the adapter supplies only reviewed, verified market context. */
export const strategyApplication = makeRiskBalancedTrendApplication(protocol, definition)
