import { cashSpotLimitTimeInForce } from '../execution/order-terms'
import { instrumentMarket } from '../instruments'
import { Result } from 'effect'

import { MutationOperation } from '../broker/alpaca-mutations/model'
import { recordedOrderRequestBody, orderPriceBoundaryMicros } from '../broker/alpaca-mutations/decisions'
import { CycleTerminalReason } from '../cycle/model'
import type { CycleCompletionWaitReason, CycleWaitingDetails } from '../cycle/runner/readiness'
import {
  Authority,
  IntentState,
  OrderStatus,
  OrderType,
  ReconciliationStatus,
  TerminalOutcome,
  type Intent,
  type Order,
  type Position,
} from '../execution/contracts'
import { legacyOrderV2SchemaVersion } from '../execution/legacy-wire'
import { MutationEventType, type MutationEvent } from '../execution/mutations/model'

export const countOpenPositions = (positions: readonly Pick<Position, 'quantityAtoms'>[]): number =>
  positions.filter((position) => BigInt(position.quantityAtoms) !== 0n).length

export interface ExecutionCycleFillInput {
  readonly intents: readonly Pick<Intent, 'intentId' | 'state' | 'terminalOutcome'>[]
  readonly orders?: readonly Pick<Order, 'intentId' | 'filledQuantityAtoms'>[]
}

export const executionCycleHasFilledIntent = (input: ExecutionCycleFillInput): boolean => {
  const { intents, orders = [] } = input
  const intentIds = new Set(intents.map((intent) => intent.intentId))
  return (
    intents.some(
      (intent) => intent.state === IntentState.Terminal && intent.terminalOutcome === TerminalOutcome.Filled,
    ) ||
    orders.some(
      (order) =>
        order.intentId !== undefined && intentIds.has(order.intentId) && BigInt(order.filledQuantityAtoms) > 0n,
    )
  )
}

export type ExecutionIntentTerminalDisposition =
  | 'FILLED'
  | 'BENIGN_ZERO_FILL_LIMIT'
  | 'PARTIAL_FILL_LIMIT'
  | 'UNSUCCESSFUL'

export interface ExecutionIntentTerminalDispositionInput {
  readonly phase: 'ENTRY' | 'CLOSE'
  readonly intent: Pick<
    Intent,
    | 'accountId'
    | 'clientOrderId'
    | 'intentId'
    | 'orderType'
    | 'quantityAtoms'
    | 'side'
    | 'state'
    | 'symbol'
    | 'terminalOutcome'
    | 'timeInForce'
  >
  readonly acceptedBrokerOrderId?: string
  readonly orders: readonly Pick<
    Order,
    | 'accountId'
    | 'brokerOrderId'
    | 'clientOrderId'
    | 'filledQuantityAtoms'
    | 'intentId'
    | 'orderType'
    | 'quantityAtoms'
    | 'side'
    | 'status'
    | 'symbol'
    | 'timeInForce'
  >[]
}

export const decideExecutionIntentTerminalDisposition = (
  input: ExecutionIntentTerminalDispositionInput,
): ExecutionIntentTerminalDisposition => {
  if (input.intent.state !== IntentState.Terminal) return 'UNSUCCESSFUL'
  if (input.intent.terminalOutcome === TerminalOutcome.Filled) return 'FILLED'
  if (
    input.phase !== 'ENTRY' ||
    input.intent.terminalOutcome !== TerminalOutcome.Canceled ||
    input.intent.orderType !== OrderType.Limit ||
    input.intent.timeInForce !== cashSpotLimitTimeInForce(instrumentMarket(input.intent.symbol)) ||
    input.acceptedBrokerOrderId === undefined
  ) {
    return 'UNSUCCESSFUL'
  }
  const matchingOrders = input.orders.filter(
    (order) =>
      order.accountId === input.intent.accountId &&
      order.brokerOrderId === input.acceptedBrokerOrderId &&
      order.clientOrderId === input.intent.clientOrderId &&
      order.intentId === input.intent.intentId &&
      order.symbol === input.intent.symbol &&
      order.side === input.intent.side &&
      order.orderType === input.intent.orderType &&
      order.timeInForce === input.intent.timeInForce &&
      order.quantityAtoms === input.intent.quantityAtoms,
  )
  const order = matchingOrders.length === 1 ? matchingOrders[0] : undefined
  if (order?.status !== OrderStatus.Canceled) return 'UNSUCCESSFUL'
  const filledQuantity = BigInt(order.filledQuantityAtoms)
  if (filledQuantity === 0n) return 'BENIGN_ZERO_FILL_LIMIT'
  return filledQuantity > 0n && filledQuantity < BigInt(input.intent.quantityAtoms)
    ? 'PARTIAL_FILL_LIMIT'
    : 'UNSUCCESSFUL'
}

