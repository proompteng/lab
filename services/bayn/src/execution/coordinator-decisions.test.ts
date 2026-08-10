import { describe, expect, test } from 'bun:test'

import { Option, Result } from 'effect'

import {
  MutationOperation,
  cancelRequestHash,
  orderRequestBody,
  type MutationEvidence,
} from '../broker/alpaca-mutations'
import {
  AssetClass,
  OrderClass,
  OrderSide as BrokerSide,
  OrderStatus,
  OrderType as BrokerOrderType,
  TimeInForce as BrokerTimeInForce,
  type Order,
} from '../broker/alpaca'
import { canonicalHashV1 } from '../hash'
import {
  IntentState,
  OrderSide,
  OrderType,
  RiskOutcome,
  TerminalOutcome,
  TimeInForce,
  type Intent,
  type RiskDecision,
} from '../paper'
import {
  decideRecoverySuccess,
  decideSubmitSuccess,
  encodeOrder,
  ensureRecoveryDelay,
  makeDryRunSubmit,
  nextInstant,
  recoveryObservationRequiresPersistence,
  selectRecovery,
  validateActiveSubmitRiskDecision,
  validateStartedSubmitRiskDecision,
  validateRecovery,
  type ExecutionDecisionFailure,
} from './coordinator-decisions'

const encodedRequest = (value: Intent) => Result.getOrThrow(orderRequestBody(value))
import type { StoredIntent } from './intents'
import { MutationEventType, mutationIdResult, type MutationEvent } from './mutations'

const intentId = 'a'.repeat(64)
const accountId = 'e6fe16f3-64a4-4921-8928-cadf02f92f98'
const brokerOrderId = '61e69015-8549-4bfd-b9c3-01e75843f47d'
const decisionId = 'b'.repeat(64)

const intent: Intent = {
  schemaVersion: 'bayn.paper-intent.v3',
  intentId,
  authorityGenerationHash: 'f'.repeat(64),
  riskDecisionId: decisionId,
  strategyName: 'risk-balanced-trend',
  cycleId: 'c'.repeat(64),
  decisionHash: 'd'.repeat(64),
  policyHash: 'e'.repeat(64),
  accountId,
  clientOrderId: `b1_${'A'.repeat(43)}`,
  symbol: 'AMD',
  side: OrderSide.Buy,
  orderType: OrderType.Market,
  timeInForce: TimeInForce.Day,
  quantityMicros: '1250000',
  notionalLimitMicros: '200000000',
  state: IntentState.Approved,
  createdAt: '2026-07-25T00:00:00.000Z',
}

const riskDecision: RiskDecision = {
  schemaVersion: 'bayn.paper-risk-decision.v1',
  decisionId,
  inputHash: '1'.repeat(64),
  intentId,
  policyHash: intent.policyHash,
  outcome: RiskOutcome.Approved,
  reasonCodes: [],
  decidedAt: '2026-07-25T00:00:00.000Z',
  expiresAt: '2026-07-25T00:05:00.000Z',
}

const stored = (state: IntentState = IntentState.Approved): StoredIntent => ({
  intent: { ...intent, state },
  decision: riskDecision,
  stateVersion: 1,
  updatedAt: intent.createdAt,
})

const evidence: MutationEvidence = {
  requestId: 'request-1',
  status: 200,
  contentHash: '2'.repeat(64),
  observedAt: '2026-07-25T00:01:00.000Z',
}

const order = (overrides: Partial<Order> = {}): Order => ({
  accountId,
  brokerOrderId,
  clientOrderId: intent.clientOrderId,
  createdAt: evidence.observedAt,
  updatedAt: evidence.observedAt,
  submittedAt: evidence.observedAt,
  assetId: 'b0b6dd9d-8b9b-48a9-ba46-b9d54906e415',
  symbol: intent.symbol,
  assetClass: AssetClass.UsEquity,
  quantityMicros: intent.quantityMicros,
  filledQuantityMicros: '0',
  orderClass: OrderClass.Simple,
  orderType: BrokerOrderType.Limit,
  limitPriceMicros: '160000000',
  side: BrokerSide.Buy,
  timeInForce: BrokerTimeInForce.Day,
  status: OrderStatus.Accepted,
  extendedHours: false,
  observedAt: evidence.observedAt,
  ...overrides,
})

const mutation = (
  operation: MutationOperation,
  eventType: MutationEventType,
  stateIntent: Intent = intent,
): MutationEvent => {
  const requestHash =
    operation === MutationOperation.Submit
      ? canonicalHashV1(encodedRequest(stateIntent))
      : cancelRequestHash(brokerOrderId)
  return {
    schemaVersion: 'bayn.paper-mutation-event.v1',
    eventId: '3'.repeat(64),
    mutationId: Result.getOrThrow(mutationIdResult(intentId, operation)),
    intentId,
    sequence: 1,
    operation,
    eventType,
    requestHash,
    consistencyDelayMs: 1_000,
    brokerOrderId,
    occurredAt: '2026-07-25T00:01:00.000Z',
  }
}

