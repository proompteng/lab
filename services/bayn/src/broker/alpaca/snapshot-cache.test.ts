import { describe, expect, test } from 'bun:test'
import { ConfigProvider, Deferred, Effect, Fiber, Logger, Result } from 'effect'
import { BrokerObservations, decodeObservedBrokerSnapshot, validateObservedBrokerSnapshot } from './observed-snapshot'
import { TestClock } from 'effect/testing'

import { canonicalHashV1 } from '../../hash'
import { currentUtcInstant } from '../../time'
import { unusedAssetBySymbol, unusedMarketCalendar } from '../alpaca-test-support'
import { BrokerReadError, BrokerReadErrorKind } from './failures'
import {
  AccountStatus,
  OrderCollection,
  OrderStatus,
  accountConfigurationObservationSchemaVersion,
  accountConfigurationObservationSource,
  type Account,
  type BrokerReadShape,
  type FeeActivity,
  type FillActivity,
  type Order,
  type Position,
  type ReadResult,
} from './model'
import { brokerSnapshotCacheConfig, captureBrokerObservation, makeProjectedBrokerRead } from './snapshot-cache'

const config = { pollIntervalMs: 30_000, maxAgeMs: 60_000 }
const accountId = '61e69015-8549-4bfd-b9c3-01e75843f47d'

const fixture = (
  history: {
    readonly positions?: readonly Position[]
    readonly orders?: readonly Order[]
    readonly fills?: readonly FillActivity[]
    readonly fees?: readonly FeeActivity[]
  } = {},
) => {
  const calls: string[] = []
  let equityMicros = '1000000000'
  let pendingEquity: { readonly value: string; readonly visibleAtMs: number } | undefined
  let accountFailure: BrokerReadError | undefined
  let accountBarrier: Effect.Effect<void> = Effect.void
  const observe = <A>(operation: string, value: (at: string) => A): Effect.Effect<ReadResult<A>> =>
    Effect.gen(function* () {
      calls.push(operation)
      const at = yield* currentUtcInstant
      const observed = value(at)
      return {
        value: observed,
        evidence: {
          requestId: `request-${operation}-${calls.length}`,
          status: 200,
          contentHash: canonicalHashV1(observed),
          observedAt: at,
        },
      }
    })
  const account: BrokerReadShape['account'] = Effect.suspend(() =>
    accountBarrier.pipe(
      Effect.andThen(
        Effect.suspend(() =>
          accountFailure === undefined
            ? observe('account', (observedAt): Account => {
                const equity =
                  pendingEquity !== undefined && Date.parse(observedAt) >= pendingEquity.visibleAtMs
                    ? pendingEquity.value
                    : equityMicros
                return {
                  id: accountId,
                  status: AccountStatus.Active,
                  currency: 'USD',
                  cashMicros: equity,
                  equityMicros: equity,
                  lastEquityMicros: equity,
                  buyingPowerMicros: equity,
                  accountBlocked: false,
                  tradingBlocked: false,
                  tradeSuspendedByUser: false,
                  observedAt,
                }
              })
            : Effect.fail(accountFailure),
        ),
      ),
    ),
  )
  const read: BrokerReadShape = {
    account,
    positions: observe('positions', () => history.positions ?? []),
    accountConfiguration: observe('configuration', (observedAt) => ({
      schemaVersion: accountConfigurationObservationSchemaVersion,
      source: accountConfigurationObservationSource,
      requestHash: 'a'.repeat(64),
      fractionalTrading: true,
      normalizedResponseHash: 'b'.repeat(64),
      observedAt,
    })),
    orders: (query) =>
      observe(`orders:${JSON.stringify(query)}`, () => {
        const orders = history.orders ?? []
        return query?.status === OrderCollection.Open
          ? orders.filter((order) => order.status === OrderStatus.Accepted)
          : orders
      }),
    fillActivities: (query) => observe(`fills:${JSON.stringify(query)}`, () => ({ items: history.fills ?? [] })),
    feeActivities: () => observe('fees', () => ({ items: history.fees ?? [] })),
    orderById: () => Effect.die(new Error('unexpected order lookup')),
    orderByClientId: () => Effect.die(new Error('unexpected client order lookup')),
    assetBySymbol: unusedAssetBySymbol,
    marketCalendar: unusedMarketCalendar,
  }
  return {
    read,
    calls,
    setEquity: (value: string) => {
      equityMicros = value
      pendingEquity = undefined
    },
    setDelayedEquity: (value: string, visibleAtMs: number) => {
      pendingEquity = { value, visibleAtMs }
    },
    failAccount: (error: BrokerReadError | undefined) => {
      accountFailure = error
    },
    blockAccount: (barrier: Effect.Effect<void>) => {
      accountBarrier = barrier
    },
  }
}

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(TestClock.layer()), Effect.provideService(Logger.CurrentLoggers, new Set())),
  )