export type PreparedMutationIntentDecision =
  | { readonly _tag: 'Submit' }
  | { readonly _tag: 'Recover'; readonly eventType: MutationEventType }
  | { readonly _tag: 'Pending'; readonly order: Order }
  | { readonly _tag: 'SkipTerminal' }

export type PreparedMutationIntentDecisionFailure = {
  readonly _tag: 'PreparedMutationIntentDecisionFailure'
  readonly intentId: string
  readonly message: string
  readonly eventType?: MutationEventType
}

export const decidePreparedMutationIntent = (
  intent: Intent,
  latest: MutationEvent | undefined,
): Result.Result<PreparedMutationIntentDecision, PreparedMutationIntentDecisionFailure> => {
  if (intent.state === IntentState.Terminal) return Result.succeed({ _tag: 'SkipTerminal' })
  if (latest === undefined) return Result.succeed({ _tag: 'Submit' })
  switch (latest.eventType) {
    case MutationEventType.SubmitAccepted:
    case MutationEventType.RecoveryFound: {
      if (latest.brokerOrderId === undefined) {
        return Result.fail({
          _tag: 'PreparedMutationIntentDecisionFailure',
          intentId: intent.intentId,
          eventType: latest.eventType,
          message: 'accepted nonterminal submit lacks a durable broker order identity',
        })
      }
      const representation = recordedOrderRequestBody(intent, latest.requestHash)
      if (Result.isFailure(representation)) {
        return Result.fail({
          _tag: 'PreparedMutationIntentDecisionFailure',
          intentId: intent.intentId,
          eventType: latest.eventType,
          message: `accepted submit has no supported immutable broker representation: ${representation.failure.message}`,
        })
      }
      const request = representation.success
      const orderRepresentation = { quantityAtoms: intent.quantityAtoms }
      const limitPrice = 'limit_price' in request ? orderPriceBoundaryMicros(intent) : Result.succeed(undefined)
      if (Result.isFailure(limitPrice)) {
        return Result.fail({
          _tag: 'PreparedMutationIntentDecisionFailure',
          intentId: intent.intentId,
          eventType: latest.eventType,
          message: `accepted submit has no valid immutable limit price: ${limitPrice.failure.message}`,
        })
      }
      return Result.succeed({
        _tag: 'Pending',
        order: {
          schemaVersion: legacyOrderV2SchemaVersion,
          accountId: intent.accountId,
          brokerOrderId: latest.brokerOrderId,
          clientOrderId: intent.clientOrderId,
          intentId: intent.intentId,
          symbol: intent.symbol,
          side: intent.side,
          orderType: 'limit_price' in request ? OrderType.Limit : OrderType.Market,
          timeInForce: intent.timeInForce,
          ...orderRepresentation,
          filledQuantityAtoms: '0',
          ...(limitPrice.success === undefined ? {} : { limitPriceMicros: limitPrice.success.toString() }),
          status: OrderStatus.New,
          observedAt: latest.occurredAt,
        },
      })
    }
    case MutationEventType.SubmitRejected:
    case MutationEventType.SubmitDenied:
      return Result.fail({
        _tag: 'PreparedMutationIntentDecisionFailure',
        intentId: intent.intentId,
        eventType: latest.eventType,
        message: 'terminal submit event does not match the nonterminal durable intent state',
      })
    case MutationEventType.SubmitStarted:
    case MutationEventType.SubmitUnknown:
    case MutationEventType.RecoveryNotFound:
    case MutationEventType.RecoveryUnknown:
    case MutationEventType.CancelStarted:
    case MutationEventType.CancelAccepted:
    case MutationEventType.CancelUnknown:
      return Result.succeed({ _tag: 'Recover', eventType: latest.eventType })
  }
}

