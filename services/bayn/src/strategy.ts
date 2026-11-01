import { Result } from 'effect'
import type { RuntimeProvenance } from './contracts'
import { makeEntryAblationDefinition } from './jev/entry-ablation'
import { decodeEntryAblationPolicy, type EntryAblationPolicy } from './jev/entry-ablation-policy'
import { makeJevDefinition, type JevDecisionEvidence } from './jev/decision'
import type { JevContractError } from './jev/contract'
import type { StrategyDefinition } from './strategy/core'
import type { ChartEntryTarget } from './strategy/runtime-decision'
import { decodeJevProtocol, defaultJevProtocolDocument, jevBehaviorHash, type JevProtocol } from './jev/protocol'
import { makeRepeatedMomentumDefinition } from './strategy/repeated-momentum/decision'
import { decodeRepeatedMomentumPolicy, type RepeatedMomentumPolicy } from './strategy/repeated-momentum/policy'

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

export const makeRepeatedMomentumRuntime = (policy: RepeatedMomentumPolicy, provenance: RuntimeProvenance) =>
  ({ definition: makeRepeatedMomentumDefinition(policy), provenance }) satisfies MomentumStrategyRuntime

export const strategyDefinition = (runtime: StrategyRuntime): StrategyRuntime['definition'] => runtime.definition

export const makeEntryAblationRuntime = (policy: EntryAblationPolicy, provenance: RuntimeProvenance) =>
  ({
    definition: makeEntryAblationDefinition(policy),
    provenance,
  }) satisfies StrategyRuntime

export const loadStrategyTradingProtocol = (runtime: StrategyRuntime) => {
  const parameters = runtime.definition.parameters
  return parameters.schemaVersion === 'bayn.repeated-momentum-policy.v1'
    ? decodeRepeatedMomentumPolicy(parameters).pipe(Result.map((policy) => policy.sharedProtocol))
    : parameters.schemaVersion === 'bayn.entry-ablation-policy.v1'
      ? decodeEntryAblationPolicy(parameters).pipe(Result.map((policy) => policy.sharedProtocol))
      : decodeJevProtocol(parameters)
}