describe('execution coordinator decisions', () => {
  test('builds the dry-run request only from a currently approved durable decision', () => {
    const active = makeDryRunSubmit(stored(), Date.parse('2026-07-25T00:04:59.999Z'))
    const expired = makeDryRunSubmit(stored(), Date.parse(riskDecision.expiresAt))

    expect(Result.getOrThrow(active)).toEqual({
      schemaVersion: 'bayn.paper-submit-dry-run.v1',
      intentId,
      clientOrderId: intent.clientOrderId,
      requestHash: canonicalHashV1(encodedRequest(intent)),
      request: encodedRequest(intent),
    })
    expect(Option.getOrUndefined(Result.getFailure(expired))).toMatchObject({
      _tag: 'ExpiredRiskDecision',
      expiresAt: riskDecision.expiresAt,
    })
  })

  test('rechecks the started submit decision at the final broker boundary', () => {
    const started = stored(IntentState.IoStarted)
    const active = validateStartedSubmitRiskDecision(started, Date.parse('2026-07-25T00:04:59.999Z'))
    const expired = validateStartedSubmitRiskDecision(started, Date.parse(riskDecision.expiresAt))

    expect(Result.getOrThrow(active)).toBe(started)
    expect(Option.getOrUndefined(Result.getFailure(expired))).toMatchObject({
      _tag: 'ExpiredRiskDecision',
      operationLabel: 'final submission',
      expiresAt: riskDecision.expiresAt,
    })
  })

  test('classifies exact and mismatched broker submissions without performing effects', () => {
    const encoded = Result.getOrThrow(encodeOrder(MutationOperation.Submit, intent))
    const exact = decideSubmitSuccess(intent, encoded, {
      requestHash: encoded.requestHash,
      order: order({ status: OrderStatus.Filled, filledQuantityMicros: intent.quantityMicros }),
      evidence,
    })
    const mismatched = decideSubmitSuccess(intent, encoded, {
      requestHash: encoded.requestHash,
      order: order({ accountId: 'd4aa6c51-2f30-4f1c-8dbc-462067dd569c' }),
      evidence,
    })

    expect(exact).toEqual({
      _tag: 'SubmitAccepted',
      brokerOrderId,
      evidence,
      terminalOutcome: TerminalOutcome.Filled,
    })
    expect(mismatched).toEqual({
      _tag: 'SubmitUnknown',
      brokerOrderId,
      evidence,
    })
  })

  test('keeps recovery selection, cancellation ordering, and delay boundaries pure', () => {
    const unknownIntent = { ...intent, state: IntentState.Unknown }
    const submit = mutation(MutationOperation.Submit, MutationEventType.SubmitUnknown, unknownIntent)
    const cancel = mutation(MutationOperation.Cancel, MutationEventType.CancelStarted, unknownIntent)

    expect(Result.getOrThrow(selectRecovery(MutationOperation.Submit, unknownIntent, submit))).toEqual({
      _tag: 'RecoveryRequired',
      event: submit,
    })
    expect(Option.getOrUndefined(Result.getFailure(validateRecovery(unknownIntent, submit, cancel)))).toEqual({
      _tag: 'SubmitRecoveryBlockedByCancellation',
    })
    expect(
      Option.getOrUndefined(
        Result.getFailure(ensureRecoveryDelay(MutationOperation.Submit, submit, Date.parse(submit.occurredAt) + 999)),
      ),
    ).toEqual({
      _tag: 'RecoveryTooEarly',
      operation: MutationOperation.Submit,
      eligibleAt: '2026-07-25T00:01:01.000Z',
    })
    expect(
      Result.getOrThrow(ensureRecoveryDelay(MutationOperation.Submit, submit, Date.parse(submit.occurredAt) + 1_000)),
    ).toEqual(submit)
  })

  test('does not append another mutation event for the same known open recovery', () => {
    const current = {
      ...mutation(MutationOperation.Submit, MutationEventType.RecoveryFound),
      sequence: 3,
      responseStatus: evidence.status,
      responseContentHash: evidence.contentHash,
    }
    expect(
      recoveryObservationRequiresPersistence(current, {
        _tag: 'RecoveryFound',
        brokerOrderId,
        evidence,
      }),
    ).toBe(false)
    expect(
      recoveryObservationRequiresPersistence(current, {
        _tag: 'RecoveryFound',
        brokerOrderId,
        evidence: { ...evidence, contentHash: '4'.repeat(64) },
      }),
    ).toBe(true)
    expect(
      recoveryObservationRequiresPersistence(current, {
        _tag: 'RecoveryFound',
        brokerOrderId,
        evidence,
        terminalOutcome: TerminalOutcome.Filled,
      }),
    ).toBe(true)
    expect(
      recoveryObservationRequiresPersistence(current, {
        _tag: 'RecoveryUnknown',
        evidence,
      }),
    ).toBe(true)
  })

  test('returns malformed and overflowing coordinator instants through the closed failure algebra', () => {
    const expectInvalidInstant = <A>(
      result: Result.Result<A, ExecutionDecisionFailure>,
      expected: {
        readonly operation: MutationOperation
        readonly field: Extract<ExecutionDecisionFailure, { readonly _tag: 'InvalidInstant' }>['field']
        readonly value: string | number
      },
    ) => {
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({ _tag: 'InvalidInstant', ...expected })
      }
    }

    expect(
      Result.getOrThrow(nextInstant(MutationOperation.Submit, '2026-07-25T00:00:00.000Z', '2026-07-25T00:00:00.000Z')),
    ).toBe('2026-07-25T00:00:00.001Z')

    expectInvalidInstant(nextInstant(MutationOperation.Submit, 'not-an-instant', '2026-07-25T00:00:00.000Z'), {
      operation: MutationOperation.Submit,
      field: 'stored-updated-at',
      value: 'not-an-instant',
    })
    expectInvalidInstant(nextInstant(MutationOperation.Cancel, '2026-07-25T00:00:00.000Z', 'not-an-instant'), {
      operation: MutationOperation.Cancel,
      field: 'occurred-at',
      value: 'not-an-instant',
    })
    expectInvalidInstant(
      nextInstant(MutationOperation.Submit, '+275760-09-13T00:00:00.000Z', '2026-07-25T00:00:00.000Z'),
      { operation: MutationOperation.Submit, field: 'stored-updated-at', value: 8_640_000_000_000_001 },
    )
    expectInvalidInstant(validateActiveSubmitRiskDecision(stored(), Number.NaN), {
      operation: MutationOperation.Submit,
      field: 'current-time',
      value: Number.NaN,
    })
    expectInvalidInstant(validateActiveSubmitRiskDecision(stored(), 0.5), {
      operation: MutationOperation.Submit,
      field: 'current-time',
      value: 0.5,
    })
    expectInvalidInstant(validateActiveSubmitRiskDecision(stored(), Number.MAX_VALUE), {
      operation: MutationOperation.Submit,
      field: 'current-time',
      value: Number.MAX_VALUE,
    })
    expectInvalidInstant(validateActiveSubmitRiskDecision(stored(), 253_402_300_800_000), {
      operation: MutationOperation.Submit,
      field: 'current-time',
      value: 253_402_300_800_000,
    })
    expectInvalidInstant(
      ensureRecoveryDelay(
        MutationOperation.Submit,
        mutation(MutationOperation.Submit, MutationEventType.SubmitUnknown),
        Number.NaN,
      ),
      { operation: MutationOperation.Submit, field: 'current-time', value: Number.NaN },
    )
    expectInvalidInstant(
      ensureRecoveryDelay(
        MutationOperation.Submit,
        mutation(MutationOperation.Submit, MutationEventType.SubmitUnknown),
        0.5,
      ),
      { operation: MutationOperation.Submit, field: 'current-time', value: 0.5 },
    )
    expectInvalidInstant(
      ensureRecoveryDelay(
        MutationOperation.Submit,
        mutation(MutationOperation.Submit, MutationEventType.SubmitUnknown),
        Number.MAX_VALUE,
      ),
      { operation: MutationOperation.Submit, field: 'current-time', value: Number.MAX_VALUE },
    )
    expectInvalidInstant(
      ensureRecoveryDelay(
        MutationOperation.Submit,
        mutation(MutationOperation.Submit, MutationEventType.SubmitUnknown),
        253_402_300_800_000,
      ),
      { operation: MutationOperation.Submit, field: 'current-time', value: 253_402_300_800_000 },
    )
    expectInvalidInstant(
      ensureRecoveryDelay(
        MutationOperation.Cancel,
        {
          ...mutation(MutationOperation.Cancel, MutationEventType.CancelUnknown),
          occurredAt: 'not-an-instant',
        } as MutationEvent,
        Date.parse('2026-07-25T00:00:00.000Z'),
      ),
      { operation: MutationOperation.Cancel, field: 'occurred-at', value: 'not-an-instant' },
    )
  })

  test('neutralizes the exact zero-fill canceled broker order but not a different order', () => {
    const acknowledged = { ...intent, state: IntentState.Acknowledged }
    const cancel = mutation(MutationOperation.Cancel, MutationEventType.CancelUnknown, acknowledged)
    const canceled = order({
      status: OrderStatus.Canceled,
      filledQuantityMicros: '0',
      accountId: 'd4aa6c51-2f30-4f1c-8dbc-462067dd569c',
    })

    expect(
      decideRecoverySuccess(acknowledged, MutationOperation.Cancel, cancel, {
        value: canceled,
        evidence,
      }),
    ).toEqual({
      _tag: 'RecoveryFound',
      brokerOrderId,
      evidence,
      terminalOutcome: TerminalOutcome.Canceled,
    })
    expect(
      decideRecoverySuccess(acknowledged, MutationOperation.Cancel, cancel, {
        value: { ...canceled, brokerOrderId: '9bcf0f36-19d5-488c-97ac-ad16ce9ca97a' },
        evidence,
      }),
    ).toEqual({
      _tag: 'RecoveryUnknown',
      evidence,
    })
  })
})
