import { describe, expect, test } from 'bun:test'
import { Clock, Effect, Fiber, Logger, Option, References, Result, Tracer } from 'effect'
import { TestClock } from 'effect/testing'
import { NodeServices } from '@effect/platform-node'

import { CycleState, type AutonomousCycle } from '../cycle/model'
import { retryableOperationalError } from '../errors'
import { type IntradayMarketDataService } from '../market-data/intraday/model'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import { streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { JevBatchExpired, JevBatchStore } from './batch-evaluation'
import { JevClient } from './client'
import { JevEvaluationStore } from './evaluation'
import { JevExitReason } from './exit'
import { nativeJevFixture } from './native.test-support'
import { JevPositionStore, JevPurpose } from './portfolio'
import { evaluateJevObservation, evaluateJevPositionManagement } from './runtime'
import { utcInstantFromEpochMillis } from '../time'
import { reconciledStateHash } from '../simulation-reconciliation/broker-model'
import { defaultJevProtocolDocument } from './protocol'
import { jevHoldingMinutesForSymbol } from './markets'

const scenario = (
  options: {
    readonly premium?: number
    readonly observedAt?: string
    readonly firstFillAt?: string
    readonly laterFillAt?: string
    readonly symbol?: string
    readonly brokerEvidenceAgeMs?: number
    readonly pricingUnavailable?: boolean
    readonly stalledPricing?: boolean
    readonly pricingCleanupDelayMs?: number
    readonly advanceMs?: number
  } = {},
) => {
  const fixture = nativeJevFixture(JevPurpose.Manage, options.observedAt ?? '2026-09-04T14:30:32.000Z')
  const original = fixture.portfolio
  if (original.purpose !== JevPurpose.Manage) throw new Error('Expected held-position fixture')
  const at = utcInstantFromEpochMillis(
    Date.parse(fixture.observation.payload.observedAt) - (options.brokerEvidenceAgeMs ?? 0),
  )
  const material = {
    ...original.brokerState,
    account: { ...original.brokerState.account, observedAt: at },
    positions: original.brokerState.positions.map((position) => ({
      ...position,
      observedAt: at,
      symbol: options.symbol ?? position.symbol,
    })),
    orders: original.brokerState.orders.map((order) => ({
      ...order,
      observedAt: at,
      symbol: options.symbol ?? order.symbol,
    })),
    positionsObservedAt: at,
    ordersObservedAt: at,
  }
  const hash = Result.getOrThrow(reconciledStateHash(material))
  const symbol = options.symbol ?? 'AAPL'
  const planned = original.exitPolicy.plans['AAPL']
  if (planned === undefined) throw new Error('Expected an immutable entry plan')
  const firstFillAt = options.firstFillAt ?? original.entryFills[0]?.occurredAt
  if (firstFillAt === undefined) throw new Error('Expected first entry fill')
  const sourceEnd = Math.floor(Date.parse(firstFillAt) / 60_000) * 60_000
  const portfolio = {
    ...original,
    exitPolicy: {
      ...original.exitPolicy,
      plans: {
        [symbol]: {
          ...planned,
          levels: {
            ...planned.levels,
            symbol,
            maximumHoldingMinutes: jevHoldingMinutesForSymbol(fixture.protocol, symbol),
            sourceEndAt: utcInstantFromEpochMillis(sourceEnd),
            sourceStartAt: utcInstantFromEpochMillis(sourceEnd - fixture.protocol.lookbackMinutes * 60_000),
          },
        },
      },
    },
    brokerState: {
      ...material,
      reconciliation: {
        ...original.brokerState.reconciliation,
        reconciledAt: at,
        expectedHash: hash,
        observedHash: hash,
      },
    },
    entryFills: original.entryFills.map((fill, index) => ({
      ...fill,
      symbol: options.symbol ?? fill.symbol,
      occurredAt: (index === 0 ? options.firstFillAt : options.laterFillAt) ?? fill.occurredAt,
    })),
  }
  const cycle: AutonomousCycle = {
    ...fixture.draft,
    state: CycleState.Active,
    bindings: {},
    stateVersion: 1,
    createdAt: fixture.observation.payload.observedAt,
    updatedAt: fixture.observation.payload.observedAt,
  }
  let pricing = 0
  let interrupted = 0
  const marketData: IntradayMarketDataService = {
    check: Effect.void,
    verifyReference: () => Effect.die('Unexpected reference read'),
    loadSnapshot: (query) =>
      Effect.gen(function* () {
        if (query.purpose === undefined)
          return yield* Effect.die('Position management must not load signals or call Jev')
        pricing++
        if (options.pricingUnavailable)
          return yield* retryableOperationalError({
            component: 'market-data',
            operation: 'snapshot',
            message: 'execution quote unavailable',
          })
        if (options.stalledPricing)
          return yield* Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                interrupted++
                if (options.pricingCleanupDelayMs !== undefined) yield* TestClock.adjust(options.pricingCleanupDelayMs)
              }),
            ),
          )
        return streamingFixtureFromRaw(
          makeIntradayMomentumTestSnapshot(
            fixture.protocol,
            { ...query, archiveWatermarks: [] },
            { AAPL: options.premium ?? 0.002 },
          ),
          query,
        ).snapshot
      }),
  }
  const program = evaluateJevPositionManagement({
    cycle,
    entryDecisionHash: portfolio.entryDecisionHash,
    authorityGenerationHash: fixture.observation.payload.authorityGenerationHash,
    protocol: fixture.protocol,
    calendar: fixture.snapshot.manifest.calendar,
    brokerState: portfolio.brokerState,
    marketData,
  }).pipe(Effect.provideService(JevPositionStore, { read: () => Effect.succeed(portfolio) }))
  const run = () =>
    Effect.runPromise(
      TestClock.setTime(Date.parse(fixture.observation.payload.observedAt)).pipe(
        Effect.andThen(
          options.advanceMs === undefined
            ? program
            : Effect.gen(function* () {
                const fiber = yield* program.pipe(Effect.forkChild({ startImmediately: true }))
                yield* TestClock.adjust(options.advanceMs ?? 0)
                return yield* Fiber.join(fiber)
              }),
        ),
        Effect.provide(TestClock.layer()),
        Effect.provide(NodeServices.layer),
      ),
    )
  return { run, pricingCalls: () => pricing, interruptions: () => interrupted }
}

