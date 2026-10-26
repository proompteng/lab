import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { JevCandidatePlanStatus } from './batch'
import { decideJevEntry, JevEntryTargetSchema } from './decision'
import { entryCompletionFixture } from './entry-inference.test-support'
import { decodeJevProtocol, defaultJevProtocolDocument } from './protocol'
import { nativeJevFixture, nativeJevDecisionEvidence } from './native.test-support'
import { prepareEntryInferenceInput } from './entry-inference-input'

const fixture = nativeJevFixture()

test('native source and dependent requests survive canonical serialization', () => {
  const evidence = nativeJevDecisionEvidence(fixture)
  const candidate = evidence.batchPlan.candidates[0]
  if (candidate?.status !== JevCandidatePlanStatus.Requested) throw new Error('Expected entry source')
  const prepared = Result.getOrThrow(prepareEntryInferenceInput(JSON.parse(JSON.stringify(candidate.request.request))))
  expect(prepared.requestHash).toBe(candidate.request.requestHash)
  const completion = entryCompletionFixture(candidate.request)
  expect(completion.handoff.disposition.status).toBe('READY')
  if (completion.handoff.disposition.status !== 'READY') throw new Error('Missing dependent request')
  expect(
    Object.values(completion.handoff.disposition.jevRequest.questions).every((question) => question.type === 'noul'),
  ).toBe(true)
})

test('negative own and relative returns reach chart inference without a momentum veto', () => {
  const falling = nativeJevFixture(undefined, undefined, undefined, undefined, undefined, { AAPL: -0.02, AMZN: -0.03 })
  const evidence = nativeJevDecisionEvidence(falling)
  for (const candidate of evidence.batchPlan.candidates) expect(candidate.status).toBe(JevCandidatePlanStatus.Requested)
  const candidate = evidence.batchPlan.candidates.find((value) => value.symbol === 'AAPL')
  if (candidate?.status !== JevCandidatePlanStatus.Requested) throw new Error('Expected source request')
  expect(JSON.stringify(candidate.request.request.numericalState)).toContain('lookbackReturnBps')
  expect(candidate.request.request.chartSource.symbol).toBe('AAPL')
})

test('selected prices, source anchors and funded size reproduce the sealed proposal', () => {
  const target = Result.getOrThrow(decideJevEntry(nativeJevDecisionEvidence(fixture)))
  const symbol = target.selectedSymbols[0]
  if (symbol === undefined) throw new Error('Expected a funded supported entry')
  const plan = target.exitPolicy.plans[symbol]
  const candidate = target.evidence.batchResult.candidates.find((value) => value.symbol === symbol)
  if (plan === undefined || candidate?.status !== 'RESOLVED' || candidate.receipt?.outcome.status !== 'COMPLETED')
    throw new Error('Missing selected evidence')
  const disposition = candidate.receipt.outcome.completion.handoff.disposition
  if (disposition.status !== 'READY') throw new Error('Missing funded proposals')
  const proposal = disposition.evaluation.proposals.find((value) => value.proposalId === plan.levels.proposalId)
  if (proposal === undefined) throw new Error('Selected plan did not come from its provider handoff')
  expect(plan.levels.source).toEqual(proposal.source)
  expect(plan.maximumQuantityAtoms).toBe(proposal.funding.maximumQuantityAtoms)
  expect(BigInt(plan.estimatedTargetNetMicros)).toBeGreaterThan(BigInt(plan.acquisitionCostMicros))
  expect(BigInt(plan.estimatedStopNetMicros)).toBeLessThan(BigInt(plan.acquisitionCostMicros))
  expect(target.exitPolicy.maximumHoldingMinutes).toBe(15)
  expect(Result.isSuccess(Schema.decodeUnknownResult(JevEntryTargetSchema)(target))).toBe(true)
  const altered = {
    ...target,
    exitPolicy: {
      ...target.exitPolicy,
      plans: { ...target.exitPolicy.plans, [symbol]: { ...plan, maximumQuantityAtoms: '1' } },
    },
  }
  expect(Result.isFailure(Schema.decodeUnknownResult(JevEntryTargetSchema)(altered))).toBe(true)
})

test('retired protocol geometry and caps cannot become current defaults', () => {
  expect(
    Result.isFailure(decodeJevProtocol({ ...defaultJevProtocolDocument, schemaVersion: 'bayn.jev.protocol.v23' })),
  ).toBe(true)
  expect(Result.isFailure(decodeJevProtocol({ ...defaultJevProtocolDocument, maximumCapitalRiskBps: 10 }))).toBe(true)
  expect(Result.isFailure(decodeJevProtocol({ ...defaultJevProtocolDocument, maximumStopBps: 500 }))).toBe(true)
  expect(Result.getOrThrow(canonicalHashV1Result(defaultJevProtocolDocument))).not.toBe(
    '7cf76109bc5301a4eabef41f4cf37ea531b3bb87c6b5246d74970262398936de',
  )
})
