import { ObservedFeeActivitySchema } from '../fee-activity'
import { Context, Effect, Schema } from 'effect'

import { Sha256Schema, UtcInstantSchema, UtcSourceTimestampSchema, strictParseOptions } from '../../schemas'
import { BrokerReadError, BrokerReadErrorKind } from './failures'
import { CashReportingQuantumSchema } from './cash-reporting'
import { CryptoFeeTierSchema } from '../crypto-fees'
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

export const maximumBrokerObservationAgeMs = 60_000

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
  cashReportingQuantumMicros: CashReportingQuantumSchema,
  equityMicros: micros,
  lastEquityMicros: micros,
  cryptoStatus: Schema.NullOr(Schema.String),
  cryptoFeeTier: Schema.NullOr(CryptoFeeTierSchema),
  nonMarginableBuyingPowerMicros: Schema.NullOr(micros),
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
  assetClass: Schema.Literals([AssetClass.UsEquity, AssetClass.Crypto]),
  side: Schema.Enum(PositionSide),
  quantityAtoms: micros,
  averageEntryPriceMicros: micros,
  costBasisMicros: micros,
  marketPriceMicros: micros,
  marketValueMicros: micros,
  unrealizedPnlMicros: micros,
  observedAt: UtcInstantSchema,
})
const orderLeaf = Schema.Struct({
  accountId: Schema.String,
  brokerOrderId: Schema.String,
  parentBrokerOrderId: Schema.optionalKey(Schema.String),
  clientOrderId: Schema.String,
  createdAt: UtcSourceTimestampSchema,
  updatedAt: Schema.optionalKey(UtcSourceTimestampSchema),
  submittedAt: Schema.optionalKey(UtcSourceTimestampSchema),
  filledAt: Schema.optionalKey(UtcSourceTimestampSchema),
  expiredAt: Schema.optionalKey(UtcSourceTimestampSchema),
  canceledAt: Schema.optionalKey(UtcSourceTimestampSchema),
  failedAt: Schema.optionalKey(UtcSourceTimestampSchema),
  replacedAt: Schema.optionalKey(UtcSourceTimestampSchema),
  replacedBy: Schema.optionalKey(Schema.String),
  replaces: Schema.optionalKey(Schema.String),
  assetId: Schema.String,
  symbol: Schema.String,
  assetClass: Schema.Literals([AssetClass.UsEquity, AssetClass.Crypto]),
  quantityAtoms: Schema.optionalKey(micros),
  notionalMicros: Schema.optionalKey(micros),
  filledQuantityAtoms: micros,
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
const order = Schema.Struct({
  ...orderLeaf.fields,
  legs: Schema.optionalKey(Schema.Array(orderLeaf).check(Schema.isMaxLength(2))),
})
const fill = Schema.Struct({
  accountId: Schema.String,
  activityId: Schema.String,
  cumulativeQuantityAtoms: micros,
  leavesQuantityAtoms: micros,
  priceAtoms: micros,
  quantityAtoms: micros,
  side: Schema.Enum(OrderSide),
  symbol: Schema.String,
  transactionTime: UtcSourceTimestampSchema,
  brokerOrderId: Schema.String,
  type: Schema.Enum(TradeActivityType),
  orderStatus: Schema.optionalKey(Schema.Enum(OrderStatus)),
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
      fees: Schema.Array(observed(ObservedFeeActivitySchema)),
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

export const ObservedBrokerStateSchema = Schema.Struct({
  ...ObservedBrokerSnapshotSchema.fields,
  snapshot: Schema.Struct({
    account: ObservedBrokerSnapshotSchema.fields.snapshot.fields.account,
    positions: ObservedBrokerSnapshotSchema.fields.snapshot.fields.positions,
  }),
}) satisfies Schema.Schema<ObservedBrokerState>
export type ObservedBrokerState = Omit<ObservedBrokerSnapshot, 'snapshot'> & {
  readonly snapshot: Pick<StableBrokerSnapshot, 'account' | 'positions'>
}

export const observedBrokerState = (value: ObservedBrokerSnapshot): ObservedBrokerState => ({
  snapshot: { account: value.snapshot.account, positions: value.snapshot.positions },
  configuration: value.configuration,
  openOrders: value.openOrders,
  recentOrders: value.recentOrders,
  recentFills: value.recentFills,
  startedAt: value.startedAt,
  completedAt: value.completedAt,
  observedAt: value.observedAt,
})

export const decodeObservedBrokerSnapshot = Schema.decodeUnknownResult(ObservedBrokerSnapshotSchema, strictParseOptions)

export const observationUnavailable = (message: string, cause?: unknown): BrokerReadError =>
  new BrokerReadError({
    operation: 'preflight',
    kind: BrokerReadErrorKind.Timeout,
    retryable: true,
    message,
    ...(cause === undefined ? {} : { cause }),
  })

export const observationTimes = (value: ObservedBrokerState): readonly string[] => [
  value.startedAt,
  value.completedAt,
  value.observedAt,
  value.snapshot.account.evidence.observedAt,
  value.snapshot.account.value.observedAt,
  value.snapshot.positions.evidence.observedAt,
  value.configuration.evidence.observedAt,
  value.configuration.value.observedAt,
  value.openOrders.evidence.observedAt,
  value.recentOrders.evidence.observedAt,
  value.recentFills.evidence.observedAt,
  ...value.snapshot.positions.value.map((row) => row.observedAt),
]

const stateAccounts = (value: ObservedBrokerState): readonly string[] => [
  value.snapshot.account.value.id,
  ...value.snapshot.positions.value.map((row) => row.accountId),
  ...value.openOrders.value.map((row) => row.accountId),
  ...value.recentOrders.value.map((row) => row.accountId),
  ...value.recentFills.value.items.map((row) => row.accountId),
]

const validateObservedBrokerCut = <A extends ObservedBrokerState>(
  value: A,
  observedTimes: readonly string[],
  accounts: readonly string[],
  accountId: string,
  now: string,
  maximumAgeMs: number,
): Effect.Effect<A, BrokerReadError> =>
  Effect.suspend(() => {
    const current = Date.parse(now)
    const times = observedTimes.map(Date.parse)
    const ageMs = current - Math.min(...times)
    const reason =
      !Number.isFinite(current) ||
      !Number.isFinite(maximumAgeMs) ||
      maximumAgeMs <= 0 ||
      times.some((at) => !Number.isFinite(at))
        ? 'invalid-clock'
        : accounts.some((id) => id !== accountId)
          ? 'account-mismatch'
          : times.some((at) => at > current)
            ? 'future-observation'
            : Date.parse(value.completedAt) < Date.parse(value.startedAt) ||
                Date.parse(value.observedAt) !== Math.min(...times)
              ? 'invalid-chronology'
              : ageMs >= maximumAgeMs
                ? 'stale-observation'
                : undefined
    if (reason !== undefined)
      return Effect.logWarning('Broker observation rejected').pipe(
        Effect.annotateLogs({ reason, observedAt: value.observedAt, checkedAt: now, ageMs, maximumAgeMs }),
        Effect.andThen(Effect.fail(observationUnavailable(`Broker observation rejected: ${reason}`))),
      )
    return Effect.succeed(value)
  })

export const validateObservedBrokerState = (
  value: ObservedBrokerState,
  accountId: string,
  now: string,
  maximumAgeMs: number,
) => validateObservedBrokerCut(value, observationTimes(value), stateAccounts(value), accountId, now, maximumAgeMs)

export const validateObservedBrokerSnapshot = (
  value: ObservedBrokerSnapshot,
  accountId: string,
  now: string,
  maximumAgeMs: number,
) =>
  validateObservedBrokerCut(
    value,
    [...observationTimes(value), value.snapshot.history.orders.observedAt],
    [
      ...stateAccounts(value),
      ...value.snapshot.history.orders.rows.map((row) => row.value.accountId),
      ...value.snapshot.history.fills.map((row) => row.value.accountId),
      ...value.snapshot.history.fees.map((row) => row.value.accountId),
    ],
    accountId,
    now,
    maximumAgeMs,
  )

export interface BrokerObservationTicket {
  readonly generation: number
  readonly startedAt: string
}
export interface BrokerObservationsShape {
  readonly read: Effect.Effect<ObservedBrokerSnapshot, BrokerReadError>
  readonly readState: Effect.Effect<ObservedBrokerState, BrokerReadError>
  readonly readForSubmit: (intentId: string) => Effect.Effect<ObservedBrokerState, BrokerReadError>
  readonly invalidate: Effect.Effect<void, BrokerReadError>
}
export class BrokerObservations extends Context.Service<BrokerObservations, BrokerObservationsShape>()(
  '@proompteng/bayn/broker/alpaca/BrokerObservations',
) {}
