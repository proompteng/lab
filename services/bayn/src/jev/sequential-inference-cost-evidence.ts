import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { strictParseOptions } from '../schemas'
import { makeNativeChartEvidence, makeRetainedChartEvidenceV1 } from './chart-evidence'
import { JevContractError, JevFailure } from './contract'
import { makeChartDecisionsRequest } from './chart-questions'
import { makeEntryJudgmentRequest, entryJudgmentPolicy } from './entry-questions'
import {
  RetainedConditionalChartAssessmentsSchema,
  makeRetainedConditionalChartDecisionsRequest,
  retainedConditionalChartAssessmentsFromResponse,
  retainedConditionalChartQuestionPolicy,
} from './retained-conditional-chart-questions'
import {
  decodeEntryHandoff,
  decodeEntryHandoffForChart,
  makeEntryHandoffSchema,
  makeEntryInferenceCompletionSchema,
  verifyEntryCompletion,
} from './entry-inference-evidence'
import {
  EntryInferenceInputSchema,
  verifyEntryInferenceSource,
  type EntryInferenceMaterial,
} from './entry-inference-input'
import type { EntryHandoffMaterial } from './entry-inference'
import { jevEntryEconomics } from './entry-economics'
import { mayHaveRetainedFundableSourceProposal } from './entry-proposals'
import {
  decodeJevEvaluationReceipt,
  decodeJevEvaluationRequest,
  JevEvaluationReceiptSchema,
  JevEvaluationRequestSchema,
  JevOutcome,
} from './evidence'
import { decodeJevResolution } from './resolution'
import { jevProtocolSchemaForQuestionPolicy } from './protocol'
import {
  RetainedChartAssessmentsSchema,
  makeRetainedChartDecisionsRequest,
  retainedChartAssessments,
  retainedChartQuestionPolicy,
} from './retained-chart-questions'
import { makeRetainedEntryJudgmentRequest, retainedEntryJudgmentPolicy } from './retained-entry-questions'

export const retainedSequentialQuestionPolicyHash = Result.getOrThrow(
  canonicalHashV1Result({ chart: retainedChartQuestionPolicy, jev: retainedEntryJudgmentPolicy }),
)
export const retainedConditionalQuestionPolicyHash = Result.getOrThrow(
  canonicalHashV1Result({ chart: retainedConditionalChartQuestionPolicy, jev: entryJudgmentPolicy }),
)
const RetainedInput = Schema.Struct({
  ...EntryInferenceInputSchema.fields,
  schemaVersion: Schema.Literals(['bayn.entry-inference-input.v1', 'bayn.entry-inference-input.v2']),
  protocol: jevProtocolSchemaForQuestionPolicy(retainedSequentialQuestionPolicyHash, 'bayn.jev.protocol.v24'),
})
const RetainedRequest = Schema.Struct({ ...JevEvaluationRequestSchema.fields, request: RetainedInput })
const RetainedConditionalInput = Schema.Struct({
  ...EntryInferenceInputSchema.fields,
  schemaVersion: Schema.Literal('bayn.entry-inference-input.v3'),
  protocol: jevProtocolSchemaForQuestionPolicy(retainedConditionalQuestionPolicyHash, 'bayn.jev.protocol.v24'),
})
const RetainedConditionalRequest = Schema.Struct({
  ...JevEvaluationRequestSchema.fields,
  request: RetainedConditionalInput,
})
const RetainedHandoff = makeEntryHandoffSchema('bayn.entry-handoff.v1', RetainedChartAssessmentsSchema)
const RetainedConditionalHandoff = makeEntryHandoffSchema(
  'bayn.entry-handoff.v2',
  RetainedConditionalChartAssessmentsSchema,
)
const makeRetainedReceiptSchema = <S extends Schema.Top>(handoff: S) =>
  Schema.Struct({
    ...JevEvaluationReceiptSchema.fields,
    outcome: Schema.Union([
      Schema.Struct({
        status: Schema.Literal(JevOutcome.Completed),
        completion: makeEntryInferenceCompletionSchema(handoff),
      }),
      Schema.Struct({ status: Schema.Literal(JevOutcome.Failed), failure: Schema.Enum(JevFailure) }),
    ]),
  })
const RetainedReceipt = makeRetainedReceiptSchema(RetainedHandoff)
const RetainedConditionalReceipt = makeRetainedReceiptSchema(RetainedConditionalHandoff)
const invalid = (message: string) => Result.fail(new JevContractError({ message }))

const retainedSourceFeasible = (
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
    return economics === null
      ? false
      : yield* mayHaveRetainedFundableSourceProposal({
          chart,
          economics,
          protocol: input.protocol,
          bidMicros: BigInt(input.funding.bidMicros),
        })
  })

