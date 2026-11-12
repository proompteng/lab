import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { decodeInferenceCostEvidence, InferenceStage } from '../inference-costs'
import { summarizeForwardInferenceExpenses } from '../forward-performance/inference-expenses'
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
      outcome: {
        status: 'RECEIVED',
        inference: {
          ...completion.handoff.disposition.visual,
          response: (() => {
            const response = completion.handoff.disposition.visual.response
            if (response.model !== 'gpt-6-luna') throw new Error('Expected retained Decisions receipt')
            return response
          })(),
        },
      },
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
  const { chartCheckpoint: _checkpoint, ...priorSource } = source
  const priorChartQuote = Result.getOrThrow(makeInferenceExpenseQuotes(priorSource, inferenceExpenseRateCard)).find(
    (quote) => 'stage' in quote.line && quote.line.stage === InferenceStage.Chart,
  )
  if (priorChartQuote === undefined) throw new Error('Expected a retained pre-checkpoint chart quote')
  expect(priorChartQuote.schemaVersion).toBe('bayn.inference-expense-quote.v2')
  expect(BigInt(priorChartQuote.line.estimatedCostPicoUsd ?? '0')).toBeGreaterThan(0n)
  const { accountId, sessionDate, asOf, ...row } = source
  const evidence = Result.getOrThrow(
    decodeInferenceCostEvidence({
      schemaVersion: 'bayn.inference-cost-evidence.v3',
      accountBindingHash: priorChartQuote.accountBindingHash,
      sessionDate,
      asOf,
      requests: [row],
    }),
  )
  const frozen = [...quotes, priorChartQuote].map((quote) => ({ quote, verifiedAt: asOf }))
  const summary = Result.getOrThrow(summarizeForwardInferenceExpenses(evidence, accountId, frozen))
  expect(summary.completeMeteredCoverage).toBe(true)
  expect(summary.matchedQuoteHashes).toEqual(quotes.map((quote) => quote.quoteHash).sort())
  expect(summary.matchedQuoteHashes).not.toContain(priorChartQuote.quoteHash)
  expect(summary.requestsWithCoverageIssues).toEqual([])
  expect(summary.knownEstimatedCostPicoUsd).toBe(
    quotes.reduce((total, quote) => total + BigInt(quote.line.estimatedCostPicoUsd ?? '0'), 0n).toString(),
  )
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
    request: {
      ...request.request,
      protocol: {
        ...request.request.protocol,
        schemaVersion: 'bayn.jev.protocol.v26',
        entrySignalPolicy: 'openai-decisions-then-jev' as const,
      },
    },
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
