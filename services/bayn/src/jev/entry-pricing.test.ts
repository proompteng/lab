import { defaultJevProtocolDocument } from './protocol'
import { entryInferenceFixtureLayer } from './entry-inference.test-support'
import { describe, expect, test } from 'bun:test'
import { Clock, Effect, Option, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { DecisionReadinessReason } from '../cycle/runner/readiness'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { cryptoMarketFixture } from '../testing/crypto-market-fixture'
import { jevObservationForSnapshot } from './native.test-support'
import { jevEntryPriceAllowances } from './entry-economics'
import { deriveExecutionIntentPricing } from '../execution/intent-pricing'
import { OrderSide, OrderType, TimeInForce } from '../execution/contracts'
import { orderRequestBody } from '../broker/alpaca-mutations/decisions'
import { OrderType as AlpacaOrderType, TimeInForce as AlpacaTimeInForce } from '../broker/alpaca/model'
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

const pricingFixture = (bidPrice: number, askPrice: number, bidSize = 100, askSize = 100, quoteAt?: string) => {
  const fixture = nativeJevFixture(undefined, undefined, undefined, {
    ...defaultJevProtocolDocument,
    candidateSymbols: ['AAPL'],
  })
  const retained = nativeJevDecisionEvidence(fixture)
  const batchPlan = Result.getOrThrow(
    makeJevTradingSignalBatch({
      observation: retained.observation,
      expiresAt: retained.batchPlan.expiresAt,
      planVersion: JevBatchPlanVersion.V7,
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
        quote.symbol === 'AAPL'
          ? {
              ...quote,
              bidPrice,
              askPrice,
              bidSize,
              askSize,
              ...(quoteAt === undefined ? {} : { eventAt: quoteAt, ingestedAt: quoteAt }),
            }
          : quote,
      ),
    },
    query,
  )
  return { fixture, decision, pricing: snapshot }
}

const cryptoEntryFixture = () => {
  const { snapshot } = cryptoMarketFixture('BTC/USD', { quoteSpreadBps: 2, observedPriceChoices: true })
  const observation = Result.getOrThrow(jevObservationForSnapshot(snapshot))
  const evidence = nativeJevDecisionEvidence({ observation, protocol: observation.payload.protocol })
  const decision = Result.getOrThrow(
    decideJevEntry({
      ...evidence,
      batchResult: nativeJevBatchResult(evidence.batchPlan, evidence.decidedAt, (symbol) => symbol === 'BTC/USD'),
    }),
  )
  expect(decision.selectedSymbols).toEqual(['BTC/USD'])
  return { snapshot, decision }
}

test('a crypto entry enforces its inference-ask cap through the submitted IOC limit', () => {
  const { snapshot, decision } = cryptoEntryFixture()
  const compiled = Result.getOrThrow(compileJevEntry(decision, snapshot, snapshot))
  const plan = decision.exitPolicy.plans['BTC/USD']
  const quantity = compiled.maximumBuyQuantityAtoms['BTC/USD']
  const ask = compiled.askPriceMicros['BTC/USD']
  if (plan === undefined || quantity === undefined || ask === undefined) throw new Error('Missing funded crypto terms')
  const pricing = Result.getOrThrow(
    deriveExecutionIntentPricing({
      symbol: 'BTC/USD',
      side: OrderSide.Buy,
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.ImmediateOrCancel,
      quantityAtoms: BigInt(quantity),
      referencePriceMicros: BigInt(ask),
      limitSlippageBps: BigInt(
        jevEntryPriceAllowances(decision.evidence.observation.protocol, 'BTC/USD').limitSlippageBps,
      ),
    }),
  )
  const body = Result.getOrThrow(
    orderRequestBody({
      symbol: 'BTC/USD',
      side: OrderSide.Buy,
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.ImmediateOrCancel,
      clientOrderId: 'b1_' + 'A'.repeat(43),
      quantityAtoms: quantity,
      limitPriceMicros: pricing.expectedExecutionPriceMicros.toString(),
      notionalLimitMicros: pricing.notionalLimitMicros.toString(),
    }),
  )
  expect(pricing.expectedExecutionPriceMicros.toString()).toBe(plan.levels.maximumEntryPriceMicros)
  expect(Number(body.limit_price)).toBe(Number(plan.levels.maximumEntryPriceMicros) / 1_000_000)
  expect(body.time_in_force).toBe(AlpacaTimeInForce.ImmediateOrCancel)
  expect(body.type).toBe(AlpacaOrderType.Limit)
})

test('crypto entry does not chase a fresh narrow quote above the inference ask', () => {
  const { snapshot, decision } = cryptoEntryFixture()
  const adverse = cryptoMarketFixture('BTC/USD', { quoteSpreadBps: 3, observedPriceChoices: true }).snapshot
  const compiled = compileJevEntry(decision, snapshot, adverse)
  expect(Result.isFailure(compiled)).toBe(true)
  if (Result.isFailure(compiled)) {
    expect(compiled.failure).toBeInstanceOf(JevAwaitingEvidence)
    expect(compiled.failure).toMatchObject({ message: expect.stringContaining('entry cost price ceiling') })
  }
})

describe('Jev entry execution quote eligibility', () => {
  test.each([0, -10000, 10000])('entry compilation preserves the stop boundary at offset %s micros', (offset) => {
    const original = pricingFixture(100, 100.02)
    const plan = original.decision.exitPolicy.plans['AAPL']
    if (plan === undefined) throw new Error('Missing selected fixture plan')
    const bid = (Number(plan.levels.stopPriceMicros) + offset) / 1_000_000
    const { fixture, decision, pricing } = pricingFixture(bid, bid + 0.01)
    const compiled = compileJevEntry(decision, fixture.snapshot, pricing)
    expect(Result.isSuccess(compiled)).toBe(offset > 0)
    if (Result.isFailure(compiled))
      expect(compiled.failure).toMatchObject({ readiness: DecisionReadinessReason.NoEligibleCandidate })
  })

  test('an approved entry compiles with a fresh execution quote from before the minute boundary', () => {
    const quoteAt = '2026-09-04T14:29:59.000Z'
    const { fixture, decision, pricing } = pricingFixture(100, 100.02, 100, 100, quoteAt)
    expect(decision.selectedSymbols).toEqual(['AAPL'])
    const compiled = Result.getOrThrow(compileJevEntry(decision, fixture.snapshot, pricing))
    expect(compiled.entryQuotes['AAPL']?.eventAt).toBe(quoteAt)
    expect(compiled.entryQuotes['AAPL']?.maximumAgeMs).toBeLessThanOrEqual(fixture.protocol.maximumQuoteAgeMs)
    expect(compiled.priceMicros['AAPL']).toBe('100020000')
  })

  test('a fresh narrow execution quote compiles after an eligible model decision', () => {
    const { fixture, decision, pricing } = pricingFixture(100, 100.02)
    expect(decision.selectedSymbols).toEqual(['AAPL'])
    const compiled = Result.getOrThrow(compileJevEntry(decision, fixture.snapshot, pricing))
    expect(compiled.priceMicros['AAPL']).toBe('100020000')
    expect(compiled.maximumBuyQuantityAtoms['AAPL']).toBe(decision.exitPolicy.plans['AAPL']?.maximumQuantityAtoms)
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
    const { fixture, decision, pricing } = pricingFixture(99.975, 100.025)
    expect(Result.isSuccess(compileJevEntry(decision, fixture.snapshot, pricing))).toBe(true)
  })

  test('a narrow refreshed quote above the inference-bound cost ceiling cannot enter', () => {
    const original = nativeJevFixture().snapshot.latestQuotes['AAPL']
    if (original === undefined) throw new Error('Missing fixture quote')
    const ask = original.askPrice * 1.001 + 0.02
    const { fixture, decision, pricing } = pricingFixture(ask - 0.01, ask)
    const compiled = compileJevEntry(decision, fixture.snapshot, pricing)
    expect(Result.isFailure(compiled)).toBe(true)
    if (Result.isFailure(compiled)) {
      expect(compiled.failure).toBeInstanceOf(JevAwaitingEvidence)
      if (compiled.failure instanceof JevAwaitingEvidence)
        expect(compiled.failure.message).toContain('entry cost price ceiling')
    }
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
      JevBatchPlanVersion.V7,
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
          record: () => Effect.die('Observation admission must be owned by the batch store'),
          latestJevWindowEnd: () => Effect.sync(() => latestWindow),
        }),
        Effect.provideService(JevBatchStore, {
          pending: () => Effect.succeed([]),
          read: () => unused,
          finish: () => unused,
          begin: (plan, observation) =>
            Effect.gen(function* () {
              calls.observations += 1
              latestWindow = Option.some(observation.manifest.rangeEndAt)
              calls.batches += 1
              yield* TestClock.adjust(100)
              const now = yield* Clock.currentTimeMillis
              return { plan, dispatches: [], result: nativeJevBatchResult(plan, new Date(now).toISOString()) }
            }),
        }),
        Effect.provideService(JevEvaluationStore, {
          read: () => unused,

          record: () => unused,
          abandon: () => unused,
        }),
        Effect.provideService(JevClient, { evaluate: () => unused }),
        Effect.provide(entryInferenceFixtureLayer),
        Effect.provide(TestClock.layer()),
      ),
    )
  })
})
