import { Result, Schema, pipe } from 'effect'

import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'
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
  UtcOrderTimestampSchema as UtcOrderTimestamp,
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
import { Pipeable } from '../pipeable'

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
  Fill: { ...CommonEventInput, sourceTimestamp: UtcOrderTimestamp, fill: FillSchema },
})
export type BrokerEventInput = typeof BrokerEventInputSchema.Type

export const FillEventInputSchema = Schema.TaggedStruct('Fill', {
  ...CommonEventInput,
  sourceTimestamp: UtcOrderTimestamp,
  fill: FillSchema,
})
export type FillEventInput = typeof FillEventInputSchema.Type

export const PositionEventInputSchema = Schema.TaggedStruct('Position', {
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

type ObservationTarget = 'account' | 'fill' | 'order' | 'position' | 'position-snapshot'

export type BrokerObservationError =
  | { readonly _tag: 'DecodeFailed'; readonly target: ObservationTarget; readonly cause: unknown }
  | {
      readonly _tag: 'CanonicalizationFailed'
      readonly target: ObservationTarget
      readonly cause: CanonicalHashFailure
    }
  | { readonly _tag: 'TimestampInvalid'; readonly value: string }
  | {
      readonly _tag: 'ObservationTimeMismatch'
      readonly valueObservedAt: string
      readonly evidenceObservedAt: string
    }
  | { readonly _tag: 'UnsupportedOrderType'; readonly value: AlpacaOrderType }
  | { readonly _tag: 'UnsupportedTimeInForce'; readonly value: AlpacaTimeInForce }
  | {
      readonly _tag: 'FilledQuantityInvalid'
      readonly filledQuantityMicros: string
      readonly quantityMicros?: string
    }
  | { readonly _tag: 'UnsupportedOrderStatus'; readonly value: AlpacaOrderStatus }
  | { readonly _tag: 'DuplicatePositionAsset'; readonly assetId: string }
  | { readonly _tag: 'DuplicatePositionSymbol'; readonly symbol: string }
  | {
      readonly _tag: 'PositionAccountMismatch'
      readonly expectedAccountId: string
      readonly accountIds: readonly string[]
    }
  | { readonly _tag: 'OrderQuantityOrNotionalRequired'; readonly brokerOrderId: string }
  | { readonly _tag: 'ExtendedHoursUnsupported'; readonly brokerOrderId: string }
  | { readonly _tag: 'OrderUpdatedAtMissing'; readonly brokerOrderId: string }
  | {
      readonly _tag: 'FillOrderMismatch'
      readonly activityId: string
      readonly brokerOrderId: string
    }

const fail = <A>(error: BrokerObservationError): Result.Result<A, BrokerObservationError> => Result.fail(error)

const decode =
  <A>(target: ObservationTarget, schema: Schema.Codec<A>) =>
  (value: unknown): Result.Result<A, BrokerObservationError> =>
    pipe(
      Schema.decodeUnknownResult(schema, strictParseOptions)(value),
      Result.mapError((cause): BrokerObservationError => ({ _tag: 'DecodeFailed', target, cause })),
    )

const decodeEvent = (
  target: Extract<ObservationTarget, 'account' | 'order'>,
  value: unknown,
): Result.Result<BrokerEventInput, BrokerObservationError> => decode(target, BrokerEventInputSchema)(value)
const decodeFill = decode('fill', FillEventInputSchema)
const decodePosition = decode('position', PositionEventInputSchema)
const decodePositionSnapshot = decode('position-snapshot', PositionSnapshotInputSchema)

const canonicalHash = (target: ObservationTarget, value: unknown): Result.Result<string, BrokerObservationError> =>
  Result.mapError(
    canonicalHashV1Result(value),
    (cause): BrokerObservationError => ({ _tag: 'CanonicalizationFailed', target, cause }),
  )

const canonicalUnsignedIntegerPattern = /^(?:0|[1-9][0-9]*)$/

export const sourceTimestamp = (value: string): Result.Result<string, BrokerObservationError> => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value)
  if (match === null) return fail({ _tag: 'TimestampInvalid', value })
  return pipe(
    Schema.decodeResult(UtcOrderTimestamp, strictParseOptions)(`${match[1]}.${(match[2] ?? '').padEnd(9, '0')}Z`),
    Result.mapError((): BrokerObservationError => ({ _tag: 'TimestampInvalid', value })),
  )
}

