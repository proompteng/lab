import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { JevFailure } from './contract'
import {
  entryCompletionFixture,
  entryEvaluationRequestFixture,
  stagedCheckpointFixture,
} from './entry-inference.test-support'
import { JevOutcome, makeJevEvaluationReceipt } from './evidence'
import { readStagedInferenceCostEvidence } from './staged-inference-cost-evidence'

const request = entryEvaluationRequestFixture()
const completion = entryCompletionFixture(request)
const receipt = Result.getOrThrow(
  makeJevEvaluationReceipt(request, {
    schemaVersion: 'bayn.jev-evaluation-receipt.v3',
    requestId: request.requestId,
    startedAt: request.observedAt,
    completedAt: completion.completedAt,
    outcome: { status: JevOutcome.Completed, completion },
  }),
)
const row = {
  request,
  receipt,
  resolution: null,
  handoff: completion.handoff,
  stagedCheckpoint: stagedCheckpointFixture(request),
}
const rehashReceipt = (changed: typeof receipt) => {
  const { receiptHash: _, ...material } = changed
  return { ...material, receiptHash: Result.getOrThrow(canonicalHashV1Result(material)) }
}

test('current financial receipt reuses its exact independently reproduced handoff', () => {
  const result = Result.getOrThrow(readStagedInferenceCostEvidence(row))
  expect(result.receipt).toEqual(receipt)
  expect(result.handoff).toEqual(completion.handoff)
  expect(result.visualStages.map((stage) => stage.outcome)).toEqual(['RECEIVED'])
})

test('a validly rehashed receipt cannot substitute or omit the independent handoff', () => {
  const { handoffHash: _, ...material } = { ...completion.handoff, recordedAt: request.expiresAt }
  const changedHandoff = { ...material, handoffHash: Result.getOrThrow(canonicalHashV1Result(material)) }
  const changedReceipt = rehashReceipt({
    ...receipt,
    outcome: { status: JevOutcome.Completed, completion: { ...completion, handoff: changedHandoff } },
  })
  for (const changed of [
    { ...row, receipt: changedReceipt },
    { ...row, handoff: null },
    { ...row, handoff: changedHandoff },
    { ...row, handoff: { ...completion.handoff, handoffHash: 'f'.repeat(64) } },
  ])
    expect(Result.isFailure(readStagedInferenceCostEvidence(changed))).toBe(true)
})

test('current financial receipts preserve request, completion and provider clock checks', () => {
  const before = new Date(Date.parse(request.observedAt) - 1).toISOString()
  const after = new Date(Date.parse(request.observedAt) + 1).toISOString()
  for (const changed of [
    { ...receipt, requestId: 'f'.repeat(64) },
    { ...receipt, startedAt: before },
    { ...receipt, completedAt: before },
    { ...receipt, startedAt: after, completedAt: after },
    {
      ...receipt,
      outcome: { status: JevOutcome.Completed as const, completion: { ...completion, completedAt: after } },
    },
  ])
    expect(Result.isFailure(readStagedInferenceCostEvidence({ ...row, receipt: rehashReceipt(changed) }))).toBe(true)
})

test('current failed receipts still require proof of non-dispatch expiry', () => {
  const failed = {
    ...receipt,
    completedAt: request.expiresAt,
    outcome: { status: JevOutcome.Failed as const, failure: JevFailure.NotDispatched },
  }
  const empty = {
    ...row,
    receipt: rehashReceipt(failed),
    handoff: null,
    stagedCheckpoint: { claims: [], terminals: [], skips: [] },
  }
  expect(Result.isSuccess(readStagedInferenceCostEvidence(empty))).toBe(true)
  for (const changed of [
    { ...failed, startedAt: request.expiresAt },
    { ...failed, completedAt: request.observedAt },
  ])
    expect(Result.isFailure(readStagedInferenceCostEvidence({ ...empty, receipt: rehashReceipt(changed) }))).toBe(true)
})

test('reusing a verified handoff still verifies dependent Jev evidence', () => {
  if (completion.jev.status !== 'RECEIVED') throw new Error('Expected completed fixture Jev evidence')
  for (const jev of [
    { status: 'NOT_REQUESTED' as const },
    { status: 'NOT_DISPATCHED' as const },
    { status: 'OMITTED_BY_POLICY' as const },
    { ...completion.jev, inference: { ...completion.jev.inference, responseHash: 'f'.repeat(64) } },
    { ...completion.jev, inference: { ...completion.jev.inference, requestHash: 'f'.repeat(64) } },
  ]) {
    const changed = rehashReceipt({
      ...receipt,
      outcome: { status: JevOutcome.Completed, completion: { ...completion, jev } },
    })
    expect(Result.isFailure(readStagedInferenceCostEvidence({ ...row, receipt: changed }))).toBe(true)
  }
})
