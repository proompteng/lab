import { describe, expect, test } from 'bun:test'

import { Effect, Exit, Result, Schema } from 'effect'

import {
  CycleState,
  isIntradayCycleDraft,
  makeCycleDraft,
  makeCycleExecutionPolicyFromModel,
  makeCycleIdentity,
  makeExecutionCalendarObservation,
  makeIntradayCycleWindow,
  type IntradayAutonomousCycle,
} from './cycle'
import {
  AccountStatus,
  Authority,
  KillState,
  OrderType,
  ReconciliationStatus,
  RiskOutcome,
  TimeInForce,
  type AccountSnapshot,
  type Reconciliation,
} from './execution/contracts'
import { makeExecutionIntentFromDecodedPlan } from './execution/intents/domain'
import { legacyIntentPlanSchemaVersion } from './execution/legacy-wire'
import { bindCycleExecutionSession } from './execution-session'
import { canonicalHashV1 } from './hash'
import { IntradaySnapshotPurpose, persistIntradaySnapshotRows, type IntradaySnapshotRequest } from './market-data'
import { reconciledStateHash } from './reconciliation'
import { BrokerMode, Gate, PolicySchema, Reason, decodeState, evaluate, type Policy } from './risk'
import { strictParseOptions } from './schemas'
import {
  buildExecutionDecision,
  buildObserveShadowDecision,
  type ObserveShadowDecisionInput,
  type ShadowDeltaRiskInput,
} from './shadow-decision'
import {
  decodeExecutionDecisionDocument,
  decodeObserveShadowDecisionDocument,
  ExecutionMarketDataBindingSchema,
  makeExecutionDecisionDocument,
  type ExecutionMarketDataBinding,
} from './shadow-decision-contract'
import { decideIntradayMomentum, deriveIntradayMomentumSignalMetrics } from './strategy/intraday-momentum/decision'
import {
  decodeDefaultIntradayMomentumProtocol,
  intradayMomentumExecutionModel,
  intradayMomentumSnapshotSymbols,
} from './strategy/intraday-momentum/protocol'
import { makeIntradayMomentumTestSnapshot } from './strategy/intraday-momentum/test-support'
import {
  intradaySnapshotReferencePricesSchemaVersion,
  planTargets,
  quoteBoundTargetPlannerInputSchemaVersion,
  TargetPlanStatus,
  type QuoteBoundTargetPlannerInput,
} from './target-planner'

const hash = (character: string): string => character.repeat(64)
const accountId = 'paper-account-1'
const sessionDate = '2026-08-18' as const
const observedAt = '2026-08-18T16:00:02.000Z'
const brokerObservedAt = '2026-08-18T16:00:00.000Z'
const accountingHash = hash('a')

const value = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

const calendarMaterial = {
  schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
  source: 'alpaca-v2-calendar' as const,
  requestedRange: { start: sessionDate, end: sessionDate },
  timeZone: 'UTC' as const,
  sessions: [
    {
      date: sessionDate,
      openAt: '2026-08-18T13:30:00.000Z',
      closeAt: '2026-08-18T20:00:00.000Z',
    },
  ],
}
const calendar = Object.freeze({ ...calendarMaterial, normalizedResponseHash: canonicalHashV1(calendarMaterial) })

const protocol = value(decodeDefaultIntradayMomentumProtocol())

const activeCycle = (): IntradayAutonomousCycle => {
  const session = calendar.sessions[0]
  if (session === undefined) throw new Error('intraday test calendar requires one session')
  const executionCalendar = value(
    makeExecutionCalendarObservation({
      schemaVersion: calendar.schemaVersion,
      source: calendar.source,
      ...session,
    }),
  )
  const executionPolicy = value(makeCycleExecutionPolicyFromModel(intradayMomentumExecutionModel))
  if (executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3') {
    throw new Error('intraday execution must derive a v3 cycle policy')
  }
  const identity = value(
    makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v3',
      strategyName: 'intraday-momentum',
      qualificationRunId: hash('1'),
      strategyProtocolHash: hash('2'),
      accountId,
      executionSessionDate: sessionDate,
      executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
      executionCalendarSource: executionCalendar.executionCalendarSource,
      executionCalendarHash: executionCalendar.executionCalendarHash,
      executionPolicy,
    }),
  )
  const window = value(makeIntradayCycleWindow(executionCalendar, executionPolicy))
  const draft = value(makeCycleDraft(identity, window))
  if (!isIntradayCycleDraft(draft)) throw new Error('intraday cycle must use v3')
  return {
    ...draft,
    state: CycleState.Active,
    bindings: {},
    stateVersion: 1,
    createdAt: '2026-08-18T13:00:00.000Z',
    updatedAt: window.submissionOpenAt,
  }
}