const canonicalInstant = (value: string): Result.Result<string, BrokerObservationError> =>
  pipe(
    sourceTimestamp(value),
    Result.flatMap((timestamp) =>
      pipe(
        Schema.decodeResult(UtcInstant, strictParseOptions)(`${timestamp.slice(0, 23)}Z`),
        Result.mapError((): BrokerObservationError => ({ _tag: 'TimestampInvalid', value })),
      ),
    ),
  )

const validateObservationTime = (
  observedAt: string,
  evidence: ReadEvidence,
): Result.Result<void, BrokerObservationError> =>
  observedAt === evidence.observedAt
    ? Result.succeed(undefined)
    : fail({
        _tag: 'ObservationTimeMismatch',
        valueObservedAt: observedAt,
        evidenceObservedAt: evidence.observedAt,
      })

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

const orderType = (value: AlpacaOrderType): Result.Result<OrderType, BrokerObservationError> => {
  switch (value) {
    case AlpacaOrderType.Market:
      return Result.succeed(OrderType.Market)
    case AlpacaOrderType.Limit:
      return Result.succeed(OrderType.Limit)
    default:
      return fail({ _tag: 'UnsupportedOrderType', value })
  }
}

const timeInForce = (value: AlpacaTimeInForce): Result.Result<TimeInForce, BrokerObservationError> => {
  switch (value) {
    case AlpacaTimeInForce.Day:
      return Result.succeed(TimeInForce.Day)
    case AlpacaTimeInForce.GoodUntilCanceled:
      return Result.succeed(TimeInForce.GoodUntilCanceled)
    case AlpacaTimeInForce.ImmediateOrCancel:
      return Result.succeed(TimeInForce.ImmediateOrCancel)
    case AlpacaTimeInForce.FillOrKill:
      return Result.succeed(TimeInForce.FillOrKill)
    default:
      return fail({ _tag: 'UnsupportedTimeInForce', value })
  }
}

const nonterminalStatus = (
  filledQuantityMicros: string,
  quantityMicros?: string,
): Result.Result<OrderStatus, BrokerObservationError> => {
  if (!canonicalUnsignedIntegerPattern.test(filledQuantityMicros)) {
    return fail({
      _tag: 'FilledQuantityInvalid',
      filledQuantityMicros,
      ...(quantityMicros === undefined ? {} : { quantityMicros }),
    })
  }
  const filled = BigInt(filledQuantityMicros)
  if (quantityMicros === undefined) {
    return Result.succeed(filled === 0n ? OrderStatus.Pending : OrderStatus.PartiallyFilled)
  }
  if (!canonicalUnsignedIntegerPattern.test(quantityMicros)) {
    return fail({ _tag: 'FilledQuantityInvalid', filledQuantityMicros, quantityMicros })
  }
  const quantity = BigInt(quantityMicros)
  if (filled === 0n) return Result.succeed(OrderStatus.Pending)
  if (filled < quantity) return Result.succeed(OrderStatus.PartiallyFilled)
  return filled === quantity
    ? Result.succeed(OrderStatus.Filled)
    : fail({ _tag: 'FilledQuantityInvalid', filledQuantityMicros, quantityMicros })
}

