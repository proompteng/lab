import { Context, Effect, Schema } from 'effect'

import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../../schemas'
import { canonicalHashV1 } from '../../hash'
import { BrokerReadError, BrokerReadErrorKind } from './failures'
import {
  AccountStatus,
  AssetClass,
  AssetExchange,
  OrderClass,
  OrderType,
  OrderSide,
  OrderStatus,
  PositionSide,
  TimeInForce,
  TradeActivityType,
  accountConfigurationObservationSchemaVersion,
  accountConfigurationObservationSource,
  type StableBrokerSnapshot,
  type ReadResult,
  type AccountConfigurationObservation,
  type Order,
  type FillActivityPage,
} from './model'

const micros = Schema.String.check(Schema.isPattern(/^-?\d+$/))
const evidence = Schema.Struct({
  requestId: Schema.String,
  status: Schema.Int,
  contentHash: Sha256Schema,
  observedAt: UtcInstantSchema,
  rateLimit: Schema.optionalKey(
    Schema.Struct({
      limit: Schema.optionalKey(Schema.String),
      remaining: Schema.optionalKey(Schema.String),
      reset: Schema.optionalKey(Schema.String),
      retryAfter: Schema.optionalKey(Schema.String),
    }),
  ),
})
const observed = <S extends Schema.Top>(value: S) => Schema.Struct({ value, evidence })
const account = Schema.Struct({
  id: Schema.String,
  status: Schema.Enum(AccountStatus),
  currency: Schema.Literal('USD'),
  cashMicros: micros,
  equityMicros: micros,
  lastEquityMicros: micros,
  buyingPowerMicros: micros,
  accountBlocked: Schema.Boolean,
  tradingBlocked: Schema.Boolean,
  tradeSuspendedByUser: Schema.Boolean,
  observedAt: UtcInstantSchema,
})
const position = Schema.Struct({
  accountId: Schema.String,
  assetId: Schema.String,
  symbol: Schema.String,
  exchange: Schema.Enum(AssetExchange),
  assetClass: Schema.Literal(AssetClass.UsEquity),
  side: Schema.Enum(PositionSide),
  quantityMicros: micros,
  averageEntryPriceMicros: micros,
  costBasisMicros: Schema.optionalKey(micros),
  marketPriceMicros: micros,
  marketValueMicros: micros,
  unrealizedPnlMicros: micros,
  observedAt: UtcInstantSchema,
})
const order = Schema.Struct({
  accountId: Schema.String,
  brokerOrderId: Schema.String,
  clientOrderId: Schema.String,
  createdAt: UtcInstantSchema,
  updatedAt: Schema.optionalKey(UtcInstantSchema),
  submittedAt: Schema.optionalKey(UtcInstantSchema),
  filledAt: Schema.optionalKey(UtcInstantSchema),
  expiredAt: Schema.optionalKey(UtcInstantSchema),
  canceledAt: Schema.optionalKey(UtcInstantSchema),
  failedAt: Schema.optionalKey(UtcInstantSchema),
  replacedAt: Schema.optionalKey(UtcInstantSchema),
  replacedBy: Schema.optionalKey(Schema.String),
  replaces: Schema.optionalKey(Schema.String),
  assetId: Schema.String,
  symbol: Schema.String,
  assetClass: Schema.Literal(AssetClass.UsEquity),
  quantityMicros: Schema.optionalKey(micros),
  notionalMicros: Schema.optionalKey(micros),
  filledQuantityMicros: micros,
  filledAveragePriceMicros: Schema.optionalKey(micros),
  orderClass: Schema.Enum(OrderClass),
  orderType: Schema.Enum(OrderType),
  side: Schema.Enum(OrderSide),
  timeInForce: Schema.Enum(TimeInForce),
  limitPriceMicros: Schema.optionalKey(micros),
  stopPriceMicros: Schema.optionalKey(micros),
  status: Schema.Enum(OrderStatus),
  extendedHours: Schema.Boolean,
  trailPercentMicros: Schema.optionalKey(micros),
  trailPriceMicros: Schema.optionalKey(micros),
  highWaterMarkMicros: Schema.optionalKey(micros),
  observedAt: UtcInstantSchema,
})
const fill = Schema.Struct({
  accountId: Schema.String,
  activityId: Schema.String,
  cumulativeQuantityMicros: micros,
  leavesQuantityMicros: micros,
  priceMicros: micros,
  quantityMicros: micros,
  side: Schema.Enum(OrderSide),
  symbol: Schema.String,
  transactionTime: UtcInstantSchema,
  brokerOrderId: Schema.String,
  type: Schema.Enum(TradeActivityType),
  orderStatus: Schema.optionalKey(Schema.Enum(OrderStatus)),
})
const fee = Schema.Struct({
  accountId: Schema.String,
  activityId: Schema.String,
  date: Schema.String,
  netAmountMicros: micros,
})
const configuration = Schema.Struct({
  schemaVersion: Schema.Literal(accountConfigurationObservationSchemaVersion),
  source: Schema.Literal(accountConfigurationObservationSource),
  requestHash: Sha256Schema,
  fractionalTrading: Schema.Boolean,
  observedAt: UtcInstantSchema,
  normalizedResponseHash: Sha256Schema,
})

