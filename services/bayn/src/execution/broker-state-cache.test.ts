import { describe, expect, test } from 'bun:test'
import { Cause, Effect, Exit } from 'effect'
import { cachedBrokerStateFixture } from './broker-state-cache.fixture'
import { makeBrokerStateCache } from './broker-state-cache'
import { AccountStatus as BrokerAccountStatus } from '../broker/alpaca'
import { Authority, KillState, OrderStatus, OrderSide, OrderType, TimeInForce } from './contracts'
import type { ReconciliationPassResult } from '../reconciler'

const now = '2026-09-29T14:00:00.000Z'
const accountId = 'cache-test-account'
const generation = '1'.repeat(64)
const fixture = (): ReconciliationPassResult => {
  const cached = cachedBrokerStateFixture({
    id: accountId,
    status: BrokerAccountStatus.Active,
    currency: 'USD',
    cashMicros: '100000000000',
    equityMicros: '100000000000',
    lastEquityMicros: '100000000000',
    buyingPowerMicros: '100000000000',
    accountBlocked: false,
    tradingBlocked: false,
    tradeSuspendedByUser: false,
    observedAt: now,
  })
  return {
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
      tradingDate: '2026-09-29',
      dailyTradedNotionalMicros: '0',
      dayStartEquityMicros: '100000000000',
      peakEquityMicros: '100000000000',
      unknownMutationCount: 0,
      authorityObservedAt: now,
      authority: {
        schemaVersion: 'bayn.paper-authority.v1',
        generationHash: generation,
        maximum: Authority.Execution,
        effective: Authority.Execution,
        kill: KillState.Clear,
        version: 1,
        updatedAt: now,
      },
    },
  }
}
const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined

describe('native broker state cache', () => {
  test('reserves one reconciled version before transmission and refuses replay of that version', async () => {
    const cache = makeBrokerStateCache(accountId, generation)
    const result = fixture()
    await Effect.runPromise(cache.record(result))
    expect((await Effect.runPromise(cache.take(now, 1000))).version.reconciliationId).toBe(
      result.report.reconciliation.reconciliationId,
    )
    await Effect.runPromise(cache.record(result))
    expect(failure(await Effect.runPromiseExit(cache.take(now, 1000)))).toMatchObject({
      _tag: 'BrokerStateCacheUnavailable',
      reason: 'consumed',
    })
  })
  test('only one simultaneous submit can consume a version', async () => {
    const cache = makeBrokerStateCache(accountId, generation)
    await Effect.runPromise(cache.record(fixture()))
    const results = await Effect.runPromise(
      Effect.all([cache.take(now, 1000).pipe(Effect.exit), cache.take(now, 1000).pipe(Effect.exit)], {
        concurrency: 2,
      }),
    )
    expect(results.filter(Exit.isSuccess)).toHaveLength(1)
    expect(results.filter(Exit.isFailure)).toHaveLength(1)
  })
  test('invalidation requires a newly reconciled version, including after an unknown mutation or cancellation', async () => {
    const cache = makeBrokerStateCache(accountId, generation)
    const old = fixture()
    await Effect.runPromise(cache.record(old).pipe(Effect.andThen(cache.invalidate), Effect.andThen(cache.record(old))))
    expect(Exit.isFailure(await Effect.runPromiseExit(cache.take(now, 1000)))).toBe(true)
    const reconciliation = { ...old.report.reconciliation, reconciliationId: '9'.repeat(64) }
    await Effect.runPromise(
      cache.record({
        ...old,
        report: { ...old.report, reconciliation },
        brokerState: { ...old.brokerState, reconciliation },
      }),
    )
    expect(Exit.isSuccess(await Effect.runPromiseExit(cache.take(now, 1000)))).toBe(true)
  })
  test.each(['2026-09-29T14:00:01.000Z', '2026-09-29T13:59:59.999Z', 'invalid'])(
    'rejects stale, future or invalid time %s',
    async (at) => {
      const cache = makeBrokerStateCache(accountId, generation)
      await Effect.runPromise(cache.record(fixture()))
      expect(failure(await Effect.runPromiseExit(cache.take(at, 1000)))).toMatchObject({
        _tag: 'BrokerStateCacheUnavailable',
        reason: 'stale',
      })
    },
  )
  test.each([OrderStatus.New, OrderStatus.Pending, OrderStatus.PartiallyFilled])(
    'does not reuse inventory while order %s can fill',
    async (status) => {
      const cache = makeBrokerStateCache(accountId, generation)
      const result = fixture()
      const order = {
        schemaVersion: 'bayn.paper-order.v2' as const,
        accountId,
        brokerOrderId: 'order',
        clientOrderId: 'client',
        symbol: 'AMD',
        side: OrderSide.Buy,
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.ImmediateOrCancel,
        quantityMicros: '2000000',
        filledQuantityMicros: status === OrderStatus.PartiallyFilled ? '1000000' : '0',
        limitPriceMicros: '100000000',
        status,
        observedAt: now,
      }
      await Effect.runPromise(cache.record({ ...result, brokerState: { ...result.brokerState, orders: [order] } }))
      expect(failure(await Effect.runPromiseExit(cache.take(now, 1000)))).toMatchObject({
        _tag: 'BrokerStateCacheUnavailable',
        reason: 'pending-orders',
      })
      await Effect.runPromise(
        cache.record({
          ...result,
          brokerState: { ...result.brokerState, orders: [{ ...order, status: OrderStatus.Canceled }] },
        }),
      )
      expect(Exit.isSuccess(await Effect.runPromiseExit(cache.take(now, 1000)))).toBe(true)
    },
  )
  test('unknown mutations, incomplete accounting and generation changes invalidate the cache', async () => {
    const cache = makeBrokerStateCache(accountId, generation)
    const result = fixture()
    for (const changed of [
      { ...result, riskContext: { ...result.riskContext, unknownMutationCount: 1 } },
      { ...result, report: { ...result.report, metrics: { ...result.report.metrics, accountingExact: false } } },
      { ...result, riskContext: { ...result.riskContext, authority: null, authorityObservedAt: null } },
      {
        ...result,
        brokerState: { ...result.brokerState, account: { ...result.brokerState.account, accountId: 'other-account' } },
      },
    ]) {
      await Effect.runPromise(cache.record(result).pipe(Effect.andThen(cache.record(changed))))
      expect(Exit.isFailure(await Effect.runPromiseExit(cache.take(now, 1000)))).toBe(true)
    }
  })
})
