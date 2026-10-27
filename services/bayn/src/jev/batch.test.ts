import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import {
  decodeJevBatchPlan,
  decodeJevBatchResult,
  JevBatchPlanVersion,
  JevCandidatePlanStatus,
  JevCandidateResultStatus,
  JevEntryExclusion,
  JevSourceExclusion,
  makeJevBatchPlan,
  jevBatchQuestionSetHash,
  makeJevBatchResult,
  usableJevBatchInferences,
  type JevBatchPlan,
} from './batch'
import { JevFailure } from './contract'
import { JevOutcome, makeJevEvaluationReceipt, makeJevEvaluationRequest } from './evidence'
import { prepareEntryInferenceInput } from './entry-inference-input'
import { makeNativeChartEvidence } from './chart-evidence'
import { makeInitialChartStageRequest, stagedChartQuestionPolicy } from './staged-chart-questions'
import { entryJudgmentPolicy } from './entry-questions'
import { JevResolutionStatus, makeJevResolution } from './resolution'
import { evaluationRequestFixture } from './test-support'
import { entryEvaluationRequestFixture, entryCompletionFixture } from './entry-inference.test-support'
import type { EntryInferenceCompletion } from './entry-inference'
import type { JevEvaluationReceipt, JevEvaluationRequest } from './evidence'

const request = evaluationRequestFixture()
const second = entryEvaluationRequestFixture(request.observedAt, 'AMZN')
const planMaterial = {
  schemaVersion: JevBatchPlanVersion.V7,
  cycleId: request.cycleId,
  authorityGenerationHash: request.authorityGenerationHash,
  observationHash: 'd'.repeat(64),
  protocolHash: 'e'.repeat(64),
  snapshotId: request.snapshotId,
  observedAt: request.observedAt,
  expiresAt: request.expiresAt,
  benchmarkSymbol: 'SPY',
  questionSetHash: Result.getOrThrow(
    jevBatchQuestionSetHash([request, second].map((request) => ({ symbol: request.symbol, request }))),
  ),
  candidates: [
    { symbol: 'AAPL', status: JevCandidatePlanStatus.Requested, request },
    { symbol: 'AMZN', status: JevCandidatePlanStatus.Requested, request: second },
    {
      symbol: 'NVDA',
      status: JevCandidatePlanStatus.Excluded,
      reason: JevSourceExclusion.NotReady,
      message: 'No complete window',
    },
  ],
}
const plan = Result.getOrThrow(makeJevBatchPlan(planMaterial))
test('120-bar funded batch admission binds bounded CHART and complete selected-start policy', () => {
  const original = entryEvaluationRequestFixture()
  const bars = Array.from({ length: 120 }, (_, index) => ({
    minuteBeforeWindowEnd: 120 - index,
    open: 100,
    high: index === 119 ? 108 : 102,
    low: 97,
    close: index === 119 ? 104 : 101,
    volume: 100,
  }))
  const prepared = Result.getOrThrow(
    prepareEntryInferenceInput({
      ...original.request,
      chartSource: { ...original.request.chartSource, bars },
      numericalState: { ...original.request.numericalState, candidate: { symbol: original.symbol, bars1m: bars } },
    }),
  )
  const { requestId: _requestId, ...material } = original
  const current = Result.getOrThrow(
    makeJevEvaluationRequest({ ...material, request: prepared.input, requestHash: prepared.requestHash }),
  )
  const candidates = [{ symbol: current.symbol, status: JevCandidatePlanStatus.Requested, request: current }]
  const questionSetHash = Result.getOrThrow(jevBatchQuestionSetHash(candidates))
  const chart = Result.getOrThrow(makeNativeChartEvidence(prepared.input.chartSource))
  const visual = Result.getOrThrow(
    makeInitialChartStageRequest({ chart, protocol: prepared.input.protocol, funding: prepared.input.funding }),
  )
  expect(questionSetHash).toBe(
    Result.getOrThrow(
      canonicalHashV1Result([
        {
          symbol: current.symbol,
          visual: { model: visual.request.model, questions: visual.request.questions },
          staged: { policy: stagedChartQuestionPolicy, inputHash: prepared.requestHash },
          jev: entryJudgmentPolicy,
        },
      ]),
    ),
  )
  const batch = Result.getOrThrow(
    makeJevBatchPlan({
      ...planMaterial,
      cycleId: current.cycleId,
      authorityGenerationHash: current.authorityGenerationHash,
      snapshotId: current.snapshotId,
      observedAt: current.observedAt,
      expiresAt: current.expiresAt,
      candidates,
      questionSetHash,
    }),
  )
  expect(Result.isSuccess(decodeJevBatchPlan(batch))).toBe(true)
  const { batchId: _batchId, ...batchMaterial } = batch
  const forged = {
    ...batchMaterial,
    questionSetHash: Result.getOrThrow(
      canonicalHashV1Result([
        {
          symbol: current.symbol,
          visual: { model: visual.request.model, questions: visual.request.questions },
          jev: entryJudgmentPolicy,
        },
      ]),
    ),
  }
  expect(Result.isFailure(makeJevBatchPlan(forged))).toBe(true)
})
const at = (ms: number) => new Date(ms).toISOString()
const resultMaterial = (
  batch: JevBatchPlan = plan,
  completion = 400,
  inferenceAt: (request: JevEvaluationRequest, index: number) => EntryInferenceCompletion = (request) =>
    entryCompletionFixture(request),
) => ({
  schemaVersion: 'bayn.jev-batch-result.v1',
  batchId: batch.batchId,
  completedAt: at(completion),
  candidates: batch.candidates.map((candidate, index) => {
    if (candidate.status === JevCandidatePlanStatus.Excluded)
      return { symbol: candidate.symbol, status: JevCandidateResultStatus.Excluded }
    const receipt = Result.getOrThrow(
      makeJevEvaluationReceipt(candidate.request, {
        schemaVersion: 'bayn.jev-evaluation-receipt.v3',
        requestId: candidate.request.requestId,
        startedAt: at(0),
        completedAt: at((index + 1) * 100),
        outcome: { status: JevOutcome.Completed, completion: inferenceAt(candidate.request, index) },
      }),
    )
    return {
      symbol: candidate.symbol,
      status: JevCandidateResultStatus.Resolved,
      requestId: candidate.request.requestId,
      receipt,
      resolution: Result.getOrThrow(
        makeJevResolution(candidate.request, receipt, {
          schemaVersion: 'bayn.jev-evaluation-resolution.v1',
          requestId: candidate.request.requestId,
          status: JevResolutionStatus.Recorded,
          receiptHash: receipt.receiptHash,
        }),
      ),
    }
  }),
})

