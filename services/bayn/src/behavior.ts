import { sha256 } from './hash'

export const riskBalancedTrendBehaviorVersion = 'bayn.risk-balanced-trend.behavior.v4' as const
/** Durable identity for every evaluation that used the v4 terminal-replay semantics. */
export const riskBalancedTrendBehaviorV4Hash = sha256('bayn.risk-balanced-trend.behavior.v4')
export const riskBalancedTrendBehaviorHash = riskBalancedTrendBehaviorV4Hash

/** Keep this list immutable when the active strategy behavior advances. */
export const riskBalancedTrendTerminalReplayBehaviorHashes = [riskBalancedTrendBehaviorV4Hash] as const
