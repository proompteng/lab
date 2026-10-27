import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { makeNativeChartEvidence, type NativeChartEvidence } from './chart-evidence'
import { ChartAssessmentsSchema, type ChartAssessmentsMaterial } from './chart-questions'
import {
  decodeJevResponse,
  JevContractError,
  JevFailure,
  JevInferenceSchema,
  JevRequestSchema,
  JevResponseSchema,
  prepareJevRequest,
} from './contract'
import {
  DecisionsInferenceSchema,
  DecisionsUsageSchema,
  decodeDecisionsResponse,
  prepareDecisionsRequest,
  validDecisionsUsage,
  type DecisionsError,
  type DecisionsResponse,
} from './decisions'
import { deriveEntryDispositionForChart, hasFeasibleEntrySource, type EntryHandoffMaterial } from './entry-inference'
import {
  prepareEntryInferenceInput,
  type EntryInferenceInput,
  type EntryInferenceMaterial,
} from './entry-inference-input'
import { EntryProposalSchema, EntrySetup, ProposalRejection } from './entry-proposals'
import { makeEntryJudgmentRequest } from './entry-questions'
import { BaseStartEvidenceSchema, makeStagedSkipReceipt, stageResponseIdentity } from './staged-checkpoint'
import {
  makeInitialChartStageRequest,
  makeSelectedBaseStartStageRequest,
  stagedChartAssessments,
} from './staged-chart-questions'

const HttpStatus = Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })))
const Evaluation = Schema.Struct({
  proposals: Schema.Array(EntryProposalSchema).check(Schema.isMaxLength(2)),
  rejections: Schema.Array(Schema.Struct({ setup: Schema.Enum(EntrySetup), reason: Schema.Enum(ProposalRejection) })),
})
const makeDispositionSchema = <S extends Schema.Top>(assessments: S) =>
  Schema.Union([
    Schema.Struct({ status: Schema.Literal('SOURCE_INFEASIBLE') }),
    Schema.Struct({
      status: Schema.Literal('VISUAL_FAILED'),
      failure: Schema.Struct({
        category: Schema.Literals(['REQUEST', 'TRANSPORT', 'STATUS', 'RESPONSE', 'DEADLINE']),
        httpStatus: HttpStatus,
        responseHash: Schema.NullOr(Sha256Schema),
        usage: Schema.NullOr(DecisionsUsageSchema),
      }),
    }),
    Schema.Struct({
      status: Schema.Literal('PREPARATION_FAILED'),
      visual: DecisionsInferenceSchema,
      reason: Schema.Literals(['VISUAL_RECEIPT_MISMATCH', 'DERIVATION_CONTRACT', 'BASE_START_FAILED']),
    }),
    Schema.Struct({
      status: Schema.Literal('NO_FUNDED_PROPOSALS'),
      visual: DecisionsInferenceSchema,
      assessments,
      evaluation: Evaluation,
    }),
    Schema.Struct({
      status: Schema.Literal('READY'),
      visual: DecisionsInferenceSchema,
      assessments,
      evaluation: Evaluation,
      jevRequest: JevRequestSchema,
      jevRequestHash: Sha256Schema,
    }),
  ])
export const makeEntryHandoffSchema = <
  V extends 'bayn.entry-handoff.v1' | 'bayn.entry-handoff.v2' | 'bayn.entry-handoff.v3' | 'bayn.entry-handoff.v4',
  S extends Schema.Top,
>(
  schemaVersion: V,
  assessments: S,
) =>
  Schema.Struct({
    schemaVersion: Schema.Literal(schemaVersion),
    requestId: Sha256Schema,
    inputHash: Sha256Schema,
    visualRequestHash: Sha256Schema,
    recordedAt: UtcInstantSchema,
    disposition: makeDispositionSchema(assessments),
    handoffHash: Sha256Schema,
  })
export const EntryHandoffSchema = Schema.Struct({
  ...makeEntryHandoffSchema('bayn.entry-handoff.v4', ChartAssessmentsSchema).fields,
  baseStart: Schema.suspend(() => BaseStartEvidenceSchema),
})
export const makeEntryInferenceCompletionSchema = <S extends Schema.Top>(handoff: S) =>
  Schema.Struct({
    handoff,
    completedAt: UtcInstantSchema,
    jev: Schema.Union([
      Schema.Struct({ status: Schema.Literal('RECEIVED'), inference: JevInferenceSchema }),
      Schema.Struct({
        status: Schema.Literal('FAILED'),
        failure: Schema.Enum(JevFailure),
        httpStatus: HttpStatus,
        responseHash: Schema.NullOr(Sha256Schema),
        usage: Schema.NullOr(JevResponseSchema.fields.usage),
      }),
      Schema.Struct({ status: Schema.Literal('NOT_REQUESTED') }),
      Schema.Struct({ status: Schema.Literal('NOT_DISPATCHED') }),
      Schema.Struct({ status: Schema.Literal('OMITTED_BY_POLICY') }),
    ]),
  })
