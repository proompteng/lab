import { Schema } from 'effect'

import { canonicalHashV1 } from '../hash'
import {
  AccountSnapshotSchema,
  AccountStatus,
  Broker,
  FillSchema,
  OrderSchema,
  OrderSide,
  OrderStatus,
  OrderType,
  PositionSchema,
  TimeInForce,
} from '../paper'
import {
  Sha256Schema as Sha256,
  StrictNonEmptyStringSchema as NonEmptyString,
  UtcInstantSchema as UtcInstant,
  strictParseOptions,
} from '../schemas'
import {
  AccountStatus as AlpacaAccountStatus,
  OrderSide as AlpacaOrderSide,
  OrderStatus as AlpacaOrderStatus,
  OrderType as AlpacaOrderType,
  TimeInForce as AlpacaTimeInForce,
  type Account as AlpacaAccount,
  type FillActivity,
  type Order as AlpacaOrder,
  type Position as AlpacaPosition,
  type ReadEvidence,
  type ReadResult,
} from './alpaca'

const CommonEventInput = {
  broker: Schema.Literal(Broker.Alpaca),
  accountId: NonEmptyString,
  sourceEventId: NonEmptyString,
  contentHash: Sha256,
  occurredAt: UtcInstant,
  observedAt: UtcInstant,
} as const

export const BrokerEventInputSchema = Schema.TaggedUnion({
  Account: { ...CommonEventInput, account: AccountSnapshotSchema },
  Position: { ...CommonEventInput, position: PositionSchema },
  Order: { ...CommonEventInput, order: OrderSchema },
  Fill: { ...CommonEventInput, fill: FillSchema },
})
export type BrokerEventInput = typeof BrokerEventInputSchema.Type

export const FillEventInputSchema = Schema.Struct({
  _tag: Schema.Literal('Fill'),
  ...CommonEventInput,
  fill: FillSchema,
})
export type FillEventInput = typeof FillEventInputSchema.Type

export const PositionEventInputSchema = Schema.Struct({
  _tag: Schema.Literal('Position'),
  ...CommonEventInput,
  position: PositionSchema,
})
export type PositionEventInput = typeof PositionEventInputSchema.Type

export const PositionSnapshotInputSchema = Schema.Struct({
  accountId: NonEmptyString,
  sourceHash: Sha256,
  observedAt: UtcInstant,
  positions: Schema.Array(PositionEventInputSchema),
})
export type PositionSnapshotInput = typeof PositionSnapshotInputSchema.Type

export const ValuationInputSchema = Schema.Struct({
  accountEventId: Sha256,
  positionSnapshotId: Sha256,
})
export type ValuationInput = typeof ValuationInputSchema.Type

const decodeEvent = Schema.decodeUnknownSync(BrokerEventInputSchema, strictParseOptions)
const decodeFill = Schema.decodeUnknownSync(FillEventInputSchema, strictParseOptions)
const decodePosition = Schema.decodeUnknownSync(PositionEventInputSchema, strictParseOptions)
const decodePositionSnapshot = Schema.decodeUnknownSync(PositionSnapshotInputSchema, strictParseOptions)

const assertObservationTime = (observedAt: string, evidence: ReadEvidence): void => {
  if (observedAt !== evidence.observedAt) throw new Error('normalized broker payload and response evidence disagree')
}

const withoutObservedAt = <A extends { readonly observedAt: string }>(value: A): Omit<A, 'observedAt'> => {
  const { observedAt: _observedAt, ...content } = value
  return content
}

const accountStatus = (account: AlpacaAccount): AccountStatus => {
  if (account.status === AlpacaAccountStatus.AccountClosed) return AccountStatus.Closed
  if (
    account.status === AlpacaAccountStatus.Active &&
    !account.accountBlocked &&
    !account.tradingBlocked &&
    !account.tradeSuspendedByUser
  ) {
    return AccountStatus.Active
  }
  return AccountStatus.Restricted
}

const side = (value: AlpacaOrderSide): OrderSide => (value === AlpacaOrderSide.Buy ? OrderSide.Buy : OrderSide.Sell)

const orderType = (value: AlpacaOrderType): OrderType => {
  switch (value) {
    case AlpacaOrderType.Market:
      return OrderType.Market
    case AlpacaOrderType.Limit:
      return OrderType.Limit
    default:
      throw new Error(`unsupported paper order type ${value}`)
  }
}