export type PendingMutationObservationDecision =
  | { readonly _tag: 'StableOpen'; readonly order: Order }
  | { readonly _tag: 'Recover'; readonly reason: 'missing' | 'terminal'; readonly order?: Order }

const terminalOrderStatuses = new Set<OrderStatus>([
  OrderStatus.Filled,
  OrderStatus.Canceled,
  OrderStatus.Expired,
  OrderStatus.Rejected,
])

const pendingOrderIdentityMatches = (expected: Order, observed: Order): boolean =>
  observed.accountId === expected.accountId &&
  observed.brokerOrderId === expected.brokerOrderId &&
  observed.clientOrderId === expected.clientOrderId &&
  (observed.intentId === undefined || observed.intentId === expected.intentId) &&
  observed.symbol === expected.symbol &&
  observed.side === expected.side &&
  observed.orderType === expected.orderType &&
  observed.timeInForce === expected.timeInForce &&
  observed.quantityAtoms === expected.quantityAtoms &&
  observed.notionalMicros === expected.notionalMicros &&
  observed.limitPriceMicros === expected.limitPriceMicros

export const decidePendingMutationObservation = (
  expected: Order,
  observedOrders: readonly Order[],
): Result.Result<PendingMutationObservationDecision, PreparedMutationIntentDecisionFailure> => {
  const candidates = observedOrders.filter(
    (order) => order.brokerOrderId === expected.brokerOrderId || order.clientOrderId === expected.clientOrderId,
  )
  if (candidates.length === 0) return Result.succeed({ _tag: 'Recover', reason: 'missing' })
  if (candidates.length !== 1) {
    return Result.fail({
      _tag: 'PreparedMutationIntentDecisionFailure',
      intentId: expected.intentId ?? '<missing>',
      message: 'reconciliation returned multiple orders for one acknowledged execution intent',
    })
  }
  const observed = candidates[0]
  if (observed === undefined || !pendingOrderIdentityMatches(expected, observed)) {
    return Result.fail({
      _tag: 'PreparedMutationIntentDecisionFailure',
      intentId: expected.intentId ?? '<missing>',
      message: 'reconciled broker order conflicts with the acknowledged execution intent identity',
    })
  }
  return terminalOrderStatuses.has(observed.status)
    ? Result.succeed({ _tag: 'Recover', reason: 'terminal', order: observed })
    : Result.succeed({ _tag: 'StableOpen', order: observed })
}

export type PreparedMutationIntentAdmissionFailure = {
  readonly _tag: 'PreparedMutationIntentAdmissionFailure'
  readonly reason:
    | 'accounting-inexact'
    | 'authority'
    | 'expiry'
    | 'reconciliation-not-exact'
    | 'unknown-mutation'
    | 'unknown-order'
  readonly message: string
}

