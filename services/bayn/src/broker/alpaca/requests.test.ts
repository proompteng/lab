import { describe, expect, test } from 'bun:test'

import { Redacted, Result } from 'effect'

import { BrokerEnvironment } from '../../execution/authority'
import { BrokerProvider, alpacaSandboxBaseUrl, decodeBrokerConnection } from '../connection'
import { OrderCollection, OrderSide, SortDirection } from './model'
import {
  accountConfigurationUrl,
  accountUrl,
  assetBySymbolUrl,
  fillActivitiesRequest,
  marketCalendarUrl,
  orderByClientIdUrl,
  orderByIdUrl,
  ordersUrl,
  positionsUrl,
} from './requests'

const connection = Result.getOrThrow(
  decodeBrokerConnection({
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    baseUrl: alpacaSandboxBaseUrl,
    expectedAccountId: 'e6fe16f3-64a4-4921-8928-cadf02f92f98',
    key: Redacted.make('key'),
    secret: Redacted.make('secret'),
    proxyUrl: 'http://proxy.test:3128',
    operationTimeoutMs: 30_000,
    retryAttempts: 2,
  }),
)

describe('Alpaca read request builders', () => {
  test('binds every fixed read endpoint to the verified connection', () => {
    expect(accountUrl(connection).toString()).toBe(`${alpacaSandboxBaseUrl}/v2/account`)
    expect(accountConfigurationUrl(connection).toString()).toBe(`${alpacaSandboxBaseUrl}/v2/account/configurations`)
    expect(positionsUrl(connection).toString()).toBe(`${alpacaSandboxBaseUrl}/v2/positions`)
    expect(assetBySymbolUrl(connection, 'BRK/B').toString()).toBe(`${alpacaSandboxBaseUrl}/v2/assets/BRK%2FB`)
    expect(orderByIdUrl(connection, 'order/id').toString()).toBe(`${alpacaSandboxBaseUrl}/v2/orders/order%2Fid`)
    expect(orderByClientIdUrl(connection, 'client/order').toString()).toBe(
      `${alpacaSandboxBaseUrl}/v2/orders:by_client_order_id?client_order_id=client%2Forder`,
    )
  })

  test('constructs ordered, encoded collection and calendar queries from decoded values', () => {
    expect(
      ordersUrl(connection, {
        status: OrderCollection.All,
        limit: 25,
        after: '2026-07-01T00:00:00Z',
        until: '2026-07-02T00:00:00Z',
        direction: SortDirection.Ascending,
        side: OrderSide.Buy,
        symbols: ['AAPL', 'BRK/B'],
      }).toString(),
    ).toBe(
      `${alpacaSandboxBaseUrl}/v2/orders?status=all&limit=25&after=2026-07-01T00%3A00%3A00Z&until=2026-07-02T00%3A00%3A00Z&direction=asc&side=buy&symbols=AAPL%2CBRK%2FB`,
    )
    expect(marketCalendarUrl(connection, { start: '2026-07-01', end: '2026-07-03' }).toString()).toBe(
      `${alpacaSandboxBaseUrl}/v2/calendar?start=2026-07-01&end=2026-07-03&date_type=TRADING`,
    )
  })

  test('preserves fill pagination metadata while binding the verified endpoint', () => {
    const request = fillActivitiesRequest(connection, {
      date: '2026-07-01',
      after: '2026-07-01T00:00:00Z',
      until: '2026-07-02T00:00:00Z',
      direction: SortDirection.Descending,
      pageSize: 17,
      pageToken: 'cursor::order',
    })

    expect(request.pageSize).toBe(17)
    expect(request.url.toString()).toBe(
      `${alpacaSandboxBaseUrl}/v2/account/activities/FILL?date=2026-07-01&after=2026-07-01T00%3A00%3A00Z&until=2026-07-02T00%3A00%3A00Z&direction=desc&page_size=17&page_token=cursor%3A%3Aorder`,
    )
  })
})
