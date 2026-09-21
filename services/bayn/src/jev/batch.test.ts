import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1 } from '../hash'
import {
  decodeJevBatchPlan,
  decodeJevBatchResult,
  JevCandidatePlanStatus,
  JevCandidateResultStatus,
  JevSourceExclusion,
  makeJevBatchPlan,
  makeJevBatchResult,
  usableJevBatchInferences,
  type JevBatchPlan,
} from './batch'
import { JevFailure } from './contract'
import { JevOutcome, makeJevEvaluationReceipt, makeJevEvaluationRequest } from './evidence'
import { JevResolutionStatus, makeJevResolution } from './resolution'
import { evaluationRequestFixture, inferenceFixture } from './test-support'

const request = evaluationRequestFixture()
const { requestId: _, ...requestMaterial } = request
const second = Result.getOrThrow(makeJevEvaluationRequest({ ...requestMaterial, symbol: 'AMZN' }))
const planMaterial = {
  schemaVersion: 'bayn.jev-batch-plan.v1',
  cycleId: request.cycleId,
  authorityGenerationHash: request.authorityGenerationHash,
  observationHash: 'd'.repeat(64),
  protocolHash: 'e'.repeat(64),
  snapshotId: request.snapshotId,
  observedAt: request.observedAt,
  expiresAt: request.expiresAt,
  benchmarkSymbol: 'SPY',
  questionSetHash: canonicalHashV1({ model: request.request.model, questions: request.request.questions }),
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
const at = (ms: number) => new Date(ms).toISOString()
const resultMaterial = (batch: JevBatchPlan = plan, completion = 400) => ({
  schemaVersion: 'bayn.jev-batch-result.v1',
  batchId: batch.batchId,
  completedAt: at(completion),
  candidates: batch.candidates.map((candidate, index) => {
    if (candidate.status === JevCandidatePlanStatus.Excluded)
      return { symbol: candidate.symbol, status: JevCandidateResultStatus.Excluded }
    const receipt = Result.getOrThrow(
      makeJevEvaluationReceipt(candidate.request, {
        schemaVersion: 'bayn.jev-evaluation-receipt.v1',
        requestId: candidate.request.requestId,
        startedAt: at(0),
        completedAt: at((index + 1) * 100),
        outcome: { status: JevOutcome.Received, inference: inferenceFixture() },
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
  test('binds every candidate and reproduces every inference without a provider', () => {
    expect(Result.getOrThrow(decodeJevBatchPlan(JSON.parse(JSON.stringify(plan))))).toEqual(plan)
    const result = Result.getOrThrow(makeJevBatchResult(plan, resultMaterial()))
    expect(Result.getOrThrow(decodeJevBatchResult(plan, JSON.parse(JSON.stringify(result))))).toEqual(result)
    const inferences = Result.getOrThrow(usableJevBatchInferences(plan, result, 450))
    expect(inferences.map((value) => value.symbol)).toEqual(['AAPL', 'AMZN'])
    expect(inferences.map((value) => value.requestId)).toEqual([request.requestId, second.requestId])
    expect(result.candidates[2]).toEqual({ symbol: 'NVDA', status: JevCandidateResultStatus.Excluded })
  })

  test('rejects mixed observations, generation, time, questions and duplicate or reordered candidates', () => {
    for (const change of [
      { cycleId: 'f'.repeat(64) },
      { authorityGenerationHash: 'f'.repeat(64) },
      { snapshotId: 'f'.repeat(64) },
      { observedAt: at(1) },
      { expiresAt: at(4999) },
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
      expect(Result.isFailure(decodeJevBatchResult(plan, { ...changed, resultHash: canonicalHashV1(changed) }))).toBe(
        true,
      )
    }
  })

  test('selection waits for the slowest result and retains the whole completion and persistence delay', () => {
    expect(Result.isFailure(makeJevBatchResult(plan, resultMaterial(plan, 150)))).toBe(true)
    const result = Result.getOrThrow(makeJevBatchResult(plan, resultMaterial()))
    expect(Result.isFailure(usableJevBatchInferences(plan, result, 399))).toBe(true)
    expect(Result.isSuccess(usableJevBatchInferences(plan, result, 4999))).toBe(true)
    expect(Result.isFailure(usableJevBatchInferences(plan, result, 5000))).toBe(true)
    expect(Result.isFailure(usableJevBatchInferences(plan, result, Number.NaN))).toBe(true)
    const { resultHash: _, ...lateMaterial } = result
    const late = Result.getOrThrow(makeJevBatchResult(plan, { ...lateMaterial, completedAt: at(5001) }))
    expect(Result.isFailure(usableJevBatchInferences(plan, late, 5001))).toBe(true)
  })

  test('a failed candidate remains explicit and prevents using only the successful candidate', () => {
    const failedReceipt = Result.getOrThrow(
      makeJevEvaluationReceipt(second, {
        schemaVersion: 'bayn.jev-evaluation-receipt.v1',
        requestId: second.requestId,
        startedAt: at(0),
        completedAt: at(300),
        outcome: {
          status: JevOutcome.Failed,
          failure: JevFailure.Timeout,
          httpStatus: null,
          responseHash: null,
          rejectedResponse: null,
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
        abandonedAt: at(6000),
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
      const result = Result.getOrThrow(makeJevBatchResult(plan, { ...changed, completedAt: at(6000) }))
      expect(Result.isFailure(usableJevBatchInferences(plan, result, 6000))).toBe(true)
    }
  })
})
