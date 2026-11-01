import { Context, Data, type Effect, Result } from 'effect'

import type { OperationalError } from '../errors'
import { makeNativeChartEvidence } from './chart-evidence'
import {
  makeStagedDispatchClaim,
  stageResponseIdentity,
  type StagedDispatchClaim,
  type StagedTerminalReceipt,
  type BaseStartEvidence,
} from './staged-checkpoint'
import { type ChartAssessments, type ChartAssessmentsMaterial } from './chart-questions'
import { makeInitialChartStageRequest, stagedChartAssessments } from './staged-chart-questions'
import type { JevInference } from './client'
import { JevFailure, JevResponseSchema, type JevRequest } from './contract'
import type { DecisionsError, DecisionsInference, DecisionsUsageSchema } from './decisions'
import { jevEntryEconomics } from './entry-economics'
import {
  prepareEntryInferenceInput,
  type EntryInferenceInput,
  type EntryInferenceMaterial,
} from './entry-inference-input'
import {
  makeEntrySourceCandidates,
  makeEntryProposals,
  EntrySetup,
  ProposalRejection,
  type EntryProposal,
} from './entry-proposals'
import { makeEntryJudgmentRequest } from './entry-questions'

export type VisualFailureEvidence = {
  readonly category: DecisionsError['category']
  readonly httpStatus: number | null
  readonly responseHash: string | null
  readonly usage: typeof DecisionsUsageSchema.Type | null
}
type ProposalEvaluation = {
  readonly proposals: readonly EntryProposal[]
  readonly rejections: readonly { readonly setup: EntrySetup; readonly reason: ProposalRejection }[]
}
type HandoffDispositionFor<A extends ChartAssessmentsMaterial> =
  | { readonly status: 'SOURCE_INFEASIBLE' }
  | { readonly status: 'VISUAL_FAILED'; readonly failure: VisualFailureEvidence }
  | {
      readonly status: 'PREPARATION_FAILED'
      readonly visual: DecisionsInference
      readonly reason: 'VISUAL_RECEIPT_MISMATCH' | 'DERIVATION_CONTRACT' | 'BASE_START_FAILED'
    }
  | {
      readonly status: 'NO_FUNDED_PROPOSALS'
      readonly visual: DecisionsInference
      readonly assessments: A
      readonly evaluation: ProposalEvaluation
    }
  | {
      readonly status: 'READY'
      readonly visual: DecisionsInference
      readonly assessments: A
      readonly evaluation: ProposalEvaluation
      readonly jevRequest: JevRequest
      readonly jevRequestHash: string
    }

type HandoffDisposition = HandoffDispositionFor<ChartAssessments>

export interface EntryHandoff {
  readonly schemaVersion: 'bayn.entry-handoff.v4'
  readonly requestId: string
  readonly inputHash: string
  readonly visualRequestHash: string
  readonly recordedAt: string
  readonly disposition: HandoffDisposition
  readonly baseStart: BaseStartEvidence
  readonly handoffHash: string
}
export type EntryHandoffMaterial = Omit<EntryHandoff, 'disposition' | 'schemaVersion' | 'baseStart'> & {
  readonly schemaVersion:
    | 'bayn.entry-handoff.v1'
    | 'bayn.entry-handoff.v2'
    | 'bayn.entry-handoff.v3'
    | 'bayn.entry-handoff.v4'
  readonly disposition: HandoffDispositionFor<ChartAssessmentsMaterial>
  readonly baseStart?: BaseStartEvidence
}

export type VisualTransition = {
  readonly terminal: StagedTerminalReceipt
  readonly successor:
    | { readonly kind: 'NONE' }
    | { readonly kind: 'VISUAL'; readonly claim: StagedDispatchClaim }
    | { readonly kind: 'HANDOFF'; readonly handoff: EntryHandoff }
}

export type EntryStageTransition =
  | VisualTransition
  | { readonly terminal: null; readonly successor: { readonly kind: 'HANDOFF'; readonly handoff: EntryHandoff } }

