import {
  OrderClass,
  OrderType,
  OrderSide,
  OrderStatus,
  TimeInForce,
  type Order,
  type StableBrokerSnapshot,
} from '../broker/alpaca/model'
import { observedBrokerSnapshotFixture } from '../broker/alpaca/observed-snapshot.fixture'
import type { IntentBinding } from '../db/reconciliation'

export const normalizationFixture = (size: number) => {
  const at = '2026-10-25T00:00:00.000Z'
  const fixture = observedBrokerSnapshotFixture('normalization-account', at, at).snapshot
  const example = fixture.history.orders.rows[0]
  if (example === undefined) throw new Error('normalization fixture requires an order')
  const bindings: IntentBinding[] = Array.from({ length: size }, (_, i) => ({
    intentId: i.toString(16).padStart(64, '0'),
    clientOrderId: `client-order-${i}`,
    symbol: 'AAPL',
    quantityAtoms: '1000000000',
    protection: {
      _tag: 'Bracket',
      stopPriceMicros: '190000000',
      stopLimitPriceMicros: '189000000',
      profitLimitPriceMicros: '210000000',
    },
  }))
  const rows = bindings
    .map((binding, i) => {
      const parent: Order = {
        ...example.value,
        brokerOrderId: `order-${i}`,
        clientOrderId: binding.clientOrderId,
        orderClass: OrderClass.Bracket,
        timeInForce: TimeInForce.Day,
        limitPriceMicros: '200000000',
      }
      const legs: Order[] = [OrderType.StopLimit, OrderType.Limit].map((orderType, j) => ({
        ...parent,
        brokerOrderId: `child-${i}-${j}`,
        clientOrderId: `child-client-${i}-${j}`,
        parentBrokerOrderId: parent.brokerOrderId,
        orderClass: OrderClass.Simple,
        orderType,
        status: OrderStatus.Canceled,
        side: OrderSide.Sell,
        filledQuantityAtoms: '0',
        limitPriceMicros: j === 0 ? '189000000' : '210000000',
        ...(j === 0 ? { stopPriceMicros: '190000000' } : {}),
      }))
      return { ...example, value: { ...parent, legs } }
    })
    .reverse()
  const snapshot: StableBrokerSnapshot = {
    ...fixture,
    history: { ...fixture.history, orders: { ...fixture.history.orders, rows }, fills: [] },
  }
  return { snapshot, bindings }
}
