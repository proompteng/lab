import { NodeHttpClient, Undici } from '@effect/platform-node'
import { Cause, Clock, Context, Data, DateTime, Effect, Layer, Redacted, Schema, Scope } from 'effect'
import { Headers, HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'

import { canonicalHashV1 } from '../hash'
import {
  IsoDateSchema as IsoDate,
  StrictNonEmptyStringSchema as NonEmptyString,
  SymbolSchema as SymbolName,
} from '../schemas'

export const paperTradingUrl = 'https://paper-api.alpaca.markets'
const defaultFillActivitiesPageSize = 100
const maxMarketCalendarRangeDays = 31
const marketCalendarPreflightRangeDays = 14
const millisecondsPerDay = 86_400_000
const accountConfigurationObservationSchemaVersion = 'bayn.alpaca-account-configuration-observation.v1' as const
const accountConfigurationObservationSource = 'alpaca-v2-account-configurations' as const
const assetObservationSchemaVersion = 'bayn.alpaca-asset-observation.v1' as const
const assetObservationSource = 'alpaca-v2-asset' as const
const marketCalendarSchemaVersion = 'bayn.alpaca-market-calendar-observation.v1' as const
const marketCalendarSource = 'alpaca-v2-calendar' as const
const marketCalendarTimeZone = 'America/New_York' as const
export const readPreflightTimeoutMs = 45_000
const responseParseOptions = { onExcessProperty: 'ignore' } as const
const inputParseOptions = { onExcessProperty: 'error' } as const
const redactedHeaders = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'apca-api-key-id',
  'apca-api-secret-key',
] as const

const U128_MAX = 340_282_366_920_938_463_463_374_607_431_768_211_455n
const I128_MIN = -170_141_183_460_469_231_731_687_303_715_884_105_728n
const I128_MAX = 170_141_183_460_469_231_731_687_303_715_884_105_727n

const Uuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
)
const Decimal = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$|^-[1-9][0-9]*(?:\.[0-9]+)?$/))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
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

export enum BrokerReadErrorKind {
  Configuration = 'CONFIGURATION',
  Transport = 'TRANSPORT',
  Timeout = 'TIMEOUT',
  Authentication = 'AUTHENTICATION',
  Forbidden = 'FORBIDDEN',
  NotFound = 'NOT_FOUND',
  RateLimited = 'RATE_LIMITED',
  Server = 'SERVER',
  HttpStatus = 'HTTP_STATUS',
  InvalidRequest = 'INVALID_REQUEST',
  InvalidResponse = 'INVALID_RESPONSE',
  AccountMismatch = 'ACCOUNT_MISMATCH',
}

export type BrokerReadOperation =
  | 'configuration'
  | 'proxy'
  | 'preflight'
  | 'account'
  | 'account-configuration'
  | 'positions'
  | 'orders'
  | 'order-by-id'
  | 'order-by-client-id'
  | 'fill-activities'
  | 'asset-by-symbol'
  | 'market-calendar'

export class BrokerReadError extends Data.TaggedError('BrokerReadError')<{
  readonly operation: BrokerReadOperation
  readonly kind: BrokerReadErrorKind
  readonly message: string
  readonly retryable: boolean
  readonly status?: number
  readonly requestId?: string
  readonly contentHash?: string
  readonly observedAt?: string
  readonly cause?: unknown
}> {}

export interface ReadOptions {
  readonly expectedAccountId: string
  readonly key: Redacted.Redacted<string>
  readonly secret: Redacted.Redacted<string>
  readonly proxyUrl: string
  readonly operationTimeoutMs: number
  readonly retryAttempts: number
}