export class EntryInferenceJournal extends Context.Service<
  EntryInferenceJournal,
  {
    readonly recordVisualClaims: (
      claims: readonly StagedDispatchClaim[],
    ) => Effect.Effect<readonly { readonly requestId: string; readonly dispatchAllowed: boolean }[], OperationalError>
    readonly recordTransitions: (
      transitions: readonly EntryStageTransition[],
    ) => Effect.Effect<readonly { readonly requestId: string; readonly dispatchAllowed: boolean }[], OperationalError>
  }
>()('@proompteng/bayn/EntryInferenceJournal') {}

export interface EntryInferenceClaim {
  readonly requestId: string
  readonly input: EntryInferenceInput
  readonly observedAt: string
  readonly expiresAt: string
  readonly claimedAt: string
}

export const prepareClaimedEntry = (claim: EntryInferenceClaim) =>
  Result.gen(function* () {
    const prepared = yield* prepareEntryInferenceInput(claim.input)
    const observed = Date.parse(claim.observedAt)
    const expires = Date.parse(claim.expiresAt)
    const started = Date.parse(claim.claimedAt)
    if (
      ![observed, expires, started].every(Number.isSafeInteger) ||
      started < observed ||
      started >= expires ||
      Date.parse(prepared.input.chartSource.windowEndAt) > observed ||
      expires - observed !== prepared.input.protocol.inferenceValidityMs
    )
      return yield* Result.fail(
        new EntryInferenceError({
          category: 'DEADLINE',
          message: 'Entry inference claim is outside its original evidence window',
        }),
      )
    const chart = yield* makeNativeChartEvidence(prepared.input.chartSource)
    const visualRequest = yield* makeInitialChartStageRequest({
      chart,
      protocol: prepared.input.protocol,
      funding: prepared.input.funding,
    })
    const sourceFeasibility = yield* evaluateEntrySourceFeasibility(prepared.input, chart)
    const visualClaim = sourceFeasibility.feasible
      ? yield* makeStagedDispatchClaim({
          schemaVersion: 'bayn.staged-dispatch-claim.v1',
          stage: 'CHART',
          requestId: claim.requestId,
          providerRequestHash: visualRequest.requestHash,
          predecessorHash: null,
          selectedEnd: null,
          claimedAt: claim.claimedAt,
          expiresAt: claim.expiresAt,
        })
      : null
    return { claim, prepared, chart, visualRequest, visualClaim, sourceFeasibility }
  })

export class EntryInferenceError extends Data.TaggedError('EntryInferenceError')<{
  readonly message: string
  readonly category: 'INPUT' | 'DEADLINE' | 'EXISTING_HANDOFF'
  readonly cause?: unknown
}> {}

export type EntryInferenceCompletion = {
  readonly handoff: EntryHandoff
  readonly completedAt: string
  readonly jev:
    | { readonly status: 'RECEIVED'; readonly inference: JevInference }
    | {
        readonly status: 'FAILED'
        readonly failure: JevFailure
        readonly httpStatus: number | null
        readonly responseHash: string | null
        readonly usage: typeof JevResponseSchema.fields.usage.Type | null
      }
    | { readonly status: 'NOT_REQUESTED' }
    | { readonly status: 'NOT_DISPATCHED' }
    | { readonly status: 'OMITTED_BY_POLICY' }
}

export enum EntrySourceFeasibilityReason {
  Feasible = 'FEASIBLE',
  NoExecutableQuantity = 'NO_EXECUTABLE_QUANTITY',
  NoFundedSourceStructure = 'NO_FUNDED_SOURCE_STRUCTURE',
}

export interface EntrySourceFeasibility {
  readonly feasible: boolean
  readonly reason: EntrySourceFeasibilityReason
  readonly supportBarCount: number
  readonly resistanceBarCount: number
  readonly baseWindowCount: number
}

