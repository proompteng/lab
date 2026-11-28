import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { InferenceStage, InferenceUsageStatus } from '../inference-costs'
import {
  buildInferenceExpensePlan,
  decodeInferenceExpenseQuote,
  inferenceExpenseRateCard,
  makeInferenceExpenseQuotes,
  verifyInferenceExpenseQuote,
  verifyPendingInferenceExpenses,
} from '../inference-expense'
import { expenseCoverageFromEvidence } from '../inference-expense.test-support'
import { entryCompletionFixture, stagedCheckpointFixture } from './entry-inference.test-support'
import { JevResolutionStatus, makeJevResolution } from './resolution'
import { decodeStagedCheckpoint } from './staged-checkpoint'
import { undispatchedVisualFixture } from './staged-not-dispatched.test-support'

const rehash = <T extends { readonly terminalHash: string }>(terminal: T) => {
  const { terminalHash: _, ...material } = terminal
  return { ...material, terminalHash: Result.getOrThrow(canonicalHashV1Result(material)) }
}

test.each(['ORIGINAL_EXPIRY', 'ADMISSION_EXPIRY'] as const)(
  '%s proves zero visual and dependent Jev expense without a provider handoff',
  (reason) => {
    const { source, terminal } = undispatchedVisualFixture(reason)
    const quotes = Result.getOrThrow(makeInferenceExpenseQuotes(source, inferenceExpenseRateCard))
    expect(quotes.map((quote) => ('stage' in quote.line ? quote.line.stage : null)).sort()).toEqual([
      InferenceStage.Chart,
      InferenceStage.Jev,
    ])
    for (const quote of quotes) {
      expect(quote.schemaVersion).toBe('bayn.inference-expense-quote.v5')
      expect(quote.line).toMatchObject({
        usageStatus: InferenceUsageStatus.NotDispatched,
        notDispatchedByTerminalHash: terminal.terminalHash,
        inputTokens: '0',
        outputTokens: '0',
        cachedInputTokens: '0',
        cacheWriteInputTokens: '0',
        estimatedCostPicoUsd: '0',
        receiptHash: null,
        resolutionHash: null,
        handoffHash: null,
        rateHash: null,
      })
      expect(quote.rate).toBeNull()
      expect(Result.isSuccess(decodeInferenceExpenseQuote(quote))).toBe(true)
      expect(Result.isSuccess(verifyInferenceExpenseQuote(source, quote))).toBe(true)
    }
    expect(Result.getOrThrow(buildInferenceExpensePlan(quotes)).transfers).toEqual([])
  },
)

test('non-dispatch clocks, reason, source claim and immutable identity are independently reproduced', () => {
  const { request, source, terminal } = undispatchedVisualFixture()
  const beforeClaim = new Date(Date.parse(request.observedAt) - 1).toISOString()
  const changes = [
    { ...terminal, claimHash: 'f'.repeat(64) },
    { ...terminal, requestId: 'f'.repeat(64) },
    { ...terminal, stage: 'BASE_START' },
    { ...terminal, schemaVersion: 'bayn.staged-terminal-receipt.v1' },
    { ...terminal, recordedAt: request.expiresAt },
    { ...terminal, outcome: { ...terminal.outcome, checkedAt: beforeClaim } },
    { ...terminal, outcome: { ...terminal.outcome, checkedAt: request.observedAt } },
    { ...terminal, outcome: { ...terminal.outcome, deadlineAt: terminal.recordedAt } },
    { ...terminal, outcome: { ...terminal.outcome, deadlineAt: request.observedAt } },
    { ...terminal, outcome: { ...terminal.outcome, reason: 'ADMISSION_EXPIRY' } },
  ]
  for (const changed of changes) {
    const stagedCheckpoint = { ...source.stagedCheckpoint, terminals: [rehash(changed)] }
    expect(Result.isFailure(decodeStagedCheckpoint(request, stagedCheckpoint))).toBe(true)
  }
})

test('an uncompleted claim remains unknown and a paid chart cannot become a zero expense', () => {
  const { request, source } = undispatchedVisualFixture()
  const paid = stagedCheckpointFixture(request)
  const pending = { claims: paid.claims, terminals: [], skips: [] }
  const unknown = Result.getOrThrow(
    makeInferenceExpenseQuotes({ ...source, stagedCheckpoint: pending }, inferenceExpenseRateCard),
  )
  expect(unknown).toHaveLength(1)
  expect(unknown[0]?.line.usageStatus).toBe(InferenceUsageStatus.Unknown)
  const zero = Result.getOrThrow(makeInferenceExpenseQuotes(source, inferenceExpenseRateCard))
  const paidSource = { ...source, stagedCheckpoint: paid }
  for (const quote of zero) expect(Result.isFailure(verifyInferenceExpenseQuote(paidSource, quote))).toBe(true)
  const completion = entryCompletionFixture(request)
  expect(
    Result.isFailure(makeInferenceExpenseQuotes({ ...source, handoff: completion.handoff }, inferenceExpenseRateCard)),
  ).toBe(true)
})

