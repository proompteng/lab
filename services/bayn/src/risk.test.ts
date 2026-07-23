import { describe, expect, test } from 'bun:test'

import { Schema } from 'effect'

import { canonicalHashV1 } from './hash'
import {
  AccountStatus,
  Authority,
  DiscrepancyKind,
  IntentSchema,
  IntentState,
  KillState,
  OrderSide,
  OrderStatus,
  OrderType,
  ReconciliationStatus,
  RiskOutcome,
  TerminalOutcome,
  TimeInForce,
  type Intent,
} from './paper'
import { reconciledStateHash } from './reconciliation'
import { BrokerMode, PolicySchema, Reason, StateSchema, evaluate, type Policy, type State } from './risk'
import { strictParseOptions } from './schemas'

const evaluatedAt = '2026-07-21T21:00:00.000Z'
const observedAt = '2026-07-21T20:59:30.000Z'
const hash = (character: string): string => character.repeat(64)

const decodePolicy = Schema.decodeUnknownSync(PolicySchema, strictParseOptions)
const decodeState = Schema.decodeUnknownSync(StateSchema, strictParseOptions)
const decodeIntent = Schema.decodeUnknownSync(IntentSchema, strictParseOptions)

const rehashExecutionSession = (
  binding: Omit<State['executionSession'], 'bindingHash'>,
): State['executionSession'] => ({
  ...binding,
  bindingHash: canonicalHashV1(binding),
})

const changeExecutionWindow = (
  binding: State['executionSession'],
  overrides: Partial<Pick<State['executionSession'], 'submissionOpenAt' | 'submissionCutoffAt'>>,
): State['executionSession'] => {
  const { bindingHash: _, ...material } = binding
  if (overrides.submissionCutoffAt === undefined) {
    return rehashExecutionSession({ ...material, ...overrides })
  }
  const executionOpenAt = new Date(
    Date.parse(overrides.submissionCutoffAt) + material.submissionCutoffLeadMinutes * 60_000,
  ).toISOString()
  const executionDate = executionOpenAt.slice(0, 10) as State['executionSession']['executionSession']['date']
  const signalDate = new Date(Date.parse(`${executionDate}T00:00:00.000Z`) - 24 * 60 * 60_000)
    .toISOString()
    .slice(0, 10) as State['executionSession']['signal']['sessionDate']
  const executionSession = {
    date: executionDate,
    openAt: executionOpenAt,
    closeAt: new Date(Date.parse(executionOpenAt) + 2 * 60 * 60_000).toISOString(),
  }
  const calendar = {
    schemaVersion: material.calendar.schemaVersion,
    source: material.calendar.source,
    requestedRange: { start: signalDate, end: executionDate },
    timeZone: material.calendar.timeZone,
    sessions: [executionSession],
  }
  return rehashExecutionSession({
    ...material,
    ...overrides,
    signal: { ...material.signal, sessionDate: signalDate },
    calendar: {
      ...calendar,
      normalizedResponseHash: canonicalHashV1(calendar),
    },
    executionSession,
  })
}

const makePolicy = (overrides: Partial<Policy> = {}): Policy =>
  decodePolicy({
    schemaVersion: 'bayn.paper-risk-policy.v1',
    accountId: 'paper-account-1',
    brokerMode: BrokerMode.Paper,
    allowedSymbols: ['AMD', 'NVDA'],
    allowedOrderTypes: [OrderType.Market],
    allowedTimeInForce: [TimeInForce.Day, TimeInForce.GoodUntilCanceled],
    maxOrderNotionalMicros: '100000000',
    maxSymbolExposureMicros: '200000000',
    maxGrossExposureMicros: '300000000',
    maxNetExposureMicros: '300000000',
    maxDailyTradedNotionalMicros: '200000000',
    maxDailyLossMicros: '50000000',
    maxDrawdownMicros: '100000000',
    maxIntentAgeMs: 60_000,
    maxBrokerStateAgeMs: 60_000,
    maxMarketDataAgeMs: 60_000,
    maxAdverseSlippageBps: 100,
    maxUnresolvedOrders: 0,
    decisionTtlMs: 30_000,
    ...overrides,
  })

