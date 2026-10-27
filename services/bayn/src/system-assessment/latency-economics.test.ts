import { expect, test } from 'bun:test'
import { Clock, Effect, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { AssetClass, AssetExchange, AssetStatus } from '../broker/alpaca/model'
import { normalizeAssetResult } from '../broker/alpaca/normalizers'
import { IntentState, OrderSide, OrderType, TimeInForce, type Intent } from '../execution/contracts'
import { makeReplayBroker } from '../intraday-replay/broker'
import { streamingFixture } from '../testing/streaming-market-fixture'

import { makeReplayBrokerCheckpoint, type ReplayBrokerEvidenceConfig } from '../intraday-replay/broker-checkpoint'
import { createReplayLedger } from '../intraday-replay/ledger'
import { type ReplayInferenceCall } from '../intraday-replay/inference-timing'
import { equityMarketProfile } from '../jev/markets'
import { JevResearchPolicy } from '../jev/acceptance'
import { nativeJevInference } from '../jev/native.test-support'
import { jevModel, prepareJevRequest } from '../jev/contract'
import { OperatingCostCategory, OperatingCostCoverage } from '../operating-costs'
import { assessmentFixture, testHash } from './fixtures.test-support'
import { replayRateCardFixture } from '../testing/inference-rate-card.test-support'
import { ReplaySessionCostsSchema, reproduceReplaySessionEconomics } from './latency-economics'
import { CostAllocationPlanSchema } from './cost-allocation'

const fixture = (policy: JevResearchPolicy = JevResearchPolicy.Candidate) => {
  const { input, verifiedSources } = assessmentFixture()
  const fullTariff = {
    jev: { inputMicrosPerMillionTokens: '100000000', outputMicrosPerMillionTokens: '0' },
    chart: {
      inputMicrosPerMillionTokens: '100000000',
      outputMicrosPerMillionTokens: '0',
      cachedInputMicrosPerMillionTokens: '0',
      cacheWriteInputMicrosPerMillionTokens: '0',
    },
  }
  const inferenceTariff = replayRateCardFixture({
    jev: policy === JevResearchPolicy.Candidate ? fullTariff.jev : null,
    chart: policy === JevResearchPolicy.Candidate || policy === JevResearchPolicy.Ablation ? fullTariff.chart : null,
  })
  const registration = {
    ...input.registration,
    policies: input.registration.policies.map((p) => ({
      ...p,
      inferenceRateCard: p.policy === policy ? inferenceTariff : replayRateCardFixture(fullTariff),
    })),
  }
  const definition = registration.policies.find((p) => p.policy === policy)
  const candidate = input.policies.find((p) => p.policy === policy)
  const first = registration.calendar.sessions[0]
  if (definition === undefined || candidate === undefined || first === undefined)
    throw new Error('Missing fixture policy')
  const config: ReplayBrokerEvidenceConfig = {
    runId: testHash('stress run'),
    sourceManifestHash: testHash('retained market data'),
    openingCashMicros: '100000000000',
    protocol: { ...registration.obligations.configuration.protocol, ...equityMarketProfile },
    assumptions: { latencyMs: 10, slippageBps: 0, availableLiquidityPpm: 1000000, feeMultiplierPpm: 1000000 },
    fractionalTrading: false,
    assets: [],
    calendar: registration.calendar.sessions.map((s) => ({
      date: s.sessionDate,
      open: '09:30',
      close: '09:32',
      session_open: '0930',
      session_close: '0932',
    })),
  }
  const checkpoint = Result.getOrThrow(
    makeReplayBrokerCheckpoint(
      config,
      {
        schemaVersion: 'bayn.simulated-broker-state.v7',
        createdAt: first.openAt,
        runId: config.runId,
        accountId: `replay-${config.runId}`,
        ledger: Result.getOrThrow(createReplayLedger(config.openingCashMicros)),
        orders: [],
        fills: [],
        fees: [],
        sessionCloses: registration.calendar.sessions.map((s) => ({
          sessionDate: s.sessionDate,
          equityMicros: config.openingCashMicros,
          valuationQualified: true,
        })),
      },
      input.asOf,
    ),
  )
  const costs = Schema.decodeUnknownSync(ReplaySessionCostsSchema)({
    policy,
    allocationRuleHash: definition.costAllocationRuleHash,
    asOf: input.asOf,
    inferenceCalls: [],
    inferenceTariff,
    sessions: candidate.sessions.map((session) => ({ ...session.operatingCosts, trading: null })),
  })
  const request = Result.getOrThrow(
    prepareJevRequest({
      model: jevModel,
      state: { symbol: 'AAPL' },
      questions: { enter: { type: 'noul', instructions: 'Assess retained market information.' } },
    }),
  )
  const call: ReplayInferenceCall = {
    schemaVersion: 'bayn.replay-inference-call.v2',
    stage: 'JEV',
    request: request.request,
    requestHash: request.requestHash,
    budgetMs: 1000,
    simulatedStartedAt: first.openAt,
    providerStartedAt: first.openAt,
    providerCompletedAt: first.openAt,
    outcome: { status: 'RECEIVED', inference: nativeJevInference(request.request, first.openAt) },
  }
  const evaluate = (value: unknown = costs, retained: unknown = checkpoint) =>
    reproduceReplaySessionEconomics(registration, config, retained, value, verifiedSources)
  return { input, registration, config, checkpoint, costs, call, evaluate, verifiedSources }
}

test('zero-trade stress retains every registered session and produces a fully costed operating loss', () => {
  for (const policy of Object.values(JevResearchPolicy)) {
    const f = fixture(policy)
    const result = Result.getOrThrow(f.evaluate())
    expect(result.complete).toBe(true)
    expect(result.evidenceMode).toBe('COUNTERFACTUAL')
    expect(result.sessions).toHaveLength(20)
    expect(result.sessions.map((s) => s.sessionDate)).toEqual(
      f.registration.calendar.sessions.map((s) => s.sessionDate),
    )
    for (const session of result.sessions) {
      expect(session.executionPnlMicros).toBe('0')
      expect(session.netEconomicPnlMicros).toBe('-15000000')
      expect(session.qualificationPnlMicros).toBe('-15000000')
    }
  }
})

test('actual replay fills and fees reconcile to cash while all twenty sessions retain their operating expenses', async () => {
  const f = fixture()
  const first = f.registration.calendar.sessions[0]
  const original = streamingFixture().snapshot.quotes.find((quote) => quote.symbol === 'AAPL')
  if (first === undefined || original === undefined) throw new Error('Missing execution fixture')
  const config = {
    ...f.config,
    assumptions: { ...f.config.assumptions, latencyMs: 0 },
    assets: [
      Result.getOrThrow(
        normalizeAssetResult(
          {
            id: '12345678-1234-4234-8234-123456789abc',
            symbol: 'AAPL',
            class: AssetClass.UsEquity,
            exchange: AssetExchange.Nasdaq,
            status: AssetStatus.Active,
            tradable: true,
            fractionable: true,
          },
          'AAPL',
          first.openAt,
        ),
      ),
    ],
  }
  const checkpoint = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(first.openAt) - 60_000)
      let price = 100
      const broker = yield* makeReplayBroker({
        ...config,
        quoteAt: () =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis
            const instant = new Date(at).toISOString()
            const value = {
              ...original,
              eventAt: instant,
              ingestedAt: instant,
              bidPrice: price,
              askPrice: price,
              bidSize: 100,
              askSize: 100,
            }
            return { value, availableAtMs: at, sequence: price, recordHash: testHash(value) }
          }),
      })
      yield* TestClock.setTime(Date.parse(first.openAt))
      const buy: Intent = {
        schemaVersion: 'bayn.execution-intent.v5',
        intentId: testHash('buy'),
        riskDecisionId: testHash('risk'),
        authorityGenerationHash: testHash('authority'),
        cycleId: testHash('cycle'),
        decisionHash: testHash('decision'),
        policyHash: testHash('policy'),
        strategyName: 'intraday-momentum',
        accountId: broker.accountId,
        clientOrderId: 'replay-buy',
        symbol: 'AAPL',
        side: OrderSide.Buy,
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.Day,
        quantityAtoms: '5000000000',
        notionalLimitMicros: '500000000',
        limitPriceMicros: '100000000',
        state: IntentState.IoStarted,
        createdAt: first.openAt,
      }
      yield* broker.mutation.submit(buy)
      price = 101
      yield* TestClock.adjust(1000)
      yield* broker.mutation.submit({
        ...buy,
        intentId: testHash('sell'),
        clientOrderId: 'replay-sell',
        side: OrderSide.Sell,
        limitPriceMicros: '101000000',
        notionalLimitMicros: '505000000',
      })
      for (const session of f.registration.calendar.sessions) {
        yield* TestClock.setTime(Date.parse(session.closeAt))
        yield* broker.valuationAt(session.closeAt)
      }
      return yield* broker.checkpoint
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  )
  const result = Result.getOrThrow(
    reproduceReplaySessionEconomics(f.registration, config, checkpoint, f.costs, f.verifiedSources),
  )
  expect(checkpoint.state.fills).toHaveLength(2)
  const net = BigInt(checkpoint.state.ledger.cashMicros) - BigInt(config.openingCashMicros)
  expect(net).toBe(5000000n - BigInt(checkpoint.state.ledger.executionFeesMicros))
  expect(result.sessions[0]?.executionPnlMicros).toBe(net.toString())
  expect(net).toBeGreaterThan(0n)
  expect(BigInt(result.sessions[0]?.netEconomicPnlMicros ?? '0')).toBeLessThan(0n)
  expect(result.sessions.reduce((sum, session) => sum + BigInt(session.qualificationPnlMicros ?? '0'), 0n)).toBe(
    net - 300000000n,
  )
  expect(result.complete).toBe(true)
})