test('frozen zero quotes validate the complete current graph before projecting their proof', () => {
  const { request, source, claim, terminal } = undispatchedVisualFixture()
  const zero = Result.getOrThrow(makeInferenceExpenseQuotes(source, inferenceExpenseRateCard))
  const paid = stagedCheckpointFixture(request)
  const invalidSources = [
    { ...source, asOf: request.observedAt },
    { ...source, stagedCheckpoint: { claims: [claim, claim], terminals: [terminal], skips: [] } },
    { ...source, stagedCheckpoint: { claims: [claim], terminals: [terminal, terminal], skips: [] } },
    { ...source, stagedCheckpoint: { claims: [claim], terminals: [terminal, ...paid.terminals], skips: [] } },
  ]
  for (const changed of invalidSources) {
    expect(Result.isFailure(makeInferenceExpenseQuotes(changed, inferenceExpenseRateCard))).toBe(true)
    for (const quote of zero) expect(Result.isFailure(verifyInferenceExpenseQuote(changed, quote))).toBe(true)
  }
})

test('retained abandoned gaps still verify after a late positive non-dispatch terminal', () => {
  const { request, source } = undispatchedVisualFixture()
  const resolution = Result.getOrThrow(
    makeJevResolution(request, null, {
      schemaVersion: 'bayn.jev-evaluation-resolution.v1',
      requestId: request.requestId,
      status: JevResolutionStatus.Abandoned,
      abandonedAt: request.expiresAt,
    }),
  )
  const earlier = {
    ...source,
    asOf: request.expiresAt,
    resolution,
    stagedCheckpoint: { ...source.stagedCheckpoint, terminals: [] },
  }
  const gaps = Result.getOrThrow(makeInferenceExpenseQuotes(earlier, inferenceExpenseRateCard))
  expect(gaps).toHaveLength(2)
  expect(gaps.every((quote) => quote.schemaVersion === 'bayn.inference-expense-quote.v4')).toBe(true)
  expect(gaps.every((quote) => quote.line.usageStatus === InferenceUsageStatus.Unknown)).toBe(true)
  const retainedHashes = gaps.map((quote) => quote.quoteHash)
  const current = { ...source, resolution }
  const zero = Result.getOrThrow(makeInferenceExpenseQuotes(current, inferenceExpenseRateCard))
  for (const quote of gaps) expect(Result.isSuccess(verifyInferenceExpenseQuote(current, quote))).toBe(true)
  const quotes = [...gaps, ...zero]
  const pending = quotes.map((payload) => ({ quoteHash: payload.quoteHash, payload, source: current }))
  expect(Result.getOrThrow(verifyPendingInferenceExpenses(pending)).map((quote) => quote.quoteHash)).toEqual(
    quotes.map((quote) => quote.quoteHash),
  )
  const { accountId, sessionDate, asOf, ...entry } = current
  const evidence = {
    schemaVersion: 'bayn.inference-cost-evidence.v4' as const,
    accountBindingHash: zero[0]?.accountBindingHash,
    sessionDate,
    asOf,
    requests: [entry],
  }
  const coverage = Result.getOrThrow(
    expenseCoverageFromEvidence(
      evidence,
      accountId,
      quotes.map((quote) => ({ quote, verifiedAt: asOf })),
    ),
  )
  expect(coverage.completeMeteredCoverage).toBe(true)
  expect(coverage.knownEstimatedCostPicoUsd).toBe('0')
  expect(coverage.gapRequestCount).toBe(0)
  expect(Result.getOrThrow(buildInferenceExpensePlan(quotes)).transfers).toEqual([])
  expect(gaps.map((quote) => quote.quoteHash)).toEqual(retainedHashes)
  const missingCurrent = Result.getOrThrow(
    expenseCoverageFromEvidence(
      evidence,
      accountId,
      gaps.map((quote) => ({ quote, verifiedAt: asOf })),
    ),
  )
  expect(missingCurrent.completeMeteredCoverage).toBe(false)
  expect(missingCurrent.missingQuoteCount).toBe(2)
  const corrupted = { ...current, stagedCheckpoint: { ...current.stagedCheckpoint, terminals: [] } }
  for (const quote of zero) expect(Result.isFailure(verifyInferenceExpenseQuote(corrupted, quote))).toBe(true)
  const invalidGraph = {
    ...current,
    stagedCheckpoint: {
      ...current.stagedCheckpoint,
      terminals: current.stagedCheckpoint.terminals.map((terminal) => ({ ...terminal, terminalHash: 'f'.repeat(64) })),
    },
  }
  for (const quote of gaps) expect(Result.isFailure(verifyInferenceExpenseQuote(invalidGraph, quote))).toBe(true)
})

test('v5 cannot be relabeled as a legacy quote or consume tokens, price or unrelated proof', () => {
  const { source } = undispatchedVisualFixture()
  const quotes = Result.getOrThrow(makeInferenceExpenseQuotes(source, inferenceExpenseRateCard))
  for (const quote of quotes) {
    const changes = [
      { ...quote, schemaVersion: 'bayn.inference-expense-quote.v4' },
      { ...quote, line: { ...quote.line, inputTokens: '1' } },
      { ...quote, line: { ...quote.line, estimatedCostPicoUsd: '1' } },
      { ...quote, line: { ...quote.line, rateHash: 'f'.repeat(64) } },
      { ...quote, line: { ...quote.line, notDispatchedByTerminalHash: 'f'.repeat(64) } },
    ]
    for (const changed of changes) {
      const { quoteHash: _, ...material } = changed
      const rehashed = { ...material, quoteHash: Result.getOrThrow(canonicalHashV1Result(material)) }
      const decoded = decodeInferenceExpenseQuote(rehashed)
      expect(Result.isFailure(decoded) || Result.isFailure(verifyInferenceExpenseQuote(source, decoded.success))).toBe(
        true,
      )
    }
  }
})
