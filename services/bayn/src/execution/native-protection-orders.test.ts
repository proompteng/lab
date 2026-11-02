import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { type OrderRequestIntent, orderRequestBody } from '../broker/alpaca-mutations/decisions'
import {
  AssetClass,
  OrderClass,
  OrderSide as BrokerSide,
  OrderStatus,
  OrderType as BrokerType,
  TimeInForce as BrokerDuration,
  type Order,
} from '../broker/alpaca/model'
import { verifyProtectionGroup } from '../broker/alpaca/protection-group'
import { OrderSide, OrderType, TimeInForce } from './contracts'

const levels = { stopPriceMicros: '99000000', stopLimitPriceMicros: '98900000', profitLimitPriceMicros: '102000000' }
const entry: OrderRequestIntent = {
  symbol: 'AAPL',
  side: OrderSide.Buy,
  orderType: OrderType.Limit,
  timeInForce: TimeInForce.Day,
  quantityAtoms: '1000000000',
  notionalLimitMicros: '100000000',
  limitPriceMicros: '100000000',
  clientOrderId: 'entry',
  protection: { _tag: 'Bracket' as const, ...levels },
}
const at = '2026-10-19T17:00:00.000Z'
const order = (patch: Partial<Order>): Order => ({
  accountId: 'account',
  brokerOrderId: 'parent',
  clientOrderId: 'entry',
  createdAt: at,
  updatedAt: at,
  assetId: 'asset',
  symbol: 'AAPL',
  assetClass: AssetClass.UsEquity,
  quantityAtoms: '1000000000',
  filledQuantityAtoms: '0',
  orderClass: OrderClass.Bracket,
  orderType: BrokerType.Limit,
  side: BrokerSide.Buy,
  timeInForce: BrokerDuration.Day,
  limitPriceMicros: '100000000',
  status: OrderStatus.New,
  extendedHours: false,
  observedAt: at,
  ...patch,
})
const group = (): Order =>
  order({
    filledQuantityAtoms: '1000000000',
    status: OrderStatus.Filled,
    legs: [
      order({
        brokerOrderId: 'profit',
        parentBrokerOrderId: 'parent',
        clientOrderId: 'alpaca-generated-profit',
        side: BrokerSide.Sell,
        limitPriceMicros: levels.profitLimitPriceMicros,
      }),
      order({
        brokerOrderId: 'stop',
        parentBrokerOrderId: 'parent',
        clientOrderId: 'alpaca-generated-stop',
        side: BrokerSide.Sell,
        orderType: BrokerType.StopLimit,
        limitPriceMicros: levels.stopLimitPriceMicros,
        stopPriceMicros: levels.stopPriceMicros,
      }),
    ],
  })
const expected = {
  symbol: entry.symbol,
  quantityAtoms: entry.quantityAtoms,
  protection: { _tag: 'Bracket' as const, ...levels },
}

test('a whole-share entry transmits both immutable exit legs in its bracket request', () => {
  expect(Result.getOrThrow(orderRequestBody(entry))).toEqual({
    symbol: 'AAPL',
    qty: '1',
    side: BrokerSide.Buy,
    type: BrokerType.Limit,
    time_in_force: BrokerDuration.Day,
    limit_price: '100',
    client_order_id: 'entry',
    extended_hours: false,
    order_class: 'bracket',
    take_profit: { limit_price: '102' },
    stop_loss: { stop_price: '99', limit_price: '98.9' },
  })
  const changed = { ...entry, protection: { _tag: 'Bracket' as const, ...levels, stopPriceMicros: '103000000' } }
  expect(Result.isFailure(orderRequestBody(changed))).toBe(true)
  expect(
    Result.isFailure(orderRequestBody({ ...entry, quantityAtoms: '1500000000', notionalLimitMicros: '150000000' })),
  ).toBe(true)
})

test('crypto protection is a standalone GTC stop-limit and its target is managed by the strategy', () => {
  const stop = {
    ...entry,
    symbol: 'BTC/USD',
    side: OrderSide.Sell,
    orderType: OrderType.StopLimit,
    timeInForce: TimeInForce.GoodUntilCanceled,
    limitPriceMicros: '98900000',
    notionalLimitMicros: '98900000',
    protection: {
      _tag: 'StopLimit' as const,
      stopPriceMicros: levels.stopPriceMicros,
      entryDecisionHash: 'a'.repeat(64),
    },
  }
  expect(Result.getOrThrow(orderRequestBody(stop))).toEqual({
    symbol: 'BTC/USD',
    qty: '1',
    side: BrokerSide.Sell,
    type: BrokerType.StopLimit,
    time_in_force: BrokerDuration.GoodUntilCanceled,
    limit_price: '98.9',
    stop_price: '99',
    client_order_id: 'entry',
    extended_hours: false,
  })
  expect(Result.isFailure(orderRequestBody({ ...stop, timeInForce: TimeInForce.ImmediateOrCancel }))).toBe(true)
  expect(Result.isFailure(orderRequestBody({ ...stop, protection: { _tag: 'Bracket' as const, ...levels } }))).toBe(
    true,
  )
})

test('nested child identity is accepted only with exact parent, side, strategy prices, quantity and distinct IDs', () => {
  expect(Result.getOrThrow(verifyProtectionGroup(group(), expected))).toHaveLength(2)
  const parent = group()
  for (const patch of [
    { side: BrokerSide.Buy },
    { stopPriceMicros: '98000000' },
    { quantityAtoms: '2000000000' },
    { parentBrokerOrderId: 'unrelated' },
    { clientOrderId: 'entry' },
  ]) {
    const [profit, stop] = parent.legs ?? []
    if (profit === undefined || stop === undefined) throw new Error('group fixture missing')
    expect(
      Result.isFailure(verifyProtectionGroup({ ...parent, legs: [profit, { ...stop, ...patch }] }, expected)),
    ).toBe(true)
  }
  expect(Result.isFailure(verifyProtectionGroup({ ...parent, legs: [] }, expected))).toBe(true)
})

test('partial take-profit fills preserve the original price levels while reducing sibling coverage', () => {
  const parent = group()
  const [profit, stop] = parent.legs ?? []
  if (profit === undefined || stop === undefined) throw new Error('group fixture missing')
  expect(
    Result.isSuccess(
      verifyProtectionGroup(
        {
          ...parent,
          legs: [
            { ...profit, filledQuantityAtoms: '400000000', status: OrderStatus.PartiallyFilled },
            { ...stop, quantityAtoms: '600000000' },
          ],
        },
        expected,
      ),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      verifyProtectionGroup(
        {
          ...parent,
          legs: [
            { ...profit, filledQuantityAtoms: '400000000' },
            { ...stop, quantityAtoms: '500000000' },
          ],
        },
        expected,
      ),
    ),
  ).toBe(true)
})
