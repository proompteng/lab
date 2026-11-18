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
} from '../inference-expense'
import { entryCompletionFixture, stagedCheckpointFixture } from './entry-inference.test-support'
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
