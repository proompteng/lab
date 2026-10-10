import { expect, test } from 'bun:test'
import type { PgClient } from '@effect/sql-pg'
import { Effect, Result } from 'effect'

import { makeInferenceExpenseQuote } from '../inference-expense'
import { expenseRateFixture, expenseSourceFixture } from '../inference-expense.test-support'
import { readForwardInferenceExpenses, summarizeForwardInferenceExpenses } from './inference-expenses'

const first = expenseSourceFixture({ authorityGenerationHash: '1'.repeat(64), inputTokens: 3 })
const second = expenseSourceFixture({ key: 'b', authorityGenerationHash: '2'.repeat(64), inputTokens: 7 })
const gap = expenseSourceFixture({ key: 'c', authorityGenerationHash: '1'.repeat(64), missing: true })
const sources = [first, second, gap]
const frozen = sources.map((source) => ({
  quote: Result.getOrThrow(makeInferenceExpenseQuote(source, expenseRateFixture)),
  verifiedAt: source.asOf,
}))
const evidence = {
  schemaVersion: 'bayn.inference-cost-evidence.v1' as const,
  accountBindingHash: frozen[0]?.quote.accountBindingHash ?? '',
  sessionDate: first.sessionDate,
  asOf: first.asOf,
  requests: sources.map(({ requestId, cycleId, authorityGenerationHash, request, receipt, resolution }) => ({
    requestId,
    cycleId,
    authorityGenerationHash,
    request,
    receipt,
    resolution,
  })),
}

test('attributes verified inference estimates only to the requested generation and retains unknown usage', () => {
  const result = Result.getOrThrow(
    summarizeForwardInferenceExpenses(evidence, first.accountId, frozen, first.authorityGenerationHash),
  )
  expect(result).toMatchObject({
    claimedRequestCount: 2,
    knownEstimatedCostPicoUsd: '126000',
    gapRequestCount: 1,
    completeMeteredCoverage: false,
    invoiceReconciled: false,
  })
  expect(
    Result.getOrThrow(
      summarizeForwardInferenceExpenses(evidence, first.accountId, frozen, second.authorityGenerationHash),
    ),
  ).toMatchObject({ claimedRequestCount: 1, knownEstimatedCostPicoUsd: '294000', completeMeteredCoverage: true })
  expect(Result.getOrThrow(summarizeForwardInferenceExpenses(evidence, first.accountId, frozen))).toMatchObject({
    claimedRequestCount: 3,
    knownEstimatedCostPicoUsd: '420000',
  })
})

test('retains missing and unverified quotes without inventing a charge or complete cost coverage', () => {
  expect(
    Result.getOrThrow(
      summarizeForwardInferenceExpenses(evidence, first.accountId, frozen.slice(1), first.authorityGenerationHash),
    ),
  ).toMatchObject({ knownEstimatedCostPicoUsd: '0', missingQuoteCount: 1, completeMeteredCoverage: false })
  expect(
    Result.getOrThrow(
      summarizeForwardInferenceExpenses(
        evidence,
        first.accountId,
        frozen.map((row) => ({ ...row, verifiedAt: null })),
        second.authorityGenerationHash,
      ),
    ),
  ).toMatchObject({ knownEstimatedCostPicoUsd: '294000', unverifiedRequestCount: 1, completeMeteredCoverage: false })
})

test('rejects foreign account and conflicting coverage instead of summing it', () => {
  expect(Result.isFailure(summarizeForwardInferenceExpenses(evidence, 'foreign-account', frozen))).toBe(true)
  expect(Result.isFailure(summarizeForwardInferenceExpenses(evidence, first.accountId, [...frozen, ...frozen]))).toBe(
    true,
  )
})

test('retains the original expense read failure for diagnostics', async () => {
  const cause = new Error('synthetic database unavailable')
  const sql = (() => Effect.fail(cause)) as unknown as PgClient.PgClient
  const result = await Effect.runPromise(
    Effect.scoped(
      readForwardInferenceExpenses(
        {
          operationTimeoutMs: 1000,
          tigerBeetle: { clusterId: 1n, replicaAddresses: ['127.0.0.1:3000'], ledger: 7001 },
        },
        sql,
        first.accountId,
      ).pipe(Effect.result),
    ),
  )
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) {
    expect(result.failure._tag).toBe('InferenceCostError')
    expect(result.failure.cause).toBe(cause)
  }
})