interface ProxyDispatcherDependencies {
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
  readonly accountId: string
  readonly accountHash: string
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

const AccountResponseSchema = Schema.Struct({
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

const AccountConfigurationResponseSchema = Schema.Struct({
  fractional_trading: Schema.Boolean,
})

const PositionResponseSchema = Schema.Struct({
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

const AssetResponseSchema = Schema.Struct({
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

const FillActivityResponseSchema = Schema.Struct({
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
const MarketCalendarResponseSchema = Schema.Array(
  Schema.Struct({
    date: IsoDate,
    open: MarketTimeSchema,
    close: MarketTimeSchema,
  }),
)

const ResponseHeadersSchema = Schema.Struct({
  'x-request-id': RequestId,
  'x-ratelimit-limit': Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d+$/))),
  'x-ratelimit-remaining': Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d+$/))),
  'x-ratelimit-reset': Schema.optionalKey(NonEmptyString),
  'retry-after': Schema.optionalKey(NonEmptyString),
})

const ErrorResponseSchema = Schema.Struct({
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

const MarketCalendarQueryBase = Schema.Struct({
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

const RuntimeOptionsSchema = Schema.Struct({
  expectedAccountId: Uuid,
  operationTimeoutMs: PositiveInteger,
  retryAttempts: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
})

type Decoder<A> = (input: unknown) => Effect.Effect<A, unknown>

const decodeAccount = Schema.decodeUnknownEffect(AccountResponseSchema, responseParseOptions)
const decodeAccountConfiguration = Schema.decodeUnknownEffect(AccountConfigurationResponseSchema, responseParseOptions)
const decodeAsset = Schema.decodeUnknownEffect(AssetResponseSchema, responseParseOptions)
const decodePositions = Schema.decodeUnknownEffect(Schema.Array(PositionResponseSchema), responseParseOptions)
const decodeOrders = Schema.decodeUnknownEffect(Schema.Array(OrderResponseSchema), responseParseOptions)
const decodeOrder = Schema.decodeUnknownEffect(OrderResponseSchema, responseParseOptions)
const decodeFillActivities = Schema.decodeUnknownEffect(Schema.Array(FillActivityResponseSchema), responseParseOptions)
const decodeMarketCalendar = Schema.decodeUnknownEffect(MarketCalendarResponseSchema, responseParseOptions)
const decodeResponseHeaders = HttpClientResponse.schemaHeaders(ResponseHeadersSchema, responseParseOptions)
const decodeErrorResponse = Schema.decodeUnknownEffect(ErrorResponseSchema, responseParseOptions)
const decodeOrdersQuery = Schema.decodeUnknownEffect(OrdersQuerySchema, inputParseOptions)
const decodeFillActivitiesQuery = Schema.decodeUnknownEffect(FillActivitiesQuerySchema, inputParseOptions)
const decodeMarketCalendarQuery = Schema.decodeUnknownEffect(MarketCalendarQuerySchema, inputParseOptions)
const decodeAssetSymbol = Schema.decodeUnknownEffect(SymbolName)
const decodeOrderId = Schema.decodeUnknownEffect(Uuid)
const decodeExternalClientOrderId = Schema.decodeUnknownEffect(ExternalClientOrderId)
const decodeRuntimeOptions = Schema.decodeUnknownEffect(RuntimeOptionsSchema, inputParseOptions)

const redactDiagnostic = (value: string, sensitiveValues: readonly string[]): string =>
  sensitiveValues.reduce(
    (redacted, sensitive) => (sensitive.length === 0 ? redacted : redacted.replaceAll(sensitive, '<redacted>')),
    value,
  )

const safeCause = (cause: unknown, sensitiveValues: readonly string[] = []): Readonly<Record<string, string>> => {
  if (Schema.isSchemaError(cause)) {
    return { tag: cause._tag, message: redactDiagnostic(cause.message, sensitiveValues) }
  }
  if (HttpClientError.isHttpClientError(cause)) {
    const detail =
      'cause' in cause.reason && cause.reason.cause instanceof Error ? cause.reason.cause.message : undefined
    return {
      tag: cause._tag,
      reason: cause.reason._tag,
      message: redactDiagnostic(cause.message, sensitiveValues),
      ...(detail === undefined ? {} : { detail: redactDiagnostic(detail, sensitiveValues) }),
    }
  }
  if (cause instanceof Error) {
    const message = typeof cause.message === 'string' ? redactDiagnostic(cause.message, sensitiveValues) : undefined
    const code =
      'code' in cause && (typeof cause.code === 'string' || typeof cause.code === 'number')
        ? String(cause.code)
        : undefined
    return {
      tag: cause.name,
      ...(message === undefined ? {} : { message }),
      ...(code === undefined ? {} : { code }),
    }
  }
  if (typeof cause === 'object' && cause !== null && '_tag' in cause && typeof cause._tag === 'string') {
    const message =
      'message' in cause && typeof cause.message === 'string'
        ? redactDiagnostic(cause.message, sensitiveValues)
        : undefined
    return { tag: cause._tag, ...(message === undefined ? {} : { message }) }
  }
  return { tag: typeof cause }
}

const configurationError = (operation: 'configuration' | 'proxy', message: string, cause?: unknown): BrokerReadError =>
  new BrokerReadError({
    operation,
    kind: BrokerReadErrorKind.Configuration,
    message,
    retryable: false,
    cause: cause === undefined ? undefined : safeCause(cause),
  })

const invalidResponse = (
  operation: BrokerReadOperation,
  message: string,
  evidence?: Partial<ReadEvidence>,
  cause?: unknown,
): BrokerReadError =>
  new BrokerReadError({
    operation,
    kind: BrokerReadErrorKind.InvalidResponse,
    message,
    retryable: false,
    status: evidence?.status,
    requestId: evidence?.requestId,
    contentHash: evidence?.contentHash,
    observedAt: evidence?.observedAt,
    cause: cause === undefined ? undefined : safeCause(cause),
  })

const invalidRequest = (operation: BrokerReadOperation, message: string, cause: unknown): BrokerReadError =>
  new BrokerReadError({
    operation,
    kind: BrokerReadErrorKind.InvalidRequest,
    message,
    retryable: false,
    cause: safeCause(cause),
  })

const transportError = (
  operation: BrokerReadOperation,
  cause: unknown,
  sensitiveValues: readonly string[],
): BrokerReadError =>
  new BrokerReadError({
    operation,
    kind: BrokerReadErrorKind.Transport,
    message: `Alpaca ${operation} request failed before a response was available`,
    retryable: true,
    cause: safeCause(cause, sensitiveValues),
  })

const statusError = (
  operation: BrokerReadOperation,
  status: number,
  requestId: string,
  contentHash: string,
  observedAt: string,
  code: string | number,
  detail: string,
): BrokerReadError => {
  const kind =
    status === 401
      ? BrokerReadErrorKind.Authentication
      : status === 403
        ? BrokerReadErrorKind.Forbidden
        : status === 404
          ? BrokerReadErrorKind.NotFound
          : status === 429
            ? BrokerReadErrorKind.RateLimited
            : status >= 500
              ? BrokerReadErrorKind.Server
              : BrokerReadErrorKind.HttpStatus
  return new BrokerReadError({
    operation,
    kind,
    message: `Alpaca ${operation} returned HTTP ${status} (${String(code)}): ${detail}`,
    retryable: status === 429 || status >= 500,
    status,
    requestId,
    contentHash,
    observedAt,
  })
}

const timeoutError = (
  operation: BrokerReadOperation,
  timeoutMs: number,
  cause: unknown,
  sensitiveValues: readonly string[],
): BrokerReadError =>
  new BrokerReadError({
    operation,
    kind: BrokerReadErrorKind.Timeout,
    message: `Alpaca ${operation} exceeded its ${timeoutMs}ms deadline`,
    retryable: true,
    cause: safeCause(cause, sensitiveValues),
  })

const decimalToMicros = (value: string, signed: boolean, name: string): string => {
  const negative = value.startsWith('-')
  const absolute = negative ? value.slice(1) : value
  const separator = absolute.indexOf('.')
  const whole = separator === -1 ? absolute : absolute.slice(0, separator)
  const fraction = separator === -1 ? '' : absolute.slice(separator + 1)
  if (fraction.length > 6 && /[1-9]/.test(fraction.slice(6))) {
    throw new Error(`${name} cannot be represented exactly as decimal micros`)
  }
  const micros = BigInt(whole) * 1_000_000n + BigInt((fraction.slice(0, 6) + '000000').slice(0, 6))
  const result = negative ? -micros : micros
  if (!signed && result < 0n) throw new Error(`${name} must be non-negative`)
  if (signed ? result < I128_MIN || result > I128_MAX : result > U128_MAX) {
    throw new Error(`${name} exceeds the decimal micros range`)
  }
  return result.toString()
}

const positiveMicros = (value: string, name: string): string => {
  const micros = decimalToMicros(value, false, name)
  if (micros === '0') throw new Error(`${name} must be positive`)
  return micros
}

const optionalTimestamp = (value: string | null): string | undefined => value ?? undefined

const optionalMicros = (value: string | null, signed: boolean, name: string): string | undefined =>
  value === null ? undefined : decimalToMicros(value, signed, name)

const positionMicros = (value: string, side: PositionSide, name: string): string => {
  const decoded = BigInt(decimalToMicros(value, true, name))
  if (decoded === 0n) throw new Error(`${name} must be non-zero`)
  const magnitude = decoded < 0n ? -decoded : decoded
  const normalized = side === PositionSide.Short ? -magnitude : magnitude
  if (normalized < I128_MIN || normalized > I128_MAX) throw new Error(`${name} exceeds the decimal micros range`)
  return normalized.toString()
}

const normalizeAccount = (
  raw: typeof AccountResponseSchema.Type,
  expectedAccountId: string,
  observedAt: string,
): Account => {
  if (raw.id !== expectedAccountId)
    throw new Error(`credential resolved account ${raw.id}, expected ${expectedAccountId}`)
  return {
    id: raw.id,
    status: raw.status,
    currency: raw.currency,
    cashMicros: decimalToMicros(raw.cash, true, 'account cash'),
    equityMicros: decimalToMicros(raw.equity, true, 'account equity'),
    buyingPowerMicros: decimalToMicros(raw.buying_power, true, 'account buying power'),
    accountBlocked: raw.account_blocked,
    tradingBlocked: raw.trading_blocked,
    tradeSuspendedByUser: raw.trade_suspended_by_user,
    observedAt,
  }
}

const accountConfigurationRequestMaterial = {
  schemaVersion: accountConfigurationObservationSchemaVersion,
  source: accountConfigurationObservationSource,
  method: 'GET',
  path: '/v2/account/configurations',
} as const

const normalizeAccountConfiguration = (
  raw: typeof AccountConfigurationResponseSchema.Type,
  observedAt: string,
): AccountConfigurationObservation => {
  const normalized = {
    schemaVersion: accountConfigurationObservationSchemaVersion,
    source: accountConfigurationObservationSource,
    requestHash: canonicalHashV1(accountConfigurationRequestMaterial),
    fractionalTrading: raw.fractional_trading,
  }
  return {
    ...normalized,
    observedAt,
    normalizedResponseHash: canonicalHashV1(normalized),
  }
}

const normalizePosition = (
  raw: typeof PositionResponseSchema.Type,
  accountId: string,
  observedAt: string,
): Position => {
  if (raw.asset_class !== AssetClass.UsEquity) throw new Error(`unsupported position asset class ${raw.asset_class}`)
  const quantityMicros = positionMicros(raw.qty, raw.side, 'position quantity')
  const marketValueMicros = positionMicros(raw.market_value, raw.side, 'market value')
  return {
    accountId,
    assetId: raw.asset_id,
    symbol: raw.symbol,
    exchange: raw.exchange,
    assetClass: raw.asset_class,
    side: raw.side,
    quantityMicros,
    averageEntryPriceMicros: positiveMicros(raw.avg_entry_price, 'average entry price'),
    marketPriceMicros: positiveMicros(raw.current_price, 'current price'),
    marketValueMicros,
    unrealizedPnlMicros: decimalToMicros(raw.unrealized_pl, true, 'unrealized PnL'),
    observedAt,
  }
}

const assetRequestMaterial = (requestedSymbol: string) => ({
  schemaVersion: assetObservationSchemaVersion,
  source: assetObservationSource,
  method: 'GET' as const,
  path: `/v2/assets/${encodeURIComponent(requestedSymbol)}`,
  requestedSymbol,
})

const normalizeAsset = (
  raw: typeof AssetResponseSchema.Type,
  requestedSymbol: string,
  observedAt: string,
): AssetObservation => {
  if (raw.symbol !== requestedSymbol) {
    throw new Error(`asset lookup returned symbol ${raw.symbol}, expected ${requestedSymbol}`)
  }
  const requestHash = canonicalHashV1(assetRequestMaterial(requestedSymbol))
  const normalized = {
    schemaVersion: assetObservationSchemaVersion,
    source: assetObservationSource,
    requestedSymbol,
    requestHash,
    assetId: raw.id,
    symbol: raw.symbol,
    assetClass: raw.class,
    exchange: raw.exchange,
    status: raw.status,
    tradable: raw.tradable,
    fractionable: raw.fractionable,
    attributes: [...new Set(raw.attributes ?? [])].sort(),
  }
  return {
    ...normalized,
    observedAt,
    normalizedResponseHash: canonicalHashV1(normalized),
  }
}

export const normalizeOrder = (raw: typeof OrderResponseSchema.Type, accountId: string, observedAt: string): Order => {
  if (raw.asset_class !== AssetClass.UsEquity) throw new Error(`unsupported order asset class ${raw.asset_class}`)
  if ((raw.qty === null) === (raw.notional === null))
    throw new Error('order must contain exactly one of qty or notional')
  if (raw.order_type !== undefined && raw.order_type !== raw.type) {
    throw new Error('deprecated order_type does not match type')
  }
  if (raw.order_class === OrderClass.MultiLeg) throw new Error('multi-leg orders are outside the Bayn equity contract')

  const quantityMicros = raw.qty === null ? undefined : positiveMicros(raw.qty, 'order quantity')
  const notionalMicros = raw.notional === null ? undefined : positiveMicros(raw.notional, 'order notional')
  const filledQuantityMicros = decimalToMicros(raw.filled_qty, false, 'filled quantity')
  if (quantityMicros !== undefined && BigInt(filledQuantityMicros) > BigInt(quantityMicros)) {
    throw new Error('filled quantity exceeds order quantity')
  }
  if (raw.order_type === OrderType.Limit && raw.limit_price === null) {
    throw new Error('limit order is missing limit_price')
  }
  if (raw.order_type === OrderType.Stop && raw.stop_price === null) {
    throw new Error('stop order is missing stop_price')
  }
  if (raw.order_type === OrderType.StopLimit && (raw.limit_price === null || raw.stop_price === null)) {
    throw new Error('stop-limit order is missing limit_price or stop_price')
  }
  if (raw.order_type === OrderType.TrailingStop && (raw.trail_price === null) === (raw.trail_percent === null)) {
    throw new Error('trailing-stop order must contain exactly one trailing offset')
  }

  const filledAt = optionalTimestamp(raw.filled_at)
  const updatedAt = raw.updated_at ?? undefined
  const submittedAt = raw.submitted_at ?? undefined
  const expiredAt = optionalTimestamp(raw.expired_at)
  const canceledAt = optionalTimestamp(raw.canceled_at)
  const failedAt = optionalTimestamp(raw.failed_at)
  const replacedAt = optionalTimestamp(raw.replaced_at)
  const replacedBy = raw.replaced_by ?? undefined
  const replaces = raw.replaces ?? undefined
  const filledAveragePriceMicros = optionalMicros(raw.filled_avg_price, false, 'filled average price')
  const limitPriceMicros = optionalMicros(raw.limit_price, false, 'limit price')
  const stopPriceMicros = optionalMicros(raw.stop_price, false, 'stop price')
  const trailPercentMicros = optionalMicros(raw.trail_percent, false, 'trail percent')
  const trailPriceMicros = optionalMicros(raw.trail_price, false, 'trail price')
  const highWaterMarkMicros = optionalMicros(raw.hwm, false, 'high water mark')

  return {
    accountId,
    brokerOrderId: raw.id,
    clientOrderId: raw.client_order_id,
    createdAt: raw.created_at,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(submittedAt === undefined ? {} : { submittedAt }),
    ...(filledAt === undefined ? {} : { filledAt }),
    ...(expiredAt === undefined ? {} : { expiredAt }),
    ...(canceledAt === undefined ? {} : { canceledAt }),
    ...(failedAt === undefined ? {} : { failedAt }),
    ...(replacedAt === undefined ? {} : { replacedAt }),
    ...(replacedBy === undefined ? {} : { replacedBy }),
    ...(replaces === undefined ? {} : { replaces }),
    assetId: raw.asset_id,
    symbol: raw.symbol,
    assetClass: raw.asset_class,
    ...(quantityMicros === undefined ? {} : { quantityMicros }),
    ...(notionalMicros === undefined ? {} : { notionalMicros }),
    filledQuantityMicros,
    ...(filledAveragePriceMicros === undefined ? {} : { filledAveragePriceMicros }),
    orderClass: raw.order_class === '' ? OrderClass.Simple : raw.order_class,
    orderType: raw.type,
    side: raw.side,
    timeInForce: raw.time_in_force,
    ...(limitPriceMicros === undefined ? {} : { limitPriceMicros }),
    ...(stopPriceMicros === undefined ? {} : { stopPriceMicros }),
    status: raw.status,
    extendedHours: raw.extended_hours,
    ...(trailPercentMicros === undefined ? {} : { trailPercentMicros }),
    ...(trailPriceMicros === undefined ? {} : { trailPriceMicros }),
    ...(highWaterMarkMicros === undefined ? {} : { highWaterMarkMicros }),
    observedAt,
  }
}

const normalizeFillActivity = (raw: typeof FillActivityResponseSchema.Type, accountId: string): FillActivity => {
  if (raw.account_id !== undefined && raw.account_id !== accountId) {
    throw new Error(`fill activity resolved account ${raw.account_id}, expected ${accountId}`)
  }
  const cumulativeQuantityMicros = decimalToMicros(raw.cum_qty, false, 'cumulative fill quantity')
  const leavesQuantityMicros = decimalToMicros(raw.leaves_qty, false, 'leaves quantity')
  const quantityMicros = positiveMicros(raw.qty, 'fill quantity')
  if (BigInt(cumulativeQuantityMicros) < BigInt(quantityMicros)) {
    throw new Error('cumulative fill quantity is smaller than this fill quantity')
  }
  if (
    (raw.type === TradeActivityType.Fill && leavesQuantityMicros !== '0') ||
    (raw.type === TradeActivityType.PartialFill && leavesQuantityMicros === '0')
  ) {
    throw new Error(`fill activity type ${raw.type} is inconsistent with leaves quantity`)
  }
  const orderStatus = raw.order_status
  return {
    accountId,
    activityId: raw.id,
    cumulativeQuantityMicros,
    leavesQuantityMicros,
    priceMicros: positiveMicros(raw.price, 'fill price'),
    quantityMicros,
    side: raw.side,
    symbol: raw.symbol,
    transactionTime: raw.transaction_time,
    brokerOrderId: raw.order_id,
    type: raw.type,
    ...(orderStatus === undefined ? {} : { orderStatus }),
  }
}

const marketCalendarInstant = (date: string, time: string, field: 'open' | 'close'): string => {
  const zoned = DateTime.makeZoned(
    {
      year: Number(date.slice(0, 4)),
      month: Number(date.slice(5, 7)),
      day: Number(date.slice(8, 10)),
      hour: Number(time.slice(0, 2)),
      minute: Number(time.slice(3, 5)),
      second: 0,
      millisecond: 0,
    },
    {
      timeZone: marketCalendarTimeZone,
      adjustForTimeZone: true,
      disambiguation: 'reject',
    },
  )
  if (zoned._tag === 'None') {
    throw new Error(`market calendar ${field} is not a valid ${marketCalendarTimeZone} wall-clock instant`)
  }
  return DateTime.formatIso(zoned.value)
}

const normalizeMarketCalendar = (
  raw: typeof MarketCalendarResponseSchema.Type,
  query: typeof MarketCalendarQueryBase.Type,
): MarketCalendarObservation => {
  const sessions = raw
    .map((session): MarketCalendarSession => {
      if (session.date < query.start || session.date > query.end) {
        throw new Error(`market calendar session ${session.date} is outside the requested range`)
      }
      const openAt = marketCalendarInstant(session.date, session.open, 'open')
      const closeAt = marketCalendarInstant(session.date, session.close, 'close')
      if (openAt >= closeAt) throw new Error(`market calendar session ${session.date} has invalid hours`)
      return { date: session.date, openAt, closeAt }
    })
    .sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0))

  for (let index = 1; index < sessions.length; index += 1) {
    if (sessions[index - 1]?.date === sessions[index]?.date) {
      throw new Error(`market calendar contains duplicate session ${sessions[index]?.date ?? ''}`)
    }
  }

  const normalized = {
    schemaVersion: marketCalendarSchemaVersion,
    source: marketCalendarSource,
    requestedRange: { start: query.start, end: query.end },
    timeZone: 'UTC' as const,
    sessions,
  }
  return {
    ...normalized,
    normalizedResponseHash: canonicalHashV1(normalized),
  }
}

const responseEvidence = (
  headers: typeof ResponseHeadersSchema.Type,
  status: number,
  contentHash: string,
  observedAt: string,
): ReadEvidence => {
  const limit = headers['x-ratelimit-limit']
  const remaining = headers['x-ratelimit-remaining']
  if (limit !== undefined && remaining !== undefined && BigInt(remaining) > BigInt(limit)) {
    throw new Error('rate-limit remaining exceeds limit')
  }
  const rateLimit =
    limit === undefined &&
    remaining === undefined &&
    headers['x-ratelimit-reset'] === undefined &&
    headers['retry-after'] === undefined
      ? undefined
      : {
          limit,
          remaining,
          reset: headers['x-ratelimit-reset'],
          retryAfter: headers['retry-after'],
        }
  return {
    requestId: headers['x-request-id'],
    status,
    contentHash,
    observedAt,
    rateLimit,
  }
}

const decodeInput = <A>(
  operation: BrokerReadOperation,
  decoder: Decoder<A>,
  input: unknown,
  message: string,
): Effect.Effect<A, BrokerReadError> =>
  decoder(input).pipe(Effect.mapError((cause) => invalidRequest(operation, message, cause)))

const normalize = <A>(
  operation: BrokerReadOperation,
  evidence: ReadEvidence,
  evaluate: () => A,
): Effect.Effect<ReadResult<A>, BrokerReadError> =>
  Effect.try({
    try: () => ({ value: evaluate(), evidence }),
    catch: (cause) =>
      invalidResponse(operation, `Alpaca ${operation} response violates the Bayn read contract`, evidence, cause),
  })

export const makeProxyDispatcher = (
  proxyUrl: string,
  dependencies: ProxyDispatcherDependencies = {
    create: (url) => new Undici.ProxyAgent({ uri: url.toString() }),
    destroy: (dispatcher) => dispatcher.destroy(),
  },
): Effect.Effect<Undici.Dispatcher, BrokerReadError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const url = new URL(proxyUrl)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('proxy URL must use HTTP or HTTPS')
        if (url.username !== '' || url.password !== '')
          throw new Error('proxy credentials must not be embedded in the URL')
        if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
          throw new Error('proxy URL must contain only an origin')
        }
        return dependencies.create(url)
      },
      catch: (cause) => configurationError('proxy', 'invalid Alpaca proxy configuration', cause),
    }),
    (dispatcher) => Effect.promise(() => dependencies.destroy(dispatcher)),
  )

