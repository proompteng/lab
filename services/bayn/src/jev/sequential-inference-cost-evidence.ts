import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { strictParseOptions } from '../schemas'
import { makeNativeChartEvidence, makeRetainedChartEvidenceV1 } from './chart-evidence'
import { JevContractError, JevFailure } from './contract'
import {
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
import { jevEntryEconomics } from './entry-economics'
import { mayHaveRetainedFundableSourceProposal } from './entry-proposals'
import { JevEvaluationReceiptSchema, JevEvaluationRequestSchema, JevOutcome } from './evidence'
import { decodeJevResolution } from './resolution'
import { jevProtocolSchemaForQuestionPolicy } from './protocol'
import {
  RetainedChartAssessmentsSchema,
  makeRetainedChartDecisionsRequest,
  retainedChartAssessments,
  retainedChartQuestionPolicy,
} from './retained-chart-questions'
import { makeRetainedEntryJudgmentRequest, retainedEntryJudgmentPolicy } from './retained-entry-questions'
import {
  retainedConditionalChartQuestionPolicy as chartQuestionPolicy,
  RetainedConditionalChartAssessmentsSchema as ChartAssessmentsSchema,
  makeRetainedConditionalChartDecisionsRequest as makeChartDecisionsRequest,
  retainedConditionalChartAssessmentsFromResponse as chartAssessmentsFromResponse,
} from './retained-conditional-chart-questions'
import {
  chartQuestionPolicy as fundedChartQuestionPolicy,
  ChartAssessmentsSchema as FundedChartAssessmentsSchema,
  makeChartDecisionsRequest as makeFundedChartDecisionsRequest,
  chartAssessmentsFromResponse as fundedChartAssessmentsFromResponse,
} from './retained-funded-chart-questions'
import { entryJudgmentPolicy, makeEntryJudgmentRequest } from './entry-questions'

export const retainedSequentialQuestionPolicyHash = Result.getOrThrow(
  canonicalHashV1Result({ chart: retainedChartQuestionPolicy, jev: retainedEntryJudgmentPolicy }),
)
const OldInput = Schema.Struct({
  ...EntryInferenceInputSchema.fields,
  schemaVersion: Schema.Literals(['bayn.entry-inference-input.v1', 'bayn.entry-inference-input.v2']),
  protocol: jevProtocolSchemaForQuestionPolicy(retainedSequentialQuestionPolicyHash, 'bayn.jev.protocol.v24'),
})
export const retainedConditionalQuestionPolicyHash = Result.getOrThrow(
  canonicalHashV1Result({ chart: chartQuestionPolicy, jev: entryJudgmentPolicy }),
)
const ConditionalInput = Schema.Struct({
  ...EntryInferenceInputSchema.fields,
  schemaVersion: Schema.Literal('bayn.entry-inference-input.v3'),
  protocol: jevProtocolSchemaForQuestionPolicy(retainedConditionalQuestionPolicyHash, 'bayn.jev.protocol.v24'),
})
export const retainedFundedQuestionPolicyHash = Result.getOrThrow(
  canonicalHashV1Result({ chart: fundedChartQuestionPolicy, jev: entryJudgmentPolicy }),
)
const FundedInput = Schema.Struct({
  ...EntryInferenceInputSchema.fields,
  schemaVersion: Schema.Literal('bayn.entry-inference-input.v4'),
  protocol: jevProtocolSchemaForQuestionPolicy(retainedFundedQuestionPolicyHash, 'bayn.jev.protocol.v25'),
})
const RetainedRequest = Schema.Struct({
  ...JevEvaluationRequestSchema.fields,
  schemaVersion: Schema.Literal('bayn.jev-evaluation-request.v2'),
  request: Schema.Union([OldInput, ConditionalInput, FundedInput]),
})
const RetainedHandoff = makeEntryHandoffSchema('bayn.entry-handoff.v1', RetainedChartAssessmentsSchema)
const ConditionalHandoff = makeEntryHandoffSchema('bayn.entry-handoff.v2', ChartAssessmentsSchema)
const FundedHandoff = makeEntryHandoffSchema('bayn.entry-handoff.v3', FundedChartAssessmentsSchema)
const RetainedReceipt = Schema.Struct({
  ...JevEvaluationReceiptSchema.fields,
  schemaVersion: Schema.Literal('bayn.jev-evaluation-receipt.v2'),
  outcome: Schema.Union([
    Schema.Struct({
      status: Schema.Literal(JevOutcome.Completed),
      completion: makeEntryInferenceCompletionSchema(
        Schema.Union([RetainedHandoff, ConditionalHandoff, FundedHandoff]),
      ),
    }),
    Schema.Struct({ status: Schema.Literal(JevOutcome.Failed), failure: Schema.Enum(JevFailure) }),
  ]),
})
const invalid = (message: string) => Result.fail(new JevContractError({ message }))

const retainedSourceFeasible = (
  input: EntryInferenceMaterial,
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

// Financial projection only. The executable entry codec accepts only v5 inputs.
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
    const request = yield* Schema.decodeUnknownResult(RetainedRequest, strictParseOptions)(row.request)
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
    const funded = version.request.schemaVersion === 'bayn.entry-inference-input.v4'
    const conditional = version.request.schemaVersion === 'bayn.entry-inference-input.v3'
    const fundedRequest = funded
      ? yield* makeFundedChartDecisionsRequest({
          chart,
          protocol: request.request.protocol,
          funding: request.request.funding,
        })
      : null
    const chartRequest =
      fundedRequest ??
      (yield* conditional ? makeChartDecisionsRequest(chart) : makeRetainedChartDecisionsRequest(chart))
    const handoff =
      row.handoff === null
        ? null
        : yield* decodeEntryHandoffForChart({
            source,
            input: row.handoff,
            inputHash: prepared.requestHash,
            chart,
            handoffSchema: Schema.Union([FundedHandoff, ConditionalHandoff, RetainedHandoff]),
            sourceFeasible:
              fundedRequest !== null
                ? fundedRequest.sourceFeasible
                : version.request.schemaVersion === 'bayn.entry-inference-input.v1'
                  ? null
                  : yield* retainedSourceFeasible(request.request, chart),
            prepareVisual: () => Result.succeed(chartRequest),
            assessVisual: funded
              ? (sourceChart, response) =>
                  fundedChartAssessmentsFromResponse(sourceChart, response, chartRequest.request)
              : conditional
                ? chartAssessmentsFromResponse
                : retainedChartAssessments,
            prepareJudgments: conditional || funded ? makeEntryJudgmentRequest : makeRetainedEntryJudgmentRequest,
          })

    if (
      handoff !== null &&
      handoff.schemaVersion !==
        (funded
          ? 'bayn.entry-handoff.v3'
          : version.request.schemaVersion === 'bayn.entry-inference-input.v3'
            ? 'bayn.entry-handoff.v2'
            : 'bayn.entry-handoff.v1')
    )
      return yield* invalid('Retained handoff version differs from its input contract')
    const receipt =
      row.receipt === null ? null : yield* Schema.decodeUnknownResult(RetainedReceipt, strictParseOptions)(row.receipt)
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

export const decodeConditionalEvaluationRequest = (input: unknown) =>
  Result.gen(function* () {
    const graph = yield* readSequentialInferenceCostEvidence({
      request: input,
      receipt: null,
      handoff: null,
      resolution: null,
    })

    if (graph.request.request.schemaVersion !== 'bayn.entry-inference-input.v3')
      return yield* invalid('Chart checkpoint requires the retained conditional input contract')
    return graph.request
  })

export const decodeFundedEvaluationRequest = (input: unknown) =>
  Result.gen(function* () {
    const graph = yield* readSequentialInferenceCostEvidence({
      request: input,
      receipt: null,
      handoff: null,
      resolution: null,
    })
    if (graph.request.request.schemaVersion !== 'bayn.entry-inference-input.v4')
      return yield* invalid('Funded financial evidence requires the retained v25 input contract')
    return graph.request
  })
