import type { RuntimeProvenance } from './contracts'
import type { EntryAblationPolicy } from './jev/entry-ablation-policy'
import { makeJevDefinition, type JevDecisionEvidence } from './jev/decision'
import type { JevContractError } from './jev/contract'
import type { StrategyDefinition } from './strategy/core'
import type { ChartEntryTarget } from './strategy/runtime-decision'
import { decodeJevProtocol, defaultJevProtocolDocument, jevBehaviorHash, type JevProtocol } from './jev/protocol'
import type { makeRepeatedMomentumDefinition } from './strategy/repeated-momentum/decision'

/** The application root composes exactly one reviewed strategy implementation. */
export const activeStrategyName = 'jev' as const
export const activeStrategyBehaviorHash = jevBehaviorHash
export const loadActiveStrategyProtocol = () => decodeJevProtocol(defaultJevProtocolDocument)

export const makeActiveStrategyRuntime = (protocol: JevProtocol, provenance: RuntimeProvenance) =>
  ({
    definition: makeJevDefinition(protocol),
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
export type StrategyRuntime = ChartStrategyRuntime | MomentumStrategyRuntime

export const isRepeatedMomentumRuntime = (runtime: StrategyRuntime): runtime is MomentumStrategyRuntime =>
  runtime.definition.parameters.schemaVersion === 'bayn.repeated-momentum-policy.v1'

export const strategyTradingProtocol = (runtime: StrategyRuntime): JevProtocol => {
  const parameters = runtime.definition.parameters
  return 'sharedProtocol' in parameters ? parameters.sharedProtocol : parameters
}
