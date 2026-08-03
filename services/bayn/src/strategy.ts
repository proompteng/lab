import type { RiskBalancedTrendStrategyDefinition } from './strategy/risk-balanced-trend'
import type { RuntimeProvenance } from './contracts'

export type {
  StrategyDecisionFailure,
  StrategyDefinition,
  TargetPortfolio,
  VerifiedStrategyContext,
} from './strategy/core'
export { makeRiskBalancedTrendDefinition, riskBalancedTrendContextAtSignal } from './strategy/risk-balanced-trend'
export type {
  RiskBalancedTrendMarketContext,
  RiskBalancedTrendStrategyDefinition,
  RiskBalancedTrendTargetPortfolio,
} from './strategy/risk-balanced-trend'

export interface StrategyRuntime {
  readonly definition: RiskBalancedTrendStrategyDefinition
  readonly provenance: RuntimeProvenance
}
