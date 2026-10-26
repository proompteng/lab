import { costReportFromEvidence } from './inference-expense.test-support'
import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from './hash'
import {
  InferenceCostCoverage,
  InferenceStage,
  InferenceUsageStatus,
  decodeInferenceCostEvidence,
  makeInferenceCostReport,
} from './inference-costs'
import {
  buildInferenceExpensePlan,
  decodeInferenceExpenseQuote,
  inferenceExpenseRateCard,
  makeInferenceExpenseQuote,
  makeInferenceExpenseQuotes,
  verifyInferenceExpenseCoverage,
  verifyInferenceExpenseQuote,
  type InferenceExpenseSource,
} from './inference-expense'
import { JevFailure } from './jev/contract'
import { JevOutcome, makeJevEvaluationReceipt } from './jev/evidence'
import { type EntryInferenceCompletion, type EntryHandoff } from './jev/entry-inference'
import { entryCompletionFixture, entryEvaluationRequestFixture } from './jev/entry-inference.test-support'
import { JevResolutionStatus, makeJevResolution } from './jev/resolution'
import { summarizeForwardInferenceExpenses } from './forward-performance/inference-expenses'

const request = entryEvaluationRequestFixture()
const completion = entryCompletionFixture(request)
const source = (
  completed: EntryInferenceCompletion | null = completion,
  handoff = completed?.handoff ?? completion.handoff,
  abandoned = completed === null,
): InferenceExpenseSource => {
  const receipt =
    completed === null
      ? null
      : Result.getOrThrow(
          makeJevEvaluationReceipt(request, {
            schemaVersion: 'bayn.jev-evaluation-receipt.v2',
            requestId: request.requestId,
            startedAt: request.observedAt,
            completedAt: completed.completedAt,
            outcome: { status: JevOutcome.Completed, completion: completed },
          }),
        )
  const resolution = Result.getOrThrow(
    makeJevResolution(
      request,
      receipt,
      abandoned
        ? {
            schemaVersion: 'bayn.jev-evaluation-resolution.v1',
            requestId: request.requestId,
            status: JevResolutionStatus.Abandoned,
            abandonedAt: request.expiresAt,
          }
        : {
            schemaVersion: 'bayn.jev-evaluation-resolution.v1',
            requestId: request.requestId,
            status: JevResolutionStatus.Recorded,
            receiptHash: receipt?.receiptHash,
          },
    ),
  )
  return {
    accountId: 'stage-cost-fixture',
    sessionDate: '2026-10-25',
    asOf: '2026-10-25T07:01:00.000Z',
    requestId: request.requestId,
    cycleId: request.cycleId,
    authorityGenerationHash: request.authorityGenerationHash,
    request,
    receipt,
    resolution,
    handoff,
  }
}
const evidence = (value: InferenceExpenseSource) => ({
  schemaVersion: 'bayn.inference-cost-evidence.v2' as const,
  accountBindingHash: Result.getOrThrow(
    canonicalHashV1Result({ schemaVersion: 'bayn.inference-cost-account.v1', accountId: value.accountId }),
  ),
  sessionDate: value.sessionDate,
  asOf: value.asOf,
  requests: [
    {
      requestId: value.requestId,
      cycleId: value.cycleId,
      authorityGenerationHash: value.authorityGenerationHash,
      request: value.request,
      receipt: value.receipt,
      resolution: value.resolution,
      handoff: value.handoff,
    },
  ],
})
const report = (value: InferenceExpenseSource) =>
  Result.getOrThrow(costReportFromEvidence(evidence(value), inferenceExpenseRateCard))
const sealHandoff = (disposition: EntryHandoff['disposition']): EntryHandoff => {
  const { handoffHash: _, ...material } = { ...completion.handoff, disposition }
  return { ...material, handoffHash: Result.getOrThrow(canonicalHashV1Result(material)) }
}

