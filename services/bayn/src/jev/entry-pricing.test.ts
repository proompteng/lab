import { describe, expect, test } from 'bun:test'
import { Clock, Effect, Option, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { DecisionReadinessReason } from '../cycle/runner/readiness'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { JevBatchPlanVersion } from './batch'
import { JevBatchStore } from './batch-evaluation'
import { JevClient } from './client'
import { decideJevEntry } from './decision'
import { JevEvaluationStore } from './evaluation'
import { nativeJevBatchResult, nativeJevDecisionEvidence, nativeJevFixture } from './native.test-support'
import {
  compileJevEntry,
  evaluateJevObservationFromSnapshot,
  JevAwaitingEvidence,
  JevAwaitingFreshWindow,
  jevPricingQuery,
} from './runtime'
import { makeJevTradingSignalBatch } from './trading-signals'

const pricingFixture = (bidPrice: number, askPrice: number, bidSize = 100, askSize = 100) => {
  const fixture = nativeJevFixture()
  const retained = nativeJevDecisionEvidence(fixture)
  const batchPlan = Result.getOrThrow(
    makeJevTradingSignalBatch({
      observation: retained.observation,
      expiresAt: retained.batchPlan.expiresAt,
      planVersion: JevBatchPlanVersion.V3,
    }),
  )
  const decision = Result.getOrThrow(
    decideJevEntry({
      ...retained,
      batchPlan,
      batchResult: nativeJevBatchResult(batchPlan, retained.decidedAt),
    }),
  )
  const pricingAt = new Date(Date.parse(decision.decidedAt) + 100).toISOString()
  const query = Result.getOrThrow(
    jevPricingQuery(fixture.draft, fixture.protocol, fixture.snapshot.manifest.calendar, pricingAt, ['AAPL']),
  )
  const { snapshot } = streamingFixtureFromRaw(
    {
      ...fixture.snapshot,
      quotes: fixture.snapshot.quotes.map((quote) =>
        quote.symbol === 'AAPL' ? { ...quote, bidPrice, askPrice, bidSize, askSize } : quote,
      ),
    },
    query,
  )
  return { fixture, decision, pricing: snapshot }
}

describe('Jev entry execution quote eligibility', () => {
  test('a fresh narrow execution quote compiles after an eligible model decision', () => {
    const { fixture, decision, pricing } = pricingFixture(100, 100.02)
    expect(decision.selectedSymbols).toEqual(['AAPL'])
    const compiled = Result.getOrThrow(compileJevEntry(decision, fixture.snapshot, pricing))
    expect(compiled.priceMicros['AAPL']).toBe('100020000')
    expect(compiled.maximumBuyQuantityMicros['AAPL']).toBe('100000000')
  })

  test.each([
    ['spread widens', 100, 100.06, 100, 100],
    ['bid liquidity disappears', 100, 100.02, 0, 100],
    ['ask liquidity disappears', 100, 100.02, 100, 0],
  ] as const)('an eligible signal cannot admit a refreshed quote when %s', (_, bid, ask, bidSize, askSize) => {
    const { fixture, decision, pricing } = pricingFixture(bid, ask, bidSize, askSize)
    expect(decision.selectedSymbols).toEqual(['AAPL'])
    const compiled = compileJevEntry(decision, fixture.snapshot, pricing)
    expect(Result.isFailure(compiled)).toBe(true)
    if (!Result.isFailure(compiled)) throw new Error('Expected entry to wait for a qualifying execution quote')
    expect(compiled.failure).toBeInstanceOf(JevAwaitingEvidence)
    expect(compiled.failure).toMatchObject({ readiness: DecisionReadinessReason.NoEligibleCandidate })
    expect(decision.selectedSymbols).toEqual(['AAPL'])
  })

  test('the existing exact spread boundary remains eligible', () => {
    const { fixture, decision, pricing } = pricingFixture(199.95, 200.05)
    expect(Result.isSuccess(compileJevEntry(decision, fixture.snapshot, pricing))).toBe(true)
  })

  test('a rejected execution quote cannot reopen its consumed signal window', async () => {
    const { fixture, pricing } = pricingFixture(100, 100.06)
    let latestWindow = Option.none<string>()
    const calls = { snapshots: 0, observations: 0, batches: 0 }
    const unused = Effect.die('Unexpected provider or evaluation mutation')
    const attempt = evaluateJevObservationFromSnapshot(
      {
        cycleId: fixture.observation.payload.cycleId,
        authorityGenerationHash: fixture.observation.payload.authorityGenerationHash,
        protocol: fixture.protocol,
        portfolio: fixture.portfolio,
      },
      fixture.snapshot.manifest.rangeEndAt,
      Effect.sync(() => {
        calls.snapshots += 1
        return fixture.snapshot
      }),
    ).pipe(
      Effect.flatMap(({ snapshot, evidence }) =>
        Effect.fromResult(decideJevEntry(evidence)).pipe(
          Effect.flatMap((decision) => Effect.fromResult(compileJevEntry(decision, snapshot, pricing))),
        ),
      ),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(fixture.observation.payload.observedAt))
        const first = yield* Effect.result(attempt)
        expect(Result.isFailure(first)).toBe(true)
        if (!Result.isFailure(first)) throw new Error('Expected rejected execution pricing')
        expect(first.failure).toBeInstanceOf(JevAwaitingEvidence)
        for (let retry = 0; retry < 3; retry += 1) {
          yield* TestClock.adjust(1000)
          const repeated = yield* Effect.result(attempt)
          expect(Result.isFailure(repeated)).toBe(true)
          if (!Result.isFailure(repeated)) throw new Error('Expected consumed signal window')
          expect(repeated.failure).toBeInstanceOf(JevAwaitingFreshWindow)
          expect(repeated.failure).toMatchObject({ availableAt: '2026-09-04T14:31:02.000Z' })
        }
        expect(calls).toEqual({ snapshots: 1, observations: 1, batches: 1 })
      }).pipe(
        Effect.provideService(CandidateObservationStore, {
          record: (observation) =>
            Effect.sync(() => {
              calls.observations += 1
              latestWindow = Option.some(observation.payload.manifest.rangeEndAt)
            }),
          latestJevWindowEnd: () => Effect.sync(() => latestWindow),
        }),
        Effect.provideService(JevBatchStore, {
          pending: () => Effect.succeed([]),
          read: () => unused,
          finish: () => unused,
          begin: (plan) =>
            Effect.gen(function* () {
              calls.batches += 1
              yield* TestClock.adjust(100)
              const now = yield* Clock.currentTimeMillis
              return { plan, result: nativeJevBatchResult(plan, new Date(now).toISOString()) }
            }),
        }),
        Effect.provideService(JevEvaluationStore, {
          read: () => unused,
          begin: () => unused,
          record: () => unused,
          abandon: () => unused,
        }),
        Effect.provideService(JevClient, { evaluate: () => unused }),
        Effect.provide(TestClock.layer()),
      ),
    )
  })
})