export const EntryInferenceCompletionSchema = makeEntryInferenceCompletionSchema(EntryHandoffSchema)

type EntrySource = {
  readonly requestId: string
  readonly input: EntryInferenceInput
  readonly observedAt: string
  readonly expiresAt: string
}
const invalid = (message: string) => Result.fail(new JevContractError({ message }))

export const decodeEntryHandoff = (source: EntrySource, input: unknown) =>
  Result.gen(function* () {
    const prepared = yield* prepareEntryInferenceInput(source.input)
    return yield* decodeStagedEntryHandoff(
      { ...source, input: prepared.input },
      input,
      prepared.requestHash,
      makeEntryJudgmentRequest,
    )
  })

export const decodeStagedEntryHandoff = (
  source: Omit<EntrySource, 'input'> & { readonly input: EntryInferenceMaterial },
  input: unknown,
  inputHash: string,
  prepareJudgments: typeof makeEntryJudgmentRequest,
) =>
  Result.gen(function* () {
    const chart = yield* makeNativeChartEvidence(source.input.chartSource)
    const handoff = yield* Schema.decodeUnknownResult(EntryHandoffSchema, strictParseOptions)(input)
    const { handoffHash, ...material } = handoff
    const initial = yield* makeInitialChartStageRequest({
      chart,
      protocol: source.input.protocol,
      funding: source.input.funding,
    })
    if (
      handoff.requestId !== source.requestId ||
      handoff.inputHash !== inputHash ||
      handoff.visualRequestHash !== initial.requestHash ||
      handoff.recordedAt < source.observedAt ||
      handoffHash !== (yield* canonicalHashV1Result(material))
    )
      return yield* invalid('Staged handoff identity or source does not reproduce')
    const base = handoff.baseStart
    if (base.status === 'NOT_REQUESTED') {
      const { skipHash, ...skipMaterial } = base.skip
      const expected = yield* makeStagedSkipReceipt(skipMaterial)
      if (
        skipHash !== expected.skipHash ||
        base.skip.requestId !== source.requestId ||
        base.skip.recordedAt < source.observedAt ||
        base.skip.recordedAt > handoff.recordedAt
      )
        return yield* invalid('Staged handoff has an unbound skip receipt')
    }
    const disposition = handoff.disposition
    if (disposition.status === 'SOURCE_INFEASIBLE') {
      if (
        (yield* hasFeasibleEntrySource(source.input, chart)) ||
        base.status !== 'NOT_REQUESTED' ||
        base.skip.reason !== 'SOURCE_INFEASIBLE' ||
        base.skip.predecessorHash !== null
      )
        return yield* invalid('Staged source-infeasible handoff contradicts its source or skip')
      return handoff
    }
    if (disposition.status === 'VISUAL_FAILED') {
      if (
        (disposition.failure.usage !== null && !validDecisionsUsage(disposition.failure.usage)) ||
        base.status !== 'NOT_REQUESTED' ||
        base.skip.reason !== 'CHART_FAILED' ||
        base.skip.predecessorHash === null
      )
        return yield* invalid('Failed staged chart has invalid costs or skip evidence')
      return handoff
    }
    const visual = disposition.visual
    if (
      visual.requestHash !== initial.requestHash ||
      visual.responseHash !== (yield* canonicalHashV1Result(visual.response)) ||
      visual.startedAt < source.observedAt ||
      visual.startedAt >= source.expiresAt ||
      visual.completedAt < visual.startedAt ||
      visual.completedAt > handoff.recordedAt ||
      Result.isFailure(decodeDecisionsResponse(initial.request, visual.response))
    )
      return yield* invalid('Staged chart response differs from its original source or clocks')
    const next = yield* makeSelectedBaseStartStageRequest(
      { chart, protocol: source.input.protocol, funding: source.input.funding },
      stageResponseIdentity(visual),
    )
    if (next.status === 'NOT_REQUESTED') {
      if (
        base.status !== 'NOT_REQUESTED' ||
        base.skip.reason !== next.reason ||
        base.skip.predecessorHash === null ||
        base.skip.recordedAt < visual.completedAt
      )
        return yield* invalid('Base start skip does not reproduce the selected chart outcome')
    } else {
      if (base.status === 'NOT_REQUESTED') return yield* invalid('Selected base start cannot be silently skipped')
      if (base.status === 'FAILED') {
        if (base.failure.usage !== null && !validDecisionsUsage(base.failure.usage))
          return yield* invalid('Failed base start has inconsistent usage')
        if (disposition.status !== 'PREPARATION_FAILED' || disposition.reason !== 'BASE_START_FAILED')
          return yield* invalid('Failed base start cannot authorize a dependent proposal')
        return handoff
      }
      const inference = base.inference
      if (
        inference.requestHash !== next.requestHash ||
        inference.responseHash !== (yield* canonicalHashV1Result(inference.response)) ||
        inference.startedAt < visual.completedAt ||
        inference.startedAt >= source.expiresAt ||
        inference.completedAt < inference.startedAt ||
        inference.completedAt > handoff.recordedAt ||
        Result.isFailure(decodeDecisionsResponse(next.request, inference.response))
      )
        return yield* invalid('Base start response changes its selected predecessor or clocks')
    }
    const derive = stagedChartAssessments(
      { chart, protocol: source.input.protocol, funding: source.input.funding },
      stageResponseIdentity(visual),
      base.status === 'RECEIVED' ? stageResponseIdentity(base.inference) : null,
    ).pipe(
      Result.flatMap((assessments) =>
        deriveEntryDispositionForChart(source.input, visual, chart, assessments, prepareJudgments),
      ),
    )
    if (disposition.status === 'PREPARATION_FAILED') {
      if (disposition.reason !== 'DERIVATION_CONTRACT' || Result.isSuccess(derive))
        return yield* invalid('Staged preparation failure contradicts reproducible evidence')
      return handoff
    }
    const expected = yield* derive
    if ((yield* canonicalHashV1Result(expected)) !== (yield* canonicalHashV1Result(disposition)))
      return yield* invalid('Staged handoff changes assessments, proposals or the dependent Jev request')
    return handoff
  })