export const evaluateEntrySourceFeasibility = (
  input: Pick<EntryInferenceMaterial, 'protocol' | 'funding'>,
  chart: Result.Result.Success<ReturnType<typeof makeNativeChartEvidence>>,
) =>
  Result.gen(function* () {
    const economics = yield* jevEntryEconomics({
      feeAt: chart.windowEndAt,
      protocol: input.protocol,
      symbol: chart.symbol,
      bidMicros: BigInt(input.funding.bidMicros),
      askMicros: BigInt(input.funding.askMicros),
      capitalMicros: input.funding.capitalMicros,
      cryptoFeeTier: input.funding.cryptoFeeTier,
    })
    if (economics === null)
      return {
        feasible: false,
        reason: EntrySourceFeasibilityReason.NoExecutableQuantity,
        supportBarCount: 0,
        resistanceBarCount: 0,
        baseWindowCount: 0,
      } satisfies EntrySourceFeasibility
    const candidates = yield* makeEntrySourceCandidates({
      chart,
      economics,
      protocol: input.protocol,
      bidMicros: BigInt(input.funding.bidMicros),
    })
    const feasible =
      candidates.baseWindows.length > 0 ||
      (candidates.supportBarIds.length > 0 && candidates.resistanceBarIds.length > 0)
    return {
      feasible,
      reason: feasible ? EntrySourceFeasibilityReason.Feasible : EntrySourceFeasibilityReason.NoFundedSourceStructure,
      supportBarCount: candidates.supportBarIds.length,
      resistanceBarCount: candidates.resistanceBarIds.length,
      baseWindowCount: candidates.baseWindows.length,
    } satisfies EntrySourceFeasibility
  })

export const hasFeasibleEntrySource = (
  input: Pick<EntryInferenceMaterial, 'protocol' | 'funding'>,
  chart: Result.Result.Success<ReturnType<typeof makeNativeChartEvidence>>,
) => evaluateEntrySourceFeasibility(input, chart).pipe(Result.map((result) => result.feasible))

export const deriveEntryHandoffDisposition = (
  input: EntryInferenceInput,
  visual: DecisionsInference,
  baseStart: DecisionsInference | null = null,
) =>
  Result.gen(function* () {
    const chart = yield* makeNativeChartEvidence(input.chartSource)
    return yield* deriveEntryDispositionForChart(
      input,
      visual,
      chart,
      yield* stagedChartAssessments(
        { chart, protocol: input.protocol, funding: input.funding },
        stageResponseIdentity(visual),
        baseStart === null ? null : stageResponseIdentity(baseStart),
      ),
      makeEntryJudgmentRequest,
    )
  })

export const deriveEntryDispositionForChart = <A extends ChartAssessmentsMaterial>(
  input: Pick<EntryInferenceMaterial, 'numericalState' | 'protocol' | 'funding'>,
  visual: DecisionsInference,
  chart: Result.Result.Success<ReturnType<typeof makeNativeChartEvidence>>,
  assessments: A,
  prepareJudgments: typeof makeEntryJudgmentRequest,
) =>
  Result.gen(function* () {
    const economics = yield* jevEntryEconomics({
      feeAt: chart.windowEndAt,
      protocol: input.protocol,
      symbol: chart.symbol,
      bidMicros: BigInt(input.funding.bidMicros),
      askMicros: BigInt(input.funding.askMicros),
      capitalMicros: input.funding.capitalMicros,
      cryptoFeeTier: input.funding.cryptoFeeTier,
    })
    const evaluation =
      economics === null
        ? {
            proposals: [],
            rejections: [EntrySetup.SupportRecovery, EntrySetup.BaseBreakout].map((setup) => ({
              setup,
              reason: ProposalRejection.NoQuantity,
            })),
          }
        : yield* makeEntryProposals({
            chart,
            assessments,
            economics,
            protocol: input.protocol,
            bidMicros: BigInt(input.funding.bidMicros),
          })
    const jev = yield* prepareJudgments({
      numericalState: input.numericalState,
      chart,
      assessments,
      proposals: evaluation.proposals,
    })
    return jev === null
      ? ({ status: 'NO_FUNDED_PROPOSALS', visual, assessments, evaluation } as const)
      : ({
          status: 'READY',
          visual,
          assessments,
          evaluation,
          jevRequest: jev.request,
          jevRequestHash: jev.requestHash,
        } as const)
  })