const baseState = (): State => {
  const account = {
    schemaVersion: 'bayn.paper-account-snapshot.v1' as const,
    accountId: 'paper-account-1',
    status: AccountStatus.Active,
    currency: 'USD' as const,
    cashMicros: '750000000',
    equityMicros: '950000000',
    buyingPowerMicros: '100000000',
    observedAt,
  }
  const positions = [
    {
      schemaVersion: 'bayn.paper-position.v1' as const,
      accountId: 'paper-account-1',
      symbol: 'AMD',
      quantityMicros: '1000000',
      averageEntryPriceMicros: '90000000',
      marketPriceMicros: '100000000',
      marketValueMicros: '100000000',
      unrealizedPnlMicros: '10000000',
      observedAt,
    },
    {
      schemaVersion: 'bayn.paper-position.v1' as const,
      accountId: 'paper-account-1',
      symbol: 'NVDA',
      quantityMicros: '1000000',
      averageEntryPriceMicros: '90000000',
      marketPriceMicros: '100000000',
      marketValueMicros: '100000000',
      unrealizedPnlMicros: '10000000',
      observedAt,
    },
  ]
  const orders: readonly ReturnType<typeof openOrder>[] = []
  const accountingHash = hash('a')
  const reconciledStateHashValue = reconciledStateHash({
    account,
    positions,
    positionsObservedAt: observedAt,
    orders,
    ordersObservedAt: observedAt,
    accountingHash,
  })
  const calendar = {
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
    source: 'alpaca-v2-calendar' as const,
    requestedRange: { start: '2026-07-21' as const, end: '2026-07-31' as const },
    timeZone: 'UTC' as const,
    sessions: [
      {
        date: '2026-07-22' as const,
        openAt: '2026-07-22T13:30:00.000Z',
        closeAt: '2026-07-22T20:00:00.000Z',
      },
    ],
  }
  const executionSession = rehashExecutionSession({
    schemaVersion: 'bayn.execution-session-binding.v1',
    signal: {
      sessionDate: '2026-07-21',
      finalizedAt: '2026-07-21T20:58:00.000Z',
      contentHash: hash('5'),
    },
    planningBrokerState: {
      observedAt,
      contentHash: reconciledStateHashValue,
    },
    calendar: { ...calendar, normalizedResponseHash: canonicalHashV1(calendar) },
    executionSession: calendar.sessions[0],
    submissionOpenAt: observedAt,
    submissionCutoffAt: '2026-07-22T13:15:00.000Z',
    submissionCutoffLeadMinutes: 15,
  })
  return decodeState({
    schemaVersion: 'bayn.paper-risk-state.v2',
    brokerMode: BrokerMode.Paper,
    account,
    positions,
    positionsObservedAt: observedAt,
    orders,
    ordersObservedAt: observedAt,
    reconciliation: {
      schemaVersion: 'bayn.paper-reconciliation.v1',
      reconciliationId: hash('1'),
      accountId: 'paper-account-1',
      expectedHash: reconciledStateHashValue,
      observedHash: reconciledStateHashValue,
      contentHash: hash('3'),
      status: ReconciliationStatus.Exact,
      discrepancies: [],
      reconciledAt: observedAt,
    },
    authority: {
      schemaVersion: 'bayn.paper-authority.v1',
      generationHash: hash('4'),
      maximum: Authority.Paper,
      effective: Authority.Paper,
      kill: KillState.Clear,
      version: 1,
      updatedAt: observedAt,
    },
    authorityObservedAt: observedAt,
    unknownMutationCount: 0,
    dailyTradedNotionalMicros: '100000000',
    dayStartEquityMicros: '1000000000',
    peakEquityMicros: '1050000000',
    accountingHash,
    marketDataSymbol: 'NVDA',
    marketDataHash: hash('5'),
    referencePriceMicros: '100000000',
    expectedExecutionPriceMicros: '100000000',
    marketDataObservedAt: observedAt,
    executionSession,
    reservedBuyingPowerMicros: '0',
    evaluatedAt,
  })
}

const makeState = (overrides: Partial<State> = {}): State => {
  const merged = { ...baseState(), ...overrides }
  const reconciledStateHashValue = reconciledStateHash({
    account: merged.account,
    positions: merged.positions,
    positionsObservedAt: merged.positionsObservedAt,
    orders: merged.orders,
    ordersObservedAt: merged.ordersObservedAt,
    accountingHash: merged.accountingHash,
  })
  const reconciliation =
    overrides.reconciliation ??
    ({
      ...merged.reconciliation,
      expectedHash: reconciledStateHashValue,
      observedHash: reconciledStateHashValue,
    } satisfies State['reconciliation'])
  const sourceExecutionSession = overrides.executionSession ?? merged.executionSession
  const { bindingHash: _, ...bindingMaterial } = sourceExecutionSession
  const executionSession = rehashExecutionSession({
    ...bindingMaterial,
    signal: { ...bindingMaterial.signal, contentHash: merged.marketDataHash },
    planningBrokerState: {
      observedAt: reconciliation.reconciledAt,
      contentHash: reconciliation.observedHash,
    },
  })
  return decodeState({
    ...merged,
    reconciliation,
    executionSession,
  })
}

