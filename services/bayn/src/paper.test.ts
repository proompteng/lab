import { describe, expect, test } from 'bun:test'

import { Effect, Exit } from 'effect'

import {
  AccountStatus,
  Authority,
  Broker,
  IntentState,
  KillState,
  MutationOutcome,
  OrderSide,
  OrderStatus,
  OrderType,
  ReconciliationStatus,
  RiskOutcome,
  TerminalOutcome,
  TimeInForce,
  decodeAccountingReceipt,
  decodeAccountSnapshot,
  decodeAuthorityState,
  decodeBrokerError,
  decodeBrokerEvent,
  decodeFill,
  decodeIntent,
  decodeOrder,
  decodePosition,
  decodePaperAuthorityProofBinding,
  decodePaperAuthorityGeneration,
  decodeRateLimit,
  decodeReconciliation,
  decodeRiskDecision,
  decodeRiskInput,
  decodeValuation,
  isIntentTransitionAllowed,
  makePaperAuthorityGeneration,
} from './paper'

const instant = '2026-07-22T06:00:00.000Z'
const later = '2026-07-22T06:01:00.000Z'
const hash = (character: string): string => character.repeat(64)
const u64Max = '18446744073709551615'
const u128Max = '340282366920938463463374607431768211455'
const i128Min = '-170141183460469231731687303715884105728'
const i128Max = '170141183460469231731687303715884105727'

const expectFailure = async (effect: Effect.Effect<unknown, unknown>): Promise<void> => {
  expect(Exit.isFailure(await Effect.runPromiseExit(effect))).toBe(true)
}

const account = {
  schemaVersion: 'bayn.paper-account-snapshot.v1' as const,
  accountId: 'paper-account-1',
  status: AccountStatus.Active,
  currency: 'USD' as const,
  cashMicros: '1000000000000',
  equityMicros: '1000000000000',
  buyingPowerMicros: '2000000000000',
  observedAt: later,
}

const position = {
  schemaVersion: 'bayn.paper-position.v1' as const,
  accountId: account.accountId,
  symbol: 'NVDA',
  quantityMicros: '1000000',
  averageEntryPriceMicros: '100000000',
  marketPriceMicros: '125000000',
  marketValueMicros: '125000000',
  unrealizedPnlMicros: '25000000',
  observedAt: later,
}

const order = {
  schemaVersion: 'bayn.paper-order.v1' as const,
  accountId: account.accountId,
  brokerOrderId: 'broker-order-1',
  clientOrderId: 'client-order-1',
  intentId: hash('1'),
  symbol: 'NVDA',
  side: OrderSide.Buy,
  orderType: OrderType.Market,
  timeInForce: TimeInForce.Day,
  quantityMicros: '1000000',
  filledQuantityMicros: '500000',
  status: OrderStatus.PartiallyFilled,
  observedAt: later,
}

const fill = {
  schemaVersion: 'bayn.paper-fill.v1' as const,
  accountId: account.accountId,
  fillId: 'fill-1',
  brokerOrderId: order.brokerOrderId,
  clientOrderId: order.clientOrderId,
  intentId: order.intentId,
  symbol: order.symbol,
  side: order.side,
  quantityMicros: '500000',
  priceMicros: '125000000',
  feeMicros: '10000',
  occurredAt: instant,
}

const brokerError = {
  schemaVersion: 'bayn.paper-broker-error.v1' as const,
  requestId: 'request-1',
  code: 'TIMEOUT',
  message: 'request timed out after I/O began',
  retryable: false,
  mutationOutcome: MutationOutcome.Unknown,
  observedAt: later,
}

const rateLimit = {
  schemaVersion: 'bayn.paper-rate-limit.v1' as const,
  limit: '200',
  remaining: '199',
  resetsAt: later,
  observedAt: later,
}

const source = {
  schemaVersion: 'bayn.paper-broker-event.v1' as const,
  eventId: hash('2'),
  contentHash: hash('3'),
  broker: Broker.Alpaca,
  accountId: account.accountId,
  sourceEventId: 'source-event-1',
  sourceSequence: '1',
  occurredAt: instant,
  observedAt: later,
}

