import { Clock, Context, Data, Effect, Redacted, Result, Schema } from 'effect'

import type { OperationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import { utcInstantFromEpochMillis } from '../time'
import { makeNativeChartEvidence } from './chart-evidence'
import {
  makeStagedDispatchClaim,
  makeStagedTerminalReceipt,
  makeStagedSkipReceipt,
  stageResponseIdentity,
  type StagedDispatchClaim,
  type StagedTerminalReceipt,
  type StagedSkipReceipt,
  type BaseStartEvidence,
} from './staged-checkpoint'
import { type ChartAssessments, type ChartAssessmentsMaterial } from './chart-questions'
import {
  makeInitialChartStageRequest,
  makeSelectedBaseStartStageRequest,
  stagedChartAssessments,
} from './staged-chart-questions'
import { JevClient, type JevError, type JevInference } from './client'
import { decodeJevResponse, JevFailure, JevResponseSchema, type JevRequest } from './contract'
import { DecisionsClient, type DecisionsError, type DecisionsInference, type DecisionsUsageSchema } from './decisions'
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

export class EntryInferenceJournal extends Context.Service<
  EntryInferenceJournal,
  {
    readonly recordVisualClaim: (
      claim: StagedDispatchClaim,
    ) => Effect.Effect<{ readonly dispatchAllowed: boolean }, OperationalError>
    readonly recordVisualTerminal: (receipt: StagedTerminalReceipt) => Effect.Effect<void, OperationalError>
    readonly recordBaseStartSkip: (receipt: StagedSkipReceipt) => Effect.Effect<void, OperationalError>
    readonly recordHandoff: (
      handoff: EntryHandoff,
    ) => Effect.Effect<{ readonly dispatchAllowed: boolean }, OperationalError>
  }
>()('@proompteng/bayn/EntryInferenceJournal') {}

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
}

const rejectedJevUsage = (error: JevError, expectedRequestHash: string) => {
  if (
    error.requestHash !== expectedRequestHash ||
    error.rejectedResponse === undefined ||
    error.responseHash === undefined
  )
    return null
  const raw = Redacted.value(error.rejectedResponse)
  const hash = canonicalHashV1Result(raw)
  const metering = Schema.decodeUnknownResult(
    Schema.Struct({ model: JevResponseSchema.fields.model, usage: JevResponseSchema.fields.usage }),
  )(raw)
  return Result.isSuccess(hash) && hash.success === error.responseHash && Result.isSuccess(metering)
    ? metering.success.usage
    : null
}

export const hasFeasibleEntrySource = (
  input: Pick<EntryInferenceMaterial, 'protocol' | 'funding'>,
  chart: Result.Result.Success<ReturnType<typeof makeNativeChartEvidence>>,
) =>
  Result.gen(function* () {
    const economics = yield* jevEntryEconomics({
      protocol: input.protocol,
      symbol: chart.symbol,
      bidMicros: BigInt(input.funding.bidMicros),
      askMicros: BigInt(input.funding.askMicros),
      capitalMicros: input.funding.capitalMicros,
      cryptoFeeTier: input.funding.cryptoFeeTier,
    })
    if (economics === null) return false
    const candidates = yield* makeEntrySourceCandidates({
      chart,
      economics,
      protocol: input.protocol,
      bidMicros: BigInt(input.funding.bidMicros),
    })
    return (
      candidates.baseWindows.length > 0 ||
      (candidates.supportBarIds.length > 0 && candidates.resistanceBarIds.length > 0)
    )
  })

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