const orderStatus = (
  value: AlpacaOrderStatus,
  filledQuantityMicros: string,
  quantityMicros?: string,
): Result.Result<OrderStatus, BrokerObservationError> => {
  switch (value) {
    case AlpacaOrderStatus.New:
      return filledQuantityMicros === '0'
        ? Result.succeed(OrderStatus.New)
        : nonterminalStatus(filledQuantityMicros, quantityMicros)
    case AlpacaOrderStatus.PartiallyFilled:
      return Result.succeed(OrderStatus.PartiallyFilled)
    case AlpacaOrderStatus.Filled:
      return Result.succeed(OrderStatus.Filled)
    case AlpacaOrderStatus.Canceled:
      return Result.succeed(OrderStatus.Canceled)
    case AlpacaOrderStatus.Expired:
      return Result.succeed(OrderStatus.Expired)
    case AlpacaOrderStatus.Rejected:
      return Result.succeed(OrderStatus.Rejected)
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
      return fail({ _tag: 'UnsupportedOrderStatus', value })
  }
}

export const accountObservation = (
  result: ReadResult<AlpacaAccount>,
): Result.Result<BrokerEventInput, BrokerObservationError> => {
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
  return pipe(
    Result.all({
      observationTime: validateObservationTime(result.value.observedAt, result.evidence),
      contentHash: canonicalHash('account', {
        schemaVersion: 'bayn.paper-account-source.v1',
        responseContentHash: result.evidence.contentHash,
        account: withoutObservedAt(account),
      }),
    }),
    Result.flatMap(({ contentHash }) =>
      decodeEvent('account', {
        _tag: 'Account',
        broker: Broker.Alpaca,
        accountId: account.accountId,
        sourceEventId: `account:${result.evidence.contentHash}:${result.evidence.observedAt}`,
        contentHash,
        occurredAt: account.observedAt,
        observedAt: account.observedAt,
        account,
      }),
    ),
  )
}

const positionObservation = (
  value: AlpacaPosition,
  evidence: ReadEvidence,
): Result.Result<PositionEventInput, BrokerObservationError> => {
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
  return pipe(
    Result.all({
      observationTime: validateObservationTime(value.observedAt, evidence),
      contentHash: canonicalHash('position', {
        schemaVersion: 'bayn.paper-position-source.v1',
        responseContentHash: evidence.contentHash,
        position: withoutObservedAt(position),
      }),
    }),
    Result.flatMap(({ contentHash }) =>
      decodePosition({
        _tag: 'Position',
        broker: Broker.Alpaca,
        accountId: position.accountId,
        sourceEventId: `position:${evidence.contentHash}:${evidence.observedAt}:${value.assetId}`,
        contentHash,
        occurredAt: position.observedAt,
        observedAt: position.observedAt,
        position,
      }),
    ),
  )
}

const duplicatePosition = (positions: readonly AlpacaPosition[]): BrokerObservationError | undefined => {
  const duplicateAsset = positions.find(
    (position, index) => positions.findIndex((candidate) => candidate.assetId === position.assetId) !== index,
  )
  if (duplicateAsset !== undefined) return { _tag: 'DuplicatePositionAsset', assetId: duplicateAsset.assetId }
  const duplicateSymbol = positions.find(
    (position, index) => positions.findIndex((candidate) => candidate.symbol === position.symbol) !== index,
  )
  return duplicateSymbol === undefined ? undefined : { _tag: 'DuplicatePositionSymbol', symbol: duplicateSymbol.symbol }
}

const positionSnapshotDataFirst = (
  accountId: string,
  result: ReadResult<readonly AlpacaPosition[]>,
): Result.Result<PositionSnapshotInput, BrokerObservationError> => {
  const accountIds = [...new Set(result.value.map((position) => position.accountId))].sort()
  const accountMismatch = accountIds.some((observedAccountId) => observedAccountId !== accountId)
  const ordered = [...result.value].sort((left, right) => left.symbol.localeCompare(right.symbol))
  const duplicate = duplicatePosition(ordered)
  return accountMismatch
    ? fail({ _tag: 'PositionAccountMismatch', expectedAccountId: accountId, accountIds })
    : duplicate !== undefined
      ? fail(duplicate)
      : pipe(
          Result.all(ordered.map((position) => positionObservation(position, result.evidence))),
          Result.flatMap((positions) =>
            decodePositionSnapshot({
              accountId,
              sourceHash: result.evidence.contentHash,
              observedAt: result.evidence.observedAt,
              positions,
            }),
          ),
        )
}

