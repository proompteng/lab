import type { RuntimeProvenance } from './contracts'
import { makeJevDefinition } from './jev/decision'
import { decodeJevProtocol, defaultJevProtocolDocument, jevBehaviorHash, type JevProtocol } from './jev/protocol'

/** The application root composes exactly one reviewed strategy implementation. */
export const activeStrategyName = 'jev' as const
export const activeStrategyBehaviorHash = jevBehaviorHash
export const loadActiveStrategyProtocol = () => decodeJevProtocol(defaultJevProtocolDocument)

export const makeActiveStrategyRuntime = (protocol: JevProtocol, provenance: RuntimeProvenance): StrategyRuntime => ({
  definition: makeJevDefinition(protocol),
  provenance,
})

export interface StrategyRuntime {
  readonly definition: ReturnType<typeof makeJevDefinition>
  readonly provenance: RuntimeProvenance
}

export const strategyDefinition = (runtime: StrategyRuntime): StrategyRuntime['definition'] => runtime.definition