export const decidePreparedMutationIntentAdmission = (
  prepared: PreparedMutationIntentDecision,
  effectiveAuthority: Authority,
  observedAt: string,
  expiresAt: string,
  unknownMutationCount: number,
  reconciliationStatus: ReconciliationStatus = ReconciliationStatus.Exact,
  accountingExact = true,
  unknownOrderCount = 0,
): Result.Result<void, PreparedMutationIntentAdmissionFailure> => {
  if (prepared._tag !== 'Submit') return Result.succeed(undefined)
  if (effectiveAuthority !== Authority.Execution) {
    return Result.fail({
      _tag: 'PreparedMutationIntentAdmissionFailure',
      reason: 'authority',
      message: 'fresh broker submit requires current effective execution authority',
    })
  }
  if (observedAt >= expiresAt) {
    return Result.fail({
      _tag: 'PreparedMutationIntentAdmissionFailure',
      reason: 'expiry',
      message: 'fresh broker submit is forbidden at or after decision expiry',
    })
  }
  if (reconciliationStatus !== ReconciliationStatus.Exact) {
    return Result.fail({
      _tag: 'PreparedMutationIntentAdmissionFailure',
      reason: 'reconciliation-not-exact',
      message: 'fresh broker submit requires exact same-pass reconciliation',
    })
  }
  if (!accountingExact) {
    return Result.fail({
      _tag: 'PreparedMutationIntentAdmissionFailure',
      reason: 'accounting-inexact',
      message: 'fresh broker submit requires exact same-pass accounting',
    })
  }
  if (unknownMutationCount !== 0) {
    return Result.fail({
      _tag: 'PreparedMutationIntentAdmissionFailure',
      reason: 'unknown-mutation',
      message: 'fresh broker submit is forbidden while a mutation outcome is unknown',
    })
  }
  if (unknownOrderCount !== 0) {
    return Result.fail({
      _tag: 'PreparedMutationIntentAdmissionFailure',
      reason: 'unknown-order',
      message: 'fresh broker submit is forbidden while a broker order is unknown',
    })
  }
  return Result.succeed(undefined)
}

export const decidePreparedCloseIntentAdmission = (
  prepared: PreparedMutationIntentDecision,
  observedAt: string,
  expiresAt: string,
  unknownMutationCount: number,
  reconciliationStatus: ReconciliationStatus = ReconciliationStatus.Exact,
  accountingExact = true,
  unknownOrderCount = 0,
): Result.Result<void, PreparedMutationIntentAdmissionFailure> => {
  if (prepared._tag !== 'Submit') return Result.succeed(undefined)
  if (observedAt >= expiresAt) {
    return Result.fail({
      _tag: 'PreparedMutationIntentAdmissionFailure',
      reason: 'expiry',
      message: 'close-only broker submit is forbidden after the bounded close lease',
    })
  }
  if (reconciliationStatus !== ReconciliationStatus.Exact) {
    return Result.fail({
      _tag: 'PreparedMutationIntentAdmissionFailure',
      reason: 'reconciliation-not-exact',
      message: 'close-only broker submit requires exact same-pass reconciliation',
    })
  }
  if (!accountingExact) {
    return Result.fail({
      _tag: 'PreparedMutationIntentAdmissionFailure',
      reason: 'accounting-inexact',
      message: 'close-only broker submit requires exact same-pass accounting',
    })
  }
  if (unknownMutationCount !== 0) {
    return Result.fail({
      _tag: 'PreparedMutationIntentAdmissionFailure',
      reason: 'unknown-mutation',
      message: 'close-only broker submit is forbidden while a mutation outcome is unknown',
    })
  }
  if (unknownOrderCount !== 0) {
    return Result.fail({
      _tag: 'PreparedMutationIntentAdmissionFailure',
      reason: 'unknown-order',
      message: 'close-only broker submit is forbidden while a broker order is unknown',
    })
  }
  return Result.succeed(undefined)
}

export interface ExecutionCycleIntentTerminalEvidence {
  readonly state: IntentState
  readonly terminalOutcome?: TerminalOutcome
  readonly updatedAt: string
  readonly latestMutationAt?: string
  readonly terminalDisposition?: ExecutionIntentTerminalDisposition
}

export interface ExecutionCycleReconciliationEvidence {
  readonly status: ReconciliationStatus
  readonly reconciledAt: string
  readonly accountingExact: boolean
  readonly unknownMutationCount: number
  readonly unknownOrderCount: number
  readonly openPositionCount: number
}

export type ExecutionPhaseCompletionDecision =
  | { readonly _tag: 'Complete' }
  | {
      readonly _tag: 'Wait'
      readonly reason: CycleCompletionWaitReason
    }

