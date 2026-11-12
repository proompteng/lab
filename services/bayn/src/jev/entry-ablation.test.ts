import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { selectEntryAblationProposal } from './entry-ablation'
import { EntryAblationSelection, prepareEntryInferenceInput } from './entry-inference-input'
import { entryCompletionFixture, entryEvaluationRequestFixture } from './entry-inference.test-support'
import { EntrySetup } from './entry-proposals'
import { JevOutcome, makeJevEvaluationReceipt, makeJevEvaluationRequest } from './evidence'

const hash = (value: unknown) => Result.getOrThrow(canonicalHashV1Result(value))
const fixture = () => {
  const base = entryEvaluationRequestFixture(undefined, undefined, EntryAblationSelection.LowestModeledLoss)
  const bars = [
    { minuteBeforeWindowEnd: 6, open: 100, high: 103, low: 97, close: 101, volume: 100 },
    { minuteBeforeWindowEnd: 5, open: 101, high: 102, low: 99, close: 100, volume: 100 },
    { minuteBeforeWindowEnd: 4, open: 100, high: 102, low: 99, close: 101, volume: 100 },
    { minuteBeforeWindowEnd: 3, open: 101, high: 102, low: 99, close: 100, volume: 100 },
    { minuteBeforeWindowEnd: 2, open: 103, high: 108, low: 102, close: 104, volume: 100 },
    { minuteBeforeWindowEnd: 1, open: 104, high: 105, low: 103, close: 104, volume: 100 },
  ]
  const prepared = Result.getOrThrow(
    prepareEntryInferenceInput({
      ...base.request,
      chartSource: { ...base.request.chartSource, bars },
      numericalState: { ...base.request.numericalState, candidate: { symbol: 'AAPL', bars1m: bars } },
    }),
  )
  const { requestId: _, ...material } = base
  const request = Result.getOrThrow(
    makeJevEvaluationRequest({
      ...material,
      request: prepared.input,
      requestHash: prepared.requestHash,
    }),
  )
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
  return { request, receipt, decidedAt: Date.parse(request.observedAt), completion }
}

test('removing Jev selects the least modeled loss from reproduced funded chart proposals', () => {
  const input = fixture()
  const disposition = input.completion.handoff.disposition
  expect(disposition.status).toBe('READY')
  if (disposition.status !== 'READY') throw new Error('Expected two funded source proposals')
  expect(disposition.evaluation.proposals).toHaveLength(2)
  const selected = Result.getOrThrow(selectEntryAblationProposal(input))
  expect(selected.proposal?.source.setup).toBe(EntrySetup.SupportRecovery)
  const expected = disposition.evaluation.proposals.find(
    (proposal) => proposal.source.setup === EntrySetup.SupportRecovery,
  )
  if (expected === undefined) throw new Error('Expected the independently funded recovery')
  expect(selected.proposal).toEqual(expected)
  expect(input.completion.jev).toEqual({ status: 'OMITTED_BY_POLICY' })
})

test('ablation cannot consume candidate judgments, missing receipts, future evidence or an expired request', () => {
  const input = fixture()
  const candidate = entryEvaluationRequestFixture()
  for (const changed of [
    { ...input, request: candidate },
    { ...input, receipt: null },
    { ...input, decidedAt: input.decidedAt - 1 },
    { ...input, decidedAt: Date.parse(input.request.expiresAt) },
    { ...input, decidedAt: Number.NaN },
  ])
    expect(Result.isFailure(selectEntryAblationProposal(changed))).toBe(true)
})

test('rehashing a receipt cannot replace original proposals with a more attractive result', () => {
  const input = fixture()
  const disposition = input.completion.handoff.disposition
  if (disposition.status !== 'READY') throw new Error('Expected funded proposals')
  const proposals = disposition.evaluation.proposals.slice().reverse()
  const { handoffHash: _, ...handoff } = input.completion.handoff
  const changed = { ...handoff, disposition: { ...disposition, evaluation: { ...disposition.evaluation, proposals } } }
  const { receiptHash: _receiptHash, ...receipt } = input.receipt
  const altered = {
    ...receipt,
    outcome: {
      status: JevOutcome.Completed,
      completion: {
        ...input.completion,
        handoff: { ...changed, handoffHash: hash(changed) },
      },
    },
  }
  expect(
    Result.isFailure(
      selectEntryAblationProposal({
        ...input,
        receipt: { ...altered, receiptHash: hash(altered) },
      }),
    ),
  ).toBe(true)
})

test('ablation retains an evidenced zero-proposal abstention without manufacturing an entry', () => {
  const base = entryEvaluationRequestFixture(undefined, undefined, EntryAblationSelection.LowestModeledLoss)
  const prepared = Result.getOrThrow(
    prepareEntryInferenceInput({
      ...base.request,
      funding: { ...base.request.funding, bidMicros: '500000000', askMicros: '500020000' },
    }),
  )
  const { requestId: _, ...material } = base
  const request = Result.getOrThrow(
    makeJevEvaluationRequest({ ...material, request: prepared.input, requestHash: prepared.requestHash }),
  )
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
  expect(
    Result.getOrThrow(selectEntryAblationProposal({ request, receipt, decidedAt: Date.parse(request.observedAt) }))
      .proposal,
  ).toBeNull()
})
