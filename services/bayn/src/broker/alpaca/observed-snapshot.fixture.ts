import {
  AccountStatus,
  accountConfigurationObservationSchemaVersion,
  accountConfigurationObservationSource,
  type ReadResult,
} from './model'
import type { ObservedBrokerSnapshot } from './observed-snapshot'

export const observedBrokerSnapshotFixture = (accountId: string, observedAt: string): ObservedBrokerSnapshot => {
  const observe = <A>(value: A): ReadResult<A> => ({
    value,
    evidence: { requestId: 'observation-test', status: 200, contentHash: 'a'.repeat(64), observedAt },
  })
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
      history: { orders: { rows: [], observedAt }, fills: [], fees: [] },
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
    recentOrders: observe([]),
    recentFills: observe({ items: [] }),
  }
}
