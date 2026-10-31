import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result, stableU128 } from '../hash'
import { decodeInferenceCostEvidence, InferenceUsageStatus } from '../inference-costs'
import {
  buildInferenceExpensePlan,
  inferenceExpenseRateCard,
  makeInferenceExpenseQuotes,
  verifyInferenceExpenseQuote,
} from '../inference-expense'
import { summarizeForwardInferenceExpenses } from '../forward-performance/inference-expenses'
import { makeNativeChartEvidence } from './chart-evidence'
import { decodeDecisionsResponse, type DecisionsRequest } from './decisions'
import { deriveEntryHandoffDisposition } from './entry-inference'
import { entryEvaluationRequestFixture } from './entry-inference.test-support'
import { prepareEntryInferenceInput } from './entry-inference-input'
import { makeJevEvaluationRequest, makeJevEvaluationReceipt, JevOutcome } from './evidence'
import { JevResolutionStatus, makeJevResolution } from './resolution'
import { makeInitialChartStageRequest, makeSelectedBaseStartStageRequest } from './staged-chart-questions'
import { makeStagedDispatchClaim, makeStagedTerminalReceipt, stageResponseIdentity } from './staged-checkpoint'

const fixture = () => {
  const original = entryEvaluationRequestFixture()
  const bars = [
    { minuteBeforeWindowEnd: 4, open: 99.4, high: 100, low: 99, close: 99.8, volume: 100 },
    { minuteBeforeWindowEnd: 3, open: 100.1, high: 100.4, low: 100, close: 100.3, volume: 100 },
    { minuteBeforeWindowEnd: 2, open: 100.3, high: 100.4, low: 100, close: 100.2, volume: 100 },
    { minuteBeforeWindowEnd: 1, open: 100.4, high: 100.405, low: 100.395, close: 100.4, volume: 100 },
  ]
  const symbol = 'ETH/USD'
  const prepared = Result.getOrThrow(
    prepareEntryInferenceInput({
      ...original.request,
      numericalState: {
        ...original.request.numericalState,
        candidate: { symbol, bars1m: bars },
      },
      chartSource: { ...original.request.chartSource, symbol, bars },
      funding: { bidMicros: '100410000', askMicros: '100420000', capitalMicros: '100000000000', cryptoFeeTier: 4 },
    }),
  )
  const { requestId: _, ...material } = original
  const request = Result.getOrThrow(
    makeJevEvaluationRequest({
      ...material,
      symbol,
      request: prepared.input,
      requestHash: prepared.requestHash,
    }),
  )
  const chart = Result.getOrThrow(makeNativeChartEvidence(request.request.chartSource))
  const context = { chart, protocol: request.request.protocol, funding: request.request.funding }
  const initial = Result.getOrThrow(makeInitialChartStageRequest(context))
  expect(initial.sourceFeasible).toBe(true)
  const first = chart.bars[1]
  const last = chart.bars[2]
  if (first === undefined || last === undefined) throw new Error('Expected narrow observed base')
  const inference = (provider: { request: DecisionsRequest; requestHash: string }) => {
    const response = Result.getOrThrow(
      decodeDecisionsResponse(provider.request, {
        model: provider.request.model,
        answers: provider.request.questions.map((question) => {
          if (question.type === 'predicate')
            return {
              type: 'predicate',
              name: question.name,
              probability: question.name.includes('base') ? 1 : 0,
            }
          const choice =
            question.name === 'base_last_bar'
              ? last.id
              : question.name.startsWith('base_first_bar')
                ? first.id
                : question.choices.find((item) => !chart.bars.some((bar) => bar.id === item.value))?.value
          if (choice === undefined) throw new Error('Expected explicit absent anchor')
          return {
            type: 'choice',
            name: question.name,
            choice,
            confidence: 1,
            probabilities: question.choices.map((item) => ({
              value: item.value,
              probability: item.value === choice ? 1 : 0,
            })),
          }
        }),
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens: 10,
          total_tokens: 110,
        },
      }),
    )
    return {
      requestHash: provider.requestHash,
      responseHash: Result.getOrThrow(canonicalHashV1Result(response)),
      response,
      startedAt: request.observedAt,
      completedAt: request.observedAt,
    }
  }
  const visual = inference(initial)
  const next = Result.getOrThrow(makeSelectedBaseStartStageRequest(context, stageResponseIdentity(visual)))
  if (next.status !== 'PREPARED') throw new Error('Expected paid base-start stage')
  const base = inference(next)
  const chartClaim = Result.getOrThrow(
    makeStagedDispatchClaim({
      schemaVersion: 'bayn.staged-dispatch-claim.v1',
      stage: 'CHART',
      requestId: request.requestId,
      providerRequestHash: initial.requestHash,
      predecessorHash: null,
      selectedEnd: null,
      claimedAt: request.observedAt,
      expiresAt: request.expiresAt,
    }),
  )
  const chartTerminal = Result.getOrThrow(
    makeStagedTerminalReceipt({
      schemaVersion: 'bayn.staged-terminal-receipt.v1',
      stage: 'CHART',
      requestId: request.requestId,
      claimHash: chartClaim.claimHash,
      recordedAt: request.observedAt,
      outcome: { status: 'RECEIVED', inference: visual },
    }),
  )
  const baseClaim = Result.getOrThrow(
    makeStagedDispatchClaim({
      schemaVersion: 'bayn.staged-dispatch-claim.v1',
      stage: 'BASE_START',
      requestId: request.requestId,
      providerRequestHash: next.requestHash,
      predecessorHash: chartTerminal.terminalHash,
      selectedEnd: next.selectedEnd,
      claimedAt: request.observedAt,
      expiresAt: request.expiresAt,
    }),
  )
  const baseTerminal = Result.getOrThrow(
    makeStagedTerminalReceipt({
      schemaVersion: 'bayn.staged-terminal-receipt.v1',
      stage: 'BASE_START',
      requestId: request.requestId,
      claimHash: baseClaim.claimHash,
      recordedAt: request.observedAt,
      outcome: { status: 'RECEIVED', inference: base },
    }),
  )
  const disposition = Result.getOrThrow(deriveEntryHandoffDisposition(request.request, visual, base))
  expect(disposition.status).toBe('NO_FUNDED_PROPOSALS')
  expect(disposition.evaluation.proposals).toHaveLength(0)
  const handoffMaterial = {
    schemaVersion: 'bayn.entry-handoff.v4' as const,
    requestId: request.requestId,
    inputHash: request.requestHash,
    visualRequestHash: initial.requestHash,
    recordedAt: request.observedAt,
    disposition,
    baseStart: { status: 'RECEIVED' as const, inference: base },
  }
  const handoff = { ...handoffMaterial, handoffHash: Result.getOrThrow(canonicalHashV1Result(handoffMaterial)) }
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
  const resolution = Result.getOrThrow(
    makeJevResolution(request, receipt, {
      schemaVersion: 'bayn.jev-evaluation-resolution.v1',
      requestId: request.requestId,
      status: JevResolutionStatus.Recorded,
      receiptHash: receipt.receiptHash,
    }),
  )
  const source = {
    accountId: 'unfunded-cost-test',
    sessionDate: '2026-10-25' as const,
    asOf: request.expiresAt,
    requestId: request.requestId,
    cycleId: request.cycleId,
    authorityGenerationHash: request.authorityGenerationHash,
    request,
    receipt,
    resolution,
    handoff,
    stagedCheckpoint: { claims: [chartClaim, baseClaim], terminals: [chartTerminal, baseTerminal], skips: [] },
  }
  const { accountId, sessionDate, asOf, ...row } = source
  const evidence = Result.getOrThrow(
    decodeInferenceCostEvidence({
      schemaVersion: 'bayn.inference-cost-evidence.v4',
      accountBindingHash: Result.getOrThrow(
        canonicalHashV1Result({ schemaVersion: 'bayn.inference-cost-account.v1', accountId }),
      ),
      sessionDate,
      asOf,
      requests: [row],
    }),
  )
  return { source, evidence }
}

