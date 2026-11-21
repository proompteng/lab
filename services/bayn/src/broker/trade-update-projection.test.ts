import { describe, expect, test } from 'bun:test'

import { projectBrokerTradeUpdate, BrokerStreamReconciliationReason } from './trade-update-projection'
import type { BrokerNotification } from './notifications'
import { BrokerEnvironment } from './identity'

const accountId = 'e6fe16f3-64a4-4921-8928-cadf02f92f98'
const orderId = '61e69015-8549-4bfd-b9c3-01e75843f47d'
const executionId = 'f2ef6b1a-f277-44fd-945a-cf0461cb1ea4'
const clientOrderId = 'bayn-stream-order'
const intentId = '1'.repeat(64)
const order = {
  id: orderId,
  client_order_id: clientOrderId,
  created_at: '2026-11-11T17:37:01.000000Z',
  updated_at: '2026-11-11T17:37:18.784802Z',
  submitted_at: '2026-11-11T17:37:01.000000Z',
  filled_at: '2026-11-11T17:37:18.784802Z',
  expired_at: null,
  canceled_at: null,
  failed_at: null,
  replaced_at: null,
  replaced_by: null,
  replaces: null,
  asset_id: 'b0b6dd9d-8b9b-48a9-ba46-b9d54906e415',
  symbol: 'AAPL',
  asset_class: 'us_equity',
  notional: null,
  qty: '1.25',
  filled_qty: '1.25',
  filled_avg_price: '123.45',
  order_class: '',
  order_type: 'limit',
  type: 'limit',
  side: 'buy',
  time_in_force: 'day',
  limit_price: '124',
  stop_price: null,
  status: 'filled',
  extended_hours: false,
  legs: null,
  trail_percent: null,
  trail_price: null,
  hwm: null,
}
const notification = (data: Record<string, unknown>): BrokerNotification => ({
  _tag: 'TradeUpdate',
  schemaVersion: 'bayn.broker-notification.v1',
  eventId: '2'.repeat(64),
  session: {
    identityHash: '3'.repeat(64),
    accountId,
    environment: BrokerEnvironment.Sandbox,
    credentialHash: '4'.repeat(64),
    sessionId: 'stream-session',
    sourceRevision: '5'.repeat(40),
    verifiedAt: '2026-11-11T17:37:00.000Z',
    authenticatedAt: '2026-11-11T17:37:00.001Z',
    subscribedAt: '2026-11-11T17:37:00.002Z',
  },
  receivedAt: '2026-11-11T17:37:18.790Z',
  frameJson: JSON.stringify({ stream: 'trade_updates', data }),
})
const binding = { intentId, clientOrderId }

describe('broker trade-update projection', () => {
  test('normalizes a streamed fill to the same immutable order and execution identities used by reconciliation', () => {
    const result = projectBrokerTradeUpdate(
      notification({
        event: 'fill',
        timestamp: '2026-11-11T17:37:18.784802123Z',
        execution_id: executionId,
        price: '123.45',
        qty: '1.25',
        order,
      }),
      [binding],
    )
    expect(result._tag).toBe('Project')
    if (result._tag !== 'Project') throw new Error('expected projected fill')
    expect(result.order).toMatchObject({
      _tag: 'Order',
      sourceEventId: `order:${orderId}:${order.updated_at}`,
      sourceTimestamp: '2026-11-11T17:37:18.784802000Z',
      order: { accountId, brokerOrderId: orderId, clientOrderId, intentId, status: 'FILLED' },
    })
    expect(result.fill).toMatchObject({
      _tag: 'Fill',
      sourceEventId: `20261111123718784::${executionId}`,
      fill: {
        accountId,
        brokerOrderId: orderId,
        clientOrderId,
        intentId,
        quantityAtoms: '1250000000',
        priceAtoms: '123450000000',
      },
    })
  })

  test.each([
    ['missing intent binding', [], BrokerStreamReconciliationReason.MissingIntent],
    ['unknown event', [binding], BrokerStreamReconciliationReason.UnsupportedEvent],
  ])('%s fails closed into explicit reconciliation', (_name, bindings, reason) => {
    const result = projectBrokerTradeUpdate(
      notification({
        event: reason === BrokerStreamReconciliationReason.UnsupportedEvent ? 'future_event' : 'fill',
        timestamp: '2026-11-11T17:37:18.784802123Z',
        order,
      }),
      bindings,
    )
    expect(result).toMatchObject({ _tag: 'ReconcileRequired', reason })
  })
})