const snapshotRequest = (): IntradaySnapshotRequest => ({
  sessionDate,
  calendar,
  rangeStartAt: '2026-08-18T15:30:00.000Z',
  rangeEndAt: '2026-08-18T16:00:00.000Z',
  observedAt,
  universeId: protocol.universeId,
  universeSymbolHash: protocol.universeSymbolHash,
  universe: protocol.universe,
  symbols: intradayMomentumSnapshotSymbols(protocol),
  feed: protocol.feed,
  delayClass: protocol.delayClass,
  sourceTopics: protocol.sourceTopics,
  maximumQuoteAgeMs: protocol.maximumQuoteAgeMs,
  minimumWatermarkLagMs: protocol.decisionDelaySeconds * 1_000,
  archiveWatermarks: Object.values(protocol.sourceTopics)
    .sort()
    .map((sourceTopic) => ({ sourceTopic, sourcePartition: 0, inclusiveLastOffset: '1000' })),
})

const executionMarketData = (
  snapshot = makeIntradayMomentumTestSnapshot(protocol, snapshotRequest()),
): ExecutionMarketDataBinding => {
  const { schemaVersion: snapshotSchemaVersion, ...material } = snapshot.manifest
  return Schema.decodeUnknownSync(
    ExecutionMarketDataBindingSchema,
    strictParseOptions,
  )({
    schemaVersion: 'bayn.execution-market-data-binding.v2',
    snapshotSchemaVersion,
    ...material,
  })
}

const brokerState = () => {
  const account: AccountSnapshot = {
    schemaVersion: 'bayn.paper-account-snapshot.v1',
    accountId,
    status: AccountStatus.Active,
    currency: 'USD',
    cashMicros: '100000000000',
    equityMicros: '100000000000',
    buyingPowerMicros: '100000000000',
    observedAt: brokerObservedAt,
  }
  const positions = [] as const
  const orders = [] as const
  const stateHash = value(
    reconciledStateHash({
      account,
      positions,
      positionsObservedAt: brokerObservedAt,
      orders,
      ordersObservedAt: brokerObservedAt,
      accountingHash,
    }),
  )
  const reconciliationMaterial = {
    schemaVersion: 'bayn.paper-reconciliation.v1' as const,
    accountId,
    expectedHash: stateHash,
    observedHash: stateHash,
    status: ReconciliationStatus.Exact,
    discrepancies: [],
    reconciledAt: brokerObservedAt,
  }
  const reconciliationId = canonicalHashV1({
    schemaVersion: 'bayn.paper-reconciliation-id.v1',
    material: reconciliationMaterial,
  })
  const reconciliation: Reconciliation = {
    ...reconciliationMaterial,
    reconciliationId,
    contentHash: canonicalHashV1({ ...reconciliationMaterial, reconciliationId }),
  }
  return { account, positions, orders, reconciliation, stateHash }
}

const policy = (): Policy =>
  Schema.decodeUnknownSync(
    PolicySchema,
    strictParseOptions,
  )({
    schemaVersion: 'bayn.execution-risk-policy.v3',
    accountId,
    brokerMode: BrokerMode.Execution,
    allowedSymbols: protocol.candidateSymbols,
    allowedOrderTypes: [OrderType.Limit],
    allowedTimeInForce: [TimeInForce.ImmediateOrCancel],
    maxOrderNotionalMicros: '1000000000',
    maxSymbolExposureMicros: '1000000000',
    maxGrossExposureMicros: '1000000000',
    maxNetExposureMicros: '1000000000',
    maxDailyTradedNotionalMicros: '2000000000',
    maxDailyLossMicros: '100000000',
    maxDrawdownMicros: '100000000',
    maxIntentAgeMs: 120_000,
    maxBrokerStateAgeMs: 120_000,
    maxMarketDataAgeMs: 120_000,
    maxAdverseSlippageBps: 100,
    maxOpenOrders: 2,
    decisionTtlMs: 120_000,
  })