test('invoice consumption replaces estimates while qualification uses the larger amount exactly once', () => {
  const f = fixture()
  const first = f.costs.sessions[0]
  const invoice = first?.consumption[0]
  if (first === undefined || invoice === undefined) throw new Error('Missing cost fixture')
  for (const amount of ['2000', '20000']) {
    const sourceHash = testHash(`inference invoice source ${amount}`)
    f.verifiedSources.add(sourceHash)
    const inference = {
      ...invoice,
      documentId: testHash(`inference invoice ${amount}`),
      category: OperatingCostCategory.Inference,
      sourceHash,
      grossAmountMicros: amount,
      allocations: invoice.allocations.map((allocation) => ({ ...allocation, amountMicros: amount })),
    }
    const result = Result.getOrThrow(
      f.evaluate({
        ...f.costs,
        inferenceCalls: [f.call],
        sessions: [
          { ...first, consumption: [...first.consumption, inference, inference] },
          ...f.costs.sessions.slice(1),
        ],
      }),
    )
    const session = result.sessions[0]
    expect(session?.netEconomicPnlMicros).toBe(String(-15000000n - BigInt(amount)))
    expect(session?.qualificationPnlMicros).toBe(
      String(-15000000n - (BigInt(amount) > 10000n ? BigInt(amount) : 10000n)),
    )
  }
})