const timeInForce = (value: AlpacaTimeInForce): TimeInForce => {
  switch (value) {
    case AlpacaTimeInForce.Day:
      return TimeInForce.Day
    case AlpacaTimeInForce.GoodUntilCanceled:
      return TimeInForce.GoodUntilCanceled
    case AlpacaTimeInForce.ImmediateOrCancel:
      return TimeInForce.ImmediateOrCancel
    case AlpacaTimeInForce.FillOrKill:
      return TimeInForce.FillOrKill
    default:
      throw new Error(`unsupported paper time in force ${value}`)
  }
}

const nonterminalStatus = (filledQuantityMicros: string, quantityMicros: string): OrderStatus => {
  const filled = BigInt(filledQuantityMicros)
  const quantity = BigInt(quantityMicros)
  if (filled === 0n) return OrderStatus.Pending
  if (filled < quantity) return OrderStatus.PartiallyFilled
  if (filled === quantity) return OrderStatus.Filled
  throw new Error('Alpaca filled quantity exceeds order quantity')
}

const orderStatus = (value: AlpacaOrderStatus, filledQuantityMicros: string, quantityMicros: string): OrderStatus => {
  switch (value) {
    case AlpacaOrderStatus.New:
      return filledQuantityMicros === '0' ? OrderStatus.New : nonterminalStatus(filledQuantityMicros, quantityMicros)
    case AlpacaOrderStatus.PartiallyFilled:
      return OrderStatus.PartiallyFilled
    case AlpacaOrderStatus.Filled:
      return OrderStatus.Filled
    case AlpacaOrderStatus.Canceled:
      return OrderStatus.Canceled
    case AlpacaOrderStatus.Expired:
      return OrderStatus.Expired
    case AlpacaOrderStatus.Rejected:
      return OrderStatus.Rejected
    case AlpacaOrderStatus.Accepted:
    case AlpacaOrderStatus.AcceptedForBidding:
    case AlpacaOrderStatus.PendingCancel:
    case AlpacaOrderStatus.PendingNew:
    case AlpacaOrderStatus.PendingReplace:
    case AlpacaOrderStatus.PendingReview:
    case AlpacaOrderStatus.DoneForDay:
    case AlpacaOrderStatus.Calculated:
    case AlpacaOrderStatus.Held:
    case AlpacaOrderStatus.Stopped:
    case AlpacaOrderStatus.Suspended:
      return nonterminalStatus(filledQuantityMicros, quantityMicros)
    default:
      throw new Error(`unsupported paper order status ${value}`)
  }
}

export const accountObservation = (result: ReadResult<AlpacaAccount>): BrokerEventInput => {
  assertObservationTime(result.value.observedAt, result.evidence)
  const account = {
    schemaVersion: 'bayn.paper-account-snapshot.v1' as const,
    accountId: result.value.id,
    status: accountStatus(result.value),
    currency: result.value.currency,
    cashMicros: result.value.cashMicros,
    equityMicros: result.value.equityMicros,
    buyingPowerMicros: result.value.buyingPowerMicros,
    observedAt: result.value.observedAt,
  }
  return decodeEvent({
    _tag: 'Account',
    broker: Broker.Alpaca,
    accountId: account.accountId,
    sourceEventId: `account:${result.evidence.contentHash}:${result.evidence.observedAt}`,
    contentHash: canonicalHashV1({
      schemaVersion: 'bayn.paper-account-source.v1',
      responseContentHash: result.evidence.contentHash,
      account: withoutObservedAt(account),
    }),
    occurredAt: account.observedAt,
    observedAt: account.observedAt,
    account,
  })
}

const positionObservations = (result: ReadResult<readonly AlpacaPosition[]>): readonly PositionEventInput[] => {
  const identities = new Set<string>()
  const symbols = new Set<string>()
  return [...result.value]
    .sort((left, right) => (left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0))
    .map((value) => {
      assertObservationTime(value.observedAt, result.evidence)
      if (identities.has(value.assetId)) throw new Error(`duplicate Alpaca position asset ${value.assetId}`)
      if (symbols.has(value.symbol)) throw new Error(`duplicate Alpaca position symbol ${value.symbol}`)
      identities.add(value.assetId)
      symbols.add(value.symbol)
      const position = {
        schemaVersion: 'bayn.paper-position.v1' as const,
        accountId: value.accountId,
        symbol: value.symbol,
        quantityMicros: value.quantityMicros,
        averageEntryPriceMicros: value.averageEntryPriceMicros,
        marketPriceMicros: value.marketPriceMicros,
        marketValueMicros: value.marketValueMicros,
        unrealizedPnlMicros: value.unrealizedPnlMicros,
        observedAt: value.observedAt,
      }
      return decodePosition({
        _tag: 'Position',
        broker: Broker.Alpaca,
        accountId: position.accountId,
        sourceEventId: `position:${result.evidence.contentHash}:${result.evidence.observedAt}:${value.assetId}`,
        contentHash: canonicalHashV1({
          schemaVersion: 'bayn.paper-position-source.v1',
          responseContentHash: result.evidence.contentHash,
          position: withoutObservedAt(position),
        }),
        occurredAt: position.observedAt,
        observedAt: position.observedAt,
        position,
      })
    })
}

