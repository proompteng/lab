import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { projectBrokerTradeUpdate, BrokerStreamReconciliationReason } from './trade-update-projection'
import type { BrokerNotification } from './notifications'
import { BrokerEnvironment } from './identity'
import { decodeOrder } from './alpaca/model'
import { normalizeOrderResult } from './alpaca/normalizers'
import { orderObservation, type BrokerEventInput } from './observations'
import { decideOrderVersion } from '../db/execution-store/decisions'
import type { IntentBinding } from '../db/intent-bindings'
import { OrderStatus, type Order } from '../execution/contracts'
import { sha256 } from '../hash'

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
const parentOrderId = '96fb36eb-8b7c-4341-b767-b0106c6b52cf'
const protectionBinding: IntentBinding = {
  ...binding,
  symbol: 'AAPL',
  quantityAtoms: '2000000000',
  protection: {
    _tag: 'Bracket',
    stopPriceMicros: '120000000',
    stopLimitPriceMicros: '119000000',
    profitLimitPriceMicros: '130000000',
  },
}
const childOrder = {
  ...order,
  client_order_id: 'broker-generated-child',
  status: 'held',
  filled_at: null,
  filled_qty: '0',
  filled_avg_price: null,
  qty: '2',
  side: 'sell',
  type: 'stop_limit',
  order_type: 'stop_limit',
  order_class: 'bracket',
  limit_price: '119',
  stop_price: '120',
  group_id: '693d7d82-e1e9-4d78-acd2-e720b5724c41',
  group_role: 'stop_loss',
}
const childNotification = (
  event = 'held',
  overrides: Record<string, unknown> = {},
  fields: Record<string, unknown> = {},
) =>
  notification({
    event,
    timestamp: '2026-11-11T17:37:18.784802123Z',
    order: { ...childOrder, status: event, ...overrides },
    ...fields,
  })
const canonicalChild = (source: BrokerNotification): Extract<BrokerEventInput, { readonly _tag: 'Order' }> => {
  if (source._tag !== 'TradeUpdate') throw new Error('expected trade update fixture')
  const raw = JSON.parse(source.frameJson).data.order
  const normalized = Result.getOrThrow(
    normalizeOrderResult(Result.getOrThrow(decodeOrder(raw)), accountId, source.receivedAt),
  )
  const event = Result.getOrThrow(
    orderObservation(
      { ...normalized, parentBrokerOrderId: parentOrderId },
      { status: 200, requestId: source.eventId, contentHash: sha256(source.frameJson), observedAt: source.receivedAt },
      intentId,
    ),
  )
  if (event._tag !== 'Order') throw new Error('expected canonical child order')
  return event
}
const canonicalChildOrder = (source = childNotification()): Order => {
  const event = canonicalChild(source)
  if (event._tag !== 'Order') throw new Error('expected canonical child order')
  return event.order
}

