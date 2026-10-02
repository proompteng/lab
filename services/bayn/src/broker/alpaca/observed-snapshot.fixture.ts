import {
  AccountStatus,
  AssetClass,
  OrderClass,
  OrderSide,
  OrderStatus,
  OrderType,
  TimeInForce,
  TradeActivityType,
  accountConfigurationObservationSchemaVersion,
  accountConfigurationObservationSource,
  type ReadResult,
  type Order,
  type FillActivity,
} from './model'
import type { ObservedBrokerSnapshot } from './observed-snapshot'

export const observedBrokerSnapshotFixture = (
  accountId: string,
  observedAt: string,
  sourceTimestamp?: string,
): ObservedBrokerSnapshot => {
  const observe = <A>(value: A): ReadResult<A> => ({
    value,
    evidence: { requestId: 'observation-test', status: 200, contentHash: 'a'.repeat(64), observedAt },
  })
  const orders: readonly Order[] =
    sourceTimestamp === undefined
      ? []
      : [
          {
            accountId,
            brokerOrderId: 'broker-order',
            clientOrderId: 'client-order',
            assetId: 'asset',
            symbol: 'AAPL',
            assetClass: AssetClass.UsEquity,
            createdAt: sourceTimestamp,
            updatedAt: sourceTimestamp,
            submittedAt: sourceTimestamp,
            filledAt: sourceTimestamp,
            observedAt,
            quantityMicros: '1000000',
            filledQuantityMicros: '1000000',
            filledAveragePriceMicros: '200000000',
            orderClass: OrderClass.Simple,
            orderType: OrderType.Limit,
            side: OrderSide.Buy,
            timeInForce: TimeInForce.ImmediateOrCancel,
            status: OrderStatus.Filled,
            extendedHours: false,
          },
        ]
  const fills: readonly FillActivity[] =
    sourceTimestamp === undefined
      ? []
      : [
          {
            accountId,
            activityId: 'fill',
            cumulativeQuantityMicros: '1000000',
            leavesQuantityMicros: '0',
            priceMicros: '200000000',
            quantityMicros: '1000000',
            side: OrderSide.Buy,
            symbol: 'AAPL',
            transactionTime: sourceTimestamp,
            brokerOrderId: 'broker-order',
            type: TradeActivityType.Fill,
            orderStatus: OrderStatus.Filled,
          },
        ]
  return {
    startedAt: observedAt,
    observedAt,
    completedAt: observedAt,
    snapshot: {
      account: observe({
        id: accountId,
        status: AccountStatus.Active,
        currency: 'USD',
        cashMicros: '100000000000',
        equityMicros: '100000000000',
        lastEquityMicros: '100000000000',
        buyingPowerMicros: '100000000000',
        accountBlocked: false,
        tradingBlocked: false,
        tradeSuspendedByUser: false,
        observedAt,
      }),
      positions: observe([]),
      history: { orders: { rows: orders.map(observe), observedAt }, fills: fills.map(observe), fees: [] },
    },
    configuration: observe({
      schemaVersion: accountConfigurationObservationSchemaVersion,
      source: accountConfigurationObservationSource,
      requestHash: 'b'.repeat(64),
      normalizedResponseHash: 'c'.repeat(64),
      fractionalTrading: true,
      observedAt,
    }),
    openOrders: observe([]),
    recentOrders: observe(orders),
    recentFills: observe({ items: fills }),
  }
}
