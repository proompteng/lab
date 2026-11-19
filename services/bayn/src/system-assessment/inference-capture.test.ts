import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { decodeInferenceCostEvidence, InferenceCostEvidenceSchema } from '../inference-costs'
import { makeInferenceExpenseQuote } from '../inference-expense'
import { expenseRateFixture, expenseSourceFixture } from '../inference-expense.test-support'
import { strictParseOptions } from '../schemas'
import { captureInferenceSnapshot } from './inference-capture'

const snapshot = (state: string) => {
  const source = expenseSourceFixture({ state })
  const quote = Result.getOrThrow(makeInferenceExpenseQuote(source, expenseRateFixture))
  const request = {
    requestId: source.requestId,
    cycleId: source.cycleId,
    authorityGenerationHash: source.authorityGenerationHash,
    request: source.request,
    receipt: source.receipt,
    resolution: source.resolution,
    handoff: source.handoff,
  }
  return {
    evidence: Result.getOrThrow(
      decodeInferenceCostEvidence({
        schemaVersion: 'bayn.inference-cost-evidence.v2',
        accountBindingHash: quote.accountBindingHash,
        sessionDate: source.sessionDate,
        asOf: source.asOf,
        requests: [request],
      }),
    ),
    quotes: [{ quote, verifiedAt: source.asOf }],
  }
}

test('financial capture retains complete replayable inference evidence once', () => {
  const original = snapshot('retained private inference input')
  const captured = captureInferenceSnapshot(original, 'BAYN_SYSTEM_QUALIFICATION')
  expect(captured.evidence).not.toBeNull()
  const evidence = Result.getOrThrow(
    Schema.decodeUnknownResult(InferenceCostEvidenceSchema, strictParseOptions)(captured.evidence),
  )
  expect(Result.getOrThrow(decodeInferenceCostEvidence(evidence))).toEqual(original.evidence)
  expect(captured.source.requests[0]?.sourceFingerprint).toBe(
    Result.getOrThrow(canonicalHashV1Result(evidence.requests[0])),
  )
  expect(captured.source.quotes).toEqual(original.quotes)
  expect(JSON.stringify(captured.source)).not.toContain('retained private inference input')
})

test('operational capture retains source identities and all quotes without raw inference bodies', () => {
  const original = snapshot('large private inference input '.repeat(300))
  const captured = captureInferenceSnapshot(original, 'BAYN_OPERATIONAL_RELIABILITY')
  expect(captured.evidence).toBeNull()
  expect(captured.source.requests).toEqual(
    original.evidence.requests.map((request) => ({
      requestId: request.requestId,
      cycleId: request.cycleId,
      authorityGenerationHash: request.authorityGenerationHash,
      requestSchemaVersion: request.requestSchemaVersion,
      sourceFingerprint: request.sourceFingerprint,
    })),
  )
  expect(captured.source.quotes).toEqual(original.quotes)
  expect(JSON.stringify(captured)).not.toContain('large private inference input')
  expect(JSON.stringify(captured).length).toBeLessThan(10_000)
})

test('operational provenance changes when validated inference input changes', () => {
  const first = captureInferenceSnapshot(snapshot('first input'), 'BAYN_OPERATIONAL_RELIABILITY')
  const second = captureInferenceSnapshot(snapshot('changed input'), 'BAYN_OPERATIONAL_RELIABILITY')
  expect(first.source.requests[0]?.sourceFingerprint).not.toBe(second.source.requests[0]?.sourceFingerprint)
})