test('missing consumption and unresolved calls cannot establish complete stress economics', () => {
  const f = fixture()
  const missing = Result.getOrThrow(
    f.evaluate({
      ...f.costs,
      sessions: f.costs.sessions.map((session) => ({
        ...session,
        coverage: session.coverage.map((coverage) =>
          coverage.category === OperatingCostCategory.Infrastructure
            ? { ...coverage, status: OperatingCostCoverage.Unknown, sourceHash: null }
            : coverage,
        ),
      })),
    }),
  )
  expect(missing.complete).toBe(false)
  expect(missing.sessions.every((s) => s.netEconomicPnlMicros === null && s.qualificationPnlMicros === null)).toBe(true)
  const unknown = Result.getOrThrow(
    f.evaluate({ ...f.costs, inferenceCalls: [{ ...f.call, outcome: { status: 'INTERRUPTED' } }] }),
  )
  expect(unknown.complete).toBe(false)
  expect(unknown.sessions[0]?.netEconomicPnlMicros).toBe('-15000000')
  expect(unknown.sessions[0]?.qualificationPnlMicros).toBeNull()
})

test('replay economics require a consistent invoice allocation map and every allocated session', () => {
  const f = fixture()
  const first = f.costs.sessions[0]
  const invoice = first?.consumption[0]
  if (first === undefined || invoice === undefined) throw new Error('Missing cost fixture')
  const sourceHash = testHash('one replay invoice for twenty sessions')
  f.verifiedSources.add(sourceHash)
  const shared = {
    ...invoice,
    documentId: sourceHash,
    sourceHash,
    serviceStartDate: first.sessionDate,
    serviceEndDateExclusive: '2026-12-01',
    grossAmountMicros: '300000000',
    allocations: f.costs.sessions.map((session) => ({
      accountBindingHash: session.accountBindingHash,
      sessionDate: session.sessionDate,
      amountMicros: '15000000',
      sourceHash,
    })),
  }
  const consistent = {
    ...f.costs,
    sessions: f.costs.sessions.map((session) => ({ ...session, consumption: [shared] })),
  }
  const basisSourceHash = testHash('prospectively reviewed shared monthly invoice basis')
  f.verifiedSources.add(basisSourceHash)
  const registration = {
    ...f.registration,
    costAllocationPlans: [
      ...f.registration.costAllocationPlans,
      Schema.decodeUnknownSync(CostAllocationPlanSchema)({
        provider: shared.provider,
        category: shared.category,
        serviceStartDate: shared.serviceStartDate,
        serviceEndDateExclusive: shared.serviceEndDateExclusive,
        basisSourceHash,
        weights: shared.allocations.map((allocation) => ({
          accountBindingHash: allocation.accountBindingHash,
          sessionDate: allocation.sessionDate,
          weight: '1',
        })),
      }),
    ],
  }
  const evaluate = (value: unknown) =>
    reproduceReplaySessionEconomics(registration, f.config, f.checkpoint, value, f.verifiedSources)
  const result = Result.getOrThrow(evaluate(consistent))
  expect(result.complete).toBe(true)
  expect(result.sessions.reduce((sum, session) => sum + BigInt(session.qualificationPnlMicros ?? '0'), 0n)).toBe(
    -300000000n,
  )
  const omitted = {
    ...consistent,
    sessions: consistent.sessions.map((session, index) => (index === 1 ? { ...session, consumption: [] } : session)),
  }
  const moved = {
    ...consistent,
    sessions: consistent.sessions.map((session, index) => {
      const next = consistent.sessions[(index + 1) % consistent.sessions.length]
      if (next === undefined) throw new Error('Missing cost session')
      return {
        ...session,
        consumption: [
          {
            ...shared,
            allocations: [
              {
                accountBindingHash: next.accountBindingHash,
                sessionDate: next.sessionDate,
                amountMicros: '300000000',
                sourceHash,
              },
            ],
          },
        ],
      }
    }),
  }
  for (const invalid of [omitted, moved]) {
    const failure = evaluate(invalid)
    expect(Result.isFailure(failure)).toBe(true)
    if (Result.isFailure(failure))
      expect(failure.failure.cause).toMatchObject({
        _tag: 'OperatingCostError',
        message: expect.stringContaining('Operating-cost window'),
      })
  }
  const retuned = {
    ...consistent,
    sessions: consistent.sessions.map((session) => ({
      ...session,
      consumption: [
        {
          ...shared,
          allocations: shared.allocations.map((allocation, index) => ({
            ...allocation,
            amountMicros: index === 0 ? shared.grossAmountMicros : '0',
          })),
        },
      ],
    })),
  }
  const retunedResult = evaluate(retuned)
  expect(Result.isFailure(retunedResult)).toBe(true)
  if (Result.isFailure(retunedResult))
    expect(retunedResult.failure.cause).toMatchObject({
      _tag: 'OperatingCostError',
      message: 'Invoice allocation differs from its prospectively registered weights',
    })
})

