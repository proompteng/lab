import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { inferenceExpenseRateCard, makeInferenceExpenseQuotes } from '../inference-expense'
import { InferenceStage, InferenceUsageStatus } from '../inference-costs'
import { makeRetainedChartEvidenceV1 } from './chart-evidence'
import { makeChartDecisionsRequest } from './chart-questions'
import { deriveEntryDispositionForChart } from './entry-inference'
import { entryEvaluationRequestFixture, nativeChartInference } from './entry-inference.test-support'
import { decodeJevEvaluationRequest, JevOutcome } from './evidence'
import { readSequentialInferenceCostEvidence } from './sequential-inference-cost-evidence'

const retained = () => {
  const current = entryEvaluationRequestFixture()
  const bars = current.request.chartSource.bars.map((bar) => ({ ...bar, volume: bar.volume / 1_000_000 }))
  const input = {
    ...current.request,
    schemaVersion: 'bayn.entry-inference-input.v1',
    chartSource: { ...current.request.chartSource, bars },
    numericalState: { ...current.request.numericalState, candidate: { symbol: current.symbol, bars1m: bars } },
  }
  const { requestId: _, ...original } = current
  const material = { ...original, request: input, requestHash: Result.getOrThrow(canonicalHashV1Result(input)) }
  const request = { ...material, requestId: Result.getOrThrow(canonicalHashV1Result(material)) }
  const chart = Result.getOrThrow(makeRetainedChartEvidenceV1(input.chartSource))
  const visualRequest = Result.getOrThrow(makeChartDecisionsRequest(chart))
  const visual = nativeChartInference(visualRequest.request, request.observedAt)
  const disposition = Result.getOrThrow(deriveEntryDispositionForChart(input, visual, chart))
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
