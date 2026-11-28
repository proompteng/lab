import { expect, test } from 'bun:test'
import { decodeInferenceCostEvidence, decodeInferenceCostRequest, InferenceCostError } from '../inference-costs'
import type { PgClient } from '@effect/sql-pg'
import { Effect, Result } from 'effect'

import {
  InferenceExpenseCoverageIssue,
  makeInferenceExpenseQuote,
  verifyInferenceExpenseCoverage,
} from '../inference-expense'
import { expenseRateFixture, expenseSourceFixture } from '../inference-expense.test-support'
import {
  readForwardInferenceExpenseSnapshots,
  readForwardInferenceExpenseSummary,
  summarizeForwardInferenceExpenses,
  type ForwardInferenceExpenseSession,
} from './inference-expenses'
import { makeReportVerification, ReportVerification } from './verification'

const summarizeFromEvidence = (
  evidence: unknown,
  accountId: string,
  frozen: Parameters<typeof summarizeForwardInferenceExpenses>[2],
  generationHash?: string,
) =>
  decodeInferenceCostEvidence(evidence).pipe(
    Result.flatMap((decoded) => summarizeForwardInferenceExpenses(decoded, accountId, frozen, generationHash)),
  )

const first = expenseSourceFixture({ authorityGenerationHash: '1'.repeat(64), inputTokens: 3 })
const second = expenseSourceFixture({ key: 'b', authorityGenerationHash: '2'.repeat(64), inputTokens: 7 })
const gap = expenseSourceFixture({ key: 'c', authorityGenerationHash: '1'.repeat(64), missing: true })
const sources = [first, second, gap]
const frozen = sources.map((source) => ({
  quote: Result.getOrThrow(makeInferenceExpenseQuote(source, expenseRateFixture)),
  verifiedAt: source.asOf,
}))
const evidence = {
  schemaVersion: 'bayn.inference-cost-evidence.v2' as const,
  accountBindingHash: frozen[0]?.quote.accountBindingHash ?? '',
  sessionDate: first.sessionDate,
  asOf: first.asOf,
  requests: sources.map(({ requestId, cycleId, authorityGenerationHash, request, receipt, resolution, handoff }) => ({
    requestId,
    cycleId,
    authorityGenerationHash,
    request,
    receipt,
    resolution,
    handoff,
  })),
}

test('attributes verified inference estimates only to the requested generation and retains unknown usage', () => {
  const result: Omit<
    ForwardInferenceExpenseSession,
    'exactSessionLedger' | 'ledgerTimestampMax' | 'verifiedSessionTransferCount'
  > = Result.getOrThrow(summarizeFromEvidence(evidence, first.accountId, frozen, first.authorityGenerationHash))
  expect(result.sourceAsOf).toBe(evidence.asOf)
  expect(result.requestsWithCoverageIssues).toMatchObject([
    { requestId: gap.requestId, stage: 'JEV', issues: [InferenceExpenseCoverageIssue.UnknownUsage] },
  ])
  expect(result.matchedQuoteHashes).toEqual([frozen[0]?.quote.quoteHash, frozen[2]?.quote.quoteHash].sort())
  expect(JSON.stringify(result)).not.toContain(first.accountId)
  expect(result).toMatchObject({
    claimedRequestCount: 2,
    knownEstimatedCostPicoUsd: '126000',
    gapRequestCount: 1,
    completeMeteredCoverage: false,
    invoiceReconciled: false,
  })
  expect(
    Result.getOrThrow(summarizeFromEvidence(evidence, first.accountId, frozen, second.authorityGenerationHash)),
  ).toMatchObject({ claimedRequestCount: 1, knownEstimatedCostPicoUsd: '294000', completeMeteredCoverage: true })
  expect(Result.getOrThrow(summarizeFromEvidence(evidence, first.accountId, frozen))).toMatchObject({
    claimedRequestCount: 3,
    knownEstimatedCostPicoUsd: '420000',
  })
})

