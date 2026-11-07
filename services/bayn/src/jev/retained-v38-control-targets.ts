import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { strictParseOptions } from '../schemas'
import {
  deriveMomentumTargetMaterial,
  MomentumDecisionEvidenceSchema,
  RepeatedMomentumTargetSchema,
} from '../strategy/repeated-momentum/decision'
import { RepeatedMomentumPolicySchema } from '../strategy/repeated-momentum/policy'
import { JevBatchPlanVersion, JevCandidatePlanStatus } from './batch'
import { JevContractError } from './contract'
import { makeChartEntryTargetMaterial } from './decision'
import { EntryAblationTargetSchema, selectFundedEntryAblationProposal } from './entry-ablation'
import { EntryAblationPolicySchema, makeEntryAblationPolicy } from './entry-ablation-policy'
import { reproduceRetainedJevV38CandidateObservation } from './observation'
import { RetainedJevV38ObservationSchema } from './observation-contract'
import { RetainedJevProtocolV38Schema } from './protocol'
import { reproduceRetainedJevV38DecisionSource, RetainedJevV38DecisionEvidenceSchema } from './retained-v38-targets'
import { entryProposalExitPlan, type JevFundedExitPlan } from './strategy-exit-plan'
import { jevEntryQuoteExclusion } from './trading-signals'

export const RetainedJevV38AblationPolicySchema = Schema.Struct({
  ...EntryAblationPolicySchema.fields,
  sharedProtocol: RetainedJevProtocolV38Schema,
})
export const RetainedJevV38MomentumPolicySchema = Schema.Struct({
  ...RepeatedMomentumPolicySchema.fields,
  sharedProtocol: RetainedJevProtocolV38Schema,
})

/** Preserve the original control's exact funded-loss ranking and omitted Jev stage. */
export const reproduceRetainedJevV38AblationTarget = (input: unknown) =>
  Result.gen(function* () {
    const source = yield* reproduceRetainedJevV38DecisionSource(input, JevBatchPlanVersion.Ablation)
    const selected: { symbol: string; weight: number; modeledLossMicros: bigint; exitPlan: JevFundedExitPlan }[] = []
    const entryPlanRejections: Record<string, 'NO_FUNDED_CANDIDATES'> = {}
    for (const candidate of source.evidence.batchPlan.candidates) {
      if (candidate.status !== JevCandidatePlanStatus.Requested) continue
      const available = source.inferences.find((inference) => inference.symbol === candidate.symbol)
      const quote = source.observation.snapshot.latestQuotes[candidate.symbol]
      if (available === undefined || quote === undefined)
        return yield* Result.fail(
          new JevContractError({ message: 'Retained ablation requires every original inference and quote' }),
        )
      const proposal = yield* selectFundedEntryAblationProposal(available.inference)
      if (proposal === null) {
        entryPlanRejections[candidate.symbol] = 'NO_FUNDED_CANDIDATES'
        continue
      }
      if ((yield* jevEntryQuoteExclusion(quote)) !== null) continue
      selected.push({
        symbol: candidate.symbol,
        weight: proposal.funding.maximumTargetWeight,
        modeledLossMicros:
          BigInt(proposal.funding.acquisitionCostMicros) - BigInt(proposal.funding.estimatedStopNetMicros),
        exitPlan: entryProposalExitPlan(proposal),
      })
    }
    selected.sort((left, right) =>
      left.modeledLossMicros < right.modeledLossMicros
        ? -1
        : left.modeledLossMicros > right.modeledLossMicros
          ? 1
          : left.symbol.localeCompare(right.symbol),
    )
    return {
      schemaVersion: 'bayn.entry-ablation-target.v1' as const,
      strategy: 'jev' as const,
      policy: makeEntryAblationPolicy(source.observation.protocol),
      ...(yield* makeChartEntryTargetMaterial(source, {
        entryPlanRejections,
        selected: selected.slice(0, source.observation.protocol.maximumPositions),
      })),
    }
  })

const same = (left: unknown, right: unknown) => {
  const a = canonicalHashV1Result(left)
  const b = canonicalHashV1Result(right)
  return Result.isSuccess(a) && Result.isSuccess(b) && a.success === b.success
}

export const RetainedJevV38AblationTargetSchema = Schema.Struct({
  ...EntryAblationTargetSchema.fields,
  policy: RetainedJevV38AblationPolicySchema,
  evidence: RetainedJevV38DecisionEvidenceSchema,
}).check(
  Schema.makeFilter((target) => {
    const reproduced = reproduceRetainedJevV38AblationTarget(target.evidence)
    return Result.isSuccess(reproduced) && same(reproduced.success, target)
      ? []
      : [{ path: ['evidence'], issue: 'original v38 ablation evidence must reproduce the exact retained target' }]
  }),
)

const RetainedMomentumEvidenceSchema = Schema.Struct({
  ...MomentumDecisionEvidenceSchema.fields,
  observation: RetainedJevV38ObservationSchema,
})
export const reproduceRetainedJevV38MomentumTarget = (input: unknown, policy: unknown) =>
  Result.gen(function* () {
    const verifiedPolicy = yield* Schema.decodeUnknownResult(
      RetainedJevV38MomentumPolicySchema,
      strictParseOptions,
    )(policy)
    const evidence = yield* Schema.decodeUnknownResult(RetainedMomentumEvidenceSchema, strictParseOptions)(input)
    const observation = yield* reproduceRetainedJevV38CandidateObservation(evidence.observation)
    return yield* deriveMomentumTargetMaterial(verifiedPolicy, evidence, observation)
  })
export const RetainedJevV38MomentumTargetSchema = Schema.Struct({
  ...RepeatedMomentumTargetSchema.fields,
  policy: RetainedJevV38MomentumPolicySchema,
  evidence: RetainedMomentumEvidenceSchema,
}).check(
  Schema.makeFilter((target) => {
    const reproduced = reproduceRetainedJevV38MomentumTarget(target.evidence, target.policy)
    return Result.isSuccess(reproduced) && same(reproduced.success, target)
      ? []
      : [
          {
            path: ['evidence'],
            issue: 'original v38 momentum policy and source must reproduce the exact retained target',
          },
        ]
  }),
)

export type RetainedJevV38AblationTarget = typeof RetainedJevV38AblationTargetSchema.Type
export type RetainedJevV38MomentumTarget = typeof RetainedJevV38MomentumTargetSchema.Type
