import type { RuntimeProvenance } from './contracts'
import { intradayMomentumBehaviorHash, makeIntradayMomentumDefinition } from './strategy/intraday-momentum/decision'
import {
  decodeDefaultIntradayMomentumProtocol,
  type IntradayMomentumProtocol,
} from './strategy/intraday-momentum/protocol'
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
export const activeStrategyName = 'intraday-momentum' as const
export const activeStrategyBehaviorHash = intradayMomentumBehaviorHash
export const loadActiveStrategyProtocol = decodeDefaultIntradayMomentumProtocol

export const makeActiveStrategyRuntime = (
  protocol: IntradayMomentumProtocol,
  provenance: RuntimeProvenance,
): StrategyRuntime => ({
  definition: makeIntradayMomentumDefinition(protocol),
  provenance,
})

export interface StrategyRuntime {
  readonly definition: StrategyDefinition<any, any, any, any>
  readonly provenance: RuntimeProvenance
}

export const strategyDefinition = (runtime: StrategyRuntime): StrategyRuntime['definition'] => runtime.definition