export const decideExecutionPhaseCompletion = (
  phase: 'ENTRY' | 'CLOSE',
  documentCreatedAt: string,
  intents: readonly ExecutionCycleIntentTerminalEvidence[],
  reconciliation: ExecutionCycleReconciliationEvidence,
): ExecutionPhaseCompletionDecision => {
  if (intents.some((intent) => intent.state !== IntentState.Terminal)) {
    return { _tag: 'Wait', reason: 'intent-nonterminal' }
  }
  if (
    intents.some(
      (intent) =>
        intent.terminalOutcome !== TerminalOutcome.Filled &&
        !(
          phase === 'ENTRY' &&
          (intent.terminalDisposition === 'BENIGN_ZERO_FILL_LIMIT' ||
            intent.terminalDisposition === 'PARTIAL_FILL_LIMIT')
        ),
    )
  ) {
    return { _tag: 'Wait', reason: 'intent-unsuccessful' }
  }
  if (reconciliation.status !== ReconciliationStatus.Exact) {
    return { _tag: 'Wait', reason: 'reconciliation-not-exact' }
  }
  if (!reconciliation.accountingExact) return { _tag: 'Wait', reason: 'accounting-inexact' }
  if (reconciliation.unknownMutationCount !== 0) return { _tag: 'Wait', reason: 'unknown-mutation' }
  if (reconciliation.unknownOrderCount !== 0) return { _tag: 'Wait', reason: 'unknown-order' }
  const latestEvidenceAt = Math.max(
    Date.parse(documentCreatedAt),
    ...intents.flatMap((intent) => [
      Date.parse(intent.updatedAt),
      Date.parse(intent.latestMutationAt ?? intent.updatedAt),
    ]),
  )
  if (Date.parse(reconciliation.reconciledAt) <= latestEvidenceAt) {
    return { _tag: 'Wait', reason: 'reconciliation-not-later' }
  }
  if (phase === 'CLOSE' && reconciliation.openPositionCount !== 0) return { _tag: 'Wait', reason: 'open-position' }
  return { _tag: 'Complete' }
}

export type PreparedMutationRecoveryDecision =
  | { readonly _tag: 'NoRecovery' }
  | { readonly _tag: 'ObservePending'; readonly event: MutationEvent }
  | {
      readonly _tag: 'Recover'
      readonly operation: MutationOperation
      readonly event: MutationEvent
    }

export const decidePreparedMutationRecovery = (
  intent: Intent,
  latestSubmit: MutationEvent | undefined,
  latestCancel: MutationEvent | undefined,
): Result.Result<PreparedMutationRecoveryDecision, PreparedMutationIntentDecisionFailure> => {
  if (latestCancel !== undefined) {
    if (latestCancel.operation !== MutationOperation.Cancel) {
      return Result.fail({
        _tag: 'PreparedMutationIntentDecisionFailure',
        intentId: intent.intentId,
        eventType: latestCancel.eventType,
        message: 'durable cancellation recovery read returned a non-cancel mutation',
      })
    }
    return intent.state === IntentState.Terminal && latestCancel.eventType === MutationEventType.RecoveryFound
      ? Result.succeed({ _tag: 'NoRecovery' })
      : Result.succeed({ _tag: 'Recover', operation: MutationOperation.Cancel, event: latestCancel })
  }
  if (latestSubmit === undefined) return Result.succeed({ _tag: 'NoRecovery' })
  if (latestSubmit.operation !== MutationOperation.Submit) {
    return Result.fail({
      _tag: 'PreparedMutationIntentDecisionFailure',
      intentId: intent.intentId,
      eventType: latestSubmit.eventType,
      message: 'durable submit recovery read returned a non-submit mutation',
    })
  }
  if (
    intent.state === IntentState.Terminal &&
    (latestSubmit.eventType === MutationEventType.SubmitAccepted ||
      latestSubmit.eventType === MutationEventType.SubmitRejected ||
      latestSubmit.eventType === MutationEventType.SubmitDenied ||
      latestSubmit.eventType === MutationEventType.RecoveryFound)
  ) {
    return Result.succeed({ _tag: 'NoRecovery' })
  }
  if (
    intent.state !== IntentState.Terminal &&
    (latestSubmit.eventType === MutationEventType.SubmitRejected ||
      latestSubmit.eventType === MutationEventType.SubmitDenied)
  ) {
    return Result.fail({
      _tag: 'PreparedMutationIntentDecisionFailure',
      intentId: intent.intentId,
      eventType: latestSubmit.eventType,
      message: 'terminal submit event does not match the nonterminal durable intent state',
    })
  }
  if (
    intent.state !== IntentState.Terminal &&
    (latestSubmit.eventType === MutationEventType.SubmitAccepted ||
      latestSubmit.eventType === MutationEventType.RecoveryFound)
  ) {
    return latestSubmit.brokerOrderId === undefined
      ? Result.fail({
          _tag: 'PreparedMutationIntentDecisionFailure',
          intentId: intent.intentId,
          eventType: latestSubmit.eventType,
          message: 'accepted nonterminal submit lacks a durable broker order identity',
        })
      : Result.succeed({ _tag: 'ObservePending', event: latestSubmit })
  }
  return Result.succeed({ _tag: 'Recover', operation: MutationOperation.Submit, event: latestSubmit })
}