test('retains missing and unverified quotes without inventing a charge or complete cost coverage', () => {
  expect(
    Result.getOrThrow(summarizeFromEvidence(evidence, first.accountId, frozen.slice(1), first.authorityGenerationHash)),
  ).toMatchObject({ knownEstimatedCostPicoUsd: '0', missingQuoteCount: 1, completeMeteredCoverage: false })
  expect(
    Result.getOrThrow(
      summarizeFromEvidence(
        evidence,
        first.accountId,
        frozen.map((row) => ({ ...row, verifiedAt: null })),
        second.authorityGenerationHash,
      ),
    ),
  ).toMatchObject({ knownEstimatedCostPicoUsd: '294000', unverifiedRequestCount: 1, completeMeteredCoverage: false })
})

test('rejects foreign account and conflicting coverage instead of summing it', () => {
  expect(Result.isFailure(summarizeFromEvidence(evidence, 'foreign-account', frozen))).toBe(true)
  expect(Result.isFailure(summarizeFromEvidence(evidence, first.accountId, [...frozen, ...frozen]))).toBe(true)
})

test('retains exact missing quote sources without exposing the provider request or response', () => {
  const result = Result.getOrThrow(
    summarizeFromEvidence(evidence, first.accountId, frozen.slice(1), first.authorityGenerationHash),
  )
  expect(result.requestsWithCoverageIssues).toMatchObject([
    { requestId: gap.requestId, receiptHash: null, issues: ['UNKNOWN_USAGE'] },
    { requestId: first.requestId, receiptHash: first.receipt?.receiptHash, issues: ['MISSING_FROZEN_QUOTE'] },
  ])
  expect(JSON.stringify(result)).not.toContain('rejectedResponse')
  expect(JSON.stringify(result)).not.toContain('requestHash')
  expect(JSON.stringify(result)).not.toContain(first.accountId)
})

test('validates other generations in the same session before attributing selected expenses', () => {
  const tampered = frozen.map((row) =>
    row.quote.line.requestId === second.requestId
      ? { ...row, quote: { ...row.quote, quoteHash: '0'.repeat(64) } }
      : row,
  )
  expect(
    Result.isFailure(summarizeFromEvidence(evidence, first.accountId, tampered, first.authorityGenerationHash)),
  ).toBe(true)
  const conflicting = frozen.flatMap((row) => (row.quote.line.requestId === second.requestId ? [row, row] : [row]))
  expect(
    Result.isFailure(summarizeFromEvidence(evidence, first.accountId, conflicting, first.authorityGenerationHash)),
  ).toBe(true)
})

test('retains the original expense read failure for diagnostics', async () => {
  const cause = new Error('synthetic database unavailable')
  const sql = (() => Effect.fail(cause)) as unknown as PgClient.PgClient
  const result = await Effect.runPromise(
    Effect.scoped(readForwardInferenceExpenseSnapshots(sql, first.accountId).pipe(Effect.result)),
  )
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) {
    expect(result.failure._tag).toBe('InferenceCostError')
    expect(result.failure.cause).toBe(cause)
  }
})

test('partitioned coverage exactly matches the complete cut, retaining duplicates, gaps and generation scope', async () => {
  const decoded = Result.getOrThrow(decodeInferenceCostEvidence(evidence))
  const inputs = [decoded, { ...decoded, requests: [...decoded.requests, ...decoded.requests] }]
  for (const input of inputs)
    for (const generation of [undefined, first.authorityGenerationHash, second.authorityGenerationHash])
      for (const quotes of [frozen, frozen.slice(1), frozen.map((row) => ({ ...row, verifiedAt: null }))]) {
        const actual = await runPartitioned(input, first.accountId, quotes, generation)
        expect(actual).toEqual(summarizeForwardInferenceExpenses(input, first.accountId, quotes, generation))
      }
})

