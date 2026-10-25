import { withProviderSessions } from './testing/market-calendar-fixture'
import { describe, expect, test } from 'bun:test'

import { Result, Schema } from 'effect'
import fc from 'fast-check'
import { checkProperty } from './testing/property-test-support'

import { canonicalHashV1Result } from './hash'
import { deriveExecutionIntentPricing } from './execution/intent-pricing'
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
  ReferenceIntentSchema,
  RiskOutcome,
  TerminalOutcome,
  TimeInForce,
  type Intent,
  type ReferenceIntent,
} from './execution/contracts'
import { reconciledStateHash } from './simulation-reconciliation/broker-model'
import { utcInstantFromEpochMillis } from './time'
import {
  accountLossMicros,
  BrokerMode,
  EvaluationSchema,
  Gate,
  isAuthorityNotGrantedReason,
  orderedRiskGateDefinitions,
  PolicySchema,
  executionRiskPolicySchemaVersion,
  Reason,
  RiskEvaluationFailure,
  StateSchema,
  evaluate,
  type Evaluation,
  type Policy,
  type State,
} from './risk'
import { strictParseOptions } from './schemas'

const evaluatedAt = '2026-07-21T19:30:00.000Z'

test('property: absolute account loss limits retain micro-dollar precision after capital translations', () => {
  checkProperty(
    'account-loss-capital-translation',
    fc.property(
      fc.bigInt({ min: 0n, max: 10n ** 25n }),
      fc.bigInt({ min: 0n, max: 10n ** 25n }),
      fc.bigInt({ min: 0n, max: 10n ** 15n }),
      (equity, addition, loss) => {
        const original = accountLossMicros({
          accountEquityMicros: equity,
          dayStartEquityMicros: equity + loss,
          peakEquityMicros: equity + loss + 1n,
        })
        const translated = accountLossMicros({
          accountEquityMicros: equity + addition,
          dayStartEquityMicros: equity + addition + loss,
          peakEquityMicros: equity + addition + loss + 1n,
        })
        expect(translated).toEqual(original)
        expect(original.drawdownMicros - original.dailyLossMicros).toBe(1n)
      },
    ),
  )
})
const observedAt = '2026-07-21T19:29:30.000Z'
const hash = (character: string): string => character.repeat(64)

const decodePolicy = Schema.decodeUnknownSync(PolicySchema, strictParseOptions)
const decodeState = Schema.decodeUnknownSync(StateSchema, strictParseOptions)
const decodeIntent = Schema.decodeUnknownSync(IntentSchema, strictParseOptions)
const decodeReferenceIntent = Schema.decodeUnknownSync(ReferenceIntentSchema, strictParseOptions)
const decodeEvaluationResult = Schema.decodeUnknownResult(EvaluationSchema, strictParseOptions)

type OperationReason<Input> = Input extends {
  readonly operation: infer Operation
  readonly reason: infer FailureReason
}
  ? { readonly operation: Operation; readonly reason: FailureReason }
  : never
type RiskFailurePair = OperationReason<ConstructorParameters<typeof RiskEvaluationFailure>[0]>
const riskFailurePairs = [
  { operation: 'bind-authority', reason: 'authority-contract' },
  { operation: 'bind-authority', reason: 'authority-generation' },
  { operation: 'bind-authority', reason: 'authority-maximum' },
  { operation: 'canonicalize-input', reason: 'evidence' },
  { operation: 'canonicalize-input', reason: 'reconciliation' },
  { operation: 'compute-metrics', reason: 'order-notional' },
  { operation: 'decode-input', reason: 'intent' },
  { operation: 'decode-input', reason: 'policy' },
  { operation: 'decode-input', reason: 'positions' },
  { operation: 'decode-input', reason: 'state' },
  { operation: 'decode-output', reason: 'decision' },
  { operation: 'decode-output', reason: 'evaluation' },
  { operation: 'decode-output', reason: 'input' },
] as const satisfies readonly RiskFailurePair[]
type MissingRiskFailurePair = Exclude<RiskFailurePair, (typeof riskFailurePairs)[number]>
type InvalidRiskFailurePair = Exclude<(typeof riskFailurePairs)[number], RiskFailurePair>
const riskFailurePairCoverage: [MissingRiskFailurePair, InvalidRiskFailurePair] extends [never, never] ? true : never =
  true

type ExecutionSession = State['executionSession']
type ExecutionSessionWithoutHash = Omit<ExecutionSession, 'bindingHash'>
const rehashExecutionSession = (material: ExecutionSessionWithoutHash): ExecutionSession => ({
  ...material,
  bindingHash: Result.getOrThrow(canonicalHashV1Result(material)),
})
const changeExecutionWindow = (
  binding: ExecutionSession,
  overrides: Partial<Pick<ExecutionSession, 'submissionOpenAt' | 'submissionCutoffAt'>>,
): ExecutionSession => {
  const { bindingHash: _, ...material } = binding
  const cutoff = overrides.submissionCutoffAt ?? binding.submissionCutoffAt
  return rehashExecutionSession({
    ...material,
    ...overrides,
    decisionAfterOpenMs:
      Date.parse(overrides.submissionOpenAt ?? binding.submissionOpenAt) - Date.parse(binding.executionSession.openAt),
    submissionCutoffAfterOpenMs: Date.parse(cutoff) - Date.parse(binding.executionSession.openAt),
  })
}

const makePolicy = (overrides: Partial<Policy> = {}): Policy =>
  decodePolicy({
    schemaVersion: 'bayn.execution-risk-policy.v4',
    accountId: 'paper-account-1',
    brokerMode: BrokerMode.Execution,
    allowedSymbols: ['AMD', 'NVDA'],
    allowedOrderTypes: [OrderType.Limit],
    allowedTimeInForce: [TimeInForce.Day, TimeInForce.ImmediateOrCancel],
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
    maxOpenOrders: 2,
    decisionTtlMs: 30_000,
    ...overrides,
  })