const makeIntent = (overrides: Partial<Intent> = {}): Intent =>
  decodeIntent({
    schemaVersion: 'bayn.paper-intent.v2',
    intentId: hash('6'),
    strategyName: 'risk-balanced-trend',
    cycleId: hash('7'),
    decisionHash: hash('8'),
    policyHash: canonicalHashV1(makePolicy()),
    accountId: 'paper-account-1',
    clientOrderId: 'risk-test-order-1',
    symbol: 'NVDA',
    side: OrderSide.Buy,
    orderType: OrderType.Market,
    timeInForce: TimeInForce.Day,
    quantityMicros: '1000000',
    notionalLimitMicros: '100000000',
    state: IntentState.Planned,
    createdAt: '2026-07-21T20:59:45.000Z',
    ...overrides,
  })

const expectBlocked = (reason: Reason, intent = makeIntent(), state = makeState(), policy = makePolicy()): void => {
  const result = evaluate(intent, state, policy)
  expect(result.decision.outcome).toBe(RiskOutcome.Blocked)
  expect(result.decision.reasonCodes).toContain(reason)
}

const openOrder = (brokerOrderId: string) => ({
  schemaVersion: 'bayn.paper-order.v1' as const,
  accountId: 'paper-account-1',
  brokerOrderId,
  clientOrderId: `client-${brokerOrderId}`,
  symbol: 'NVDA',
  side: OrderSide.Buy,
  orderType: OrderType.Market,
  timeInForce: TimeInForce.Day,
  quantityMicros: '1000000',
  filledQuantityMicros: '0',
  status: OrderStatus.New,
  observedAt,
})