test('prices both providers and posts separate deterministic expenses for one parent request', () => {
  const value = source()
  const result = report(value)
  expect(result.requestCount).toBe(1)
  expect(result.providerRequestCount).toBe(2)
  expect(result.knownEstimatedCostPicoUsd).toBe('18400000')
  expect(result.estimatedTotalCostMicros).toBe('19')
  const quotes = Result.getOrThrow(makeInferenceExpenseQuotes(value, inferenceExpenseRateCard))
  expect(quotes).toHaveLength(2)
  expect(Result.isFailure(makeInferenceExpenseQuote(value, inferenceExpenseRateCard))).toBe(true)
  for (const quote of quotes) expect(Result.isSuccess(verifyInferenceExpenseQuote(value, quote))).toBe(true)
  const plan = Result.getOrThrow(buildInferenceExpensePlan(quotes))
  expect(plan.transfers).toHaveLength(2)
  expect(new Set(plan.transfers.map((row) => row.id)).size).toBe(2)
  expect(plan.transfers.reduce((sum, row) => sum + row.amount, 0n)).toBe(18_400_000n)
  expect(result.invoiceReconciled).toBe(false)
})

test('retains known chart charges and explicit unknown Jev usage after a provider failure', () => {
  const value = source({
    ...completion,
    jev: { status: 'FAILED', failure: JevFailure.Transport, httpStatus: null, responseHash: null, usage: null },
  })
  const result = report(value)
  expect(result.coverage).toBe(InferenceCostCoverage.Incomplete)
  expect(result.unknownUsageCount).toBe(1)
  expect(result.knownEstimatedCostPicoUsd).toBe('10000000')
  expect(result.estimatedTotalCostMicros).toBeNull()
  const quotes = Result.getOrThrow(makeInferenceExpenseQuotes(value, inferenceExpenseRateCard))
  expect(Result.getOrThrow(buildInferenceExpensePlan(quotes)).transfers.map((row) => row.amount)).toEqual([10_000_000n])
})

test('prices a committed chart response after a crash without pretending Jev was undispatched', () => {
  const value = source(null)
  const result = report(value)
  expect(result.requests.find((line) => 'stage' in line && line.stage === InferenceStage.Jev)?.usageStatus).toBe(
    InferenceUsageStatus.Unknown,
  )
  expect(result.knownEstimatedCostPicoUsd).toBe('10000000')
  expect(result.estimatedTotalCostMicros).toBeNull()
  const quotes = Result.getOrThrow(makeInferenceExpenseQuotes(value, inferenceExpenseRateCard))
  for (const quote of quotes) expect(Result.isSuccess(verifyInferenceExpenseQuote(value, quote))).toBe(true)
})

test('subtracts cache reads and writes from total input before applying their own tariffs', () => {
  const disposition = completion.handoff.disposition
  if (disposition.status !== 'READY') throw new Error('Expected funded fixture')
  const response = {
    ...disposition.visual.response,
    usage: {
      ...disposition.visual.response.usage,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 },
    },
  }
  const visual = { ...disposition.visual, response, responseHash: Result.getOrThrow(canonicalHashV1Result(response)) }
  const handoff = sealHandoff({ ...disposition, visual })
  const value = source({ ...completion, handoff })
  const result = report(value)
  expect(
    result.requests.find((line) => 'stage' in line && line.stage === InferenceStage.Chart)?.estimatedCostPicoUsd,
  ).toBe('8950000')
  const quote = Result.getOrThrow(makeInferenceExpenseQuote(value, inferenceExpenseRateCard, InferenceStage.Chart))
  expect(Result.isSuccess(verifyInferenceExpenseQuote(value, quote))).toBe(true)
  const { quoteHash: _, ...changed } = { ...quote, line: { ...quote.line, cachedInputTokens: '101' } }
  expect(
    Result.isFailure(
      decodeInferenceExpenseQuote({ ...changed, quoteHash: Result.getOrThrow(canonicalHashV1Result(changed)) }),
    ),
  ).toBe(true)
})

test('accounts for a metered visual refusal while proving no dependent request was sent', () => {
  const handoff = sealHandoff({
    status: 'VISUAL_FAILED',
    failure: {
      category: 'STATUS',
      httpStatus: 429,
      responseHash: 'd'.repeat(64),
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 0,
        total_tokens: 100,
      },
    },
  })
  const value = source({ handoff, completedAt: completion.completedAt, jev: { status: 'NOT_REQUESTED' } })
  const result = report(value)
  expect(result.notDispatchedRequestCount).toBe(1)
  expect(result.rejectedResponseUsageCount).toBe(1)
  expect(result.estimatedTotalCostMicros).toBe('10')
  const quotes = Result.getOrThrow(makeInferenceExpenseQuotes(value, inferenceExpenseRateCard))
  for (const quote of quotes) expect(Result.isSuccess(verifyInferenceExpenseQuote(value, quote))).toBe(true)
  expect(Result.getOrThrow(buildInferenceExpensePlan(quotes)).transfers).toHaveLength(1)
})