export type PreparedMutationCycleStep =
  | { readonly _tag: 'RunCycle' }
  | {
      readonly _tag: 'Execute'
      readonly action: 'CANCEL' | 'RECOVER_SUBMIT' | 'RECOVER_CANCEL'
      readonly intentId: string
      readonly observedAt: string
    }
  | {
      readonly _tag: 'Execute'
      readonly action: 'SUBMIT'
      readonly intentId: string
      readonly observedAt: string
      readonly submitExpiresAt: string
    }
  | {
      readonly _tag: 'Block'
      readonly reason:
        | CycleTerminalReason.MissedSubmission
        | CycleTerminalReason.ProvenanceMismatch
        | CycleTerminalReason.Risk
      readonly observedAt: string
    }
  | ({ readonly _tag: 'Wait'; readonly observedAt: string } & CycleWaitingDetails)
  | { readonly _tag: 'Complete'; readonly observedAt: string }

export type BoundMutationCycleOutcome = Exclude<PreparedMutationCycleStep, { readonly _tag: 'Execute' }>

export const mutationRecoveryIsDue = (event: MutationEvent, observedAt: string): boolean =>
  Date.parse(observedAt) >= Date.parse(event.occurredAt) + event.consistencyDelayMs

export const executionSubmitExpiresAt = (documentExpiresAt: string, riskDecisionExpiresAt: string): string =>
  riskDecisionExpiresAt < documentExpiresAt ? riskDecisionExpiresAt : documentExpiresAt

export const expiredExecutionPlanTerminalReason = (
  observedAt: string,
  submitExpiresAt: string,
  submissionCutoffAt: string,
): CycleTerminalReason.MissedSubmission | CycleTerminalReason.Risk | undefined =>
  observedAt < submitExpiresAt
    ? undefined
    : observedAt >= submissionCutoffAt
      ? CycleTerminalReason.MissedSubmission
      : CycleTerminalReason.Risk

export type MutationIntentSettlementDecision =
  | {
      readonly _tag: 'Settled'
      readonly outcome: 'accepted' | 'rejected' | 'denied'
    }
  | {
      readonly _tag: 'Unresolved'
      readonly eventType: MutationEventType
    }

export const decideMutationIntentSettlement = (eventType: MutationEventType): MutationIntentSettlementDecision => {
  switch (eventType) {
    case MutationEventType.SubmitAccepted:
    case MutationEventType.CancelAccepted:
    case MutationEventType.RecoveryFound:
      return { _tag: 'Settled', outcome: 'accepted' }
    case MutationEventType.SubmitRejected:
      return { _tag: 'Settled', outcome: 'rejected' }
    case MutationEventType.SubmitDenied:
      return { _tag: 'Settled', outcome: 'denied' }
    default:
      return { _tag: 'Unresolved', eventType }
  }
}

export interface MutationIntentExecutionResult {
  readonly settlement: Extract<MutationIntentSettlementDecision, { readonly _tag: 'Settled' }>
  readonly consistencyDelayMs: number
  readonly operation: MutationOperation
  readonly mutationAdvanced: boolean
}

export const mutationIntentReconciliationDelayMs = (result: MutationIntentExecutionResult): number =>
  result.mutationAdvanced && result.settlement.outcome === 'accepted' ? result.consistencyDelayMs : 0