const baseState = (): State => {
  const account = {
    schemaVersion: 'bayn.paper-account-snapshot.v2' as const,
    cryptoFeeTier: null,
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
      schemaVersion: 'bayn.position.v2' as const,
      costBasisMicros: '90000000',
      accountId: 'paper-account-1',
      symbol: 'AMD',
      quantityAtoms: '1000000000',
      averageEntryPriceMicros: '90000000',
      marketPriceMicros: '100000000',
      marketValueMicros: '100000000',
      unrealizedPnlMicros: '10000000',
      observedAt,
    },
    {
      schemaVersion: 'bayn.position.v2' as const,
      costBasisMicros: '90000000',
      accountId: 'paper-account-1',
      symbol: 'NVDA',
      quantityAtoms: '1000000000',
      averageEntryPriceMicros: '90000000',
      marketPriceMicros: '100000000',
      marketValueMicros: '100000000',
      unrealizedPnlMicros: '10000000',
      observedAt,
    },
  ]
  const orders: readonly ReturnType<typeof openOrder>[] = []
  const accountingHash = hash('a')
  const reconciledStateHashValue = Result.getOrThrow(
    reconciledStateHash({
      account,
      positions,
      positionsObservedAt: observedAt,
      orders,
      ordersObservedAt: observedAt,
      accountingHash,
    }),
  )
  const calendar = withProviderSessions({
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v2' as const,
    source: 'alpaca-v2-calendar' as const,
    requestedRange: { start: '2026-07-21' as const, end: '2026-07-31' as const },
    timeZone: 'UTC' as const,
    sessions: [
      {
        date: '2026-07-21' as const,
        openAt: '2026-07-21T19:00:00.000Z',
        closeAt: '2026-07-21T20:30:00.000Z',
      },
    ],
  })
  const executionSession = rehashExecutionSession({
    schemaVersion: 'bayn.execution-session-binding.v3',
    planningBrokerState: { observedAt, contentHash: reconciledStateHashValue },
    calendar: { ...calendar, normalizedResponseHash: Result.getOrThrow(canonicalHashV1Result(calendar)) },
    executionSession: calendar.sessions[0],
    submissionOpenAt: observedAt,
    submissionCutoffAt: '2026-07-21T20:00:00.000Z',
    decisionAfterOpenMs: 0,
    submissionCutoffAfterOpenMs: 60 * 60_000,
  })
  return decodeState({
    schemaVersion: 'bayn.paper-risk-state.v2',
    brokerMode: BrokerMode.Execution,
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
      maximum: Authority.Execution,
      effective: Authority.Execution,
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
    executionMarketDataHash: hash('5'),
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
  const reconciledStateHashValue = Result.getOrThrow(
    reconciledStateHash({
      account: merged.account,
      positions: merged.positions,
      positionsObservedAt: merged.positionsObservedAt,
      orders: merged.orders,
      ordersObservedAt: merged.ordersObservedAt,
      accountingHash: merged.accountingHash,
    }),
  )
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

const makeIntent = (overrides: Partial<Intent> = {}): Intent => {
  const value = {
    schemaVersion: 'bayn.execution-intent.v5',
    intentId: hash('6'),
    authorityGenerationHash: hash('4'),
    strategyName: 'risk-balanced-trend',
    cycleId: hash('7'),
    decisionHash: hash('8'),
    policyHash: Result.getOrThrow(canonicalHashV1Result(makePolicy())),
    accountId: 'paper-account-1',
    clientOrderId: 'risk-test-order-1',
    symbol: 'NVDA',
    side: OrderSide.Buy,
    orderType: OrderType.Limit,
    timeInForce: TimeInForce.Day,
    quantityAtoms: '1000000000',
    notionalLimitMicros: '100000000',
    limitPriceMicros: '100000000',
    state: IntentState.Planned,
    createdAt: '2026-07-21T19:29:45.000Z',
    ...overrides,
  }
  return decodeIntent({
    ...value,
    notionalLimitMicros:
      overrides.notionalLimitMicros ??
      (
        (BigInt(value.quantityAtoms) * BigInt(value.limitPriceMicros) +
          (value.side === OrderSide.Buy ? 999999999n : 0n)) /
        1000000000n
      ).toString(),
  })
}

const makeReferenceIntent = (): ReferenceIntent => {
  const { authorityGenerationHash: _, ...intent } = makeIntent()
  return decodeReferenceIntent({ ...intent, schemaVersion: 'bayn.reference-intent.v4' })
}

const evaluateSuccess = (
  intent: Intent | ReferenceIntent,
  state: State,
  policy: Policy,
  proposedPositions?: State['positions'],
): Evaluation => {
  const result = evaluate({ intent, state, policy, proposedPositions })
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

const expectBlocked = (
  reason: Reason,
  intent: Intent | ReferenceIntent = makeIntent(),
  state = makeState(),
  policy = makePolicy(),
): void => {
  const result = evaluateSuccess(intent, state, policy)
  expect(result.decision.outcome).toBe(RiskOutcome.Blocked)
  expect(result.decision.reasonCodes).toContain(reason)
}

describe('entry risk properties', () => {
  const validEntry = (quantity: number) => {
    const policy = makePolicy()
    const state = makeState()
    const intent = makeIntent({ quantityAtoms: String(BigInt(quantity) * 1000n) })
    expect(evaluateSuccess(intent, state, policy).decision.outcome).toBe(RiskOutcome.Approved)
    return { policy, state, intent }
  }

  test('property: authority restrictions and unknown mutations block otherwise approved generated entries', () => {
    checkProperty(
      'entry-authority',
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1000 }),
        (quantity, unknownMutationCount) => {
          const { policy, state, intent } = validEntry(quantity)
          expectBlocked(Reason.UnknownMutation, intent, makeState({ unknownMutationCount }), policy)
          expectBlocked(
            Reason.AuthorityNotGranted,
            intent,
            makeState({ authority: { ...state.authority, effective: Authority.Observe } }),
            policy,
          )
          expectBlocked(
            Reason.KillActive,
            intent,
            makeState({
              authority: {
                ...state.authority,
                effective: Authority.Observe,
                kill: KillState.Active,
                reason: 'synthetic property restriction',
              },
            }),
            policy,
          )
          expect(
            evaluate({
              intent,
              policy,
              state: makeState({ authority: { ...state.authority, generationHash: hash('9') } }),
            }),
          ).toMatchObject({ _tag: 'Failure', failure: { operation: 'bind-authority', reason: 'authority-generation' } })
        },
      ),
    )
  })

  test('property: market and broker freshness include the exact expiry boundary', () => {
    checkProperty(
      'entry-freshness',
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 60_000 }),
        (quantity, overdueMs) => {
          const { policy, intent } = validEntry(quantity)
          const before = utcInstantFromEpochMillis(Date.parse(observedAt) + policy.maxMarketDataAgeMs - 1)
          const freshIntent = { ...intent, createdAt: before }
          expect(evaluateSuccess(freshIntent, makeState({ evaluatedAt: before }), policy).decision.outcome).toBe(
            RiskOutcome.Approved,
          )
          for (const offset of [0, overdueMs + 1]) {
            const at = utcInstantFromEpochMillis(Date.parse(observedAt) + policy.maxMarketDataAgeMs + offset)
            const expired = makeState({ evaluatedAt: at })
            expectBlocked(Reason.MarketDataStale, freshIntent, expired, policy)
            expectBlocked(Reason.BrokerStateStale, freshIntent, expired, policy)
          }
        },
      ),
    )
  })

  test('property: an entry at its exact notional cap passes and one micro above blocks', () => {
    checkProperty(
      'entry-notional-boundary',
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (quantity) => {
        const { state } = validEntry(quantity)
        const notional = BigInt(quantity) * 100n
        const policy = makePolicy({ maxOrderNotionalMicros: String(notional) })
        const intent = makeIntent({
          quantityAtoms: String(BigInt(quantity) * 1000n),
          policyHash: Result.getOrThrow(canonicalHashV1Result(policy)),
        })
        expect(evaluateSuccess(intent, state, policy).decision.outcome).toBe(RiskOutcome.Approved)
        const stricter = makePolicy({ maxOrderNotionalMicros: String(notional - 1n) })
        expectBlocked(
          Reason.OrderNotionalExceeded,
          { ...intent, policyHash: Result.getOrThrow(canonicalHashV1Result(stricter)) },
          state,
          stricter,
        )
      }),
    )
  })
})

