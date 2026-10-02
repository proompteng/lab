import type { RuntimeProvenance } from './contracts'
import { makeJevDefinition } from './jev/decision'
import { decodeJevProtocol, defaultJevProtocolDocument, jevBehaviorHash, type JevProtocol } from './jev/protocol'
import type { StrategyDefinition } from './strategy/core'

export type {
  StrategyDecisionFailure,
  StrategyDefinition,
  TargetPortfolio,
  VerifiedStrategyContext,
} from './strategy/core'
export {
  decideIntradayMomentum,
  intradayMomentumBehaviorHash,
  makeIntradayMomentumDefinition,
} from './strategy/intraday-momentum/decision'
export {
  IntradayMomentumFailure,
  type IntradayMomentumFailureReason,
  type IntradayMomentumMarketContext,
  type IntradayMomentumRejectionReason,
  type IntradayMomentumSessionBinding,
  type IntradayMomentumSignal,
  type IntradayMomentumStrategyDefinition,
  type IntradayMomentumTargetPortfolio,
} from './strategy/intraday-momentum/model'
export {
  decodeDefaultIntradayMomentumProtocol,
  decodeIntradayMomentumProtocol,
  defaultIntradayMomentumProtocolDocument,
  hashIntradayMomentumProtocol,
  intradayMomentumExecutionModel,
  intradayMomentumSnapshotSymbols,
  IntradayMomentumProtocolDecodeError,
  IntradayMomentumProtocolSchema,
  type IntradayMomentumProtocol,
} from './strategy/intraday-momentum/protocol'

/** The application root composes exactly one reviewed strategy implementation. */
export const activeStrategyName = 'jev' as const
export const activeStrategyBehaviorHash = jevBehaviorHash
export const loadActiveStrategyProtocol = () => decodeJevProtocol(defaultJevProtocolDocument)

export const makeActiveStrategyRuntime = (protocol: JevProtocol, provenance: RuntimeProvenance): StrategyRuntime => ({
  definition: makeJevDefinition(protocol),
  provenance,
})

export interface StrategyRuntime {
  readonly definition: StrategyDefinition<any, any, any, any>
  readonly provenance: RuntimeProvenance
}

export const strategyDefinition = (runtime: StrategyRuntime): StrategyRuntime['definition'] => runtime.definition
