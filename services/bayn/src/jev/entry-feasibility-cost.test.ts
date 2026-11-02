import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { makeInferenceExpenseQuotes } from '../inference-expense'
import { InferenceStage, InferenceUsageStatus } from '../inference-costs'
import { makeNativeChartEvidence } from './chart-evidence'
import { makeInitialChartStageRequest } from './staged-chart-questions'
import { makeStagedSkipReceipt } from './staged-checkpoint'
import { JevResolutionStatus, makeJevResolution } from './resolution'
import { entryEvaluationRequestFixture } from './entry-inference.test-support'
import { decodeEntryHandoff } from './entry-inference-evidence'
import { prepareEntryInferenceInput } from './entry-inference-input'
import { makeJevEvaluationRequest, makeJevEvaluationReceipt, JevOutcome } from './evidence'

const skipped = () => {
  const { requestId: _, ...base } = entryEvaluationRequestFixture()
  const prepared = Result.getOrThrow(
    prepareEntryInferenceInput({
      ...base.request,
      funding: { ...base.request.funding, bidMicros: '500000000', askMicros: '500020000' },
    }),
  )
  const request = Result.getOrThrow(
    makeJevEvaluationRequest({ ...base, request: prepared.input, requestHash: prepared.requestHash }),
  )
  const chart = Result.getOrThrow(makeNativeChartEvidence(request.request.chartSource))
  const visual = Result.getOrThrow(
    makeInitialChartStageRequest({ chart, protocol: request.request.protocol, funding: request.request.funding }),
  )
  const skip = Result.getOrThrow(
    makeStagedSkipReceipt({
      schemaVersion: 'bayn.staged-skip-receipt.v1',
      stage: 'BASE_START',
      requestId: request.requestId,
      predecessorHash: null,
      reason: 'SOURCE_INFEASIBLE',
      recordedAt: request.observedAt,
    }),
  )
  const material = {
    schemaVersion: 'bayn.entry-handoff.v4' as const,
    requestId: request.requestId,
    inputHash: request.requestHash,
    visualRequestHash: visual.requestHash,
    recordedAt: request.observedAt,
    disposition: { status: 'SOURCE_INFEASIBLE' as const },
    baseStart: { status: 'NOT_REQUESTED' as const, skip },
  }
  const handoff = Result.getOrThrow(
    decodeEntryHandoff(
      {
        requestId: request.requestId,
        input: request.request,
        observedAt: request.observedAt,
        expiresAt: request.expiresAt,
      },
      { ...material, handoffHash: Result.getOrThrow(canonicalHashV1Result(material)) },
    ),
  )
  const receipt = Result.getOrThrow(
    makeJevEvaluationReceipt(request, {
      schemaVersion: 'bayn.jev-evaluation-receipt.v3',
      requestId: request.requestId,
      startedAt: request.observedAt,
      completedAt: request.observedAt,
      outcome: {
        status: JevOutcome.Completed,
        completion: { handoff, completedAt: request.observedAt, jev: { status: 'NOT_REQUESTED' } },
      },
    }),
  )
  return { request, handoff, receipt, stagedCheckpoint: { claims: [], terminals: [], skips: [skip] } }
}

for (const completed of [true, false])
  test(`prices authenticated undispatched stages after the infeasible handoff, completion=${completed}`, () => {
    const row = skipped()
    const quotes = Result.getOrThrow(
      makeInferenceExpenseQuotes(
        {
          ...row,
          receipt: completed ? row.receipt : null,
          resolution: completed
            ? Result.getOrThrow(
                makeJevResolution(row.request, row.receipt, {
                  schemaVersion: 'bayn.jev-evaluation-resolution.v1',
                  requestId: row.request.requestId,
                  status: JevResolutionStatus.Recorded,
                  receiptHash: row.receipt.receiptHash,
                }),
              )
            : null,
          requestId: row.request.requestId,
          cycleId: row.request.cycleId,
          authorityGenerationHash: row.request.authorityGenerationHash,
          accountId: 'source-feasibility-test',
          sessionDate: '2026-10-25',
          asOf: row.request.expiresAt,
        },
        { schemaVersion: 'bayn.inference-rate-card.v1', rates: [] },
      ),
    )
    expect(quotes).toHaveLength(completed ? 3 : 1)
    expect(quotes.map((q) => ('stage' in q.line ? q.line.stage : null)).toSorted()).toEqual(
      completed ? [InferenceStage.BaseStart, InferenceStage.Chart, InferenceStage.Jev] : [InferenceStage.BaseStart],
    )
    for (const quote of quotes) {
      expect(quote.line.usageStatus).toBe(InferenceUsageStatus.NotDispatched)
      expect(quote.line.inputTokens).toBe('0')
      expect(quote.line.outputTokens).toBe('0')
      expect(quote.line.estimatedCostPicoUsd).toBe('0')
      expect(quote.rate).toBeNull()
    }
  })
