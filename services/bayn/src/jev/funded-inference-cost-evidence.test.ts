import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { InferenceStage } from '../inference-costs'
import {
  makeInferenceExpenseQuotes,
  verifyInferenceExpenseQuote,
  inferenceExpenseRateCard,
  buildInferenceExpensePlan,
} from '../inference-expense'
import { decodeJevEvaluationRequest } from './evidence'
import {
  entryEvaluationRequestFixture,
  entryCompletionFixture,
  makeFundedEvaluationReceipt,
} from './funded-entry.test-support'
import {
  readSequentialInferenceCostEvidence,
  retainedFundedQuestionPolicyHash,
} from './sequential-inference-cost-evidence'
import { decodeChartCheckpoint, makeChartDispatchClaim, makeChartTerminalReceipt } from './chart-checkpoint'
import { makeJevResolution, JevResolutionStatus } from './resolution'

test('funded v25 history keeps two-stage identities and checkpoint quotes after the staged cutover', () => {
  expect(retainedFundedQuestionPolicyHash).toBe('7be14891e60d6e276aca0ac72ddd7102afe8193c9b6d1cdfd57da885e0078399')
  const request = entryEvaluationRequestFixture()
  expect(request.schemaVersion).toBe('bayn.jev-evaluation-request.v2')
  expect(request.request.schemaVersion).toBe('bayn.entry-inference-input.v4')
  expect(request.request.protocol.schemaVersion).toBe('bayn.jev.protocol.v25')
  expect(request.request.protocol.entryQuestionPolicyHash).toBe(retainedFundedQuestionPolicyHash)
  expect(Result.isFailure(decodeJevEvaluationRequest(request))).toBe(true)
  const completion = entryCompletionFixture(request)
  expect(completion.handoff.schemaVersion).toBe('bayn.entry-handoff.v3')
  expect('baseStart' in completion.handoff).toBe(false)
  const receipt = Result.getOrThrow(
    makeFundedEvaluationReceipt(request, {
      startedAt: request.observedAt,
      completedAt: completion.completedAt,
      outcome: { status: 'COMPLETED', completion },
    }),
  )
  expect(receipt.schemaVersion).toBe('bayn.jev-evaluation-receipt.v2')
  const resolution = Result.getOrThrow(
    makeJevResolution(request, receipt, {
      schemaVersion: 'bayn.jev-evaluation-resolution.v1',
      requestId: request.requestId,
      status: JevResolutionStatus.Recorded,
      receiptHash: receipt.receiptHash,
    }),
  )
  const graph = Result.getOrThrow(
    readSequentialInferenceCostEvidence({ request, receipt, resolution, handoff: completion.handoff }),
  )
  const claim = Result.getOrThrow(
    makeChartDispatchClaim({
      schemaVersion: 'bayn.chart-dispatch-claim.v1',
      stage: 'CHART',
      requestId: request.requestId,
      providerRequestHash: graph.chartRequest.requestHash,
      claimedAt: request.observedAt,
      expiresAt: request.expiresAt,
    }),
  )
  const terminal = Result.getOrThrow(
    makeChartTerminalReceipt({
      schemaVersion: 'bayn.chart-terminal-receipt.v1',
      requestId: request.requestId,
      claimHash: claim.claimHash,
      recordedAt: completion.handoff.recordedAt,
      outcome: { status: 'RECEIVED', inference: completion.handoff.disposition.visual },
    }),
  )
  const checkpoint = { claim, terminal }
  expect(Result.getOrThrow(decodeChartCheckpoint(request, checkpoint))).toEqual(checkpoint)
  const source = {
    accountId: 'funded-history',
    sessionDate: '2026-10-25' as const,
    asOf: request.expiresAt,
    requestId: request.requestId,
    cycleId: request.cycleId,
    authorityGenerationHash: request.authorityGenerationHash,
    request,
    receipt,
    resolution,
    handoff: completion.handoff,
    chartCheckpoint: checkpoint,
  }
  const quotes = Result.getOrThrow(makeInferenceExpenseQuotes(source, inferenceExpenseRateCard))
  expect(quotes).toHaveLength(2)
  expect(quotes.map((quote) => ('stage' in quote.line ? quote.line.stage : null)).sort()).toEqual([
    InferenceStage.Chart,
    InferenceStage.Jev,
  ])
  expect(quotes.find((quote) => 'stage' in quote.line && quote.line.stage === 'CHART')?.schemaVersion).toBe(
    'bayn.inference-expense-quote.v3',
  )
  expect(Result.getOrThrow(buildInferenceExpensePlan(quotes)).transfers).toHaveLength(2)
  for (const quote of quotes) expect(Result.getOrThrow(verifyInferenceExpenseQuote(source, quote))).toEqual(quote)
  const { claimHash: _, ...wrongClaim } = { ...claim, providerRequestHash: 'f'.repeat(64) }
  expect(
    Result.isFailure(
      decodeChartCheckpoint(request, {
        claim: { ...wrongClaim, claimHash: Result.getOrThrow(canonicalHashV1Result(wrongClaim)) },
        terminal,
      }),
    ),
  ).toBe(true)
  const { requestId: _id, ...wrongRequest } = {
    ...request,
    request: { ...request.request, protocol: { ...request.request.protocol, schemaVersion: 'bayn.jev.protocol.v26' } },
  }
  expect(
    Result.isFailure(
      readSequentialInferenceCostEvidence({
        request: { ...wrongRequest, requestId: Result.getOrThrow(canonicalHashV1Result(wrongRequest)) },
        receipt: null,
        handoff: null,
        resolution: null,
      }),
    ),
  ).toBe(true)
})