export interface ObservedBrokerSnapshot {
  readonly snapshot: StableBrokerSnapshot
  readonly configuration: ReadResult<AccountConfigurationObservation>
  readonly openOrders: ReadResult<readonly Order[]>
  readonly recentOrders: ReadResult<readonly Order[]>
  readonly recentFills: ReadResult<FillActivityPage>
  readonly startedAt: string
  readonly completedAt: string
  readonly observedAt: string
}

export const ObservedBrokerSnapshotSchema = Schema.Struct({
  snapshot: Schema.Struct({
    account: observed(account),
    positions: observed(Schema.Array(position)),
    history: Schema.Struct({
      orders: Schema.Struct({ rows: Schema.Array(observed(order)), observedAt: UtcInstantSchema }),
      fills: Schema.Array(observed(fill)),
      fees: Schema.Array(observed(fee)),
    }),
  }),
  configuration: observed(configuration),
  openOrders: observed(Schema.Array(order)),
  recentOrders: observed(Schema.Array(order)),
  recentFills: observed(Schema.Struct({ items: Schema.Array(fill), nextPageToken: Schema.optionalKey(Schema.String) })),
  startedAt: UtcInstantSchema,
  completedAt: UtcInstantSchema,
  observedAt: UtcInstantSchema,
}) satisfies Schema.Schema<ObservedBrokerSnapshot>

export const decodeObservedBrokerSnapshot = Schema.decodeUnknownResult(ObservedBrokerSnapshotSchema, strictParseOptions)

export const observationUnavailable = (message: string, cause?: unknown): BrokerReadError =>
  new BrokerReadError({
    operation: 'preflight',
    kind: BrokerReadErrorKind.Timeout,
    retryable: true,
    message,
    ...(cause === undefined ? {} : { cause }),
  })

export const observationTimes = (value: ObservedBrokerSnapshot): readonly string[] => [
  value.startedAt,
  value.completedAt,
  value.observedAt,
  value.snapshot.account.evidence.observedAt,
  value.snapshot.account.value.observedAt,
  value.snapshot.positions.evidence.observedAt,
  value.snapshot.history.orders.observedAt,
  value.configuration.evidence.observedAt,
  value.configuration.value.observedAt,
  value.openOrders.evidence.observedAt,
  value.recentOrders.evidence.observedAt,
  value.recentFills.evidence.observedAt,
  ...value.snapshot.positions.value.map((row) => row.observedAt),
]

export const validateObservedBrokerSnapshot = (
  value: ObservedBrokerSnapshot,
  accountId: string,
  now: string,
  maximumAgeMs: number,
): Effect.Effect<ObservedBrokerSnapshot, BrokerReadError> =>
  Effect.suspend(() => {
    const current = Date.parse(now)
    const times = observationTimes(value).map(Date.parse)
    const accounts = [
      value.snapshot.account.value.id,
      ...value.snapshot.positions.value.map((row) => row.accountId),
      ...value.snapshot.history.orders.rows.map((row) => row.value.accountId),
      ...value.snapshot.history.fills.map((row) => row.value.accountId),
      ...value.snapshot.history.fees.map((row) => row.value.accountId),
      ...value.openOrders.value.map((row) => row.accountId),
      ...value.recentOrders.value.map((row) => row.accountId),
      ...value.recentFills.value.items.map((row) => row.accountId),
    ]
    if (
      !Number.isFinite(current) ||
      !Number.isFinite(maximumAgeMs) ||
      maximumAgeMs <= 0 ||
      times.some((at) => !Number.isFinite(at) || at > current) ||
      current - Math.min(...times) >= maximumAgeMs ||
      Date.parse(value.completedAt) < Date.parse(value.startedAt) ||
      Date.parse(value.observedAt) !== Math.min(...times) ||
      accounts.some((id) => id !== accountId)
    )
      return Effect.fail(observationUnavailable('Broker observation is stale, premature or belongs to another account'))
    return Effect.succeed(value)
  })

export interface BrokerObservationTicket {
  readonly generation: number
  readonly startedAt: string
}
export interface BrokerObservationsShape {
  readonly read: Effect.Effect<ObservedBrokerSnapshot, BrokerReadError>
  readonly readForSubmit: (intentId: string) => Effect.Effect<ObservedBrokerSnapshot, BrokerReadError>
  readonly invalidate: Effect.Effect<void, BrokerReadError>
}
export class BrokerObservations extends Context.Service<BrokerObservations, BrokerObservationsShape>()(
  '@proompteng/bayn/broker/alpaca/BrokerObservations',
) {}

export const observedBrokerSnapshotHash = (value: ObservedBrokerSnapshot): string => canonicalHashV1(value)
