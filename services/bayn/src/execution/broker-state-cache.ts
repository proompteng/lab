import { Data, Effect } from 'effect'

import { OrderStatus, ReconciliationStatus } from './contracts'
import type { Order } from '../broker/alpaca'
import type { ReconciliationPassResult } from '../reconciler'

export interface BrokerStateVersion {
  readonly reconciliationId: string
  readonly reconciledAt: string
  readonly authorityGenerationHash: string
  readonly authorityVersion: number
}

export interface CachedBrokerState {
  readonly openOrders: readonly Order[]
  readonly version: BrokerStateVersion
  readonly state: ReconciliationPassResult['brokerState']
}

export class BrokerStateCacheFailure extends Data.TaggedError('BrokerStateCacheUnavailable')<{
  readonly reason: 'empty' | 'consumed' | 'inexact' | 'account' | 'authority' | 'pending-orders' | 'stale'
}> {}

export interface BrokerStateCache {
  readonly record: (result: ReconciliationPassResult) => Effect.Effect<void>
  readonly invalidate: Effect.Effect<void>
  readonly take: (observedAt: string, maximumAgeMs: number) => Effect.Effect<CachedBrokerState, BrokerStateCacheFailure>
}

type CacheState =
  | { readonly _tag: 'Unavailable'; readonly reason: BrokerStateCacheFailure['reason'] }
  | { readonly _tag: 'Available'; readonly cached: CachedBrokerState }

export const makeBrokerStateCache = (accountId: string, authorityGenerationHash: string): BrokerStateCache => {
  let current: CacheState = { _tag: 'Unavailable', reason: 'empty' }
  let consumedVersion: string | undefined
  return {
    record: (result) =>
      Effect.sync(() => {
        const authority = result.riskContext.authority
        const reconciliation = result.report.reconciliation
        if (reconciliation.reconciliationId === consumedVersion) {
          current = { _tag: 'Unavailable', reason: 'consumed' }
        } else if (reconciliation.accountId !== accountId || result.brokerState.account.accountId !== accountId) {
          current = { _tag: 'Unavailable', reason: 'account' }
        } else if (
          result.brokerState.reconciliation.reconciliationId !== reconciliation.reconciliationId ||
          reconciliation.status !== ReconciliationStatus.Exact ||
          !result.report.metrics.accountingExact ||
          result.riskContext.unknownMutationCount !== 0 ||
          reconciliation.expectedHash !== reconciliation.observedHash ||
          reconciliation.discrepancies.length !== 0
        ) {
          current = { _tag: 'Unavailable', reason: 'inexact' }
        } else if (authority === null || authority.generationHash !== authorityGenerationHash) {
          current = { _tag: 'Unavailable', reason: 'authority' }
        } else if (
          result.brokerState.orders.some(
            (order) =>
              order.status === OrderStatus.New ||
              order.status === OrderStatus.Pending ||
              order.status === OrderStatus.PartiallyFilled,
          )
        ) {
          current = { _tag: 'Unavailable', reason: 'pending-orders' }
        } else {
          current = {
            _tag: 'Available',
            cached: {
              openOrders: [],
              version: {
                reconciliationId: reconciliation.reconciliationId,
                reconciledAt: reconciliation.reconciledAt,
                authorityGenerationHash,
                authorityVersion: authority.version,
              },
              state: result.brokerState,
            },
          }
        }
      }),
    invalidate: Effect.sync(() => {
      if (current._tag === 'Available') consumedVersion = current.cached.version.reconciliationId
      current = { _tag: 'Unavailable', reason: 'consumed' }
    }),
    take: (observedAt, maximumAgeMs) =>
      Effect.suspend(() => {
        const previous = current
        current = { _tag: 'Unavailable', reason: 'consumed' }
        if (previous._tag === 'Unavailable')
          return Effect.fail(new BrokerStateCacheFailure({ reason: previous.reason }))
        const { cached } = previous
        consumedVersion = cached.version.reconciliationId
        const now = Date.parse(observedAt)
        const observations = [
          cached.version.reconciledAt,
          cached.state.account.observedAt,
          cached.state.positionsObservedAt,
          cached.state.ordersObservedAt,
          ...cached.state.positions.map((position) => position.observedAt),
        ]
        if (
          !Number.isFinite(now) ||
          !Number.isFinite(maximumAgeMs) ||
          maximumAgeMs <= 0 ||
          observations.some(
            (at) => !Number.isFinite(Date.parse(at)) || Date.parse(at) > now || now - Date.parse(at) >= maximumAgeMs,
          )
        )
          return Effect.fail(new BrokerStateCacheFailure({ reason: 'stale' }))
        return Effect.succeed(cached)
      }),
  }
}
