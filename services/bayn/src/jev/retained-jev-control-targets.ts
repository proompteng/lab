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
import {
  EntryAblationPolicySchema,
  makeEntryAblationPolicy,
  retainedJevAblationQuestionPolicyHash,
} from './entry-ablation-policy'
import { reproduceRetainedJevCandidateObservation } from './observation'
import { RetainedJevObservationSchema } from './observation-contract'
import { RetainedVisualJevProtocolSchema } from './protocol'
import { reproduceRetainedJevDecisionSource, RetainedJevDecisionEvidenceSchema } from './retained-jev-targets'
import { entryProposalExitPlan, type JevFundedExitPlan } from './strategy-exit-plan'
import { jevEntryQuoteExclusion } from './trading-signals'

export const RetainedJevAblationPolicySchema = Schema.Struct({
  ...EntryAblationPolicySchema.fields,
  questionPolicyHash: Schema.Literal(retainedJevAblationQuestionPolicyHash),
  sharedProtocol: RetainedVisualJevProtocolSchema,
})
export const RetainedJevMomentumPolicySchema = Schema.Struct({
  ...RepeatedMomentumPolicySchema.fields,
  sharedProtocol: RetainedVisualJevProtocolSchema,
})

/** Preserve the original control's exact funded-loss ranking and omitted Jev stage. */
export const reproduceRetainedJevAblationTarget = (input: unknown) =>
  Result.gen(function* () {
    const source = yield* reproduceRetainedJevDecisionSource(input, JevBatchPlanVersion.Ablation)
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

export const RetainedJevAblationTargetSchema = Schema.Struct({
  ...EntryAblationTargetSchema.fields,
  policy: RetainedJevAblationPolicySchema,
  evidence: RetainedJevDecisionEvidenceSchema,
}).check(
  Schema.makeFilter((target) => {
    const reproduced = reproduceRetainedJevAblationTarget(target.evidence)
    return Result.isSuccess(reproduced) && same(reproduced.success, target)
      ? []
      : [{ path: ['evidence'], issue: 'original v38 ablation evidence must reproduce the exact retained target' }]
  }),
)

const RetainedMomentumEvidenceSchema = Schema.Struct({
  ...MomentumDecisionEvidenceSchema.fields,
  observation: RetainedJevObservationSchema,
})
export const reproduceRetainedJevMomentumTarget = (input: unknown, policy: unknown) =>
  Result.gen(function* () {
    const verifiedPolicy = yield* Schema.decodeUnknownResult(
      RetainedJevMomentumPolicySchema,
      strictParseOptions,
    )(policy)
    const evidence = yield* Schema.decodeUnknownResult(RetainedMomentumEvidenceSchema, strictParseOptions)(input)
    const observation = yield* reproduceRetainedJevCandidateObservation(evidence.observation)
    return yield* deriveMomentumTargetMaterial(verifiedPolicy, evidence, observation)
  })
export const RetainedJevMomentumTargetSchema = Schema.Struct({
  ...RepeatedMomentumTargetSchema.fields,
  policy: RetainedJevMomentumPolicySchema,
  evidence: RetainedMomentumEvidenceSchema,
}).check(
  Schema.makeFilter((target) => {
    const reproduced = reproduceRetainedJevMomentumTarget(target.evidence, target.policy)
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

export type RetainedJevAblationTarget = typeof RetainedJevAblationTargetSchema.Type
export type RetainedJevMomentumTarget = typeof RetainedJevMomentumTargetSchema.Type
