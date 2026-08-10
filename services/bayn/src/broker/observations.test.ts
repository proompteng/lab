import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import {
  AccountStatus as AlpacaAccountStatus,
  AssetClass,
  AssetExchange,
  OrderClass,
  OrderSide as AlpacaOrderSide,
  OrderStatus as AlpacaOrderStatus,
  OrderType as AlpacaOrderType,
  PositionSide,
  TimeInForce as AlpacaTimeInForce,
  TradeActivityType,
  type Account as AlpacaAccount,
  type FillActivity,
  type Order as AlpacaOrder,
  type Position as AlpacaPosition,
  type ReadEvidence,
} from './alpaca'
import { AccountStatus, OrderSide, OrderStatus } from '../paper'
import {
  accountObservation,
  fillObservation,
  orderObservation,
  positionSnapshot,
  renderBrokerObservationError,
  sourceTimestamp,
  type BrokerObservationError,
} from './observations'

const success = <A>(result: Result.Result<A, BrokerObservationError>): A => Result.getOrThrow(result)
const failure = <A>(result: Result.Result<A, BrokerObservationError>): BrokerObservationError => {
  if (Result.isFailure(result)) return result.failure
  return expect.unreachable('expected broker observation failure')
}

const observedAt = '2026-07-22T15:30:01.000Z'
const evidence: ReadEvidence = {
  requestId: 'request-1',
  status: 200,
  contentHash: 'a'.repeat(64),
  observedAt,
}

const account: AlpacaAccount = {
  id: '61e69015-8549-4bfd-b9c3-01e75843f47d',
  status: AlpacaAccountStatus.Active,
  currency: 'USD',
  cashMicros: '1000000000',
  equityMicros: '1200000000',
  lastEquityMicros: '1200000000',
  buyingPowerMicros: '2000000000',
  accountBlocked: false,
  tradingBlocked: false,
  tradeSuspendedByUser: false,
  observedAt,
}

const order: AlpacaOrder = {
  accountId: account.id,
  brokerOrderId: '8efc7b9a-8b2b-4000-9955-d36e7db0df74',
  clientOrderId: 'bayn-order-1',
  createdAt: '2026-07-22T15:29:59.000Z',
  updatedAt: '2026-07-22T15:30:00.500123Z',
  submittedAt: '2026-07-22T15:29:59.100Z',
  assetId: '9f1f6f68-9d4b-4db5-9b24-3fe1c15b5b4c',
  symbol: 'NVDA',
  assetClass: AssetClass.UsEquity,
  quantityMicros: '2000000',
  filledQuantityMicros: '1000000',
  filledAveragePriceMicros: '100000000',
  orderClass: OrderClass.Simple,
  orderType: AlpacaOrderType.Market,
  side: AlpacaOrderSide.Buy,
  timeInForce: AlpacaTimeInForce.Day,
  status: AlpacaOrderStatus.PendingCancel,
  extendedHours: false,
  observedAt,
}

const activity: FillActivity = {
  accountId: account.id,
  activityId: '20260722153000000::5f596936-6f23-4cef-bdf1-3806aae57dbf',
  cumulativeQuantityMicros: '1000000',
  leavesQuantityMicros: '1000000',
  priceMicros: '100000000',
  quantityMicros: '1000000',
  side: AlpacaOrderSide.Buy,
  symbol: 'NVDA',
  transactionTime: '2026-07-22T15:30:00.000987Z',
  brokerOrderId: order.brokerOrderId,
  type: TradeActivityType.PartialFill,
  orderStatus: AlpacaOrderStatus.PartiallyFilled,
}