const fixture = (premiums: Readonly<Record<string, number>> = {}): ObserveShadowDecisionInput => {
  const cycle = activeCycle()
  const snapshot = makeIntradayMomentumTestSnapshot(protocol, snapshotRequest(), premiums)
  const decisionMarketData = executionMarketData(snapshot)
  const compiledDecision = value(
    decideIntradayMomentum(
      {
        snapshot,
        session: {
          sessionDate,
          openAt: cycle.window.executionOpenAt,
          closeAt: cycle.window.executionCloseAt,
          calendarHash: cycle.window.executionCalendarHash,
        },
      },
      protocol,
    ),
  )
  const executionPolicy = policy()
  const broker = brokerState()
  const hasEntryTargets = compiledDecision.selectedSymbols.length > 0
  const pricingMarketData = hasEntryTargets
    ? executionMarketData(
        makeIntradayMomentumTestSnapshot(
          protocol,
          {
            ...snapshotRequest(),
            symbols: protocol.candidateSymbols,
            purpose: IntradaySnapshotPurpose.EntryPricing,
          },
          premiums,
        ),
      )
    : decisionMarketData
  const marketData = pricingMarketData
  const planningSymbols = protocol.candidateSymbols
  const priceMicros = Object.fromEntries(planningSymbols.map((symbol) => [symbol, '100010000']))
  const bidPriceMicros = Object.fromEntries(planningSymbols.map((symbol) => [symbol, '99990000']))
  const askPriceMicros = Object.fromEntries(planningSymbols.map((symbol) => [symbol, '100010000']))
  const priceMaterial = {
    schemaVersion: intradaySnapshotReferencePricesSchemaVersion,
    signalDate: sessionDate,
    observedAt,
    snapshotId: marketData.snapshotId,
    snapshotContentHash: marketData.contentHash,
    priceReference: 'verified-adverse-quote-boundary' as const,
    priceMicros,
    bidPriceMicros,
    askPriceMicros,
  }
  const plannerInput: QuoteBoundTargetPlannerInput = {
    schemaVersion: quoteBoundTargetPlannerInputSchemaVersion,
    strategyName: 'intraday-momentum',
    cycleId: cycle.identity.cycleId,
    decisionHash: canonicalHashV1(compiledDecision),
    policyHash: canonicalHashV1(executionPolicy),
    accountId,
    signalDate: sessionDate,
    targetWeights: compiledDecision.targetWeights,
    referencePrices: { ...priceMaterial, contentHash: canonicalHashV1(priceMaterial) },
    brokerState: {
      account: broker.account,
      positions: broker.positions,
      positionsObservedAt: brokerObservedAt,
      orders: broker.orders,
      ordersObservedAt: brokerObservedAt,
      accountingHash,
      reconciliation: broker.reconciliation,
      unknownOrderCount: 0,
    },
    precision: {
      ...intradayMomentumExecutionModel.precision,
      quantityIncrementMicros: '1000000',
    },
    allocationCapitalMicros: '2000000000',
    executionTerms: {
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.ImmediateOrCancel,
      priceReference: 'verified-adverse-quote-boundary',
      snapshotId: marketData.snapshotId,
      snapshotContentHash: marketData.contentHash,
      maximumBuyQuantityMicros: Object.fromEntries(planningSymbols.map((symbol) => [symbol, '1000000'])),
      maximumSellQuantityMicros: Object.fromEntries(planningSymbols.map((symbol) => [symbol, '1000000'])),
    },
    maximumInputAgeMs: 120_000,
    submissionCutoffAt: cycle.window.submissionCutoffAt,
    observedAt,
  }
  const targetPlan = value(planTargets(plannerInput))
  const boundExecutionSession = value(
    bindCycleExecutionSession({
      cycle,
      executionSessionDate: sessionDate,
      planningBrokerState: { observedAt: brokerObservedAt, contentHash: broker.stateHash },
      calendar,
      executionModel: intradayMomentumExecutionModel,
    }),
  )
  const riskInputs: ShadowDeltaRiskInput[] = targetPlan.intentTargets.map((target) => {
    const plannedTarget = targetPlan.targets.find(({ symbol }) => symbol === target.symbol)
    if (plannedTarget === undefined) throw new Error(`intraday fixture is missing ${target.symbol}`)
    return {
      symbol: target.symbol,
      notionalLimitMicros: (
        (BigInt(target.quantityMicros) * BigInt(plannedTarget.referencePriceMicros)) /
        1_000_000n
      ).toString(),
      state: Effect.runSync(
        decodeState({
          schemaVersion: 'bayn.paper-risk-state.v2',
          brokerMode: BrokerMode.Execution,
          account: broker.account,
          positions: broker.positions,
          positionsObservedAt: brokerObservedAt,
          orders: broker.orders,
          ordersObservedAt: brokerObservedAt,
          reconciliation: broker.reconciliation,
          authority: {
            schemaVersion: 'bayn.paper-authority.v1',
            generationHash: hash('6'),
            maximum: Authority.Execution,
            effective: Authority.Execution,
            kill: KillState.Clear,
            version: 1,
            updatedAt: brokerObservedAt,
          },
          authorityObservedAt: brokerObservedAt,
          unknownMutationCount: 0,
          dailyTradedNotionalMicros: '0',
          dayStartEquityMicros: broker.account.equityMicros,
          peakEquityMicros: broker.account.equityMicros,
          accountingHash,
          marketDataSymbol: target.symbol,
          marketDataHash: marketData.contentHash,
          executionMarketDataHash: marketData.contentHash,
          referencePriceMicros: plannedTarget.referencePriceMicros,
          expectedExecutionPriceMicros: plannedTarget.referencePriceMicros,
          marketDataObservedAt: marketData.observedAt,
          executionSession: boundExecutionSession,
          reservedBuyingPowerMicros: '0',
          evaluatedAt: plannerInput.observedAt,
        }),
      ),
    }
  })
  return {
    cycle,
    snapshot: {
      snapshotId: decisionMarketData.snapshotId,
      contentHash: decisionMarketData.contentHash,
      finalizedAt: decisionMarketData.observedAt,
    },
    compiledDecision,
    decisionMarketDataRows: value(persistIntradaySnapshotRows(snapshot)),
    ...(hasEntryTargets ? { decisionMarketData } : {}),
    executionMarketData: marketData,
    plannerInput,
    targetPlan,
    policy: executionPolicy,
    riskInputs,
  }
}