export const positionSnapshot = Pipeable.dual(2, positionSnapshotDataFirst)

type ValidatedOrder = Omit<AlpacaOrder, 'updatedAt'> & {
  readonly updatedAt: string
}

const validateOrderShape = (
  value: AlpacaOrder,
  evidence: ReadEvidence,
): Result.Result<ValidatedOrder, BrokerObservationError> => {
  const quantityMicros = value.quantityMicros
  const notionalMicros = value.notionalMicros
  if ((quantityMicros === undefined) === (notionalMicros === undefined)) {
    return fail({ _tag: 'OrderQuantityOrNotionalRequired', brokerOrderId: value.brokerOrderId })
  }
  if (value.extendedHours) {
    return fail({ _tag: 'ExtendedHoursUnsupported', brokerOrderId: value.brokerOrderId })
  }
  const updatedAt = value.updatedAt
  if (updatedAt === undefined) {
    return fail({ _tag: 'OrderUpdatedAtMissing', brokerOrderId: value.brokerOrderId })
  }
  return pipe(
    validateObservationTime(value.observedAt, evidence),
    Result.map(() => ({
      ...value,
      updatedAt,
    })),
  )
}

const orderObservationDataFirst = (
  value: AlpacaOrder,
  evidence: ReadEvidence,
  intentId?: string,
): Result.Result<BrokerEventInput, BrokerObservationError> =>
  pipe(
    validateOrderShape(value, evidence),
    Result.flatMap((validated) =>
      pipe(
        Result.all({
          orderType: orderType(validated.orderType),
          timeInForce: timeInForce(validated.timeInForce),
          status: orderStatus(validated.status, validated.filledQuantityMicros, validated.quantityMicros),
          occurredAt: canonicalInstant(validated.updatedAt),
        }),
        Result.flatMap(({ occurredAt, orderType: normalizedOrderType, status, timeInForce: normalizedTimeInForce }) => {
          const order = {
            schemaVersion: 'bayn.paper-order.v2' as const,
            accountId: validated.accountId,
            brokerOrderId: validated.brokerOrderId,
            clientOrderId: validated.clientOrderId,
            ...(intentId === undefined ? {} : { intentId }),
            symbol: validated.symbol,
            side: side(validated.side),
            orderType: normalizedOrderType,
            timeInForce: normalizedTimeInForce,
            ...(validated.quantityMicros === undefined ? {} : { quantityMicros: validated.quantityMicros }),
            ...(validated.notionalMicros === undefined ? {} : { notionalMicros: validated.notionalMicros }),
            filledQuantityMicros: validated.filledQuantityMicros,
            ...(validated.limitPriceMicros === undefined ? {} : { limitPriceMicros: validated.limitPriceMicros }),
            status,
            observedAt: validated.observedAt,
          }
          return pipe(
            canonicalHash('order', {
              schemaVersion: 'bayn.paper-order-source.v1',
              order: withoutObservedAt(order),
              brokerUpdatedAt: validated.updatedAt,
            }),
            Result.flatMap((contentHash) =>
              decodeEvent('order', {
                _tag: 'Order',
                broker: Broker.Alpaca,
                accountId: order.accountId,
                sourceEventId: `order:${order.brokerOrderId}:${validated.updatedAt}`,
                contentHash,
                occurredAt,
                observedAt: order.observedAt,
                order,
              }),
            ),
          )
        }),
      ),
    ),
  )

export const orderObservation = Pipeable.by<
  (evidence: ReadEvidence, intentId?: string) => (value: AlpacaOrder) => ReturnType<typeof orderObservationDataFirst>,
  typeof orderObservationDataFirst
>(
  (arguments_) => typeof arguments_[0] === 'object' && arguments_[0] !== null && 'brokerOrderId' in arguments_[0],
  orderObservationDataFirst,
)

