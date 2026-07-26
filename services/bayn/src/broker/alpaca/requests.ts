import { Result } from 'effect'

import { contractFailure, type BrokerReadContractFailure } from './failures'
import {
  ResponseHeadersSchema,
  accountConfigurationObservationSchemaVersion,
  accountConfigurationObservationSource,
  assetObservationSchemaVersion,
  assetObservationSource,
  defaultFillActivitiesPageSize,
  paperTradingUrl,
  type FillActivitiesQuery,
  type MarketCalendarQuery,
  type OrdersQuery,
  type ReadEvidence,
} from './model'

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

export const accountUrl = (): URL => new URL('/v2/account', paperTradingUrl)

export const accountConfigurationUrl = (): URL => new URL(accountConfigurationRequestMaterial.path, paperTradingUrl)

export const positionsUrl = (): URL => new URL('/v2/positions', paperTradingUrl)

export const assetBySymbolUrl = (requestedSymbol: string): URL =>
  new URL(assetRequestMaterial(requestedSymbol).path, paperTradingUrl)

export const marketCalendarUrl = (query: MarketCalendarQuery): URL => {
  const url = new URL('/v2/calendar', paperTradingUrl)
  url.searchParams.set('start', query.start)
  url.searchParams.set('end', query.end)
  url.searchParams.set('date_type', 'TRADING')
  return url
}

export const ordersUrl = (query: OrdersQuery): URL => {
  const url = new URL('/v2/orders', paperTradingUrl)
  if (query.status !== undefined) url.searchParams.set('status', query.status)
  if (query.limit !== undefined) url.searchParams.set('limit', String(query.limit))
  if (query.after !== undefined) url.searchParams.set('after', query.after)
  if (query.until !== undefined) url.searchParams.set('until', query.until)
  if (query.direction !== undefined) url.searchParams.set('direction', query.direction)
  if (query.side !== undefined) url.searchParams.set('side', query.side)
  if (query.symbols !== undefined) url.searchParams.set('symbols', query.symbols.join(','))
  return url
}

export const orderByIdUrl = (orderId: string): URL =>
  new URL(`/v2/orders/${encodeURIComponent(orderId)}`, paperTradingUrl)

export const orderByClientIdUrl = (clientOrderId: string): URL => {
  const url = new URL('/v2/orders:by_client_order_id', paperTradingUrl)
  url.searchParams.set('client_order_id', clientOrderId)
  return url
}

export interface FillActivitiesRequest {
  readonly url: URL
  readonly pageSize: number
}

export const fillActivitiesRequest = (query: FillActivitiesQuery): FillActivitiesRequest => {
  const url = new URL('/v2/account/activities/FILL', paperTradingUrl)
  const pageSize = query.pageSize ?? defaultFillActivitiesPageSize
  if (query.date !== undefined) url.searchParams.set('date', query.date)
  if (query.after !== undefined) url.searchParams.set('after', query.after)
  if (query.until !== undefined) url.searchParams.set('until', query.until)
  if (query.direction !== undefined) url.searchParams.set('direction', query.direction)
  url.searchParams.set('page_size', String(pageSize))
  if (query.pageToken !== undefined) url.searchParams.set('page_token', query.pageToken)
  return { url, pageSize }
}

export const responseEvidenceResult = (
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
          limit,
          remaining,
          reset: headers['x-ratelimit-reset'],
          retryAfter: headers['retry-after'],
        }
  return Result.succeed({
    requestId: headers['x-request-id'],
    status,
    contentHash,
    observedAt,
    rateLimit,
  })
}