describe('entry-bound native position exits', () => {
  test.each([
    [-0.02, JevExitReason.ProtectiveStop],
    [0.051, JevExitReason.ProfitTarget],
  ] as const)('a premium of %f triggers %s without any model or inference store', async (premium, reason) => {
    const check = scenario({ premium })
    expect(await check.run()).toMatchObject({ _tag: 'Exit', target: { reason, targetWeights: { AAPL: 0 } } })
    expect(check.pricingCalls()).toBe(1)
  })
  test.each([-0.002, 0, 0.002, 0.009])(
    'a position between its stop and net target is held at premium %f',
    async (premium) => {
      const check = scenario({ premium })
      expect(await check.run()).toMatchObject({ _tag: 'Wait', details: { waitReason: 'JEV_POSITION_HELD' } })
      expect(check.pricingCalls()).toBe(1)
    },
  )
  test('partial entry fills retain the deadline of the first actual fill', async () => {
    const check = scenario({ firstFillAt: '2026-09-04T14:15:39.000Z', laterFillAt: '2026-09-04T14:27:32.000Z' })
    expect(await check.run()).toMatchObject({
      _tag: 'Wait',
      details: { maximumHoldDueAt: '2026-09-04T14:30:39.000Z', maximumHoldEvaluatedAt: '2026-09-04T14:30:32.000Z' },
    })
  })
  test('a missing price does not lose the entry-bound deadline', async () => {
    const check = scenario({ pricingUnavailable: true, firstFillAt: '2026-09-04T14:15:39.000Z' })
    expect(await check.run()).toMatchObject({
      _tag: 'Wait',
      details: { maximumHoldDueAt: '2026-09-04T14:30:39.000Z', readiness: { reason: 'SNAPSHOT_UNAVAILABLE' } },
    })
  })
  test('the maximum hold exits without price history or any model dependency', async () => {
    const check = scenario({ firstFillAt: '2026-09-04T14:15:32.000Z', pricingUnavailable: true })
    expect(await check.run()).toMatchObject({ _tag: 'Exit', target: { reason: JevExitReason.MaximumHold } })
    expect(check.pricingCalls()).toBe(0)
  })
  test('an overdue position with stale broker evidence awaits reconciliation', async () => {
    const check = scenario({ firstFillAt: '2026-09-04T14:15:32.000Z', brokerEvidenceAgeMs: 60_000 })
    expect(await check.run()).toMatchObject({
      _tag: 'Wait',
      details: { waitReason: 'JEV_POSITION_AWAITING_RECONCILIATION' },
    })
    expect(check.pricingCalls()).toBe(0)
  })
  test('the holding deadline interrupts stalled pricing and still closes', async () => {
    const check = scenario({ stalledPricing: true, firstFillAt: '2026-09-04T14:15:39.000Z', advanceMs: 7_000 })
    expect(await check.run()).toMatchObject({
      _tag: 'Exit',
      target: { reason: JevExitReason.MaximumHold, observedAt: '2026-09-04T14:30:39.000Z' },
    })
    expect(check.interruptions()).toBe(1)
  })
  test('expired pricing waits for fresh evidence without using a model', async () => {
    const check = scenario({ stalledPricing: true, advanceMs: 10_000 })
    expect(await check.run()).toMatchObject({
      _tag: 'Wait',
      details: { readiness: { reason: 'SNAPSHOT_UNAVAILABLE' } },
    })
    expect(check.interruptions()).toBe(1)
  })
  test('slow pricing cleanup cannot authorize an overdue exit from stale reconciliation', async () => {
    const check = scenario({
      stalledPricing: true,
      pricingCleanupDelayMs: 60_000,
      firstFillAt: '2026-09-04T14:15:39.000Z',
      advanceMs: 7_000,
    })
    expect(await check.run()).toMatchObject({
      _tag: 'Wait',
      details: {
        waitReason: 'JEV_POSITION_AWAITING_RECONCILIATION',
        maximumHoldDueAt: '2026-09-04T14:30:39.000Z',
      },
    })
    expect(check.interruptions()).toBe(1)
  })
  test('the completed-minute boundary preserves the holding deadline', async () => {
    const check = scenario({ observedAt: '2026-09-04T14:30:00.000Z', firstFillAt: '2026-09-04T14:15:07.000Z' })
    expect(await check.run()).toMatchObject({
      _tag: 'Wait',
      details: { maximumHoldDueAt: '2026-09-04T14:30:07.000Z', readiness: { reason: 'LOOKBACK_WARMUP' } },
    })
    expect(check.pricingCalls()).toBe(0)
  })
  for (const symbol of ['BTC/USD', 'ETH/USD', 'SOL/USD']) {
    test(`${symbol} retains its entry-bound sixty-minute deadline after fifteen minutes`, async () => {
      const check = scenario({ symbol, firstFillAt: '2026-09-04T14:15:32.000Z', pricingUnavailable: true })
      expect(await check.run()).toMatchObject({
        _tag: 'Wait',
        details: { maximumHoldDueAt: '2026-09-04T15:15:32.000Z' },
      })
    })
    test(`${symbol} exits at sixty minutes without market data or inference`, async () => {
      const check = scenario({ symbol, firstFillAt: '2026-09-04T13:30:32.000Z', pricingUnavailable: true })
      expect(await check.run()).toMatchObject({
        _tag: 'Exit',
        target: { reason: JevExitReason.MaximumHold, symbols: [symbol] },
      })
      expect(check.pricingCalls()).toBe(0)
    })
    test(`${symbol} cannot close at sixty minutes with stale broker evidence`, async () => {
      const check = scenario({ symbol, firstFillAt: '2026-09-04T13:30:32.000Z', brokerEvidenceAgeMs: 60_000 })
      expect(await check.run()).toMatchObject({
        _tag: 'Wait',
        details: { waitReason: 'JEV_POSITION_AWAITING_RECONCILIATION' },
      })
      expect(check.pricingCalls()).toBe(0)
    })
  }
  for (const symbol of ['BTC/USD', 'ETH/USD', 'SOL/USD']) {
    test(`${symbol} recovers an overdue prior-day position without market data or Jev`, async () => {
      const check = scenario({ symbol, firstFillAt: '2026-09-03T23:50:00.000Z', pricingUnavailable: true })
      expect(await check.run()).toMatchObject({
        _tag: 'Exit',
        target: { reason: JevExitReason.MaximumHold, symbols: [symbol] },
      })
      expect(check.pricingCalls()).toBe(0)
    })
  }
})