describe('paper broker observations', () => {
  test('normalizes account status and preserves observation freshness', () => {
    const first = success(accountObservation({ value: account, evidence }))
    const replay = success(accountObservation({ value: account, evidence: { ...evidence, requestId: 'request-2' } }))

    expect(first._tag).toBe('Account')
    if (first._tag !== 'Account') throw new Error('expected account observation')
    expect(first.account.status).toBe(AccountStatus.Active)
    expect(first.sourceEventId).toBe(`account:${evidence.contentHash}:${observedAt}`)
    expect(replay).toEqual(first)
    const laterObservedAt = '2026-07-22T15:31:01.000Z'
    const later = success(
      accountObservation({
        value: { ...account, observedAt: laterObservedAt },
        evidence: { ...evidence, observedAt: laterObservedAt },
      }),
    )
    expect(later.sourceEventId).not.toBe(first.sourceEventId)
    expect(later.contentHash).toBe(first.contentHash)
    const restricted = success(accountObservation({ value: { ...account, tradingBlocked: true }, evidence }))
    expect(restricted._tag === 'Account' && restricted.account.status).toBe(AccountStatus.Restricted)
  })

  test('normalizes a complete position response into distinct stable events', () => {
    const positions: readonly AlpacaPosition[] = [
      {
        accountId: account.id,
        assetId: 'asset-1',
        symbol: 'NVDA',
        exchange: AssetExchange.Nasdaq,
        assetClass: AssetClass.UsEquity,
        side: PositionSide.Long,
        quantityMicros: '1000000',
        averageEntryPriceMicros: '100000000',
        marketPriceMicros: '110000000',
        marketValueMicros: '110000000',
        unrealizedPnlMicros: '10000000',
        observedAt,
      },
      {
        accountId: account.id,
        assetId: 'asset-2',
        symbol: 'AMD',
        exchange: AssetExchange.Nasdaq,
        assetClass: AssetClass.UsEquity,
        side: PositionSide.Short,
        quantityMicros: '-2000000',
        averageEntryPriceMicros: '150000000',
        marketPriceMicros: '140000000',
        marketValueMicros: '-280000000',
        unrealizedPnlMicros: '20000000',
        observedAt,
      },
    ]
    const snapshot = success(positionSnapshot(account.id, { value: positions, evidence }))
    const events = snapshot.positions

    expect(events).toHaveLength(2)
    expect(events.map((event) => (event._tag === 'Position' ? event.position.symbol : ''))).toEqual(['AMD', 'NVDA'])
    expect(new Set(events.map((event) => event.sourceEventId)).size).toBe(2)
    const laterObservedAt = '2026-07-22T15:31:01.000Z'
    const later = success(
      positionSnapshot(account.id, {
        value: positions.map((position) => ({ ...position, observedAt: laterObservedAt })),
        evidence: { ...evidence, observedAt: laterObservedAt },
      }),
    ).positions
    expect(later.map((event) => event.sourceEventId)).not.toEqual(events.map((event) => event.sourceEventId))
    expect(later.map((event) => event.contentHash)).toEqual(events.map((event) => event.contentHash))
    expect(
      failure(positionSnapshot(account.id, { value: [positions[0], { ...positions[1], symbol: 'NVDA' }], evidence })),
    ).toEqual({ _tag: 'DuplicatePositionSymbol', symbol: 'NVDA' })
    expect(success(positionSnapshot(account.id, { value: [], evidence })).positions).toEqual([])
  })

  test('maps a partially filled pending order without discarding fill state', () => {
    const event = success(orderObservation(order, evidence, 'b'.repeat(64)))

    expect(event._tag).toBe('Order')
    if (event._tag !== 'Order') throw new Error('expected order observation')
    expect(event.order).toMatchObject({
      side: OrderSide.Buy,
      status: OrderStatus.PartiallyFilled,
      filledQuantityMicros: '1000000',
      intentId: 'b'.repeat(64),
    })
    expect(event.occurredAt).toBe('2026-07-22T15:30:00.500Z')
    expect(event.sourceEventId).toBe(`order:${order.brokerOrderId}:${order.updatedAt}`)
    expect(failure(orderObservation({ ...order, extendedHours: true }, evidence))).toEqual({
      _tag: 'ExtendedHoursUnsupported',
      brokerOrderId: order.brokerOrderId,
    })
    const { updatedAt: _omittedUpdatedAt, ...orderWithoutUpdatedAt } = order
    expect(failure(orderObservation(orderWithoutUpdatedAt, evidence))).toEqual({
      _tag: 'OrderUpdatedAtMissing',
      brokerOrderId: order.brokerOrderId,
    })
  })

  test('binds a fill to its order and defaults paper fees to zero', () => {
    const event = success(fillObservation(activity, order, evidence, { intentId: 'b'.repeat(64) }))

    expect(event.fill).toMatchObject({
      fillId: activity.activityId,
      clientOrderId: order.clientOrderId,
      feeMicros: '0',
      intentId: 'b'.repeat(64),
      occurredAt: '2026-07-22T15:30:00.000Z',
    })
    expect(event.sourceTimestamp).toBe('2026-07-22T15:30:00.000987000Z')
    expect(failure(fillObservation({ ...activity, symbol: 'AMD' }, order, evidence))).toEqual({
      _tag: 'FillOrderMismatch',
      activityId: activity.activityId,
      brokerOrderId: order.brokerOrderId,
    })
  })

  test('returns closed fact-bearing failures for malformed broker observations', () => {
    expect(failure(sourceTimestamp('not-a-timestamp'))).toEqual({
      _tag: 'TimestampInvalid',
      value: 'not-a-timestamp',
    })
    expect(failure(sourceTimestamp('2026-99-99T15:30:00Z'))).toEqual({
      _tag: 'TimestampInvalid',
      value: '2026-99-99T15:30:00Z',
    })
    expect(
      failure(
        accountObservation({
          value: account,
          evidence: { ...evidence, observedAt: '2026-07-22T15:30:02.000Z' },
        }),
      ),
    ).toEqual({
      _tag: 'ObservationTimeMismatch',
      valueObservedAt: observedAt,
      evidenceObservedAt: '2026-07-22T15:30:02.000Z',
    })
    const unsupported = failure(orderObservation({ ...order, orderType: AlpacaOrderType.Stop }, evidence))
    expect(unsupported).toEqual({ _tag: 'UnsupportedOrderType', value: AlpacaOrderType.Stop })
    expect(renderBrokerObservationError(unsupported)).toBe('unsupported paper order type stop')

    expect(failure(orderObservation({ ...order, filledQuantityMicros: '+1' }, evidence))).toEqual({
      _tag: 'FilledQuantityInvalid',
      filledQuantityMicros: '+1',
      quantityMicros: '2000000',
    })

    expect(failure(accountObservation({ value: { ...account, id: '\ud800' }, evidence }))).toMatchObject({
      _tag: 'CanonicalizationFailed',
      target: 'account',
      cause: {
        _tag: 'CanonicalJsonFailure',
        path: '$.account.accountId',
        reason: 'invalid-unicode-surrogate',
        actualType: 'string',
      },
    })
  })
})
