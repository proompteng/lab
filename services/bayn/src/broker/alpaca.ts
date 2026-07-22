import { NodeHttpClient, Undici } from '@effect/platform-node'
import { Cause, Clock, Context, Data, Effect, Layer, Redacted, Schema, Scope } from 'effect'
import { Headers, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'

import { canonicalHashV1 } from '../hash'
import {
  IsoDateSchema as IsoDate,
  StrictNonEmptyStringSchema as NonEmptyString,
  SymbolSchema as SymbolName,
} from '../schemas'

const tradingUrl = 'https://paper-api.alpaca.markets'
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
const ClientOrderId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(48),
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
  | 'account'
  | 'positions'
  | 'orders'
  | 'order-by-id'
  | 'order-by-client-id'
  | 'fill-activities'

export class BrokerReadError extends Data.TaggedError('BrokerReadError')<{
  readonly operation: BrokerReadOperation
  readonly kind: BrokerReadErrorKind
  readonly message: string
  readonly retryable: boolean
  readonly status?: number
  readonly requestId?: string
  readonly contentHash?: string
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
  readonly updatedAt: string
  readonly submittedAt: string
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
  readonly positions: Effect.Effect<ReadResult<readonly Position[]>, BrokerReadError>
  readonly orders: (query?: OrdersQuery) => Effect.Effect<ReadResult<readonly Order[]>, BrokerReadError>
  readonly orderById: (orderId: string) => Effect.Effect<ReadResult<Order>, BrokerReadError>
  readonly orderByClientId: (clientOrderId: string) => Effect.Effect<ReadResult<Order>, BrokerReadError>
  readonly fillActivities: (query?: FillActivitiesQuery) => Effect.Effect<ReadResult<FillActivityPage>, BrokerReadError>
}

export class BrokerRead extends Context.Service<BrokerRead, BrokerReadShape>()('bayn/BrokerRead') {}

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

const OrderResponseSchema = Schema.Struct({
  id: Uuid,
  client_order_id: ClientOrderId,
  created_at: Timestamp,
  updated_at: Timestamp,
  submitted_at: Timestamp,
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
  order_type: Schema.Enum(OrderType),
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

const RuntimeOptionsSchema = Schema.Struct({
  expectedAccountId: Uuid,
  operationTimeoutMs: PositiveInteger,
  retryAttempts: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
})

type Decoder<A> = (input: unknown) => Effect.Effect<A, unknown>

const decodeAccount = Schema.decodeUnknownEffect(AccountResponseSchema, responseParseOptions)
const decodePositions = Schema.decodeUnknownEffect(Schema.Array(PositionResponseSchema), responseParseOptions)
const decodeOrders = Schema.decodeUnknownEffect(Schema.Array(OrderResponseSchema), responseParseOptions)
const decodeOrder = Schema.decodeUnknownEffect(OrderResponseSchema, responseParseOptions)
const decodeFillActivities = Schema.decodeUnknownEffect(Schema.Array(FillActivityResponseSchema), responseParseOptions)
const decodeResponseHeaders = HttpClientResponse.schemaHeaders(ResponseHeadersSchema, responseParseOptions)
const decodeErrorResponse = Schema.decodeUnknownEffect(ErrorResponseSchema, responseParseOptions)
const decodeOrdersQuery = Schema.decodeUnknownEffect(OrdersQuerySchema, inputParseOptions)
const decodeFillActivitiesQuery = Schema.decodeUnknownEffect(FillActivitiesQuerySchema, inputParseOptions)
const decodeOrderId = Schema.decodeUnknownEffect(Uuid)
const decodeClientOrderId = Schema.decodeUnknownEffect(ClientOrderId)
const decodeRuntimeOptions = Schema.decodeUnknownEffect(RuntimeOptionsSchema, inputParseOptions)

const safeCause = (cause: unknown): Readonly<Record<string, string>> => {
  if (typeof cause === 'object' && cause !== null && '_tag' in cause && typeof cause._tag === 'string') {
    return { tag: cause._tag }
  }
  return { tag: cause instanceof Error ? cause.name : typeof cause }
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

const transportError = (operation: BrokerReadOperation, cause: unknown): BrokerReadError =>
  new BrokerReadError({
    operation,
    kind: BrokerReadErrorKind.Transport,
    message: `Alpaca ${operation} request failed before a response was available`,
    retryable: true,
    cause: safeCause(cause),
  })

const statusError = (
  operation: BrokerReadOperation,
  status: number,
  requestId: string,
  contentHash: string,
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
  })
}

const timeoutError = (operation: BrokerReadOperation, timeoutMs: number, cause: unknown): BrokerReadError =>
  new BrokerReadError({
    operation,
    kind: BrokerReadErrorKind.Timeout,
    message: `Alpaca ${operation} exceeded its ${timeoutMs}ms deadline`,
    retryable: true,
    cause: safeCause(cause),
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

const normalizePosition = (
  raw: typeof PositionResponseSchema.Type,
  accountId: string,
  observedAt: string,
): Position => {
  if (raw.asset_class !== AssetClass.UsEquity) throw new Error(`unsupported position asset class ${raw.asset_class}`)
  const quantityMicros = decimalToMicros(raw.qty, true, 'position quantity')
  const marketValueMicros = decimalToMicros(raw.market_value, true, 'market value')
  if (
    (raw.side === PositionSide.Long && BigInt(quantityMicros) <= 0n) ||
    (raw.side === PositionSide.Short && BigInt(quantityMicros) >= 0n) ||
    (raw.side === PositionSide.Long && BigInt(marketValueMicros) <= 0n) ||
    (raw.side === PositionSide.Short && BigInt(marketValueMicros) >= 0n)
  ) {
    throw new Error(`position side ${raw.side} is inconsistent with quantity or market value`)
  }
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

const normalizeOrder = (raw: typeof OrderResponseSchema.Type, accountId: string, observedAt: string): Order => {
  if (raw.asset_class !== AssetClass.UsEquity) throw new Error(`unsupported order asset class ${raw.asset_class}`)
  if ((raw.qty === null) === (raw.notional === null))
    throw new Error('order must contain exactly one of qty or notional')
  if (raw.order_type !== raw.type) throw new Error('deprecated order_type does not match type')
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

  return {
    accountId,
    brokerOrderId: raw.id,
    clientOrderId: raw.client_order_id,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    submittedAt: raw.submitted_at,
    filledAt: optionalTimestamp(raw.filled_at),
    expiredAt: optionalTimestamp(raw.expired_at),
    canceledAt: optionalTimestamp(raw.canceled_at),
    failedAt: optionalTimestamp(raw.failed_at),
    replacedAt: optionalTimestamp(raw.replaced_at),
    replacedBy: raw.replaced_by ?? undefined,
    replaces: raw.replaces ?? undefined,
    assetId: raw.asset_id,
    symbol: raw.symbol,
    assetClass: raw.asset_class,
    quantityMicros,
    notionalMicros,
    filledQuantityMicros,
    filledAveragePriceMicros: optionalMicros(raw.filled_avg_price, false, 'filled average price'),
    orderClass: raw.order_class === '' ? OrderClass.Simple : raw.order_class,
    orderType: raw.order_type,
    side: raw.side,
    timeInForce: raw.time_in_force,
    limitPriceMicros: optionalMicros(raw.limit_price, false, 'limit price'),
    stopPriceMicros: optionalMicros(raw.stop_price, false, 'stop price'),
    status: raw.status,
    extendedHours: raw.extended_hours,
    trailPercentMicros: optionalMicros(raw.trail_percent, false, 'trail percent'),
    trailPriceMicros: optionalMicros(raw.trail_price, false, 'trail price'),
    highWaterMarkMicros: optionalMicros(raw.hwm, false, 'high water mark'),
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
    orderStatus: raw.order_status,
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

const httpLayer = (proxyUrl: string): Layer.Layer<HttpClient.HttpClient, BrokerReadError> =>
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
          .pipe(Effect.mapError((cause) => transportError(operation, cause)))
        const observedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
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
        const evidence = yield* Effect.try({
          try: () => responseEvidence(headers, response.status, contentHash, observedAt),
          catch: (cause) =>
            invalidResponse(
              operation,
              `Alpaca ${operation} rate-limit metadata is invalid`,
              { status: response.status, requestId: headers['x-request-id'], contentHash },
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
            statusError(operation, response.status, evidence.requestId, contentHash, failure.code, failure.message),
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
              ? timeoutError(operation, runtime.operationTimeoutMs, cause)
              : transportError(operation, cause),
        ),
        Effect.provideService(Headers.CurrentRedactedNames, redactedHeaders),
        Effect.withSpan('broker.read', { attributes: { 'broker.system': 'alpaca', 'broker.operation': operation } }),
      )

    const account = readJson('account', new URL('/v2/account', tradingUrl), decodeAccount).pipe(
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

    const positions = readJson('positions', new URL('/v2/positions', tradingUrl), decodePositions).pipe(
      Effect.flatMap((result) =>
        normalize('positions', result.evidence, () =>
          result.value.map((position) =>
            normalizePosition(position, runtime.expectedAccountId, result.evidence.observedAt),
          ),
        ),
      ),
    )

    const orders = (query: OrdersQuery = {}) =>
      decodeInput('orders', decodeOrdersQuery, query, 'invalid Alpaca orders query').pipe(
        Effect.flatMap((decoded) => {
          const url = new URL('/v2/orders', tradingUrl)
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
          readJson('order-by-id', new URL(`/v2/orders/${encodeURIComponent(decoded)}`, tradingUrl), decodeOrder),
        ),
        Effect.flatMap((result) =>
          normalize('order-by-id', result.evidence, () =>
            normalizeOrder(result.value, runtime.expectedAccountId, result.evidence.observedAt),
          ),
        ),
      )

    const orderByClientId = (clientOrderId: string) =>
      decodeInput('order-by-client-id', decodeClientOrderId, clientOrderId, 'invalid Alpaca client order ID').pipe(
        Effect.flatMap((decoded) => {
          const url = new URL('/v2/orders:by_client_order_id', tradingUrl)
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
          const url = new URL('/v2/account/activities/FILL', tradingUrl)
          if (decoded.date !== undefined) url.searchParams.set('date', decoded.date)
          if (decoded.after !== undefined) url.searchParams.set('after', decoded.after)
          if (decoded.until !== undefined) url.searchParams.set('until', decoded.until)
          if (decoded.direction !== undefined) url.searchParams.set('direction', decoded.direction)
          if (decoded.pageSize !== undefined) url.searchParams.set('page_size', String(decoded.pageSize))
          if (decoded.pageToken !== undefined) url.searchParams.set('page_token', decoded.pageToken)
          return readJson('fill-activities', url, decodeFillActivities).pipe(
            Effect.map((result) => ({ result, pageSize: decoded.pageSize })),
          )
        }),
        Effect.flatMap(({ pageSize, result }) =>
          normalize('fill-activities', result.evidence, () => {
            const items = result.value.map((activity) => normalizeFillActivity(activity, runtime.expectedAccountId))
            return {
              items,
              nextPageToken:
                pageSize !== undefined && items.length === pageSize && items.length > 0
                  ? items[items.length - 1]?.activityId
                  : undefined,
            }
          }),
        ),
      )

    return { account, positions, orders, orderById, orderByClientId, fillActivities }
  })

export const layer = (options: ReadOptions): Layer.Layer<BrokerRead, BrokerReadError, HttpClient.HttpClient> =>
  Layer.effect(BrokerRead, make(options).pipe(Effect.tap((read) => read.account)))

export const live = (options: ReadOptions): Layer.Layer<BrokerRead, BrokerReadError> =>
  layer(options).pipe(Layer.provide(httpLayer(options.proxyUrl)))
