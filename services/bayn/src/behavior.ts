import { sha256 } from './hash'

export const riskBalancedTrendBehaviorVersion = 'bayn.risk-balanced-trend.behavior.v2' as const
export const riskBalancedTrendBehaviorHash = sha256(riskBalancedTrendBehaviorVersion)