const openOrder = (brokerOrderId: string) => ({
  schemaVersion: 'bayn.order.v3' as const,
  accountId: 'paper-account-1',
  brokerOrderId,
  clientOrderId: `client-${brokerOrderId}`,
  symbol: 'NVDA',
  side: OrderSide.Buy,
  orderType: OrderType.Market,
  timeInForce: TimeInForce.Day,
  quantityAtoms: '1000000000',
  filledQuantityAtoms: '0',
  status: OrderStatus.New,
  observedAt,
})

describe('bounded execution risk', () => {
  test('retains exact authority identity while preserving millisecond observation ordering', () => {
    const state = makeState()
    const updatedAt = '2026-07-21T19:29:30.000402Z'
    const accepted = decodeState({ ...state, authority: { ...state.authority, updatedAt } })
    expect(accepted.authority.updatedAt).toBe(updatedAt)
    expect(accepted.authorityObservedAt).toBe(observedAt)
    expect(() =>
      decodeState({ ...state, authority: { ...state.authority, updatedAt: '2026-07-21T19:29:30.001001Z' } }),
    ).toThrow()
  })

  test('rounds fractional spending outward at the intent and order limit boundary', () => {
    const intent = makeIntent({ quantityAtoms: '1000000001' })
    const state = makeState({ account: { ...baseState().account, buyingPowerMicros: '100000001' } })
    const policy = makePolicy({
      maxOrderNotionalMicros: '100000001',
      maxSymbolExposureMicros: '200000001',
      maxGrossExposureMicros: '300000001',
      maxNetExposureMicros: '300000001',
      maxDailyTradedNotionalMicros: '200000001',
    })
    const result = evaluateSuccess(intent, state, policy)

    expect(intent.notionalLimitMicros).toBe('100000001')
    expect(result.metrics.orderNotionalMicros).toBe('100000001')
    expect(result.decision.outcome).toBe(RiskOutcome.Approved)
    expectBlocked(
      Reason.OrderNotionalExceeded,
      intent,
      state,
      makePolicy({ ...policy, maxOrderNotionalMicros: '100000000' }),
    )
    expect(() => makeIntent({ ...intent, notionalLimitMicros: '100000000' })).toThrow()
  })

  test('strictly decodes complete policy and coherent state', () => {
    expect(makePolicy().schemaVersion).toBe('bayn.execution-risk-policy.v4')
    expect(makeState().schemaVersion).toBe('bayn.paper-risk-state.v2')

    const rawPolicy = { ...makePolicy() }
    const missingPolicy: Record<string, unknown> = { ...rawPolicy }
    delete missingPolicy['maxOrderNotionalMicros']
    expect(() => decodePolicy(missingPolicy)).toThrow()
    expect(() => decodePolicy({ ...rawPolicy, brokerMode: 'LIVE' })).toThrow()
    expect(() => decodePolicy({ ...rawPolicy, allowedSymbols: ['NVDA', 'AMD'] })).toThrow()
    expect(() => decodePolicy({ ...rawPolicy, allowedSymbols: ['AMD', 'AMD'] })).toThrow()
    expect(decodePolicy({ ...rawPolicy, allowedOrderTypes: [OrderType.Limit] }).allowedOrderTypes).toEqual([
      OrderType.Limit,
    ])
    expect(() => decodePolicy({ ...rawPolicy, allowedOrderTypes: [OrderType.Market, OrderType.Limit] })).toThrow()
    expect(() => decodePolicy({ ...rawPolicy, allowedOrderTypes: [OrderType.Market, OrderType.Market] })).toThrow()
    expect(() => decodePolicy({ ...rawPolicy, maxOrderNotionalMicros: '01' })).toThrow()
    expect(() => decodePolicy({ ...rawPolicy, maxOrderNotionalMicros: '9223372036854775808' })).toThrow()
    expect(() => decodePolicy({ ...rawPolicy, maxOpenOrders: 0 })).toThrow()
    expect(() => decodePolicy({ ...rawPolicy, decisionTtlMs: 86_400_001 })).toThrow()
    expect(() => decodePolicy({ ...rawPolicy, extra: true })).toThrow()

    const state = baseState()
    const intradayMarketDataHash = hash('6')
    expect(
      decodeState({
        ...state,
        marketDataHash: intradayMarketDataHash,
        executionMarketDataHash: intradayMarketDataHash,
      }).executionMarketDataHash,
    ).toBe(intradayMarketDataHash)
    expect(() => decodeState({ ...state, marketDataHash: intradayMarketDataHash })).toThrow()
    expect(() => decodeState({ ...state, executionMarketDataHash: intradayMarketDataHash })).toThrow()
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
    expect(() => decodeState({ ...state, marketDataObservedAt: '2026-07-21T19:30:00.001Z' })).toThrow()
    expect(() =>
      decodeState({
        ...state,
        executionSession: { ...state.executionSession, bindingHash: hash('0') },
      }),
    ).toThrow()

    const earlierOrderObservation = '2026-07-21T19:29:29.000Z'
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

  test('emits an account-neutral authority reason and decodes legacy hash-bound evidence unchanged', () => {
    const current = evaluateSuccess(
      makeReferenceIntent(),
      makeState({
        authority: {
          ...baseState().authority,
          maximum: Authority.Observe,
          effective: Authority.Observe,
        },
      }),
      makePolicy(),
    )
    expect(current.decision.reasonCodes).toContain(Reason.AuthorityNotGranted)
    expect(current.decision.reasonCodes).not.toContain(Reason.LegacyAuthorityNotGranted)
    expect(String(Reason.AuthorityNotGranted)).toBe('AUTHORITY_NOT_GRANTED')

    const { decisionId: _decisionId, ...currentDecisionMaterial } = current.decision
    const legacyDecisionMaterial = {
      ...currentDecisionMaterial,
      reasonCodes: currentDecisionMaterial.reasonCodes.map((reason) =>
        isAuthorityNotGrantedReason(reason) ? Reason.LegacyAuthorityNotGranted : reason,
      ),
    }
    const legacyEvaluation = {
      ...current,
      decision: {
        ...legacyDecisionMaterial,
        decisionId: Result.getOrThrow(canonicalHashV1Result(legacyDecisionMaterial)),
      },
      gates: current.gates.map((gate) =>
        gate.name === Gate.Authority ? { ...gate, reason: Reason.LegacyAuthorityNotGranted } : gate,
      ),
    }

    expect(decodeEvaluationResult(legacyEvaluation)).toMatchObject({ _tag: 'Success' })
  })

  test('approves the exact limit boundary and binds a deterministic decision', () => {
    const first = evaluateSuccess(makeIntent(), makeState(), makePolicy())
    const second = evaluateSuccess(makeIntent(), makeState(), makePolicy())

    expect(first).toEqual(second)
    expect(first.decision.outcome).toBe(RiskOutcome.Approved)
    expect(first.decision.reasonCodes).toEqual([])
    expect(first.gates.every((gate) => gate.passed)).toBe(true)
    expect(first.gates.map(({ name, reason }) => ({ name, reason }))).toEqual(
      orderedRiskGateDefinitions.map(({ name, reason }) => ({ name, reason })),
    )
    expect({
      inputHash: first.input.inputHash,
      decisionId: first.decision.decisionId,
    }).toEqual({
      inputHash: '345d6223e06dd20434f778e9b8e286a82288d6a9cbc0e1603540a2861ea69c03',
      decisionId: '8c79bb520794f042599f6955d27c908980c876a4c95080a0c004908c5105461d',
    })
    expect(first.input.freshUntil).toBe('2026-07-21T19:30:30.000Z')
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

  test('approves quote-bound LIMIT/IOC only when the policy explicitly allows both terms', () => {
    const limitIntent = makeIntent({
      symbol: 'BTC/USD',
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.ImmediateOrCancel,
    })
    const policy = decodePolicy({
      ...makePolicy(),
      schemaVersion: executionRiskPolicySchemaVersion,
      allowedSymbols: ['AMD', 'BTC/USD', 'NVDA'],
      allowedOrderTypes: [OrderType.Limit],
      allowedTimeInForce: [TimeInForce.ImmediateOrCancel],
    })

    expect(evaluateSuccess(limitIntent, makeState({ marketDataSymbol: 'BTC/USD' }), policy).decision.outcome).toBe(
      RiskOutcome.Approved,
    )
    expect(() => decodePolicy({ ...policy, schemaVersion: 'bayn.paper-risk-policy.v2' })).toThrow()
  })

  test('uses the same LIMIT/DAY allowlist for fractional closes and ordinary orders', () => {
    const policy = decodePolicy({
      ...makePolicy(),
      schemaVersion: executionRiskPolicySchemaVersion,
      allowedOrderTypes: [OrderType.Limit],
      allowedTimeInForce: [TimeInForce.Day],
    })
    const positions = baseState().positions.map((position) =>
      position.symbol === 'NVDA'
        ? {
            ...position,
            quantityAtoms: '500000000',
            marketValueMicros: '50000000',
            unrealizedPnlMicros: '5000000',
          }
        : position,
    )
    const state = makeState({
      positions,
      closeOnly: true,
      closeOnlyExpiresAt: '2026-07-21T19:31:00.000Z',
    })
    const intent = makeIntent({
      policyHash: Result.getOrThrow(canonicalHashV1Result(policy)),
      side: OrderSide.Sell,
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.Day,
      quantityAtoms: '500000000',
      notionalLimitMicros: '50000000',
    })

    expect(evaluateSuccess(intent, state, policy).decision.outcome).toBe(RiskOutcome.Approved)
    expect(evaluateSuccess(intent, makeState({ positions }), policy).decision.outcome).toBe(RiskOutcome.Approved)
    const excludedDuration = makePolicy({ ...policy, allowedTimeInForce: [TimeInForce.ImmediateOrCancel] })
    expectBlocked(Reason.TimeInForceNotAllowed, intent, state, excludedDuration)
    expectBlocked(Reason.TimeInForceNotAllowed, intent, makeState({ positions }), excludedDuration)
  })

  test('admits an exact LIMIT/DAY buy-to-cover only in close-only mode', () => {
    const policy = decodePolicy({
      ...makePolicy(),
      schemaVersion: executionRiskPolicySchemaVersion,
      allowedOrderTypes: [OrderType.Limit],
      allowedTimeInForce: [TimeInForce.Day],
    })
    const positions = baseState().positions.map((position) =>
      position.symbol === 'NVDA'
        ? {
            ...position,
            quantityAtoms: '-500000000',
            marketValueMicros: '-50000000',
            unrealizedPnlMicros: '0',
          }
        : position,
    )
    const state = makeState({
      positions,
      closeOnly: true,
      closeOnlyExpiresAt: '2026-07-21T19:31:00.000Z',
    })
    const intent = makeIntent({
      policyHash: Result.getOrThrow(canonicalHashV1Result(policy)),
      side: OrderSide.Buy,
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.Day,
      quantityAtoms: '500000000',
      notionalLimitMicros: '50000000',
    })

    const cover = evaluateSuccess(intent, state, policy)
    expect(cover.decision.outcome).toBe(RiskOutcome.Approved)
    expect(cover.gates.find((gate) => gate.name === Gate.LongOnly)?.passed).toBe(true)
    expectBlocked(Reason.ShortPositionNotAllowed, intent, makeState({ positions }), policy)
  })

  test.each(['BTC/USD', 'ETH/USD', 'SOL/USD', 'NVDA'])(
    'enforces the native LIMIT duration and price for a fractional %s close',
    (symbol) => {
      const crypto = symbol.includes('/')
      const supportedDuration = crypto ? TimeInForce.ImmediateOrCancel : TimeInForce.Day
      const unsupportedDuration = crypto ? TimeInForce.Day : TimeInForce.ImmediateOrCancel
      const policy = makePolicy({
        schemaVersion: executionRiskPolicySchemaVersion,
        allowedSymbols: ['AMD', symbol],
        allowedOrderTypes: [OrderType.Limit],
        allowedTimeInForce: [supportedDuration],
        maxOrderNotionalMicros: '200000000',
      })
      const positions = baseState().positions.map((position) =>
        position.symbol === 'NVDA'
          ? { ...position, symbol, quantityAtoms: '1000000001', marketValueMicros: '100000001' }
          : position,
      )
      const state = makeState({
        positions,
        marketDataSymbol: symbol,
        closeOnly: true,
        closeOnlyExpiresAt: '2026-07-21T19:31:00.000Z',
      })
      const close = makeIntent({
        policyHash: Result.getOrThrow(canonicalHashV1Result(policy)),
        symbol,
        side: OrderSide.Sell,
        orderType: OrderType.Limit,
        timeInForce: supportedDuration,
        quantityAtoms: '1000000001',
        notionalLimitMicros: '100000000',
      })
      expect(evaluateSuccess(close, state, policy).decision.outcome).toBe(RiskOutcome.Approved)
      expect(() => makeIntent({ ...close, timeInForce: unsupportedDuration })).toThrow()
      expect(() => decodeIntent({ ...close, timeInForce: TimeInForce.GoodUntilCanceled })).toThrow()
      expectBlocked(Reason.DailyTradedNotionalExceeded, close, makeState({ ...state, closeOnly: false }), policy)
    },
  )

  test('admits an out-of-policy symbol only as an exact reconciled close', () => {
    const positions = baseState().positions.map((position) =>
      position.symbol === 'NVDA'
        ? {
            ...position,
            symbol: 'TSLA',
          }
        : position,
    )
    const closeOnlyState = makeState({
      positions,
      marketDataSymbol: 'TSLA',
      closeOnly: true,
      closeOnlyExpiresAt: '2026-07-21T19:31:00.000Z',
    })
    const exactClose = makeIntent({
      symbol: 'TSLA',
      side: OrderSide.Sell,
      quantityAtoms: '1000000000',
    })

    const approved = evaluateSuccess(exactClose, closeOnlyState, makePolicy())
    expect(approved.decision.outcome).toBe(RiskOutcome.Approved)
    expect(approved.gates.find((gate) => gate.name === Gate.Symbol)?.passed).toBe(true)

    expectBlocked(Reason.SymbolNotAllowed, exactClose, makeState({ positions, marketDataSymbol: 'TSLA' }), makePolicy())
    expectBlocked(
      Reason.ShortPositionNotAllowed,
      makeIntent({
        symbol: 'TSLA',
        side: OrderSide.Sell,
        quantityAtoms: '2000000000',
        notionalLimitMicros: '200000000',
      }),
      closeOnlyState,
      makePolicy({ maxOrderNotionalMicros: '200000000', maxDailyTradedNotionalMicros: '300000000' }),
    )
  })

  test('does not require buying power for a strictly exposure-reducing short cover', () => {
    const positions = baseState().positions.map((position) =>
      position.symbol === 'NVDA'
        ? {
            ...position,
            quantityAtoms: '-1000000000',
            marketValueMicros: '-100000000',
            unrealizedPnlMicros: '0',
          }
        : position,
    )
    const state = makeState({
      account: { ...baseState().account, buyingPowerMicros: '0' },
      positions,
      reservedBuyingPowerMicros: '100000000',
      closeOnly: true,
      closeOnlyExpiresAt: '2026-07-21T19:31:00.000Z',
    })
    const cover = makeIntent({
      side: OrderSide.Buy,
      quantityAtoms: '1000000000',
      notionalLimitMicros: '100000000',
    })

    const result = evaluateSuccess(cover, state, makePolicy())
    expect(result.decision.outcome).toBe(RiskOutcome.Approved)
    expect(result.gates.find((gate) => gate.name === Gate.BuyingPower)?.passed).toBe(true)
    expect(result.metrics.postTradeSymbolExposureMicros).toBe('0')

    expectBlocked(Reason.BuyingPowerExceeded, cover, makeState({ ...state, closeOnly: false }), makePolicy())
    expectBlocked(
      Reason.ShortPositionNotAllowed,
      makeIntent({ side: OrderSide.Buy, quantityAtoms: '2000000000', notionalLimitMicros: '200000000' }),
      state,
      makePolicy({ maxOrderNotionalMicros: '200000000' }),
    )
  })

  test('permits only the bounded sell close through an active kill', () => {
    const closeOnlyState = makeState({
      closeOnly: true,
      closeOnlyExpiresAt: '2026-07-21T19:31:00.000Z',
      authority: {
        ...baseState().authority,
        effective: Authority.Observe,
        kill: KillState.Active,
        reason: 'paper close-only containment',
      },
    })

    const close = evaluateSuccess(makeIntent({ side: OrderSide.Sell }), closeOnlyState, makePolicy())
    expect(close.decision.outcome).toBe(RiskOutcome.Approved)
    expect(close.gates.find((gate) => gate.name === Gate.Kill)?.passed).toBe(true)
    expectBlocked(Reason.KillActive, makeIntent(), closeOnlyState)
  })

  test('lets only a strictly exposure-reducing close liquidate gains beyond entry limits', () => {
    const positions = baseState().positions.map((position) =>
      position.symbol === 'NVDA'
        ? {
            ...position,
            marketPriceMicros: '150000000',
            marketValueMicros: '150000000',
            unrealizedPnlMicros: '60000000',
          }
        : position,
    )
    const sharedState = {
      account: {
        ...baseState().account,
        cashMicros: '550000000',
        equityMicros: '800000000',
        buyingPowerMicros: '0',
      },
      positions,
      referencePriceMicros: '150000000',
      expectedExecutionPriceMicros: '150000000',
      dailyTradedNotionalMicros: '100000000',
    } satisfies Partial<State>
    const intent = makeIntent({
      side: OrderSide.Sell,
      quantityAtoms: '1000000000',
      limitPriceMicros: '150000000',
      notionalLimitMicros: '150000000',
    })
    const closeOnlyState = makeState({
      ...sharedState,
      closeOnly: true,
      closeOnlyExpiresAt: '2026-07-21T19:31:00.000Z',
    })
    const close = evaluateSuccess(intent, closeOnlyState, makePolicy())

    expect(close.decision.outcome).toBe(RiskOutcome.Approved)
    expect(close.metrics.orderNotionalMicros).toBe('150000000')
    expect(close.decision.reasonCodes).toEqual([])

    const ordinary = evaluateSuccess(intent, makeState(sharedState), makePolicy())
    expect(ordinary.decision.reasonCodes).toEqual(
      expect.arrayContaining([
        Reason.OrderNotionalExceeded,
        Reason.DailyTradedNotionalExceeded,
        Reason.DailyLossExceeded,
        Reason.DrawdownExceeded,
      ]),
    )

    const oversell = evaluateSuccess(
      makeIntent({
        side: OrderSide.Sell,
        quantityAtoms: '2000000000',
        limitPriceMicros: '150000000',
        notionalLimitMicros: '300000000',
      }),
      closeOnlyState,
      makePolicy({ maxDailyTradedNotionalMicros: '400000000' }),
    )
    expect(oversell.decision.reasonCodes).toContain(Reason.ShortPositionNotAllowed)
    expect(oversell.decision.reasonCodes).toContain(Reason.OrderNotionalExceeded)
  })

  test('approves at submission open and blocks immediately before it and exactly at cutoff', () => {
    const state = makeState()
    const atOpen = makeState({
      executionSession: changeExecutionWindow(state.executionSession, { submissionOpenAt: evaluatedAt }),
    })
    const beforeOpen = makeState({
      executionSession: changeExecutionWindow(state.executionSession, {
        submissionOpenAt: '2026-07-21T19:30:00.001Z',
      }),
    })
    const atCutoff = makeState({
      executionSession: changeExecutionWindow(state.executionSession, { submissionCutoffAt: evaluatedAt }),
    })
    const nearCutoffAt = '2026-07-21T19:30:00.500Z'
    const observeNearCutoff = makeState({
      authority: { ...state.authority, effective: Authority.Observe },
      executionSession: changeExecutionWindow(state.executionSession, { submissionCutoffAt: nearCutoffAt }),
    })

    expect(evaluateSuccess(makeIntent({ createdAt: evaluatedAt }), atOpen, makePolicy()).decision.outcome).toBe(
      RiskOutcome.Approved,
    )
    expectBlocked(Reason.OutsideSession, makeIntent(), beforeOpen, makePolicy())
    expectBlocked(Reason.OutsideSession, makeIntent(), atCutoff, makePolicy())
    const nearCutoff = evaluateSuccess(makeIntent(), observeNearCutoff, makePolicy())
    expect(nearCutoff.decision.reasonCodes).toContain(Reason.AuthorityNotGranted)
    expect(nearCutoff.decision.expiresAt).toBe(nearCutoffAt)
    expect(nearCutoff.input.freshUntil).toBe(nearCutoffAt)
  })

  test('blocks one micro beyond every money and exposure limit', () => {
    expect(() => makeIntent({ notionalLimitMicros: '99999999' })).toThrow()
    const cases: readonly [Reason, Intent, State, Policy][] = [
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

  test('blocks adverse slippage and an open-order count beyond the explicit cap', () => {
    const slippageState = makeState({
      account: { ...baseState().account, buyingPowerMicros: '101000000' },
      expectedExecutionPriceMicros: '101000000',
    })
    const slippageIntent = makeIntent({ limitPriceMicros: '101000000', notionalLimitMicros: '101000000' })
    const slippagePolicy = makePolicy({
      maxOrderNotionalMicros: '101000000',
      maxSymbolExposureMicros: '201000000',
      maxGrossExposureMicros: '301000000',
      maxNetExposureMicros: '301000000',
      maxDailyTradedNotionalMicros: '201000000',
      maxAdverseSlippageBps: 100,
    })
    expect(evaluateSuccess(slippageIntent, slippageState, slippagePolicy).decision.outcome).toBe(RiskOutcome.Approved)
    expectBlocked(
      Reason.AdverseSlippageExceeded,
      slippageIntent,
      slippageState,
      makePolicy({ ...slippagePolicy, maxAdverseSlippageBps: 99 }),
    )

    const atOrderCap = makeState({ orders: [openOrder('broker-1'), openOrder('broker-2')] })
    expectBlocked(Reason.UnresolvedOrdersExceeded, makeIntent(), atOrderCap, makePolicy({ maxOpenOrders: 2 }))
  })

  test('does not require buying power for a position-reducing sell', () => {
    const result = evaluateSuccess(
      makeIntent({ side: OrderSide.Sell }),
      makeState({ account: { ...baseState().account, buyingPowerMicros: '0' } }),
      makePolicy(),
    )
    expect(result.decision.outcome).toBe(RiskOutcome.Approved)
    expect(result.metrics.postTradeSymbolExposureMicros).toBe('0')
  })

  test('blocks a sell that would open a short position', () => {
    const intent = makeIntent({ side: OrderSide.Sell, quantityAtoms: '2000000000', notionalLimitMicros: '200000000' })
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
    const intent = makeIntent({ limitPriceMicros: '200000000', notionalLimitMicros: '200000000' })
    const policy = makePolicy({
      maxOrderNotionalMicros: '200000000',
      maxSymbolExposureMicros: '400000000',
      maxGrossExposureMicros: '500000000',
      maxNetExposureMicros: '500000000',
      maxDailyTradedNotionalMicros: '300000000',
    })
    const result = evaluateSuccess(intent, state, policy)

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
        quantityAtoms: '-1000000000',
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
    const intent = makeIntent({ side: OrderSide.Sell, limitPriceMicros: '198000000', notionalLimitMicros: '198000000' })
    const policy = makePolicy({
      maxOrderNotionalMicros: '198000000',
      maxSymbolExposureMicros: '400000000',
      maxGrossExposureMicros: '500000000',
      maxNetExposureMicros: '300000000',
      maxDailyTradedNotionalMicros: '298000000',
    })
    const result = evaluateSuccess(intent, state, policy)

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
          quantityAtoms: '2000',
          averageEntryPriceMicros: '50000000',
          marketPriceMicros: '50000000',
          marketValueMicros: '100',
          unrealizedPnlMicros: '0',
        },
        {
          ...baseState().positions[1],
          quantityAtoms: '-1000',
          averageEntryPriceMicros: '49100000',
          marketPriceMicros: '49100000',
          marketValueMicros: '-49',
          unrealizedPnlMicros: '0',
        },
      ],
      referencePriceMicros: '49100000',
      expectedExecutionPriceMicros: '49100000',
    })
    const intent = makeIntent({
      side: OrderSide.Sell,
      quantityAtoms: '1000',
      limitPriceMicros: '49100000',
      notionalLimitMicros: '49',
    })
    const result = evaluateSuccess(intent, state, makePolicy())

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
    expect(
      evaluate({ intent: { ...makeIntent(), orderType: OrderType.Market }, state: makeState(), policy: makePolicy() }),
    ).toMatchObject({
      _tag: 'Failure',
      failure: { operation: 'decode-input', reason: 'intent' },
    })
    expectBlocked(
      Reason.TimeInForceNotAllowed,
      makeIntent(),
      makeState(),
      makePolicy({ allowedTimeInForce: [TimeInForce.ImmediateOrCancel] }),
    )
    expectBlocked(
      Reason.IntentNotPlanned,
      makeIntent({
        state: IntentState.Terminal,
        riskDecisionId: hash('7'),
        terminalOutcome: TerminalOutcome.Blocked,
      }),
    )
    expectBlocked(Reason.IntentTimeInvalid, makeIntent({ createdAt: '2026-07-21T19:30:00.001Z' }))
    expectBlocked(Reason.IntentTimeInvalid, makeIntent({ createdAt: '2026-07-21T19:29:29.999Z' }))
    expectBlocked(
      Reason.IntentStale,
      makeIntent({ createdAt: '2026-07-21T19:29:00.000Z' }),
      makeState(),
      makePolicy({ maxIntentAgeMs: 60_000 }),
    )
    expectBlocked(
      Reason.AuthorityNotGranted,
      makeReferenceIntent(),
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
    const baseline = evaluateSuccess(makeIntent(), makeState(), makePolicy())
    const changedIntent = evaluateSuccess(makeIntent({ clientOrderId: 'risk-test-order-2' }), makeState(), makePolicy())
    const changedPolicy = evaluateSuccess(
      makeIntent(),
      makeState(),
      makePolicy({ allowedSymbols: ['AMD', 'NVDA', 'WDC'] }),
    )
    const changedState = evaluateSuccess(
      makeIntent(),
      makeState({ marketDataHash: hash('9'), executionMarketDataHash: hash('9') }),
      makePolicy(),
    )
    const changedAccounting = evaluateSuccess(makeIntent(), makeState({ accountingHash: hash('b') }), makePolicy())

    expect(changedIntent.input.intentId).toBe(baseline.input.intentId)
    expect(changedIntent.input.inputHash).not.toBe(baseline.input.inputHash)
    expect(changedIntent.decision.decisionId).not.toBe(baseline.decision.decisionId)
    expect(changedPolicy.policyHash).not.toBe(baseline.policyHash)
    expect(changedPolicy.input.inputHash).not.toBe(baseline.input.inputHash)
    expect(changedState.input.inputHash).not.toBe(baseline.input.inputHash)
    expect(changedAccounting.input.inputHash).not.toBe(baseline.input.inputHash)

    const ttlCapped = evaluateSuccess(makeIntent(), makeState(), makePolicy({ decisionTtlMs: 1_000 }))
    const freshnessCapped = evaluateSuccess(
      makeIntent(),
      makeState(),
      makePolicy({ decisionTtlMs: 60_000, maxBrokerStateAgeMs: 30_001, maxMarketDataAgeMs: 30_001 }),
    )
    const cutoffCapped = evaluateSuccess(
      makeIntent(),
      makeState({
        executionSession: changeExecutionWindow(makeState().executionSession, {
          submissionCutoffAt: '2026-07-21T19:30:00.001Z',
        }),
      }),
      makePolicy({ decisionTtlMs: 60_000 }),
    )
    const intentCapped = evaluateSuccess(
      makeIntent(),
      makeState(),
      makePolicy({ decisionTtlMs: 60_000, maxIntentAgeMs: 15_001 }),
    )
    expect(ttlCapped.input.freshUntil).toBe('2026-07-21T19:30:01.000Z')
    expect(freshnessCapped.input.freshUntil).toBe('2026-07-21T19:30:00.001Z')
    expect(cutoffCapped.input.freshUntil).toBe('2026-07-21T19:30:00.001Z')
    expect(intentCapped.input.freshUntil).toBe('2026-07-21T19:30:00.001Z')
  })

  test('requires the exact authority generation for execution evaluation and hashes that binding', () => {
    const baselineState = makeState()
    const baseline = evaluateSuccess(makeIntent(), baselineState, makePolicy())
    const rotatedAuthority = { ...baselineState.authority, generationHash: hash('9') }
    const rotatedState = makeState({ authority: rotatedAuthority })
    const rotated = evaluateSuccess(makeIntent({ authorityGenerationHash: hash('9') }), rotatedState, makePolicy())

    expect(rotated.input.inputHash).not.toBe(baseline.input.inputHash)
    expect(rotated.gates.find((gate) => gate.name === 'reconciliation')?.passed).toBe(true)
    const failures = [
      evaluate({ intent: makeIntent(), state: rotatedState, policy: makePolicy() }),
      evaluate({ intent: makeReferenceIntent(), state: baselineState, policy: makePolicy() }),
      evaluate({
        intent: makeReferenceIntent(),
        state: makeState({
          authority: {
            ...baselineState.authority,
            effective: Authority.Observe,
            kill: KillState.Active,
            reason: 'operator kill',
          },
        }),
        policy: makePolicy(),
      }),
      evaluate({
        intent: makeIntent(),
        state: makeState({
          authority: {
            ...baselineState.authority,
            maximum: Authority.Observe,
            effective: Authority.Observe,
          },
        }),
        policy: makePolicy(),
      }),
    ] as const
    expect(failures.map((result) => (Result.isFailure(result) ? result.failure.reason : null))).toEqual([
      'authority-generation',
      'authority-contract',
      'authority-contract',
      'authority-maximum',
    ])
    for (const result of failures) {
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: 'RiskEvaluationFailure',
          operation: 'bind-authority',
        })
      }
    }
  })

  test('returns closed tagged failures for malformed exported inputs', () => {
    const cases = [
      ['intent', evaluate({ intent: {}, state: makeState(), policy: makePolicy() })],
      ['state', evaluate({ intent: makeIntent(), state: {}, policy: makePolicy() })],
      ['policy', evaluate({ intent: makeIntent(), state: makeState(), policy: {} })],
      [
        'positions',
        evaluate({ intent: makeIntent(), state: makeState(), policy: makePolicy(), proposedPositions: [{}] }),
      ],
    ] as const

    for (const [reason, result] of cases) {
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: 'RiskEvaluationFailure',
          operation: 'decode-input',
          reason,
        })
        expect(result.failure.cause).toBeDefined()
      }
    }
  })

  test('exposes exactly the correlated risk failure operation and reason table', () => {
    const failures = riskFailurePairs.map(
      (pair) => new RiskEvaluationFailure({ ...pair, message: 'failure-pair coverage', facts: {} }),
    )
    expect(riskFailurePairCoverage).toBe(true)
    expect(failures.map(({ operation, reason }) => ({ operation, reason }))).toEqual([...riskFailurePairs])
    expect(failures.every((failure) => failure._tag === 'RiskEvaluationFailure')).toBe(true)
  })

  test('rejects projected position books that diverge from the authoritative account snapshot context', () => {
    const state = makeState()
    const first = state.positions[0]
    const second = state.positions[1]
    if (first === undefined || second === undefined) throw new Error('risk fixture requires two positions')
    const cases: readonly State['positions'][] = [
      [second, first],
      [first, { ...second, symbol: first.symbol }],
      [{ ...first, accountId: 'another-account' }, second],
      [{ ...first, observedAt: '2026-07-21T19:29:29.999Z' }, second],
      [{ ...first, marketValueMicros: '0' }, second],
    ]

    for (const proposedPositions of cases) {
      const result = evaluate({ intent: makeIntent(), state, policy: makePolicy(), proposedPositions })
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: 'RiskEvaluationFailure',
          operation: 'decode-input',
          reason: 'positions',
        })
        expect(result.failure.facts['issues']).toBeArray()
      }
    }
  })

  test('fails before gates when malformed projected positions could undercount exact-state gross exposure', () => {
    const state = makeState()
    expect(state.reconciliation.status).toBe(ReconciliationStatus.Exact)
    expect(state.reconciliation.expectedHash).toBe(state.reconciliation.observedHash)
    const proposedPositions = state.positions.map((position) =>
      position.symbol === 'AMD' ? { ...position, marketValueMicros: '0' } : position,
    )
    const result = evaluate({
      intent: makeIntent(),
      state,
      policy: makePolicy({ maxGrossExposureMicros: '250000000' }),
      proposedPositions,
    })

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: 'RiskEvaluationFailure',
        operation: 'decode-input',
        reason: 'positions',
      })
      expect(result.failure.facts['issues']).toContainEqual({
        path: ['positions', 0, 'marketValueMicros'],
        issue: 'must have the quantity sign',
      })
    }
  })

  test('rejects a rehashed evaluation with a gate assigned another gate reason', () => {
    const valid = evaluateSuccess(makeIntent(), makeState(), makePolicy())
    const gates = valid.gates.map((gate) => ({ ...gate }))
    const firstReason = gates[0]?.reason
    const secondReason = gates[1]?.reason
    if (firstReason === undefined || secondReason === undefined) {
      throw new Error('risk fixture requires the first two authoritative gates')
    }
    gates[0] = { ...gates[0]!, reason: secondReason }
    gates[1] = { ...gates[1]!, reason: firstReason }

    const decoded = decodeEvaluationResult({ ...valid, gates })
    expect(Result.isFailure(decoded)).toBe(true)
    expect(gates[0]?.name).toBe(Gate.IntentState)
  })
})