describe('entry observation admission', () => {
  test.each([
    [JevPurpose.Entry, 'current', defaultJevProtocolDocument],
    [JevPurpose.Manage, 'current', defaultJevProtocolDocument],
    [JevPurpose.Entry, 'single-candidate', { ...defaultJevProtocolDocument, candidateSymbols: ['AAPL'] }],
  ] as const)(
    '%s %s retains typed expiry and structured admission diagnostics',
    async (purpose, _label, protocolDocument) => {
      const fixture = nativeJevFixture(purpose, '2026-09-04T14:30:32.000Z', undefined, protocolDocument)
      const spans: Tracer.NativeSpan[] = []
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      const logs: { message: unknown; annotations: Readonly<Record<string, unknown>> }[] = []
      const logger = Logger.make(({ message, fiber }) => {
        logs.push({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) })
      })
      const result = await Effect.runPromise(
        TestClock.setTime(Date.parse(fixture.observation.payload.observedAt)).pipe(
          Effect.andThen(
            evaluateJevObservation({
              cycleId: fixture.observation.payload.cycleId,
              authorityGenerationHash: fixture.observation.payload.authorityGenerationHash,
              protocol: fixture.protocol,
              portfolio: fixture.portfolio,
              snapshot: fixture.snapshot,
            }),
          ),
          Effect.result,
          Effect.provideService(CandidateObservationStore, {
            record: () => Effect.die('Observation admission must be owned by the batch store'),
            latestJevWindowEnd: () => Effect.succeed(Option.none()),
          }),
          Effect.provideService(JevBatchStore, {
            pending: () => Effect.succeed([]),
            read: () => Effect.die('No batch was recorded'),
            finish: () => Effect.die('An expired admission cannot finalize an unrecorded batch'),
            begin: (plan) =>
              TestClock.adjust(fixture.protocol.inferenceValidityMs + 100).pipe(
                Effect.andThen(Clock.currentTimeMillis),
                Effect.flatMap((now) =>
                  Effect.fail(
                    new JevBatchExpired({
                      batchId: plan.batchId,
                      cycleId: plan.cycleId,
                      observedAt: plan.observedAt,
                      expiresAt: plan.expiresAt,
                      checkedAt: utcInstantFromEpochMillis(now),
                    }),
                  ),
                ),
              ),
          }),
          Effect.provideService(JevEvaluationStore, {
            read: () => Effect.die('No request can exist'),

            record: () => Effect.die('No inference can be recorded'),
            abandon: () => Effect.die('No inference can be abandoned'),
          }),
          Effect.provideService(JevClient, { evaluate: () => Effect.die('No provider call is allowed') }),
          Effect.provide(TestClock.layer()),
          Effect.provide(Logger.layer([logger])),
          Effect.provide(NodeServices.layer),
          Effect.provideService(Tracer.Tracer, tracer),
        ),
      )
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result))
        expect(result.failure).toMatchObject({ _tag: 'JevAwaitingEvidence', readiness: 'INFERENCE_UNAVAILABLE' })
      const warning = logs.find(
        ({ message }) => Array.isArray(message) && message[0] === 'Jev observation expired before batch admission',
      )
      expect(warning?.annotations).toMatchObject({
        batchId: expect.stringMatching(/^[0-9a-f]{64}$/),
        cycleId: fixture.observation.payload.cycleId,
        observedAt: fixture.observation.payload.observedAt,
        expiresAt: utcInstantFromEpochMillis(
          Date.parse(fixture.observation.payload.observedAt) + fixture.protocol.inferenceValidityMs,
        ),
        checkedAt: utcInstantFromEpochMillis(
          Date.parse(fixture.observation.payload.observedAt) + fixture.protocol.inferenceValidityMs + 100,
        ),
        admissionLagMs: fixture.protocol.inferenceValidityMs + 100,
      })
      const planning = spans.find((span) => span.name === 'bayn.jev.batch-plan')
      expect(planning?.attributes.get('bayn.entry_timing.input_available_at')).toBe(
        fixture.observation.payload.observedAt,
      )
      expect(planning?.attributes.get('bayn.entry_timing.snapshot_hash')).toBe(fixture.snapshot.manifest.contentHash)
      expect(planning?.attributes.get('bayn.entry_timing.batch_id')).toMatch(/^[0-9a-f]{64}$/)
      expect(planning?.attributes.get('bayn.entry_timing.observation_hash')).toBe(fixture.observation.contentHash)
      if (purpose === JevPurpose.Entry)
        expect(planning?.attributes.get('bayn.entry_timing.deterministic_selected_at')).toBe(
          fixture.observation.payload.observedAt,
        )
      else expect(planning?.attributes.has('bayn.entry_timing.deterministic_selected_at')).toBe(false)
    },
  )
})
