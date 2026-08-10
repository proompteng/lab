import { Result } from 'effect'

import type { BrokerConnection } from '../connection'
import { contractFailure, type BrokerReadContractFailure } from './failures'
import {
  ResponseHeadersSchema,
  accountConfigurationObservationSchemaVersion,
  accountConfigurationObservationSource,
  assetObservationSchemaVersion,
  assetObservationSource,
  defaultFillActivitiesPageSize,
  type FillActivitiesQuery,
  type MarketCalendarQuery,
  type OrdersQuery,
  type ReadEvidence,
} from './model'
import { Pipeable } from '../../pipeable'

export const accountConfigurationRequestMaterial = {
  schemaVersion: accountConfigurationObservationSchemaVersion,
  source: accountConfigurationObservationSource,
  method: 'GET',
  path: '/v2/account/configurations',
} as const

export const assetRequestMaterial = (requestedSymbol: string) => ({
  schemaVersion: assetObservationSchemaVersion,
  source: assetObservationSource,
  method: 'GET' as const,
  path: `/v2/assets/${encodeURIComponent(requestedSymbol)}`,
  requestedSymbol,
})

export const accountUrl = (connection: BrokerConnection): URL => new URL('/v2/account', connection.baseUrl)

export const accountConfigurationUrl = (connection: BrokerConnection): URL =>
  new URL(accountConfigurationRequestMaterial.path, connection.baseUrl)

export const positionsUrl = (connection: BrokerConnection): URL => new URL('/v2/positions', connection.baseUrl)

const assetBySymbolUrlDataFirst = (connection: BrokerConnection, requestedSymbol: string): URL =>
  new URL(assetRequestMaterial(requestedSymbol).path, connection.baseUrl)

export const assetBySymbolUrl = Pipeable.dual(2, assetBySymbolUrlDataFirst)

const marketCalendarUrlDataFirst = (connection: BrokerConnection, query: MarketCalendarQuery): URL => {
  const url = new URL('/v2/calendar', connection.baseUrl)
  url.searchParams.set('start', query.start)
  url.searchParams.set('end', query.end)
  url.searchParams.set('date_type', 'TRADING')
  return url
}

export const marketCalendarUrl = Pipeable.dual(2, marketCalendarUrlDataFirst)

const ordersUrlDataFirst = (connection: BrokerConnection, query: OrdersQuery): URL => {
  const url = new URL('/v2/orders', connection.baseUrl)
  if (query.status !== undefined) url.searchParams.set('status', query.status)
  if (query.limit !== undefined) url.searchParams.set('limit', String(query.limit))
  if (query.after !== undefined) url.searchParams.set('after', query.after)
  if (query.until !== undefined) url.searchParams.set('until', query.until)
  if (query.direction !== undefined) url.searchParams.set('direction', query.direction)
  if (query.side !== undefined) url.searchParams.set('side', query.side)
  if (query.symbols !== undefined) url.searchParams.set('symbols', query.symbols.join(','))
  return url
}

export const ordersUrl = Pipeable.dual(2, ordersUrlDataFirst)

export const submitOrderUrl = (connection: BrokerConnection): URL => new URL('/v2/orders', connection.baseUrl)

const orderByIdUrlDataFirst = (connection: BrokerConnection, orderId: string): URL =>
  new URL(`/v2/orders/${encodeURIComponent(orderId)}`, connection.baseUrl)

export const orderByIdUrl = Pipeable.dual(2, orderByIdUrlDataFirst)

const cancelOrderUrlDataFirst = (connection: BrokerConnection, orderId: string): URL =>
  orderByIdUrl(connection, orderId)

export const cancelOrderUrl = Pipeable.dual(2, cancelOrderUrlDataFirst)

const orderByClientIdUrlDataFirst = (connection: BrokerConnection, clientOrderId: string): URL => {
  const url = new URL('/v2/orders:by_client_order_id', connection.baseUrl)
  url.searchParams.set('client_order_id', clientOrderId)
  return url
}

export const orderByClientIdUrl = Pipeable.dual(2, orderByClientIdUrlDataFirst)

export interface FillActivitiesRequest {
  readonly url: URL
  readonly pageSize: number
}

const fillActivitiesRequestDataFirst = (
  connection: BrokerConnection,
  query: FillActivitiesQuery,
): FillActivitiesRequest => {
  const url = new URL('/v2/account/activities/FILL', connection.baseUrl)
  const pageSize = query.pageSize ?? defaultFillActivitiesPageSize
  if (query.date !== undefined) url.searchParams.set('date', query.date)
  if (query.after !== undefined) url.searchParams.set('after', query.after)
  if (query.until !== undefined) url.searchParams.set('until', query.until)
  if (query.direction !== undefined) url.searchParams.set('direction', query.direction)
  url.searchParams.set('page_size', String(pageSize))
  if (query.pageToken !== undefined) url.searchParams.set('page_token', query.pageToken)
  return { url, pageSize }
}

export const fillActivitiesRequest = Pipeable.dual(2, fillActivitiesRequestDataFirst)

const responseEvidenceResultDataFirst = (
  headers: typeof ResponseHeadersSchema.Type,
  status: number,
  contentHash: string,
  observedAt: string,
): Result.Result<ReadEvidence, BrokerReadContractFailure> => {
  const limit = headers['x-ratelimit-limit']
  const remaining = headers['x-ratelimit-remaining']
  if (limit !== undefined && remaining !== undefined && BigInt(remaining) > BigInt(limit)) {
    return Result.fail(
      contractFailure('RATE_LIMIT', 'rate-limit remaining exceeds limit', {
        field: 'x-ratelimit-remaining',
        expected: `<=${limit}`,
        actual: remaining,
      }),
    )
  }
  const rateLimit =
    limit === undefined &&
    remaining === undefined &&
    headers['x-ratelimit-reset'] === undefined &&
    headers['retry-after'] === undefined
      ? undefined
      : {
          ...(limit === undefined ? {} : { limit }),
          ...(remaining === undefined ? {} : { remaining }),
          ...(headers['x-ratelimit-reset'] === undefined ? {} : { reset: headers['x-ratelimit-reset'] }),
          ...(headers['retry-after'] === undefined ? {} : { retryAfter: headers['retry-after'] }),
        }
  return Result.succeed({
    requestId: headers['x-request-id'],
    status,
    contentHash,
    observedAt,
    ...(rateLimit === undefined ? {} : { rateLimit }),
  })
}

export const responseEvidenceResult = Pipeable.dual(4, responseEvidenceResultDataFirst)
