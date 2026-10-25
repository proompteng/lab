import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { makeNativeChartEvidence, type NativeChartEvidence } from './chart-evidence'
import { ChartAssessmentsSchema, makeChartDecisionsRequest } from './chart-questions'
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
  validDecisionsUsage,
} from './decisions'
import { deriveEntryDispositionForChart } from './entry-inference'
import {
  prepareEntryInferenceInput,
  type EntryInferenceInput,
  type EntryInferenceMaterial,
} from './entry-inference-input'
import { EntryProposalSchema, EntrySetup, ProposalRejection } from './entry-proposals'

const HttpStatus = Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })))
const Evaluation = Schema.Struct({
  proposals: Schema.Array(EntryProposalSchema).check(Schema.isMaxLength(2)),
  rejections: Schema.Array(Schema.Struct({ setup: Schema.Enum(EntrySetup), reason: Schema.Enum(ProposalRejection) })),
})
const Disposition = Schema.Union([
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
    assessments: ChartAssessmentsSchema,
    evaluation: Evaluation,
  }),
  Schema.Struct({
    status: Schema.Literal('READY'),
    visual: DecisionsInferenceSchema,
    assessments: ChartAssessmentsSchema,
    evaluation: Evaluation,
    jevRequest: JevRequestSchema,
    jevRequestHash: Sha256Schema,
  }),
])
export const EntryHandoffSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.entry-handoff.v1'),
  requestId: Sha256Schema,
  inputHash: Sha256Schema,
  visualRequestHash: Sha256Schema,
  recordedAt: UtcInstantSchema,
  disposition: Disposition,
  handoffHash: Sha256Schema,
})
export const EntryInferenceCompletionSchema = Schema.Struct({
  handoff: EntryHandoffSchema,
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
    return yield* decodeEntryHandoffForChart({ source, input, inputHash: prepared.requestHash, chart })
  })

export const decodeEntryHandoffForChart = ({
  source,
  input,
  inputHash,
  chart,
}: {
  readonly source: Omit<EntrySource, 'input'> & { readonly input: EntryInferenceMaterial }
  readonly input: unknown
  readonly inputHash: string
  readonly chart: NativeChartEvidence
}) =>
  Result.gen(function* () {
    const handoff = yield* Schema.decodeUnknownResult(EntryHandoffSchema, strictParseOptions)(input)
    const { handoffHash, ...material } = handoff
    const visualRequest = yield* makeChartDecisionsRequest(chart)
    if (
      handoff.requestId !== source.requestId ||
      handoff.inputHash !== inputHash ||
      handoff.visualRequestHash !== visualRequest.requestHash ||
      handoff.recordedAt < source.observedAt ||
      (yield* canonicalHashV1Result(material)) !== handoffHash
    )
      return yield* invalid('Entry handoff identity or source input does not reproduce')
    const disposition = handoff.disposition
    if (disposition.status === 'VISUAL_FAILED') {
      if (disposition.failure.usage !== null && !validDecisionsUsage(disposition.failure.usage))
        return yield* invalid('Failed chart inference contains inconsistent metering')
      return handoff
    }
    const visual = disposition.visual
    const visualBound =
      visual.requestHash === visualRequest.requestHash &&
      (yield* canonicalHashV1Result(visual.response)) === visual.responseHash &&
      visual.startedAt >= source.observedAt &&
      visual.completedAt >= visual.startedAt &&
      visual.completedAt <= handoff.recordedAt &&
      Result.isSuccess(decodeDecisionsResponse(visualRequest.request, visual.response))
    if (disposition.status === 'PREPARATION_FAILED') {
      if (disposition.reason === 'VISUAL_RECEIPT_MISMATCH' ? visualBound : !visualBound)
        return yield* invalid('Preparation failure contradicts its chart inference receipt')
      if (
        disposition.reason === 'DERIVATION_CONTRACT' &&
        Result.isSuccess(deriveEntryDispositionForChart(source.input, visual, chart))
      )
        return yield* invalid('A successful derivation cannot be recorded as a preparation failure')
      return handoff
    }
    if (!visualBound) return yield* invalid('Entry handoff has an unbound chart inference receipt')
    const expected = yield* deriveEntryDispositionForChart(source.input, visual, chart)
    if ((yield* canonicalHashV1Result(expected)) !== (yield* canonicalHashV1Result(disposition)))
      return yield* invalid('Entry handoff changes chart judgments, funded proposals or the dependent Jev request')
    return handoff
  }).pipe(
    Result.mapError((cause) => new JevContractError({ message: 'Entry handoff evidence does not reproduce', cause })),
  )

export const decodeEntryInferenceCompletion = (source: EntrySource, input: unknown) =>
  Result.gen(function* () {
    const completion = yield* Schema.decodeUnknownResult(EntryInferenceCompletionSchema, strictParseOptions)(input)
    const handoff = yield* decodeEntryHandoff(source, completion.handoff)
    return yield* verifyEntryCompletion(source, completion, handoff)
  }).pipe(
    Result.mapError(
      (cause) => new JevContractError({ message: 'Entry inference completion does not reproduce', cause }),
    ),
  )

export const verifyEntryCompletion = (
  source: Pick<EntrySource, 'expiresAt'>,
  completion: typeof EntryInferenceCompletionSchema.Type,
  handoff: typeof EntryHandoffSchema.Type,
) =>
  Result.gen(function* () {
    if ((yield* canonicalHashV1Result(completion.handoff)) !== (yield* canonicalHashV1Result(handoff)))
      return yield* invalid('Inference completion differs from its verified provider handoff')
    if (completion.completedAt < handoff.recordedAt)
      return yield* invalid('Inference completion precedes its provider handoff')
    const outcome = completion.jev
    if (handoff.disposition.status !== 'READY') {
      if (outcome.status !== 'NOT_REQUESTED')
        return yield* invalid('Jev cannot be dispatched without a prepared funded proposal')
      return completion
    }
    if (outcome.status === 'NOT_REQUESTED')
      return yield* invalid('A prepared Jev request must retain its dispatch disposition')
    if (outcome.status === 'NOT_DISPATCHED') {
      if (completion.completedAt < source.expiresAt)
        return yield* invalid('Undispatched Jev evidence must prove original deadline expiry')
      return completion
    }
    if (outcome.status === 'FAILED') return completion
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
    return completion
  }).pipe(
    Result.mapError(
      (cause) => new JevContractError({ message: 'Entry inference completion does not reproduce', cause }),
    ),
  )

export const usableEntryInferenceCompletion = (
  source: EntrySource,
  completion: typeof EntryInferenceCompletionSchema.Type,
  now: number,
) =>
  Result.gen(function* () {
    const verified = yield* decodeEntryInferenceCompletion(source, completion)
    if (
      !Number.isSafeInteger(now) ||
      now < Date.parse(verified.completedAt) ||
      now >= Date.parse(source.expiresAt) ||
      verified.handoff.disposition.status === 'VISUAL_FAILED' ||
      verified.handoff.disposition.status === 'PREPARATION_FAILED' ||
      verified.jev.status === 'FAILED' ||
      verified.jev.status === 'NOT_DISPATCHED'
    )
      return yield* invalid('Entry inference is unavailable or outside its original evidence window')
    return verified
  })
