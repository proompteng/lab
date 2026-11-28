import type { RuntimeProvenance } from './contracts'
import type { EntryAblationPolicy } from './jev/entry-ablation-policy'
import { makeJevDefinition, type JevDecisionEvidence } from './jev/decision'
import type { JevContractError } from './jev/contract'
import type { StrategyDefinition } from './strategy/core'
import type { ChartEntryTarget } from './strategy/runtime-decision'
import { decodeJevProtocol, defaultJevProtocolDocument, type JevProtocol } from './jev/protocol'
import { Result } from 'effect'
import type { makeRepeatedMomentumDefinition } from './strategy/repeated-momentum/decision'
import { makeIntradayAlphaDefinition } from './strategy/intraday-alpha/decision'
import {
  decodePureEtfPolicy,
  intradayAlphaBehaviorHash,
  makePureEtfPolicy,
  type IntradayAlphaPolicy,
} from './strategy/intraday-alpha/policy'

/** Shared Jev protocol supplying execution-model, market-profile, and session bounds. */
export const loadSharedJevProtocol = () => decodeJevProtocol(defaultJevProtocolDocument)

export const makeJevStrategyRuntime = (protocol: JevProtocol, provenance: RuntimeProvenance) =>
  ({
    definition: makeJevDefinition(protocol),
    provenance,
  }) satisfies StrategyRuntime

/** The application root composes exactly one reviewed strategy implementation. */
export const activeStrategyName = 'jev' as const
export const activeStrategyBehaviorHash = intradayAlphaBehaviorHash
export const loadActiveStrategyProtocol = () =>
  loadSharedJevProtocol().pipe(Result.flatMap((shared) => decodePureEtfPolicy(makePureEtfPolicy(shared))))

export const makeActiveStrategyRuntime = (policy: IntradayAlphaPolicy, provenance: RuntimeProvenance) =>
  ({
    definition: makeIntradayAlphaDefinition(policy),
    provenance,
  }) satisfies StrategyRuntime

interface ChartStrategyRuntime {
  readonly definition: StrategyDefinition<
    JevDecisionEvidence,
    JevContractError,
    ChartEntryTarget,
    JevProtocol | EntryAblationPolicy
  >
  readonly provenance: RuntimeProvenance
}

interface MomentumStrategyRuntime {
  readonly definition: ReturnType<typeof makeRepeatedMomentumDefinition>
  readonly provenance: RuntimeProvenance
}

interface IntradayAlphaStrategyRuntime {
  readonly definition: ReturnType<typeof makeIntradayAlphaDefinition>
  readonly provenance: RuntimeProvenance
}
export type StrategyRuntime = ChartStrategyRuntime | MomentumStrategyRuntime | IntradayAlphaStrategyRuntime

export const isRepeatedMomentumRuntime = (runtime: StrategyRuntime): runtime is MomentumStrategyRuntime =>
  runtime.definition.parameters.schemaVersion === 'bayn.repeated-momentum-policy.v1'

export const isIntradayAlphaRuntime = (runtime: StrategyRuntime): runtime is IntradayAlphaStrategyRuntime =>
  runtime.definition.parameters.schemaVersion === 'bayn.intraday-alpha-policy.v2' ||
  runtime.definition.parameters.schemaVersion === 'bayn.intraday-alpha-policy.v3'

export const strategyTradingProtocol = (runtime: StrategyRuntime): JevProtocol => {
  const parameters = runtime.definition.parameters
  return 'sharedProtocol' in parameters ? parameters.sharedProtocol : parameters
}
