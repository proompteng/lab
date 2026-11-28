import { Effect, Redacted, Result, Schema } from 'effect'
import { FetchHttpClient, Headers, HttpClient, HttpClientRequest } from 'effect/http'

import {
  IsoDateSchema,
  NonNegativeIntegerSchema,
  PositiveFiniteSchema,
  StrictNonEmptyStringSchema,
  SymbolSchema,
  UtcSourceTimestampSchema,
} from '../../src/schemas'
import { redactedHeaders } from '../../src/broker/alpaca/model'
import { failure, TimeInForce } from './contract'

export const paperOrigin = 'https://paper-api.alpaca.markets'
const dataOrigin = 'https://data.alpaca.markets'
export const validatePaperOrigin = (origin: string) =>
  origin === paperOrigin || origin === `${paperOrigin}/`
    ? Result.succeed(paperOrigin)
    : Result.fail(
        failure('config', 'BAYN_ALPACA_BASE_URL must be https://paper-api.alpaca.markets (live is forbidden)'),
      )

const WallTime = Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/))
const Instant = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/),
  Schema.makeFilter((value) => Number.isFinite(Date.parse(value))),
)
const Calendar = Schema.Array(Schema.Struct({ date: IsoDateSchema, open: WallTime, close: WallTime }))
const Clock = Schema.Struct({ timestamp: Instant, is_open: Schema.Boolean, next_open: Instant })
export const AccountId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/))
const Decimal = Schema.String.check(Schema.isPattern(/^-?(?:0|[1-9]\d{0,9})(?:\.\d{1,18})?$/))
export const Account = Schema.Struct({
  id: AccountId,
  status: Schema.Literal('ACTIVE'),
  currency: Schema.Literal('USD'),
  equity: Decimal,
  cash: Decimal,
  buying_power: Decimal,
  account_blocked: Schema.Boolean,
  trading_blocked: Schema.Boolean,
  trade_suspended_by_user: Schema.Boolean,
})
export const Positions = Schema.Array(
  Schema.Struct({
    symbol: SymbolSchema,
    side: Schema.Literals(['long', 'short']),
    qty: Decimal,
    qty_available: Schema.optionalKey(Decimal),
    market_value: Decimal,
  }),
)
const OrderIdentity = Schema.Struct({
  id: AccountId,
  symbol: SymbolSchema,
  client_order_id: StrictNonEmptyStringSchema,
  status: StrictNonEmptyStringSchema,
})
export const Orders = Schema.Array(OrderIdentity)
export enum Side {
  Buy = 'buy',
  Sell = 'sell',
}
const Acknowledgement = Schema.Struct({
  ...OrderIdentity.fields,
  side: Schema.Enum(Side),
  qty: Decimal,
  type: Schema.Literal('limit'),
  time_in_force: Schema.Enum(TimeInForce),
  limit_price: Decimal,
  extended_hours: Schema.Literal(false),
})
export type OrderRequest = {
  readonly symbol: string
  readonly qty: string
  readonly side: Side
  readonly type: 'limit'
  readonly time_in_force: TimeInForce
  readonly limit_price: string
  readonly extended_hours: false
  readonly client_order_id: string
}
export const Bar = Schema.Struct({
  t: UtcSourceTimestampSchema,
  o: PositiveFiniteSchema,
  h: PositiveFiniteSchema,
  l: PositiveFiniteSchema,
  c: PositiveFiniteSchema,
  v: NonNegativeIntegerSchema,
  n: Schema.optionalKey(NonNegativeIntegerSchema),
  vw: Schema.optionalKey(PositiveFiniteSchema),
})
export type Bar = typeof Bar.Type
export enum BarAdjustment {
  All = 'all',
  Raw = 'raw',
}
const Bars = Schema.Struct({
  bars: Schema.Record(SymbolSchema, Schema.Array(Bar)),
  next_page_token: Schema.NullOr(StrictNonEmptyStringSchema),
  adjustment: Schema.optionalKey(Schema.Enum(BarAdjustment)),
  feed: Schema.optionalKey(Schema.Literal('sip')),
  timeframe: Schema.optionalKey(Schema.Literal('1Day')),
})

export type BarsPage = typeof Bars.Type
export type Account = typeof Account.Type
export type Position = (typeof Positions.Type)[number]
export type OpenOrder = typeof OrderIdentity.Type
export type Calendar = typeof Calendar.Type
export type MarketClock = typeof Clock.Type

