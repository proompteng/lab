import type { Undici } from '@effect/platform-node'
import { Context, Effect, Schema, type Result } from 'effect'

import type { BrokerEnvironment } from '../../execution/authority'
import {
  IsoDateSchema as IsoDate,
  StrictNonEmptyStringSchema as NonEmptyString,
  SymbolSchema as SymbolName,
} from '../../schemas'
import type { BrokerProvider } from '../connection'
import { BrokerReadError } from './failures'

export const defaultFillActivitiesPageSize = 100
const maxMarketCalendarRangeDays = 31
export const marketCalendarPreflightRangeDays = 14
const millisecondsPerDay = 86_400_000
export const accountConfigurationObservationSchemaVersion = 'bayn.alpaca-account-configuration-observation.v1' as const
export const accountConfigurationObservationSource = 'alpaca-v2-account-configurations' as const
export const assetObservationSchemaVersion = 'bayn.alpaca-asset-observation.v1' as const
export const assetObservationSource = 'alpaca-v2-asset' as const
export const marketCalendarSchemaVersion = 'bayn.alpaca-market-calendar-observation.v1' as const
export const marketCalendarSource = 'alpaca-v2-calendar' as const
export const marketCalendarTimeZone = 'America/New_York' as const
export const readPreflightTimeoutMs = 45_000
export const responseParseOptions = { onExcessProperty: 'ignore' } as const
export const inputParseOptions = { onExcessProperty: 'error' } as const
export const redactedHeaders = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'apca-api-key-id',
  'apca-api-secret-key',
] as const

export const U128_MAX = 340_282_366_920_938_463_463_374_607_431_768_211_455n
export const I128_MIN = -170_141_183_460_469_231_731_687_303_715_884_105_728n
export const I128_MAX = 170_141_183_460_469_231_731_687_303_715_884_105_727n

const Uuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
)
const Decimal = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$|^-[1-9][0-9]*(?:\.[0-9]+)?$/))
const isUtcTimestamp = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(value)
  if (match === null) return false
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  )
}
const Timestamp = Schema.String.check(Schema.makeFilter(isUtcTimestamp, { expected: 'an RFC 3339 UTC timestamp' }))
const ExternalClientOrderId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.makeFilter((value: string) => value.trim() === value, {
    expected: 'a non-empty client order ID without surrounding whitespace',
  }),
)
const ActivityId = Schema.String.check(
  Schema.isPattern(/^[^:]+::[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
)
const RequestId = NonEmptyString.check(Schema.isMaxLength(256))
const ErrorCode = Schema.Union([NonEmptyString.check(Schema.isMaxLength(64)), Schema.Int])
const ErrorMessage = NonEmptyString.check(Schema.isMaxLength(1_000))

export enum AccountStatus {
  AccountClosed = 'ACCOUNT_CLOSED',
  AccountUpdated = 'ACCOUNT_UPDATED',
  ActionRequired = 'ACTION_REQUIRED',
  Active = 'ACTIVE',
  AmlReview = 'AML_REVIEW',
  ApprovalPending = 'APPROVAL_PENDING',
  Approved = 'APPROVED',
  Disabled = 'DISABLED',
  DisablePending = 'DISABLE_PENDING',
  Edited = 'EDITED',
  Inactive = 'INACTIVE',
  KycSubmitted = 'KYC_SUBMITTED',
  Limited = 'LIMITED',
  Onboarding = 'ONBOARDING',
  PaperOnly = 'PAPER_ONLY',
  ReapprovalPending = 'REAPPROVAL_PENDING',
  Rejected = 'REJECTED',
  Resubmitted = 'RESUBMITTED',
  SignedUp = 'SIGNED_UP',
  SubmissionFailed = 'SUBMISSION_FAILED',
  Submitted = 'SUBMITTED',
}

export enum AssetClass {
  UsEquity = 'us_equity',
  UsOption = 'us_option',
  Crypto = 'crypto',
  CryptoPerpetual = 'crypto_perp',
}

export enum AssetExchange {
  Amex = 'AMEX',
  Arca = 'ARCA',
  Ascx = 'ASCX',
  Bats = 'BATS',
  Nyse = 'NYSE',
  Nasdaq = 'NASDAQ',
  NyseArca = 'NYSEARCA',
  Ftxu = 'FTXU',
  Coinbase = 'CBSE',
  Gnss = 'GNSS',
  Erisx = 'ERSX',
  Otc = 'OTC',
  Crypto = 'CRYPTO',
  Empty = '',
}

export enum AssetStatus {
  Active = 'active',
  Inactive = 'inactive',
}

export type AssetObservationExchange = Exclude<AssetExchange, AssetExchange.Empty>

export enum PositionSide {
  Long = 'long',
  Short = 'short',
}

export enum OrderClass {
  Simple = 'simple',
  MultiLeg = 'mleg',
  Bracket = 'bracket',
  OneCancelsOther = 'oco',
  OneTriggersOther = 'oto',
}

export enum OrderType {
  Market = 'market',
  Limit = 'limit',
  Stop = 'stop',
  StopLimit = 'stop_limit',
  TrailingStop = 'trailing_stop',
}

export enum OrderSide {
  Buy = 'buy',
  Sell = 'sell',
}

export enum TimeInForce {
  Day = 'day',
  GoodUntilCanceled = 'gtc',
  Opening = 'opg',
  Closing = 'cls',
  ImmediateOrCancel = 'ioc',
  FillOrKill = 'fok',
}

export enum OrderStatus {
  New = 'new',
  PartiallyFilled = 'partially_filled',
  Filled = 'filled',
  DoneForDay = 'done_for_day',
  Canceled = 'canceled',
  Expired = 'expired',
  Replaced = 'replaced',
  PendingCancel = 'pending_cancel',
  PendingReplace = 'pending_replace',
  PendingReview = 'pending_review',
  Accepted = 'accepted',
  PendingNew = 'pending_new',
  AcceptedForBidding = 'accepted_for_bidding',
  Stopped = 'stopped',
  Rejected = 'rejected',
  Suspended = 'suspended',
  Calculated = 'calculated',
  Held = 'held',
}

export enum OrderCollection {
  Open = 'open',
  Closed = 'closed',
  All = 'all',
}

export enum SortDirection {
  Ascending = 'asc',
  Descending = 'desc',
}

export enum TradeActivityType {
  Fill = 'fill',
  PartialFill = 'partial_fill',
}

export interface ProxyDispatcherDependencies {
  readonly create: (url: URL) => Undici.Dispatcher
  readonly destroy: (dispatcher: Undici.Dispatcher) => Promise<void>
}

export interface RateLimitEvidence {
  readonly limit?: string
  readonly remaining?: string
  readonly reset?: string
  readonly retryAfter?: string
}

export interface ReadEvidence {
  readonly requestId: string
  readonly status: number
  readonly contentHash: string
  readonly observedAt: string
  readonly rateLimit?: RateLimitEvidence
}

export interface ReadResult<A> {
  readonly value: A
  readonly evidence: ReadEvidence
}

export interface Account {
  readonly id: string
  readonly status: AccountStatus
  readonly currency: 'USD'
  readonly cashMicros: string
  readonly equityMicros: string
  readonly buyingPowerMicros: string
  readonly accountBlocked: boolean
  readonly tradingBlocked: boolean
  readonly tradeSuspendedByUser: boolean
  readonly observedAt: string
}

export interface AccountConfigurationObservation {
  readonly schemaVersion: typeof accountConfigurationObservationSchemaVersion
  readonly source: typeof accountConfigurationObservationSource
  readonly requestHash: string
  readonly fractionalTrading: boolean
  readonly observedAt: string
  readonly normalizedResponseHash: string
}

export interface Position {
  readonly accountId: string
  readonly assetId: string
  readonly symbol: string
  readonly exchange: AssetExchange
  readonly assetClass: AssetClass.UsEquity
  readonly side: PositionSide
  readonly quantityMicros: string
  readonly averageEntryPriceMicros: string
  readonly marketPriceMicros: string
  readonly marketValueMicros: string
  readonly unrealizedPnlMicros: string
  readonly observedAt: string
}

export interface Order {
  readonly accountId: string
  readonly brokerOrderId: string
  readonly clientOrderId: string
  readonly createdAt: string
  readonly updatedAt?: string
  readonly submittedAt?: string
  readonly filledAt?: string
  readonly expiredAt?: string
  readonly canceledAt?: string
  readonly failedAt?: string
  readonly replacedAt?: string
  readonly replacedBy?: string
  readonly replaces?: string
  readonly assetId: string
  readonly symbol: string
  readonly assetClass: AssetClass.UsEquity
  readonly quantityMicros?: string
  readonly notionalMicros?: string
  readonly filledQuantityMicros: string
  readonly filledAveragePriceMicros?: string
  readonly orderClass: OrderClass
  readonly orderType: OrderType
  readonly side: OrderSide
  readonly timeInForce: TimeInForce
  readonly limitPriceMicros?: string
  readonly stopPriceMicros?: string
  readonly status: OrderStatus
  readonly extendedHours: boolean
  readonly trailPercentMicros?: string
  readonly trailPriceMicros?: string
  readonly highWaterMarkMicros?: string
  readonly observedAt: string
}

export interface FillActivity {
  readonly accountId: string
  readonly activityId: string
  readonly cumulativeQuantityMicros: string
  readonly leavesQuantityMicros: string
  readonly priceMicros: string
  readonly quantityMicros: string
  readonly side: OrderSide
  readonly symbol: string
  readonly transactionTime: string
  readonly brokerOrderId: string
  readonly type: TradeActivityType
  readonly orderStatus?: OrderStatus
}

export interface FillActivityPage {
  readonly items: readonly FillActivity[]
  readonly nextPageToken?: string
}

export interface MarketCalendarQuery {
  readonly start: string
  readonly end: string
}

export interface AssetObservation {
  readonly schemaVersion: typeof assetObservationSchemaVersion
  readonly source: typeof assetObservationSource
  readonly requestedSymbol: string
  readonly requestHash: string
  readonly assetId: string
  readonly symbol: string
  readonly assetClass: AssetClass
  readonly exchange: AssetObservationExchange
  readonly status: AssetStatus
  readonly tradable: boolean
  readonly fractionable: boolean
  readonly attributes: readonly string[]
  readonly observedAt: string
  readonly normalizedResponseHash: string
}

export interface MarketCalendarSession {
  readonly date: string
  readonly openAt: string
  readonly closeAt: string
}

export interface MarketCalendarObservation {
  readonly schemaVersion: typeof marketCalendarSchemaVersion
  readonly source: typeof marketCalendarSource
  readonly requestedRange: {
    readonly start: string
    readonly end: string
  }
  readonly timeZone: 'UTC'
  readonly sessions: readonly MarketCalendarSession[]
  readonly normalizedResponseHash: string
}

export interface OrdersQuery {
  readonly status?: OrderCollection
  readonly limit?: number
  readonly after?: string
  readonly until?: string
  readonly direction?: SortDirection
  readonly side?: OrderSide
  readonly symbols?: readonly string[]
}

export interface FillActivitiesQuery {
  readonly date?: string
  readonly after?: string
  readonly until?: string
  readonly direction?: SortDirection
  readonly pageSize?: number
  readonly pageToken?: string
}

export interface BrokerReadShape {
  readonly account: Effect.Effect<ReadResult<Account>, BrokerReadError>
  readonly accountConfiguration: Effect.Effect<ReadResult<AccountConfigurationObservation>, BrokerReadError>
  readonly assetBySymbol: (symbol: string) => Effect.Effect<ReadResult<AssetObservation>, BrokerReadError>
  readonly positions: Effect.Effect<ReadResult<readonly Position[]>, BrokerReadError>
  readonly orders: (query?: OrdersQuery) => Effect.Effect<ReadResult<readonly Order[]>, BrokerReadError>
  readonly orderById: (orderId: string) => Effect.Effect<ReadResult<Order>, BrokerReadError>
  readonly orderByClientId: (clientOrderId: string) => Effect.Effect<ReadResult<Order>, BrokerReadError>
  readonly fillActivities: (query?: FillActivitiesQuery) => Effect.Effect<ReadResult<FillActivityPage>, BrokerReadError>
  readonly marketCalendar: (
    query: MarketCalendarQuery,
  ) => Effect.Effect<ReadResult<MarketCalendarObservation>, BrokerReadError>
}

export class BrokerRead extends Context.Service<BrokerRead, BrokerReadShape>()('bayn/BrokerRead') {}

export interface ReadPreflight {
  readonly provider: BrokerProvider
  readonly environment: BrokerEnvironment
  readonly baseUrl: string
  readonly accountId: string
  readonly accountStatus: AccountStatus.Active
  readonly accountBlocked: false
  readonly tradingBlocked: false
  readonly tradeSuspendedByUser: false
  readonly accountHash: string
  readonly fractionalTrading: true
  readonly accountConfigurationHash: string
  readonly positionCount: number
  readonly positionsHash: string
  readonly openOrderCount: number
  readonly recentOrderCount: number
  readonly ordersHash: string
  readonly fillCount: number
  readonly fillsHash: string
  readonly marketCalendarSessionCount: number
  readonly marketCalendarHash: string
  readonly orderById: 'MATCHED' | 'NOT_FOUND'
  readonly orderByClientId: 'MATCHED' | 'NOT_FOUND'
}

export const AccountResponseSchema = Schema.Struct({
  id: Uuid,
  account_number: NonEmptyString,
  status: Schema.Enum(AccountStatus),
  currency: Schema.Literal('USD'),
  cash: Decimal,
  equity: Decimal,
  buying_power: Decimal,
  account_blocked: Schema.Boolean,
  trading_blocked: Schema.Boolean,
  trade_suspended_by_user: Schema.Boolean,
})

export const AccountConfigurationResponseSchema = Schema.Struct({
  fractional_trading: Schema.Boolean,
})

export const PositionResponseSchema = Schema.Struct({
  asset_id: Uuid,
  symbol: SymbolName,
  exchange: Schema.Enum(AssetExchange),
  asset_class: Schema.Enum(AssetClass),
  avg_entry_price: Decimal,
  qty: Decimal,
  side: Schema.Enum(PositionSide),
  market_value: Decimal,
  unrealized_pl: Decimal,
  current_price: Decimal,
})

export const AssetResponseSchema = Schema.Struct({
  id: Uuid,
  class: Schema.Enum(AssetClass),
  exchange: Schema.Union([
    Schema.Literal(AssetExchange.Amex),
    Schema.Literal(AssetExchange.Arca),
    Schema.Literal(AssetExchange.Ascx),
    Schema.Literal(AssetExchange.Bats),
    Schema.Literal(AssetExchange.Nyse),
    Schema.Literal(AssetExchange.Nasdaq),
    Schema.Literal(AssetExchange.NyseArca),
    Schema.Literal(AssetExchange.Ftxu),
    Schema.Literal(AssetExchange.Coinbase),
    Schema.Literal(AssetExchange.Gnss),
    Schema.Literal(AssetExchange.Erisx),
    Schema.Literal(AssetExchange.Otc),
    Schema.Literal(AssetExchange.Crypto),
  ]),
  symbol: SymbolName,
  status: Schema.Enum(AssetStatus),
  tradable: Schema.Boolean,
  fractionable: Schema.Boolean,
  attributes: Schema.optionalKey(Schema.NullOr(Schema.Array(NonEmptyString))),
})

export const OrderResponseSchema = Schema.Struct({
  id: Uuid,
  client_order_id: ExternalClientOrderId,
  created_at: Timestamp,
  updated_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  submitted_at: Schema.optionalKey(Schema.NullOr(Timestamp)),
  filled_at: Schema.NullOr(Timestamp),
  expired_at: Schema.NullOr(Timestamp),
  canceled_at: Schema.NullOr(Timestamp),
  failed_at: Schema.NullOr(Timestamp),
  replaced_at: Schema.NullOr(Timestamp),
  replaced_by: Schema.NullOr(Uuid),
  replaces: Schema.NullOr(Uuid),
  asset_id: Uuid,
  symbol: SymbolName,
  asset_class: Schema.Enum(AssetClass),
  notional: Schema.NullOr(Decimal),
  qty: Schema.NullOr(Decimal),
  filled_qty: Decimal,
  filled_avg_price: Schema.NullOr(Decimal),
  order_class: Schema.Union([Schema.Literal(''), Schema.Enum(OrderClass)]),
  order_type: Schema.optionalKey(Schema.Enum(OrderType)),
  type: Schema.Enum(OrderType),
  side: Schema.Enum(OrderSide),
  time_in_force: Schema.Enum(TimeInForce),
  limit_price: Schema.NullOr(Decimal),
  stop_price: Schema.NullOr(Decimal),
  status: Schema.Enum(OrderStatus),
  extended_hours: Schema.Boolean,
  legs: Schema.Null,
  trail_percent: Schema.NullOr(Decimal),
  trail_price: Schema.NullOr(Decimal),
  hwm: Schema.NullOr(Decimal),
})

export const FillActivityResponseSchema = Schema.Struct({
  activity_type: Schema.Literal('FILL'),
  id: ActivityId,
  account_id: Schema.optionalKey(Uuid),
  cum_qty: Decimal,
  leaves_qty: Decimal,
  price: Decimal,
  qty: Decimal,
  side: Schema.Enum(OrderSide),
  symbol: SymbolName,
  transaction_time: Timestamp,
  order_id: Uuid,
  type: Schema.Enum(TradeActivityType),
  order_status: Schema.optionalKey(Schema.Enum(OrderStatus)),
})

const MarketTimeSchema = Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/))
export const MarketCalendarResponseSchema = Schema.Array(
  Schema.Struct({
    date: IsoDate,
    open: MarketTimeSchema,
    close: MarketTimeSchema,
  }),
)

