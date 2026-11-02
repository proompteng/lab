import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import type { StrategyDefinition } from '../strategy/core'
import { EntryAblationPolicySchema, makeEntryAblationPolicy, type EntryAblationPolicy } from './entry-ablation-policy'
import type { JevDecisionEvidence } from './decision'
import { JevBatchPlanVersion, JevCandidatePlanStatus, JevCandidateResultStatus } from './batch'
import { JevContractError } from './contract'
import { ChartEntryTargetFields, makeChartEntryTargetMaterial, reproduceDecisionEvidence } from './decision'
import { decodeJevEvaluationReceipt, decodeJevEvaluationRequest, entryInferenceAvailableAt } from './evidence'
import { EntryAblationSelection } from './entry-inference-input'
import { JevPurpose } from './portfolio'
import { entryProposalExitPlan, type JevFundedExitPlan } from './strategy-exit-plan'
import { jevEntryQuoteExclusion } from './trading-signals'

/** The candidate's loss and identity tie-breakers, with the Jev ranking removed. */
export const selectEntryAblationProposal = (input: {
  readonly request: unknown
  readonly receipt: unknown
  readonly decidedAt: number
}) =>
  Result.gen(function* () {
    const request = yield* decodeJevEvaluationRequest(input.request)
    if (
      request.request.schemaVersion !== 'bayn.entry-ablation-input.v1' ||
      request.request.selectionPolicy !== EntryAblationSelection.LowestModeledLoss
    )
      return yield* Result.fail(
        new JevContractError({ message: 'Ablation requires its frozen source selection policy' }),
      )
    const receipt = yield* decodeJevEvaluationReceipt(request, input.receipt)
    const { handoff, jev } = yield* entryInferenceAvailableAt(
      request,
      receipt,
      input.decidedAt,
      'bayn.entry-ablation-input.v1',
    )
    if (handoff.disposition.status === 'SOURCE_INFEASIBLE' || handoff.disposition.status === 'NO_FUNDED_PROPOSALS')
      return { request, receipt, proposal: null }
    if (handoff.disposition.status !== 'READY' || jev.status !== 'OMITTED_BY_POLICY')
      return yield* Result.fail(
        new JevContractError({ message: 'Ablation requires actual funded chart proposals and explicit Jev omission' }),
      )
    const proposals = handoff.disposition.evaluation.proposals.toSorted((left, right) => {
      const leftLoss = BigInt(left.funding.acquisitionCostMicros) - BigInt(left.funding.estimatedStopNetMicros)
      const rightLoss = BigInt(right.funding.acquisitionCostMicros) - BigInt(right.funding.estimatedStopNetMicros)
      return leftLoss < rightLoss ? -1 : leftLoss > rightLoss ? 1 : left.proposalId.localeCompare(right.proposalId)
    })
    return { request, receipt, proposal: proposals[0] ?? null }
  }).pipe(
    Result.mapError(
      (cause) => new JevContractError({ message: 'Ablation selection could not reproduce its source evidence', cause }),
    ),
  )

export const decideEntryAblation = (input: unknown) =>
  Result.gen(function* () {
    const source = yield* reproduceDecisionEvidence(input, JevBatchPlanVersion.Ablation)
    if (source.observation.portfolio.purpose !== JevPurpose.Entry)
      return yield* Result.fail(new JevContractError({ message: 'Ablation requires a flat entry observation' }))
    const selected: { symbol: string; weight: number; modeledLossMicros: bigint; exitPlan: JevFundedExitPlan }[] = []
    const entryPlanRejections: Record<string, 'NO_FUNDED_CANDIDATES'> = {}
    for (const candidate of source.evidence.batchPlan.candidates) {
      if (candidate.status !== JevCandidatePlanStatus.Requested) continue
      const result = source.evidence.batchResult.candidates.find((result) => result.symbol === candidate.symbol)
      const quote = source.observation.snapshot.latestQuotes[candidate.symbol]
      if (result?.status !== JevCandidateResultStatus.Resolved || result.receipt === null || quote === undefined)
        return yield* Result.fail(
          new JevContractError({
            message: 'Ablation requires a complete result and verified quote for every requested candidate',
          }),
        )
      const choice = yield* selectEntryAblationProposal({
        request: candidate.request,
        receipt: result.receipt,
        decidedAt: Date.parse(source.evidence.decidedAt),
      })
      if (choice.proposal === null) {
        entryPlanRejections[candidate.symbol] = 'NO_FUNDED_CANDIDATES'
        continue
      }
      if ((yield* jevEntryQuoteExclusion(quote)) !== null) continue
      selected.push({
        symbol: candidate.symbol,
        weight: choice.proposal.funding.maximumTargetWeight,
        modeledLossMicros:
          BigInt(choice.proposal.funding.acquisitionCostMicros) -
          BigInt(choice.proposal.funding.estimatedStopNetMicros),
        exitPlan: entryProposalExitPlan(choice.proposal),
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
  }).pipe(
    Result.mapError(
      (cause) => new JevContractError({ message: 'Ablation target could not reproduce its source evidence', cause }),
    ),
  )

export const EntryAblationTargetSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.entry-ablation-target.v1'),
  strategy: Schema.Literal('jev'),
  policy: EntryAblationPolicySchema,
  ...ChartEntryTargetFields,
}).check(
  Schema.makeFilter((target) => {
    const { evidence, ...material } = target
    const reproduced = decideEntryAblation(evidence).pipe(
      Result.flatMap(({ evidence: _, ...derived }) => canonicalHashV1Result(derived)),
    )
    const supplied = canonicalHashV1Result(material)
    return Result.isSuccess(reproduced) && Result.isSuccess(supplied) && reproduced.success === supplied.success
      ? []
      : [{ path: ['evidence'], issue: 'complete recorded ablation evidence must reproduce the exact target' }]
  }),
)
export type EntryAblationTarget = typeof EntryAblationTargetSchema.Type

export const makeEntryAblationDefinition = (
  policy: EntryAblationPolicy,
): StrategyDefinition<JevDecisionEvidence, JevContractError, EntryAblationTarget, EntryAblationPolicy> => ({
  name: 'jev',
  holdingPeriod: 'INTRADAY',
  parameters: policy,
  decide: ({ market }) =>
    Result.gen(function* () {
      const target = yield* decideEntryAblation(market)
      if ((yield* canonicalHashV1Result(target.policy)) !== (yield* canonicalHashV1Result(policy)))
        return yield* Result.fail(
          new JevContractError({ message: 'Ablation evidence differs from its registered policy' }),
        )
      return target
    }).pipe(Result.mapError((cause) => new JevContractError({ message: 'Ablation strategy decision failed', cause }))),
})