describe('durable broker observations', () => {
  test('cancels broker acquisition at the polling deadline without producing a partial cut', async () => {
    const source = fixture()
    await run(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        let cancelled = 0
        source.blockAccount(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                cancelled += 1
              }),
            ),
          ),
        )
        const pending = yield* captureBrokerObservation(source.read, yield* currentUtcInstant, 1000).pipe(
          Effect.result,
          Effect.forkChild({ startImmediately: true }),
        )
        yield* Deferred.await(started)
        yield* TestClock.adjust(1000)
        const result = yield* Fiber.join(pending)
        expect(Result.isFailure(result)).toBe(true)
        expect(cancelled).toBe(1)
      }),
    )
  })
  test('captures complete stable history with its original poll start and validates durable bytes', async () => {
    const source = fixture()
    const value = await run(
      Effect.gen(function* () {
        return yield* captureBrokerObservation(source.read, yield* currentUtcInstant, 15_000)
      }),
    )
    expect(Result.isSuccess(decodeObservedBrokerSnapshot(value))).toBe(true)
    expect(value.observedAt).toBe(value.startedAt)
    expect(value.snapshot.account.value.id).toBe(accountId)
    expect(source.calls.length).toBeGreaterThan(3)
  })
  test('routine and final submit reads never invoke the direct source', async () => {
    const source = fixture()
    await run(
      Effect.gen(function* () {
        const value = yield* captureBrokerObservation(source.read, yield* currentUtcInstant, 15_000)
        const initial = source.calls.length
        const projected = yield* makeProjectedBrokerRead(source.read).pipe(
          Effect.provideService(BrokerObservations, {
            read: Effect.succeed(value),
            readForSubmit: () => Effect.succeed(value),
            invalidate: Effect.void,
          }),
        )
        yield* Effect.all([
          projected.account,
          projected.positions,
          projected.orders({ status: OrderCollection.Open, limit: 10 }),
          projected.accountConfiguration,
        ])
        expect(source.calls.length).toBe(initial)
        expect(projected.projection?.fresh).toBe(source.read)
      }),
    )
  })
  test('invalidates before mutation and on interruption without triggering inline polling', async () => {
    const source = fixture()
    await run(
      Effect.gen(function* () {
        const value = yield* captureBrokerObservation(source.read, yield* currentUtcInstant, 15_000)
        let invalidations = 0
        const projected = yield* makeProjectedBrokerRead(source.read).pipe(
          Effect.provideService(BrokerObservations, {
            read: Effect.succeed(value),
            readForSubmit: () => Effect.succeed(value),
            invalidate: Effect.sync(() => {
              invalidations += 1
            }),
          }),
        )
        const wrap = projected.projection?.withMutation
        if (wrap === undefined) throw new Error('missing projection')
        yield* wrap(Effect.sync(() => expect(invalidations).toBe(1)))
        expect(invalidations).toBe(2)
        const started = yield* Deferred.make<void>()
        const pending = yield* wrap(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))).pipe(
          Effect.forkChild({ startImmediately: true }),
        )
        yield* Deferred.await(started)
        expect(invalidations).toBe(3)
        yield* Fiber.interrupt(pending)
        expect(invalidations).toBe(4)
      }),
    )
  })
  test('rejects stale, future, foreign-account and falsely refreshed observations', async () => {
    const source = fixture()
    const value = await run(
      Effect.gen(function* () {
        return yield* captureBrokerObservation(source.read, yield* currentUtcInstant, 15_000)
      }),
    )
    for (const [candidate, identity, now] of [
      [value, accountId, '1970-01-01T00:01:00.000Z'],
      [value, 'other-account', value.completedAt],
      [{ ...value, startedAt: '1970-01-01T00:00:01.000Z' }, accountId, value.completedAt],
      [{ ...value, observedAt: '1970-01-01T00:00:00.001Z' }, accountId, '1970-01-01T00:00:01.000Z'],
    ] as const) {
      const result = await run(
        validateObservedBrokerSnapshot(candidate, identity, now, config.maxAgeMs).pipe(Effect.result),
      )
      expect(Result.isFailure(result)).toBe(true)
    }
  })
  test('fails closed when the durable projection is unavailable', async () => {
    const source = fixture()
    await run(
      Effect.gen(function* () {
        const projected = yield* makeProjectedBrokerRead(source.read).pipe(
          Effect.provideService(BrokerObservations, {
            read: Effect.fail(
              new BrokerReadError({
                operation: 'preflight',
                kind: BrokerReadErrorKind.Timeout,
                retryable: true,
                message: 'unavailable',
              }),
            ),
            readForSubmit: () => Effect.die('unavailable submit'),
            invalidate: Effect.void,
          }),
        )
        expect(Result.isFailure(yield* projected.account.pipe(Effect.result))).toBe(true)
        expect(source.calls).toHaveLength(0)
      }),
    )
  })
  test('requires a poll interval shorter than maximum cache age', async () => {
    const result = await Effect.runPromise(
      brokerSnapshotCacheConfig.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ BAYN_BROKER_POLL_INTERVAL_MS: 30_000, BAYN_BROKER_CACHE_MAX_AGE_MS: 30_000 }),
        ),
        Effect.result,
      ),
    )
    expect(Result.isFailure(result)).toBe(true)
  })
})
