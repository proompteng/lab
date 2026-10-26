import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { inferenceExpenseRateCard, makeInferenceExpenseQuotes } from '../inference-expense'
import { InferenceStage, InferenceUsageStatus } from '../inference-costs'
import { makeNativeChartEvidence, makeRetainedChartEvidenceV1 } from './chart-evidence'
import { deriveEntryDispositionForChart } from './entry-inference'
import { entryEvaluationRequestFixture } from './entry-inference.test-support'
import { decodeJevEvaluationRequest, JevOutcome } from './evidence'
import {
  readSequentialInferenceCostEvidence,
  retainedSequentialQuestionPolicyHash,
} from './sequential-inference-cost-evidence'
import { makeRetainedChartDecisionsRequest, retainedChartAssessments } from './retained-chart-questions'
import { makeRetainedEntryJudgmentRequest } from './retained-entry-questions'
import { decodeDecisionsResponse } from './decisions'

const retained = (
  schemaVersion: 'bayn.entry-inference-input.v1' | 'bayn.entry-inference-input.v2' = 'bayn.entry-inference-input.v1',
) => {
  const current = entryEvaluationRequestFixture()
  const bars = current.request.chartSource.bars.map((bar) => ({ ...bar, volume: bar.volume / 1_000_000 }))
  const input = {
    ...current.request,
    schemaVersion,
    protocol: {
      ...current.request.protocol,
      schemaVersion: 'bayn.jev.protocol.v24' as const,
      entryQuestionPolicyHash: retainedSequentialQuestionPolicyHash,
    },
    chartSource: { ...current.request.chartSource, bars },
    numericalState: { ...current.request.numericalState, candidate: { symbol: current.symbol, bars1m: bars } },
  }
  const { requestId: _, ...original } = current
  const material = { ...original, request: input, requestHash: Result.getOrThrow(canonicalHashV1Result(input)) }
  const request = { ...material, requestId: Result.getOrThrow(canonicalHashV1Result(material)) }
  const chart = Result.getOrThrow(
    schemaVersion === 'bayn.entry-inference-input.v1'
      ? makeRetainedChartEvidenceV1(input.chartSource)
      : makeNativeChartEvidence(input.chartSource),
  )
  const visualRequest = Result.getOrThrow(makeRetainedChartDecisionsRequest(chart))
  const anchors = {
    support_anchor: chart.bars.reduce((left, right) => (left.low <= right.low ? left : right)),
    resistance_anchor: chart.bars.reduce((left, right) => (left.high >= right.high ? left : right)),
    base_first_bar: chart.bars[0],
    base_last_bar: chart.bars.at(-2),
  }
  const response = Result.getOrThrow(
    decodeDecisionsResponse(visualRequest.request, {
      model: visualRequest.request.model,
      answers: visualRequest.request.questions.map((question) => {
        if (question.type === 'predicate') return { type: 'predicate', name: question.name, probability: 0.9 }
        const anchor = Object.entries(anchors).find(([name]) => name === question.name)?.[1]
        if (anchor === undefined) throw new Error('Missing retained source anchor')
        return {
          type: 'choice',
          name: question.name,
          choice: anchor.id,
          confidence: 1,
          probabilities: question.choices.map((choice) => ({
            value: choice.value,
            probability: choice.value === anchor.id ? 1 : 0,
          })),
        }
      }),
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 0,
        total_tokens: 100,
      },
    }),
  )
  const visual = {
    requestHash: visualRequest.requestHash,
    responseHash: Result.getOrThrow(canonicalHashV1Result(response)),
    startedAt: request.observedAt,
    completedAt: request.observedAt,
    response,
  }
  const disposition = Result.getOrThrow(
    deriveEntryDispositionForChart(
      input,
      visual,
      chart,
      Result.getOrThrow(retainedChartAssessments(chart, response)),
      makeRetainedEntryJudgmentRequest,
    ),
  )
  if (disposition.status !== 'READY') throw new Error('The retained fixture requires a funded proposal')
  const handoffMaterial = {
    schemaVersion: 'bayn.entry-handoff.v1',
    requestId: request.requestId,
    inputHash: request.requestHash,
    visualRequestHash: visualRequest.requestHash,
    recordedAt: request.observedAt,
    disposition,
  }
  const handoff = { ...handoffMaterial, handoffHash: Result.getOrThrow(canonicalHashV1Result(handoffMaterial)) }
  const receiptMaterial = {
    schemaVersion: 'bayn.jev-evaluation-receipt.v2',
    requestId: request.requestId,
    startedAt: request.observedAt,
    completedAt: request.expiresAt,
    outcome: {
      status: JevOutcome.Completed,
      completion: { handoff, completedAt: request.expiresAt, jev: { status: 'NOT_DISPATCHED' } },
    },
  }
  const receipt = { ...receiptMaterial, receiptHash: Result.getOrThrow(canonicalHashV1Result(receiptMaterial)) }
  return { request, receipt, handoff, resolution: null }
}

