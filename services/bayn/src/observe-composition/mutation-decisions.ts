import { Result } from 'effect'

import {
  MutationOperation,
  compatibleOrderRequestBody,
  orderPriceBoundaryMicros,
  orderRequestNotionalMicros,
} from '../broker/alpaca-mutations'
import { CycleTerminalReason } from '../cycle'
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
import { legacyOrderV2SchemaVersion, legacyPositionSchemaVersion } from '../execution/legacy-wire'
import { MutationEventType, type MutationEvent } from '../execution/mutations'
import type { PlannedTargetQuantity } from '../target-planner'
import { Pipeable } from '../pipeable'

const quantityScale = 1_000_000n

export const countOpenPositions = (positions: readonly Pick<Position, 'quantityMicros'>[]): number =>
  positions.filter((position) => BigInt(position.quantityMicros) !== 0n).length

export interface ExecutionCycleFillInput {
  readonly intents: readonly Pick<Intent, 'intentId' | 'state' | 'terminalOutcome'>[]
  readonly orders?: readonly Pick<Order, 'intentId' | 'filledQuantityMicros'>[]
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
        order.intentId !== undefined && intentIds.has(order.intentId) && BigInt(order.filledQuantityMicros) > 0n,
    )
  )
}

const executionClosePlanNeedsResidualReplanDataFirst = (
  intents: readonly Pick<Intent, 'state'>[],
  openPositionCount: number,
): boolean =>
  intents.length > 0 && intents.every((intent) => intent.state === IntentState.Terminal) && openPositionCount > 0

/** A settled close plan must be replaced when authoritative positions remain open. */
export const executionClosePlanNeedsResidualReplan = Pipeable.dual(2, executionClosePlanNeedsResidualReplanDataFirst)

const comparePositionSymbol = (left: Position, right: Position): number =>
  left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0

const divideAwayFromZero = (numerator: bigint): bigint => {
  const magnitude = numerator < 0n ? -numerator : numerator
  const rounded = magnitude === 0n ? 0n : (magnitude + quantityScale - 1n) / quantityScale
  return numerator < 0n ? -rounded : rounded
}

const projectMutationPosition = (
  positions: readonly Position[],
  target: PlannedTargetQuantity,
  accountId: string,
  observedAt: string,
): readonly Position[] => {
  const retained = positions.filter((position) => position.symbol !== target.symbol)
  const quantity = BigInt(target.targetQuantityMicros)
  if (quantity === 0n) return retained
  const previous = positions.find((position) => position.symbol === target.symbol)
  const referencePrice = BigInt(target.referencePriceMicros)
  const averageEntryPrice = BigInt(previous?.averageEntryPriceMicros ?? target.referencePriceMicros)
  const projected: Position = {
    schemaVersion: legacyPositionSchemaVersion,
    accountId: previous?.accountId ?? accountId,
    symbol: target.symbol,
    quantityMicros: target.targetQuantityMicros,
    averageEntryPriceMicros: averageEntryPrice.toString(),
    marketPriceMicros: target.referencePriceMicros,
    marketValueMicros: divideAwayFromZero(quantity * referencePrice).toString(),
    unrealizedPnlMicros: divideAwayFromZero(quantity * (referencePrice - averageEntryPrice)).toString(),
    observedAt: previous?.observedAt ?? observedAt,
  }
  return [...retained, projected].sort(comparePositionSymbol)
}

const projectWorstCasePendingMutationPositionDataFirst = (
  positions: readonly Position[],
  target: PlannedTargetQuantity,
  accountId: string,
  observedAt: string,
): readonly Position[] => {
  const current = positions.find((position) => position.symbol === target.symbol)
  const currentQuantity = current === undefined ? 0n : BigInt(current.quantityMicros)
  const targetQuantity = BigInt(target.targetQuantityMicros)
  return targetQuantity <= currentQuantity
    ? positions
    : projectMutationPosition(positions, target, accountId, observedAt)
}

export const projectWorstCasePendingMutationPosition = Pipeable.dual(
  4,
  projectWorstCasePendingMutationPositionDataFirst,
)

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

