import { Result, pipe } from 'effect'

import { decodeProtocol, defaultProtocolDocument } from '../protocol'
import type { RiskBalancedTrendFailure } from '../risk-balanced-trend/model'
import type { DecisionPlan, Protocol } from '../types'
import {
  makeRiskBalancedTrendApplication,
  type RiskBalancedTrendMarketContext,
  type RiskBalancedTrendStrategyDefinition,
} from './risk-balanced-trend'
import { makeRiskBalancedTrendDecision } from './risk-balanced-trend/decision'
import { annualizedPortfolioVolatility } from './risk-balanced-trend/risk'
import { dailyReturns, fail, WEIGHT_SCALE } from './risk-balanced-trend/shared'

const selectionCount = 2

const protocol = Result.getOrThrow(
  decodeProtocol({
    ...defaultProtocolDocument,
    horizons: [63, 126, 252],
    maximumSymbolWeight: 1 / selectionCount,
    signal: {
      ...defaultProtocolDocument.signal,
      minimumPositiveHorizons: 2,
    },
  }),
)

const selectedSymbols = (decision: DecisionPlan): ReadonlySet<string> =>
  new Set(
    decision.signals
      .filter(({ eligible }) => eligible)
      .sort(
        (left, right) =>
          right.compositeScore - left.compositeScore ||
          (left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0),
      )
      .slice(0, selectionCount)
      .map(({ symbol }) => symbol),
  )

const recentReturns = (
  context: RiskBalancedTrendMarketContext,
  candidateProtocol: Protocol,
): Result.Result<Readonly<Record<string, readonly number[]>>, RiskBalancedTrendFailure> =>
  pipe(
    Result.all(
      candidateProtocol.universe.map((symbol) => {
        const closes = context.closes[symbol]
        return closes === undefined
          ? fail({
              _tag: 'RiskBalancedTrendCloseHistoryMismatch',
              symbol,
              expectedCount: context.sessionDates.length,
              observedCount: 0,
            })
          : pipe(
              dailyReturns(closes, candidateProtocol.volatilityWindow, symbol),
              Result.map((returns) => [symbol, returns] as const),
            )
      }),
    ),
    Result.map(Object.fromEntries),
  )

const scaleToRiskLimit = (
  requestedWeights: Readonly<Record<string, number>>,
  returnSeries: Readonly<Record<string, readonly number[]>>,
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
    annualizedPortfolioVolatility(requestedWeights, returnSeries),
    Result.flatMap((estimatedAnnualizedPortfolioVolatility) => {
      const exposureScale =
        estimatedAnnualizedPortfolioVolatility === 0
          ? 1
          : Math.min(1, candidateProtocol.maximumPortfolioVolatility / estimatedAnnualizedPortfolioVolatility)
      const targetWeights = Object.fromEntries(
        Object.entries(requestedWeights).map(([symbol, weight]) => [
          symbol,
          Math.floor(weight * exposureScale * WEIGHT_SCALE) / WEIGHT_SCALE,
        ]),
      )
      return pipe(
        annualizedPortfolioVolatility(targetWeights, returnSeries),
        Result.flatMap((observedPortfolioVolatility) => {
          const totalWeight = Object.values(targetWeights).reduce((total, weight) => total + weight, 0)
          return totalWeight > 1 + 1e-12 ||
            Object.values(targetWeights).some(
              (weight) => weight < 0 || weight > candidateProtocol.maximumSymbolWeight + 1e-12,
            ) ||
            observedPortfolioVolatility > candidateProtocol.maximumPortfolioVolatility + 1e-12
            ? fail({
                _tag: 'UnboundedRiskBalancedTrendWeights',
                totalWeight,
                maximumSymbolWeight: candidateProtocol.maximumSymbolWeight,
                maximumPortfolioVolatility: candidateProtocol.maximumPortfolioVolatility,
                observedPortfolioVolatility,
              })
            : Result.succeed({ estimatedAnnualizedPortfolioVolatility, exposureScale, targetWeights })
        }),
      )
    }),
  )

const decide = (
  context: RiskBalancedTrendMarketContext,
  candidateProtocol: Protocol,
): Result.Result<DecisionPlan, RiskBalancedTrendFailure> =>
  pipe(
    Result.all({
      base: makeRiskBalancedTrendDecision(context.signalDate, context.sessionDates, context.closes, candidateProtocol),
      returnSeries: recentReturns(context, candidateProtocol),
    }),
    Result.flatMap(({ base, returnSeries }) => {
      const selected = selectedSymbols(base)
      const requestedWeights = Object.fromEntries(
        candidateProtocol.universe.map((symbol) => [symbol, selected.has(symbol) ? 1 / selectionCount : 0]),
      )
      return pipe(
        scaleToRiskLimit(requestedWeights, returnSeries, candidateProtocol),
        Result.map(({ estimatedAnnualizedPortfolioVolatility, exposureScale, targetWeights }) => ({
          ...base,
          estimatedAnnualizedPortfolioVolatility,
          exposureScale,
          targetWeights,
          signals: base.signals.map((signal) => ({
            ...signal,
            positiveScore: selected.has(signal.symbol) ? signal.positiveScore : 0,
            eligible: selected.has(signal.symbol),
            uncappedWeight: requestedWeights[signal.symbol] ?? 0,
            cappedWeight: requestedWeights[signal.symbol] ?? 0,
            targetWeight: targetWeights[signal.symbol] ?? 0,
          })),
        })),
      )
    }),
  )

const definition: RiskBalancedTrendStrategyDefinition = {
  name: 'candidate-25-top-two-momentum-consensus',
  parameters: protocol,
  decide: ({ market }) => decide(market, protocol),
}

/** Result-blind top-two momentum consensus with fixed concentration and portfolio-risk bounds. */
export const strategyApplication = makeRiskBalancedTrendApplication(protocol, definition)