const proxyLayer = (proxyUrl: string): Layer.Layer<NodeHttpClient.Dispatcher, BrokerReadError> =>
  Layer.effect(NodeHttpClient.Dispatcher, makeProxyDispatcher(proxyUrl))

export const alpacaHttpLayer = (proxyUrl: string): Layer.Layer<HttpClient.HttpClient, BrokerReadError> =>
  NodeHttpClient.layerUndiciNoDispatcher.pipe(Layer.provide(proxyLayer(proxyUrl)))

export const make = (options: ReadOptions): Effect.Effect<BrokerReadShape, BrokerReadError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const runtime = yield* decodeRuntimeOptions({
      expectedAccountId: options.expectedAccountId,
      operationTimeoutMs: options.operationTimeoutMs,
      retryAttempts: options.retryAttempts,
    }).pipe(Effect.mapError((cause) => configurationError('configuration', 'invalid Alpaca read options', cause)))
    const key = Redacted.value(options.key)
    const secret = Redacted.value(options.secret)
    if (key.length === 0 || key.trim() !== key || secret.length === 0 || secret.trim() !== secret) {
      return yield* Effect.fail(
        configurationError('configuration', 'Alpaca credentials must be non-empty without surrounding whitespace'),
      )
    }
    const sensitiveValues = [key, secret]

    const baseClient = yield* HttpClient.HttpClient
    const client = baseClient.pipe(HttpClient.retryTransient({ times: runtime.retryAttempts }))

    const readJson = <A>(
      operation: BrokerReadOperation,
      url: URL,
      decoder: Decoder<A>,
    ): Effect.Effect<ReadResult<A>, BrokerReadError> =>
      Effect.gen(function* () {
        const request = HttpClientRequest.get(url, {
          acceptJson: true,
          headers: {
            'APCA-API-KEY-ID': key,
            'APCA-API-SECRET-KEY': secret,
          },
        })
        const response = yield* client
          .execute(request)
          .pipe(Effect.mapError((cause) => transportError(operation, cause, sensitiveValues)))
        const headers = yield* decodeResponseHeaders(response).pipe(
          Effect.mapError((cause) =>
            invalidResponse(
              operation,
              `Alpaca ${operation} response headers are invalid`,
              { status: response.status },
              cause,
            ),
          ),
        )
        const raw = yield* response.json.pipe(
          Effect.mapError((cause) =>
            invalidResponse(
              operation,
              `Alpaca ${operation} response body is not valid JSON`,
              { status: response.status, requestId: headers['x-request-id'] },
              cause,
            ),
          ),
        )
        const contentHash = yield* Effect.try({
          try: () => canonicalHashV1(raw),
          catch: (cause) =>
            invalidResponse(
              operation,
              `Alpaca ${operation} response cannot be canonically hashed`,
              { status: response.status, requestId: headers['x-request-id'] },
              cause,
            ),
        })
        const observedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
        const evidence = yield* Effect.try({
          try: () => responseEvidence(headers, response.status, contentHash, observedAt),
          catch: (cause) =>
            invalidResponse(
              operation,
              `Alpaca ${operation} rate-limit metadata is invalid`,
              { status: response.status, requestId: headers['x-request-id'], contentHash, observedAt },
              cause,
            ),
        })

        if (response.status < 200 || response.status >= 300) {
          const failure = yield* decodeErrorResponse(raw).pipe(
            Effect.mapError((cause) =>
              invalidResponse(operation, `Alpaca ${operation} error response is invalid`, evidence, cause),
            ),
          )
          return yield* Effect.fail(
            statusError(
              operation,
              response.status,
              evidence.requestId,
              contentHash,
              evidence.observedAt,
              failure.code,
              failure.message,
            ),
          )
        }

        const value = yield* decoder(raw).pipe(
          Effect.mapError((cause) =>
            invalidResponse(operation, `Alpaca ${operation} response body does not match its schema`, evidence, cause),
          ),
        )
        yield* Effect.annotateCurrentSpan({
          'broker.operation': operation,
          'broker.request_id': evidence.requestId,
          'broker.status': evidence.status,
          'broker.content_hash': evidence.contentHash,
        })
        return { value, evidence }
      }).pipe(
        Effect.timeout(`${runtime.operationTimeoutMs} millis`),
        Effect.mapError((cause) =>
          cause instanceof BrokerReadError
            ? cause
            : Cause.isTimeoutError(cause)
              ? timeoutError(operation, runtime.operationTimeoutMs, cause, sensitiveValues)
              : transportError(operation, cause, sensitiveValues),
        ),
        Effect.provideService(Headers.CurrentRedactedNames, redactedHeaders),
        Effect.withSpan('broker.read', { attributes: { 'broker.system': 'alpaca', 'broker.operation': operation } }),
      )

    const account = readJson('account', new URL('/v2/account', paperTradingUrl), decodeAccount).pipe(
      Effect.flatMap((result) =>
        result.value.id === runtime.expectedAccountId
          ? normalize('account', result.evidence, () =>
              normalizeAccount(result.value, runtime.expectedAccountId, result.evidence.observedAt),
            )
          : Effect.fail(
              new BrokerReadError({
                operation: 'account',
                kind: BrokerReadErrorKind.AccountMismatch,
                message: `Alpaca credential resolved account ${result.value.id}, expected ${runtime.expectedAccountId}`,
                retryable: false,
                status: result.evidence.status,
                requestId: result.evidence.requestId,
                contentHash: result.evidence.contentHash,
              }),
            ),
      ),
    )

    const accountConfiguration = readJson(
      'account-configuration',
      new URL(accountConfigurationRequestMaterial.path, paperTradingUrl),
      decodeAccountConfiguration,
    ).pipe(
      Effect.flatMap((result) =>
        normalize('account-configuration', result.evidence, () =>
          normalizeAccountConfiguration(result.value, result.evidence.observedAt),
        ),
      ),
    )

    const positions = readJson('positions', new URL('/v2/positions', paperTradingUrl), decodePositions).pipe(
      Effect.flatMap((result) =>
        normalize('positions', result.evidence, () =>
          result.value.map((position) =>
            normalizePosition(position, runtime.expectedAccountId, result.evidence.observedAt),
          ),
        ),
      ),
    )

    const assetBySymbol = (symbol: string) =>
      decodeInput('asset-by-symbol', decodeAssetSymbol, symbol, 'invalid Alpaca asset symbol').pipe(
        Effect.flatMap((decoded) => {
          const request = assetRequestMaterial(decoded)
          return readJson('asset-by-symbol', new URL(request.path, paperTradingUrl), decodeAsset).pipe(
            Effect.flatMap((result) =>
              normalize('asset-by-symbol', result.evidence, () =>
                normalizeAsset(result.value, decoded, result.evidence.observedAt),
              ),
            ),
          )
        }),
      )

    const marketCalendar = (query: MarketCalendarQuery) =>
      decodeInput('market-calendar', decodeMarketCalendarQuery, query, 'invalid Alpaca market calendar query').pipe(
        Effect.flatMap((decoded) => {
          const url = new URL('/v2/calendar', paperTradingUrl)
          url.searchParams.set('start', decoded.start)
          url.searchParams.set('end', decoded.end)
          url.searchParams.set('date_type', 'TRADING')
          return readJson('market-calendar', url, decodeMarketCalendar).pipe(
            Effect.flatMap((result) =>
              normalize('market-calendar', result.evidence, () => normalizeMarketCalendar(result.value, decoded)),
            ),
          )
        }),
      )

    const orders = (query: OrdersQuery = {}) =>
      decodeInput('orders', decodeOrdersQuery, query, 'invalid Alpaca orders query').pipe(
        Effect.flatMap((decoded) => {
          const url = new URL('/v2/orders', paperTradingUrl)
          if (decoded.status !== undefined) url.searchParams.set('status', decoded.status)
          if (decoded.limit !== undefined) url.searchParams.set('limit', String(decoded.limit))
          if (decoded.after !== undefined) url.searchParams.set('after', decoded.after)
          if (decoded.until !== undefined) url.searchParams.set('until', decoded.until)
          if (decoded.direction !== undefined) url.searchParams.set('direction', decoded.direction)
          if (decoded.side !== undefined) url.searchParams.set('side', decoded.side)
          if (decoded.symbols !== undefined) url.searchParams.set('symbols', decoded.symbols.join(','))
          return readJson('orders', url, decodeOrders)
        }),
        Effect.flatMap((result) =>
          normalize('orders', result.evidence, () =>
            result.value.map((order) => normalizeOrder(order, runtime.expectedAccountId, result.evidence.observedAt)),
          ),
        ),
      )

    const orderById = (orderId: string) =>
      decodeInput('order-by-id', decodeOrderId, orderId, 'invalid Alpaca order ID').pipe(
        Effect.flatMap((decoded) =>
          readJson('order-by-id', new URL(`/v2/orders/${encodeURIComponent(decoded)}`, paperTradingUrl), decodeOrder),
        ),
        Effect.flatMap((result) =>
          normalize('order-by-id', result.evidence, () =>
            normalizeOrder(result.value, runtime.expectedAccountId, result.evidence.observedAt),
          ),
        ),
      )

    const orderByClientId = (clientOrderId: string) =>
      decodeInput(
        'order-by-client-id',
        decodeExternalClientOrderId,
        clientOrderId,
        'invalid Alpaca client order ID',
      ).pipe(
        Effect.flatMap((decoded) => {
          const url = new URL('/v2/orders:by_client_order_id', paperTradingUrl)
          url.searchParams.set('client_order_id', decoded)
          return readJson('order-by-client-id', url, decodeOrder)
        }),
        Effect.flatMap((result) =>
          normalize('order-by-client-id', result.evidence, () =>
            normalizeOrder(result.value, runtime.expectedAccountId, result.evidence.observedAt),
          ),
        ),
      )

    const fillActivities = (query: FillActivitiesQuery = {}) =>
      decodeInput('fill-activities', decodeFillActivitiesQuery, query, 'invalid Alpaca fill activities query').pipe(
        Effect.flatMap((decoded) => {
          const url = new URL('/v2/account/activities/FILL', paperTradingUrl)
          const pageSize = decoded.pageSize ?? defaultFillActivitiesPageSize
          if (decoded.date !== undefined) url.searchParams.set('date', decoded.date)
          if (decoded.after !== undefined) url.searchParams.set('after', decoded.after)
          if (decoded.until !== undefined) url.searchParams.set('until', decoded.until)
          if (decoded.direction !== undefined) url.searchParams.set('direction', decoded.direction)
          url.searchParams.set('page_size', String(pageSize))
          if (decoded.pageToken !== undefined) url.searchParams.set('page_token', decoded.pageToken)
          return readJson('fill-activities', url, decodeFillActivities).pipe(
            Effect.map((result) => ({ result, pageSize })),
          )
        }),
        Effect.flatMap(({ pageSize, result }) =>
          normalize('fill-activities', result.evidence, () => {
            const items = result.value.map((activity) => normalizeFillActivity(activity, runtime.expectedAccountId))
            return {
              items,
              nextPageToken:
                items.length === pageSize && items.length > 0 ? items[items.length - 1]?.activityId : undefined,
            }
          }),
        ),
      )

    return {
      account,
      accountConfiguration,
      assetBySymbol,
      positions,
      orders,
      orderById,
      orderByClientId,
      fillActivities,
      marketCalendar,
    }
  })

