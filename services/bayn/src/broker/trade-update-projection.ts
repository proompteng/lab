import { Result, Schema } from 'effect'

import { sha256 } from '../hash'
import { quantityFromDecimal } from '../quantity'
import { Sha256Schema, UtcInstantSchema } from '../schemas'
import type { IntentBinding } from '../db/intent-bindings'
import { fillObservation, orderObservation, type BrokerEventInput, type FillEventInput } from './observations'
import { fillActivityIdentity } from './alpaca/activity-stream'
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
      order: OrderResponseSchema,
      execution_id: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
      price: Schema.optionalKey(Schema.NonEmptyString),
      qty: Schema.optionalKey(Schema.NonEmptyString),
    }),
  }),
)

const projectedEvents = new Set([
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

export type BrokerTradeUpdateProjection =
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
): BrokerTradeUpdateProjection => {
  if (notification._tag === 'SessionReady')
    return reconcile(notification, BrokerStreamReconciliationReason.SessionBoundary)
  const decoded = Schema.decodeUnknownResult(TradeUpdateFrameSchema, responseParseOptions)(notification.frameJson)
  if (Result.isFailure(decoded)) return reconcile(notification, BrokerStreamReconciliationReason.InvalidFrame)
  const { data } = decoded.success
  if (!projectedEvents.has(data.event))
    return reconcile(notification, BrokerStreamReconciliationReason.UnsupportedEvent)
  const matchingBindings = bindings.filter((binding) => binding.clientOrderId === data.order.client_order_id)
  if (matchingBindings.length !== 1) return reconcile(notification, BrokerStreamReconciliationReason.MissingIntent)
  const binding = matchingBindings[0]
  if (binding === undefined) return reconcile(notification, BrokerStreamReconciliationReason.MissingIntent)
  const normalizedOrder = normalizeOrderResult(data.order, notification.session.accountId, notification.receivedAt)
  if (Result.isFailure(normalizedOrder)) return reconcile(notification, BrokerStreamReconciliationReason.InvalidOrder)
  const evidence = {
    status: 200,
    requestId: notification.eventId,
    contentHash: sha256(notification.frameJson),
    observedAt: notification.receivedAt,
  }
  const order = orderObservation(normalizedOrder.success, evidence, binding.intentId)
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
    normalizedOrder.success,
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