test('changed cash, fees, marks, session membership, cost scope and inference occurrence are rejected', () => {
  const f = fixture()
  const resign = (state: typeof f.checkpoint.state) => {
    const { checkpointHash: _, ...material } = { ...f.checkpoint, state }
    return { ...material, checkpointHash: testHash(material) }
  }
  for (const state of [
    { ...f.checkpoint.state, ledger: { ...f.checkpoint.state.ledger, cashMicros: '100001000000' } },
    {
      ...f.checkpoint.state,
      ledger: { ...f.checkpoint.state.ledger, executionFeesMicros: '0', netRealizedPnlAfterCostsMicros: '1000' },
    },
    { ...f.checkpoint.state, sessionCloses: f.checkpoint.state.sessionCloses.slice(1) },
    { ...f.checkpoint.state, sessionCloses: [...f.checkpoint.state.sessionCloses].reverse() },
    {
      ...f.checkpoint.state,
      sessionCloses: f.checkpoint.state.sessionCloses.map((s) => ({ ...s, equityMicros: '100001000000' })),
    },
  ])
    expect(Result.isFailure(f.evaluate(f.costs, resign(state)))).toBe(true)
  for (const costs of [
    { ...f.costs, allocationRuleHash: testHash('different rule') },
    { ...f.costs, sessions: f.costs.sessions.slice(1) },
    { ...f.costs, sessions: [...f.costs.sessions].reverse() },
    { ...f.costs, sessions: f.costs.sessions.map((s) => ({ ...s, asOf: '2026-11-01T00:00:00.000Z' })) },
    { ...f.costs, sessions: f.costs.sessions.map((s) => ({ ...s, accountBindingHash: testHash('other account') })) },
    {
      ...f.costs,
      sessions: f.costs.sessions.map((s) => ({
        ...s,
        trading: { sourceHash: testHash('invented trade'), netPnlAfterExecutionFeesMicros: '1000000' },
      })),
    },
    { ...f.costs, inferenceCalls: [f.call, f.call] },
    { ...f.costs, inferenceCalls: [{ ...f.call, simulatedStartedAt: '2026-12-01T01:00:00.000Z' }] },
    { ...f.costs, inferenceCalls: [{ ...f.call, requestHash: testHash('another request') }] },
  ])
    expect(Result.isFailure(f.evaluate(costs))).toBe(true)
})
