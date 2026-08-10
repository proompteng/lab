import { Result, pipe } from 'effect'

import { canonicalHashResult, requiredRecordValue, requiredSession, type AlignedSession } from '../../simulation'
import { ContractVersion, type DecisionPlan, type IsoDate, type Protocol } from '../../types'
import type { RiskBalancedTrendDecision, RiskBalancedTrendFailure } from '../../risk-balanced-trend/model'
import type { StrategyDefinition, TargetPortfolio, VerifiedStrategyContext } from '../core'
import { quantizeWeights, redistributeWithCap } from './allocation'
import { annualizedPortfolioVolatility } from './risk'
import { finalizeSignals, prepareSignal, type PreparedSignal } from './signals'
import { fail, requiredHistory, WEIGHT_SCALE } from './shared'
import { Pipeable } from '../../pipeable'

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

const makeRiskBalancedTrendDecisionDataFirst = (
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

export const makeRiskBalancedTrendDecision = Pipeable.dual(4, makeRiskBalancedTrendDecisionDataFirst)

export interface RiskBalancedTrendMarketContext {
  readonly signalDate: IsoDate
  readonly sessionDates: readonly IsoDate[]
  readonly closes: Readonly<Record<string, readonly number[]>>
}

export type RiskBalancedTrendTargetPortfolio = DecisionPlan & TargetPortfolio

export type RiskBalancedTrendStrategyDefinition = StrategyDefinition<
  RiskBalancedTrendMarketContext,
  RiskBalancedTrendFailure,
  RiskBalancedTrendTargetPortfolio
>

export const makeRiskBalancedTrendDefinition = (protocol: Protocol): RiskBalancedTrendStrategyDefinition => ({
  name: 'risk-balanced-trend',
  parameters: protocol,
  decide: ({ market }: VerifiedStrategyContext<RiskBalancedTrendMarketContext>) =>
    makeRiskBalancedTrendDecision(market.signalDate, market.sessionDates, market.closes, protocol),
})

const riskBalancedTrendContextAtSignalDataFirst = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  protocol: Protocol,
): Result.Result<VerifiedStrategyContext<RiskBalancedTrendMarketContext>, RiskBalancedTrendFailure> =>
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
        Result.map((closes) => ({
          market: {
            signalDate: signalSession.date,
            sessionDates: history.map((session) => session.date),
            closes: Object.fromEntries(closes),
          },
        })),
      )
    }),
  )

export const riskBalancedTrendContextAtSignal = Pipeable.dual(3, riskBalancedTrendContextAtSignalDataFirst)

export const decisionFromAlignedSessions = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  protocol: Protocol,
  definition: RiskBalancedTrendStrategyDefinition = makeRiskBalancedTrendDefinition(protocol),
): RiskBalancedTrendDecision =>
  pipe(
    riskBalancedTrendContextAtSignal(sessions, signalIndex, protocol),
    Result.flatMap((context) => definition.decide(context)),
  )