const missingOrderId = '00000000-0000-4000-8000-000000000000'
const missingClientOrderId = 'bayn-observe-read-proof-does-not-exist'

const expectNotFound = (
  operation: 'order-by-id' | 'order-by-client-id',
  read: Effect.Effect<ReadResult<Order>, BrokerReadError>,
): Effect.Effect<'NOT_FOUND', BrokerReadError> =>
  read.pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        error.kind === BrokerReadErrorKind.NotFound ? Effect.succeed('NOT_FOUND' as const) : Effect.fail(error),
      onSuccess: (result) =>
        Effect.fail(
          invalidResponse(
            operation,
            `Alpaca ${operation} unexpectedly resolved the observe-only proof identity`,
            result.evidence,
            result.value,
          ),
        ),
    }),
  )

const verifyOrderLookup = (
  operation: 'order-by-id' | 'order-by-client-id',
  expected: Order,
  read: Effect.Effect<ReadResult<Order>, BrokerReadError>,
): Effect.Effect<'MATCHED', BrokerReadError> =>
  read.pipe(
    Effect.flatMap((result) =>
      result.value.brokerOrderId === expected.brokerOrderId && result.value.clientOrderId === expected.clientOrderId
        ? Effect.succeed('MATCHED' as const)
        : Effect.fail(
            invalidResponse(
              operation,
              `Alpaca ${operation} returned a different order during observe-only preflight`,
              result.evidence,
              result.value,
            ),
          ),
    ),
  )

