import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1 } from '../hash'
import {
  constructSimulatedSnapshot,
  constructStreamingSnapshot,
  type VerifiedStrategyMarketSnapshot,
} from '../market-data/streaming/snapshot'
import { persistIntradayRecordRows } from '../market-data/intraday/verification'
import { candidateObservationFixture } from '../testing/candidate-observation-fixture'
import { simulationFixture } from '../testing/simulated-streaming-fixture'
import { JevCandidatePlanStatus, makeJevBatchPlan } from './batch'
import { makeJevEvaluationRequest } from './evidence'
import {
  makeJevTradingSignalBatch,
  makeJevTradingSignalRequest,
  reproduceJevRequestFromObservation,
  reproduceJevTradingSignalBatch,
} from './trading-signals'

const fixture = candidateObservationFixture()
const observationFor = (snapshot: VerifiedStrategyMarketSnapshot) => ({
  ...fixture.observation.payload,
  manifest: snapshot.manifest,
  observedAt: snapshot.manifest.observedAt,
  rows: Result.getOrThrow(persistIntradayRecordRows(snapshot)),
})
const input = {
  observation: fixture.observation.payload,
  expiresAt: new Date(Date.parse(fixture.input.observedAt) + 5000).toISOString(),
}

describe('Jev trading batch source reproduction', () => {
  test('freezes the entire recorded universe and reproduces each exact request', () => {
    const plan = Result.getOrThrow(makeJevTradingSignalBatch(input))
    expect(plan.observationHash).toBe(fixture.observation.contentHash)
    expect(plan.protocolHash).toBe(canonicalHashV1(fixture.protocol))
    expect(plan.candidates.map((candidate) => candidate.symbol)).toEqual([...fixture.protocol.candidateSymbols])
    for (const candidate of plan.candidates) {
      if (candidate.status !== JevCandidatePlanStatus.Requested) throw new Error('Expected complete fixture')
      const prepared = Result.getOrThrow(
        makeJevTradingSignalRequest(fixture.snapshot, candidate.symbol, fixture.protocol.benchmarkSymbol),
      )
      expect(candidate.request.requestHash).toBe(prepared.requestHash)
      expect(
        Result.getOrThrow(reproduceJevRequestFromObservation(candidate.request, fixture.observation.payload))
          .requestHash,
      ).toBe(prepared.requestHash)
    }
    expect(
      Result.getOrThrow(reproduceJevTradingSignalBatch(input.observation, JSON.parse(JSON.stringify(plan)))),
    ).toEqual(plan)
  })

  test('request reconstruction rejects incomplete rows, different observation time and a changed universe', () => {
    const plan = Result.getOrThrow(makeJevTradingSignalBatch(input))
    const candidate = plan.candidates[0]
    if (candidate?.status !== JevCandidatePlanStatus.Requested) throw new Error('Missing request fixture')
    const source = fixture.observation.payload
    for (const changed of [
      { ...source, rows: { ...source.rows, quotes: source.rows.quotes.slice(1) } },
      { ...source, observedAt: new Date(Date.parse(source.observedAt) + 1).toISOString() },
      { ...source, protocol: { ...source.protocol, candidateSymbols: source.protocol.candidateSymbols.slice(1) } },
      { ...source, manifest: { ...source.manifest, schemaVersion: 'unknown-source' } },
    ])
      expect(Result.isFailure(reproduceJevRequestFromObservation(candidate.request, changed))).toBe(true)
  })

  test('a correctly rehashed plan cannot omit a losing candidate or change model input', () => {
    const { batchId: _, ...material } = Result.getOrThrow(makeJevTradingSignalBatch(input))
    const omitted = Result.getOrThrow(makeJevBatchPlan({ ...material, candidates: material.candidates.slice(1) }))
    expect(Result.isFailure(reproduceJevTradingSignalBatch(input.observation, omitted))).toBe(true)
    const altered = Result.getOrThrow(
      makeJevBatchPlan({
        ...material,
        candidates: material.candidates.map((candidate) => {
          if (candidate.status !== JevCandidatePlanStatus.Requested || candidate.symbol !== 'AAPL') return candidate
          const { requestId: _, ...evaluation } = candidate.request
          const request = { ...evaluation.request, state: { fabricated: 'favorable state' } }
          return {
            ...candidate,
            request: Result.getOrThrow(
              makeJevEvaluationRequest({ ...evaluation, request, requestHash: canonicalHashV1(request) }),
            ),
          }
        }),
      }),
    )
    expect(Result.isFailure(reproduceJevTradingSignalBatch(input.observation, altered))).toBe(true)
  })

  test('reproduction rejects a rehashed claim to an unrelated observation or protocol', () => {
    const { batchId: _, ...material } = Result.getOrThrow(makeJevTradingSignalBatch(input))
    for (const field of ['observationHash', 'protocolHash']) {
      const altered = Result.getOrThrow(makeJevBatchPlan({ ...material, [field]: 'f'.repeat(64) }))
      expect(Result.isFailure(reproduceJevTradingSignalBatch(input.observation, altered))).toBe(true)
    }
  })

  test('retains the exact source exclusion rather than dropping an unavailable candidate', () => {
    const features = new Map(fixture.cut.projection.features)
    features.delete('NVDA')
    const snapshot = Result.getOrThrow(
      constructStreamingSnapshot(
        { ...fixture.cut, projection: { ...fixture.cut.projection, features } },
        fixture.query,
      ),
    )
    const observation = observationFor(snapshot)
    const plan = Result.getOrThrow(makeJevTradingSignalBatch({ ...input, observation }))
    const excluded = plan.candidates.find((candidate) => candidate.symbol === 'NVDA')
    expect(excluded?.status).toBe(JevCandidatePlanStatus.Excluded)
    if (excluded?.status !== JevCandidatePlanStatus.Excluded) throw new Error('Missing source exclusion')
    const sourceExclusion = snapshot.manifest.candidateExclusions?.[0]
    if (sourceExclusion === undefined) throw new Error('Missing source exclusion fixture')
    expect(sourceExclusion.symbol).toBe(excluded.symbol)
    expect(sourceExclusion.reason).toBe(excluded.reason)
    expect(sourceExclusion.message).toBe(excluded.message)
    expect(plan.candidates).toHaveLength(fixture.protocol.candidateSymbols.length)
    expect(Result.getOrThrow(reproduceJevTradingSignalBatch(observation, plan))).toEqual(plan)
    const { batchId: _, ...material } = plan
    const changedReason = Result.getOrThrow(
      makeJevBatchPlan({
        ...material,
        candidates: material.candidates.map((candidate) =>
          candidate.status === JevCandidatePlanStatus.Excluded
            ? { ...candidate, message: 'Different reason' }
            : candidate,
        ),
      }),
    )
    expect(Result.isFailure(reproduceJevTradingSignalBatch(observation, changedReason))).toBe(true)
  })

  test('uses the same complete batch contract with retained simulated snapshots', () => {
    const simulated = simulationFixture()
    const snapshot = Result.getOrThrow(constructSimulatedSnapshot(simulated.cursor, simulated.source, simulated.query))
    const observation = observationFor(snapshot)
    const plan = Result.getOrThrow(
      makeJevTradingSignalBatch({
        ...input,
        observation,
        expiresAt: new Date(Date.parse(snapshot.manifest.observedAt) + 5000).toISOString(),
      }),
    )
    expect(plan.candidates.map((candidate) => candidate.symbol)).toEqual([
      ...(snapshot.manifest.candidateSymbols ?? []),
    ])
    expect(Result.getOrThrow(reproduceJevTradingSignalBatch(observation, plan))).toEqual(plan)
    expect(Result.isFailure(reproduceJevTradingSignalBatch(input.observation, plan))).toBe(true)
  })
})
