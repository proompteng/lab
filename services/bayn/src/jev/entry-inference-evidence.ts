import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { makeNativeChartEvidence, type NativeChartEvidence } from './chart-evidence'
import {
  ChartAssessmentsSchema,
  chartAssessmentsFromResponse,
  makeChartDecisionsRequest,
  type ChartAssessmentsMaterial,
} from './chart-questions'
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
import { deriveEntryDispositionForChart, type EntryHandoffMaterial } from './entry-inference'
import {
  prepareEntryInferenceInput,
  type EntryInferenceInput,
  type EntryInferenceMaterial,
} from './entry-inference-input'
import { EntryProposalSchema, EntrySetup, ProposalRejection } from './entry-proposals'
import { makeEntryJudgmentRequest } from './entry-questions'

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
      reason: Schema.Literals(['VISUAL_RECEIPT_MISMATCH', 'DERIVATION_CONTRACT']),
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
  V extends 'bayn.entry-handoff.v1' | 'bayn.entry-handoff.v2' | 'bayn.entry-handoff.v3',
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
export const EntryHandoffSchema = makeEntryHandoffSchema('bayn.entry-handoff.v3', ChartAssessmentsSchema)
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
    const chart = yield* makeNativeChartEvidence(prepared.input.chartSource)
    const visualRequest = yield* makeChartDecisionsRequest({
      chart,
      protocol: prepared.input.protocol,
      funding: prepared.input.funding,
    })
    return yield* decodeEntryHandoffForChart({
      source,
      input,
      inputHash: prepared.requestHash,
      chart,
      handoffSchema: EntryHandoffSchema,
      sourceFeasible: visualRequest.sourceFeasible,
      prepareVisual: () => Result.succeed(visualRequest),
      assessVisual: (sourceChart, response) =>
        chartAssessmentsFromResponse(sourceChart, response, visualRequest.request),
      prepareJudgments: makeEntryJudgmentRequest,
    })
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
  source: Pick<EntrySource, 'expiresAt'>,
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