const fillObservationDataFirst = (
  activity: FillActivity,
  order: AlpacaOrder,
  evidence: ReadEvidence,
  options: { readonly intentId?: string; readonly feeMicros?: string } = {},
): Result.Result<FillEventInput, BrokerObservationError> => {
  const matchesOrder =
    activity.accountId === order.accountId &&
    activity.brokerOrderId === order.brokerOrderId &&
    activity.symbol === order.symbol &&
    activity.side === order.side
  return matchesOrder
    ? pipe(
        Result.all({
          occurredAt: canonicalInstant(activity.transactionTime),
          sourceTimestamp: sourceTimestamp(activity.transactionTime),
        }),
        Result.flatMap(({ occurredAt, sourceTimestamp: normalizedSourceTimestamp }) => {
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
            occurredAt,
          }
          return pipe(
            canonicalHash('fill', {
              schemaVersion: 'bayn.paper-fill-source.v1',
              fill,
              brokerTransactionTime: activity.transactionTime,
            }),
            Result.flatMap((contentHash) =>
              decodeFill({
                _tag: 'Fill',
                broker: Broker.Alpaca,
                accountId: fill.accountId,
                sourceEventId: fill.fillId,
                sourceTimestamp: normalizedSourceTimestamp,
                contentHash,
                occurredAt: fill.occurredAt,
                observedAt: evidence.observedAt,
                fill,
              }),
            ),
          )
        }),
      )
    : fail({
        _tag: 'FillOrderMismatch',
        activityId: activity.activityId,
        brokerOrderId: order.brokerOrderId,
      })
}

export const fillObservation = Pipeable.by<
  (
    order: AlpacaOrder,
    evidence: ReadEvidence,
    options?: { readonly intentId?: string; readonly feeMicros?: string },
  ) => (activity: FillActivity) => ReturnType<typeof fillObservationDataFirst>,
  typeof fillObservationDataFirst
>(
  (arguments_) => typeof arguments_[0] === 'object' && arguments_[0] !== null && 'activityId' in arguments_[0],
  fillObservationDataFirst,
)

export const renderBrokerObservationError = (error: BrokerObservationError): string => {
  switch (error._tag) {
    case 'DecodeFailed':
      return `${error.target} observation failed strict decoding`
    case 'CanonicalizationFailed':
      return `${error.target} observation failed canonical hashing`
    case 'TimestampInvalid':
      return `broker timestamp is not a UTC RFC 3339 instant: ${error.value}`
    case 'ObservationTimeMismatch':
      return `broker payload observation ${error.valueObservedAt} does not match response evidence ${error.evidenceObservedAt}`
    case 'UnsupportedOrderType':
      return `unsupported paper order type ${error.value}`
    case 'UnsupportedTimeInForce':
      return `unsupported paper time in force ${error.value}`
    case 'FilledQuantityInvalid':
      return `filled quantity ${error.filledQuantityMicros} exceeds or is invalid for order quantity ${error.quantityMicros}`
    case 'UnsupportedOrderStatus':
      return `unsupported paper order status ${error.value}`
    case 'DuplicatePositionAsset':
      return `duplicate Alpaca position asset ${error.assetId}`
    case 'DuplicatePositionSymbol':
      return `duplicate Alpaca position symbol ${error.symbol}`
    case 'PositionAccountMismatch':
      return `Alpaca position accounts ${error.accountIds.join(',')} do not match ${error.expectedAccountId}`
    case 'OrderQuantityOrNotionalRequired':
      return `paper order ${error.brokerOrderId} must contain exactly one of quantity or notional`
    case 'ExtendedHoursUnsupported':
      return `paper execution requires extended hours disabled for ${error.brokerOrderId}`
    case 'OrderUpdatedAtMissing':
      return `paper order ${error.brokerOrderId} requires Alpaca updated_at`
    case 'FillOrderMismatch':
      return `Alpaca fill ${error.activityId} does not match order ${error.brokerOrderId}`
  }
}
