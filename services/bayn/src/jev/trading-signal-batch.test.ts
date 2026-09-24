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
import { JevBatchPlanVersion, JevCandidatePlanStatus, JevEntryExclusion, makeJevBatchPlan } from './batch'
import { decideJevEntry } from './decision'
import { makeJevEvaluationRequest } from './evidence'
import { nativeJevBatchResult, nativeJevFixture } from './native.test-support'
import { makeJevObservation } from './observation'
import { JevPurpose } from './portfolio'
import {
  jevEntryQuoteExclusion,
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
  planVersion: JevBatchPlanVersion.V1,
}

const nativeObservationWithWideQuotes = (
  fixture: ReturnType<typeof nativeJevFixture>,
  symbols: readonly string[],
  futurePricing?: 'quote' | 'trade',
) => {
  const quotes = new Map(fixture.cut.projection.quotes)
  const quoteHistory = new Map(fixture.cut.projection.quoteHistory)
  const trades = new Map(fixture.cut.projection.trades)
  const tradeHistory = new Map(fixture.cut.projection.tradeHistory)
  const futureAt = new Date(Date.parse(fixture.query.observedAt) + 1).toISOString()
  for (const symbol of symbols) {
    const quote = quotes.get(symbol)
    const history = quoteHistory.get(symbol)
    if (quote === undefined || history === undefined) throw new Error('Native fixture quote is missing')
    quotes.set(symbol, {
      ...quote,
      value: {
        ...quote.value,
        askPrice: quote.value.bidPrice * 1.01,
        ...(futurePricing === 'quote' ? { eventAt: futureAt } : {}),
      },
    })
    quoteHistory.set(
      symbol,
      history.map((entry) => ({
        ...entry,
        value: {
          ...entry.value,
          askPrice: entry.value.bidPrice * 1.01,
          ...(futurePricing === 'quote' ? { eventAt: futureAt } : {}),
        },
      })),
    )
    if (futurePricing === 'trade') {
      const trade = trades.get(symbol)
      const history = tradeHistory.get(symbol)
      if (trade === undefined || history === undefined) throw new Error('Native fixture trade is missing')
      trades.set(symbol, { ...trade, value: { ...trade.value, eventAt: futureAt } })
      tradeHistory.set(
        symbol,
        history.map((entry) => ({ ...entry, value: { ...entry.value, eventAt: futureAt } })),
      )
    }
  }
  const snapshot = Result.getOrThrow(
    constructStreamingSnapshot(
      { ...fixture.cut, projection: { ...fixture.cut.projection, quotes, quoteHistory, trades, tradeHistory } },
      fixture.query,
    ),
  )
  return Result.getOrThrow(
    makeJevObservation({
      cycleId: fixture.draft.identity.cycleId,
      authorityGenerationHash: 'b'.repeat(64),
      protocol: fixture.protocol,
      portfolio: fixture.portfolio,
      snapshot,
    }),
  )
}