export const verifyReadAccess = (read: BrokerReadShape): Effect.Effect<ReadPreflight, BrokerReadError> =>
  Effect.gen(function* () {
    const account = yield* read.account
    const calendarStart = new Date(yield* Clock.currentTimeMillis).toISOString().slice(0, 10)
    const calendarEnd = new Date(
      Date.parse(`${calendarStart}T00:00:00.000Z`) + (marketCalendarPreflightRangeDays - 1) * millisecondsPerDay,
    )
      .toISOString()
      .slice(0, 10)
    const responses = yield* Effect.all(
      {
        positions: read.positions,
        openOrders: read.orders({ status: OrderCollection.Open, limit: 1 }),
        recentOrders: read.orders({
          status: OrderCollection.All,
          limit: 1,
          direction: SortDirection.Descending,
        }),
        fills: read.fillActivities({ pageSize: 1, direction: SortDirection.Descending }),
        marketCalendar: read.marketCalendar({ start: calendarStart, end: calendarEnd }),
      },
      { concurrency: 5 },
    )
    const order = responses.recentOrders.value[0] ?? responses.openOrders.value[0]
    const lookups =
      order === undefined
        ? yield* Effect.all({
            orderById: expectNotFound('order-by-id', read.orderById(missingOrderId)),
            orderByClientId: expectNotFound('order-by-client-id', read.orderByClientId(missingClientOrderId)),
          })
        : yield* Effect.all({
            orderById: verifyOrderLookup('order-by-id', order, read.orderById(order.brokerOrderId)),
            orderByClientId: verifyOrderLookup('order-by-client-id', order, read.orderByClientId(order.clientOrderId)),
          })
    const proof = yield* Effect.try({
      try: (): ReadPreflight => ({
        accountId: account.value.id,
        accountHash: canonicalHashV1(account.value),
        positionCount: responses.positions.value.length,
        positionsHash: canonicalHashV1(responses.positions.value),
        openOrderCount: responses.openOrders.value.length,
        recentOrderCount: responses.recentOrders.value.length,
        ordersHash: canonicalHashV1({
          open: responses.openOrders.value,
          recent: responses.recentOrders.value,
        }),
        fillCount: responses.fills.value.items.length,
        fillsHash: canonicalHashV1(responses.fills.value.items),
        marketCalendarSessionCount: responses.marketCalendar.value.sessions.length,
        marketCalendarHash: responses.marketCalendar.value.normalizedResponseHash,
        ...lookups,
      }),
      catch: (cause) =>
        new BrokerReadError({
          operation: 'preflight',
          kind: BrokerReadErrorKind.InvalidResponse,
          message: 'Alpaca observe-only preflight data is not canonical JSON',
          retryable: false,
          cause: safeCause(cause),
        }),
    })
    yield* Effect.logInfo('Alpaca observe-only read preflight passed').pipe(
      Effect.annotateLogs({
        accountId: proof.accountId,
        accountHash: proof.accountHash,
        positionCount: proof.positionCount,
        positionsHash: proof.positionsHash,
        openOrderCount: proof.openOrderCount,
        recentOrderCount: proof.recentOrderCount,
        ordersHash: proof.ordersHash,
        fillCount: proof.fillCount,
        fillsHash: proof.fillsHash,
        marketCalendarSessionCount: proof.marketCalendarSessionCount,
        marketCalendarHash: proof.marketCalendarHash,
        orderById: proof.orderById,
        orderByClientId: proof.orderByClientId,
      }),
    )
    return proof
  }).pipe(
    Effect.timeoutOrElse({
      duration: readPreflightTimeoutMs,
      orElse: () =>
        Effect.fail(
          new BrokerReadError({
            operation: 'preflight',
            kind: BrokerReadErrorKind.Timeout,
            message: `Alpaca observe-only read preflight exceeded its ${readPreflightTimeoutMs}ms startup deadline`,
            retryable: true,
          }),
        ),
    }),
    Effect.withLogSpan('broker.read.preflight'),
  )

export const layer = (options: ReadOptions): Layer.Layer<BrokerRead, BrokerReadError, HttpClient.HttpClient> =>
  Layer.effect(BrokerRead, make(options).pipe(Effect.tap(verifyReadAccess)))

export const live = (options: ReadOptions): Layer.Layer<BrokerRead, BrokerReadError> =>
  layer(options).pipe(Layer.provide(alpacaHttpLayer(options.proxyUrl)))
