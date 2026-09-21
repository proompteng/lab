import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1 } from '../hash'
import { constructSimulatedSnapshot, constructStreamingSnapshot } from '../market-data/streaming/snapshot'
import { candidateObservationFixture } from '../testing/candidate-observation-fixture'
import { simulationFixture } from '../testing/simulated-streaming-fixture'
import { JevCandidatePlanStatus, makeJevBatchPlan } from './batch'
import { makeJevEvaluationRequest } from './evidence'
import {
  makeJevTradingSignalBatch,
  makeJevTradingSignalRequest,
  reproduceJevTradingSignalBatch,
} from './trading-signals'

const fixture = candidateObservationFixture()
const input = {
  snapshot: fixture.snapshot,
  cycleId: fixture.input.cycleId,
  authorityGenerationHash: fixture.input.authorityGenerationHash,
  observationHash: fixture.observation.contentHash,
  protocolHash: canonicalHashV1(fixture.protocol),
  expiresAt: new Date(Date.parse(fixture.input.observedAt) + 5000).toISOString(),
  benchmarkSymbol: fixture.protocol.benchmarkSymbol,
}

describe('Jev trading batch source reproduction', () => {
  test('freezes the entire recorded universe and reproduces each exact request', () => {
    const plan = Result.getOrThrow(makeJevTradingSignalBatch(input))
    expect(plan.candidates.map((candidate) => candidate.symbol)).toEqual([...fixture.protocol.candidateSymbols])
    for (const candidate of plan.candidates) {
      if (candidate.status !== JevCandidatePlanStatus.Requested) throw new Error('Expected complete fixture')
      const prepared = Result.getOrThrow(
        makeJevTradingSignalRequest(input.snapshot, candidate.symbol, input.benchmarkSymbol),
      )
      expect(candidate.request.requestHash).toBe(prepared.requestHash)
    }
    expect(Result.getOrThrow(reproduceJevTradingSignalBatch(input.snapshot, JSON.parse(JSON.stringify(plan))))).toEqual(
      plan,
    )
  })

  test('a correctly rehashed plan cannot omit a losing candidate or change model input', () => {
    const { batchId: _, ...material } = Result.getOrThrow(makeJevTradingSignalBatch(input))
    const omitted = Result.getOrThrow(makeJevBatchPlan({ ...material, candidates: material.candidates.slice(1) }))
    expect(Result.isFailure(reproduceJevTradingSignalBatch(input.snapshot, omitted))).toBe(true)
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
    expect(Result.isFailure(reproduceJevTradingSignalBatch(input.snapshot, altered))).toBe(true)
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
    const plan = Result.getOrThrow(makeJevTradingSignalBatch({ ...input, snapshot }))
    const excluded = plan.candidates.find((candidate) => candidate.symbol === 'NVDA')
    expect(excluded?.status).toBe(JevCandidatePlanStatus.Excluded)
    if (excluded?.status !== JevCandidatePlanStatus.Excluded) throw new Error('Missing source exclusion')
    const sourceExclusion = snapshot.manifest.candidateExclusions?.[0]
    if (sourceExclusion === undefined) throw new Error('Missing source exclusion fixture')
    expect(sourceExclusion.symbol).toBe(excluded.symbol)
    expect(sourceExclusion.reason).toBe(excluded.reason)
    expect(sourceExclusion.message).toBe(excluded.message)
    expect(plan.candidates).toHaveLength(fixture.protocol.candidateSymbols.length)
    expect(Result.getOrThrow(reproduceJevTradingSignalBatch(snapshot, plan))).toEqual(plan)
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
    expect(Result.isFailure(reproduceJevTradingSignalBatch(snapshot, changedReason))).toBe(true)
  })

  test('uses the same complete batch contract with retained simulated snapshots', () => {
    const simulated = simulationFixture()
    const snapshot = Result.getOrThrow(constructSimulatedSnapshot(simulated.cursor, simulated.source, simulated.query))
    const plan = Result.getOrThrow(
      makeJevTradingSignalBatch({
        ...input,
        snapshot,
        expiresAt: new Date(Date.parse(snapshot.manifest.observedAt) + 5000).toISOString(),
      }),
    )
    expect(plan.candidates.map((candidate) => candidate.symbol)).toEqual([
      ...(snapshot.manifest.candidateSymbols ?? []),
    ])
    expect(Result.getOrThrow(reproduceJevTradingSignalBatch(snapshot, plan))).toEqual(plan)
    expect(Result.isFailure(reproduceJevTradingSignalBatch(input.snapshot, plan))).toBe(true)
  })
})
