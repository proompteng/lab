import { describe, expect, test } from 'bun:test'

import { Cause, Clock, Duration, Effect, Exit, Fiber, Option, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { utcInstantFromEpochMillis } from '../time'

import { provideTestLayer } from '../effect-test-support'
import {
  BrokerMutation,
  BrokerMutationError,
  MutationFailure,
  MutationOperation,
  cancelRequestHash,
  orderRequestBody,
  type BrokerMutationShape,
  type MutationEvidence,
  type PartialMutationEvidence,
} from '../broker/alpaca-mutations'
import {
  AssetClass,
  BrokerRead,
  BrokerReadError,
  BrokerReadErrorKind,
  OrderClass,
  OrderSide as BrokerSide,
  OrderStatus,
  OrderType as BrokerOrderType,
  TimeInForce as BrokerTimeInForce,
  type BrokerReadShape,
  type Order,
} from '../broker/alpaca'
import { canonicalHashV1 } from '../hash'
import {
  Authority,
  IntentState,
  KillState,
  MutationOutcome,
  OrderSide,
  OrderType,
  RiskOutcome,
  TerminalOutcome,
  TimeInForce,
  type Intent,
  type RiskDecision,
} from './contracts'
import { cancel, dryRunSubmit, ExecutionError, ExecutionFailure, recover, submit } from './coordinator'
import { IntentStore, type IntentStoreService, type StoredIntent } from './intents'

const encodedRequest = (value: Intent) => Result.getOrThrow(orderRequestBody(value))
import {
  decideFinalSubmitAuthorization,
  decideMutationAuthority,
  decideMutationOutcome,
  decideMutationStart,
  decideMutationStartReplay,
  MutationEventType,
  MutationStore,
  MutationStoreError,
  mutationIdResult,
  type MutationAuthoritySnapshot,
  type MutationEvent,
  type MutationIntentTransition,
  type MutationIntentSnapshot,
  type MutationOutcomeDefinition,
  type MutationOutcomeInput,
  type MutationReplayIntentSnapshot,
  type MutationStartInput,
  type MutationStoreShape,
} from './mutations'
import { WriterFence, WriterFenceError } from './writer-fence'

const intentId = 'a'.repeat(64)
const orderId = '61e69015-8549-4bfd-b9c3-01e75843f47d'
const accountId = 'e6fe16f3-64a4-4921-8928-cadf02f92f98'
const initialTime = '1969-12-31T23:59:59.000Z'

const intent: Intent = {
  schemaVersion: 'bayn.paper-intent.v3',
  intentId,
  authorityGenerationHash: 'f'.repeat(64),
  riskDecisionId: 'b'.repeat(64),
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
  createdAt: initialTime,
}

const riskDecision: RiskDecision = {
  schemaVersion: 'bayn.paper-risk-decision.v1',
  decisionId: 'b'.repeat(64),
  inputHash: 'f'.repeat(64),
  intentId,
  policyHash: intent.policyHash,
  outcome: RiskOutcome.Approved,
  reasonCodes: [],
  decidedAt: initialTime,
  expiresAt: '1970-01-01T00:10:00.000Z',
}

const brokerOrder = (status = OrderStatus.Accepted, observedAt = '1970-01-01T00:00:01.000Z'): Order => ({
  accountId,
  brokerOrderId: orderId,
  clientOrderId: intent.clientOrderId,
  createdAt: observedAt,
  updatedAt: observedAt,
  submittedAt: observedAt,
  assetId: 'b0b6dd9d-8b9b-48a9-ba46-b9d54906e415',
  symbol: intent.symbol,
  assetClass: AssetClass.UsEquity,
  notionalMicros: intent.notionalLimitMicros,
  filledQuantityMicros: status === OrderStatus.Filled ? intent.quantityMicros : '0',
  orderClass: OrderClass.Simple,
  orderType: BrokerOrderType.Market,
  side: BrokerSide.Buy,
  timeInForce: BrokerTimeInForce.Day,
  status,
  extendedHours: false,
  observedAt,
})

const evidence = (status: number, observedAt: string): MutationEvidence => ({
  requestId: `request-${status}`,
  status,
  contentHash: canonicalHashV1({ status, observedAt }),
  observedAt,
})

const resultSuccess = <A, E>(result: Result.Result<A, E>): A => {
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

const resultFailure = <A>(result: Result.Result<A, MutationStoreError>): MutationStoreError => {
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isSuccess(result)) throw new Error('expected a mutation decision failure')
  return result.failure
}

const decisionRequestHash = '1'.repeat(64)
const decisionStartedAt = '1970-01-01T00:00:01.000Z'
const decisionOutcomeAt = '1970-01-01T00:00:02.000Z'

const decisionStartInput = (operation: MutationOperation, brokerOrderId?: string): MutationStartInput => ({
  intentId,
  requestHash: decisionRequestHash,
  consistencyDelayMs: 1_000,
  occurredAt: decisionStartedAt,
  ...(operation === MutationOperation.Cancel && brokerOrderId !== undefined ? { brokerOrderId } : {}),
})

const decisionAuthority: MutationAuthoritySnapshot = {
  maximum: Authority.Paper,
  effective: Authority.Paper,
  killState: KillState.Clear,
  generationHash: intent.authorityGenerationHash,
  generationMaximum: Authority.Paper,
  generationAccountId: accountId,
}

const decisionIntent = (state: IntentState = IntentState.Approved): MutationIntentSnapshot => ({
  accountId,
  authorityGenerationHash: intent.authorityGenerationHash,
  policyHash: intent.policyHash,
  state,
  side: intent.side,
  strategyName: intent.strategyName,
  updatedAt: initialTime,
  generationAccountId: accountId,
  generationMaximum: Authority.Paper,
  generationRiskPolicyHash: intent.policyHash,
  generationStrategyName: intent.strategyName,
})

const decisionEvent = (
  operation: MutationOperation,
  eventType: MutationEventType,
  overrides: Partial<MutationEvent> = {},
): MutationEvent => ({
  schemaVersion: 'bayn.paper-mutation-event.v1',
  eventId: canonicalHashV1({ operation, eventType, overrides }),
  mutationId: resultSuccess(mutationIdResult(intentId, operation)),
  intentId,
  sequence: 1,
  operation,
  eventType,
  requestHash: decisionRequestHash,
  consistencyDelayMs: 1_000,
  occurredAt: decisionStartedAt,
  ...overrides,
})

const decisionOutcomeInput = (overrides: Partial<MutationOutcomeInput> = {}): MutationOutcomeInput => ({
  intentId,
  requestHash: decisionRequestHash,
  occurredAt: decisionOutcomeAt,
  ...overrides,
})

const decisionReplayIntent = (
  state: IntentState,
  terminalOutcome: TerminalOutcome | null = null,
): MutationReplayIntentSnapshot => ({ state, terminalOutcome })

describe('MutationStore decision algebra', () => {
  test('returns a closed canonicalization failure for a malformed mutation identity', () => {
    const identity = mutationIdResult('\ud800', MutationOperation.Submit)

    expect(Result.isFailure(identity)).toBe(true)
    if (Result.isSuccess(identity)) throw new Error('expected malformed mutation identity to fail')
    expect(identity.failure).toMatchObject({
      _tag: 'MutationCanonicalizationFailure',
      fact: {
        _tag: 'MutationIdentity',
        intentId: '\ud800',
        operation: MutationOperation.Submit,
      },
      cause: {
        _tag: 'CanonicalJsonFailure',
        path: '$.intentId',
        reason: 'invalid-unicode-surrogate',
        actualType: 'string',
      },
    })
  })

  test('makes every authority outcome explicit', () => {
    const submitBinding = resultSuccess(decideMutationAuthority(MutationOperation.Submit, decisionAuthority))
    expect(submitBinding).toEqual({
      accountId,
      generationHash: intent.authorityGenerationHash,
    })

    expect(
      resultSuccess(
        decideMutationAuthority(MutationOperation.Cancel, {
          ...decisionAuthority,
          effective: Authority.Observe,
          killState: KillState.Active,
        }),
      ),
    ).toEqual(submitBinding)

    const closeBinding = resultSuccess(
      decideMutationAuthority(
        MutationOperation.Submit,
        { ...decisionAuthority, effective: Authority.Observe, killState: KillState.Active },
        true,
      ),
    )
    expect(closeBinding).toEqual(submitBinding)
    expect(
      resultFailure(
        decideMutationAuthority(MutationOperation.Submit, {
          ...decisionAuthority,
          effective: Authority.Observe,
          killState: KillState.Active,
        }),
      ),
    ).toMatchObject({ failure: 'authority' })

    const failures: readonly [MutationOperation, MutationAuthoritySnapshot | undefined, string][] = [
      [MutationOperation.Submit, undefined, 'paper authority is not initialized'],
      [
        MutationOperation.Submit,
        { ...decisionAuthority, maximum: Authority.Observe },
        'GitOps maximum authority is not PAPER',
      ],
      [
        MutationOperation.Submit,
        { ...decisionAuthority, effective: Authority.Observe },
        'effective authority is not PAPER and clear',
      ],
      [
        MutationOperation.Submit,
        { ...decisionAuthority, killState: KillState.Active },
        'effective authority is not PAPER and clear',
      ],
      [
        MutationOperation.Cancel,
        { ...decisionAuthority, effective: Authority.Observe },
        'cancellation requires PAPER authority or an active kill',
      ],
      [
        MutationOperation.Submit,
        { ...decisionAuthority, generationMaximum: Authority.Observe },
        'active PAPER authority lacks its immutable account binding',
      ],
      [
        MutationOperation.Submit,
        { ...decisionAuthority, generationAccountId: null },
        'active PAPER authority lacks its immutable account binding',
      ],
    ]
    for (const [operation, authority, message] of failures) {
      expect(resultFailure(decideMutationAuthority(operation, authority))).toMatchObject({
        _tag: 'MutationStoreError',
        failure: 'authority',
        message,
      })
    }
  })

  test('rechecks active authority and immutable IO-started intent bindings before final submit', () => {
    const binding = resultSuccess(decideMutationAuthority(MutationOperation.Submit, decisionAuthority))

    expect(
      resultSuccess(
        decideFinalSubmitAuthorization({ authority: binding, intent: decisionIntent(IntentState.IoStarted) }),
      ),
    ).toBeUndefined()
    for (const snapshot of [
      undefined,
      decisionIntent(IntentState.Approved),
      { ...decisionIntent(IntentState.IoStarted), authorityGenerationHash: '9'.repeat(64) },
      { ...decisionIntent(IntentState.IoStarted), generationAccountId: 'another-account' },
    ]) {
      expect(resultFailure(decideFinalSubmitAuthorization({ authority: binding, intent: snapshot }))).toMatchObject({
        operation: 'begin-submit',
      })
    }

    const closeBinding = resultSuccess(
      decideMutationAuthority(
        MutationOperation.Submit,
        { ...decisionAuthority, effective: Authority.Observe, killState: KillState.Active },
        true,
      ),
    )
    const closeInput = { ...decisionStartInput(MutationOperation.Submit), closeOnly: true as const }
    const closeStarted = resultSuccess(
      decideMutationStart(
        MutationOperation.Submit,
        closeInput,
        closeBinding,
        { ...decisionIntent(), side: OrderSide.Sell },
        undefined,
      ),
    )
    expect(closeStarted.intentTransition).toBe('ApprovedToIoStarted')
    expect(
      resultFailure(
        decideMutationStart(MutationOperation.Submit, closeInput, closeBinding, decisionIntent(), undefined),
      ),
    ).toMatchObject({ failure: 'authority', message: 'close-only submit requires a sell intent' })
    expect(
      resultFailure(
        decideFinalSubmitAuthorization({
          authority: closeBinding,
          intent: decisionIntent(IntentState.IoStarted),
          closeOnly: true,
        }),
      ),
    ).toMatchObject({ failure: 'authority', message: 'close-only submit requires a sell intent' })
  })

  test('decides start replay, immutable binding, stale time, and retained cancel identity', () => {
    const submitInput = decisionStartInput(MutationOperation.Submit)
    const submitStarted = decisionEvent(MutationOperation.Submit, MutationEventType.SubmitStarted)
    expect(resultSuccess(decideMutationStartReplay(MutationOperation.Submit, submitInput, undefined))).toEqual({
      _tag: 'BeginMutation',
    })
    const replay = resultSuccess(decideMutationStartReplay(MutationOperation.Submit, submitInput, submitStarted))
    expect(replay).toEqual({
      _tag: 'ReplayMutation',
      receipt: { event: submitStarted, started: false },
    })
    if (replay._tag === 'ReplayMutation') expect(replay.receipt.event).toBe(submitStarted)

    for (const changed of [
      { ...submitStarted, requestHash: '2'.repeat(64) },
      { ...submitStarted, consistencyDelayMs: 2_000 },
      { ...submitStarted, mutationId: '3'.repeat(64) },
    ]) {
      expect(resultFailure(decideMutationStartReplay(MutationOperation.Submit, submitInput, changed))).toMatchObject({
        operation: 'begin-submit',
        failure: 'conflict',
        message: 'mutation identity was reused with different request content',
      })
    }
    const cancelInput = decisionStartInput(MutationOperation.Cancel, orderId)
    expect(
      resultFailure(
        decideMutationStartReplay(
          MutationOperation.Cancel,
          cancelInput,
          decisionEvent(MutationOperation.Cancel, MutationEventType.CancelStarted, {
            brokerOrderId: 'another-order',
          }),
        ),
      ),
    ).toMatchObject({ operation: 'begin-cancel', failure: 'conflict' })
    const malformedReplay = resultFailure(
      decideMutationStartReplay(MutationOperation.Submit, { ...submitInput, intentId: '\ud800' }, submitStarted),
    )
    expect(malformedReplay).toMatchObject({
      operation: 'begin-submit',
      failure: 'invariant',
      message: 'mutation identity canonicalization failed',
      cause: {
        _tag: 'CanonicalJsonFailure',
        path: '$.intentId',
        reason: 'invalid-unicode-surrogate',
        actualType: 'string',
      },
    })
    expect(malformedReplay.cause).toBe(malformedReplay.canonicalizationFailure?.cause)

    const authority = resultSuccess(decideMutationAuthority(MutationOperation.Submit, decisionAuthority))
    const submit = resultSuccess(
      decideMutationStart(MutationOperation.Submit, submitInput, authority, decisionIntent(), undefined),
    )
    expect(submit).toMatchObject({
      event: {
        operation: MutationOperation.Submit,
        eventType: MutationEventType.SubmitStarted,
        sequence: 1,
      },
      intentTransition: 'ApprovedToIoStarted',
    })

    const bindingFailures: readonly [MutationIntentSnapshot, string][] = [
      [
        { ...decisionIntent(), generationMaximum: Authority.Observe },
        'intent does not match its immutable PAPER authority-generation bindings',
      ],
      [
        { ...decisionIntent(), generationAccountId: null },
        'intent does not match its immutable PAPER authority-generation bindings',
      ],
      [
        { ...decisionIntent(), generationAccountId: 'another-account' },
        'intent does not match its immutable PAPER authority-generation bindings',
      ],
      [
        { ...decisionIntent(), generationRiskPolicyHash: '4'.repeat(64) },
        'intent does not match its immutable PAPER authority-generation bindings',
      ],
      [
        { ...decisionIntent(), generationStrategyName: 'another-strategy' },
        'intent does not match its immutable PAPER authority-generation bindings',
      ],
    ]
    for (const [snapshot, message] of bindingFailures) {
      expect(
        resultFailure(decideMutationStart(MutationOperation.Submit, submitInput, authority, snapshot, undefined)),
      ).toMatchObject({ operation: 'begin-submit', failure: 'authority', message })
    }
    expect(
      resultFailure(
        decideMutationStart(
          MutationOperation.Submit,
          submitInput,
          { ...authority, accountId: 'another-account' },
          decisionIntent(),
          undefined,
        ),
      ),
    ).toMatchObject({
      message: 'intent account does not match the active PAPER authority generation',
    })
    expect(
      resultFailure(
        decideMutationStart(
          MutationOperation.Submit,
          submitInput,
          authority,
          { ...decisionIntent(), authorityGenerationHash: '5'.repeat(64) },
          undefined,
        ),
      ),
    ).toMatchObject({
      message: 'intent authority generation is not the active PAPER generation',
    })
    expect(
      resultFailure(
        decideMutationStart(
          MutationOperation.Submit,
          { ...submitInput, occurredAt: initialTime },
          authority,
          decisionIntent(),
          undefined,
        ),
      ),
    ).toMatchObject({ message: 'mutation time must follow the intent state' })

    const retainedStates: readonly [MutationEventType, IntentState][] = [
      [MutationEventType.SubmitAccepted, IntentState.Acknowledged],
      [MutationEventType.RecoveryFound, IntentState.Acknowledged],
      [MutationEventType.SubmitUnknown, IntentState.Unknown],
      [MutationEventType.RecoveryNotFound, IntentState.Unknown],
      [MutationEventType.RecoveryUnknown, IntentState.Unknown],
    ]
    for (const [eventType, state] of retainedStates) {
      const cancel = resultSuccess(
        decideMutationStart(
          MutationOperation.Cancel,
          cancelInput,
          authority,
          decisionIntent(state),
          decisionEvent(MutationOperation.Submit, eventType, { brokerOrderId: orderId }),
        ),
      )
      expect(cancel).toMatchObject({
        event: { operation: MutationOperation.Cancel, eventType: MutationEventType.CancelStarted },
        intentTransition: 'KeepIntentState',
      })
    }
    for (const submitted of [
      undefined,
      decisionEvent(MutationOperation.Submit, MutationEventType.SubmitRejected, { brokerOrderId: orderId }),
      decisionEvent(MutationOperation.Submit, MutationEventType.SubmitAccepted, {
        brokerOrderId: 'another-order',
      }),
    ]) {
      expect(
        resultFailure(
          decideMutationStart(
            MutationOperation.Cancel,
            cancelInput,
            authority,
            decisionIntent(IntentState.Acknowledged),
            submitted,
          ),
        ),
      ).toMatchObject({
        operation: 'begin-cancel',
        failure: 'invariant',
        message: 'cancel requires the exact durable submitted order identity',
      })
    }

    const malformedBrokerOrderId = '\ud800'
    const malformedEvent = resultFailure(
      decideMutationStart(
        MutationOperation.Cancel,
        decisionStartInput(MutationOperation.Cancel, malformedBrokerOrderId),
        authority,
        decisionIntent(IntentState.Acknowledged),
        {
          ...decisionEvent(MutationOperation.Submit, MutationEventType.SubmitAccepted, {
            brokerOrderId: orderId,
          }),
          brokerOrderId: malformedBrokerOrderId,
        },
      ),
    )
    expect(malformedEvent).toMatchObject({
      operation: 'begin-cancel',
      failure: 'invariant',
      message: 'mutation event canonicalization failed',
      cause: {
        _tag: 'CanonicalJsonFailure',
        path: '$.brokerOrderId',
        reason: 'invalid-unicode-surrogate',
        actualType: 'string',
      },
    })
    expect(malformedEvent.cause).toBe(malformedEvent.canonicalizationFailure?.cause)
  })

  test('maps every public outcome to one closed transition decision', () => {
    const cases: readonly [
      MutationOutcomeDefinition,
      MutationOperation,
      MutationEventType,
      MutationIntentTransition['_tag'],
      IntentState | undefined,
      TerminalOutcome | undefined,
    ][] = [
      [
        { _tag: 'SubmitAccepted' },
        MutationOperation.Submit,
        MutationEventType.SubmitAccepted,
        'TransitionFromIoStarted',
        IntentState.Acknowledged,
        undefined,
      ],
      [
        { _tag: 'SubmitAccepted', terminalOutcome: TerminalOutcome.Filled },
        MutationOperation.Submit,
        MutationEventType.SubmitAccepted,
        'TransitionFromIoStarted',
        IntentState.Terminal,
        TerminalOutcome.Filled,
      ],
      [
        { _tag: 'SubmitRejected' },
        MutationOperation.Submit,
        MutationEventType.SubmitRejected,
        'TransitionFromIoStarted',
        IntentState.Terminal,
        TerminalOutcome.Rejected,
      ],
      [
        { _tag: 'SubmitUnknown' },
        MutationOperation.Submit,
        MutationEventType.SubmitUnknown,
        'TransitionFromIoStarted',
        IntentState.Unknown,
        undefined,
      ],
      [
        { _tag: 'CancelAccepted' },
        MutationOperation.Cancel,
        MutationEventType.CancelAccepted,
        'KeepIntentState',
        undefined,
        undefined,
      ],
      [
        { _tag: 'CancelUnknown' },
        MutationOperation.Cancel,
        MutationEventType.CancelUnknown,
        'KeepIntentState',
        undefined,
        undefined,
      ],
      [
        { _tag: 'RecoveryFound', operation: MutationOperation.Submit },
        MutationOperation.Submit,
        MutationEventType.RecoveryFound,
        'RecoverSubmit',
        IntentState.Acknowledged,
        undefined,
      ],
      [
        {
          _tag: 'RecoveryFound',
          operation: MutationOperation.Submit,
          terminalOutcome: TerminalOutcome.Expired,
        },
        MutationOperation.Submit,
        MutationEventType.RecoveryFound,
        'RecoverSubmit',
        IntentState.Terminal,
        TerminalOutcome.Expired,
      ],
      [
        { _tag: 'RecoveryFound', operation: MutationOperation.Cancel },
        MutationOperation.Cancel,
        MutationEventType.RecoveryFound,
        'KeepIntentState',
        undefined,
        undefined,
      ],
      [
        {
          _tag: 'RecoveryFound',
          operation: MutationOperation.Cancel,
          terminalOutcome: TerminalOutcome.Canceled,
        },
        MutationOperation.Cancel,
        MutationEventType.RecoveryFound,
        'RecoverCancelTerminal',
        IntentState.Terminal,
        TerminalOutcome.Canceled,
      ],
      [
        { _tag: 'RecoveryNotFound', operation: MutationOperation.Submit },
        MutationOperation.Submit,
        MutationEventType.RecoveryNotFound,
        'KeepIntentState',
        undefined,
        undefined,
      ],
      [
        { _tag: 'RecoveryUnknown', operation: MutationOperation.Cancel },
        MutationOperation.Cancel,
        MutationEventType.RecoveryUnknown,
        'KeepIntentState',
        undefined,
        undefined,
      ],
    ]

    for (const [definition, operation, eventType, tag, state, terminalOutcome] of cases) {
      const previousType =
        definition._tag === 'SubmitAccepted' ||
        definition._tag === 'SubmitRejected' ||
        definition._tag === 'SubmitUnknown'
          ? MutationEventType.SubmitStarted
          : definition._tag === 'CancelAccepted' || definition._tag === 'CancelUnknown'
            ? MutationEventType.CancelStarted
            : operation === MutationOperation.Submit
              ? MutationEventType.SubmitUnknown
              : MutationEventType.CancelUnknown
      const brokerOrderId =
        eventType === MutationEventType.SubmitRejected || eventType === MutationEventType.SubmitUnknown
          ? undefined
          : orderId
      const status =
        eventType === MutationEventType.CancelAccepted
          ? 204
          : eventType === MutationEventType.RecoveryNotFound
            ? 404
            : eventType === MutationEventType.SubmitRejected
              ? 422
              : 200
      const previous = decisionEvent(
        operation,
        previousType,
        operation === MutationOperation.Cancel ? { brokerOrderId: orderId } : {},
      )
      const decision = resultSuccess(
        decideMutationOutcome(
          decisionOutcomeInput({
            ...(brokerOrderId === undefined ? {} : { brokerOrderId }),
            evidence: evidence(status, decisionOutcomeAt),
          }),
          definition,
          previous,
          decisionReplayIntent(
            previousType === MutationEventType.SubmitStarted || previousType === MutationEventType.CancelStarted
              ? IntentState.IoStarted
              : IntentState.Unknown,
          ),
        ),
      )
      expect(decision).toMatchObject({
        _tag: 'AppendMutation',
        event: { operation, eventType },
        transition: { _tag: tag },
      })
      if (decision._tag !== 'AppendMutation') throw new Error('expected append decision')
      if ('nextState' in decision.transition) {
        if (state === undefined) throw new Error('expected a transition state')
        expect(decision.transition.nextState).toBe(state)
      } else {
        expect(state).toBeUndefined()
      }
      if ('terminalOutcome' in decision.transition) {
        if (terminalOutcome === undefined) throw new Error('expected a terminal outcome')
        expect(decision.transition.terminalOutcome).toBe(terminalOutcome)
      } else {
        expect(terminalOutcome).toBeUndefined()
      }
    }
  })

  test('decides every durable event transition, exact replay, retained ID, and cancel-first containment', () => {
    const allowed: readonly [MutationOperation, MutationEventType, MutationEventType][] = [
      [MutationOperation.Submit, MutationEventType.SubmitStarted, MutationEventType.SubmitAccepted],
      [MutationOperation.Submit, MutationEventType.SubmitStarted, MutationEventType.SubmitRejected],
      [MutationOperation.Submit, MutationEventType.SubmitStarted, MutationEventType.SubmitDenied],
      [MutationOperation.Submit, MutationEventType.SubmitStarted, MutationEventType.SubmitUnknown],
      [MutationOperation.Cancel, MutationEventType.CancelStarted, MutationEventType.CancelAccepted],
      [MutationOperation.Cancel, MutationEventType.CancelStarted, MutationEventType.CancelUnknown],
      [MutationOperation.Submit, MutationEventType.SubmitAccepted, MutationEventType.RecoveryFound],
      [MutationOperation.Submit, MutationEventType.SubmitUnknown, MutationEventType.RecoveryNotFound],
      [MutationOperation.Cancel, MutationEventType.CancelAccepted, MutationEventType.RecoveryUnknown],
      [MutationOperation.Cancel, MutationEventType.CancelUnknown, MutationEventType.RecoveryFound],
      [MutationOperation.Submit, MutationEventType.RecoveryFound, MutationEventType.RecoveryNotFound],
      [MutationOperation.Submit, MutationEventType.RecoveryNotFound, MutationEventType.RecoveryUnknown],
      [MutationOperation.Cancel, MutationEventType.RecoveryUnknown, MutationEventType.RecoveryFound],
    ]
    for (const [operation, previousType, nextType] of allowed) {
      const previous =
        previousType === MutationEventType.SubmitStarted
          ? decisionEvent(operation, previousType)
          : decisionEvent(operation, previousType, { brokerOrderId: orderId })
      const brokerOrderId =
        nextType === MutationEventType.SubmitRejected ||
        nextType === MutationEventType.SubmitDenied ||
        nextType === MutationEventType.SubmitUnknown
          ? undefined
          : orderId
      const status =
        nextType === MutationEventType.CancelAccepted
          ? 204
          : nextType === MutationEventType.RecoveryNotFound
            ? 404
            : nextType === MutationEventType.SubmitRejected
              ? 422
              : 200
      const definition: MutationOutcomeDefinition = (() => {
        switch (nextType) {
          case MutationEventType.SubmitAccepted:
            return { _tag: 'SubmitAccepted' }
          case MutationEventType.SubmitRejected:
            return { _tag: 'SubmitRejected' }
          case MutationEventType.SubmitDenied:
            return { _tag: 'SubmitDenied' }
          case MutationEventType.SubmitUnknown:
            return { _tag: 'SubmitUnknown' }
          case MutationEventType.CancelAccepted:
            return { _tag: 'CancelAccepted' }
          case MutationEventType.CancelUnknown:
            return { _tag: 'CancelUnknown' }
          case MutationEventType.RecoveryFound:
            return { _tag: 'RecoveryFound', operation }
          case MutationEventType.RecoveryNotFound:
            return { _tag: 'RecoveryNotFound', operation }
          case MutationEventType.RecoveryUnknown:
            return { _tag: 'RecoveryUnknown', operation }
          case MutationEventType.SubmitStarted:
          case MutationEventType.CancelStarted:
            throw new Error('STARTED is not an outcome definition')
        }
      })()
      const result = resultSuccess(
        decideMutationOutcome(
          decisionOutcomeInput({
            ...(brokerOrderId === undefined ? {} : { brokerOrderId }),
            ...(nextType === MutationEventType.SubmitDenied ? {} : { evidence: evidence(status, decisionOutcomeAt) }),
          }),
          definition,
          previous,
          decisionReplayIntent(
            previousType === MutationEventType.SubmitStarted || previousType === MutationEventType.CancelStarted
              ? IntentState.IoStarted
              : IntentState.Unknown,
          ),
        ),
      )
      expect(result).toMatchObject({
        _tag: 'AppendMutation',
        event: {
          eventType: nextType,
          ...(brokerOrderId === undefined ? {} : { brokerOrderId: orderId }),
        },
      })
    }

    const replayEvidence = evidence(404, decisionOutcomeAt)
    const replayed = decisionEvent(MutationOperation.Submit, MutationEventType.RecoveryNotFound, {
      sequence: 2,
      brokerOrderId: orderId,
      requestId: replayEvidence.requestId,
      responseStatus: replayEvidence.status,
      responseContentHash: replayEvidence.contentHash,
    })
    const replay = resultSuccess(
      decideMutationOutcome(
        decisionOutcomeInput({
          occurredAt: '1970-01-01T00:00:03.000Z',
          evidence: replayEvidence,
        }),
        { _tag: 'RecoveryNotFound', operation: MutationOperation.Submit },
        replayed,
        decisionReplayIntent(IntentState.Unknown),
      ),
    )
    expect(replay).toEqual({ _tag: 'ReplayMutation', event: replayed })
    if (replay._tag === 'ReplayMutation') expect(replay.event).toBe(replayed)

    const retained = resultSuccess(
      decideMutationOutcome(
        decisionOutcomeInput({ evidence: evidence(200, decisionOutcomeAt) }),
        { _tag: 'RecoveryFound', operation: MutationOperation.Submit },
        decisionEvent(MutationOperation.Submit, MutationEventType.SubmitAccepted, {
          brokerOrderId: orderId,
        }),
        decisionReplayIntent(IntentState.Acknowledged),
      ),
    )
    expect(retained).toMatchObject({ _tag: 'AppendMutation', event: { brokerOrderId: orderId } })

    const canonicalizationFailure = resultFailure(
      decideMutationOutcome(
        decisionOutcomeInput({ brokerOrderId: '\ud800' }),
        { _tag: 'SubmitUnknown' },
        decisionEvent(MutationOperation.Submit, MutationEventType.SubmitStarted),
        decisionReplayIntent(IntentState.IoStarted),
      ),
    )
    expect(canonicalizationFailure).toMatchObject({
      operation: 'record-submit',
      failure: 'invariant',
      message: 'mutation event canonicalization failed',
      cause: {
        _tag: 'CanonicalJsonFailure',
        path: '$.brokerOrderId',
        reason: 'invalid-unicode-surrogate',
        actualType: 'string',
      },
    })
    expect(canonicalizationFailure.cause).toBe(canonicalizationFailure.canonicalizationFailure?.cause)

    const outcomeFailures: readonly [
      MutationOutcomeInput,
      MutationOutcomeDefinition,
      MutationEvent | undefined,
      string,
    ][] = [
      [decisionOutcomeInput(), { _tag: 'SubmitAccepted' }, undefined, 'mutation STARTED event does not exist'],
      [
        decisionOutcomeInput({ requestHash: '2'.repeat(64) }),
        { _tag: 'SubmitAccepted' },
        decisionEvent(MutationOperation.Submit, MutationEventType.SubmitStarted),
        'mutation request hash changed',
      ],
      [
        decisionOutcomeInput({ brokerOrderId: 'another-order' }),
        { _tag: 'RecoveryFound', operation: MutationOperation.Submit },
        decisionEvent(MutationOperation.Submit, MutationEventType.SubmitAccepted, {
          brokerOrderId: orderId,
        }),
        'mutation broker order identity cannot change',
      ],
      [
        decisionOutcomeInput({ occurredAt: '1969-12-31T23:59:58.000Z' }),
        { _tag: 'SubmitAccepted' },
        decisionEvent(MutationOperation.Submit, MutationEventType.SubmitStarted),
        'mutation identity and sequence must remain exact',
      ],
      [
        decisionOutcomeInput(),
        { _tag: 'CancelAccepted' },
        decisionEvent(MutationOperation.Submit, MutationEventType.SubmitStarted),
        'mutation identity and sequence must remain exact',
      ],
      [
        decisionOutcomeInput(),
        { _tag: 'RecoveryFound', operation: MutationOperation.Submit },
        decisionEvent(MutationOperation.Submit, MutationEventType.SubmitRejected),
        'invalid mutation transition from SUBMIT_REJECTED to RECOVERY_FOUND',
      ],
      [
        decisionOutcomeInput(),
        { _tag: 'RecoveryFound', operation: MutationOperation.Submit },
        decisionEvent(MutationOperation.Submit, MutationEventType.SubmitStarted),
        'invalid mutation transition from SUBMIT_STARTED to RECOVERY_FOUND',
      ],
      [
        decisionOutcomeInput({ brokerOrderId: orderId }),
        { _tag: 'RecoveryUnknown', operation: MutationOperation.Cancel },
        decisionEvent(MutationOperation.Cancel, MutationEventType.CancelStarted, { brokerOrderId: orderId }),
        'invalid mutation transition from CANCEL_STARTED to RECOVERY_UNKNOWN',
      ],
    ]
    for (const [input, definition, previous, message] of outcomeFailures) {
      expect(
        resultFailure(decideMutationOutcome(input, definition, previous, decisionReplayIntent(IntentState.IoStarted))),
      ).toMatchObject({
        failure: message.includes('does not exist') ? 'invariant' : 'conflict',
        message,
      })
    }

    const invalidContracts: readonly [MutationOutcomeInput, MutationOutcomeDefinition, MutationEvent, IntentState][] = [
      [
        decisionOutcomeInput({ evidence: evidence(200, decisionOutcomeAt) }),
        { _tag: 'SubmitAccepted' },
        decisionEvent(MutationOperation.Submit, MutationEventType.SubmitStarted),
        IntentState.IoStarted,
      ],
      [
        decisionOutcomeInput({ evidence: evidence(500, decisionOutcomeAt) }),
        { _tag: 'SubmitRejected' },
        decisionEvent(MutationOperation.Submit, MutationEventType.SubmitStarted),
        IntentState.IoStarted,
      ],
      [
        decisionOutcomeInput({ evidence: evidence(200, decisionOutcomeAt) }),
        { _tag: 'RecoveryFound', operation: MutationOperation.Submit },
        decisionEvent(MutationOperation.Submit, MutationEventType.SubmitUnknown),
        IntentState.Unknown,
      ],
      [
        decisionOutcomeInput({ evidence: evidence(200, decisionOutcomeAt) }),
        { _tag: 'RecoveryNotFound', operation: MutationOperation.Submit },
        decisionEvent(MutationOperation.Submit, MutationEventType.SubmitUnknown),
        IntentState.Unknown,
      ],
      [
        decisionOutcomeInput({ brokerOrderId: orderId, evidence: evidence(200, decisionOutcomeAt) }),
        { _tag: 'CancelAccepted' },
        decisionEvent(MutationOperation.Cancel, MutationEventType.CancelStarted, { brokerOrderId: orderId }),
        IntentState.Acknowledged,
      ],
      [
        decisionOutcomeInput(),
        { _tag: 'CancelUnknown' },
        decisionEvent(MutationOperation.Cancel, MutationEventType.CancelStarted),
        IntentState.Acknowledged,
      ],
    ]
    for (const [input, definition, previous, state] of invalidContracts) {
      expect(
        resultFailure(decideMutationOutcome(input, definition, previous, decisionReplayIntent(state))),
      ).toMatchObject({
        failure: 'invariant',
        message: 'mutation event does not match its operation and evidence contract',
      })
    }

    const recoveryInput = decisionOutcomeInput({
      brokerOrderId: orderId,
      evidence: evidence(200, decisionOutcomeAt),
    })
    const unknownSubmit = decisionEvent(MutationOperation.Submit, MutationEventType.SubmitUnknown)
    const terminalSubmit = resultSuccess(
      decideMutationOutcome(
        recoveryInput,
        {
          _tag: 'RecoveryFound',
          operation: MutationOperation.Submit,
          terminalOutcome: TerminalOutcome.Filled,
        },
        unknownSubmit,
        decisionReplayIntent(IntentState.Unknown),
      ),
    )
    expect(terminalSubmit).toMatchObject({
      _tag: 'AppendMutation',
      cancelFirst: { _tag: 'RequireNoDurableCancellation' },
    })
    const openSubmit = resultSuccess(
      decideMutationOutcome(
        recoveryInput,
        { _tag: 'RecoveryFound', operation: MutationOperation.Submit },
        unknownSubmit,
        decisionReplayIntent(IntentState.Unknown),
      ),
    )
    expect(openSubmit).toMatchObject({
      _tag: 'AppendMutation',
      cancelFirst: { _tag: 'SkipCancelFirstRead' },
    })

    const acceptedEvidence = evidence(200, decisionOutcomeAt)
    const accepted = decisionEvent(MutationOperation.Submit, MutationEventType.SubmitAccepted, {
      sequence: 2,
      brokerOrderId: orderId,
      requestId: acceptedEvidence.requestId,
      responseStatus: acceptedEvidence.status,
      responseContentHash: acceptedEvidence.contentHash,
    })
    const acceptedInput = decisionOutcomeInput({
      brokerOrderId: orderId,
      evidence: acceptedEvidence,
      occurredAt: '1970-01-01T00:00:03.000Z',
    })
    expect(
      resultSuccess(
        decideMutationOutcome(
          acceptedInput,
          { _tag: 'SubmitAccepted' },
          accepted,
          decisionReplayIntent(IntentState.Acknowledged),
        ),
      ),
    ).toEqual({ _tag: 'ReplayMutation', event: accepted })
    expect(
      resultFailure(
        decideMutationOutcome(
          acceptedInput,
          { _tag: 'SubmitAccepted', terminalOutcome: TerminalOutcome.Filled },
          accepted,
          decisionReplayIntent(IntentState.Acknowledged),
        ),
      ),
    ).toMatchObject({
      operation: 'record-submit',
      failure: 'conflict',
      message: 'mutation outcome replay conflicts with durable intent state',
    })
    expect(
      resultSuccess(
        decideMutationOutcome(
          acceptedInput,
          { _tag: 'SubmitAccepted', terminalOutcome: TerminalOutcome.Filled },
          accepted,
          decisionReplayIntent(IntentState.Terminal, TerminalOutcome.Filled),
        ),
      ),
    ).toEqual({ _tag: 'ReplayMutation', event: accepted })

    const identicalEvidenceWrongIntent = resultFailure(
      decideMutationOutcome(
        { ...acceptedInput, intentId: '2'.repeat(64) },
        { _tag: 'SubmitAccepted' },
        accepted,
        decisionReplayIntent(IntentState.Acknowledged),
      ),
    )
    expect(identicalEvidenceWrongIntent).toMatchObject({
      operation: 'record-submit',
      failure: 'conflict',
      message: 'mutation identity and sequence must remain exact',
    })
    const identicalEvidenceWrongOperation = resultFailure(
      decideMutationOutcome(
        acceptedInput,
        { _tag: 'CancelAccepted' },
        accepted,
        decisionReplayIntent(IntentState.Acknowledged),
      ),
    )
    expect(identicalEvidenceWrongOperation).toMatchObject({
      operation: 'record-cancel',
      failure: 'conflict',
      message: 'mutation identity and sequence must remain exact',
    })
  })

  test('binds same-evidence replay to the exact terminal outcome while retaining open and unknown replay', () => {
    const submitEvidence = evidence(200, decisionOutcomeAt)
    const submitInput = decisionOutcomeInput({
      brokerOrderId: orderId,
      evidence: submitEvidence,
      occurredAt: '1970-01-01T00:00:03.000Z',
    })
    const submitAccepted = decisionEvent(MutationOperation.Submit, MutationEventType.SubmitAccepted, {
      sequence: 2,
      brokerOrderId: orderId,
      requestId: submitEvidence.requestId,
      responseStatus: submitEvidence.status,
      responseContentHash: submitEvidence.contentHash,
    })
    const submitRecovery = { ...submitAccepted, eventType: MutationEventType.RecoveryFound, sequence: 3 }
    const cancelRecovery = decisionEvent(MutationOperation.Cancel, MutationEventType.RecoveryFound, {
      sequence: 3,
      brokerOrderId: orderId,
      requestId: submitEvidence.requestId,
      responseStatus: submitEvidence.status,
      responseContentHash: submitEvidence.contentHash,
    })

    const terminalCases: readonly {
      readonly durable: MutationReplayIntentSnapshot
      readonly exact: MutationOutcomeDefinition
      readonly conflicting: MutationOutcomeDefinition
      readonly input: MutationOutcomeInput
      readonly operation: MutationStoreError['operation']
      readonly previous: MutationEvent
    }[] = [
      {
        durable: decisionReplayIntent(IntentState.Terminal, TerminalOutcome.Filled),
        exact: { _tag: 'SubmitAccepted', terminalOutcome: TerminalOutcome.Filled },
        conflicting: { _tag: 'SubmitAccepted', terminalOutcome: TerminalOutcome.Canceled },
        input: submitInput,
        operation: 'record-submit',
        previous: submitAccepted,
      },
      {
        durable: decisionReplayIntent(IntentState.Terminal, TerminalOutcome.Filled),
        exact: {
          _tag: 'RecoveryFound',
          operation: MutationOperation.Submit,
          terminalOutcome: TerminalOutcome.Filled,
        },
        conflicting: {
          _tag: 'RecoveryFound',
          operation: MutationOperation.Submit,
          terminalOutcome: TerminalOutcome.Expired,
        },
        input: submitInput,
        operation: 'record-recovery',
        previous: submitRecovery,
      },
      {
        durable: decisionReplayIntent(IntentState.Terminal, TerminalOutcome.Canceled),
        exact: {
          _tag: 'RecoveryFound',
          operation: MutationOperation.Cancel,
          terminalOutcome: TerminalOutcome.Canceled,
        },
        conflicting: {
          _tag: 'RecoveryFound',
          operation: MutationOperation.Cancel,
          terminalOutcome: TerminalOutcome.Expired,
        },
        input: submitInput,
        operation: 'record-recovery',
        previous: cancelRecovery,
      },
    ]

    for (const replay of terminalCases) {
      expect(resultSuccess(decideMutationOutcome(replay.input, replay.exact, replay.previous, replay.durable))).toEqual(
        {
          _tag: 'ReplayMutation',
          event: replay.previous,
        },
      )
      expect(
        resultFailure(decideMutationOutcome(replay.input, replay.conflicting, replay.previous, replay.durable)),
      ).toMatchObject({
        operation: replay.operation,
        failure: 'conflict',
        message: 'mutation outcome replay conflicts with durable intent state',
      })
    }

    const openCancelRecovery = {
      _tag: 'RecoveryFound',
      operation: MutationOperation.Cancel,
    } as const
    for (const state of [IntentState.Acknowledged, IntentState.Unknown, IntentState.Recovered]) {
      expect(
        resultSuccess(
          decideMutationOutcome(submitInput, openCancelRecovery, cancelRecovery, decisionReplayIntent(state)),
        ),
      ).toEqual({ _tag: 'ReplayMutation', event: cancelRecovery })
    }
    expect(
      resultFailure(
        decideMutationOutcome(
          submitInput,
          openCancelRecovery,
          cancelRecovery,
          decisionReplayIntent(IntentState.Terminal, TerminalOutcome.Canceled),
        ),
      ),
    ).toMatchObject({
      operation: 'record-recovery',
      failure: 'conflict',
      message: 'mutation outcome replay conflicts with durable intent state',
    })

    expect(
      resultSuccess(
        decideMutationOutcome(
          submitInput,
          { _tag: 'RecoveryFound', operation: MutationOperation.Submit },
          submitRecovery,
          decisionReplayIntent(IntentState.Acknowledged),
        ),
      ),
    ).toEqual({ _tag: 'ReplayMutation', event: submitRecovery })

    const unknownEvidence = evidence(503, decisionOutcomeAt)
    const unknown = decisionEvent(MutationOperation.Submit, MutationEventType.SubmitUnknown, {
      sequence: 2,
      requestId: unknownEvidence.requestId,
      responseStatus: unknownEvidence.status,
      responseContentHash: unknownEvidence.contentHash,
    })
    expect(
      resultSuccess(
        decideMutationOutcome(
          decisionOutcomeInput({ evidence: unknownEvidence }),
          { _tag: 'SubmitUnknown' },
          unknown,
          decisionReplayIntent(IntentState.Unknown),
        ),
      ),
    ).toEqual({ _tag: 'ReplayMutation', event: unknown })
  })
})

const completeEvidence = (response: PartialMutationEvidence | undefined): MutationEvidence | undefined =>
  response?.requestId !== undefined &&
  response.status !== undefined &&
  response.contentHash !== undefined &&
  response.observedAt !== undefined
    ? {
        requestId: response.requestId,
        status: response.status,
        contentHash: response.contentHash,
        observedAt: response.observedAt,
      }
    : undefined

interface HarnessOptions {
  readonly afterBeginSubmit?: Effect.Effect<void>
  readonly crashAfterSubmit?: boolean
  readonly lostFence?: boolean
  readonly lostFenceAfterSubmit?: boolean
  readonly lookupFailureOnceAfterMs?: number
  readonly notFoundOnce?: boolean
  readonly unknownSubmit?: boolean
  readonly submitError?: BrokerMutationError
  readonly submittedOrder?: Order
  readonly lookupOrder?: Order
  readonly lookupOrders?: readonly Order[]
}

const makeHarness = (options: HarnessOptions = {}) => {
  let stored: StoredIntent = { intent, decision: riskDecision, stateVersion: 3, updatedAt: initialTime }
  const latest = new Map<MutationOperation, MutationEvent>()
  let submitCalls = 0
  let cancelCalls = 0
  let lookupCalls = 0
  let lookupClientOrderId: string | undefined

  const event = (
    operation: MutationOperation,
    eventType: MutationEventType,
    requestHash: string,
    consistencyDelayMs: number,
    occurredAt: string,
    brokerOrderId?: string,
    response?: MutationEvidence,
  ): MutationEvent => {
    const previous = latest.get(operation)
    const sequence = (previous?.sequence ?? 0) + 1
    const effectiveBrokerOrderId = brokerOrderId ?? previous?.brokerOrderId
    const value: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: canonicalHashV1({ operation, sequence, eventType, occurredAt }),
      mutationId: resultSuccess(mutationIdResult(intentId, operation)),
      intentId,
      sequence,
      operation,
      eventType,
      requestHash,
      consistencyDelayMs,
      ...(effectiveBrokerOrderId === undefined ? {} : { brokerOrderId: effectiveBrokerOrderId }),
      ...(response === undefined
        ? {}
        : {
            requestId: response.requestId,
            responseStatus: response.status,
            responseContentHash: response.contentHash,
          }),
      occurredAt,
    }
    latest.set(operation, value)
    return value
  }

  const setState = (state: IntentState, updatedAt: string, terminalOutcome?: TerminalOutcome) => {
    stored = {
      ...stored,
      intent: { ...stored.intent, state, ...(terminalOutcome === undefined ? {} : { terminalOutcome }) },
      stateVersion: stored.stateVersion + 1,
      updatedAt,
    }
  }

  const intentStore: IntentStoreService = {
    commit: () => Effect.die(new Error('unexpected commit')),
    read: (id) => Effect.succeed(id === intentId ? Option.some(stored) : Option.none()),
  }

  const mutationStore: MutationStoreShape = {
    authorizeSubmit: () => Effect.void,
    beginSubmit: (_intentId, requestHash, consistencyDelayMs, occurredAt) => {
      const existing = latest.get(MutationOperation.Submit)
      if (existing !== undefined) {
        if (existing.requestHash !== requestHash || existing.consistencyDelayMs !== consistencyDelayMs) {
          return Effect.die(new Error('mutation identity was reused with different request content'))
        }
        return Effect.succeed({ event: existing, started: false })
      }
      const started = event(
        MutationOperation.Submit,
        MutationEventType.SubmitStarted,
        requestHash,
        consistencyDelayMs,
        occurredAt,
      )
      setState(IntentState.IoStarted, occurredAt)
      return (options.afterBeginSubmit ?? Effect.void).pipe(Effect.as({ event: started, started: true }))
    },
    submitAccepted: (_intentId, requestHash, brokerOrderId, response, terminal) => {
      const accepted = event(
        MutationOperation.Submit,
        MutationEventType.SubmitAccepted,
        requestHash,
        latest.get(MutationOperation.Submit)?.consistencyDelayMs ?? 1,
        response.observedAt,
        brokerOrderId,
        response,
      )
      setState(terminal === undefined ? IntentState.Acknowledged : IntentState.Terminal, response.observedAt, terminal)
      return Effect.succeed(accepted)
    },
    submitRejected: (_intentId, requestHash, response) => {
      const rejected = event(
        MutationOperation.Submit,
        MutationEventType.SubmitRejected,
        requestHash,
        latest.get(MutationOperation.Submit)?.consistencyDelayMs ?? 1,
        response.observedAt,
        undefined,
        response,
      )
      setState(IntentState.Terminal, response.observedAt, TerminalOutcome.Rejected)
      return Effect.succeed(rejected)
    },
    submitDenied: (_intentId, requestHash, occurredAt) => {
      const denied = event(
        MutationOperation.Submit,
        MutationEventType.SubmitDenied,
        requestHash,
        latest.get(MutationOperation.Submit)?.consistencyDelayMs ?? 1,
        occurredAt,
      )
      setState(IntentState.Terminal, occurredAt, TerminalOutcome.Rejected)
      return Effect.succeed(denied)
    },
    submitUnknown: (_intentId, requestHash, occurredAt, response, brokerOrderId) => {
      const unknown = event(
        MutationOperation.Submit,
        MutationEventType.SubmitUnknown,
        requestHash,
        latest.get(MutationOperation.Submit)?.consistencyDelayMs ?? 1,
        occurredAt,
        brokerOrderId,
        completeEvidence(response),
      )
      setState(IntentState.Unknown, occurredAt)
      return Effect.succeed(unknown)
    },
    beginCancel: (_intentId, requestHash, brokerOrderId, consistencyDelayMs, occurredAt) => {
      const existing = latest.get(MutationOperation.Cancel)
      if (existing !== undefined) {
        if (
          existing.requestHash !== requestHash ||
          existing.consistencyDelayMs !== consistencyDelayMs ||
          existing.brokerOrderId !== brokerOrderId
        ) {
          return Effect.die(new Error('mutation identity was reused with different request content'))
        }
        return Effect.succeed({ event: existing, started: false })
      }
      return Effect.succeed({
        event: event(
          MutationOperation.Cancel,
          MutationEventType.CancelStarted,
          requestHash,
          consistencyDelayMs,
          occurredAt,
          brokerOrderId,
        ),
        started: true,
      })
    },
    cancelAccepted: (_intentId, requestHash, brokerOrderId, response) =>
      Effect.succeed(
        event(
          MutationOperation.Cancel,
          MutationEventType.CancelAccepted,
          requestHash,
          latest.get(MutationOperation.Cancel)?.consistencyDelayMs ?? 1,
          response.observedAt,
          brokerOrderId,
          response,
        ),
      ),
    cancelUnknown: (_intentId, requestHash, brokerOrderId, occurredAt, response) =>
      Effect.succeed(
        event(
          MutationOperation.Cancel,
          MutationEventType.CancelUnknown,
          requestHash,
          latest.get(MutationOperation.Cancel)?.consistencyDelayMs ?? 1,
          occurredAt,
          brokerOrderId,
          completeEvidence(response),
        ),
      ),
    recoveryFound: (_intentId, operation, requestHash, brokerOrderId, response, terminal) => {
      const found = event(
        operation,
        MutationEventType.RecoveryFound,
        requestHash,
        latest.get(operation)?.consistencyDelayMs ?? 1,
        response.observedAt,
        brokerOrderId,
        response,
      )
      if (operation === MutationOperation.Submit) {
        setState(
          terminal === undefined ? IntentState.Acknowledged : IntentState.Terminal,
          response.observedAt,
          terminal,
        )
      } else if (terminal !== undefined) {
        setState(IntentState.Terminal, response.observedAt, terminal)
      }
      return Effect.succeed(found)
    },
    recoveryNotFound: (_intentId, operation, requestHash, response) =>
      Effect.succeed(
        event(
          operation,
          MutationEventType.RecoveryNotFound,
          requestHash,
          latest.get(operation)?.consistencyDelayMs ?? 1,
          response.observedAt,
          undefined,
          response,
        ),
      ),
    recoveryUnknown: (_intentId, operation, requestHash, occurredAt, response) =>
      Effect.succeed(
        event(
          operation,
          MutationEventType.RecoveryUnknown,
          requestHash,
          latest.get(operation)?.consistencyDelayMs ?? 1,
          occurredAt,
          undefined,
          completeEvidence(response),
        ),
      ),
    latest: (_intentId, operation) => Effect.succeed(latest.get(operation)),
  }

  const orderByClientId: BrokerReadShape['orderByClientId'] = (clientOrderId) =>
    Effect.gen(function* () {
      lookupCalls += 1
      lookupClientOrderId = clientOrderId
      if (options.lookupFailureOnceAfterMs !== undefined && lookupCalls === 1) {
        yield* Effect.sleep(Duration.millis(options.lookupFailureOnceAfterMs))
        return yield* new BrokerReadError({
          operation: 'order-by-client-id',
          kind: BrokerReadErrorKind.Timeout,
          message: 'injected delayed lookup timeout',
          retryable: false,
        })
      }
      const observedAt = utcInstantFromEpochMillis(yield* Clock.currentTimeMillis)
      if (options.notFoundOnce === true && lookupCalls === 1) {
        return yield* new BrokerReadError({
          operation: 'order-by-client-id',
          kind: BrokerReadErrorKind.NotFound,
          message: 'injected delayed visibility',
          retryable: false,
          status: 404,
          requestId: 'lookup-not-found',
          contentHash: canonicalHashV1({ code: 404, message: 'order not found' }),
          observedAt,
        })
      }
      const selected =
        options.lookupOrders?.[Math.min(lookupCalls - 1, options.lookupOrders.length - 1)] ??
        options.lookupOrder ??
        (latest.get(MutationOperation.Cancel) === undefined
          ? brokerOrder(OrderStatus.Accepted)
          : brokerOrder(OrderStatus.Canceled))
      const value = { ...selected, observedAt }
      return { value, evidence: evidence(200, observedAt) }
    })

  const unexpectedRead = () => Effect.die(new Error('unexpected broker read'))
  const read: BrokerReadShape = {
    account: unexpectedRead(),
    accountConfiguration: unexpectedRead(),
    assetBySymbol: unexpectedRead,
    positions: unexpectedRead(),
    orders: unexpectedRead,
    orderById: unexpectedRead,
    orderByClientId,
    fillActivities: unexpectedRead,
    marketCalendar: unexpectedRead,
  }

  const mutation: BrokerMutationShape = {
    submit: (submitted) => {
      submitCalls += 1
      if (latest.get(MutationOperation.Submit)?.eventType !== MutationEventType.SubmitStarted) {
        return Effect.die(new Error('submit happened before SUBMIT_STARTED was durable'))
      }
      if (options.crashAfterSubmit === true) return Effect.die(new Error('injected crash after send'))
      if (options.submitError !== undefined) return Effect.fail(options.submitError)
      const hash = canonicalHashV1(encodedRequest(submitted))
      if (options.unknownSubmit === true) {
        return Effect.fail(
          new BrokerMutationError({
            operation: MutationOperation.Submit,
            failure: MutationFailure.Unknown,
            outcome: MutationOutcome.Unknown,
            message: 'injected timeout',
            requestHash: hash,
          }),
        )
      }
      const response = evidence(200, '1970-01-01T00:00:00.100Z')
      return Effect.succeed({ requestHash: hash, order: options.submittedOrder ?? brokerOrder(), evidence: response })
    },
    cancel: (brokerOrderId) => {
      cancelCalls += 1
      const response = evidence(204, '1970-01-01T00:00:01.100Z')
      return Effect.succeed({ requestHash: cancelRequestHash(brokerOrderId), brokerOrderId, evidence: response })
    },
  }

  const fenceCheck = Effect.suspend(() => {
    if (
      options.lostFence !== true &&
      !(options.lostFenceAfterSubmit === true && latest.has(MutationOperation.Submit))
    ) {
      return Effect.void
    }
    return Effect.fail(
      new WriterFenceError({
        failure: 'unavailable',
        operation: 'check',
        message: 'injected writer-fence loss',
      }),
    )
  })

  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(IntentStore, intentStore),
      Effect.provideService(MutationStore, mutationStore),
      Effect.provideService(BrokerMutation, mutation),
      Effect.provideService(BrokerRead, read),
      Effect.provideService(WriterFence, {
        backendPid: 1,
        check: fenceCheck,
        transaction: (effect) => effect,
      }),
      provideTestLayer(TestClock.layer()),
    )
  const provideIntentRead = <A, E>(effect: Effect.Effect<A, E, IntentStore>) =>
    effect.pipe(Effect.provideService(IntentStore, intentStore), provideTestLayer(TestClock.layer()))
  const provideRecovery = <A, E>(effect: Effect.Effect<A, E, IntentStore | MutationStore | BrokerRead>) =>
    effect.pipe(
      Effect.provideService(IntentStore, intentStore),
      Effect.provideService(MutationStore, mutationStore),
      Effect.provideService(BrokerRead, read),
      provideTestLayer(TestClock.layer()),
    )

  return {
    provide,
    provideIntentRead,
    provideRecovery,
    mutations: mutationStore,
    calls: () => ({ submit: submitCalls, cancel: cancelCalls, lookup: lookupCalls }),
    lookupClientOrderId: () => lookupClientOrderId,
    intent: () => stored.intent,
    state: () => stored.intent.state,
  }
}