test('uses a positive expiry receipt to record zero for both undispatched stages', () => {
  const value = source()
  const receipt = Result.getOrThrow(
    makeJevEvaluationReceipt(request, {
      schemaVersion: 'bayn.jev-evaluation-receipt.v2',
      requestId: request.requestId,
      startedAt: request.observedAt,
      completedAt: request.expiresAt,
      outcome: { status: JevOutcome.Failed, failure: JevFailure.NotDispatched },
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
  const result = report({ ...value, receipt, resolution, handoff: null })
  expect(result.notDispatchedRequestCount).toBe(2)
  expect(result.estimatedTotalCostMicros).toBe('0')
  expect(result.unknownUsageCount).toBe(0)
})

test('a late Jev receipt completes coverage without repricing or posting the chart twice', () => {
  const early = source(null)
  const late = source({ ...completion, completedAt: '2026-10-25T07:00:47.000Z' }, completion.handoff, true)
  const before = Result.getOrThrow(makeInferenceExpenseQuotes(early, inferenceExpenseRateCard))
  const after = Result.getOrThrow(makeInferenceExpenseQuotes(late, inferenceExpenseRateCard))
  const quotes = [...new Map([...before, ...after].map((quote) => [quote.quoteHash, quote])).values()]
  expect(quotes).toHaveLength(3)
  expect(Result.getOrThrow(buildInferenceExpensePlan(quotes)).transfers).toHaveLength(2)
  const frozen = quotes.map((quote) => ({ quote, verifiedAt: late.asOf }))
  const decoded = Result.getOrThrow(decodeInferenceCostEvidence(evidence(late)))
  expect(
    Result.getOrThrow(verifyInferenceExpenseCoverage(decoded, late.accountId, frozen)).completeMeteredCoverage,
  ).toBe(true)
  expect(
    Result.getOrThrow(summarizeForwardInferenceExpenses(decoded, late.accountId, frozen)).knownEstimatedCostPicoUsd,
  ).toBe('18400000')
})

test('reuses one decoded source cut for pricing and both frozen provider charges', () => {
  const value = structuredClone(source())
  const frozen = Result.getOrThrow(makeInferenceExpenseQuotes(value, inferenceExpenseRateCard)).map((quote) => ({
    quote,
    verifiedAt: value.asOf,
  }))
  const decoded = Result.getOrThrow(decodeInferenceCostEvidence(evidence(value)))
  const report = Result.getOrThrow(makeInferenceCostReport(decoded, inferenceExpenseRateCard))
  const requestPayload = value.request
  if (typeof requestPayload !== 'object' || requestPayload === null) throw new Error('Fixture request is not an object')
  Object.defineProperty(requestPayload, 'schemaVersion', {
    get: () => {
      throw new Error('Decoded cost facts must not reopen the source payload')
    },
  })
  expect(Result.getOrThrow(makeInferenceCostReport(decoded, inferenceExpenseRateCard))).toEqual(report)
  expect(
    Result.getOrThrow(verifyInferenceExpenseCoverage(decoded, value.accountId, frozen)).completeMeteredCoverage,
  ).toBe(true)
})

test('wire evidence cannot inject previously decoded cost facts', () => {
  const input = evidence(source())
  expect(
    Result.isFailure(
      decodeInferenceCostEvidence({
        ...input,
        requests: input.requests.map((row) => ({ ...row, sourceFingerprint: 'f'.repeat(64), stages: [] })),
      }),
    ),
  ).toBe(true)
})

test('refuses a completed cost graph with a missing committed handoff', () => {
  expect(
    Result.isFailure(costReportFromEvidence(evidence({ ...source(), handoff: null }), inferenceExpenseRateCard)),
  ).toBe(true)
})
