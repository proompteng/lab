import { Result, Schema } from 'effect'

import { sha256 } from '../hash'
import { quantityFromDecimal } from '../quantity'
import { Sha256Schema, UtcInstantSchema } from '../schemas'
import type { IntentBinding } from '../db/intent-bindings'
import { isBracketProtection, isEquityShortProtection, isStopProtection, type Order } from '../execution/contracts'
import { fillObservation, orderObservation, type BrokerEventInput, type FillEventInput } from './observations'
import { fillActivityIdentity } from './activities'
import { OrderResponseSchema, OrderSide, U128_MAX, responseParseOptions } from './alpaca/model'
import { normalizeOrderResult } from './alpaca/normalizers'
import type { BrokerNotification } from './notifications'

type OrderEventInput = Extract<BrokerEventInput, { readonly _tag: 'Order' }>

const TradeUpdateFrameSchema = Schema.fromJsonString(
  Schema.Struct({
    stream: Schema.Literal('trade_updates'),
    data: Schema.Struct({
      event: Schema.NonEmptyString,
      timestamp: Schema.NonEmptyString,
      order: Schema.Struct({
        ...OrderResponseSchema.fields,
        group_id: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isUUID()))),
        group_role: Schema.optionalKey(Schema.NullOr(Schema.Literals(['entry', 'take_profit', 'stop_loss']))),
      }),
      execution_id: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
      price: Schema.optionalKey(Schema.NonEmptyString),
      qty: Schema.optionalKey(Schema.NonEmptyString),
    }),
  }),
)

const projectedEvents = new Set([
  'held',
  'accepted',
  'new',
  'fill',
  'partial_fill',
  'canceled',
  'expired',
  'done_for_day',
  'replaced',
  'rejected',
  'pending_new',
  'stopped',
  'pending_cancel',
  'pending_replace',
  'calculated',
  'suspended',
  'order_replace_rejected',
  'order_cancel_rejected',
])

export enum BrokerStreamReconciliationReason {
  LegacyReceipt = 'LEGACY_RECEIPT',
  SessionBoundary = 'SESSION_BOUNDARY',
  UnresolvedGap = 'UNRESOLVED_GAP',
  InvalidFrame = 'INVALID_FRAME',
  UnsupportedEvent = 'UNSUPPORTED_EVENT',
  MissingIntent = 'MISSING_INTENT',
  InvalidOrder = 'INVALID_ORDER',
  InvalidFill = 'INVALID_FILL',
  ProjectionConflict = 'PROJECTION_CONFLICT',
}

export const BrokerSourceProjectionReceiptSchema = Schema.TaggedUnion({
  CanonicallyCovered: {
    eventId: Sha256Schema,
    observedAt: UtcInstantSchema,
  },
  Projected: {
    eventId: Sha256Schema,
    observedAt: UtcInstantSchema,
    orderEventId: Sha256Schema,
    fillEventId: Schema.optionalKey(Sha256Schema),
  },
  ReconcileRequired: {
    eventId: Sha256Schema,
    observedAt: UtcInstantSchema,
    reason: Schema.Enum(BrokerStreamReconciliationReason),
  },
})
export type BrokerSourceProjectionReceipt = typeof BrokerSourceProjectionReceiptSchema.Type

export type BrokerSourceProjectionAttempt =
  | BrokerSourceProjectionReceipt
  | {
      readonly _tag: 'AwaitingProtection'
      readonly eventId: string
      readonly observedAt: string
      readonly deadlineAt: string
    }

export type BrokerTradeUpdateProjection =
  | {
      readonly _tag: 'ProtectionBindingRequired'
      readonly eventId: string
      readonly observedAt: string
      readonly brokerOrderId: string
      readonly clientOrderId: string
      readonly canWait: boolean
    }
  | {
      readonly _tag: 'ReconcileRequired'
      readonly eventId: string
      readonly observedAt: string
      readonly reason: BrokerStreamReconciliationReason
    }
  | {
      readonly _tag: 'Project'
      readonly eventId: string
      readonly observedAt: string
      readonly brokerEvent: string
      readonly order: OrderEventInput
      readonly fill?: FillEventInput
    }