test('v35 unfunded selection retains both paid stages exactly once without charging JEV', () => {
  const { source, evidence } = fixture()
  const quotes = Result.getOrThrow(makeInferenceExpenseQuotes(source, inferenceExpenseRateCard))
  expect(quotes).toHaveLength(3)
  const paid = quotes.filter((quote) => 'stage' in quote.line && quote.line.stage !== 'JEV')
  expect(paid).toHaveLength(2)
  for (const quote of paid) {
    expect(quote.line.usageStatus).toBe(InferenceUsageStatus.Received)
    // 100 uncached input tokens at 100,000 micro-USD/million; output is free in the frozen tariff.
    expect(quote.line.estimatedCostPicoUsd).toBe('10000000')
  }
  const jev = quotes.find((quote) => 'stage' in quote.line && quote.line.stage === 'JEV')
  expect(jev?.line.usageStatus).toBe(InferenceUsageStatus.NotDispatched)
  expect(jev?.line.estimatedCostPicoUsd).toBe('0')
  expect(jev?.rate).toBeNull()
  for (const quote of quotes) expect(Result.getOrThrow(verifyInferenceExpenseQuote(source, quote))).toEqual(quote)
  const plan = Result.getOrThrow(buildInferenceExpensePlan([...quotes, ...quotes]))
  expect(plan.transfers).toHaveLength(2)
  expect(new Set(plan.transfers.map((transfer) => transfer.id))).toEqual(
    new Set([
      stableU128(`bayn.inference-expense.transfer.v2:${evidence.accountBindingHash}:${source.requestId}:CHART`),
      stableU128(`bayn.inference-expense.transfer.v3:${evidence.accountBindingHash}:${source.requestId}:BASE_START`),
    ]),
  )
  const total = 20000000n
  expect(plan.transfers.reduce((sum, transfer) => sum + transfer.amount, 0n)).toBe(total)
  const frozen = quotes.map((quote) => ({ quote, verifiedAt: source.asOf }))
  const summary = Result.getOrThrow(summarizeForwardInferenceExpenses(evidence, source.accountId, frozen))
  expect(summary).toMatchObject({
    knownEstimatedCostPicoUsd: total.toString(),
    completeMeteredCoverage: true,
    missingQuoteCount: 0,
    unverifiedRequestCount: 0,
    invoiceReconciled: false,
  })
  const missing = frozen.filter(({ quote }) => !('stage' in quote.line) || quote.line.stage !== 'BASE_START')
  expect(Result.getOrThrow(summarizeForwardInferenceExpenses(evidence, source.accountId, missing))).toMatchObject({
    missingQuoteCount: 1,
    completeMeteredCoverage: false,
    invoiceReconciled: false,
  })
  const unverified = frozen.map((row) =>
    'stage' in row.quote.line && row.quote.line.stage === 'CHART' ? { ...row, verifiedAt: null } : row,
  )
  expect(Result.getOrThrow(summarizeForwardInferenceExpenses(evidence, source.accountId, unverified))).toMatchObject({
    unverifiedRequestCount: 1,
    completeMeteredCoverage: false,
    invoiceReconciled: false,
  })
})