test('retains whole-unit chart costs without accepting their input for execution', () => {
  const row = retained()
  const decoded = Result.getOrThrow(readSequentialInferenceCostEvidence(row))
  expect(decoded.request.requestHash).toBe(row.request.requestHash)
  expect(decoded.receipt?.receiptHash).toBe(row.receipt.receiptHash)
  expect(decoded.handoff?.handoffHash).toBe(row.handoff.handoffHash)
  expect(Result.isFailure(decodeJevEvaluationRequest(row.request))).toBe(true)
  const quotes = Result.getOrThrow(
    makeInferenceExpenseQuotes(
      {
        ...row,
        accountId: 'retained-chart-cost-fixture',
        sessionDate: '2026-10-25',
        asOf: row.request.expiresAt,
        requestId: row.request.requestId,
        cycleId: row.request.cycleId,
        authorityGenerationHash: row.request.authorityGenerationHash,
      },
      inferenceExpenseRateCard,
    ),
  )
  expect(
    quotes
      .map((quote) => ['stage' in quote.line ? quote.line.stage : null, quote.line.usageStatus])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  ).toEqual([
    [InferenceStage.Chart, InferenceUsageStatus.Received],
    [InferenceStage.Jev, InferenceUsageStatus.NotDispatched],
  ])
  expect(
    quotes.find((quote) => 'stage' in quote.line && quote.line.stage === InferenceStage.Chart)?.line.inputTokens,
  ).toBe('100')
})

test('retains relative-volume chart costs with the original independent questions', () => {
  expect(retainedSequentialQuestionPolicyHash).toBe('23c4a8f7d4e746486abf2b480a591419289ca174f9d6433d46121a68356b1131')
  const row = retained('bayn.entry-inference-input.v2')
  const decoded = Result.getOrThrow(readSequentialInferenceCostEvidence(row))
  expect(decoded.request.requestHash).toBe(row.request.requestHash)
  expect(decoded.receipt?.receiptHash).toBe(row.receipt.receiptHash)
  expect(decoded.handoff?.handoffHash).toBe(row.handoff.handoffHash)
  expect(Result.isFailure(decodeJevEvaluationRequest(row.request))).toBe(true)
})