describe('complete Jev batch evidence', () => {
  test('machine-precision atomic judgments retain their exact answer and source identity', () => {
    const tied = entryCompletionFixture(request, request.observedAt, 0.7 - Number.EPSILON)
    const result = Result.getOrThrow(
      makeJevBatchResult(
        plan,
        resultMaterial(plan, 400, (candidate, index) => (index === 0 ? tied : entryCompletionFixture(candidate))),
      ),
    )
    const retained = Result.getOrThrow(decodeJevBatchResult(plan, JSON.parse(JSON.stringify(result))))
    const inferences = Result.getOrThrow(usableJevBatchInferences(plan, retained, 450))
    expect(inferences.map((value) => value.symbol)).toEqual(['AAPL', 'AMZN'])
    expect(inferences[0]?.inference).toEqual(tied)
    expect(inferences[1]?.inference).toEqual(entryCompletionFixture(second))
    expect(Result.isFailure(usableJevBatchInferences(plan, retained, Date.parse(plan.expiresAt)))).toBe(true)
  })

  test('binds every candidate and reproduces every inference without a provider', () => {
    expect(Result.getOrThrow(decodeJevBatchPlan(JSON.parse(JSON.stringify(plan))))).toEqual(plan)
    const result = Result.getOrThrow(makeJevBatchResult(plan, resultMaterial()))
    expect(Result.getOrThrow(decodeJevBatchResult(plan, JSON.parse(JSON.stringify(result))))).toEqual(result)
    const inferences = Result.getOrThrow(usableJevBatchInferences(plan, result, 450))
    expect(inferences.map((value) => value.symbol)).toEqual(['AAPL', 'AMZN'])
    expect(inferences.map((value) => value.requestId)).toEqual([request.requestId, second.requestId])
    expect(result.candidates[2]).toEqual({ symbol: 'NVDA', status: JevCandidateResultStatus.Excluded })
  })

  test('only quote-ineligible candidates can justify a zero-inference entry batch', () => {
    const candidates = [
      {
        symbol: 'AAPL',
        status: JevCandidatePlanStatus.Excluded,
        reason: JevEntryExclusion.Spread,
        message: 'Verified wide entry quote',
      },
      {
        symbol: 'AMZN',
        status: JevCandidatePlanStatus.Excluded,
        reason: JevSourceExclusion.NotReady,
        message: 'Missing complete source window',
      },
    ]
    expect(
      Result.isFailure(makeJevBatchPlan({ ...planMaterial, schemaVersion: 'bayn.jev-batch-plan.v1', candidates })),
    ).toBe(true)
    const mixed = Result.getOrThrow(
      makeJevBatchPlan({
        ...planMaterial,
        schemaVersion: JevBatchPlanVersion.V7,
        candidates,
        questionSetHash: Result.getOrThrow(canonicalHashV1Result([])),
      }),
    )
    const result = Result.getOrThrow(makeJevBatchResult(mixed, resultMaterial(mixed)))
    expect(Result.isFailure(usableJevBatchInferences(mixed, result, 450))).toBe(true)
    const versionThree = Result.getOrThrow(
      makeJevBatchPlan({
        ...planMaterial,
        schemaVersion: JevBatchPlanVersion.V7,
        candidates,
        questionSetHash: Result.getOrThrow(canonicalHashV1Result([])),
      }),
    )
    const versionThreeResult = Result.getOrThrow(makeJevBatchResult(versionThree, resultMaterial(versionThree)))
    expect(Result.isFailure(usableJevBatchInferences(versionThree, versionThreeResult, 450))).toBe(true)
  })

  test('rejects mixed observations, generation, time, questions and duplicate or reordered candidates', () => {
    for (const change of [
      { cycleId: 'f'.repeat(64) },
      { authorityGenerationHash: 'f'.repeat(64) },
      { snapshotId: 'f'.repeat(64) },
      { observedAt: at(1) },
      { expiresAt: at(9999) },
      { questionSetHash: 'f'.repeat(64) },
      { benchmarkSymbol: 'AAPL' },
      { candidates: planMaterial.candidates.toReversed() },
      { candidates: [planMaterial.candidates[0], ...planMaterial.candidates] },
      { candidates: [] },
    ])
      expect(Result.isFailure(makeJevBatchPlan({ ...planMaterial, ...change }))).toBe(true)
    expect(Result.isFailure(decodeJevBatchPlan({ ...plan, observationHash: 'f'.repeat(64) }))).toBe(true)
  })

  test('rejects omitted, substituted, extra, duplicate and reordered candidate results even when rehashed', () => {
    const material = resultMaterial()
    for (const candidates of [
      material.candidates.slice(0, 1),
      material.candidates.toReversed(),
      [...material.candidates, material.candidates[0]],
      [material.candidates[0], material.candidates[0], material.candidates[2]],
      [{ ...material.candidates[1], symbol: 'AAPL' }, material.candidates[1], material.candidates[2]],
      [{ symbol: 'AAPL', status: JevCandidateResultStatus.Excluded }, ...material.candidates.slice(1)],
    ]) {
      const changed = { ...material, candidates }
      expect(
        Result.isFailure(
          decodeJevBatchResult(plan, { ...changed, resultHash: Result.getOrThrow(canonicalHashV1Result(changed)) }),
        ),
      ).toBe(true)
    }
  })

  test('selection waits for the slowest result and retains the whole completion and persistence delay', () => {
    expect(Result.isFailure(makeJevBatchResult(plan, resultMaterial(plan, 150)))).toBe(true)
    const result = Result.getOrThrow(makeJevBatchResult(plan, resultMaterial()))
    expect(Result.isFailure(usableJevBatchInferences(plan, result, 399))).toBe(true)
    expect(Result.isSuccess(usableJevBatchInferences(plan, result, 9999))).toBe(true)
    expect(Result.isFailure(usableJevBatchInferences(plan, result, 10000))).toBe(true)
    expect(Result.isFailure(usableJevBatchInferences(plan, result, Number.NaN))).toBe(true)
    const { resultHash: _, ...lateMaterial } = result
    const late = Result.getOrThrow(makeJevBatchResult(plan, { ...lateMaterial, completedAt: at(10001) }))
    expect(Result.isFailure(usableJevBatchInferences(plan, late, 10001))).toBe(true)
  })

  test('selection reproduces provider evidence even when altered receipts and batches are resealed', () => {
    const { resultHash: _originalResultHash, ...material } = Result.getOrThrow(
      makeJevBatchResult(plan, resultMaterial()),
    )
    const candidate = material.candidates[0]
    if (
      candidate?.status !== JevCandidateResultStatus.Resolved ||
      candidate.receipt === null ||
      candidate.receipt.outcome.status !== JevOutcome.Completed
    )
      throw new Error('Expected a completed candidate')
    const completion = candidate.receipt.outcome.completion
    if (completion.handoff.disposition.status !== 'READY') throw new Error('Expected a funded handoff')
    const disposition = completion.handoff.disposition
    const changedDispositions = [
      { ...disposition, visual: { ...disposition.visual, responseHash: 'f'.repeat(64) } },
      { ...disposition, assessments: { ...disposition.assessments, barsHash: 'f'.repeat(64) } },
      { ...disposition, jevRequestHash: 'f'.repeat(64) },
    ]
    for (const changedDisposition of changedDispositions) {
      const { handoffHash: _, ...originalHandoff } = completion.handoff
      const handoffMaterial = { ...originalHandoff, disposition: changedDisposition }
      const handoff = { ...handoffMaterial, handoffHash: Result.getOrThrow(canonicalHashV1Result(handoffMaterial)) }
      const { receiptHash: _receiptHash, ...originalReceipt } = candidate.receipt
      const receiptMaterial = {
        ...originalReceipt,
        outcome: { status: JevOutcome.Completed, completion: { ...completion, handoff } },
      } satisfies Omit<JevEvaluationReceipt, 'receiptHash'>
      const receipt = { ...receiptMaterial, receiptHash: Result.getOrThrow(canonicalHashV1Result(receiptMaterial)) }
      const resolution = Result.getOrThrow(
        makeJevResolution(request, receipt, {
          schemaVersion: 'bayn.jev-evaluation-resolution.v1',
          requestId: request.requestId,
          status: JevResolutionStatus.Recorded,
          receiptHash: receipt.receiptHash,
        }),
      )
      const altered = {
        ...material,
        candidates: [{ ...candidate, receipt, resolution }, ...material.candidates.slice(1)],
      }
      const result = { ...altered, resultHash: Result.getOrThrow(canonicalHashV1Result(altered)) }
      expect(Result.isFailure(usableJevBatchInferences(plan, result, 450))).toBe(true)
    }
  })

  test('a failed candidate remains explicit and prevents using only the successful candidate', () => {
    const failedReceipt = Result.getOrThrow(
      makeJevEvaluationReceipt(second, {
        schemaVersion: 'bayn.jev-evaluation-receipt.v3',
        requestId: second.requestId,
        startedAt: at(0),
        completedAt: at(300),
        outcome: {
          status: JevOutcome.Failed,
          failure: JevFailure.Timeout,
        },
      }),
    )
    const material = resultMaterial()
    const result = Result.getOrThrow(
      makeJevBatchResult(plan, {
        ...material,
        candidates: [
          material.candidates[0],
          {
            status: JevCandidateResultStatus.Resolved,
            symbol: 'AMZN',
            requestId: second.requestId,
            receipt: failedReceipt,
            resolution: Result.getOrThrow(
              makeJevResolution(second, failedReceipt, {
                schemaVersion: 'bayn.jev-evaluation-resolution.v1',
                requestId: second.requestId,
                status: JevResolutionStatus.Recorded,
                receiptHash: failedReceipt.receiptHash,
              }),
            ),
          },
          material.candidates[2],
        ],
      }),
    )
    expect(Result.isFailure(usableJevBatchInferences(plan, result, 450))).toBe(true)
    expect(Result.getOrThrow(decodeJevBatchResult(plan, result))).toEqual(result)
  })

  test('unattempted and abandoned candidates finalize only after expiry and cannot authorize entry', () => {
    const resolution = Result.getOrThrow(
      makeJevResolution(second, null, {
        schemaVersion: 'bayn.jev-evaluation-resolution.v1',
        requestId: second.requestId,
        status: JevResolutionStatus.Abandoned,
        abandonedAt: at(11000),
      }),
    )
    const material = resultMaterial()
    for (const outcome of [
      { status: JevCandidateResultStatus.Unattempted, symbol: 'AMZN', requestId: second.requestId },
      {
        status: JevCandidateResultStatus.Resolved,
        symbol: 'AMZN',
        requestId: second.requestId,
        receipt: null,
        resolution,
      },
    ]) {
      const changed = { ...material, candidates: [material.candidates[0], outcome, material.candidates[2]] }
      expect(Result.isFailure(makeJevBatchResult(plan, changed))).toBe(true)
      const result = Result.getOrThrow(makeJevBatchResult(plan, { ...changed, completedAt: at(11000) }))
      expect(Result.isFailure(usableJevBatchInferences(plan, result, 11000))).toBe(true)
    }
  })
})
