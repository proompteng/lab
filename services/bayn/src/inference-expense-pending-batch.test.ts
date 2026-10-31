import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from './hash'
import {
  inferenceExpenseBatchSize,
  inferenceExpenseRateCard,
  makeInferenceExpenseQuotes,
  verifyInferenceExpenseQuote,
  verifyPendingInferenceExpenses,
  type InferenceExpenseSource,
} from './inference-expense'
import {
  entryEvaluationRequestFixture,
  entryCompletionFixture,
  stagedCheckpointFixture,
} from './jev/entry-inference.test-support'
import { makeJevEvaluationReceipt, JevOutcome } from './jev/evidence'
import { makeJevResolution, JevResolutionStatus } from './jev/resolution'

const sourceFixture = (observedAt = '2026-10-25T07:00:32.000Z'): InferenceExpenseSource => {
  const request = entryEvaluationRequestFixture(observedAt)
  const completion = entryCompletionFixture(request)
  const receipt = Result.getOrThrow(
    makeJevEvaluationReceipt(request, {
      schemaVersion: 'bayn.jev-evaluation-receipt.v3',
      requestId: request.requestId,
      startedAt: observedAt,
      completedAt: completion.completedAt,
      outcome: { status: JevOutcome.Completed, completion },
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
  return {
    accountId: 'pending-batch-test',
    sessionDate: '2026-10-25',
    asOf: request.expiresAt,
    requestId: request.requestId,
    cycleId: request.cycleId,
    authorityGenerationHash: request.authorityGenerationHash,
    request,
    receipt,
    resolution,
    handoff: completion.handoff,
    stagedCheckpoint: stagedCheckpointFixture(request),
  }
}
const rowsFor = (source: InferenceExpenseSource) =>
  Result.getOrThrow(makeInferenceExpenseQuotes(source, inferenceExpenseRateCard)).map((payload) => ({
    quoteHash: payload.quoteHash,
    payload,
    source: structuredClone(source),
  }))
const rehash = <T extends { quoteHash: string }>(quote: T) => {
  const { quoteHash: _, ...material } = quote
  return { ...material, quoteHash: Result.getOrThrow(canonicalHashV1Result(material)) }
}

test('pending batches preserve individual validation and interleaved quote order', () => {
  const a = rowsFor(sourceFixture())
  const b = rowsFor(sourceFixture('2026-10-25T07:01:32.000Z'))
  const rows = a.flatMap((row, index) => [row, ...b.slice(index, index + 1)])
  expect(rows).toHaveLength(6)
  const expected = rows.map((row) => Result.getOrThrow(verifyInferenceExpenseQuote(row.source, row.payload)))
  const actual = Result.getOrThrow(verifyPendingInferenceExpenses(rows))
  expect(actual).toEqual(expected)
  expect(actual.map((quote) => quote.quoteHash)).toEqual(rows.map((row) => row.quoteHash))
})

test('pending batches preserve authenticated earlier prefixes alongside final stages', () => {
  const source = sourceFixture()
  const checkpoint = source.stagedCheckpoint
  if (checkpoint === undefined) throw new Error('Expected staged fixture')
  const early: InferenceExpenseSource = {
    ...source,
    receipt: null,
    resolution: null,
    handoff: null,
    stagedCheckpoint: {
      claims: checkpoint.claims.filter((claim) => claim.stage === 'CHART'),
      terminals: [],
      skips: [],
    },
  }
  const prior = Result.getOrThrow(makeInferenceExpenseQuotes(early, inferenceExpenseRateCard))
  expect(prior).toHaveLength(1)
  const rows = [...prior.map((payload) => ({ quoteHash: payload.quoteHash, payload, source })), ...rowsFor(source)]
  expect(Result.getOrThrow(verifyPendingInferenceExpenses(rows))).toEqual(
    rows.map((row) => Result.getOrThrow(verifyInferenceExpenseQuote(row.source, row.payload))),
  )
})

test('pending batches reject conflicting complete cuts even when request IDs match', () => {
  const rows = rowsFor(sourceFixture())
  const first = rows[0]
  const second = rows[1]
  if (first === undefined || second === undefined) throw new Error('Expected multiple stages')
  for (const changed of [
    { ...second.source, accountId: 'different-account' },
    { ...second.source, sessionDate: '2026-10-26' as const },
    { ...second.source, handoff: null },
    { ...second.source, asOf: '2026-10-25T07:01:01.000Z' },
  ]) {
    expect(Result.isFailure(verifyPendingInferenceExpenses([first, { ...second, source: changed }]))).toBe(true)
  }
})

test('every pending quote retains its row identity, hash, price and source association checks', () => {
  const rows = rowsFor(sourceFixture())
  const first = rows[0]
  const second = rows[1]
  if (first === undefined || second === undefined) throw new Error('Expected multiple stages')
  const incorrectPrice = rehash({ ...second.payload, line: { ...second.payload.line, estimatedCostPicoUsd: '1' } })
  const incorrectAccount = rehash({ ...second.payload, accountBindingHash: 'f'.repeat(64) })
  const other = rowsFor(sourceFixture('2026-10-25T07:01:32.000Z'))[0]
  if (other === undefined) throw new Error('Expected other request quote')
  for (const invalid of [
    { ...second, quoteHash: 'f'.repeat(64) },
    { ...second, payload: { ...second.payload, quoteHash: 'f'.repeat(64) } },
    { ...second, payload: incorrectPrice, quoteHash: incorrectPrice.quoteHash },
    { ...second, payload: incorrectAccount, quoteHash: incorrectAccount.quoteHash },
    { ...second, payload: other.payload, quoteHash: other.quoteHash },
  ]) {
    expect(Result.isFailure(verifyPendingInferenceExpenses([first, invalid]))).toBe(true)
  }
})

test('pending source reuse is local to one call and does not trust a previously validated mutable object', () => {
  const rows = rowsFor(sourceFixture())
  expect(Result.isSuccess(verifyPendingInferenceExpenses(rows))).toBe(true)
  const first = rows[0]
  if (first === undefined) throw new Error('Expected pending row')
  Object.assign(first.source, { accountId: 'mutated-account' })
  expect(Result.isFailure(verifyPendingInferenceExpenses([first]))).toBe(true)
})

test('pending batches retain the 64 quote bound without deduplicating or reordering accepted rows', () => {
  expect(Result.getOrThrow(verifyPendingInferenceExpenses([]))).toEqual([])
  const row = rowsFor(sourceFixture())[0]
  if (row === undefined) throw new Error('Expected pending row')
  expect(
    Result.getOrThrow(verifyPendingInferenceExpenses(Array.from({ length: inferenceExpenseBatchSize }, () => row))),
  ).toHaveLength(64)
  expect(
    Result.isFailure(verifyPendingInferenceExpenses(Array.from({ length: inferenceExpenseBatchSize + 1 }, () => row))),
  ).toBe(true)
})
