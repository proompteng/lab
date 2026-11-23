import { Result, Schema } from 'effect'

import { makeStrategyProtocolHashResult } from '../contracts'
import { canonicalHashV1Result } from '../hash'
import { JevResearchPolicy } from '../jev/acceptance'
import { JevBatchPlanVersion } from '../jev/batch'
import {
  EntryAblationPolicySchema,
  entryAblationStrategyIdentity,
  makeEntryAblationPolicy,
} from '../jev/entry-ablation-policy'
import { JevProtocolSchema, jevBehaviorHash, type JevProtocol } from '../jev/protocol'
import {
  RepeatedMomentumPolicySchema,
  makeRepeatedMomentumPolicy,
  repeatedMomentumStrategyIdentity,
} from '../strategy/repeated-momentum/policy'
import { Sha256Schema } from '../schemas'

const CompiledReplayPolicySchema = Schema.Literals([
  JevResearchPolicy.Candidate,
  JevResearchPolicy.Ablation,
  JevResearchPolicy.Momentum,
])
export const NativeReplayPolicySchema = Schema.Literals([
  ...CompiledReplayPolicySchema.literals,
  JevResearchPolicy.Incumbent,
])
export type NativeReplayPolicy = typeof NativeReplayPolicySchema.Type

export const NativeReplayIdentitySchema = Schema.Struct({
  policy: CompiledReplayPolicySchema,
  strategy: Schema.Struct({
    name: Schema.Literal('jev'),
    behaviorHash: Sha256Schema,
    parameterHash: Sha256Schema,
    parameterSchemaVersion: Schema.Union([
      JevProtocolSchema.fields.schemaVersion,
      EntryAblationPolicySchema.fields.schemaVersion,
      RepeatedMomentumPolicySchema.fields.schemaVersion,
    ]),
  }),
  protocolHash: Sha256Schema,
  planVersion: Schema.NullOr(Schema.Enum(JevBatchPlanVersion)),
})

/** All native policies are compiled into the same replay executable; their economic identities remain distinct. */
export const nativeReplayPolicyIdentity = <ReplayPolicy extends NativeReplayPolicy>(
  policy: ReplayPolicy,
  protocol: JevProtocol,
) =>
  Result.gen(function* () {
    if (policy === JevResearchPolicy.Ablation)
      return {
        policy,
        ...(yield* entryAblationStrategyIdentity(makeEntryAblationPolicy(protocol))),
        planVersion: JevBatchPlanVersion.Ablation,
      }
    if (policy === JevResearchPolicy.Momentum)
      return {
        policy,
        ...(yield* repeatedMomentumStrategyIdentity(makeRepeatedMomentumPolicy(protocol))),
        planVersion: null,
      }
    const strategy = {
      name: 'jev' as const,
      behaviorHash: jevBehaviorHash,
      parameterHash: yield* canonicalHashV1Result(protocol),
      parameterSchemaVersion: protocol.schemaVersion,
    }
    return {
      policy,
      strategy,
      protocolHash: yield* makeStrategyProtocolHashResult(strategy),
      planVersion: JevBatchPlanVersion.V8,
    }
  })

export const nativeReplayPolicyManifest = (protocol: JevProtocol) =>
  Result.all(CompiledReplayPolicySchema.literals.map((policy) => nativeReplayPolicyIdentity(policy, protocol)))