const intent = {
  schemaVersion: 'bayn.paper-intent.v3' as const,
  intentId: hash('4'),
  authorityGenerationHash: hash('8'),
  strategyName: 'risk-balanced-trend',
  cycleId: hash('5'),
  decisionHash: hash('6'),
  policyHash: hash('7'),
  accountId: account.accountId,
  clientOrderId: order.clientOrderId,
  symbol: order.symbol,
  side: OrderSide.Buy,
  orderType: OrderType.Market,
  timeInForce: TimeInForce.Day,
  quantityMicros: '1000000',
  notionalLimitMicros: '200000000',
  state: IntentState.Planned,
  createdAt: instant,
}

describe('paper contracts', () => {
  test('strictly decodes every broker payload and tagged event', async () => {
    const contracts: ReadonlyArray<{
      decode: (value: unknown) => Effect.Effect<unknown, unknown>
      value: Record<string, unknown>
    }> = [
      { decode: decodeAccountSnapshot, value: account },
      { decode: decodePosition, value: position },
      { decode: decodeOrder, value: order },
      { decode: decodeFill, value: fill },
      { decode: decodeBrokerError, value: brokerError },
      { decode: decodeRateLimit, value: rateLimit },
    ]

    for (const contract of contracts) {
      expect(await Effect.runPromise(contract.decode(contract.value))).toEqual(contract.value)
      await expectFailure(contract.decode({ ...contract.value, futureField: true }))
    }

    const events = [
      { _tag: 'Account' as const, ...source, account },
      { _tag: 'Position' as const, ...source, position },
      { _tag: 'Order' as const, ...source, order },
      { _tag: 'Fill' as const, ...source, sourceTimestamp: '2026-07-22T06:00:00.000000000Z', fill },
      { _tag: 'Error' as const, ...source, error: brokerError },
      { _tag: 'RateLimit' as const, ...source, rateLimit },
    ]
    for (const event of events) expect(await Effect.runPromise(decodeBrokerEvent(event))).toEqual(event)

    await expectFailure(decodeBrokerEvent({ ...events[0], observedAt: '2026-07-22T05:59:00.000Z' }))
    await expectFailure(decodeBrokerEvent({ ...events[1], position: { ...position, accountId: 'other-account' } }))
    await expectFailure(decodeBrokerEvent({ ...events[4], error: { ...brokerError, observedAt: instant } }))
    await expectFailure(decodeBrokerEvent({ ...events[2], futureField: true }))
  })

  test('enforces order and rate-limit invariants', async () => {
    await expectFailure(decodeOrder({ ...order, filledQuantityMicros: '1000001' }))
    await expectFailure(decodeOrder({ ...order, filledQuantityMicros: '0' }))
    await expectFailure(decodeOrder({ ...order, filledQuantityMicros: order.quantityMicros }))
    await expectFailure(decodeOrder({ ...order, status: OrderStatus.Filled, filledQuantityMicros: '0' }))
    expect(
      await Effect.runPromise(
        decodeOrder({ ...order, status: OrderStatus.Filled, filledQuantityMicros: order.quantityMicros }),
      ),
    ).toMatchObject({ status: OrderStatus.Filled })
    await expectFailure(decodeOrder({ ...order, status: OrderStatus.New }))
    expect(
      await Effect.runPromise(decodeOrder({ ...order, status: OrderStatus.New, filledQuantityMicros: '0' })),
    ).toMatchObject({ status: OrderStatus.New })
    await expectFailure(
      decodeOrder({ ...order, status: OrderStatus.Canceled, filledQuantityMicros: order.quantityMicros }),
    )
    await expectFailure(decodeOrder({ ...order, limitPriceMicros: '125000000' }))
    await expectFailure(decodeOrder({ ...order, orderType: OrderType.Limit }))
    expect(
      await Effect.runPromise(decodeOrder({ ...order, orderType: OrderType.Limit, limitPriceMicros: '125000000' })),
    ).toMatchObject({ orderType: OrderType.Limit })
    await expectFailure(decodeRateLimit({ ...rateLimit, remaining: '201' }))
  })

  test('accepts exact integer boundaries and rejects noncanonical or overflowing values', async () => {
    expect(
      await Effect.runPromise(
        decodeAccountSnapshot({ ...account, cashMicros: i128Min, equityMicros: i128Max, buyingPowerMicros: i128Max }),
      ),
    ).toMatchObject({ cashMicros: i128Min, buyingPowerMicros: i128Max })
    await expectFailure(decodeAccountSnapshot({ ...account, cashMicros: '-170141183460469231731687303715884105729' }))
    await expectFailure(decodeAccountSnapshot({ ...account, equityMicros: '170141183460469231731687303715884105728' }))
    await expectFailure(decodeAccountSnapshot({ ...account, cashMicros: '-0' }))
    await expectFailure(decodeAccountSnapshot({ ...account, cashMicros: '01' }))
    await expectFailure(decodeAccountSnapshot({ ...account, cashMicros: 1 }))

    expect(
      await Effect.runPromise(decodeBrokerEvent({ _tag: 'Account', ...source, sourceSequence: u64Max, account })),
    ).toMatchObject({ sourceSequence: u64Max })
    await expectFailure(
      decodeBrokerEvent({ _tag: 'Account', ...source, sourceSequence: '18446744073709551616', account }),
    )
  })

  test('binds risk evidence to every intent state', async () => {
    expect(await Effect.runPromise(decodeIntent(intent))).toEqual(intent)
    await expectFailure(decodeIntent({ ...intent, riskDecisionId: hash('5') }))
    await expectFailure(decodeIntent({ ...intent, quantityMicros: '01' }))
    await expectFailure(decodeIntent({ ...intent, terminalOutcome: TerminalOutcome.Filled }))

    const approved = { ...intent, state: IntentState.Approved, riskDecisionId: hash('5') }
    expect(await Effect.runPromise(decodeIntent(approved))).toEqual(approved)
    await expectFailure(decodeIntent({ ...approved, riskDecisionId: undefined }))

    const terminal = { ...approved, state: IntentState.Terminal, terminalOutcome: TerminalOutcome.Blocked }
    expect(await Effect.runPromise(decodeIntent(terminal))).toEqual(terminal)
    await expectFailure(decodeIntent({ ...terminal, terminalOutcome: undefined }))
  })

  test('defines the complete closed mutation transition graph', () => {
    const allowed = new Set([
      'PLANNED:APPROVED',
      'PLANNED:TERMINAL',
      'APPROVED:IO_STARTED',
      'APPROVED:TERMINAL',
      'IO_STARTED:ACKNOWLEDGED',
      'IO_STARTED:UNKNOWN',
      'IO_STARTED:TERMINAL',
      'ACKNOWLEDGED:TERMINAL',
      'UNKNOWN:RECOVERED',
      'RECOVERED:ACKNOWLEDGED',
      'RECOVERED:TERMINAL',
    ])

    const allowedTerminal = new Set([
      'PLANNED:BLOCKED',
      'APPROVED:BLOCKED',
      'APPROVED:CANCELED',
      'IO_STARTED:FILLED',
      'IO_STARTED:CANCELED',
      'IO_STARTED:EXPIRED',
      'IO_STARTED:REJECTED',
      'ACKNOWLEDGED:FILLED',
      'ACKNOWLEDGED:CANCELED',
      'ACKNOWLEDGED:EXPIRED',
      'ACKNOWLEDGED:REJECTED',
      'RECOVERED:FILLED',
      'RECOVERED:CANCELED',
      'RECOVERED:EXPIRED',
      'RECOVERED:REJECTED',
    ])

    for (const from of Object.values(IntentState)) {
      for (const to of Object.values(IntentState)) {
        if (to === IntentState.Terminal) {
          for (const outcome of Object.values(TerminalOutcome)) {
            expect(isIntentTransitionAllowed(from, to, outcome), `${from}:${outcome}`).toBe(
              allowedTerminal.has(`${from}:${outcome}`),
            )
          }
          continue
        }
        expect(isIntentTransitionAllowed(from, to), `${from}:${to}`).toBe(allowed.has(`${from}:${to}`))
        expect(isIntentTransitionAllowed(from, to, TerminalOutcome.Blocked), `${from}:${to}:unexpected outcome`).toBe(
          false,
        )
      }
    }
  })

  test('requires fresh risk inputs and immutable decisions with coherent reasons', async () => {
    const input = {
      schemaVersion: 'bayn.paper-risk-input.v1' as const,
      inputHash: hash('6'),
      intentId: intent.intentId,
      policyHash: hash('7'),
      accountSnapshotHash: hash('8'),
      positionsHash: hash('9'),
      ordersHash: hash('a'),
      marketDataHash: hash('b'),
      evaluatedAt: instant,
      freshUntil: later,
    }
    expect(await Effect.runPromise(decodeRiskInput(input))).toEqual(input)
    await expectFailure(decodeRiskInput({ ...input, freshUntil: instant }))
    await expectFailure(decodeRiskInput({ ...input, futureField: true }))

    const approved = {
      schemaVersion: 'bayn.paper-risk-decision.v1' as const,
      decisionId: hash('5'),
      inputHash: input.inputHash,
      intentId: intent.intentId,
      policyHash: input.policyHash,
      outcome: RiskOutcome.Approved,
      reasonCodes: [],
      decidedAt: instant,
      expiresAt: later,
    }
    expect(await Effect.runPromise(decodeRiskDecision(approved))).toEqual(approved)
    await expectFailure(decodeRiskDecision({ ...approved, reasonCodes: ['SHOULD_BE_EMPTY'] }))
    await expectFailure(decodeRiskDecision({ ...approved, expiresAt: instant }))
    expect(
      await Effect.runPromise(
        decodeRiskDecision({ ...approved, outcome: RiskOutcome.Blocked, reasonCodes: ['KILL_ACTIVE'] }),
      ),
    ).toMatchObject({ outcome: RiskOutcome.Blocked })
  })

  test('requires exact canonical TigerBeetle receipts and marked valuation', async () => {
    const receipt = {
      schemaVersion: 'bayn.paper-accounting-receipt.v1' as const,
      receiptId: hash('c'),
      intentId: intent.intentId,
      brokerEventId: source.eventId,
      tigerBeetleClusterId: u128Max,
      tigerBeetleLedger: 4_294_967_295,
      accountIds: ['1', '2'],
      transferIds: ['3', '4'],
      debitMicros: u128Max,
      creditMicros: u128Max,
      contentHash: hash('d'),
      recordedAt: instant,
    }
    expect(await Effect.runPromise(decodeAccountingReceipt(receipt))).toEqual(receipt)
    await expectFailure(decodeAccountingReceipt({ ...receipt, creditMicros: '1249999' }))
    await expectFailure(decodeAccountingReceipt({ ...receipt, tigerBeetleLedger: 4_294_967_296 }))
    await expectFailure(decodeAccountingReceipt({ ...receipt, accountIds: ['2', '1'] }))
    await expectFailure(decodeAccountingReceipt({ ...receipt, tigerBeetleClusterId: `${u128Max}0` }))

    const valuation = {
      schemaVersion: 'bayn.paper-valuation.v1' as const,
      valuationId: hash('e'),
      accountId: account.accountId,
      sourceHash: hash('f'),
      cashMicros: '1000000',
      longMarketValueMicros: '2500000',
      shortMarketValueMicros: '-500000',
      equityMicros: '3000000',
      asOf: instant,
    }
    expect(await Effect.runPromise(decodeValuation(valuation))).toEqual(valuation)
    await expectFailure(decodeValuation({ ...valuation, equityMicros: '3000001' }))
    await expectFailure(decodeValuation({ ...valuation, shortMarketValueMicros: '500000', equityMicros: '4000000' }))
  })

  test('requires reconciliation evidence and downward-only effective authority', async () => {
    const exact = {
      schemaVersion: 'bayn.paper-reconciliation.v1' as const,
      reconciliationId: hash('1'),
      accountId: account.accountId,
      expectedHash: hash('2'),
      observedHash: hash('2'),
      contentHash: hash('3'),
      status: ReconciliationStatus.Exact,
      discrepancies: [],
      reconciledAt: instant,
    }
    expect(await Effect.runPromise(decodeReconciliation(exact))).toEqual(exact)
    await expectFailure(decodeReconciliation({ ...exact, observedHash: hash('4') }))
    await expectFailure(decodeReconciliation({ ...exact, status: ReconciliationStatus.Discrepancy, discrepancies: [] }))

    const observe = {
      schemaVersion: 'bayn.paper-authority.v1' as const,
      generationHash: hash('5'),
      maximum: Authority.Observe,
      effective: Authority.Observe,
      kill: KillState.Clear,
      version: 1,
      updatedAt: instant,
    }
    expect(await Effect.runPromise(decodeAuthorityState(observe))).toEqual(observe)
    await expectFailure(decodeAuthorityState({ ...observe, effective: Authority.Paper }))
    await expectFailure(
      decodeAuthorityState({
        ...observe,
        maximum: Authority.Paper,
        effective: Authority.Paper,
        kill: KillState.Active,
        reason: 'operator kill',
      }),
    )
    expect(
      await Effect.runPromise(
        decodeAuthorityState({ ...observe, maximum: Authority.Paper, kill: KillState.Active, reason: 'operator kill' }),
      ),
    ).toMatchObject({ effective: Authority.Observe, kill: KillState.Active })
  })

  test('binds a PAPER authority generation to exact qualification, runtime, account, policy, and proof evidence', async () => {
    const proof = {
      schemaVersion: 'bayn.paper-authority-proof-binding.v1' as const,
      riskPolicyHash: hash('c'),
      proofPlanHash: hash('d'),
    }
    const material = {
      schemaVersion: 'bayn.paper-authority-generation.v1' as const,
      maximum: Authority.Paper as const,
      previousGenerationHash: hash('0'),
      qualificationRunId: hash('1'),
      qualificationLockId: hash('2'),
      qualificationResultHash: hash('3'),
      protocolHash: hash('4'),
      qualificationExecutionPolicyHash: hash('5'),
      qualificationSourceRevision: '6'.repeat(40),
      qualificationImageRepository: 'registry.example.test/lab/bayn-qualification',
      qualificationImageDigest: `sha256:${hash('7')}` as const,
      activationSourceRevision: '8'.repeat(40),
      activationImageRepository: 'registry.example.test/lab/bayn-activation',
      activationImageDigest: `sha256:${hash('9')}` as const,
      strategyName: 'risk-balanced-trend' as const,
      strategyBehaviorHash: hash('a'),
      strategyParameterHash: hash('b'),
      strategyParameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v3' as const,
      accountId: 'paper-account-1',
      riskPolicyHash: proof.riskPolicyHash,
      proofPlanHash: proof.proofPlanHash,
      reconciliationId: hash('e'),
      reconciliationContentHash: hash('f'),
    }
    const generation = makePaperAuthorityGeneration(material)

    expect(await Effect.runPromise(decodePaperAuthorityProofBinding(proof))).toEqual(proof)
    await expectFailure(
      decodePaperAuthorityProofBinding({
        ...proof,
        previousGenerationHash: material.previousGenerationHash,
      }),
    )
    await expectFailure(
      decodePaperAuthorityProofBinding({
        ...proof,
        reconciliationId: material.reconciliationId,
      }),
    )
    expect(await Effect.runPromise(decodePaperAuthorityGeneration(generation))).toEqual(generation)
    expect(generation.generationHash).toMatch(/^[0-9a-f]{64}$/)
    expect(makePaperAuthorityGeneration(structuredClone(material))).toEqual(generation)
    expect(
      makePaperAuthorityGeneration({
        ...material,
        proofPlanHash: hash('0'),
      }).generationHash,
    ).not.toBe(generation.generationHash)
    expect(
      makePaperAuthorityGeneration({
        ...material,
        activationSourceRevision: '2'.repeat(40),
      }).generationHash,
    ).not.toBe(generation.generationHash)
    await expectFailure(
      decodePaperAuthorityGeneration({
        ...generation,
        generationHash: hash('1'),
      }),
    )
    expect(() =>
      makePaperAuthorityGeneration({
        ...material,
        strategyParameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v2' as never,
      }),
    ).toThrow()
  })
})