// Financial projection only. The executable entry codec accepts only v4 inputs.
export const readSequentialInferenceCostEvidence = (row: {
  readonly request: unknown
  readonly receipt: unknown
  readonly handoff: unknown
  readonly resolution: unknown
}) =>
  Result.gen(function* () {
    const version = yield* Schema.decodeUnknownResult(
      Schema.Struct({
        request: Schema.Struct({
          schemaVersion: Schema.Literals([
            'bayn.entry-inference-input.v1',
            'bayn.entry-inference-input.v2',
            'bayn.entry-inference-input.v3',
            'bayn.entry-inference-input.v4',
          ]),
        }),
      }),
    )(row.request)
    if (version.request.schemaVersion === 'bayn.entry-inference-input.v4') {
      const request = yield* decodeJevEvaluationRequest(row.request)
      const chart = yield* makeNativeChartEvidence(request.request.chartSource)
      const chartRequest = yield* makeChartDecisionsRequest({
        chart,
        protocol: request.request.protocol,
        funding: request.request.funding,
      })
      const receipt = row.receipt === null ? null : yield* decodeJevEvaluationReceipt(request, row.receipt)
      const resolution = row.resolution === null ? null : yield* decodeJevResolution(request, receipt, row.resolution)
      const handoff =
        row.handoff === null
          ? null
          : yield* decodeEntryHandoff(
              {
                requestId: request.requestId,
                input: request.request,
                observedAt: request.observedAt,
                expiresAt: request.expiresAt,
              },
              row.handoff,
            )
      return { request, receipt, resolution, handoff, chartRequest }
    }

    const conditional = version.request.schemaVersion === 'bayn.entry-inference-input.v3'
    const request = yield* conditional
      ? Schema.decodeUnknownResult(RetainedConditionalRequest, strictParseOptions)(row.request)
      : Schema.decodeUnknownResult(RetainedRequest, strictParseOptions)(row.request)
    const { requestId, ...material } = request
    const prepared = yield* verifyEntryInferenceSource(request.request)
    if (
      requestId !== (yield* canonicalHashV1Result(material)) ||
      request.requestHash !== prepared.requestHash ||
      request.symbol !== request.request.chartSource.symbol ||
      request.request.chartSource.windowEndAt > request.observedAt ||
      Date.parse(request.expiresAt) - Date.parse(request.observedAt) !== request.request.protocol.inferenceValidityMs
    )
      return yield* invalid('Retained chart request identity or original validity interval does not reproduce')
    const chart = yield* request.request.schemaVersion === 'bayn.entry-inference-input.v1'
      ? makeRetainedChartEvidenceV1(request.request.chartSource)
      : makeNativeChartEvidence(request.request.chartSource)
    const source = { requestId, input: request.request, observedAt: request.observedAt, expiresAt: request.expiresAt }
    const chartRequest = yield* conditional
      ? makeRetainedConditionalChartDecisionsRequest(chart)
      : makeRetainedChartDecisionsRequest(chart)
    const handoff =
      row.handoff === null
        ? null
        : yield* decodeEntryHandoffForChart<EntryHandoffMaterial>({
            source,
            input: row.handoff,
            inputHash: prepared.requestHash,
            chart,
            handoffSchema: conditional ? RetainedConditionalHandoff : RetainedHandoff,
            sourceFeasible:
              request.request.schemaVersion === 'bayn.entry-inference-input.v1'
                ? null
                : yield* retainedSourceFeasible(request.request, chart),
            prepareVisual: () => Result.succeed(chartRequest),
            assessVisual: conditional ? retainedConditionalChartAssessmentsFromResponse : retainedChartAssessments,
            prepareJudgments: conditional ? makeEntryJudgmentRequest : makeRetainedEntryJudgmentRequest,
          })
    const receipt =
      row.receipt === null
        ? null
        : yield* conditional
            ? Schema.decodeUnknownResult(RetainedConditionalReceipt, strictParseOptions)(row.receipt)
            : Schema.decodeUnknownResult(RetainedReceipt, strictParseOptions)(row.receipt)
    if (receipt !== null) {
      const { receiptHash, ...receiptMaterial } = receipt
      if (
        receipt.requestId !== requestId ||
        receipt.startedAt < request.observedAt ||
        receipt.completedAt < receipt.startedAt ||
        receiptHash !== (yield* canonicalHashV1Result(receiptMaterial))
      )
        return yield* invalid('Retained chart receipt identity or clocks do not reproduce')
      if (receipt.outcome.status === JevOutcome.Completed) {
        const { handoff: receiptHandoff, ...completion } = receipt.outcome.completion
        const { handoffHash, ...handoffMaterial } = receiptHandoff
        if (
          handoff === null ||
          handoffHash !== handoff.handoffHash ||
          (yield* canonicalHashV1Result(handoffMaterial)) !== handoffHash
        )
          return yield* invalid('Retained chart receipt differs from its committed handoff')
        yield* verifyEntryCompletion(source, completion, handoff)
        if (
          completion.completedAt > receipt.completedAt ||
          handoff.recordedAt < receipt.startedAt ||
          (handoff.disposition.status !== 'VISUAL_FAILED' &&
            handoff.disposition.status !== 'SOURCE_INFEASIBLE' &&
            handoff.disposition.visual.startedAt < receipt.startedAt)
        )
          return yield* invalid('Retained chart receipt precedes its provider evidence')
      } else if (
        receipt.outcome.failure === JevFailure.NotDispatched &&
        (receipt.startedAt >= request.expiresAt || receipt.completedAt < request.expiresAt)
      )
        return yield* invalid('Retained undispatched chart receipt does not prove its original deadline expiry')
    }
    const resolution = row.resolution === null ? null : yield* decodeJevResolution(request, receipt, row.resolution)
    return { request, receipt, resolution, handoff, chartRequest }
  })