export const decodeEntryHandoffForChart = <H extends EntryHandoffMaterial>({
  source,
  input,
  inputHash,
  chart,
  handoffSchema,
  sourceFeasible,
  prepareVisual,
  assessVisual,
  prepareJudgments,
}: {
  readonly source: Omit<EntrySource, 'input'> & { readonly input: EntryInferenceMaterial }
  readonly input: unknown
  readonly inputHash: string
  readonly chart: NativeChartEvidence
  readonly handoffSchema: Schema.Decoder<H>
  readonly sourceFeasible: boolean | null
  readonly prepareVisual: (
    chart: NativeChartEvidence,
  ) => Result.Result<
    Pick<Result.Result.Success<ReturnType<typeof prepareDecisionsRequest>>, 'request' | 'requestHash'>,
    JevContractError | DecisionsError
  >
  readonly assessVisual: (
    chart: NativeChartEvidence,
    response: DecisionsResponse,
  ) => Result.Result<ChartAssessmentsMaterial, JevContractError | DecisionsError>
  readonly prepareJudgments: typeof makeEntryJudgmentRequest
}) =>
  Result.gen(function* () {
    const handoff = yield* Schema.decodeUnknownResult(handoffSchema, strictParseOptions)(input)
    const { handoffHash, ...material } = handoff
    const visualRequest = yield* prepareVisual(chart)
    if (
      handoff.requestId !== source.requestId ||
      handoff.inputHash !== inputHash ||
      handoff.visualRequestHash !== visualRequest.requestHash ||
      handoff.recordedAt < source.observedAt ||
      (yield* canonicalHashV1Result(material)) !== handoffHash
    )
      return yield* invalid('Entry handoff identity or source input does not reproduce')
    const disposition = handoff.disposition
    if (disposition.status === 'SOURCE_INFEASIBLE') {
      if (sourceFeasible !== false)
        return yield* invalid('Source-infeasible evidence contains a fundable source or retired input')
      return handoff
    }
    if (disposition.status === 'VISUAL_FAILED') {
      if (disposition.failure.usage !== null && !validDecisionsUsage(disposition.failure.usage))
        return yield* invalid('Failed chart inference contains inconsistent metering')
      return handoff
    }
    const visual = disposition.visual
    const decodedVisual = decodeDecisionsResponse(visualRequest.request, visual.response)
    const derive = () =>
      decodedVisual.pipe(
        Result.flatMap((response) => assessVisual(chart, response)),
        Result.flatMap((assessments) =>
          deriveEntryDispositionForChart(source.input, visual, chart, assessments, prepareJudgments),
        ),
      )
    const visualBound =
      visual.requestHash === visualRequest.requestHash &&
      (yield* canonicalHashV1Result(visual.response)) === visual.responseHash &&
      visual.startedAt >= source.observedAt &&
      visual.completedAt >= visual.startedAt &&
      visual.completedAt <= handoff.recordedAt &&
      Result.isSuccess(decodedVisual)
    if (disposition.status === 'PREPARATION_FAILED') {
      if (disposition.reason === 'BASE_START_FAILED')
        return yield* invalid('Historical handoff cannot contain a staged failure')
      if (disposition.reason === 'VISUAL_RECEIPT_MISMATCH' ? visualBound : !visualBound)
        return yield* invalid('Preparation failure contradicts its chart inference receipt')
      if (disposition.reason === 'DERIVATION_CONTRACT' && Result.isSuccess(derive()))
        return yield* invalid('A successful derivation cannot be recorded as a preparation failure')
      return handoff
    }
    if (!visualBound) return yield* invalid('Entry handoff has an unbound chart inference receipt')
    const expected = yield* derive()
    const { visual: _expectedVisual, ...expectedDerivation } = expected
    const { visual: _recordedVisual, ...recordedDerivation } = disposition
    if ((yield* canonicalHashV1Result(expectedDerivation)) !== (yield* canonicalHashV1Result(recordedDerivation)))
      return yield* invalid('Entry handoff changes chart judgments, funded proposals or the dependent Jev request')
    return handoff
  }).pipe(
    Result.mapError((cause) => new JevContractError({ message: 'Entry handoff evidence does not reproduce', cause })),
  )

