import { Data, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, SymbolSchema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { JevFailure } from './contract'
import { EntryInferenceInputSchema, prepareEntryInferenceInput } from './entry-inference-input'
import { EntryInferenceCompletionSchema, decodeEntryInferenceCompletion } from './entry-inference-evidence'

const RequestMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-evaluation-request.v3'),
  cycleId: Sha256Schema,
  authorityGenerationHash: Sha256Schema,
  snapshotId: Sha256Schema,
  symbol: SymbolSchema,
  observedAt: UtcInstantSchema,
  expiresAt: UtcInstantSchema,
  requestHash: Sha256Schema,
  request: EntryInferenceInputSchema,
})
export const JevEvaluationRequestSchema = Schema.Struct({ ...RequestMaterialSchema.fields, requestId: Sha256Schema })
export type JevEvaluationRequest = typeof JevEvaluationRequestSchema.Type

export enum JevOutcome {
  Completed = 'COMPLETED',
  Failed = 'FAILED',
}
const ReceiptMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-evaluation-receipt.v3'),
  requestId: Sha256Schema,
  startedAt: UtcInstantSchema,
  completedAt: UtcInstantSchema,
  outcome: Schema.Union([
    Schema.Struct({ status: Schema.Literal(JevOutcome.Completed), completion: EntryInferenceCompletionSchema }),
    Schema.Struct({ status: Schema.Literal(JevOutcome.Failed), failure: Schema.Enum(JevFailure) }),
  ]),
})
export const JevEvaluationReceiptSchema = Schema.Struct({ ...ReceiptMaterialSchema.fields, receiptHash: Sha256Schema })
export type JevEvaluationReceipt = typeof JevEvaluationReceiptSchema.Type

export class JevEvidenceError extends Data.TaggedError('JevEvidenceError')<{ readonly message: string }> {}
const invalid = (message: string) => Result.fail(new JevEvidenceError({ message }))
const entrySource = (request: JevEvaluationRequest) => ({
  requestId: request.requestId,
  input: request.request,
  observedAt: request.observedAt,
  expiresAt: request.expiresAt,
})

export const makeJevEvaluationRequest = (input: unknown) =>
  Result.gen(function* () {
    const material = yield* Schema.decodeUnknownResult(RequestMaterialSchema, strictParseOptions)(input)
    const prepared = yield* prepareEntryInferenceInput(material.request)
    if (
      material.symbol !== prepared.input.chartSource.symbol ||
      prepared.input.chartSource.windowEndAt > material.observedAt ||
      prepared.requestHash !== material.requestHash ||
      Date.parse(material.expiresAt) - Date.parse(material.observedAt) !== prepared.input.protocol.inferenceValidityMs
    )
      return yield* invalid('Entry evaluation request has a mismatched source, hash or original validity interval')
    return { ...material, request: prepared.input, requestId: yield* canonicalHashV1Result(material) }
  }).pipe(
    Result.mapError(
      () => new JevEvidenceError({ message: 'Entry evaluation request is malformed or does not reproduce' }),
    ),
  )

export const decodeJevEvaluationRequest = (input: unknown) =>
  Result.gen(function* () {
    const { requestId, ...material } = yield* Schema.decodeUnknownResult(
      JevEvaluationRequestSchema,
      strictParseOptions,
    )(input)
    const request = yield* makeJevEvaluationRequest(material)
    if (request.requestId !== requestId) return yield* invalid('Stored entry request identity differs')
    return request
  }).pipe(
    Result.mapError(() => new JevEvidenceError({ message: 'Stored entry request is malformed or does not reproduce' })),
  )

export const makeJevEvaluationReceipt = (request: JevEvaluationRequest, input: unknown) =>
  Result.gen(function* () {
    const material = yield* Schema.decodeUnknownResult(ReceiptMaterialSchema, strictParseOptions)(input)
    if (
      material.requestId !== request.requestId ||
      material.startedAt < request.observedAt ||
      material.completedAt < material.startedAt
    )
      return yield* invalid('Entry receipt has a mismatched request or regressed clock')
    if (material.outcome.status === JevOutcome.Completed) {
      const completion = yield* decodeEntryInferenceCompletion(entrySource(request), material.outcome.completion)
      if (
        completion.completedAt > material.completedAt ||
        completion.handoff.recordedAt < material.startedAt ||
        (completion.handoff.disposition.status !== 'VISUAL_FAILED' &&
          completion.handoff.disposition.status !== 'SOURCE_INFEASIBLE' &&
          completion.handoff.disposition.visual.startedAt < material.startedAt)
      )
        return yield* invalid('Entry receipt precedes its provider evidence or dispatch claim')
    } else if (
      material.outcome.failure === JevFailure.NotDispatched &&
      (material.startedAt >= request.expiresAt || material.completedAt < request.expiresAt)
    ) {
      return yield* invalid('Undispatched entry evidence must prove expiry after a valid original claim')
    }
    return { ...material, receiptHash: yield* canonicalHashV1Result(material) }
  }).pipe(Result.mapError(() => new JevEvidenceError({ message: 'Entry receipt is malformed or does not reproduce' })))

export const decodeJevEvaluationReceipt = (request: JevEvaluationRequest, input: unknown) =>
  Result.gen(function* () {
    const { receiptHash, ...material } = yield* Schema.decodeUnknownResult(
      JevEvaluationReceiptSchema,
      strictParseOptions,
    )(input)
    const receipt = yield* makeJevEvaluationReceipt(request, material)
    if (receipt.receiptHash !== receiptHash) return yield* invalid('Stored entry receipt identity differs')
    return receipt
  }).pipe(
    Result.mapError(() => new JevEvidenceError({ message: 'Stored entry receipt is malformed or does not reproduce' })),
  )

export const jevInferenceAvailableAt = (request: JevEvaluationRequest, receipt: JevEvaluationReceipt, now: number) => {
  if (!Number.isSafeInteger(now) || now < Date.parse(receipt.completedAt) || now >= Date.parse(request.expiresAt))
    return invalid('Entry receipt is unavailable or outside its original validity window')
  if (receipt.outcome.status !== JevOutcome.Completed)
    return invalid('Entry inference did not complete and cannot authorize an order')
  const completion = receipt.outcome.completion
  if (
    completion.handoff.disposition.status === 'VISUAL_FAILED' ||
    completion.handoff.disposition.status === 'PREPARATION_FAILED' ||
    completion.jev.status === 'FAILED' ||
    completion.jev.status === 'NOT_DISPATCHED'
  )
    return invalid('Entry inference failed and cannot authorize an order')
  return Result.succeed(completion)
}