test.each(['bayn.entry-inference-input.v1', 'bayn.entry-inference-input.v2'] as const)(
  'reproduces undispatched source costs only for a retained contract that supported the gate: %s',
  (version) => {
    const row = retained(version)
    const input = {
      ...row.request.request,
      funding: { ...row.request.request.funding, bidMicros: '500000000', askMicros: '500020000' },
    }
    const { requestId: _requestId, ...originalRequest } = row.request
    const requestMaterial = {
      ...originalRequest,
      request: input,
      requestHash: Result.getOrThrow(canonicalHashV1Result(input)),
    }
    const request = { ...requestMaterial, requestId: Result.getOrThrow(canonicalHashV1Result(requestMaterial)) }
    const { handoffHash: _handoffHash, ...originalHandoff } = row.handoff
    const handoffMaterial = {
      ...originalHandoff,
      requestId: request.requestId,
      inputHash: request.requestHash,
      disposition: { status: 'SOURCE_INFEASIBLE' },
    }
    const handoff = { ...handoffMaterial, handoffHash: Result.getOrThrow(canonicalHashV1Result(handoffMaterial)) }
    const { receiptHash: _receiptHash, ...originalReceipt } = row.receipt
    const receiptMaterial = {
      ...originalReceipt,
      requestId: request.requestId,
      outcome: {
        status: JevOutcome.Completed,
        completion: { handoff, completedAt: request.expiresAt, jev: { status: 'NOT_REQUESTED' } },
      },
    }
    const receipt = { ...receiptMaterial, receiptHash: Result.getOrThrow(canonicalHashV1Result(receiptMaterial)) }
    const packet = { request, handoff, receipt, resolution: null }
    const decoded = readSequentialInferenceCostEvidence(packet)
    if (version === 'bayn.entry-inference-input.v1') {
      expect(Result.isFailure(decoded)).toBe(true)
      return
    }
    expect(Result.getOrThrow(decoded).handoff?.handoffHash).toBe(handoff.handoffHash)
    const quotes = Result.getOrThrow(
      makeInferenceExpenseQuotes(
        {
          ...packet,
          accountId: 'retained-source-cost-fixture',
          sessionDate: '2026-10-25',
          asOf: request.expiresAt,
          requestId: request.requestId,
          cycleId: request.cycleId,
          authorityGenerationHash: request.authorityGenerationHash,
        },
        { schemaVersion: 'bayn.inference-rate-card.v1', rates: [] },
      ),
    )
    expect(quotes).toHaveLength(2)
    expect(
      quotes.every(
        (quote) =>
          quote.line.usageStatus === InferenceUsageStatus.NotDispatched && quote.line.estimatedCostPicoUsd === '0',
      ),
    ).toBe(true)
    expect(Result.isFailure(decodeJevEvaluationRequest(request))).toBe(true)
  },
)

test('rejects altered historical image identity and provider clocks even when outer hashes are recomputed', () => {
  const row = retained()
  const altered = { ...row.handoff, visualRequestHash: 'e'.repeat(64) }
  const { handoffHash: _, ...material } = altered
  const handoff = { ...material, handoffHash: Result.getOrThrow(canonicalHashV1Result(material)) }
  expect(Result.isFailure(readSequentialInferenceCostEvidence({ ...row, handoff }))).toBe(true)
  const { receiptHash: _receipt, ...receiptMaterial } = row.receipt
  const early = { ...receiptMaterial, completedAt: row.request.observedAt }
  expect(
    Result.isFailure(
      readSequentialInferenceCostEvidence({
        ...row,
        receipt: { ...early, receiptHash: Result.getOrThrow(canonicalHashV1Result(early)) },
      }),
    ),
  ).toBe(true)
})

test('keeps an uncompleted dependent provider as an unknown expense', () => {
  const row = retained()
  const quotes = Result.getOrThrow(
    makeInferenceExpenseQuotes(
      {
        ...row,
        receipt: null,
        accountId: 'retained-chart-cost-fixture',
        sessionDate: '2026-10-25',
        asOf: row.request.expiresAt,
        requestId: row.request.requestId,
        cycleId: row.request.cycleId,
        authorityGenerationHash: row.request.authorityGenerationHash,
      },
      inferenceExpenseRateCard,
    ),
  )
  expect(
    quotes
      .map((quote) => ['stage' in quote.line ? quote.line.stage : null, quote.line.usageStatus])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  ).toEqual([
    [InferenceStage.Chart, InferenceUsageStatus.Received],
    [InferenceStage.Jev, InferenceUsageStatus.Unknown],
  ])
  expect(
    quotes.find((quote) => 'stage' in quote.line && quote.line.stage === InferenceStage.Jev)?.line.estimatedCostPicoUsd,
  ).toBeNull()
})

test('rejects substituted completion handoff material after the outer receipt is rehashed', () => {
  const row = retained()
  const changed = structuredClone(row.receipt)
  changed.outcome.completion.handoff.visualRequestHash = 'f'.repeat(64)
  const { receiptHash: _, ...material } = changed
  const receipt = { ...material, receiptHash: Result.getOrThrow(canonicalHashV1Result(material)) }
  expect(Result.isFailure(readSequentialInferenceCostEvidence({ ...row, receipt }))).toBe(true)
})
