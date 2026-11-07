import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { strictParseOptions } from '../schemas'
import { entryEvaluationRequestFixture as currentRequest } from './entry-inference.test-support'
import {
  CandidateEntryInferenceInputSchema,
  AblationEntryInferenceInputSchema,
  verifyEntryInferenceSource,
} from './entry-inference-input'
import { JevEvaluationReceiptSchema } from './evidence'
import { RetainedJevProtocolV39Schema, retainedJevProtocolV39Document } from './protocol'
import { decodeRetainedStagedEvaluationRequest } from './staged-inference-cost-evidence'
import { makeNativeChartEvidence } from './chart-evidence'
import { stagedChartAssessments } from './retained-jev-staged-chart-questions'
import { deriveEntryDispositionForChart } from './entry-inference'
import { stageResponseIdentity } from './staged-checkpoint'
import { makeEntryJudgmentRequest } from './entry-questions'
import type { JevInference } from './client'
import type { EntryAblationSelection } from './entry-inference-input'

const RetainedInput = Schema.Union([
  Schema.Struct({ ...CandidateEntryInferenceInputSchema.fields, protocol: RetainedJevProtocolV39Schema }),
  Schema.Struct({ ...AblationEntryInferenceInputSchema.fields, protocol: RetainedJevProtocolV39Schema }),
])

// These constructors produce financial-reader fixtures, never a current executable request.
export const prepareEntryInferenceInput = (raw: unknown) =>
  Result.gen(function* () {
    const input = yield* Schema.decodeUnknownResult(RetainedInput, strictParseOptions)(raw)
    return { input, ...(yield* verifyEntryInferenceSource(input)) }
  })
export const makeJevEvaluationRequest = (raw: unknown) =>
  Result.gen(function* () {
    const material = yield* Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.Json))(raw)
    return yield* decodeRetainedStagedEvaluationRequest({
      ...material,
      requestId: yield* canonicalHashV1Result(material),
    })
  })
export const entryEvaluationRequestFixture = (at?: string, symbol?: string, selection?: EntryAblationSelection) => {
  const original = currentRequest(at, symbol, selection)
  const prepared = Result.getOrThrow(
    prepareEntryInferenceInput({ ...original.request, protocol: retainedJevProtocolV39Document }),
  )
  const { requestId: _id, ...material } = original
  return Result.getOrThrow(
    makeJevEvaluationRequest({ ...material, request: prepared.input, requestHash: prepared.requestHash }),
  )
}
export type RetainedEvaluationRequest = ReturnType<typeof entryEvaluationRequestFixture>

const { receiptHash: _hash, ...receiptFields } = JevEvaluationReceiptSchema.fields
export const makeJevEvaluationReceipt = (_request: RetainedEvaluationRequest, raw: unknown) =>
  Result.gen(function* () {
    const material = yield* Schema.decodeUnknownResult(Schema.Struct(receiptFields), strictParseOptions)(raw)
    return { ...material, receiptHash: yield* canonicalHashV1Result(material) }
  })

export const deriveEntryHandoffDisposition = (
  input: RetainedEvaluationRequest['request'],
  visual: JevInference,
  base: JevInference | null = null,
) =>
  Result.gen(function* () {
    const chart = yield* makeNativeChartEvidence(input.chartSource)
    const assessments = yield* stagedChartAssessments(
      { chart, protocol: input.protocol, funding: input.funding },
      stageResponseIdentity(visual),
      base === null ? null : stageResponseIdentity(base),
    )
    return yield* deriveEntryDispositionForChart(input, visual, chart, assessments, makeEntryJudgmentRequest)
  })