test('caps entry approval at the pricing quote event deadline rather than snapshot observation time', () => {
  const state = makeState({
    marketDataObservedAt: '2026-07-21T19:29:59.000Z',
    entryQuote: { eventAt: '2026-07-21T19:29:55.500123456Z', maximumAgeMs: 10_000 },
  })
  const result = evaluateSuccess(makeIntent(), state, makePolicy())
  expect(result.decision.outcome).toBe(RiskOutcome.Approved)
  expect(result.decision.expiresAt).toBe('2026-07-21T19:30:05.500Z')
  expect(result.input.freshUntil).toBe(result.decision.expiresAt)
  const expired = evaluateSuccess(
    makeIntent(),
    makeState({ ...state, evaluatedAt: result.decision.expiresAt }),
    makePolicy(),
  )
  expect(expired.decision.outcome).toBe(RiskOutcome.Blocked)
  expect(expired.decision.reasonCodes).toContain(Reason.MarketDataStale)
})

test('rejects entry quotes from after the bound pricing observation and invalid age limits', () => {
  const state = makeState()
  expect(() => makeState({ entryQuote: { eventAt: '2026-07-21T19:29:30.000000001Z', maximumAgeMs: 10_000 } })).toThrow()
  expect(() => makeState({ entryQuote: { eventAt: state.marketDataObservedAt, maximumAgeMs: 0 } })).toThrow()
})