const reconcile = (
  notification: BrokerNotification,
  reason: BrokerStreamReconciliationReason,
): BrokerTradeUpdateProjection => ({
  _tag: 'ReconcileRequired',
  eventId: notification.eventId,
  observedAt: notification.receivedAt,
  reason,
})

export const projectBrokerTradeUpdate = (
  notification: BrokerNotification,
  bindings: readonly IntentBinding[],
  protectionOrder?: Order,
): BrokerTradeUpdateProjection => {
  if (notification._tag === 'SessionReady')
    return reconcile(notification, BrokerStreamReconciliationReason.SessionBoundary)
  const decoded = Schema.decodeUnknownResult(TradeUpdateFrameSchema, responseParseOptions)(notification.frameJson)
  if (Result.isFailure(decoded)) return reconcile(notification, BrokerStreamReconciliationReason.InvalidFrame)
  const { data } = decoded.success
  if (!projectedEvents.has(data.event))
    return reconcile(notification, BrokerStreamReconciliationReason.UnsupportedEvent)
  const normalizedOrder = normalizeOrderResult(data.order, notification.session.accountId, notification.receivedAt)
  if (Result.isFailure(normalizedOrder)) return reconcile(notification, BrokerStreamReconciliationReason.InvalidOrder)
  const nativeOrder = normalizedOrder.success
  if (
    (data.event === 'held' || data.event === 'accepted') &&
    (nativeOrder.status !== data.event ||
      nativeOrder.filledQuantityAtoms !== '0' ||
      nativeOrder.filledAt !== undefined ||
      nativeOrder.filledAveragePriceMicros !== undefined ||
      data.execution_id !== undefined ||
      data.price !== undefined ||
      data.qty !== undefined)
  )
    return reconcile(notification, BrokerStreamReconciliationReason.InvalidOrder)
  const evidence = {
    status: 200,
    requestId: notification.eventId,
    contentHash: sha256(notification.frameJson),
    observedAt: notification.receivedAt,
  }
  const unboundOrder = orderObservation(nativeOrder, evidence)
  if (Result.isFailure(unboundOrder) || unboundOrder.success._tag !== 'Order')
    return reconcile(notification, BrokerStreamReconciliationReason.InvalidOrder)
  const matchingBindings = bindings.filter((binding) => binding.clientOrderId === data.order.client_order_id)
  let binding = matchingBindings.length === 1 ? matchingBindings[0] : undefined
  let parentBrokerOrderId: string | undefined
  if (binding === undefined) {
    if (matchingBindings.length !== 0) return reconcile(notification, BrokerStreamReconciliationReason.MissingIntent)
    const role = data.order.group_role
    if (
      data.order.group_id == null ||
      (role !== 'take_profit' && role !== 'stop_loss') ||
      (nativeOrder.orderClass !== 'bracket' && nativeOrder.orderClass !== 'oco') ||
      nativeOrder.legs !== undefined ||
      nativeOrder.notionalMicros !== undefined ||
      nativeOrder.extendedHours ||
      nativeOrder.timeInForce !== 'day' ||
      nativeOrder.orderType !== (role === 'stop_loss' ? 'stop_limit' : 'limit')
    )
      return reconcile(notification, BrokerStreamReconciliationReason.MissingIntent)
    if (protectionOrder === undefined)
      return {
        _tag: 'ProtectionBindingRequired',
        eventId: notification.eventId,
        observedAt: notification.receivedAt,
        brokerOrderId: nativeOrder.brokerOrderId,
        clientOrderId: nativeOrder.clientOrderId,
        canWait:
          (data.event === 'held' || data.event === 'accepted') &&
          nativeOrder.filledQuantityAtoms === '0' &&
          nativeOrder.filledAt === undefined &&
          nativeOrder.filledAveragePriceMicros === undefined &&
          data.execution_id === undefined &&
          data.price === undefined &&
          data.qty === undefined,
      }
    const inherited = bindings.filter((candidate) => candidate.intentId === protectionOrder.intentId)
    binding = inherited.length === 1 ? inherited[0] : undefined
    const terms = binding?.protection
    const quantity = nativeOrder.quantityAtoms
    const expectedQuantity = binding?.quantityAtoms
    const candidate = unboundOrder.success.order
    if (
      binding === undefined ||
      terms === undefined ||
      isStopProtection(terms) ||
      protectionOrder.parentBrokerOrderId === undefined ||
      protectionOrder.brokerOrderId === protectionOrder.parentBrokerOrderId ||
      protectionOrder.accountId !== candidate.accountId ||
      protectionOrder.brokerOrderId !== candidate.brokerOrderId ||
      protectionOrder.clientOrderId !== candidate.clientOrderId ||
      protectionOrder.symbol !== candidate.symbol ||
      binding.symbol !== candidate.symbol ||
      protectionOrder.side !== candidate.side ||
      candidate.side !== (isEquityShortProtection(terms) ? 'BUY' : 'SELL') ||
      protectionOrder.orderType !== candidate.orderType ||
      protectionOrder.timeInForce !== candidate.timeInForce ||
      quantity === undefined ||
      expectedQuantity === undefined ||
      BigInt(quantity) > BigInt(expectedQuantity) ||
      nativeOrder.orderClass !== (isBracketProtection(terms) ? 'bracket' : 'oco') ||
      nativeOrder.limitPriceMicros !==
        (role === 'stop_loss' ? terms.stopLimitPriceMicros : terms.profitLimitPriceMicros) ||
      nativeOrder.stopPriceMicros !== (role === 'stop_loss' ? terms.stopPriceMicros : undefined)
    )
      return reconcile(notification, BrokerStreamReconciliationReason.InvalidOrder)
    parentBrokerOrderId = protectionOrder.parentBrokerOrderId
  }
  if (binding === undefined) return reconcile(notification, BrokerStreamReconciliationReason.MissingIntent)
  const boundOrder = parentBrokerOrderId === undefined ? nativeOrder : { ...nativeOrder, parentBrokerOrderId }
  const order = orderObservation(boundOrder, evidence, binding.intentId)
  if (Result.isFailure(order) || order.success._tag !== 'Order')
    return reconcile(notification, BrokerStreamReconciliationReason.InvalidOrder)
  if (data.event !== 'fill' && data.event !== 'partial_fill') {
    return {
      _tag: 'Project',
      eventId: notification.eventId,
      observedAt: notification.receivedAt,
      brokerEvent: data.event,
      order: order.success,
    }
  }
  const executionId = data.execution_id
  if (executionId === undefined || data.price === undefined || data.qty === undefined)
    return reconcile(notification, BrokerStreamReconciliationReason.InvalidFill)
  const price = quantityFromDecimal(data.price)
  const quantity = quantityFromDecimal(data.qty)
  if (
    Result.isFailure(price) ||
    Result.isFailure(quantity) ||
    price.success <= 0n ||
    quantity.success <= 0n ||
    price.success > U128_MAX ||
    quantity.success > U128_MAX
  )
    return reconcile(notification, BrokerStreamReconciliationReason.InvalidFill)
  const identity = Result.try({
    try: () => fillActivityIdentity(executionId, data.timestamp),
    catch: () => BrokerStreamReconciliationReason.InvalidFill,
  })
  if (Result.isFailure(identity)) return reconcile(notification, identity.failure)
  const fill = fillObservation(
    {
      accountId: notification.session.accountId,
      activityId: identity.success.activityId,
      brokerOrderId: normalizedOrder.success.brokerOrderId,
      symbol: normalizedOrder.success.symbol,
      side: normalizedOrder.success.side === OrderSide.Buy ? OrderSide.Buy : OrderSide.Sell,
      quantityAtoms: quantity.success.toString(),
      priceAtoms: price.success.toString(),
      transactionTime: identity.success.transactionTime,
    },
    boundOrder,
    evidence,
    { intentId: binding.intentId },
  )
  return Result.isFailure(fill)
    ? reconcile(notification, BrokerStreamReconciliationReason.InvalidFill)
    : {
        _tag: 'Project',
        eventId: notification.eventId,
        observedAt: notification.receivedAt,
        brokerEvent: data.event,
        order: order.success,
        fill: fill.success,
      }
}