const mismatchedSubmissionError = () =>
  new BrokerMutationError({
    operation: MutationOperation.Submit,
    failure: MutationFailure.Unknown,
    outcome: MutationOutcome.Unknown,
    message: 'accepted order differs from durable intent',
    requestHash: canonicalHashV1(encodedRequest(intent)),
    evidence: evidence(200, '1970-01-01T00:00:00.100Z'),
    brokerOrderId: orderId,
  })

describe('paper execution coordinator', () => {
  test('renders the exact committed request without touching the broker or mutation store', async () => {
    const harness = makeHarness()
    const result = await Effect.runPromise(harness.provideIntentRead(dryRunSubmit(intentId)))

    expect(result).toEqual({
      schemaVersion: 'bayn.paper-submit-dry-run.v1',
      intentId,
      clientOrderId: intent.clientOrderId,
      requestHash: canonicalHashV1(encodedRequest(intent)),
      request: encodedRequest(intent),
    })
    expect(harness.calls()).toEqual({ submit: 0, cancel: 0, lookup: 0 })
    expect(harness.state()).toBe(IntentState.Approved)
  })

  test('rejects a dry-run request when its approved risk decision has expired', async () => {
    const harness = makeHarness()
    const failure = await Effect.runPromise(
      harness.provideIntentRead(
        Effect.gen(function* () {
          yield* TestClock.adjust(600_000)
          return yield* Effect.flip(dryRunSubmit(intentId))
        }),
      ),
    )

    expect(failure).toBeInstanceOf(ExecutionError)
    expect(failure).toMatchObject({
      failure: ExecutionFailure.InvalidState,
      message: `dry-run submission risk decision expired at ${riskDecision.expiresAt}`,
    })
    expect(harness.calls()).toEqual({ submit: 0, cancel: 0, lookup: 0 })
    expect(harness.state()).toBe(IntentState.Approved)
  })

  test('makes zero POST calls when the risk decision expires exactly at submission', async () => {
    const harness = makeHarness()
    const failure = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* TestClock.adjust(600_000)
          return yield* Effect.flip(submit(intentId, 1_000))
        }),
      ),
    )

    expect(failure).toBeInstanceOf(ExecutionError)
    expect(failure).toMatchObject({
      failure: ExecutionFailure.InvalidState,
      message: `submission risk decision expired at ${riskDecision.expiresAt}`,
    })
    expect(harness.calls()).toEqual({ submit: 0, cancel: 0, lookup: 0 })
    expect(harness.state()).toBe(IntentState.Approved)
  })

  test('records a durable no-send outcome when the decision expires after SUBMIT_STARTED but before broker I/O', async () => {
    const harness = makeHarness({ afterBeginSubmit: TestClock.adjust(600_000) })
    const denied = await Effect.runPromise(harness.provide(submit(intentId, 1_000)))

    expect(denied).toMatchObject({ eventType: MutationEventType.SubmitDenied })
    expect(harness.calls()).toEqual({ submit: 0, cancel: 0, lookup: 0 })
    expect(harness.intent()).toMatchObject({ state: IntentState.Terminal, terminalOutcome: TerminalOutcome.Rejected })
  })

  test('records before submission and never calls the broker again for a replayed intent', async () => {
    const harness = makeHarness()
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          const accepted = yield* submit(intentId, 1_000)
          yield* TestClock.adjust(600_000)
          const replay = yield* submit(intentId, 1_000)
          return { accepted, replay }
        }),
      ),
    )

    expect(result.accepted.eventType).toBe(MutationEventType.SubmitAccepted)
    expect(result.replay.eventId).toBe(result.accepted.eventId)
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 0 })
    expect(harness.state()).toBe(IntentState.Acknowledged)
  })

  test('recovers an accepted order to terminal at the exact delay without another POST', async () => {
    const harness = makeHarness({ lookupOrder: brokerOrder(OrderStatus.Filled) })
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          const accepted = yield* submit(intentId, 1_000)
          yield* TestClock.adjust(1_099)
          const tooEarly = yield* Effect.flip(recover(intentId, MutationOperation.Submit))
          yield* TestClock.adjust(1)
          const terminal = yield* recover(intentId, MutationOperation.Submit)
          const replay = yield* recover(intentId, MutationOperation.Submit)
          return { accepted, replay, terminal, tooEarly }
        }),
      ),
    )

    expect(result.accepted.eventType).toBe(MutationEventType.SubmitAccepted)
    expect(result.tooEarly).toMatchObject({
      failure: ExecutionFailure.RecoveryTooEarly,
      eligibleAt: '1970-01-01T00:00:01.100Z',
    })
    expect(result.terminal.eventType).toBe(MutationEventType.RecoveryFound)
    expect(result.replay.eventId).toBe(result.terminal.eventId)
    expect(harness.intent()).toMatchObject({
      state: IntentState.Terminal,
      terminalOutcome: TerminalOutcome.Filled,
    })
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 1 })
  })

  test('retains an accepted open order and allows a later terminal recovery after the next delay', async () => {
    const harness = makeHarness({
      lookupOrders: [brokerOrder(OrderStatus.Accepted), brokerOrder(OrderStatus.Filled)],
    })
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* submit(intentId, 1_000)
          yield* TestClock.adjust(1_100)
          const open = yield* recover(intentId, MutationOperation.Submit)
          const tooEarly = yield* Effect.flip(recover(intentId, MutationOperation.Submit))
          yield* TestClock.adjust(1_000)
          const terminal = yield* recover(intentId, MutationOperation.Submit)
          return { open, terminal, tooEarly }
        }),
      ),
    )

    expect(result.open.eventType).toBe(MutationEventType.RecoveryFound)
    expect(result.tooEarly).toMatchObject({
      failure: ExecutionFailure.RecoveryTooEarly,
      eligibleAt: '1970-01-01T00:00:02.100Z',
    })
    expect(result.terminal.eventType).toBe(MutationEventType.RecoveryFound)
    expect(harness.intent()).toMatchObject({
      state: IntentState.Terminal,
      terminalOutcome: TerminalOutcome.Filled,
    })
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 2 })
  })

  test('timestamps evidence-less recovery failure after lookup I/O and enforces the next full delay', async () => {
    const harness = makeHarness({
      lookupFailureOnceAfterMs: 400,
      lookupOrder: brokerOrder(OrderStatus.Filled),
    })
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* submit(intentId, 1_000)
          yield* TestClock.adjust(1_100)
          const recovery = yield* recover(intentId, MutationOperation.Submit).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* TestClock.adjust(400)
          const unknown = yield* Fiber.join(recovery)
          yield* TestClock.adjust(999)
          const tooEarly = yield* Effect.flip(recover(intentId, MutationOperation.Submit))
          const callsBeforeFullDelay = harness.calls()
          yield* TestClock.adjust(1)
          const terminal = yield* recover(intentId, MutationOperation.Submit)
          return { callsBeforeFullDelay, terminal, tooEarly, unknown }
        }),
      ),
    )

    expect(result.unknown).toMatchObject({
      eventType: MutationEventType.RecoveryUnknown,
      occurredAt: '1970-01-01T00:00:01.500Z',
    })
    expect(result.tooEarly).toMatchObject({
      failure: ExecutionFailure.RecoveryTooEarly,
      eligibleAt: '1970-01-01T00:00:02.500Z',
    })
    expect(result.callsBeforeFullDelay).toEqual({ submit: 1, cancel: 0, lookup: 1 })
    expect(result.terminal.eventType).toBe(MutationEventType.RecoveryFound)
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 2 })
    expect(harness.intent()).toMatchObject({
      state: IntentState.Terminal,
      terminalOutcome: TerminalOutcome.Filled,
    })
  })

  test('retains an accepted broker order identity after a 404 and allows later terminal recovery', async () => {
    const harness = makeHarness({
      notFoundOnce: true,
      lookupOrder: brokerOrder(OrderStatus.Filled),
    })
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* submit(intentId, 1_000)
          yield* TestClock.adjust(1_100)
          const notFound = yield* recover(intentId, MutationOperation.Submit)
          const afterNotFound = harness.intent()
          yield* TestClock.adjust(1_000)
          const terminal = yield* recover(intentId, MutationOperation.Submit)
          return { afterNotFound, notFound, terminal }
        }),
      ),
    )

    expect(result.notFound).toMatchObject({
      eventType: MutationEventType.RecoveryNotFound,
      brokerOrderId: orderId,
    })
    expect(result.afterNotFound).toMatchObject({ state: IntentState.Acknowledged })
    expect(result.terminal).toMatchObject({
      eventType: MutationEventType.RecoveryFound,
      brokerOrderId: orderId,
    })
    expect(harness.intent()).toMatchObject({
      state: IntentState.Terminal,
      terminalOutcome: TerminalOutcome.Filled,
    })
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 2 })
  })

  test('recovers a durable cancellation before allowing submit history to resolve', async () => {
    const harness = makeHarness()
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* submit(intentId, 1_000)
          yield* cancel(intentId, 1_000)
          yield* TestClock.adjust(1_100)
          const blockedSubmit = yield* Effect.flip(recover(intentId, MutationOperation.Submit))
          yield* TestClock.adjust(1_000)
          const canceled = yield* recover(intentId, MutationOperation.Cancel)
          const submitReplay = yield* recover(intentId, MutationOperation.Submit)
          return { blockedSubmit, canceled, submitReplay }
        }),
      ),
    )

    expect(result.blockedSubmit).toMatchObject({
      failure: ExecutionFailure.InvalidState,
      message: 'submit recovery requires the durable cancellation to recover first',
    })
    expect(result.canceled).toMatchObject({
      eventType: MutationEventType.RecoveryFound,
      brokerOrderId: orderId,
    })
    expect(result.submitReplay.eventType).toBe(MutationEventType.SubmitAccepted)
    expect(harness.intent()).toMatchObject({
      state: IntentState.Terminal,
      terminalOutcome: TerminalOutcome.Canceled,
    })
    expect(harness.calls()).toEqual({ submit: 1, cancel: 1, lookup: 1 })
  })

  test('keeps an accepted intent acknowledged when lookup returns a different broker order', async () => {
    const otherOrderId = 'f93d3f58-0e70-4cd2-a9e1-2fcb89d76f74'
    const harness = makeHarness({
      lookupOrder: { ...brokerOrder(OrderStatus.Filled), brokerOrderId: otherOrderId },
    })
    const observed = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* submit(intentId, 1_000)
          yield* TestClock.adjust(1_100)
          return yield* recover(intentId, MutationOperation.Submit)
        }),
      ),
    )

    expect(observed).toMatchObject({
      eventType: MutationEventType.RecoveryUnknown,
      brokerOrderId: orderId,
    })
    expect(harness.intent()).toMatchObject({ state: IntentState.Acknowledged })
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 1 })
  })

  test('rejects a submit replay whose committed consistency delay changes', async () => {
    const harness = makeHarness()
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* submit(intentId, 1_000)
          return yield* Effect.exit(submit(intentId, 1_001))
        }),
      ),
    )

    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(Cause.pretty(result.cause)).toContain('mutation identity was reused with different request content')
    }
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 0 })
  })

  test('accepts the broker-determined filled quantity for an exact notional market order', async () => {
    const harness = makeHarness({
      submittedOrder: { ...brokerOrder(OrderStatus.Filled), filledQuantityMicros: '500000' },
    })

    const result = await Effect.runPromise(harness.provide(submit(intentId, 1_000)))

    expect(result).toMatchObject({
      eventType: MutationEventType.SubmitAccepted,
      brokerOrderId: orderId,
    })
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 0 })
    expect(harness.state()).toBe(IntentState.Terminal)
  })

  test('records a deterministic pre-transmit denial as terminal without recovery or containment', async () => {
    const harness = makeHarness({
      submitError: new BrokerMutationError({
        operation: MutationOperation.Submit,
        failure: MutationFailure.InvalidRequest,
        outcome: MutationOutcome.Known,
        message: 'fresh quote crossed the durable order bound before transmission',
      }),
    })

    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          const denied = yield* submit(intentId, 1_000)
          const replay = yield* recover(intentId, MutationOperation.Submit)
          return { denied, replay }
        }),
      ),
    )

    expect(result.denied.eventType).toBe(MutationEventType.SubmitDenied)
    expect(result.replay).toEqual(result.denied)
    expect(harness.intent()).toMatchObject({
      state: IntentState.Terminal,
      terminalOutcome: TerminalOutcome.Rejected,
    })
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 0 })
  })

  test('cancels and closes a zero-fill mismatched accepted order by its broker ID', async () => {
    const harness = makeHarness({
      lookupOrder: { ...brokerOrder(OrderStatus.Canceled), symbol: 'NVDA' },
      submitError: mismatchedSubmissionError(),
    })

    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          const unknown = yield* submit(intentId, 1_000)
          const canceled = yield* cancel(intentId, 1_000)
          yield* TestClock.adjust(3_000)
          const found = yield* recover(intentId, MutationOperation.Cancel)
          return { unknown, canceled, found }
        }),
      ),
    )

    expect(result.unknown).toMatchObject({
      eventType: MutationEventType.SubmitUnknown,
      brokerOrderId: orderId,
    })
    expect(result.canceled.eventType).toBe(MutationEventType.CancelAccepted)
    expect(result.found.eventType).toBe(MutationEventType.RecoveryFound)
    expect(harness.calls()).toEqual({ submit: 1, cancel: 1, lookup: 1 })
    expect(harness.state()).toBe(IntentState.Terminal)
  })

  test('keeps a partially filled mismatched order UNKNOWN after cancellation', async () => {
    const harness = makeHarness({
      lookupOrder: {
        ...brokerOrder(OrderStatus.Canceled),
        symbol: 'NVDA',
        filledQuantityMicros: '1',
      },
      submitError: mismatchedSubmissionError(),
    })

    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* submit(intentId, 1_000)
          yield* cancel(intentId, 1_000)
          yield* TestClock.adjust(3_000)
          return yield* recover(intentId, MutationOperation.Cancel)
        }),
      ),
    )

    expect(result.eventType).toBe(MutationEventType.RecoveryUnknown)
    expect(harness.calls()).toEqual({ submit: 1, cancel: 1, lookup: 1 })
    expect(harness.state()).toBe(IntentState.Unknown)
  })

  test('makes no broker call or durable start when the writer fence is already lost', async () => {
    const harness = makeHarness({ lostFence: true })
    const failure = await Effect.runPromise(harness.provide(Effect.flip(submit(intentId, 1_000))))

    expect(failure).toBeInstanceOf(WriterFenceError)
    expect(harness.calls()).toEqual({ submit: 0, cancel: 0, lookup: 0 })
    expect(harness.state()).toBe(IntentState.Approved)
  })

  test('recovers an ambiguous POST through verified read lookup after the committed delay', async () => {
    const harness = makeHarness({ notFoundOnce: true, unknownSubmit: true })
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          const unknown = yield* submit(intentId, 1_000)
          const tooEarly = yield* Effect.flip(recover(intentId, MutationOperation.Submit))
          yield* TestClock.adjust(1_000)
          const notFound = yield* recover(intentId, MutationOperation.Submit)
          yield* TestClock.adjust(1_000)
          const found = yield* recover(intentId, MutationOperation.Submit)
          return { found, notFound, tooEarly, unknown }
        }),
      ),
    )

    expect(result.unknown.eventType).toBe(MutationEventType.SubmitUnknown)
    expect(result.tooEarly).toBeInstanceOf(ExecutionError)
    expect(result.tooEarly).toMatchObject({ failure: ExecutionFailure.RecoveryTooEarly })
    expect(result.notFound.eventType).toBe(MutationEventType.RecoveryNotFound)
    expect(result.found.eventType).toBe(MutationEventType.RecoveryFound)
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 2 })
    expect(harness.state()).toBe(IntentState.Acknowledged)
  })

  test('recovers SUBMIT_UNKNOWN through verified read capability after mutation authority is removed', async () => {
    const harness = makeHarness({ lookupOrder: brokerOrder(OrderStatus.Filled) })
    const requestHash = canonicalHashV1(encodedRequest(intent))
    const { found, unknown } = await Effect.runPromise(
      harness.provideRecovery(
        Effect.gen(function* () {
          yield* harness.mutations.beginSubmit(intentId, requestHash, 1_000, '1970-01-01T00:00:00.000Z')
          const unknown = yield* harness.mutations.submitUnknown(intentId, requestHash, '1969-12-31T23:59:58.000Z')
          yield* TestClock.adjust(1_000)
          const found = yield* recover(intentId, MutationOperation.Submit)
          return { found, unknown }
        }),
      ),
    )
    const replay = await Effect.runPromise(harness.provideRecovery(recover(intentId, MutationOperation.Submit)))

    expect(unknown.eventType).toBe(MutationEventType.SubmitUnknown)
    expect(found.eventType).toBe(MutationEventType.RecoveryFound)
    expect(replay.eventId).toBe(found.eventId)
    expect(harness.lookupClientOrderId()).toBe(intent.clientOrderId)
    expect(harness.calls()).toEqual({ submit: 0, cancel: 0, lookup: 1 })
  })

  test('recovers CANCEL_UNKNOWN through verified read capability after mutation authority is removed', async () => {
    const harness = makeHarness()
    const requestHash = canonicalHashV1(encodedRequest(intent))
    const { found, unknown } = await Effect.runPromise(
      harness.provideRecovery(
        Effect.gen(function* () {
          yield* harness.mutations.beginSubmit(intentId, requestHash, 1_000, '1970-01-01T00:00:00.000Z')
          yield* harness.mutations.submitAccepted(
            intentId,
            requestHash,
            orderId,
            evidence(200, '1970-01-01T00:00:00.100Z'),
          )
          yield* harness.mutations.beginCancel(
            intentId,
            cancelRequestHash(orderId),
            orderId,
            1_000,
            '1970-01-01T00:00:00.200Z',
          )
          const unknown = yield* harness.mutations.cancelUnknown(
            intentId,
            cancelRequestHash(orderId),
            orderId,
            '1970-01-01T00:00:00.200Z',
          )
          yield* TestClock.adjust(1_200)
          const found = yield* recover(intentId, MutationOperation.Cancel)
          return { found, unknown }
        }),
      ),
    )
    const replay = await Effect.runPromise(harness.provideRecovery(recover(intentId, MutationOperation.Cancel)))

    expect(unknown.eventType).toBe(MutationEventType.CancelUnknown)
    expect(found.eventType).toBe(MutationEventType.RecoveryFound)
    expect(replay.eventId).toBe(found.eventId)
    expect(harness.lookupClientOrderId()).toBe(intent.clientOrderId)
    expect(harness.calls()).toEqual({ submit: 0, cancel: 0, lookup: 1 })
  })

  test('recovers an injected post-send crash by lookup without resubmitting', async () => {
    const harness = makeHarness({ crashAfterSubmit: true })
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          const crashed = yield* Effect.exit(submit(intentId, 1_000))
          yield* TestClock.adjust(1_000)
          const found = yield* recover(intentId, MutationOperation.Submit)
          return { crashed, found }
        }),
      ),
    )

    expect(Exit.isFailure(result.crashed)).toBe(true)
    expect(result.found.eventType).toBe(MutationEventType.RecoveryFound)
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 1 })
    expect(harness.state()).toBe(IntentState.Acknowledged)
  })

  test('cancels only the identified order and resolves terminal state through lookup', async () => {
    const harness = makeHarness()
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* submit(intentId, 1_000)
          const accepted = yield* cancel(intentId, 1_000)
          yield* TestClock.adjust(3_000)
          const found = yield* recover(intentId, MutationOperation.Cancel)
          return { accepted, found }
        }),
      ),
    )

    expect(result.accepted.eventType).toBe(MutationEventType.CancelAccepted)
    expect(result.found.eventType).toBe(MutationEventType.RecoveryFound)
    expect(harness.calls()).toEqual({ submit: 1, cancel: 1, lookup: 1 })
    expect(harness.state()).toBe(IntentState.Terminal)
  })

  test('rejects a cancel replay whose committed consistency delay changes', async () => {
    const harness = makeHarness()
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* submit(intentId, 1_000)
          yield* cancel(intentId, 1_000)
          return yield* Effect.exit(cancel(intentId, 1_001))
        }),
      ),
    )

    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(Cause.pretty(result.cause)).toContain('mutation identity was reused with different request content')
    }
    expect(harness.calls()).toEqual({ submit: 1, cancel: 1, lookup: 0 })
  })

  test('cancels the exact identified order after its new-exposure risk decision expires', async () => {
    const harness = makeHarness()
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* submit(intentId, 1_000)
          yield* TestClock.adjust(600_000)
          return yield* cancel(intentId, 1_000)
        }),
      ),
    )

    expect(result).toMatchObject({
      eventType: MutationEventType.CancelAccepted,
      brokerOrderId: orderId,
    })
    expect(harness.calls()).toEqual({ submit: 1, cancel: 1, lookup: 0 })
    expect(harness.state()).toBe(IntentState.Acknowledged)
  })

  test('makes no DELETE call when the writer fence is lost after the durable submit', async () => {
    const harness = makeHarness({ lostFenceAfterSubmit: true })
    const failure = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* submit(intentId, 1_000)
          return yield* Effect.flip(cancel(intentId, 1_000))
        }),
      ),
    )

    expect(failure).toBeInstanceOf(WriterFenceError)
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 0 })
    expect(harness.state()).toBe(IntentState.Acknowledged)
  })

  test('rejects cancellation when no durable submitted order exists', async () => {
    const harness = makeHarness()
    const failure = await Effect.runPromise(harness.provide(Effect.flip(cancel(intentId, 1_000))))

    expect(failure).toBeInstanceOf(ExecutionError)
    expect(failure).toMatchObject({
      failure: ExecutionFailure.InvalidState,
      message: 'cancellation requires a positively identified broker order',
    })
    expect(harness.calls()).toEqual({ submit: 0, cancel: 0, lookup: 0 })
    expect(harness.state()).toBe(IntentState.Approved)
  })

  test('rejects cancellation when the durable submit belongs to a different intent identity', async () => {
    const harness = makeHarness()
    const otherIntentId = '0'.repeat(64)
    const failure = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* submit(intentId, 1_000)
          return yield* Effect.flip(cancel(otherIntentId, 1_000))
        }),
      ),
    )

    expect(failure).toBeInstanceOf(ExecutionError)
    expect(failure).toMatchObject({
      failure: ExecutionFailure.IntentNotFound,
      message: `intent ${otherIntentId} does not exist`,
    })
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 0 })
  })
})
