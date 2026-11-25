import type { RuntimeProvenance } from '../contracts'
import { makeEntryAblationDefinition } from '../jev/entry-ablation'
import type { EntryAblationPolicy } from '../jev/entry-ablation-policy'
import type { StrategyRuntime } from '../strategy'
import { makeIntradayAlphaDefinition } from '../strategy/intraday-alpha/decision'
import type { IntradayAlphaPolicy } from '../strategy/intraday-alpha/policy'
import { makeRepeatedMomentumDefinition } from '../strategy/repeated-momentum/decision'
import type { RepeatedMomentumPolicy } from '../strategy/repeated-momentum/policy'

export const makeRepeatedMomentumRuntime = (policy: RepeatedMomentumPolicy, provenance: RuntimeProvenance) =>
  ({ definition: makeRepeatedMomentumDefinition(policy), provenance }) satisfies StrategyRuntime

export const makeIntradayAlphaRuntime = (policy: IntradayAlphaPolicy, provenance: RuntimeProvenance) =>
  ({ definition: makeIntradayAlphaDefinition(policy), provenance }) satisfies StrategyRuntime

export const makeEntryAblationRuntime = (policy: EntryAblationPolicy, provenance: RuntimeProvenance) =>
  ({ definition: makeEntryAblationDefinition(policy), provenance }) satisfies StrategyRuntime