export const decodeEntryInferenceCompletion = (source: EntrySource, input: unknown) =>
  Result.gen(function* () {
    const { handoff: rawHandoff, ...completion } = yield* Schema.decodeUnknownResult(
      EntryInferenceCompletionSchema,
      strictParseOptions,
    )(input)
    const handoff = yield* decodeEntryHandoff(source, rawHandoff)
    return yield* verifyEntryCompletion(source, completion, handoff)
  }).pipe(
    Result.mapError(
      (cause) => new JevContractError({ message: 'Entry inference completion does not reproduce', cause }),
    ),
  )

export const verifyEntryCompletion = <H extends EntryHandoffMaterial>(
  source: Pick<EntrySource, 'expiresAt'> & {
    readonly input: Pick<EntryInferenceMaterial, 'schemaVersion'>
  },
  completion: Omit<typeof EntryInferenceCompletionSchema.Type, 'handoff'>,
  handoff: H,
) =>
  Result.gen(function* () {
    const verified = { ...completion, handoff }
    if (completion.completedAt < handoff.recordedAt)
      return yield* invalid('Inference completion precedes its provider handoff')
    const outcome = completion.jev
    if (handoff.disposition.status !== 'READY') {
      if (outcome.status !== 'NOT_REQUESTED')
        return yield* invalid('Jev cannot be dispatched without a prepared funded proposal')
      return verified
    }
    if (source.input.schemaVersion === 'bayn.entry-ablation-input.v1') {
      if (outcome.status !== 'OMITTED_BY_POLICY')
        return yield* invalid('An ablation request must omit Jev under its source selection policy')
      return verified
    }
    if (outcome.status === 'OMITTED_BY_POLICY')
      return yield* invalid('Only an explicit ablation request may omit Jev policy evidence')
    if (outcome.status === 'NOT_REQUESTED')
      return yield* invalid('A prepared Jev request must retain its dispatch disposition')
    if (outcome.status === 'NOT_DISPATCHED') {
      if (completion.completedAt < source.expiresAt)
        return yield* invalid('Undispatched Jev evidence must prove original deadline expiry')
      return verified
    }
    if (outcome.status === 'FAILED') return verified
    const inference = outcome.inference
    const prepared = yield* prepareJevRequest(handoff.disposition.jevRequest)
    if (
      prepared.requestHash !== handoff.disposition.jevRequestHash ||
      inference.requestHash !== prepared.requestHash ||
      inference.startedAt < handoff.recordedAt ||
      inference.completedAt < inference.startedAt ||
      inference.completedAt > completion.completedAt ||
      (yield* canonicalHashV1Result(inference.response)) !== inference.responseHash ||
      Result.isFailure(decodeJevResponse(prepared.request, inference.response))
    )
      return yield* invalid('Dependent Jev inference differs from the committed request or response')
    return verified
  }).pipe(
    Result.mapError(
      (cause) => new JevContractError({ message: 'Entry inference completion does not reproduce', cause }),
    ),
  )