describe('bounded paper risk', () => {
  test('strictly decodes complete policy and coherent state', () => {
    expect(makePolicy().schemaVersion).toBe('bayn.paper-risk-policy.v1')
    expect(makeState().schemaVersion).toBe('bayn.paper-risk-state.v2')

    const rawPolicy = { ...makePolicy() }
    const missingPolicy: Record<string, unknown> = { ...rawPolicy }
    delete missingPolicy.maxOrderNotionalMicros
    expect(() => decodePolicy(missingPolicy)).toThrow()
    expect(() => decodePolicy({ ...rawPolicy, brokerMode: 'LIVE' })).toThrow()
    expect(() => decodePolicy({ ...rawPolicy, allowedSymbols: ['NVDA', 'AMD'] })).toThrow()
    expect(() => decodePolicy({ ...rawPolicy, allowedSymbols: ['AMD', 'AMD'] })).toThrow()
    expect(() => decodePolicy({ ...rawPolicy, allowedOrderTypes: [OrderType.Limit] })).toThrow()
    expect(() => decodePolicy({ ...rawPolicy, maxOrderNotionalMicros: '01' })).toThrow()
    expect(() => decodePolicy({ ...rawPolicy, maxOrderNotionalMicros: '9223372036854775808' })).toThrow()
    expect(() => decodePolicy({ ...rawPolicy, maxUnresolvedOrders: 1 })).toThrow()
    expect(() => decodePolicy({ ...rawPolicy, decisionTtlMs: 86_400_001 })).toThrow()
    expect(() => decodePolicy({ ...rawPolicy, extra: true })).toThrow()

    const state = baseState()
    expect(() => decodeState({ ...state, brokerMode: 'LIVE' })).toThrow()
    expect(() =>
      decodeState({
        ...state,
        positions: [{ ...state.positions[0], accountId: 'another-account' }, state.positions[1]],
      }),
    ).toThrow()
    expect(() => decodeState({ ...state, positions: [...state.positions].reverse() })).toThrow()
    expect(() =>
      decodeState({
        ...state,
        positions: [{ ...state.positions[0], marketValueMicros: '-100000000' }, state.positions[1]],
      }),
    ).toThrow()
    expect(() => decodeState({ ...state, marketDataObservedAt: '2026-07-21T21:00:00.001Z' })).toThrow()
    expect(() =>
      decodeState({
        ...state,
        executionSession: { ...state.executionSession, bindingHash: hash('0') },
      }),
    ).toThrow()

    const earlierOrderObservation = '2026-07-21T20:59:29.000Z'
    const paginated = makeState({
      orders: [{ ...openOrder('broker-1'), observedAt: earlierOrderObservation }, openOrder('broker-2')],
      ordersObservedAt: observedAt,
    })
    expect(paginated.orders.map((order) => order.observedAt)).toEqual([earlierOrderObservation, observedAt])
    expect(() => decodeState({ ...paginated, ordersObservedAt: earlierOrderObservation })).toThrow()
    const { bindingHash: _, ...binding } = state.executionSession
    expect(() =>
      decodeState({
        ...state,
        executionSession: rehashExecutionSession({
          ...binding,
          submissionOpenAt: binding.submissionCutoffAt,
        }),
      }),
    ).toThrow()
  })

  test('approves the exact limit boundary and binds a deterministic decision', () => {
    const first = evaluate(makeIntent(), makeState(), makePolicy())
    const second = evaluate(makeIntent(), makeState(), makePolicy())

    expect(first).toEqual(second)
    expect(first.decision.outcome).toBe(RiskOutcome.Approved)
    expect(first.decision.reasonCodes).toEqual([])
    expect(first.gates.every((gate) => gate.passed)).toBe(true)
    expect(first.input.freshUntil).toBe('2026-07-21T21:00:30.000Z')
    expect(first.metrics).toEqual({
      orderNotionalMicros: '100000000',
      postTradeSymbolExposureMicros: '200000000',
      postTradeGrossExposureMicros: '300000000',
      postTradeNetExposureMicros: '300000000',
      dailyTradedNotionalMicros: '200000000',
      dailyLossMicros: '50000000',
      drawdownMicros: '100000000',
      adverseSlippageBps: '0',
      aggregateBuyingPowerMicros: '100000000',
      unresolvedOrderCount: 0,
    })
  })

  test('approves at submission open and blocks immediately before it and exactly at cutoff', () => {
    const state = makeState()
    const atOpen = makeState({
      executionSession: changeExecutionWindow(state.executionSession, { submissionOpenAt: evaluatedAt }),
    })
    const beforeOpen = makeState({
      executionSession: changeExecutionWindow(state.executionSession, {
        submissionOpenAt: '2026-07-21T21:00:00.001Z',
      }),
    })
    const atCutoff = makeState({
      executionSession: changeExecutionWindow(state.executionSession, { submissionCutoffAt: evaluatedAt }),
    })

    expect(evaluate(makeIntent({ createdAt: evaluatedAt }), atOpen, makePolicy()).decision.outcome).toBe(
      RiskOutcome.Approved,
    )
    expectBlocked(Reason.OutsideSession, makeIntent(), beforeOpen, makePolicy())
    expectBlocked(Reason.OutsideSession, makeIntent(), atCutoff, makePolicy())
  })

  test('blocks one micro beyond every money and exposure limit', () => {
    const cases: readonly [Reason, Intent, State, Policy][] = [
      [Reason.IntentNotionalExceeded, makeIntent({ notionalLimitMicros: '99999999' }), makeState(), makePolicy()],
      [Reason.OrderNotionalExceeded, makeIntent(), makeState(), makePolicy({ maxOrderNotionalMicros: '99999999' })],
      [
        Reason.BuyingPowerExceeded,
        makeIntent(),
        makeState({ account: { ...baseState().account, buyingPowerMicros: '99999999' } }),
        makePolicy(),
      ],
      [Reason.SymbolExposureExceeded, makeIntent(), makeState(), makePolicy({ maxSymbolExposureMicros: '199999999' })],
      [Reason.GrossExposureExceeded, makeIntent(), makeState(), makePolicy({ maxGrossExposureMicros: '299999999' })],
      [Reason.NetExposureExceeded, makeIntent(), makeState(), makePolicy({ maxNetExposureMicros: '299999999' })],
      [
        Reason.DailyTradedNotionalExceeded,
        makeIntent(),
        makeState(),
        makePolicy({ maxDailyTradedNotionalMicros: '199999999' }),
      ],
      [Reason.DailyLossExceeded, makeIntent(), makeState(), makePolicy({ maxDailyLossMicros: '49999999' })],
      [Reason.DrawdownExceeded, makeIntent(), makeState(), makePolicy({ maxDrawdownMicros: '99999999' })],
    ]

    for (const [reason, intent, state, policy] of cases) expectBlocked(reason, intent, state, policy)
    expectBlocked(Reason.BuyingPowerExceeded, makeIntent(), makeState({ reservedBuyingPowerMicros: '1' }), makePolicy())
  })

  test('blocks adverse slippage and any unresolved order', () => {
    const slippageState = makeState({
      account: { ...baseState().account, buyingPowerMicros: '101000000' },
      expectedExecutionPriceMicros: '101000000',
    })
    const slippageIntent = makeIntent({ notionalLimitMicros: '101000000' })
    const slippagePolicy = makePolicy({
      maxOrderNotionalMicros: '101000000',
      maxSymbolExposureMicros: '201000000',
      maxGrossExposureMicros: '301000000',
      maxNetExposureMicros: '301000000',
      maxDailyTradedNotionalMicros: '201000000',
      maxAdverseSlippageBps: 100,
    })
    expect(evaluate(slippageIntent, slippageState, slippagePolicy).decision.outcome).toBe(RiskOutcome.Approved)
    expectBlocked(
      Reason.AdverseSlippageExceeded,
      slippageIntent,
      slippageState,
      makePolicy({ ...slippagePolicy, maxAdverseSlippageBps: 99 }),
    )

    const oneOrder = makeState({ orders: [openOrder('broker-1')] })
    expectBlocked(Reason.UnresolvedOrdersExceeded, makeIntent(), oneOrder, makePolicy())
  })

  test('does not require buying power for a position-reducing sell', () => {
    const result = evaluate(
      makeIntent({ side: OrderSide.Sell }),
      makeState({ account: { ...baseState().account, buyingPowerMicros: '0' } }),
      makePolicy(),
    )
    expect(result.decision.outcome).toBe(RiskOutcome.Approved)
    expect(result.metrics.postTradeSymbolExposureMicros).toBe('0')
  })

  test('blocks a sell that would open a short position', () => {
    const intent = makeIntent({ side: OrderSide.Sell, quantityMicros: '2000000', notionalLimitMicros: '200000000' })
    const policy = makePolicy({
      maxOrderNotionalMicros: '200000000',
      maxDailyTradedNotionalMicros: '300000000',
    })

    expectBlocked(Reason.ShortPositionNotAllowed, intent, makeState(), policy)
  })

  test('revalues the current symbol at the current reference price before projecting exposure', () => {
    const state = makeState({
      account: { ...baseState().account, buyingPowerMicros: '200000000' },
      referencePriceMicros: '200000000',
      expectedExecutionPriceMicros: '200000000',
    })
    const intent = makeIntent({ notionalLimitMicros: '200000000' })
    const policy = makePolicy({
      maxOrderNotionalMicros: '200000000',
      maxSymbolExposureMicros: '400000000',
      maxGrossExposureMicros: '500000000',
      maxNetExposureMicros: '500000000',
      maxDailyTradedNotionalMicros: '300000000',
    })
    const result = evaluate(intent, state, policy)

    expect(result.decision.outcome).toBe(RiskOutcome.Approved)
    expect(result.metrics.postTradeSymbolExposureMicros).toBe('400000000')
    expect(result.metrics.postTradeGrossExposureMicros).toBe('500000000')
    expect(result.metrics.postTradeNetExposureMicros).toBe('500000000')
    expectBlocked(
      Reason.SymbolExposureExceeded,
      intent,
      state,
      makePolicy({ ...policy, maxSymbolExposureMicros: '399999999' }),
    )
  })

  test('blocks an existing short while retaining conservative exposure metrics', () => {
    const positions = [
      baseState().positions[0],
      {
        ...baseState().positions[1],
        quantityMicros: '-1000000',
        averageEntryPriceMicros: '200000000',
        marketPriceMicros: '200000000',
        marketValueMicros: '-200000000',
        unrealizedPnlMicros: '0',
      },
    ]
    const state = makeState({
      account: { ...baseState().account, buyingPowerMicros: '200000000' },
      positions,
      referencePriceMicros: '200000000',
      expectedExecutionPriceMicros: '198000000',
    })
    const intent = makeIntent({ side: OrderSide.Sell, notionalLimitMicros: '198000000' })
    const policy = makePolicy({
      maxOrderNotionalMicros: '198000000',
      maxSymbolExposureMicros: '400000000',
      maxGrossExposureMicros: '500000000',
      maxNetExposureMicros: '300000000',
      maxDailyTradedNotionalMicros: '298000000',
    })
    const result = evaluate(intent, state, policy)

    expect(result.decision.outcome).toBe(RiskOutcome.Blocked)
    expect(result.decision.reasonCodes).toContain(Reason.ShortPositionNotAllowed)
    expect(result.metrics.orderNotionalMicros).toBe('198000000')
    expect(result.metrics.postTradeSymbolExposureMicros).toBe('-400000000')
    expectBlocked(
      Reason.SymbolExposureExceeded,
      intent,
      state,
      makePolicy({ ...policy, maxSymbolExposureMicros: '399999999' }),
    )
  })

  test('rounds final net exposure outward after cross-symbol offsets', () => {
    const state = makeState({
      account: { ...baseState().account, buyingPowerMicros: '50' },
      positions: [
        {
          ...baseState().positions[0],
          quantityMicros: '2',
          averageEntryPriceMicros: '50000000',
          marketPriceMicros: '50000000',
          marketValueMicros: '100',
          unrealizedPnlMicros: '0',
        },
        {
          ...baseState().positions[1],
          quantityMicros: '-1',
          averageEntryPriceMicros: '49100000',
          marketPriceMicros: '49100000',
          marketValueMicros: '-49',
          unrealizedPnlMicros: '0',
        },
      ],
      referencePriceMicros: '49100000',
      expectedExecutionPriceMicros: '49100000',
    })
    const intent = makeIntent({ side: OrderSide.Sell, quantityMicros: '1', notionalLimitMicros: '50' })
    const result = evaluate(intent, state, makePolicy())

    expect(result.metrics.postTradeSymbolExposureMicros).toBe('-99')
    expect(result.metrics.postTradeNetExposureMicros).toBe('2')
    expectBlocked(Reason.NetExposureExceeded, intent, state, makePolicy({ maxNetExposureMicros: '1' }))
  })

  test('fails closed on identity, authority, reconciliation, freshness, session, and mutation state', () => {
    expectBlocked(Reason.AccountMismatch, makeIntent(), makeState(), makePolicy({ accountId: 'another-account' }))
    expectBlocked(
      Reason.AccountNotActive,
      makeIntent(),
      makeState({ account: { ...baseState().account, status: AccountStatus.Restricted } }),
    )
    expectBlocked(
      Reason.EquityNotPositive,
      makeIntent(),
      makeState({ account: { ...baseState().account, equityMicros: '0' } }),
    )
    expectBlocked(Reason.SymbolNotAllowed, makeIntent(), makeState(), makePolicy({ allowedSymbols: ['AMD'] }))
    expectBlocked(Reason.MarketDataSymbolMismatch, makeIntent(), makeState({ marketDataSymbol: 'AMD' }), makePolicy())
    expectBlocked(Reason.OrderTypeNotAllowed, makeIntent({ orderType: OrderType.Limit }), makeState(), makePolicy())
    expectBlocked(
      Reason.TimeInForceNotAllowed,
      makeIntent(),
      makeState(),
      makePolicy({ allowedTimeInForce: [TimeInForce.GoodUntilCanceled] }),
    )
    expectBlocked(
      Reason.IntentNotPlanned,
      makeIntent({
        state: IntentState.Terminal,
        riskDecisionId: hash('7'),
        terminalOutcome: TerminalOutcome.Blocked,
      }),
    )
    expectBlocked(Reason.IntentTimeInvalid, makeIntent({ createdAt: '2026-07-21T21:00:00.001Z' }))
    expectBlocked(Reason.IntentTimeInvalid, makeIntent({ createdAt: '2026-07-21T20:59:29.999Z' }))
    expectBlocked(
      Reason.IntentStale,
      makeIntent({ createdAt: '2026-07-21T20:59:00.000Z' }),
      makeState(),
      makePolicy({ maxIntentAgeMs: 60_000 }),
    )
    expectBlocked(
      Reason.AuthorityNotPaper,
      makeIntent(),
      makeState({
        authority: {
          ...baseState().authority,
          maximum: Authority.Observe,
          effective: Authority.Observe,
        },
      }),
    )
    expectBlocked(
      Reason.KillActive,
      makeIntent(),
      makeState({
        authority: {
          ...baseState().authority,
          effective: Authority.Observe,
          kill: KillState.Active,
          reason: 'operator kill',
        },
      }),
    )
    expectBlocked(
      Reason.ReconciliationNotExact,
      makeIntent(),
      makeState({
        reconciliation: {
          ...baseState().reconciliation,
          observedHash: hash('8'),
          status: ReconciliationStatus.Discrepancy,
          discrepancies: [
            {
              discrepancyId: hash('9'),
              kind: DiscrepancyKind.Account,
              identity: 'paper-account-1',
              expected: 'expected',
              observed: 'observed',
              evidenceHash: hash('b'),
              firstObservedAt: observedAt,
              lastObservedAt: observedAt,
            },
          ],
        },
      }),
    )
    expectBlocked(
      Reason.ReconciliationNotExact,
      makeIntent(),
      makeState({
        reconciliation: {
          ...baseState().reconciliation,
          expectedHash: hash('a'),
          observedHash: hash('a'),
        },
      }),
    )
    expectBlocked(Reason.BrokerStateStale, makeIntent(), makeState(), makePolicy({ maxBrokerStateAgeMs: 30_000 }))
    expectBlocked(Reason.MarketDataStale, makeIntent(), makeState(), makePolicy({ maxMarketDataAgeMs: 30_000 }))
    const state = makeState()
    expectBlocked(
      Reason.OutsideSession,
      makeIntent(),
      makeState({
        executionSession: changeExecutionWindow(state.executionSession, { submissionCutoffAt: evaluatedAt }),
      }),
      makePolicy(),
    )
    expectBlocked(Reason.UnknownMutation, makeIntent(), makeState({ unknownMutationCount: 1 }), makePolicy())
  })

  test('binds every intent, policy, and evidence change and caps approval lifetime', () => {
    const baseline = evaluate(makeIntent(), makeState(), makePolicy())
    const changedIntent = evaluate(makeIntent({ clientOrderId: 'risk-test-order-2' }), makeState(), makePolicy())
    const changedPolicy = evaluate(makeIntent(), makeState(), makePolicy({ allowedSymbols: ['AMD', 'NVDA', 'WDC'] }))
    const changedState = evaluate(makeIntent(), makeState({ marketDataHash: hash('9') }), makePolicy())
    const changedAccounting = evaluate(makeIntent(), makeState({ accountingHash: hash('b') }), makePolicy())

    expect(changedIntent.input.intentId).toBe(baseline.input.intentId)
    expect(changedIntent.input.inputHash).not.toBe(baseline.input.inputHash)
    expect(changedIntent.decision.decisionId).not.toBe(baseline.decision.decisionId)
    expect(changedPolicy.policyHash).not.toBe(baseline.policyHash)
    expect(changedPolicy.input.inputHash).not.toBe(baseline.input.inputHash)
    expect(changedState.input.inputHash).not.toBe(baseline.input.inputHash)
    expect(changedAccounting.input.inputHash).not.toBe(baseline.input.inputHash)

    const ttlCapped = evaluate(makeIntent(), makeState(), makePolicy({ decisionTtlMs: 1_000 }))
    const freshnessCapped = evaluate(
      makeIntent(),
      makeState(),
      makePolicy({ decisionTtlMs: 60_000, maxBrokerStateAgeMs: 30_001, maxMarketDataAgeMs: 30_001 }),
    )
    const cutoffCapped = evaluate(
      makeIntent(),
      makeState({
        executionSession: changeExecutionWindow(makeState().executionSession, {
          submissionCutoffAt: '2026-07-21T21:00:00.001Z',
        }),
      }),
      makePolicy({ decisionTtlMs: 60_000 }),
    )
    const intentCapped = evaluate(
      makeIntent(),
      makeState(),
      makePolicy({ decisionTtlMs: 60_000, maxIntentAgeMs: 15_001 }),
    )
    expect(ttlCapped.input.freshUntil).toBe('2026-07-21T21:00:01.000Z')
    expect(freshnessCapped.input.freshUntil).toBe('2026-07-21T21:00:00.001Z')
    expect(cutoffCapped.input.freshUntil).toBe('2026-07-21T21:00:00.001Z')
    expect(intentCapped.input.freshUntil).toBe('2026-07-21T21:00:00.001Z')
  })
})