export const ResponseHeadersSchema = Schema.Struct({
  'x-request-id': RequestId,
  'x-ratelimit-limit': Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d+$/))),
  'x-ratelimit-remaining': Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d+$/))),
  'x-ratelimit-reset': Schema.optionalKey(NonEmptyString),
  'retry-after': Schema.optionalKey(NonEmptyString),
})

export const ErrorResponseSchema = Schema.Struct({
  code: ErrorCode,
  message: ErrorMessage,
})

const OrdersQuerySchema = Schema.Struct({
  status: Schema.optionalKey(Schema.Enum(OrderCollection)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
  after: Schema.optionalKey(Timestamp),
  until: Schema.optionalKey(Timestamp),
  direction: Schema.optionalKey(Schema.Enum(SortDirection)),
  side: Schema.optionalKey(Schema.Enum(OrderSide)),
  symbols: Schema.optionalKey(
    Schema.Array(SymbolName).check(Schema.isMinLength(1), Schema.isUnique(), Schema.isMaxLength(500)),
  ),
})

const FillActivitiesQueryBase = Schema.Struct({
  date: Schema.optionalKey(IsoDate),
  after: Schema.optionalKey(Timestamp),
  until: Schema.optionalKey(Timestamp),
  direction: Schema.optionalKey(Schema.Enum(SortDirection)),
  pageSize: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  pageToken: Schema.optionalKey(ActivityId),
})
const FillActivitiesQuerySchema = FillActivitiesQueryBase.check(
  Schema.makeFilter((query: typeof FillActivitiesQueryBase.Type) =>
    query.date !== undefined && (query.after !== undefined || query.until !== undefined)
      ? [{ path: ['date'], issue: 'cannot be combined with after or until' }]
      : [],
  ),
)

export const MarketCalendarQueryBase = Schema.Struct({
  start: IsoDate,
  end: IsoDate,
})
const MarketCalendarQuerySchema = MarketCalendarQueryBase.check(
  Schema.makeFilter((query: typeof MarketCalendarQueryBase.Type) => {
    if (query.start > query.end) {
      return [{ path: ['end'], issue: 'must be on or after start' }]
    }
    const inclusiveDays =
      (Date.parse(`${query.end}T00:00:00.000Z`) - Date.parse(`${query.start}T00:00:00.000Z`)) / millisecondsPerDay + 1
    return inclusiveDays > maxMarketCalendarRangeDays
      ? [{ path: ['end'], issue: `range must not exceed ${maxMarketCalendarRangeDays} inclusive calendar days` }]
      : []
  }),
)

export type Decoder<A> = (input: unknown) => Result.Result<A, Schema.SchemaError>

export const decodeAccount = Schema.decodeUnknownResult(AccountResponseSchema, responseParseOptions)
export const decodeAccountConfiguration = Schema.decodeUnknownResult(
  AccountConfigurationResponseSchema,
  responseParseOptions,
)
export const decodeAsset = Schema.decodeUnknownResult(AssetResponseSchema, responseParseOptions)
export const decodePositions = Schema.decodeUnknownResult(Schema.Array(PositionResponseSchema), responseParseOptions)
export const decodeOrders = Schema.decodeUnknownResult(Schema.Array(OrderResponseSchema), responseParseOptions)
export const decodeOrder = Schema.decodeUnknownResult(OrderResponseSchema, responseParseOptions)
export const decodeFillActivities = Schema.decodeUnknownResult(
  Schema.Array(FillActivityResponseSchema),
  responseParseOptions,
)
export const decodeMarketCalendar = Schema.decodeUnknownResult(MarketCalendarResponseSchema, responseParseOptions)
export const decodeErrorResponse = Schema.decodeUnknownResult(ErrorResponseSchema, responseParseOptions)
export const decodeOrdersQuery = Schema.decodeUnknownResult(OrdersQuerySchema, inputParseOptions)
export const decodeFillActivitiesQuery = Schema.decodeUnknownResult(FillActivitiesQuerySchema, inputParseOptions)
export const decodeMarketCalendarQuery = Schema.decodeUnknownResult(MarketCalendarQuerySchema, inputParseOptions)
export const decodeAssetSymbol = Schema.decodeUnknownResult(SymbolName)
export const decodeOrderId = Schema.decodeUnknownResult(Uuid)
export const decodeExternalClientOrderId = Schema.decodeUnknownResult(ExternalClientOrderId)
