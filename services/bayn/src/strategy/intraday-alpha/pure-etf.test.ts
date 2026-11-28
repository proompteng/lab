import { expect, test } from 'bun:test'
import { Effect, Option, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { MarketCalendarObservationSchema } from '../../broker/alpaca/model'
import { normalizeMarketCalendarResult } from '../../broker/alpaca/normalizers'
import { BrokerAccess, grantedCapitalAuthority } from '../../execution/authority'
import { IntentState, OrderSide, OrderStatus, OrderType, TimeInForce } from '../../execution/contracts'
import { IntentStore, type StoredIntent } from '../../execution/intents/domain'
import { MutationOperation } from '../../broker/alpaca-mutations/model'
import { MutationEventType, MutationStore } from '../../execution/mutations/model'
import { JevContractError } from '../../jev/contract'
import { decideJevExit, JevExitReason, oppositeAlphaBandCrossed } from '../../jev/exit'
import { canonicalHashV1Result } from '../../hash'
import { currentProtectionEvidenceVersion, decodeJevPortfolio, JevPositionStore, JevPurpose } from '../../jev/portfolio'
import { jevPricingQuery } from '../../jev/runtime'
import { IntradaySnapshotPurpose } from '../../market-data/intraday/model'
import { persistIntradayRecordRows } from '../../market-data/intraday/verification'
import { constructStreamingSnapshot } from '../../market-data/streaming/snapshot'
import { reconciledStateHash } from '../../simulation-reconciliation/broker-model'
import { pureEtfCheckpointMinutes } from '../../market-data/intraday/trailing-baseline'
import { executionCycleCloseSchedule } from '../../observe-composition/execution-window'
import { advancePositionProtection } from '../../observe-composition/position-protection-interpreter'
import { loadActiveStrategyProtocol } from '../../strategy'
import { nativeAlphaDecisionFixture } from './alpha-decision.test-support'
import { actualAlphaProtectionPrices } from './exit-plan'
import { makeOwnedIntradayAlphaObservation, reproduceIntradayAlphaObservation } from './observation'
import { makeIntradayAlphaEntryQuery } from './runtime'
import { extractIntradayAlphaCandidates, selectIntradayAlphaLegs } from './signals'
import { makeAlphaStreamingSnapshot, makeFlatAlphaPortfolio, makeTestTrailingBaseline } from './test-support'

const policy = Result.getOrThrow(loadActiveStrategyProtocol())
const regular = {
  QQQ: { basePrice: 500, endReturnBps: 200 },
  SMH: { basePrice: 250, endReturnBps: 180 },
  AAPL: { basePrice: 200, endReturnBps: 4000 },
}

const halfDay = Schema.decodeUnknownSync(MarketCalendarObservationSchema)(
  Result.getOrThrow(
    normalizeMarketCalendarResult(
      [{ session_open: '0800', session_close: '1400', date: '2026-11-27', open: '09:30', close: '13:00' }],
      { start: '2026-11-27', end: '2026-11-27' },
    ),
  ),
)

test('native v3 decision funds only whole-share QQQ/SMH orders at 25 bp and preserves the exact policy identity', async () => {
  const { document, jevCalls, riskPolicy } = await nativeAlphaDecisionFixture({
    pureEtf: true,
    snapshot: { minutesFromOpen: 30, profiles: regular, quoteSpreadBps: 6 },
  })
  const target = document.strategyDecision
  if (target?.schemaVersion !== 'bayn.intraday-alpha-target.v3') throw new Error('Missing v3 target')
  expect(target.selectedSymbols).toEqual(['QQQ', 'SMH'])
  expect(Object.keys(target.targetWeights)).toEqual(['QQQ', 'SMH'])
  expect(target.targetWeights['QQQ']).toBe(0.65)
  expect(target.targetWeights['SMH']).toBe(0.2)
  const observation = target.evidence.observation
  expect(observation.schemaVersion).toBe('bayn.intraday-alpha-observation.v3')
  expect(
    Result.isFailure(
      reproduceIntradayAlphaObservation({
        ...observation,
        rows: { ...observation.rows, bars: [...observation.rows.bars].reverse() },
      }),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      reproduceIntradayAlphaObservation({
        ...observation,
        rows: { ...observation.rows, bars: observation.rows.bars.slice(1) },
      }),
    ),
  ).toBe(true)
  expect(document.entryLimitSlippageBps).toBe(25)
  expect(document.orderedIntentIds).toHaveLength(2)
  expect(riskPolicy.maxGrossExposureMicros).toBe('180000000000')
  expect(jevCalls).toBe(0)
  const plan = target.exitPolicy.plans['QQQ']
  if (plan === undefined || !('maximumEntryPriceMicros' in plan.levels)) throw new Error('Missing long plan')
  expect(plan.levels.maximumEntryPriceMicros).toBe('511270000')
  expect(BigInt(plan.maximumQuantityAtoms) % 1_000_000_000n).toBe(0n)
  expect(plan.levels.fillAnchored).toMatchObject({ stopBps: 299, collarBps: 50, profitBps: 1500 })
  const fills = [
    { symbol: 'QQQ', side: OrderSide.Buy, priceAtoms: '509000000000', quantityAtoms: '8000000000' },
    { symbol: 'QQQ', side: OrderSide.Buy, priceAtoms: '511000000000', quantityAtoms: '12000000000' },
  ]
  expect(Result.getOrThrow(actualAlphaProtectionPrices(plan, fills))).toEqual({
    stopPriceMicros: '494940000',
    stopLimitPriceMicros: '492400000',
    profitLimitPriceMicros: '586730000',
  })
  expect(target.exitPolicy.plans['SMH']?.levels.fillAnchored?.collarBps).toBe(150)
})

test('30-minute slots enforce 1.4× gap-aware bands, do not fall back to single stocks and floor volatility', () => {
  const { snapshot } = makeAlphaStreamingSnapshot({
    pureEtf: true,
    minutesFromOpen: 30,
    profiles: { ...regular, QQQ: { ...regular.QQQ, endReturnBps: 50 } },
  })
  const input = {
    snapshot,
    policy,
    accountId: 'alpha-test-account',
    trailingBaseline: {
      ...makeTestTrailingBaseline(),
      symbols: {
        QQQ: {
          priorSessions: 14,
          prevClose: 500,
          atr14Ratio: 0.01,
          sessionVolatility: 0,
          avgSwingByCheckpoint: { '30': 0.004 },
        },
        SMH: {
          priorSessions: 14,
          prevClose: 250,
          atr14Ratio: 0.01,
          sessionVolatility: 0.002,
          avgSwingByCheckpoint: { '30': 0.004 },
        },
      },
    },
  }
  const candidates = Result.getOrThrow(extractIntradayAlphaCandidates(input))
  expect(candidates.longPool.map((candidate) => candidate.symbol)).toEqual(['SMH'])
  expect(selectIntradayAlphaLegs({ ...candidates, policy, vetoedSymbols: new Set() })[0]?.targetWeight).toBe(0.3333)
  const offGrid = { ...snapshot, manifest: { ...snapshot.manifest, rangeEndAt: '2026-09-04T14:01:00.000Z' } }
  expect(Result.getOrThrow(extractIntradayAlphaCandidates({ ...input, snapshot: offGrid })).longPool).toEqual([])
})

test.each(['SPY', 'SMH'])('premature %s publication fails the observation rather than omitting the row', (symbol) => {
  const { snapshot, observedAt } = makeAlphaStreamingSnapshot({
    pureEtf: true,
    minutesFromOpen: 30,
    profiles: regular,
    prematureSymbol: symbol,
  })
  const result = makeOwnedIntradayAlphaObservation({
    schemaVersion: 'bayn.intraday-alpha-observation.v3',
    cycleId: 'a'.repeat(64),
    authorityGenerationHash: 'b'.repeat(64),
    protocol: policy.sharedProtocol,
    portfolio: makeFlatAlphaPortfolio(observedAt),
    trailingBaseline: { ...makeTestTrailingBaseline(), symbols: {} },
    snapshot,
  })
  expect(Result.isFailure(result) && result.failure instanceof JevContractError && result.failure.message).toBe(
    'Pure ETF observation contains premature completed-bar evidence',
  )
})

test('the half-day has a 12:30 ET last entry and a 12:58 ET mandatory flatten', async () => {
  const { cycle, document, rangeEndAt } = await nativeAlphaDecisionFixture({
    pureEtf: true,
    calendar: halfDay,
    snapshot: { minutesFromOpen: 180, profiles: regular, quoteSpreadBps: 6 },
  })
  expect(rangeEndAt).toBe('2026-11-27T17:30:00.000Z')
  expect(document.orderedIntentIds).toHaveLength(2)
  const schedule = executionCycleCloseSchedule(cycle, document, policy.sharedProtocol)
  expect(schedule.executionCloseAt).toBe('2026-11-27T18:00:00.000Z')
  expect(new Date(Date.parse(schedule.executionCloseAt) - schedule.sessionCloseStartLeadMs).toISOString()).toBe(
    '2026-11-27T17:58:00.000Z',
  )
  expect(
    Result.isFailure(
      makeIntradayAlphaEntryQuery({
        policy,
        calendar: halfDay,
        sessionDate: '2026-11-27',
        observedAtMs: Date.parse('2026-11-27T17:31:10.000Z'),
      }),
    ),
  ).toBe(true)
})

test('a held long exits below the open/previous-close anchor even when checkpoint noise is zero', async () => {
  const { document } = await nativeAlphaDecisionFixture({
    pureEtf: true,
    snapshot: { minutesFromOpen: 30, profiles: regular, quoteSpreadBps: 6 },
  })
  const target = document.strategyDecision
  if (target?.schemaVersion !== 'bayn.intraday-alpha-target.v3') throw new Error('Missing v3 target')
  const plan = target.exitPolicy.plans['QQQ']
  if (plan?.schemaVersion !== 'bayn.intraday-alpha-long-funded-exit-plan.v1' || plan.levels.fillAnchored === undefined)
    throw new Error('Missing v3 long plan')
  const withZeroNoise = {
    ...plan,
    levels: {
      ...plan.levels,
      fillAnchored: {
        ...plan.levels.fillAnchored,
        previousClose: 501,
        checkpointSwings: Object.fromEntries(pureEtfCheckpointMinutes.map((minute) => [String(minute), 0])),
      },
    },
  }
  const { snapshot } = makeAlphaStreamingSnapshot({
    pureEtf: true,
    minutesFromOpen: 60,
    profiles: { ...regular, QQQ: { ...regular.QQQ, overrideLatestClose: 499.99 } },
  })
  expect(Result.getOrThrow(oppositeAlphaBandCrossed(snapshot, withZeroNoise))).toBe(true)
})

test('a completed SMH opposite-band break authorizes only that leg while QQQ protection stays armed', async () => {
  const {
    cycle,
    document,
    reconciliation: baseReconciliation,
    riskPolicy,
    strategy,
  } = await nativeAlphaDecisionFixture({
    pureEtf: true,
    snapshot: { minutesFromOpen: 30, profiles: regular, quoteSpreadBps: 6 },
  })
  const target = document.strategyDecision
  if (target?.schemaVersion !== 'bayn.intraday-alpha-target.v3') throw new Error('Missing alpha target')
  const { cut, observedAt, snapshot } = makeAlphaStreamingSnapshot({
    pureEtf: true,
    minutesFromOpen: 60,
    profiles: { ...regular, SMH: { ...regular.SMH, overrideLatestClose: 245 } },
  })
  const { brokerState } = makeFlatAlphaPortfolio(observedAt)
  const accountId = brokerState.account.accountId
  const entryFills = target.selectedSymbols.map((symbol, index) => ({
    schemaVersion: 'bayn.fill.v2' as const,
    accountId,
    fillId: `fill-${index}`,
    brokerOrderId: `order-${index}`,
    clientOrderId: `client-${index}`,
    intentId: document.orderedIntentIds[index] ?? '',
    symbol,
    side: OrderSide.Buy,
    quantityAtoms: '1000000000',
    priceAtoms: symbol === 'SMH' ? '252000000000' : '506000000000',
    feeMicros: '0',
    occurredAt: '2026-09-04T14:00:09.000Z',
  }))
  const qqqPlan = target.exitPolicy.plans['QQQ']
  if (qqqPlan === undefined) throw new Error('Missing QQQ plan')
  const qqqProtection = Result.getOrThrow(actualAlphaProtectionPrices(qqqPlan, entryFills))
  const protectionIntentId = 'e'.repeat(64)
  const material = {
    account: brokerState.account,
    positions: entryFills.map((fill) => {
      const entry = (BigInt(fill.priceAtoms) / 1_000n).toString()
      return {
        schemaVersion: 'bayn.position.v2' as const,
        accountId,
        symbol: fill.symbol,
        quantityAtoms: fill.quantityAtoms,
        averageEntryPriceMicros: entry,
        costBasisMicros: entry,
        marketPriceMicros: entry,
        marketValueMicros: entry,
        unrealizedPnlMicros: '0',
        observedAt,
      }
    }),
    positionsObservedAt: observedAt,
    orders: [
      ...entryFills.map((fill) => ({
        schemaVersion: 'bayn.order.v3' as const,
        accountId,
        brokerOrderId: fill.brokerOrderId,
        clientOrderId: fill.clientOrderId,
        intentId: fill.intentId,
        symbol: fill.symbol,
        side: OrderSide.Buy,
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.Day,
        quantityAtoms: fill.quantityAtoms,
        filledQuantityAtoms: fill.quantityAtoms,
        limitPriceMicros: (BigInt(fill.priceAtoms) / 1_000n).toString(),
        status: OrderStatus.Filled,
        observedAt,
      })),
      {
        schemaVersion: 'bayn.order.v3' as const,
        accountId,
        brokerOrderId: 'qqq-stop',
        clientOrderId: 'qqq-stop-id',
        intentId: protectionIntentId,
        symbol: 'QQQ',
        side: OrderSide.Sell,
        orderType: OrderType.StopLimit,
        timeInForce: TimeInForce.Day,
        quantityAtoms: '1000000000',
        filledQuantityAtoms: '0',
        limitPriceMicros: qqqProtection.stopLimitPriceMicros,
        stopPriceMicros: qqqProtection.stopPriceMicros,
        status: OrderStatus.New,
        observedAt,
      },
    ],
    ordersObservedAt: observedAt,
    accountingHash: brokerState.accountingHash,
  }
  const stateHash = Result.getOrThrow(reconciledStateHash(material))
  const reconciliation = {
    ...brokerState.reconciliation,
    expectedHash: stateHash,
    observedHash: stateHash,
  }
  const { contentHash: _oldHash, reconciliationId: _oldId, ...receipt } = reconciliation
  const withId = { ...receipt, reconciliationId: Result.getOrThrow(canonicalHashV1Result(receipt)) }
  const managed = Result.getOrThrow(
    decodeJevPortfolio({
      purpose: JevPurpose.Manage,
      protectionEvidenceVersion: currentProtectionEvidenceVersion,
      managedSymbol: 'SMH',
      brokerState: {
        ...material,
        unknownOrderCount: 0,
        reconciliation: { ...withId, contentHash: Result.getOrThrow(canonicalHashV1Result(withId)) },
      },
      entryDecisionHash: document.contentHash,
      exitPolicy: target.exitPolicy,
      entryIntentIds: document.orderedIntentIds.toSorted(),
      protectionIntentIds: [protectionIntentId],
      entryFills,
      entryInventoryDebit: { quantityAtoms: '0', costBasisMicros: '0' },
      protectionDisposals: { quantityAtoms: '0', costBasisMicros: '0' },
      exitRequestedAt: null,
      profitExitRequested: false,
    }),
  )
  const query = Result.getOrThrow(
    jevPricingQuery(
      cycle,
      policy.sharedProtocol,
      snapshot.manifest.calendar,
      observedAt,
      ['SMH'],
      IntradaySnapshotPurpose.PositionCheckpoint,
    ),
  )
  const pricing = Result.getOrThrow(constructStreamingSnapshot(cut, query))
  const evidence = {
    cycleId: cycle.identity.cycleId,
    sessionDate: cycle.identity.executionSessionDate,
    protocol: policy.sharedProtocol,
    observedAt,
    portfolio: managed,
    symbol: 'SMH',
    trigger: {
      reason: JevExitReason.OppositeBandExit,
      manifest: pricing.manifest,
      rows: Result.getOrThrow(persistIntradayRecordRows(pricing)),
    },
  }
  const exit = Result.getOrThrow(decideJevExit(evidence))
  expect(exit.reason).toBe(JevExitReason.OppositeBandExit)
  expect(exit.targetWeights).toEqual({ SMH: 0 })
  expect(Result.isFailure(decideJevExit({ ...evidence, symbol: 'QQQ' }))).toBe(true)

  // Regression: advancePositionProtection must request PositionCheckpoint so streaming inputs supply the completed bar.
  const observedPurposes: (IntradaySnapshotPurpose | undefined)[] = []
  const unused = () => Effect.die('Unexpected protection operation')
  const qqqStoredProtection: StoredIntent = {
    intent: {
      schemaVersion: 'bayn.execution-intent.v5',
      intentId: protectionIntentId,
      strategyName: 'jev',
      clientOrderId: 'qqq-stop-id',
      cycleId: cycle.identity.cycleId,
      accountId,
      authorityGenerationHash: document.bindings.authorityGenerationHash,
      decisionHash: document.contentHash,
      policyHash: document.bindings.policyHash,
      symbol: 'QQQ',
      side: OrderSide.Sell,
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.Day,
      quantityAtoms: '1000000000',
      limitPriceMicros: qqqProtection.profitLimitPriceMicros,
      notionalLimitMicros: qqqProtection.profitLimitPriceMicros,
      protection: {
        _tag: 'Oco',
        stopPriceMicros: qqqProtection.stopPriceMicros,
        stopLimitPriceMicros: qqqProtection.stopLimitPriceMicros,
        profitLimitPriceMicros: qqqProtection.profitLimitPriceMicros,
        entryDecisionHash: document.contentHash,
      },
      createdAt: '2026-09-04T14:00:10.000Z',
      state: IntentState.Acknowledged,
    },
    stateVersion: 2,
    updatedAt: '2026-09-04T14:00:10.000Z',
  }
  const qqqProfitOrder = {
    schemaVersion: 'bayn.order.v3' as const,
    accountId,
    brokerOrderId: 'qqq-profit',
    clientOrderId: 'qqq-profit-id',
    intentId: protectionIntentId,
    symbol: 'QQQ',
    side: OrderSide.Sell,
    orderType: OrderType.Limit,
    timeInForce: TimeInForce.Day,
    quantityAtoms: '1000000000',
    filledQuantityAtoms: '0',
    limitPriceMicros: qqqProtection.profitLimitPriceMicros,
    status: OrderStatus.New,
    observedAt,
  }
  const materialWithOco = {
    ...material,
    orders: [...material.orders, qqqProfitOrder].toSorted((left, right) =>
      left.brokerOrderId.localeCompare(right.brokerOrderId),
    ),
  }
  const ocoStateHash = Result.getOrThrow(reconciledStateHash(materialWithOco))
  const ocoReceipt = { ...receipt, expectedHash: ocoStateHash, observedHash: ocoStateHash }
  const ocoWithId = { ...ocoReceipt, reconciliationId: Result.getOrThrow(canonicalHashV1Result(ocoReceipt)) }
  const brokerStateWithOco = {
    ...materialWithOco,
    unknownOrderCount: 0,
    reconciliation: { ...ocoWithId, contentHash: Result.getOrThrow(canonicalHashV1Result(ocoWithId)) },
  }
  const managedBySymbol = (symbol: string) => {
    const decoded = Result.getOrThrow(
      decodeJevPortfolio({
        ...managed,
        brokerState: brokerStateWithOco,
        managedSymbol: symbol,
      }),
    )
    if (decoded.purpose !== JevPurpose.Manage) throw new Error('Expected managed portfolio')
    return decoded
  }
  const protectionResult = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(observedAt))
      return yield* advancePositionProtection({
        input: {
          accountId,
          authorityGenerationHash: document.bindings.authorityGenerationHash,
          reconciliationIntervalMs: 30_000,
          reconciliationPassTimeoutMs: 30_000,
          strategy,
          intradayMarketData: {
            check: Effect.void,
            verifyReference: unused,
            loadSnapshot: (request) => {
              observedPurposes.push(request.purpose)
              return Effect.succeed(Result.getOrThrow(constructStreamingSnapshot(cut, request)))
            },
          },
        },
        cycle,
        document,
        protocol: policy.sharedProtocol,
        policy: riskPolicy,
        reconciliation: {
          ...baseReconciliation,
          brokerState: brokerStateWithOco,
          report: { ...baseReconciliation.report, reconciliation: brokerStateWithOco.reconciliation },
          riskContext: {
            ...baseReconciliation.riskContext,
            authority: { ...baseReconciliation.riskContext.authority, updatedAt: observedAt },
            authorityObservedAt: observedAt,
          },
        },
        closeDue: false,
        closeExpiresAt: '2026-09-04T20:00:00.000Z',
        capability: {
          _tag: 'Mutation',
          executionProgram: {
            _tag: 'ExecutionProgram',
            schemaVersion: 'bayn.execution-program.v1',
            authority: {
              brokerAccess: BrokerAccess.Mutation,
              brokerIdentity: baseReconciliation.riskContext.brokerIdentity,
              capitalAuthority: grantedCapitalAuthority(document.bindings.authorityGenerationHash),
              strategy: strategy.provenance.strategy,
            },
            recordReconciliation: unused,
            invalidateBrokerState: unused(),
            dryRunSubmit: unused,
            submit: unused,
            submitProtectionClose: unused,
            cancel: unused,
            recover: unused,
            cancelProtectionOrder: unused,
          },
        },
      })
    }).pipe(
      Effect.provideService(IntentStore, {
        read: () => Effect.succeed(Option.none()),
        protectionForCycle: () => Effect.succeed([qqqStoredProtection]),
        beginProtectionCancel: unused,
        recordProtectionCancelAccepted: unused,
        commit: unused,
      }),
      Effect.provideService(MutationStore, {
        latest: (intentId, operation) =>
          Effect.succeed(
            intentId === protectionIntentId && operation === MutationOperation.Submit
              ? {
                  schemaVersion: 'bayn.paper-mutation-event.v1' as const,
                  eventId: 'a'.repeat(64),
                  mutationId: 'b'.repeat(64),
                  intentId: protectionIntentId,
                  sequence: 2,
                  operation: MutationOperation.Submit,
                  eventType: MutationEventType.SubmitAccepted,
                  requestHash: 'c'.repeat(64),
                  consistencyDelayMs: 1_000,
                  brokerOrderId: 'qqq-stop',
                  occurredAt: '2026-09-04T14:00:10.000Z',
                }
              : undefined,
          ),
        authorizeSubmit: unused,
        beginSubmit: unused,
        submitAccepted: unused,
        submitRejected: unused,
        submitDenied: unused,
        submitUnknown: unused,
        beginCancel: unused,
        cancelAccepted: unused,
        cancelUnknown: unused,
        recoveryFound: unused,
        recoveryNotFound: unused,
        recoveryUnknown: unused,
      }),
      Effect.provideService(JevPositionStore, {
        read: ({ managedSymbol }) => Effect.succeed(managedBySymbol(managedSymbol ?? 'SMH')),
      }),
      Effect.provide(TestClock.layer()),
    ),
  )
  expect(observedPurposes).toContain(IntradaySnapshotPurpose.PositionCheckpoint)
  expect(observedPurposes).not.toContain(IntradaySnapshotPurpose.Liquidation)
  expect(protectionResult).toMatchObject({
    _tag: 'Ready',
    exitTarget: { reason: JevExitReason.OppositeBandExit, targetWeights: { SMH: 0 } },
  })
})

test('short protection is anchored above the actual fill and capped at 150 bp', async () => {
  const { document } = await nativeAlphaDecisionFixture({
    pureEtf: true,
    snapshot: {
      minutesFromOpen: 30,
      profiles: { ...regular, SMH: { ...regular.SMH, endReturnBps: -200 } },
      quoteSpreadBps: 6,
    },
  })
  const target = document.strategyDecision
  if (target?.schemaVersion !== 'bayn.intraday-alpha-target.v3') throw new Error('Missing v3 strategy target')
  const plan = target.exitPolicy.plans['SMH']
  if (plan?.schemaVersion !== 'bayn.intraday-alpha-short-funded-exit-plan.v1')
    throw new Error('Missing native short plan')
  expect(target.targetWeights['SMH']).toBe(-0.2)
  expect(
    Result.getOrThrow(
      actualAlphaProtectionPrices(plan, [
        {
          symbol: 'SMH',
          side: OrderSide.Sell,
          quantityAtoms: '10000000000',
          priceAtoms: '246000000000',
        },
      ]),
    ),
  ).toEqual({
    stopPriceMicros: '260760000',
    stopLimitPriceMicros: '264450000',
    profitLimitPriceMicros: '209100000',
  })
})
