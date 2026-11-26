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
import { makeIntradayAlphaPolicy } from '../strategy/intraday-alpha/policy'
import {
  makeResearchStrategyBinding,
  ResearchStrategyEngine,
  researchStrategyEngineMatchesRole,
  validateResearchStrategyBinding,
  type ResearchStrategyBinding,
} from '../system-assessment/strategy-binding'
import { SystemAssessmentError } from '../system-assessment/economics'

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

/** The new catalog names implementations; Candidate and Incumbent are economic roles only. */
export const nativeReplayStrategyManifest = (protocol: JevProtocol) =>
  Result.all([
    makeResearchStrategyBinding({ engine: ResearchStrategyEngine.Jev, parameters: protocol }),
    makeResearchStrategyBinding({
      engine: ResearchStrategyEngine.IntradayAlpha,
      parameters: makeIntradayAlphaPolicy(protocol),
    }),
    makeResearchStrategyBinding({
      engine: ResearchStrategyEngine.EntryAblation,
      parameters: makeEntryAblationPolicy(protocol),
    }),
    makeResearchStrategyBinding({
      engine: ResearchStrategyEngine.RepeatedMomentum,
      parameters: makeRepeatedMomentumPolicy(protocol),
    }),
  ])

export const nativeReplayStrategyIdentity = (
  policy: NativeReplayPolicy,
  raw: ResearchStrategyBinding,
  protocol: JevProtocol,
) =>
  Result.gen(function* () {
    const binding = yield* validateResearchStrategyBinding(raw)
    const compiled = yield* nativeReplayStrategyManifest(protocol)
    const exact = compiled.find((entry) => entry.engine === binding.engine)
    if (
      !researchStrategyEngineMatchesRole(policy, binding.engine) ||
      exact === undefined ||
      (yield* canonicalHashV1Result(exact)) !== (yield* canonicalHashV1Result(binding))
    )
      return yield* Result.fail(
        new SystemAssessmentError({ message: 'Replay binding differs from its compiled engine or policy role' }),
      )
    return {
      policy,
      strategy: binding.strategy,
      protocolHash: binding.protocolHash,
      planVersion:
        binding.engine === ResearchStrategyEngine.Jev
          ? JevBatchPlanVersion.V8
          : binding.engine === ResearchStrategyEngine.EntryAblation
            ? JevBatchPlanVersion.Ablation
            : null,
    }
  })