const requestTimeout = '12 seconds'
const orderLimit = 500
export const makeAlpaca = Effect.fn('macro-canary.alpaca')(function* (
  configuredOrigin: string,
  key: Redacted.Redacted<string>,
  secret: Redacted.Redacted<string>,
) {
  const origin = yield* Effect.fromResult(validatePaperOrigin(configuredOrigin))
  if (Redacted.value(key).trim().length === 0 || Redacted.value(secret).trim().length === 0)
    return yield* failure('config', 'Alpaca credentials must not be empty')
  const http = yield* HttpClient.HttpClient

  const request = <S extends Schema.ConstraintDecoder<unknown, never>>(
    operation: string,
    schema: S,
    url: URL,
    order?: OrderRequest,
  ) =>
    Effect.gen(function* () {
      const req = (
        order === undefined
          ? HttpClientRequest.get(url)
          : HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(order))
      ).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeader('APCA-API-KEY-ID', Redacted.value(key)),
        HttpClientRequest.setHeader('APCA-API-SECRET-KEY', Redacted.value(secret)),
      )
      const response = yield* http
        .execute(req)
        .pipe(Effect.mapError((cause) => failure(operation, 'Alpaca HTTP transport failed', cause.reason._tag)))
      if (response.status !== 200)
        return yield* failure(operation, `Alpaca returned HTTP ${response.status}; no automatic retry`, {
          status: response.status,
        })
      const json = yield* response.json.pipe(
        Effect.mapError((cause) => failure(operation, 'Alpaca response was not valid JSON', cause.reason._tag)),
      )
      // Do not attach provider-controlled response contents to errors printed by the CLI.
      return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError((cause) => failure(operation, 'Unexpected Alpaca response shape', { kind: cause.issue._tag })),
      )
    }).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'error' }),
      Effect.provideService(Headers.CurrentRedactedNames, redactedHeaders),
      Effect.timeout(requestTimeout),
      Effect.catchTag('TimeoutError', () =>
        Effect.fail(failure(operation, 'Alpaca request exceeded its 12-second deadline')),
      ),
    )

  const read = <S extends Schema.ConstraintDecoder<unknown, never>>(path: string, schema: S, params = {}) => {
    const url = new URL(path, origin)
    url.search = new URLSearchParams(params).toString()
    return request(path, schema, url)
  }

  return {
    calendar: (start: string, end: string) => read('/v2/calendar', Calendar, { start, end, date_type: 'TRADING' }),
    clock: () => read('/v2/clock', Clock),
    account: () => read('/v2/account', Account),
    positions: () => read('/v2/positions', Positions),
    orders: (after?: string) =>
      read('/v2/orders', Orders, {
        status: after === undefined ? 'open' : 'all',
        limit: String(orderLimit),
        nested: 'false',
        ...(after === undefined ? {} : { after }),
      }).pipe(
        Effect.filterOrFail(
          (orders) => orders.length < orderLimit,
          () => failure('reconcile', 'Alpaca orders reached the read limit; completeness cannot be established'),
        ),
      ),
    bars: (params: {
      symbols: string
      adjustment: BarAdjustment
      start: string
      end: string
      pageToken: string | null
    }) => {
      const { pageToken, ...query } = params
      const url = new URL('/v2/stocks/bars', dataOrigin)
      url.search = new URLSearchParams({
        ...query,
        timeframe: '1Day',
        feed: 'sip',
        sort: 'asc',
        limit: '10000',
        ...(pageToken === null ? {} : { page_token: pageToken }),
      }).toString()
      return request(`SIP daily bars (${params.adjustment})`, Bars, url).pipe(
        Effect.filterOrFail(
          (page) => page.adjustment === undefined || page.adjustment === params.adjustment,
          () => failure('bars', 'Alpaca bar adjustment does not match the request'),
        ),
      )
    },
    submit: (order: OrderRequest) =>
      request('paper-submit', Acknowledgement, new URL('/v2/orders', origin), order).pipe(
        Effect.filterOrFail(
          (ack) =>
            ack.client_order_id === order.client_order_id &&
            ack.symbol === order.symbol &&
            ack.side === order.side &&
            Number(ack.qty) === Number(order.qty) &&
            ack.type === order.type &&
            ack.time_in_force === order.time_in_force &&
            Number(ack.limit_price) === Number(order.limit_price) &&
            ['accepted', 'pending_new', 'new', 'partially_filled', 'filled', 'accepted_for_bidding'].includes(
              ack.status,
            ),
          () => failure('paper-submit', `Unverified acknowledgement for ${order.client_order_id}`),
        ),
      ),
  }
})

export type Alpaca = Effect.Success<ReturnType<typeof makeAlpaca>>
