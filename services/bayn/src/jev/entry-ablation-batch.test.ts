import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import {
  JevBatchPlanVersion,
  JevCandidatePlanStatus,
  jevBatchQuestionSetHash,
  makeJevBatchPlan,
  usableEntryBatchInferences,
} from './batch'
import { nativeJevBatchResult, nativeJevFixture } from './native.test-support'
import { makeJevTradingSignalBatch, reproduceJevTradingSignalBatchEvidence } from './trading-signals'
import { decideEntryAblation, EntryAblationTargetSchema } from './entry-ablation'
import { decideJevEntry, JevEntryTargetSchema } from './decision'

const fixture = () => {
  const native = nativeJevFixture()
  const observation = native.observation.payload
  const input = {
    observation,
    expiresAt: new Date(Date.parse(observation.observedAt) + native.protocol.inferenceValidityMs).toISOString(),
  }
  const candidate = Result.getOrThrow(makeJevTradingSignalBatch({ ...input, planVersion: JevBatchPlanVersion.V8 }))
  const ablation = Result.getOrThrow(makeJevTradingSignalBatch({ ...input, planVersion: JevBatchPlanVersion.Ablation }))
  return { observation, candidate, ablation }
}

test('native ablation uses the same verified market, funding, exclusions and deadlines under a distinct policy identity', () => {
  const { observation, candidate, ablation } = fixture()
  expect(ablation.batchId).not.toBe(candidate.batchId)
  expect(ablation.questionSetHash).not.toBe(candidate.questionSetHash)
  expect(ablation.observationHash).toBe(candidate.observationHash)
  expect(ablation.expiresAt).toBe(candidate.expiresAt)
  expect(ablation.candidates.map(({ symbol, status }) => ({ symbol, status }))).toEqual(
    candidate.candidates.map(({ symbol, status }) => ({ symbol, status })),
  )
  let compared = 0
  for (const [index, entry] of ablation.candidates.entries()) {
    const original = candidate.candidates[index]
    if (entry.status !== JevCandidatePlanStatus.Requested || original?.status !== JevCandidatePlanStatus.Requested)
      continue
    compared++
    expect(entry.request.request.schemaVersion).toBe('bayn.entry-ablation-input.v1')
    expect(entry.request.requestId).not.toBe(original.request.requestId)
    expect(entry.request.request.numericalState).toEqual(original.request.request.numericalState)
    expect(entry.request.request.chartSource).toEqual(original.request.request.chartSource)
    expect(entry.request.request.funding).toEqual(original.request.request.funding)
  }
  expect(compared).toBeGreaterThan(0)
  expect(Result.getOrThrow(reproduceJevTradingSignalBatchEvidence(observation, ablation)).plan).toEqual(ablation)
})

test('complete ablation evidence is available only to the ablation consumer', () => {
  const { ablation } = fixture()
  const completedAt = new Date(Date.parse(ablation.observedAt) + 100).toISOString()
  const result = nativeJevBatchResult(ablation, completedAt)
  const inferences = Result.getOrThrow(
    usableEntryBatchInferences(ablation, result, Date.parse(completedAt), JevBatchPlanVersion.Ablation),
  )
  expect(inferences.length).toBeGreaterThan(0)
  expect(
    inferences.every(
      ({ inference }) => inference.jev.status === 'OMITTED_BY_POLICY' || inference.jev.status === 'NOT_REQUESTED',
    ),
  ).toBe(true)
  expect(
    Result.isFailure(usableEntryBatchInferences(ablation, result, Date.parse(completedAt), JevBatchPlanVersion.V8)),
  ).toBe(true)
  expect(
    Result.isFailure(
      usableEntryBatchInferences(ablation, result, Date.parse(ablation.expiresAt), JevBatchPlanVersion.Ablation),
    ),
  ).toBe(true)
})

test('a resealed batch cannot mix candidate and ablation requests or relabel the policy', () => {
  const { candidate, ablation } = fixture()
  const { batchId: _, ...material } = ablation
  const requestedIndex = candidate.candidates.findIndex((entry) => entry.status === JevCandidatePlanStatus.Requested)
  expect(requestedIndex).toBeGreaterThanOrEqual(0)
  const candidates = ablation.candidates.map((entry, index) =>
    index === requestedIndex ? (candidate.candidates[index] ?? entry) : entry,
  )
  expect(
    Result.isFailure(
      makeJevBatchPlan({
        ...material,
        candidates,
        questionSetHash: Result.getOrThrow(jevBatchQuestionSetHash(candidates)),
      }),
    ),
  ).toBe(true)
  expect(Result.isFailure(makeJevBatchPlan({ ...material, schemaVersion: JevBatchPlanVersion.V8 }))).toBe(true)
})

test('ablation produces one reproducible protected target and cannot supply a candidate target', () => {
  const { observation, candidate, ablation } = fixture()
  const decidedAt = new Date(Date.parse(ablation.observedAt) + 100).toISOString()
  const evidence = {
    observation,
    batchPlan: ablation,
    batchResult: nativeJevBatchResult(ablation, decidedAt),
    decidedAt,
  }
  const target = Result.getOrThrow(decideEntryAblation(evidence))
  expect(target.selectedSymbols).toHaveLength(1)
  expect(Object.keys(target.exitPolicy.plans)).toEqual(target.selectedSymbols)
  expect(Object.values(target.targetWeights).filter((weight) => weight > 0)).toHaveLength(1)
  expect(Result.isSuccess(Schema.decodeUnknownResult(EntryAblationTargetSchema)(target))).toBe(true)
  expect(Result.isFailure(decideJevEntry(evidence))).toBe(true)
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(JevEntryTargetSchema)({
        ...target,
        schemaVersion: 'bayn.jev-entry-target.v7',
      }),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      decideEntryAblation({
        ...evidence,
        batchPlan: candidate,
        batchResult: nativeJevBatchResult(candidate, decidedAt),
      }),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(EntryAblationTargetSchema)({
        ...target,
        targetWeights: Object.fromEntries(Object.keys(target.targetWeights).map((symbol) => [symbol, 1])),
      }),
    ),
  ).toBe(true)
  expect(Result.isFailure(decideEntryAblation({ ...evidence, decidedAt: ablation.expiresAt }))).toBe(true)
})
