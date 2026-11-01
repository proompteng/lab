import { retainedIntradayExecutionModel } from '../strategy/intraday-market'
import { IntradayCandidateEvidencePolicy } from '../market-data/intraday/model'
import { Result } from 'effect'
import { canonicalHashV1Result } from '../hash'
import { makeNativeChartEvidence } from './chart-evidence'
import {
  retainedConditionalChartAssessmentsFromResponse as chartAssessmentsFromResponse,
  makeRetainedConditionalChartDecisionsRequest as makeChartDecisionsRequest,
} from './retained-conditional-chart-questions'
import { decodeJevResponse, prepareJevRequest } from './contract'
import { deriveEntryDispositionForChart } from './entry-inference'
import { verifyEntryInferenceSource, type EntryInferenceMaterial } from './entry-inference-input'
import {
  entryEvaluationRequestFixture as currentRequestFixture,
  nativeChartInference,
} from './entry-inference.test-support'
import { makeRetainedFundedEntryJudgmentRequest as makeEntryJudgmentRequest } from './retained-funded-entry-questions'
import {
  decodeConditionalEvaluationRequest,
  retainedConditionalQuestionPolicyHash,
  readSequentialInferenceCostEvidence,
} from './sequential-inference-cost-evidence'

// Historical financial-only fixtures. Never pass these to current execution codecs.
export const entryEvaluationRequestFixture = (observedAt?: string, symbol?: string) => {
  const current = currentRequestFixture(observedAt, symbol)
  const input = {
    ...current.request,
    numericalState: { ...current.request.numericalState, schemaVersion: 'bayn.jev-entry-state.v22' },
    schemaVersion: 'bayn.entry-inference-input.v3' as const,
    protocol: {
      ...current.request.protocol,
      executionModel: retainedIntradayExecutionModel,
      schemaVersion: 'bayn.jev.protocol.v24' as const,
      inputDefinition: 'bayn.jev-entry-state.v22' as const,
      lookbackMinutes: 30 as const,
      candidateEvidencePolicy: IntradayCandidateEvidencePolicy.QuoteWithWindowTrade,
      entryQuestionPolicyHash: retainedConditionalQuestionPolicyHash,
    },
  }
  const prepared = Result.getOrThrow(verifyEntryInferenceSource(input))
  const { requestId: _id, ...currentMaterial } = current
  const material = {
    ...currentMaterial,
    schemaVersion: 'bayn.jev-evaluation-request.v2' as const,
    request: input,
    requestHash: prepared.requestHash,
  }
  return Result.getOrThrow(
    decodeConditionalEvaluationRequest({ ...material, requestId: Result.getOrThrow(canonicalHashV1Result(material)) }),
  )
}
export const chartInferenceFixture = (input: EntryInferenceMaterial, at: string) => {
  const chart = Result.getOrThrow(makeNativeChartEvidence(input.chartSource))
  return nativeChartInference(Result.getOrThrow(makeChartDecisionsRequest(chart)).request, at)
}
const deriveConditionalDisposition = (
  input: EntryInferenceMaterial,
  visual: ReturnType<typeof chartInferenceFixture>,
) =>
  Result.gen(function* () {
    const chart = yield* makeNativeChartEvidence(input.chartSource)
    return yield* deriveEntryDispositionForChart(
      input,
      visual,
      chart,
      yield* chartAssessmentsFromResponse(chart, visual.response),
      makeEntryJudgmentRequest,
    )
  })
export const entryCompletionFixture = (
  request: ReturnType<typeof entryEvaluationRequestFixture>,
  at = request.observedAt,
  support = 0.9,
) => {
  const disposition = Result.getOrThrow(
    deriveConditionalDisposition(request.request, chartInferenceFixture(request.request, at)),
  )
  const material = {
    schemaVersion: 'bayn.entry-handoff.v2' as const,
    requestId: request.requestId,
    inputHash: request.requestHash,
    visualRequestHash: disposition.visual.requestHash,
    recordedAt: at,
    disposition,
  }
  const handoff = { ...material, handoffHash: Result.getOrThrow(canonicalHashV1Result(material)) }
  if (disposition.status !== 'READY') return { handoff, completedAt: at, jev: { status: 'NOT_REQUESTED' } }
  const prepared = Result.getOrThrow(prepareJevRequest(disposition.jevRequest))
  const response = Result.getOrThrow(
    decodeJevResponse(prepared.request, {
      model: prepared.request.model,
      answers: Object.fromEntries(
        Object.keys(prepared.request.questions).map((name) => [
          name,
          { type: 'noul', noul: name.endsWith('_target_obstructed') ? 1 - support : support },
        ]),
      ),
      usage: { input_tokens: 200, output_tokens: 0 },
    }),
  )
  return {
    handoff,
    completedAt: at,
    jev: {
      status: 'RECEIVED',
      inference: {
        requestHash: prepared.requestHash,
        responseHash: Result.getOrThrow(canonicalHashV1Result(response)),
        startedAt: at,
        completedAt: at,
        response,
      },
    },
  }
}

export const makeConditionalEvaluationReceipt = (
  request: ReturnType<typeof entryEvaluationRequestFixture>,
  material: {
    readonly startedAt: string
    readonly completedAt: string
    readonly outcome: { readonly status: 'COMPLETED'; readonly completion: ReturnType<typeof entryCompletionFixture> }
  },
) =>
  Result.gen(function* () {
    const value = {
      ...material,
      schemaVersion: 'bayn.jev-evaluation-receipt.v2' as const,
      requestId: request.requestId,
    }
    const receipt = { ...value, receiptHash: yield* canonicalHashV1Result(value) }
    const graph = yield* readSequentialInferenceCostEvidence({
      request,
      receipt,
      handoff: material.outcome.completion.handoff,
      resolution: null,
    })
    if (graph.receipt === null) throw new Error('Expected retained receipt')
    return graph.receipt
  })
