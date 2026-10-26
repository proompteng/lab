import { Clock, Context, Data, Effect, Redacted, Result, Schema } from 'effect'

import type { OperationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import { utcInstantFromEpochMillis } from '../time'
import { makeNativeChartEvidence } from './chart-evidence'
import { chartAssessments, makeChartDecisionsRequest, type ChartAssessments } from './chart-questions'
import { JevClient, type JevError, type JevInference } from './client'
import { decodeJevResponse, JevFailure, JevResponseSchema, type JevRequest } from './contract'
import { DecisionsClient, type DecisionsError, type DecisionsInference, type DecisionsUsageSchema } from './decisions'
import { jevEntryEconomics } from './entry-economics'
import { prepareEntryInferenceInput, type EntryInferenceInput } from './entry-inference-input'
import { makeEntryProposals, EntrySetup, ProposalRejection, type EntryProposal } from './entry-proposals'
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
type HandoffDisposition =
  | { readonly status: 'VISUAL_FAILED'; readonly failure: VisualFailureEvidence }
  | {
      readonly status: 'PREPARATION_FAILED'
      readonly visual: DecisionsInference
      readonly reason: 'VISUAL_RECEIPT_MISMATCH' | 'DERIVATION_CONTRACT'
    }
  | {
      readonly status: 'NO_FUNDED_PROPOSALS'
      readonly visual: DecisionsInference
      readonly assessments: ChartAssessments
      readonly evaluation: ProposalEvaluation
    }
  | {
      readonly status: 'READY'
      readonly visual: DecisionsInference
      readonly assessments: ChartAssessments
      readonly evaluation: ProposalEvaluation
      readonly jevRequest: JevRequest
      readonly jevRequestHash: string
    }

export interface EntryHandoff {
  readonly schemaVersion: 'bayn.entry-handoff.v1'
  readonly requestId: string
  readonly inputHash: string
  readonly visualRequestHash: string
  readonly recordedAt: string
  readonly disposition: HandoffDisposition
  readonly handoffHash: string
}

export class EntryInferenceJournal extends Context.Service<
  EntryInferenceJournal,
  {
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

export const deriveEntryHandoffDisposition = (input: EntryInferenceInput, visual: DecisionsInference) =>
  Result.gen(function* () {
    const chart = yield* makeNativeChartEvidence(input.chartSource)
    return yield* deriveEntryDispositionForChart(input, visual, chart)
  })

export const deriveEntryDispositionForChart = (
  input: Pick<EntryInferenceInput, 'numericalState' | 'protocol' | 'funding'>,
  visual: DecisionsInference,
  chart: Result.Result.Success<ReturnType<typeof makeNativeChartEvidence>>,
) =>
  Result.gen(function* () {
    const assessments = yield* chartAssessments(chart, visual.response)
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
    const jev = yield* makeEntryJudgmentRequest({
      numericalState: input.numericalState,
      chart,
      assessments,
      proposals: evaluation.proposals,
    })
    return jev === null
      ? ({ status: 'NO_FUNDED_PROPOSALS', visual, assessments, evaluation } satisfies HandoffDisposition)
      : ({
          status: 'READY',
          visual,
          assessments,
          evaluation,
          jevRequest: jev.request,
          jevRequestHash: jev.requestHash,
        } satisfies HandoffDisposition)
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
    const visualRequest = yield* Effect.fromResult(makeChartDecisionsRequest(chart))
    const decisions = yield* DecisionsClient
    const journal = yield* EntryInferenceJournal
    const visualNow = yield* Clock.currentTimeMillis
    if (visualNow >= expires || visualNow < now)
      return yield* new EntryInferenceError({
        category: 'DEADLINE',
        message: 'Original evidence window expired before chart dispatch',
      })
    const visual = yield* decisions.evaluate(visualRequest.request, expires - visualNow).pipe(
      Effect.timeoutOrElse({
        duration: expires - visualNow,
        orElse: () =>
          Effect.fail(
            new EntryInferenceError({
              category: 'DEADLINE',
              message: 'Original evidence window expired during chart inference',
            }),
          ),
      }),
      Effect.result,
    )
    let disposition: HandoffDisposition
    if (Result.isFailure(visual)) {
      const failure = visual.failure
      disposition = {
        status: 'VISUAL_FAILED',
        failure:
          failure instanceof EntryInferenceError
            ? { category: 'DEADLINE', httpStatus: null, responseHash: null, usage: null }
            : {
                category: failure.category,
                httpStatus: failure.status ?? null,
                responseHash: failure.requestHash === visualRequest.requestHash ? (failure.responseHash ?? null) : null,
                usage: failure.requestHash === visualRequest.requestHash ? (failure.usage ?? null) : null,
              },
      }
    } else {
      const expectedResponseHash = yield* Effect.fromResult(canonicalHashV1Result(visual.success.response))
      const visualReturnedAt = yield* Clock.currentTimeMillis
      const sourceBound =
        visual.success.requestHash === visualRequest.requestHash &&
        visual.success.responseHash === expectedResponseHash &&
        Date.parse(visual.success.startedAt) >= now &&
        visual.success.completedAt >= visual.success.startedAt &&
        Date.parse(visual.success.completedAt) <= visualReturnedAt
      if (!sourceBound)
        disposition = { status: 'PREPARATION_FAILED', visual: visual.success, reason: 'VISUAL_RECEIPT_MISMATCH' }
      else {
        const derived = deriveEntryHandoffDisposition(prepared.input, visual.success)
        disposition = Result.isSuccess(derived)
          ? derived.success
          : { status: 'PREPARATION_FAILED', visual: visual.success, reason: 'DERIVATION_CONTRACT' }
      }
    }
    const material = {
      schemaVersion: 'bayn.entry-handoff.v1' as const,
      requestId: claim.requestId,
      inputHash: prepared.requestHash,
      visualRequestHash: visualRequest.requestHash,
      recordedAt: utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
      disposition,
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
