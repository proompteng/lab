import { makeRiskBalancedTrendStrategy } from './strategy/risk-balanced-trend/strategy'
import type {
  RiskBalancedTrendStrategy,
  RiskBalancedTrendStrategyPrepareLockFailure,
} from './strategy/risk-balanced-trend/strategy'
import type { CurrentDecisionCycleBinding, CurrentRiskBalancedTrendDecision } from './risk-balanced-trend'
import type { RiskBalancedTrendFailure } from './risk-balanced-trend'

export type {
  StrategyDecisionFailure,
  StrategyDefinition,
  StrategyTargetPortfolio,
  VerifiedStrategyContext,
} from './strategy/core'
export { makeRiskBalancedTrendDefinition, makeRiskBalancedTrendStrategy } from './strategy/risk-balanced-trend'
export type {
  RiskBalancedTrendMarketContext,
  RiskBalancedTrendPortfolioContext,
  RiskBalancedTrendStrategyDefinition,
  RiskBalancedTrendTargetPortfolio,
} from './strategy/risk-balanced-trend'

/**
 * Runtime callers still consume the full evaluation facade until their own migrations land.
 * New strategy consumers should depend on StrategyDefinition instead.
 */
export type Strategy = RiskBalancedTrendStrategy

export type CurrentStrategyDecision = CurrentRiskBalancedTrendDecision
export type CurrentStrategyDecisionCycleBinding = CurrentDecisionCycleBinding
export type CurrentStrategyDecisionFailure = RiskBalancedTrendFailure
export type StrategyPrepareLockFailure = RiskBalancedTrendStrategyPrepareLockFailure

/** Compatibility entry point retained for the unowned runtime callers. */
export const makeStrategy = makeRiskBalancedTrendStrategy