const runPartitioned = (
  input: Parameters<typeof readForwardInferenceExpenseSummary>[0],
  accountId: string,
  quotes: Parameters<typeof summarizeForwardInferenceExpenses>[2],
  generation?: string,
) =>
  Effect.runPromise(
    readForwardInferenceExpenseSummary(input, accountId, quotes, generation).pipe(
      Effect.provideService(ReportVerification, {
        volume: () => Effect.die('unexpected volume'),
        volumeRequest: () => Effect.die('unexpected volume request'),
        decision: () => Effect.die('unexpected decision job'),
        alphaDecision: () => Effect.die('unexpected alpha decision job'),
        inference: () => Effect.die('unexpected inference job'),
        coverage: (part) =>
          Effect.fromResult(
            verifyInferenceExpenseCoverage(part.evidence, part.accountId, part.frozen, part.authorityGenerationHash),
          ).pipe(
            Effect.mapError((cause) =>
              cause instanceof InferenceCostError
                ? cause
                : new InferenceCostError({ message: 'Inference expense coverage verification failed', cause }),
            ),
          ),
      }),
      Effect.result,
    ),
  )

test('partitioned coverage rejects foreign, orphan, conflicting and tampered evidence across the whole session', async () => {
  const decoded = Result.getOrThrow(decodeInferenceCostEvidence(evidence))
  const cases = [
    { input: decoded, accountId: 'foreign-account', quotes: frozen },
    { input: { ...decoded, requests: [] }, accountId: first.accountId, quotes: frozen },
    { input: decoded, accountId: first.accountId, quotes: [...frozen, ...frozen] },
    {
      input: decoded,
      accountId: first.accountId,
      quotes: frozen.map((row) =>
        row.quote.line.requestId === second.requestId
          ? { ...row, quote: { ...row.quote, quoteHash: '0'.repeat(64) } }
          : row,
      ),
    },
    {
      input: {
        ...decoded,
        requests: [...decoded.requests, { ...decoded.requests[0]!, sourceFingerprint: '0'.repeat(64) }],
      },
      accountId: first.accountId,
      quotes: frozen,
    },
  ]
  for (const { input, accountId, quotes } of cases) {
    const actual = await runPartitioned(input, accountId, quotes, first.authorityGenerationHash)
    const expected = summarizeForwardInferenceExpenses(input, accountId, quotes, first.authorityGenerationHash)
    expect(actual).toMatchObject({
      _tag: 'Failure',
      failure: {
        message:
          Result.isFailure(expected) &&
          (expected.failure instanceof InferenceCostError
            ? expected.failure.message
            : 'Inference expense coverage verification failed'),
      },
    })
    expect(Result.isFailure(actual)).toBe(true)
  }
  expect(await runPartitioned({ ...decoded, requests: [] }, 'foreign-account', [])).toMatchObject({ _tag: 'Failure' })
})

test('native inference workers retain decoded source values, coverage and typed financial failures', async () => {
  const decoded = Result.getOrThrow(decodeInferenceCostEvidence(evidence))
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const verifier = yield* makeReportVerification()
        const request = yield* verifier.inference(evidence.requests[0], evidence.asOf)
        expect(request).toEqual(Result.getOrThrow(decodeInferenceCostRequest(evidence.requests[0], evidence.asOf)))
        const coverage = yield* verifier.coverage({ evidence: decoded, accountId: first.accountId, frozen })
        expect(coverage).toEqual(Result.getOrThrow(verifyInferenceExpenseCoverage(decoded, first.accountId, frozen)))
        const foreign = yield* verifier
          .coverage({ evidence: decoded, accountId: 'foreign-account', frozen })
          .pipe(Effect.result)
        expect(foreign).toMatchObject({
          _tag: 'Failure',
          failure: {
            _tag: 'InferenceCostError',
            message: 'Inference expense coverage account differs from the request cut',
          },
        })
      }),
    ),
  )
}, 15_000)