export const evaluateClaimedEntryInference = (claim: {
  readonly requestId: string
  readonly input: EntryInferenceInput
  readonly observedAt: string
  readonly expiresAt: string
  readonly claimedAt: string
}) =>
  Effect.gen(function* () {
    const prepared = yield* Effect.fromResult(prepareEntryInferenceInput(claim.input)).pipe(
      Effect.mapError(
        (cause) => new EntryInferenceError({ category: 'INPUT', message: 'Entry inference claim is malformed', cause }),
      ),
    )
    const observed = Date.parse(claim.observedAt)
    const expires = Date.parse(claim.expiresAt)
    const started = Date.parse(claim.claimedAt)
    const now = yield* Clock.currentTimeMillis
    if (
      !Number.isFinite(observed) ||
      !Number.isFinite(expires) ||
      !Number.isFinite(started) ||
      started < observed ||
      Date.parse(prepared.input.chartSource.windowEndAt) > observed ||
      started >= expires ||
      expires - observed !== prepared.input.protocol.inferenceValidityMs ||
      now < started ||
      now >= expires
    )
      return yield* new EntryInferenceError({
        category: 'DEADLINE',
        message: 'Entry inference claim is outside its original evidence window',
      })
    const chart = yield* Effect.fromResult(makeNativeChartEvidence(prepared.input.chartSource))
    const visualRequest = yield* Effect.fromResult(
      makeInitialChartStageRequest({ chart, protocol: prepared.input.protocol, funding: prepared.input.funding }),
    )
    const feasible = yield* Effect.fromResult(hasFeasibleEntrySource(prepared.input, chart))
    const journal = yield* EntryInferenceJournal
    const runVisual = (
      stage: StagedDispatchClaim['stage'],
      providerRequest: Pick<typeof visualRequest, 'request' | 'requestHash' | 'body'>,
      predecessor: StagedTerminalReceipt | null,
      selectedEnd: string | null,
    ) =>
      Effect.gen(function* () {
        const admittedAt = yield* Clock.currentTimeMillis
        if (admittedAt < now || admittedAt >= expires)
          return yield* new EntryInferenceError({
            category: 'DEADLINE',
            message: 'Original evidence window expired before visual admission',
          })
        const dispatchClaim = yield* Effect.fromResult(
          makeStagedDispatchClaim({
            schemaVersion: 'bayn.staged-dispatch-claim.v1',
            stage,
            requestId: claim.requestId,
            providerRequestHash: providerRequest.requestHash,
            predecessorHash: predecessor?.terminalHash ?? null,
            selectedEnd,
            claimedAt: utcInstantFromEpochMillis(admittedAt),
            expiresAt: claim.expiresAt,
          }),
        )
        const admitted = yield* journal.recordVisualClaim(dispatchClaim)
        if (!admitted.dispatchAllowed)
          return yield* new EntryInferenceError({
            category: 'EXISTING_HANDOFF',
            message: 'Visual stage is already claimed; uncertain dispatch cannot be repeated',
          })
        const dispatchAt = yield* Clock.currentTimeMillis
        if (dispatchAt < admittedAt || dispatchAt >= expires)
          return yield* new EntryInferenceError({
            category: 'DEADLINE',
            message: 'Original evidence window expired while committing visual admission',
          })
        const decisions = yield* DecisionsClient
        const visual = yield* decisions.evaluate(providerRequest.request, expires - dispatchAt).pipe(
          Effect.timeoutOrElse({
            duration: expires - dispatchAt,
            orElse: () =>
              Effect.fail(
                new EntryInferenceError({
                  category: 'DEADLINE',
                  message: 'Original evidence window expired during visual inference',
                }),
              ),
          }),
          Effect.result,
        )
        let outcome: StagedTerminalReceipt['outcome']
        const returnedAt = yield* Clock.currentTimeMillis
        if (Result.isFailure(visual)) {
          const failure = visual.failure
          outcome = {
            status: 'FAILED',
            failure:
              failure instanceof EntryInferenceError
                ? { category: 'DEADLINE', httpStatus: null, responseHash: null, usage: null }
                : {
                    category: failure.category,
                    httpStatus: failure.status ?? null,
                    responseHash:
                      failure.requestHash === providerRequest.requestHash ? (failure.responseHash ?? null) : null,
                    usage: failure.requestHash === providerRequest.requestHash ? (failure.usage ?? null) : null,
                  },
          }
        } else {
          const received = visual.success
          const responseHash = yield* Effect.fromResult(canonicalHashV1Result(received.response))
          if (
            received.requestHash !== providerRequest.requestHash ||
            received.responseHash !== responseHash ||
            Date.parse(received.startedAt) < dispatchAt ||
            received.completedAt < received.startedAt ||
            Date.parse(received.completedAt) > returnedAt
          )
            return yield* new EntryInferenceError({
              category: 'INPUT',
              message: 'Visual response does not match its dispatch claim',
            })
          outcome = { status: 'RECEIVED', inference: received }
        }
        const terminal = yield* Effect.fromResult(
          makeStagedTerminalReceipt({
            schemaVersion: 'bayn.staged-terminal-receipt.v1',
            stage,
            requestId: claim.requestId,
            claimHash: dispatchClaim.claimHash,
            recordedAt: utcInstantFromEpochMillis(returnedAt),
            outcome,
          }),
        )
        // Each paid provider boundary is durable before any successor is admitted.
        yield* journal.recordVisualTerminal(terminal)
        return terminal
      })
    const skipBase = (reason: StagedSkipReceipt['reason'], predecessor: StagedTerminalReceipt | null) =>
      Effect.gen(function* () {
        const skip = yield* Effect.fromResult(
          makeStagedSkipReceipt({
            schemaVersion: 'bayn.staged-skip-receipt.v1',
            stage: 'BASE_START',
            requestId: claim.requestId,
            reason,
            predecessorHash: predecessor?.terminalHash ?? null,
            recordedAt: utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
          }),
        )
        yield* journal.recordBaseStartSkip(skip)
        return { status: 'NOT_REQUESTED' as const, skip }
      })
    let disposition: HandoffDisposition
    let baseStart: BaseStartEvidence
    if (!feasible) {
      disposition = { status: 'SOURCE_INFEASIBLE' }
      baseStart = yield* skipBase('SOURCE_INFEASIBLE', null)
    } else {
      const visualTerminal = yield* runVisual('CHART', visualRequest, null, null)
      if (visualTerminal.outcome.status === 'FAILED') {
        disposition = { status: 'VISUAL_FAILED', failure: visualTerminal.outcome.failure }
        baseStart = yield* skipBase('CHART_FAILED', visualTerminal)
      } else {
        const visual = visualTerminal.outcome.inference
        const next = yield* Effect.fromResult(
          makeSelectedBaseStartStageRequest(
            { chart, protocol: prepared.input.protocol, funding: prepared.input.funding },
            stageResponseIdentity(visual),
          ),
        )
        if (next.status === 'NOT_REQUESTED') {
          baseStart = yield* skipBase(next.reason, visualTerminal)
        } else {
          const terminal = yield* runVisual('BASE_START', next, visualTerminal, next.selectedEnd)
          baseStart = terminal.outcome
        }
        if (baseStart.status === 'FAILED') {
          disposition = { status: 'PREPARATION_FAILED', visual, reason: 'BASE_START_FAILED' }
        } else {
          const derived = deriveEntryHandoffDisposition(
            prepared.input,
            visual,
            baseStart.status === 'RECEIVED' ? baseStart.inference : null,
          )
          disposition = Result.isSuccess(derived)
            ? derived.success
            : { status: 'PREPARATION_FAILED', visual, reason: 'DERIVATION_CONTRACT' }
        }
      }
    }
    const material = {
      schemaVersion: 'bayn.entry-handoff.v4' as const,
      requestId: claim.requestId,
      inputHash: prepared.requestHash,
      visualRequestHash: visualRequest.requestHash,
      recordedAt: utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
      disposition,
      baseStart,
    }
    const handoff: EntryHandoff = {
      ...material,
      handoffHash: yield* Effect.fromResult(canonicalHashV1Result(material)),
    }
    const admission = yield* journal.recordHandoff(handoff)
    if (!admission.dispatchAllowed)
      return yield* new EntryInferenceError({
        category: 'EXISTING_HANDOFF',
        message: 'This provider handoff is already claimed; repeated dispatch is forbidden',
      })
    const completed = (jev: EntryInferenceCompletion['jev']) =>
      Effect.map(
        Clock.currentTimeMillis,
        (at): EntryInferenceCompletion => ({ handoff, completedAt: utcInstantFromEpochMillis(at), jev }),
      )
    if (disposition.status !== 'READY') return yield* completed({ status: 'NOT_REQUESTED' })
    const jevNow = yield* Clock.currentTimeMillis
    if (jevNow < Date.parse(handoff.recordedAt))
      return yield* new EntryInferenceError({
        category: 'DEADLINE',
        message: 'Entry inference clock regressed after the committed provider handoff',
      })
    if (jevNow >= expires) return yield* completed({ status: 'NOT_DISPATCHED' })
    const client = yield* JevClient
    const inference = yield* client.evaluate(disposition.jevRequest, expires - jevNow).pipe(
      Effect.timeoutOrElse({
        duration: expires - jevNow,
        orElse: () =>
          Effect.fail(
            new EntryInferenceError({
              category: 'DEADLINE',
              message: 'Original evidence window expired during Jev inference',
            }),
          ),
      }),
      Effect.result,
    )
    if (Result.isFailure(inference)) {
      const failure = inference.failure
      return yield* completed({
        status: 'FAILED',
        failure: failure instanceof EntryInferenceError ? JevFailure.Timeout : failure.failure,
        httpStatus: failure instanceof EntryInferenceError ? null : (failure.status ?? null),
        responseHash: failure instanceof EntryInferenceError ? null : (failure.responseHash ?? null),
        usage: failure instanceof EntryInferenceError ? null : rejectedJevUsage(failure, disposition.jevRequestHash),
      })
    }
    const received = inference.success
    const responseHash = canonicalHashV1Result(received.response)
    const returnedAt = yield* Clock.currentTimeMillis
    const bound = received.requestHash === disposition.jevRequestHash
    if (
      !bound ||
      Result.isFailure(responseHash) ||
      responseHash.success !== received.responseHash ||
      Result.isFailure(decodeJevResponse(disposition.jevRequest, received.response)) ||
      Date.parse(received.startedAt) < jevNow ||
      received.completedAt < received.startedAt ||
      Date.parse(received.completedAt) > returnedAt
    )
      return yield* completed({
        status: 'FAILED',
        failure: JevFailure.Response,
        httpStatus: 200,
        responseHash: Result.isSuccess(responseHash) ? responseHash.success : null,
        usage: bound ? received.response.usage : null,
      })
    if (returnedAt >= expires)
      return yield* completed({
        status: 'FAILED',
        failure: JevFailure.Timeout,
        httpStatus: 200,
        responseHash: received.responseHash,
        usage: received.response.usage,
      })
    return yield* completed({ status: 'RECEIVED', inference: received })
  })