test.each([OrderType.Limit, OrderType.StopLimit])(
  'fractional %s protection retains the exact minimum sell proceeds',
  (orderType) => {
    const quantityAtoms = 41_753_408_340n
    const limitPriceMicros = 104_177_219n
    const stopPriceMicros = 104_281_500n
    const notionalFloor = (quantityAtoms * limitPriceMicros) / 1_000_000_000n
    const marketValue = (quantityAtoms * stopPriceMicros + 999_999_999n) / 1_000_000_000n
    const timeInForce =
      orderType === OrderType.StopLimit ? TimeInForce.GoodUntilCanceled : TimeInForce.ImmediateOrCancel
    const policy = makePolicy({
      schemaVersion: executionRiskPolicySchemaVersion,
      allowedSymbols: ['SOL/USD'],
      allowedOrderTypes: [orderType],
      allowedTimeInForce: [timeInForce],
    })
    const intent = makeIntent({
      symbol: 'SOL/USD',
      side: OrderSide.Sell,
      orderType,
      timeInForce,
      quantityAtoms: quantityAtoms.toString(),
      limitPriceMicros: limitPriceMicros.toString(),
      notionalLimitMicros: notionalFloor.toString(),
      policyHash: Result.getOrThrow(canonicalHashV1Result(policy)),
      ...(orderType === OrderType.StopLimit
        ? {
            protection: {
              _tag: 'StopLimit',
              stopPriceMicros: stopPriceMicros.toString(),
              entryDecisionHash: hash('8'),
            },
          }
        : {}),
    })
    const base = makeState()
    const position = base.positions[0]
    if (position === undefined) throw new Error('position fixture required')
    const equityMicros = (BigInt(base.account.cashMicros) + marketValue).toString()
    const state = makeState({
      account: { ...base.account, equityMicros },
      positions: [
        {
          ...position,
          symbol: 'SOL/USD',
          quantityAtoms: quantityAtoms.toString(),
          costBasisMicros: marketValue.toString(),
          averageEntryPriceMicros: stopPriceMicros.toString(),
          marketPriceMicros: stopPriceMicros.toString(),
          marketValueMicros: marketValue.toString(),
          unrealizedPnlMicros: '0',
        },
      ],
      marketDataSymbol: 'SOL/USD',
      referencePriceMicros: stopPriceMicros.toString(),
      expectedExecutionPriceMicros: limitPriceMicros.toString(),
      dayStartEquityMicros: equityMicros,
      peakEquityMicros: equityMicros,
      closeOnly: true,
      closeOnlyExpiresAt: '2026-07-21T19:35:00.000Z',
    })
    const result = evaluateSuccess(intent, state, policy)
    expect(notionalFloor).toBe(4_349_753_964n)
    expect(result.metrics.orderNotionalMicros).toBe('4349753965')
    expect(result.gates.find((gate) => gate.name === Gate.IntentNotional)?.passed).toBe(true)
    expect(result.decision.outcome).toBe(RiskOutcome.Approved)
  },
)