const decidePreparedMutationIntentDataFirst = (
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
      const representation = compatibleOrderRequestBody(intent, latest.requestHash)
      if (Result.isFailure(representation)) {
        return Result.fail({
          _tag: 'PreparedMutationIntentDecisionFailure',
          intentId: intent.intentId,
          eventType: latest.eventType,
          message: `accepted submit has no supported immutable broker representation: ${representation.failure.message}`,
        })
      }
      const request = representation.success
      const requestNotionalMicros = orderRequestNotionalMicros(request)
      if ('notional' in request && requestNotionalMicros === undefined) {
        return Result.fail({
          _tag: 'PreparedMutationIntentDecisionFailure',
          intentId: intent.intentId,
          eventType: latest.eventType,
          message: 'accepted submit has an invalid immutable notional representation',
        })
      }
      const orderRepresentation =
        requestNotionalMicros === undefined
          ? { quantityMicros: intent.quantityMicros }
          : { notionalMicros: requestNotionalMicros }
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
          filledQuantityMicros: '0',
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

export const decidePreparedMutationIntent = Pipeable.dual(2, decidePreparedMutationIntentDataFirst)

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
  observed.quantityMicros === expected.quantityMicros &&
  observed.notionalMicros === expected.notionalMicros &&
  observed.limitPriceMicros === expected.limitPriceMicros

const decidePendingMutationObservationDataFirst = (
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

export const decidePendingMutationObservation = Pipeable.dual(2, decidePendingMutationObservationDataFirst)

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

const decidePreparedMutationIntentAdmissionDataFirst = (
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

export const decidePreparedMutationIntentAdmission = Pipeable.by<
  (
    effectiveAuthority: Authority,
    observedAt: string,
    expiresAt: string,
    unknownMutationCount: number,
    reconciliationStatus?: ReconciliationStatus,
    accountingExact?: boolean,
    unknownOrderCount?: number,
  ) => (prepared: PreparedMutationIntentDecision) => ReturnType<typeof decidePreparedMutationIntentAdmissionDataFirst>,
  typeof decidePreparedMutationIntentAdmissionDataFirst
>(
  (arguments_) => typeof arguments_[0] === 'object' && arguments_[0] !== null,
  decidePreparedMutationIntentAdmissionDataFirst,
)

const decidePreparedCloseIntentAdmissionDataFirst = (
  intent: Pick<Intent, 'side'>,
  prepared: PreparedMutationIntentDecision,
  observedAt: string,
  expiresAt: string,
  unknownMutationCount: number,
  reconciliationStatus: ReconciliationStatus = ReconciliationStatus.Exact,
  accountingExact = true,
  unknownOrderCount = 0,
): Result.Result<void, PreparedMutationIntentAdmissionFailure> => {
  if (prepared._tag !== 'Submit') return Result.succeed(undefined)
  if (intent.side !== 'SELL') {
    return Result.fail({
      _tag: 'PreparedMutationIntentAdmissionFailure',
      reason: 'authority',
      message: 'close-only execution admission permits sell intents only',
    })
  }
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

export const decidePreparedCloseIntentAdmission = Pipeable.by<
  (
    prepared: PreparedMutationIntentDecision,
    observedAt: string,
    expiresAt: string,
    unknownMutationCount: number,
    reconciliationStatus?: ReconciliationStatus,
    accountingExact?: boolean,
    unknownOrderCount?: number,
  ) => (intent: Pick<Intent, 'side'>) => ReturnType<typeof decidePreparedCloseIntentAdmissionDataFirst>,
  typeof decidePreparedCloseIntentAdmissionDataFirst
>(
  (arguments_) => typeof arguments_[0] === 'object' && arguments_[0] !== null && 'side' in arguments_[0],
  decidePreparedCloseIntentAdmissionDataFirst,
)

const appendPendingMutationOrderDataFirst = (orders: readonly Order[], pending: Order): readonly Order[] =>
  orders.some((order) => order.brokerOrderId === pending.brokerOrderId || order.clientOrderId === pending.clientOrderId)
    ? orders
    : [...orders, pending]

export const appendPendingMutationOrder = Pipeable.dual(2, appendPendingMutationOrderDataFirst)

export interface ExecutionCycleIntentTerminalEvidence {
  readonly state: IntentState
  readonly terminalOutcome?: TerminalOutcome
  readonly updatedAt: string
  readonly latestMutationAt?: string
}

export interface ExecutionCycleReconciliationEvidence {
  readonly status: ReconciliationStatus
  readonly reconciledAt: string
  readonly accountingExact: boolean
  readonly unknownMutationCount: number
  readonly unknownOrderCount: number
  readonly openPositionCount?: number
}

export type ExecutionCycleCompletionDecision =
  | { readonly _tag: 'Complete' }
  | {
      readonly _tag: 'Wait'
      readonly reason:
        | 'accounting-inexact'
        | 'intent-nonterminal'
        | 'intent-unsuccessful'
        | 'reconciliation-not-later'
        | 'reconciliation-not-exact'
        | 'unknown-mutation'
        | 'unknown-order'
        | 'open-position'
    }

const decideExecutionCycleCompletionDataFirst = (
  documentCreatedAt: string,
  intents: readonly ExecutionCycleIntentTerminalEvidence[],
  reconciliation: ExecutionCycleReconciliationEvidence,
): ExecutionCycleCompletionDecision => {
  if (intents.some((intent) => intent.state !== IntentState.Terminal)) {
    return { _tag: 'Wait', reason: 'intent-nonterminal' }
  }
  if (intents.some((intent) => intent.terminalOutcome !== TerminalOutcome.Filled)) {
    return { _tag: 'Wait', reason: 'intent-unsuccessful' }
  }
  if (reconciliation.status !== ReconciliationStatus.Exact) {
    return { _tag: 'Wait', reason: 'reconciliation-not-exact' }
  }
  if (!reconciliation.accountingExact) return { _tag: 'Wait', reason: 'accounting-inexact' }
  if (reconciliation.unknownMutationCount !== 0) return { _tag: 'Wait', reason: 'unknown-mutation' }
  if (reconciliation.unknownOrderCount !== 0) return { _tag: 'Wait', reason: 'unknown-order' }
  if ((reconciliation.openPositionCount ?? 0) !== 0) return { _tag: 'Wait', reason: 'open-position' }
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
  return { _tag: 'Complete' }
}

export const decideExecutionCycleCompletion = Pipeable.dual(3, decideExecutionCycleCompletionDataFirst)

export type PreparedMutationRecoveryDecision =
  | { readonly _tag: 'NoRecovery' }
  | { readonly _tag: 'ObservePending'; readonly event: MutationEvent }
  | {
      readonly _tag: 'Recover'
      readonly operation: MutationOperation
      readonly event: MutationEvent
    }

const decidePreparedMutationRecoveryDataFirst = (
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

export const decidePreparedMutationRecovery = Pipeable.dual(3, decidePreparedMutationRecoveryDataFirst)

export type PreparedMutationCycleStep =
  | { readonly _tag: 'RunCycle' }
  | {
      readonly _tag: 'Execute'
      readonly action: 'RECOVER_SUBMIT' | 'RECOVER_CANCEL'
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
  | { readonly _tag: 'Wait'; readonly observedAt: string }
  | { readonly _tag: 'Complete'; readonly observedAt: string }

export type BoundMutationCycleOutcome = Exclude<PreparedMutationCycleStep, { readonly _tag: 'Execute' }>

const mutationRecoveryIsDueDataFirst = (event: MutationEvent, observedAt: string): boolean =>
  Date.parse(observedAt) >= Date.parse(event.occurredAt) + event.consistencyDelayMs

export const mutationRecoveryIsDue = Pipeable.dual(2, mutationRecoveryIsDueDataFirst)

const executionSubmitExpiresAtDataFirst = (documentExpiresAt: string, riskDecisionExpiresAt: string): string =>
  riskDecisionExpiresAt < documentExpiresAt ? riskDecisionExpiresAt : documentExpiresAt

export const executionSubmitExpiresAt = Pipeable.dual(2, executionSubmitExpiresAtDataFirst)

const expiredExecutionPlanTerminalReasonDataFirst = (
  observedAt: string,
  submitExpiresAt: string,
  submissionCutoffAt: string,
): CycleTerminalReason.MissedSubmission | CycleTerminalReason.Risk | undefined =>
  observedAt < submitExpiresAt
    ? undefined
    : observedAt >= submissionCutoffAt
      ? CycleTerminalReason.MissedSubmission
      : CycleTerminalReason.Risk

export const expiredExecutionPlanTerminalReason = Pipeable.dual(3, expiredExecutionPlanTerminalReasonDataFirst)

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