describe('Jev trading batch source reproduction', () => {
  test('does not exclude a candidate on future-dated pricing evidence', () => {
    for (const futurePricing of ['quote', 'trade'] as const) {
      const native = nativeJevFixture()
      const observation = nativeObservationWithWideQuotes(native, ['AAPL'], futurePricing)
      const material = {
        observation: observation.payload,
        expiresAt: new Date(
          Date.parse(observation.payload.observedAt) + native.protocol.inferenceValidityMs,
        ).toISOString(),
      }
      expect(Result.isFailure(makeJevTradingSignalBatch({ ...material, planVersion: JevBatchPlanVersion.V1 }))).toBe(
        true,
      )
      expect(Result.isFailure(makeJevTradingSignalBatch({ ...material, planVersion: JevBatchPlanVersion.V2 }))).toBe(
        true,
      )
      expect(Result.isFailure(makeJevTradingSignalBatch({ ...material, planVersion: JevBatchPlanVersion.V3 }))).toBe(
        true,
      )
    }
  })

  test('excludes an entry quote that can never pass the existing spread limit without dropping its evidence', () => {
    const native = nativeJevFixture()
    const observation = nativeObservationWithWideQuotes(native, ['AAPL'])
    const plan = Result.getOrThrow(
      makeJevTradingSignalBatch({
        observation: observation.payload,
        expiresAt: new Date(
          Date.parse(observation.payload.observedAt) + native.protocol.inferenceValidityMs,
        ).toISOString(),
        planVersion: JevBatchPlanVersion.V3,
      }),
    )
    const excluded = plan.candidates.find((candidate) => candidate.symbol === 'AAPL')
    expect(plan.schemaVersion).toBe(JevBatchPlanVersion.V3)
    expect(excluded?.status).toBe(JevCandidatePlanStatus.Excluded)
    if (excluded?.status !== JevCandidatePlanStatus.Excluded) throw new Error('Missing spread exclusion')
    expect(excluded.reason).toBe(JevEntryExclusion.Spread)
    expect(plan.candidates).toHaveLength(native.protocol.candidateSymbols.length)
    expect(plan.candidates.filter((candidate) => candidate.status === JevCandidatePlanStatus.Requested)).toHaveLength(
      native.protocol.candidateSymbols.length - 1,
    )
    expect(Result.getOrThrow(reproduceJevTradingSignalBatch(observation.payload, plan))).toEqual(plan)
    const current = Result.getOrThrow(
      makeJevTradingSignalBatch({
        observation: observation.payload,
        expiresAt: plan.expiresAt,
        planVersion: JevBatchPlanVersion.V1,
      }),
    )
    expect(current.schemaVersion).toBe(JevBatchPlanVersion.V1)
    expect(current.candidates.find((candidate) => candidate.symbol === 'AAPL')?.status).toBe(
      JevCandidatePlanStatus.Requested,
    )
    const { batchId: _, ...material } = plan
    const forged = Result.getOrThrow(
      makeJevBatchPlan({
        ...material,
        candidates: plan.candidates.map((candidate) =>
          candidate.status === JevCandidatePlanStatus.Requested
            ? {
                symbol: candidate.symbol,
                status: JevCandidatePlanStatus.Excluded,
                reason: JevEntryExclusion.Spread,
                message: 'Forged spread exclusion',
              }
            : candidate,
        ),
      }),
    )
    expect(Result.isFailure(reproduceJevTradingSignalBatch(observation.payload, forged))).toBe(true)
  })

  test('a fully ineligible entry batch makes a verified no-entry decision without a model call', () => {
    const native = nativeJevFixture()
    const observation = nativeObservationWithWideQuotes(native, native.protocol.candidateSymbols)
    const at = new Date(Date.parse(observation.payload.observedAt) + 100).toISOString()
    const plan = Result.getOrThrow(
      makeJevTradingSignalBatch({
        observation: observation.payload,
        expiresAt: new Date(
          Date.parse(observation.payload.observedAt) + native.protocol.inferenceValidityMs,
        ).toISOString(),
        planVersion: JevBatchPlanVersion.V3,
      }),
    )
    expect(plan.candidates.every((candidate) => candidate.status === JevCandidatePlanStatus.Excluded)).toBe(true)
    const result = nativeJevBatchResult(plan, at)
    const decision = Result.getOrThrow(
      decideJevEntry({ observation: observation.payload, batchPlan: plan, batchResult: result, decidedAt: at }),
    )
    expect(decision.selectedSymbols).toEqual([])
    expect(Object.values(decision.targetWeights).every((weight) => weight === 0)).toBe(true)
  })

  test('a held position remains eligible for Jev management despite a wide quote', () => {
    const native = nativeJevFixture(JevPurpose.Manage)
    const observation = nativeObservationWithWideQuotes(native, ['AAPL'])
    const plan = Result.getOrThrow(
      makeJevTradingSignalBatch({
        observation: observation.payload,
        expiresAt: new Date(
          Date.parse(observation.payload.observedAt) + native.protocol.inferenceValidityMs,
        ).toISOString(),
        planVersion: JevBatchPlanVersion.V3,
      }),
    )
    expect(plan.candidates[0]?.status).toBe(JevCandidatePlanStatus.Requested)
  })

  test('entry quote eligibility uses the same exact boundary for spread and displayed size', () => {
    const quote = nativeJevFixture().snapshot.latestQuotes['AAPL']
    if (quote === undefined) throw new Error('Native fixture quote is missing')
    expect(Result.getOrThrow(jevEntryQuoteExclusion({ ...quote, askPrice: quote.bidPrice * 1.0004 }, 5))).toBeNull()
    expect(Result.getOrThrow(jevEntryQuoteExclusion({ ...quote, askPrice: quote.bidPrice * 1.0006 }, 5))).toBe(
      JevEntryExclusion.Spread,
    )
    expect(
      Result.getOrThrow(jevEntryQuoteExclusion({ ...quote, askPrice: quote.bidPrice * 1.0004, askSize: 0 }, 5)),
    ).toBe(JevEntryExclusion.DisplayedSize)
  })

  test('reproduces retained version-one native plans without rewriting their immutable identity', () => {
    const native = nativeJevFixture()
    const current = Result.getOrThrow(
      makeJevTradingSignalBatch({
        observation: native.observation.payload,
        expiresAt: new Date(
          Date.parse(native.observation.payload.observedAt) + native.protocol.inferenceValidityMs,
        ).toISOString(),
        planVersion: JevBatchPlanVersion.V1,
      }),
    )
    const { batchId: _, ...material } = current
    const retained = Result.getOrThrow(makeJevBatchPlan({ ...material, schemaVersion: JevBatchPlanVersion.V1 }))
    expect(Result.getOrThrow(reproduceJevTradingSignalBatch(native.observation.payload, retained))).toEqual(retained)
  })

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
    expect(String(excluded.reason)).toBe(sourceExclusion.reason)
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
