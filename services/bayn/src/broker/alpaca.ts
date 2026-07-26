import { Effect, Layer, Result } from 'effect'
import { HttpClient } from 'effect/unstable/http'

import { alpacaHttpLayer, make } from './alpaca/http'
import { BrokerRead, OrderResponseSchema, type Order, type ReadOptions } from './alpaca/model'
import { normalizeOrderResult } from './alpaca/normalizers'
import { verifyReadAccess } from './alpaca/preflight'

export {
  BrokerReadContractFailure,
  BrokerReadError,
  BrokerReadErrorKind,
  type BrokerReadContractFailureReason,
  type BrokerReadOperation,
} from './alpaca/failures'
export {
  AccountConfigurationResponseSchema,
  AccountResponseSchema,
  AccountStatus,
  AssetClass,
  AssetExchange,
  AssetResponseSchema,
  AssetStatus,
  BrokerRead,
  ErrorResponseSchema,
  FillActivityResponseSchema,
  MarketCalendarResponseSchema,
  OrderClass,
  OrderCollection,
  OrderResponseSchema,
  OrderSide,
  OrderStatus,
  OrderType,
  PositionResponseSchema,
  PositionSide,
  ResponseHeadersSchema,
  SortDirection,
  TimeInForce,
  TradeActivityType,
  paperTradingUrl,
  readPreflightTimeoutMs,
  type Account,
  type AccountConfigurationObservation,
  type AssetObservation,
  type AssetObservationExchange,
  type BrokerReadShape,
  type FillActivitiesQuery,
  type FillActivity,
  type FillActivityPage,
  type MarketCalendarObservation,
  type MarketCalendarQuery,
  type MarketCalendarSession,
  type Order,
  type OrdersQuery,
  type Position,
  type RateLimitEvidence,
  type ReadEvidence,
  type ReadOptions,
  type ReadPreflight,
  type ReadResult,
} from './alpaca/model'
export { alpacaHttpLayer, make, makeProxyDispatcher } from './alpaca/http'
export { verifyReadAccess } from './alpaca/preflight'

/** @deprecated Mutation compatibility adapter. Read-side normalization uses `normalizeOrderResult`. */
export const normalizeOrder = (raw: typeof OrderResponseSchema.Type, accountId: string, observedAt: string): Order =>
  Result.getOrThrow(normalizeOrderResult(raw, accountId, observedAt))

export const layer = (
  options: ReadOptions,
): Layer.Layer<BrokerRead, import('./alpaca/failures').BrokerReadError, HttpClient.HttpClient> =>
  Layer.effect(BrokerRead, make(options).pipe(Effect.tap(verifyReadAccess)))

export const scopedReadAdapterLayer = (
  options: ReadOptions,
): Layer.Layer<BrokerRead, import('./alpaca/failures').BrokerReadError> =>
  Layer.effect(BrokerRead, make(options)).pipe(Layer.provide(alpacaHttpLayer(options.proxyUrl)))

export const live = (options: ReadOptions): Layer.Layer<BrokerRead, import('./alpaca/failures').BrokerReadError> =>
  layer(options).pipe(Layer.provide(alpacaHttpLayer(options.proxyUrl)))