const executionSession = (input: ObserveShadowDecisionInput) => {
  const broker = brokerState()
  return value(
    bindCycleExecutionSession({
      cycle: input.cycle,
      executionSessionDate: sessionDate,
      planningBrokerState: {
        observedAt: brokerObservedAt,
        contentHash: broker.stateHash,
      },
      calendar,
      executionModel: intradayMomentumExecutionModel,
    }),
  )
}

describe('intraday shadow decision', () => {
  test('persists one deterministic no-trade observation against the exact verified snapshot', async () => {
    const input = fixture()

    const first = await Effect.runPromise(buildObserveShadowDecision(input))
    const second = await Effect.runPromise(buildObserveShadowDecision(input))

    expect(input.targetPlan.status).toBe(TargetPlanStatus.NoTrade)
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      mode: 'OBSERVE',
      dispatchable: false,
      bindings: {
        strategyName: 'intraday-momentum',
        snapshotId: input.snapshot.snapshotId,
        snapshotContentHash: input.snapshot.contentHash,
      },
      deltaRisk: [],
    })
  })

  test('assembles the same no-trade material under execution authority without broker intents', async () => {
    const input = fixture()

    const document = await Effect.runPromise(
      buildExecutionDecision({
        ...input,
        authorityGenerationHash: hash('6'),
        executionSession: executionSession(input),
      }),
    )

    expect(document).toMatchObject({
      mode: 'PAPER',
      dispatchable: true,
      orderedIntentIds: [],
      deltaRisk: [],
    })
    expect(document.strategyDecision).toEqual(input.compiledDecision)
  })

  test('decodes immutable intraday-v1 execution evidence without allowing new legacy material', async () => {
    const input = fixture()
    const current = await Effect.runPromise(
      buildExecutionDecision({
        ...input,
        authorityGenerationHash: hash('6'),
        executionSession: executionSession(input),
      }),
    )
    if (current.strategyDecision?.schemaVersion !== 'bayn.intraday-momentum.target.v2') {
      throw new Error('legacy decoder fixture requires one current intraday decision')
    }
    if (current.plannerInput === undefined) throw new Error('legacy decoder fixture requires planner evidence')

    const legacyDecision = {
      schemaVersion: 'bayn.intraday-momentum.target.v1' as const,
      strategy: 'intraday-momentum' as const,
      sessionDate: current.strategyDecision.sessionDate,
      snapshotId: current.strategyDecision.snapshotId,
      observedAt: current.strategyDecision.observedAt,
      calendarHash: current.strategyDecision.calendarHash,
      selectedSymbols: [],
      targetWeights: current.strategyDecision.targetWeights,
      signals: current.strategyDecision.signals.map((signal) => ({
        symbol: signal.symbol,
        referencePriceMicros: signal.referencePriceMicros,
        rangeHighPriceMicros: signal.rangeHighPriceMicros,
        rangeLowPriceMicros: signal.rangeLowPriceMicros,
        bidPriceMicros: signal.bidPriceMicros,
        bidSizeMicros: signal.bidSizeMicros,
        askPriceMicros: signal.askPriceMicros,
        askSizeMicros: signal.askSizeMicros,
        quoteObservedAt: signal.quoteObservedAt,
        confirmationTradePriceMicros: signal.confirmationTradePriceMicros,
        confirmationTradeObservedAt: signal.confirmationTradeObservedAt,
        lookbackReturnBps: signal.lookbackReturnBps,
        breakoutBps: signal.breakoutBps,
        rangeLocationPpm: signal.rangeLocationPpm,
        spreadBps: signal.spreadBps,
        eligible: false,
        rejectionReasons: ['lookback-return' as const],
        rank: null,
      })),
    }
    const strategyDecisionHash = canonicalHashV1(legacyDecision)
    const plannerInput = { ...current.plannerInput, decisionHash: strategyDecisionHash }
    const targetPlan = value(planTargets(plannerInput))
    const { contentHash: _contentHash, ...currentMaterial } = current
    const legacyMaterial = {
      ...currentMaterial,
      bindings: { ...currentMaterial.bindings, strategyDecisionHash },
      strategyDecision: legacyDecision,
      plannerInput,
      targetPlan,
    }
    const persisted = { ...legacyMaterial, contentHash: canonicalHashV1(legacyMaterial) }

    expect(Result.isSuccess(decodeExecutionDecisionDocument(persisted))).toBeTrue()
    expect(Result.isFailure(makeExecutionDecisionDocument(legacyMaterial))).toBeTrue()
  })

  test('binds durable execution material to the exact snapshot and complete target universe', async () => {
    const selectedSymbol = protocol.candidateSymbols[0]
    if (selectedSymbol === undefined) throw new Error('intraday fixture requires one candidate symbol')
    const input = fixture({ [protocol.benchmarkSymbol]: 0.005, [selectedSymbol]: 0.02 })
    if (input.compiledDecision.schemaVersion !== 'bayn.intraday-momentum.target.v2') {
      throw new Error('intraday fixture requires one entry decision')
    }
    expect(input.compiledDecision.selectedSymbols).toEqual([selectedSymbol])
    expect(input.targetPlan.status).toBe(TargetPlanStatus.Planned)
    const document = await Effect.runPromise(
      buildExecutionDecision({
        ...input,
        authorityGenerationHash: hash('6'),
        executionSession: executionSession(input),
      }),
    )
    const { contentHash: _contentHash, ...material } = document
    expect(material.strategyDecision).toEqual(input.compiledDecision)
    expect(material.plannerInput).toEqual(input.plannerInput)
    const { plannerInput: _plannerInput, ...withoutPlannerInput } = material
    const missingPlannerInput = makeExecutionDecisionDocument(withoutPlannerInput)
    expect(Result.isFailure(missingPlannerInput)).toBe(true)
    if (Result.isFailure(missingPlannerInput)) {
      expect(String(missingPlannerInput.failure.cause)).toContain('requires persisted target-planner evidence')
    }
    const forgedMetricDecision = {
      ...input.compiledDecision,
      signals: input.compiledDecision.signals.map((signal, index) =>
        index === 0 ? { ...signal, lookbackReturnBps: signal.lookbackReturnBps + 1 } : signal,
      ),
    }
    const forgedMetricDocument = makeExecutionDecisionDocument({
      ...material,
      bindings: {
        ...material.bindings,
        strategyDecisionHash: canonicalHashV1(forgedMetricDecision),
      },
      strategyDecision: forgedMetricDecision,
    })
    expect(Result.isFailure(forgedMetricDocument)).toBeTrue()
    if (Result.isFailure(forgedMetricDocument)) {
      expect(String(forgedMetricDocument.failure.cause)).toContain('signal metrics must match persisted price evidence')
    }
    const originalSignal = input.compiledDecision.signals[0]
    if (originalSignal === undefined) throw new Error('intraday fixture requires signal evidence')
    const forgedSignalReferencePrice = BigInt(originalSignal.referencePriceMicros) + 1n
    const forgedPriceMetrics = value(
      deriveIntradayMomentumSignalMetrics(
        {
          reference: forgedSignalReferencePrice,
          high: BigInt(originalSignal.rangeHighPriceMicros),
          low: BigInt(originalSignal.rangeLowPriceMicros),
          bid: BigInt(originalSignal.bidPriceMicros),
          ask: BigInt(originalSignal.askPriceMicros),
          trade: BigInt(originalSignal.confirmationTradePriceMicros),
        },
        originalSignal.symbol,
        {
          reference: BigInt(input.compiledDecision.benchmark.referencePriceMicros),
          bid: BigInt(input.compiledDecision.benchmark.bidPriceMicros),
          ask: BigInt(input.compiledDecision.benchmark.askPriceMicros),
        },
      ),
    )
    const forgedPriceDecision = {
      ...input.compiledDecision,
      signals: input.compiledDecision.signals.map((signal, index) =>
        index === 0
          ? {
              ...signal,
              referencePriceMicros: String(forgedSignalReferencePrice),
              ...forgedPriceMetrics.metrics,
              excessReturnNumerator: String(forgedPriceMetrics.excessReturn.numerator),
              excessReturnDenominator: String(forgedPriceMetrics.excessReturn.denominator),
            }
          : signal,
      ),
    }
    const forgedPriceDocument = makeExecutionDecisionDocument({
      ...material,
      bindings: {
        ...material.bindings,
        strategyDecisionHash: canonicalHashV1(forgedPriceDecision),
      },
      strategyDecision: forgedPriceDecision,
    })
    expect(Result.isFailure(forgedPriceDocument)).toBe(true)
    if (Result.isFailure(forgedPriceDocument)) {
      expect(String(forgedPriceDocument.failure.cause)).toContain(
        'strategy decision must be reproduced from its exact verified archive rows',
      )
    }
    const forgedSelectedSymbol = protocol.candidateSymbols.find((symbol) => symbol !== selectedSymbol)
    if (forgedSelectedSymbol === undefined) throw new Error('intraday fixture requires one candidate symbol')
    const forgedStrategyDecision = {
      ...input.compiledDecision,
      selectedSymbols: [forgedSelectedSymbol],
      targetWeights: Object.fromEntries(
        protocol.candidateSymbols.map((symbol) => [symbol, symbol === forgedSelectedSymbol ? 0.1 : 0]),
      ),
      signals: input.compiledDecision.signals.map((signal) => {
        if (signal.symbol === forgedSelectedSymbol) {
          return { ...signal, eligible: true, rejectionReasons: [], rank: 1 }
        }
        return signal.symbol === selectedSymbol
          ? { ...signal, eligible: false, rejectionReasons: ['excess-return' as const], rank: null }
          : signal
      }),
    }
    const forgedTargetSelection = makeExecutionDecisionDocument({
      ...material,
      bindings: {
        ...material.bindings,
        strategyDecisionHash: canonicalHashV1(forgedStrategyDecision),
      },
      strategyDecision: forgedStrategyDecision,
    })
    expect(Result.isFailure(forgedTargetSelection)).toBe(true)
    if (Result.isFailure(forgedTargetSelection)) {
      expect(String(forgedTargetSelection.failure.cause)).toContain('canonical source-controlled signal ranking')
    }

    const strategyBindingForgeries = [
      { snapshotId: hash('d') },
      { sessionDate: '2026-08-19' as const },
      { observedAt: '2026-08-18T16:00:03.000Z' },
      { calendarHash: hash('e') },
    ]
    for (const overrides of strategyBindingForgeries) {
      const strategyDecision = { ...input.compiledDecision, ...overrides }
      const forged = makeExecutionDecisionDocument({
        ...material,
        bindings: {
          ...material.bindings,
          strategyDecisionHash: canonicalHashV1(strategyDecision),
        },
        strategyDecision,
      })
      expect(Result.isFailure(forged)).toBeTrue()
      if (Result.isFailure(forged)) {
        expect(String(forged.failure.cause)).toContain('exact market-data snapshot and session')
      }
    }

    const omittedSymbol = input.targetPlan.targets.find(({ targetWeight }) => targetWeight === 0)?.symbol
    if (omittedSymbol === undefined) throw new Error('intraday fixture requires one zero-weight target')
    const { outputHash: _outputHash, ...targetPlanMaterial } = material.targetPlan
    const rehashTargetPlan = (targets: typeof targetPlanMaterial.targets) => {
      const forgedTargetPlanMaterial = { ...targetPlanMaterial, targets }
      return { ...forgedTargetPlanMaterial, outputHash: canonicalHashV1(forgedTargetPlanMaterial) }
    }
    const targetForForgery = targetPlanMaterial.targets.find(({ symbol }) => symbol === selectedSymbol)
    if (targetForForgery === undefined) throw new Error('intraday fixture requires its selected target')
    const quantityShift = 1_000_000n
    const forgedQuantities = makeExecutionDecisionDocument({
      ...material,
      targetPlan: rehashTargetPlan(
        targetPlanMaterial.targets.map((target) =>
          target.symbol === targetForForgery.symbol
            ? {
                ...target,
                currentQuantityMicros: (BigInt(target.currentQuantityMicros) + quantityShift).toString(),
                targetQuantityMicros: (BigInt(target.targetQuantityMicros) + quantityShift).toString(),
              }
            : target,
        ),
      ),
    })
    expect(Result.isFailure(forgedQuantities)).toBe(true)
    if (Result.isFailure(forgedQuantities)) {
      expect(String(forgedQuantities.failure.cause)).toContain('persisted target-planner evidence')
    }

    const forgedReferencePrice = makeExecutionDecisionDocument({
      ...material,
      targetPlan: rehashTargetPlan(
        targetPlanMaterial.targets.map((target) =>
          target.symbol === omittedSymbol
            ? { ...target, referencePriceMicros: (BigInt(target.referencePriceMicros) + 1n).toString() }
            : target,
        ),
      ),
    })
    expect(Result.isFailure(forgedReferencePrice)).toBe(true)
    if (Result.isFailure(forgedReferencePrice)) {
      expect(String(forgedReferencePrice.failure.cause)).toContain('persisted target-planner evidence')
    }

    const reducedTargetPlanMaterial = {
      ...targetPlanMaterial,
      targets: targetPlanMaterial.targets.filter(({ symbol }) => symbol !== omittedSymbol),
    }
    const forged = makeExecutionDecisionDocument({
      ...material,
      targetPlan: {
        ...reducedTargetPlanMaterial,
        outputHash: canonicalHashV1(reducedTargetPlanMaterial),
      },
    })

    expect(Result.isFailure(forged)).toBeTrue()
    if (Result.isFailure(forged)) {
      expect(String(forged.failure.cause)).toContain('retain every strategy weight')
    }
  })

  test('reproduces complete durable risk facts before admitting a rehashed execution approval', async () => {
    const selectedSymbol = protocol.candidateSymbols[0]
    if (selectedSymbol === undefined) throw new Error('intraday fixture requires one candidate symbol')
    const input = fixture({ [protocol.benchmarkSymbol]: 0.005, [selectedSymbol]: 0.02 })
    const riskInputs = input.riskInputs.map((riskInput) => ({
      ...riskInput,
      state: {
        ...riskInput.state,
        dayStartEquityMicros: (BigInt(riskInput.state.account.equityMicros) + 200_000_000n).toString(),
        peakEquityMicros: riskInput.state.account.equityMicros,
      },
    }))
    const document = await Effect.runPromise(
      buildExecutionDecision({
        ...input,
        riskInputs,
        authorityGenerationHash: hash('6'),
        executionSession: executionSession(input),
      }),
    )

    expect(document.riskPolicy).toEqual(input.policy)
    expect(document.deltaRisk.every(({ facts }) => facts !== undefined)).toBeTrue()
    expect(document.riskBlock?.reasonCodes).toEqual([Reason.DailyLossExceeded])
    expect(document.dispatchable).toBeFalse()

    const forgedDeltaRisk = document.deltaRisk.map((risk) => {
      const { decisionId: _decisionId, ...decisionMaterial } = risk.evaluation.decision
      const approvedDecisionMaterial = {
        ...decisionMaterial,
        outcome: RiskOutcome.Approved,
        reasonCodes: [],
      }
      return {
        ...risk,
        evaluation: {
          ...risk.evaluation,
          gates: risk.evaluation.gates.map((gate) => ({ ...gate, passed: true })),
          decision: {
            ...approvedDecisionMaterial,
            decisionId: canonicalHashV1(approvedDecisionMaterial),
          },
        },
      }
    })
    const { contentHash: _contentHash, riskBlock: _riskBlock, ...material } = document
    const forged = makeExecutionDecisionDocument({
      ...material,
      dispatchable: true,
      deltaRisk: forgedDeltaRisk,
    })

    expect(Result.isFailure(forged)).toBeTrue()
    if (Result.isFailure(forged)) {
      expect(String(forged.failure.cause)).toContain('must reproduce the exact persisted risk gates')
    }
    expect(
      document.deltaRisk.some(({ evaluation }) => evaluation.gates.some(({ name }) => name === Gate.DailyLoss)),
    ).toBeTrue()
  })

  test('rejects a fully rehashed evaluation whose durable risk context differs from the bound planner state', async () => {
    const selectedSymbol = protocol.candidateSymbols[0]
    if (selectedSymbol === undefined) throw new Error('intraday fixture requires one candidate symbol')
    const input = fixture({ [protocol.benchmarkSymbol]: 0.005, [selectedSymbol]: 0.02 })
    const authorityGenerationHash = hash('6')
    const document = await Effect.runPromise(
      buildExecutionDecision({
        ...input,
        authorityGenerationHash,
        executionSession: executionSession(input),
      }),
    )
    const target = document.targetPlan.intentTargets[0]
    const risk = document.deltaRisk[0]
    if (target === undefined || risk?.facts === undefined) {
      throw new Error('risk-context fixture requires one persisted execution risk input')
    }
    const intent = value(
      makeExecutionIntentFromDecodedPlan(
        {
          schemaVersion: legacyIntentPlanSchemaVersion,
          ...target,
          notionalLimitMicros: risk.notionalLimitMicros,
        },
        authorityGenerationHash,
      ),
    )
    const forgedState = {
      ...risk.facts.state,
      dayStartEquityMicros: (BigInt(risk.facts.state.dayStartEquityMicros) + 1n).toString(),
    }
    const forgedEvaluation = value(
      evaluate({
        intent,
        state: forgedState,
        policy: input.policy,
        proposedPositions: risk.facts.proposedPositions,
      }),
    )
    const { contentHash: _contentHash, ...material } = document
    const forged = makeExecutionDecisionDocument({
      ...material,
      deltaRisk: [{ ...risk, facts: { ...risk.facts, state: forgedState }, evaluation: forgedEvaluation }],
    })

    expect(Result.isFailure(forged)).toBeTrue()
    if (Result.isFailure(forged)) {
      expect(String(forged.failure.cause)).toContain('must match the exact planner, authority, market-data')
    }
  })

  test('rejects a fully rehashed evaluation whose authority version differs from the bound state', async () => {
    const selectedSymbol = protocol.candidateSymbols[0]
    if (selectedSymbol === undefined) throw new Error('intraday fixture requires one candidate symbol')
    const input = fixture({ [protocol.benchmarkSymbol]: 0.005, [selectedSymbol]: 0.02 })
    const authorityGenerationHash = hash('6')
    const document = await Effect.runPromise(
      buildExecutionDecision({
        ...input,
        authorityGenerationHash,
        executionSession: executionSession(input),
      }),
    )
    const target = document.targetPlan.intentTargets[0]
    const risk = document.deltaRisk[0]
    if (target === undefined || risk?.facts === undefined) {
      throw new Error('authority fixture requires one persisted execution risk input')
    }
    const intent = value(
      makeExecutionIntentFromDecodedPlan(
        {
          schemaVersion: legacyIntentPlanSchemaVersion,
          ...target,
          notionalLimitMicros: risk.notionalLimitMicros,
        },
        authorityGenerationHash,
      ),
    )
    const forgedState = {
      ...risk.facts.state,
      authority: { ...risk.facts.state.authority, version: risk.facts.state.authority.version + 1 },
    }
    const forgedEvaluation = value(
      evaluate({
        intent,
        state: forgedState,
        policy: input.policy,
        proposedPositions: risk.facts.proposedPositions,
      }),
    )
    const { contentHash: _contentHash, ...material } = document
    const forged = makeExecutionDecisionDocument({
      ...material,
      deltaRisk: [{ ...risk, facts: { ...risk.facts, state: forgedState }, evaluation: forgedEvaluation }],
    })

    expect(Result.isFailure(forged)).toBeTrue()
    if (Result.isFailure(forged)) {
      expect(String(forged.failure.cause)).toContain('must match the exact planner, authority, market-data')
    }
  })

  test('recomputes quote-bound execution pricing before admitting a rehashed evaluation', async () => {
    const selectedSymbol = protocol.candidateSymbols[0]
    if (selectedSymbol === undefined) throw new Error('intraday fixture requires one candidate symbol')
    const input = fixture({ [protocol.benchmarkSymbol]: 0.005, [selectedSymbol]: 0.02 })
    const authorityGenerationHash = hash('6')
    const document = await Effect.runPromise(
      buildExecutionDecision({
        ...input,
        authorityGenerationHash,
        executionSession: executionSession(input),
      }),
    )
    const target = document.targetPlan.intentTargets[0]
    const risk = document.deltaRisk[0]
    if (target === undefined || risk?.facts === undefined) {
      throw new Error('pricing fixture requires one persisted execution risk input')
    }
    const forgedNotionalLimitMicros = (BigInt(risk.notionalLimitMicros) + 1n).toString()
    const intent = value(
      makeExecutionIntentFromDecodedPlan(
        {
          schemaVersion: legacyIntentPlanSchemaVersion,
          ...target,
          notionalLimitMicros: forgedNotionalLimitMicros,
        },
        authorityGenerationHash,
      ),
    )
    const forgedState = {
      ...risk.facts.state,
      expectedExecutionPriceMicros: (BigInt(risk.facts.state.expectedExecutionPriceMicros) + 1n).toString(),
    }
    const forgedEvaluation = value(
      evaluate({
        intent,
        state: forgedState,
        policy: input.policy,
        proposedPositions: risk.facts.proposedPositions,
      }),
    )
    const { contentHash: _contentHash, ...material } = document
    const forged = makeExecutionDecisionDocument({
      ...material,
      orderedIntentIds: [intent.intentId],
      deltaRisk: [
        {
          ...risk,
          notionalLimitMicros: forgedNotionalLimitMicros,
          facts: { ...risk.facts, state: forgedState },
          evaluation: forgedEvaluation,
        },
      ],
    })

    expect(Result.isFailure(forged)).toBeTrue()
    if (Result.isFailure(forged)) {
      expect(String(forged.failure.cause)).toContain('must reproduce the exact persisted risk gates')
    }
  })

  test('fails closed when market data is absent, incomplete, or bound to another calendar', async () => {
    const input = fixture()
    const binding = input.executionMarketData
    if (binding?.schemaVersion !== 'bayn.execution-market-data-binding.v2') {
      throw new Error('intraday fixture requires market-data binding v2')
    }
    const subset = { ...binding, symbols: binding.symbols.slice(0, 1) }
    const variants = [
      { ...input, executionMarketData: undefined },
      { ...input, executionMarketData: subset },
      {
        ...input,
        compiledDecision: { ...input.compiledDecision, calendarHash: hash('f') },
      },
    ]

    for (const variant of variants) {
      const exit = await Effect.runPromiseExit(buildObserveShadowDecision(variant))
      expect(Exit.isFailure(exit)).toBeTrue()
    }
  })

  test('fails closed when the planner result or immutable snapshot binding drifts', async () => {
    const input = fixture()
    const variants = [
      { ...input, snapshot: { ...input.snapshot, snapshotId: hash('f') } },
      { ...input, targetPlan: { ...input.targetPlan, outputHash: hash('e') } },
      { ...input, plannerInput: { ...input.plannerInput, policyHash: hash('d') } },
    ]

    for (const variant of variants) {
      const exit = await Effect.runPromiseExit(buildObserveShadowDecision(variant))
      expect(Exit.isFailure(exit)).toBeTrue()
    }
  })

  test('durable decoding rejects content rewrites and coordinator-only fields', async () => {
    const document = await Effect.runPromise(buildObserveShadowDecision(fixture()))

    expect(
      Result.isFailure(
        decodeObserveShadowDecisionDocument({
          ...document,
          targetPlan: { ...document.targetPlan, outputHash: hash('f') },
        }),
      ),
    ).toBeTrue()
    expect(
      Result.isFailure(
        decodeObserveShadowDecisionDocument({
          ...document,
          coordinatorApproval: true,
        }),
      ),
    ).toBeTrue()
  })
})
