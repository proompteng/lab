import { Effect, Schema } from 'effect'
import { IsoDateSchema } from '../schemas'
import { OrderCollection, type Account, type Position, type Order, type BrokerReadShape } from '../broker/alpaca'
import { AccountStatus, Authority, KillState, ReconciliationStatus } from './contracts'
import type { CachedBrokerState } from './broker-state-cache'

export const submissionProjectionFixture = (read: BrokerReadShape): BrokerReadShape => ({
  ...read,
  projection: {
    fresh: read,
    invalidate: Effect.void,
    withMutation: (effect) => effect,
    snapshot: Effect.die('This final-submission fixture does not supply reconciliation history'),
    submissionSnapshot: () =>
      Effect.all([read.positions, read.orders({ status: OrderCollection.Open, limit: 1 }), read.account], {
        concurrency: 3,
      }).pipe(Effect.map(([positions, openOrders, account]) => ({ account, positions, openOrders }))),
  },
})

export const cachedBrokerStateFixture = (
  account: Account,
  positions: readonly Position[] = [],
  openOrders: readonly Order[] = [],
): CachedBrokerState => {
  const reconciliation = {
    schemaVersion: 'bayn.paper-reconciliation.v1' as const,
    accountId: account.id,
    reconciliationId: '5'.repeat(64),
    expectedHash: '6'.repeat(64),
    observedHash: '6'.repeat(64),
    contentHash: '7'.repeat(64),
    status: ReconciliationStatus.Exact,
    discrepancies: [],
    reconciledAt: account.observedAt,
  }
  return {
    openOrders,
    version: {
      reconciliationId: reconciliation.reconciliationId,
      reconciledAt: account.observedAt,
      authorityGenerationHash: '1'.repeat(64),
      authorityVersion: 1,
    },
    state: {
      reconciliation,
      unknownOrderCount: 0,
      accountingHash: '8'.repeat(64),
      account: {
        schemaVersion: 'bayn.paper-account-snapshot.v1',
        accountId: account.id,
        status: AccountStatus.Active,
        currency: account.currency,
        cashMicros: account.cashMicros,
        equityMicros: account.equityMicros,
        buyingPowerMicros: account.buyingPowerMicros,
        observedAt: account.observedAt,
      },
      positions: positions.map((position) => {
        const material = {
          accountId: position.accountId,
          symbol: position.symbol,
          quantityMicros: position.quantityMicros,
          averageEntryPriceMicros: position.averageEntryPriceMicros,
          marketPriceMicros: position.marketPriceMicros,
          marketValueMicros: position.marketValueMicros,
          unrealizedPnlMicros: position.unrealizedPnlMicros,
          observedAt: position.observedAt,
        }
        return position.costBasisMicros === undefined
          ? { ...material, schemaVersion: 'bayn.paper-position.v1' as const }
          : { ...material, schemaVersion: 'bayn.position.v2' as const, costBasisMicros: position.costBasisMicros }
      }),
      positionsObservedAt: account.observedAt,
      orders: [],
      ordersObservedAt: account.observedAt,
    },
  }
}

export const nativeBrokerStateFixture = (
  cached: CachedBrokerState,
): import('../reconciler').ReconciliationPassResult => ({
  brokerState: cached.state,
  report: {
    reconciliation: cached.state.reconciliation,
    metrics: {
      accountingExact: true,
      discrepancyCount: 0,
      brokerPollAgeMs: 0,
      oldestUnknownMutationAgeMs: 0,
      cashDifferenceMicros: '0',
      positionDifferenceMicros: '0',
      equityDifferenceMicros: '0',
    },
  },
  riskContext: {
    tradingDate: Schema.decodeUnknownSync(IsoDateSchema)(cached.version.reconciledAt.slice(0, 10)),
    unknownMutationCount: 0,
    dailyTradedNotionalMicros: '0',
    dayStartEquityMicros: cached.state.account.equityMicros,
    peakEquityMicros: cached.state.account.equityMicros,
    authorityObservedAt: cached.version.reconciledAt,
    authority: {
      schemaVersion: 'bayn.paper-authority.v1',
      generationHash: cached.version.authorityGenerationHash,
      maximum: Authority.Execution,
      effective: Authority.Execution,
      kill: KillState.Clear,
      version: cached.version.authorityVersion,
      updatedAt: cached.version.reconciledAt,
    },
  },
})