describe('broker trade-update projection', () => {
  test.each(['held', 'accepted'])('projects a valid %s lifecycle observation without inventing a fill', (event) => {
    const result = projectBrokerTradeUpdate(
      notification({
        event,
        timestamp: '2026-11-11T17:37:18.784802123Z',
        order: { ...order, status: event, filled_at: null, filled_qty: '0', filled_avg_price: null },
      }),
      [binding],
    )
    expect(result._tag).toBe('Project')
    if (result._tag !== 'Project') throw new Error('expected projected lifecycle')
    expect(result.order.order).toMatchObject({ intentId, status: 'PENDING', filledQuantityAtoms: '0' })
    expect(result.fill).toBeUndefined()
  })

  test.each(['held', 'accepted'])(
    'defers an early %s child until its exact canonical parent binding exists',
    (event) => {
      const source = childNotification(event)
      expect(projectBrokerTradeUpdate(source, [protectionBinding])).toEqual({
        _tag: 'ProtectionBindingRequired',
        eventId: source.eventId,
        observedAt: source.receivedAt,
        brokerOrderId: orderId,
        clientOrderId: childOrder.client_order_id,
        canWait: true,
      })
      const projected = projectBrokerTradeUpdate(source, [protectionBinding], canonicalChildOrder(source))
      expect(projected._tag).toBe('Project')
      if (projected._tag !== 'Project') throw new Error('expected canonical child projection')
      expect(projected.order).toEqual(canonicalChild(source))
      expect(projected.fill).toBeUndefined()
      expect(projectBrokerTradeUpdate(source, [protectionBinding], canonicalChildOrder(source))).toEqual(projected)
    },
  )

  test.each(['new', 'canceled', 'partial_fill', 'fill'])(
    'retains canonical child identity through %s updates',
    (event) => {
      const filled = event === 'partial_fill' ? '0.5' : event === 'fill' ? '2' : '0'
      const fields =
        event === 'partial_fill' || event === 'fill' ? { execution_id: executionId, price: '120', qty: filled } : {}
      const source = childNotification(
        event,
        {
          status: event === 'partial_fill' ? 'partially_filled' : event === 'fill' ? 'filled' : event,
          filled_qty: filled,
          filled_avg_price: filled === '0' ? null : '120',
          filled_at: event === 'fill' ? '2026-11-11T17:37:18.784802Z' : null,
        },
        fields,
      )
      const result = projectBrokerTradeUpdate(source, [protectionBinding], canonicalChildOrder())
      expect(result._tag).toBe('Project')
      if (result._tag !== 'Project') throw new Error('expected child lifecycle projection')
      expect(result.order).toEqual(canonicalChild(source))
      expect(result.fill === undefined).toBe(filled === '0')
      if (result.fill !== undefined) expect(result.fill.fill.intentId).toBe(intentId)
    },
  )

  test('a child precision-equivalent REST replay still requires the complete normalized parent and order content', () => {
    const source = childNotification('held', { updated_at: '2026-11-11T17:37:18.784802123Z' })
    const projection = projectBrokerTradeUpdate(source, [protectionBinding], canonicalChildOrder())
    if (projection._tag !== 'Project') throw new Error('expected protected child projection')
    const retained = {
      event_id: '6'.repeat(64),
      broker_order_id: orderId,
      content_hash: projection.order.contentHash,
      source_event_id: projection.order.sourceEventId,
      source_sequence: '7',
      broker_updated_at: projection.order.sourceTimestamp,
    }
    const replay = canonicalChild(childNotification())
    expect(Result.getOrThrow(decideOrderVersion(replay, retained))._tag).toBe('RetainEquivalentOrderVersion')
    for (const change of [
      { parentBrokerOrderId: 'foreign-parent' },
      { status: OrderStatus.Canceled },
      { filledQuantityAtoms: '1000000000' },
      { stopPriceMicros: '118000000' },
      { intentId: '9'.repeat(64) },
    ])
      expect(
        Result.getOrThrow(decideOrderVersion({ ...replay, order: { ...replay.order, ...change } }, retained))._tag,
      ).toBe('SupersedeOrderVersion')
  })

  test.each([
    ['account', { accountId: 'foreign-account' }],
    ['broker order', { brokerOrderId: parentOrderId }],
    ['client order', { clientOrderId: 'foreign-client' }],
    ['intent', { intentId: '9'.repeat(64) }],
    ['parent', { parentBrokerOrderId: orderId }],
    ['symbol', { symbol: 'MSFT' }],
    ['side', { side: 'BUY' }],
    ['type', { orderType: 'LIMIT' }],
    ['duration', { timeInForce: 'GTC' }],
  ] as const)('rejects a canonical child proof with a different %s', (_name, change) => {
    const proof = { ...canonicalChildOrder(), ...change } as Order
    expect(projectBrokerTradeUpdate(childNotification(), [protectionBinding], proof)).toMatchObject({
      _tag: 'ReconcileRequired',
      reason: BrokerStreamReconciliationReason.InvalidOrder,
    })
  })

  test.each([
    ['stop', { stop_price: '118' }],
    ['limit', { limit_price: '118' }],
    ['quantity', { qty: '3' }],
    ['side', { side: 'buy' }],
    ['role', { group_role: 'take_profit' }],
    ['class', { order_class: 'oco' }],
  ])('rejects a child whose %s differs from its immutable protection', (_name, change) => {
    expect(
      projectBrokerTradeUpdate(childNotification('held', change), [protectionBinding], canonicalChildOrder())._tag,
    ).toBe('ReconcileRequired')
  })

  test.each([
    { filled_qty: '1' },
    { status: 'filled', filled_qty: '2' },
    { filled_at: order.filled_at },
    { filled_avg_price: '120' },
    { group_id: 'malformed' },
    { group_role: 'unrecognized' },
  ])('fails closed for malformed or financial lifecycle content %j', (change) => {
    expect(
      projectBrokerTradeUpdate(childNotification('held', change), [protectionBinding], canonicalChildOrder())._tag,
    ).toBe('ReconcileRequired')
  })

  test.each([{ execution_id: executionId }, { price: '120' }, { qty: '0' }])(
    'never treats fill-bearing held events as nonfinancial waits %j',
    (fields) => {
      expect(projectBrokerTradeUpdate(childNotification('held', {}, fields), [protectionBinding])).toMatchObject({
        _tag: 'ReconcileRequired',
        reason: BrokerStreamReconciliationReason.InvalidOrder,
      })
    },
  )

  test('unknown or duplicate intent evidence cannot bind a protective child', () => {
    const source = childNotification()
    expect(projectBrokerTradeUpdate(source, [], canonicalChildOrder())._tag).toBe('ReconcileRequired')
    expect(projectBrokerTradeUpdate(source, [protectionBinding, protectionBinding], canonicalChildOrder())._tag).toBe(
      'ReconcileRequired',
    )
    expect(projectBrokerTradeUpdate(childNotification('held', { group_id: null }), [protectionBinding])).toMatchObject({
      _tag: 'ReconcileRequired',
      reason: BrokerStreamReconciliationReason.MissingIntent,
    })
  })

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