test('property: fractional LIMIT buys honor a spending ceiling and sells honor a proceeds floor', () => {
  checkProperty(
    'fractional-limit-notional',
    fc.property(
      fc.constantFrom('BTC/USD', 'ETH/USD', 'SOL/USD'),
      fc.constantFrom(OrderSide.Buy, OrderSide.Sell),
      fc.integer({ min: 1_000_000, max: 1_000_000_000_000 }),
      fc.integer({ min: 1_000_000, max: 100_000_000_000 }),
      fc.integer({ min: 0, max: 25 }),
      (symbol, side, quantity, price, slippage) => {
        const pricing = Result.getOrThrow(
          deriveExecutionIntentPricing({
            symbol,
            side,
            quantityAtoms: BigInt(quantity),
            referencePriceMicros: BigInt(price),
            limitSlippageBps: BigInt(slippage),
            orderType: OrderType.Limit,
            timeInForce: TimeInForce.ImmediateOrCancel,
          }),
        )
        const policy = makePolicy({
          schemaVersion: executionRiskPolicySchemaVersion,
          allowedSymbols: [symbol],
          allowedOrderTypes: [OrderType.Limit],
          allowedTimeInForce: [TimeInForce.ImmediateOrCancel],
        })
        const intent = makeIntent({
          orderType: OrderType.Limit,
          timeInForce: TimeInForce.ImmediateOrCancel,
          symbol,
          side,
          quantityAtoms: String(quantity),
          notionalLimitMicros: String(pricing.notionalLimitMicros),
          limitPriceMicros: String(pricing.expectedExecutionPriceMicros),
          policyHash: Result.getOrThrow(canonicalHashV1Result(policy)),
        })
        const state = makeState({
          marketDataSymbol: symbol,
          referencePriceMicros: String(price),
          expectedExecutionPriceMicros: String(pricing.expectedExecutionPriceMicros),
        })
        const result = evaluateSuccess(intent, state, policy)
        const gate = result.gates.find((gate) => gate.name === Gate.IntentNotional)
        expect(gate?.passed).toBe(true)
        const wrongPrice =
          side === OrderSide.Buy
            ? pricing.expectedExecutionPriceMicros + 1_000_000n
            : pricing.expectedExecutionPriceMicros > 1_000_000n
              ? pricing.expectedExecutionPriceMicros - 1_000_000n
              : 1n
        const rejected = evaluate({
          intent,
          state: makeState({ ...state, expectedExecutionPriceMicros: wrongPrice.toString() }),
          policy,
        })
        expect(rejected).toMatchObject(Result.fail({ operation: 'decode-input', reason: 'intent' }))
      },
    ),
  )
})