export const positionSnapshot = (
  accountId: string,
  result: ReadResult<readonly AlpacaPosition[]>,
): PositionSnapshotInput => {
  if (result.value.some((position) => position.accountId !== accountId)) {
    throw new Error('Alpaca position response contains another account')
  }
  return decodePositionSnapshot({
    accountId,
    sourceHash: result.evidence.contentHash,
    observedAt: result.evidence.observedAt,
    positions: positionObservations(result),
  })
}

export const orderObservation = (value: AlpacaOrder, evidence: ReadEvidence, intentId?: string): BrokerEventInput => {
  assertObservationTime(value.observedAt, evidence)
  if (value.quantityMicros === undefined || value.notionalMicros !== undefined) {
    throw new Error('paper accounting requires a quantity order')
  }
  if (value.extendedHours) throw new Error('paper execution requires extended hours to be disabled')
  const order = {
    schemaVersion: 'bayn.paper-order.v1' as const,
    accountId: value.accountId,
    brokerOrderId: value.brokerOrderId,
    clientOrderId: value.clientOrderId,
    ...(intentId === undefined ? {} : { intentId }),
    symbol: value.symbol,
    side: side(value.side),
    orderType: orderType(value.orderType),
    timeInForce: timeInForce(value.timeInForce),
    quantityMicros: value.quantityMicros,
    filledQuantityMicros: value.filledQuantityMicros,
    ...(value.limitPriceMicros === undefined ? {} : { limitPriceMicros: value.limitPriceMicros }),
    status: orderStatus(value.status, value.filledQuantityMicros, value.quantityMicros),
    observedAt: value.observedAt,
  }
  return decodeEvent({
    _tag: 'Order',
    broker: Broker.Alpaca,
    accountId: order.accountId,
    sourceEventId: `order:${order.brokerOrderId}:${value.updatedAt}`,
    contentHash: canonicalHashV1({
      schemaVersion: 'bayn.paper-order-source.v1',
      order: withoutObservedAt(order),
      brokerUpdatedAt: value.updatedAt,
    }),
    occurredAt: value.updatedAt,
    observedAt: order.observedAt,
    order,
  })
}

export const fillObservation = (
  activity: FillActivity,
  order: AlpacaOrder,
  evidence: ReadEvidence,
  options: { readonly intentId?: string; readonly feeMicros?: string } = {},
): FillEventInput => {
  if (
    activity.accountId !== order.accountId ||
    activity.brokerOrderId !== order.brokerOrderId ||
    activity.symbol !== order.symbol ||
    activity.side !== order.side
  ) {
    throw new Error('Alpaca fill activity does not match its order')
  }
  const fill = {
    schemaVersion: 'bayn.paper-fill.v1' as const,
    accountId: activity.accountId,
    fillId: activity.activityId,
    brokerOrderId: activity.brokerOrderId,
    clientOrderId: order.clientOrderId,
    ...(options.intentId === undefined ? {} : { intentId: options.intentId }),
    symbol: activity.symbol,
    side: side(activity.side),
    quantityMicros: activity.quantityMicros,
    priceMicros: activity.priceMicros,
    feeMicros: options.feeMicros ?? '0',
    occurredAt: activity.transactionTime,
  }
  return decodeFill({
    _tag: 'Fill',
    broker: Broker.Alpaca,
    accountId: fill.accountId,
    sourceEventId: fill.fillId,
    contentHash: canonicalHashV1({ schemaVersion: 'bayn.paper-fill-source.v1', fill }),
    occurredAt: fill.occurredAt,
    observedAt: evidence.observedAt,
    fill,
  })
}
