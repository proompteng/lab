import { describe, expect, test } from 'bun:test'
import { Cause, Clock, ConfigProvider, Deferred, Effect, Exit, Fiber, Logger, type Scope } from 'effect'
import { TestClock } from 'effect/testing'

import { canonicalHashV1 } from '../../hash'
import { readStableBrokerSnapshot } from '../../simulation-reconciliation/broker-history'
import { currentUtcInstant } from '../../time'
import { unusedAssetBySymbol, unusedMarketCalendar } from '../alpaca-test-support'
import { BrokerReadError, BrokerReadErrorKind } from './failures'
import {
  AccountStatus,
  AssetClass,
  AssetExchange,
  OrderClass,
  OrderCollection,
  OrderSide,
  OrderStatus,
  OrderType,
  PositionSide,
  SortDirection,
  TimeInForce,
  TradeActivityType,
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
import { brokerSnapshotCacheConfig, makeCachedBrokerRead } from './snapshot-cache'

const config = { pollIntervalMs: 30_000, maxAgeMs: 60_000 }
const accountId = '61e69015-8549-4bfd-b9c3-01e75843f47d'
const openQuery = { status: OrderCollection.Open, limit: 1 } as const
const recentQuery = { status: OrderCollection.All, limit: 1, direction: SortDirection.Descending } as const
const fillsQuery = { pageSize: 1, direction: SortDirection.Descending } as const

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
            ? observe(
                'account',
                (observedAt): Account => ({
                  id: accountId,
                  status: AccountStatus.Active,
                  currency: 'USD',
                  cashMicros: equityMicros,
                  equityMicros,
                  lastEquityMicros: equityMicros,
                  buyingPowerMicros: equityMicros,
                  accountBlocked: false,
                  tradingBlocked: false,
                  tradeSuspendedByUser: false,
                  observedAt,
                }),
              )
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
    },
    failAccount: (error: BrokerReadError | undefined) => {
      accountFailure = error
    },
    blockAccount: (barrier: Effect.Effect<void>) => {
      accountBarrier = barrier
    },
  }
}

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(TestClock.layer()),
      Effect.provideService(Logger.CurrentLoggers, new Set()),
    ),
  )

const settle = Effect.repeat(Effect.yieldNow, { times: 10 })

describe('broker snapshot cache', () => {
  test('retains filled orders, positions, fills, fees and their original broker evidence in the cached snapshot', async () => {
    const observedAt = '1970-01-01T00:00:00.000Z'
    const order: Order = {
      accountId,
      brokerOrderId: 'filled-order',
      clientOrderId: 'client-filled-order',
      createdAt: observedAt,
      submittedAt: observedAt,
      assetId: 'spy-asset',
      symbol: 'SPY',
      assetClass: AssetClass.UsEquity,
      quantityMicros: '1000000',
      filledQuantityMicros: '1000000',
      filledAveragePriceMicros: '100000000',
      orderClass: OrderClass.Simple,
      orderType: OrderType.Market,
      side: OrderSide.Buy,
      timeInForce: TimeInForce.Day,
      status: OrderStatus.Filled,
      extendedHours: false,
      observedAt,
    }
    const fill: FillActivity = {
      accountId,
      activityId: 'fill-activity',
      brokerOrderId: order.brokerOrderId,
      cumulativeQuantityMicros: '1000000',
      leavesQuantityMicros: '0',
      priceMicros: '100000000',
      quantityMicros: '1000000',
      side: OrderSide.Buy,
      symbol: order.symbol,
      transactionTime: observedAt,
      type: TradeActivityType.Fill,
    }
    const position: Position = {
      accountId,
      assetId: order.assetId,
      symbol: order.symbol,
      exchange: AssetExchange.Arca,
      assetClass: AssetClass.UsEquity,
      side: PositionSide.Long,
      quantityMicros: '1000000',
      averageEntryPriceMicros: '100000000',
      marketPriceMicros: '100000000',
      marketValueMicros: '100000000',
      unrealizedPnlMicros: '0',
      observedAt,
    }
    const fee: FeeActivity = { accountId, activityId: 'fee-activity', date: '1970-01-01', netAmountMicros: '-1000' }
    const source = fixture({ orders: [order], fills: [fill], positions: [position], fees: [fee] })
    await run(
      Effect.gen(function* () {
        const read = yield* makeCachedBrokerRead(source.read, config)
        const snapshot = yield* readStableBrokerSnapshot(read, currentUtcInstant)
        const calls = source.calls.length
        expect(snapshot.positions.value).toEqual([position])
        expect(snapshot.history.orders.rows.map((row) => row.value)).toEqual([order])
        expect(snapshot.history.fills.map((row) => row.value)).toEqual([fill])
        expect(snapshot.history.fees.map((row) => row.value)).toEqual([fee])
        expect(snapshot.history.fills[0]?.evidence.requestId).toContain('fills:')
        expect((yield* read.orders(openQuery)).value).toEqual([])
        expect((yield* read.orders(recentQuery)).value).toEqual([order])
        expect((yield* read.fillActivities(fillsQuery)).value.items).toEqual([fill])
        expect(source.calls.length).toBe(calls)
      }),
    )
  })

  test('serves reconciliation and routine reads without another broker request or new observation timestamps', async () => {
    const source = fixture()
    await run(
      Effect.gen(function* () {
        const read = yield* makeCachedBrokerRead(source.read, config)
        const initialCalls = source.calls.length
        const initial = yield* readStableBrokerSnapshot(read, currentUtcInstant)
        expect(initialCalls).toBe(12)
        source.setEquity('900000000')
        yield* TestClock.adjust(1_000)
        for (let n = 0; n < 20; n++) {
          const [account, positions, open, recent, fills, configuration, snapshot] = yield* Effect.all(
            [
              read.account,
              read.positions,
              read.orders(openQuery),
              read.orders(recentQuery),
              read.fillActivities(fillsQuery),
              read.accountConfiguration,
              readStableBrokerSnapshot(read, currentUtcInstant),
            ],
            { concurrency: 7 },
          )
          expect(account).toBe(initial.account)
          expect(positions).toBe(initial.positions)
          expect(account.value.equityMicros).toBe('1000000000')
          expect(account.evidence.observedAt).toBe('1970-01-01T00:00:00.000Z')
          expect(
            [open, recent, fills, configuration].every(
              (item) => item.evidence.observedAt === account.evidence.observedAt,
            ),
          ).toBe(true)
          expect(snapshot).toBe(initial)
        }
        expect(source.calls.length).toBe(initialCalls)
        yield* TestClock.adjust(29_000)
        yield* settle
        expect((yield* read.account).value.equityMicros).toBe('900000000')
        expect(source.calls.length).toBe(initialCalls * 2)
      }),
    )
  })

  test('retains direct semantics for filtered orders and individual order lookups', async () => {
    const source = fixture()
    await run(
      Effect.gen(function* () {
        const read = yield* makeCachedBrokerRead(source.read, config)
        const before = source.calls.length
        yield* read.orders({ ...openQuery, symbols: ['SPY'] })
        expect(source.calls.length).toBe(before + 1)
        expect(read.orderById).toBe(source.read.orderById)
        expect(read.orderByClientId).toBe(source.read.orderByClientId)
        expect(read.projection?.fresh).toBe(source.read)
      }),
    )
  })

  test('schedules slow successful polls from their start and replaces evidence before it expires', async () => {
    const source = fixture()
    await run(
      Effect.gen(function* () {
        source.blockAccount(Effect.sleep(20_000))
        const acquiring = yield* makeCachedBrokerRead(source.read, config).pipe(Effect.forkChild)
        yield* TestClock.adjust(20_000)
        const read = yield* Fiber.join(acquiring)
        const initialCalls = source.calls.length
        expect((yield* read.accountConfiguration).evidence.observedAt).toBe('1970-01-01T00:00:00.000Z')
        yield* TestClock.adjust(30_000)
        yield* settle
        expect((yield* read.accountConfiguration).evidence.observedAt).toBe('1970-01-01T00:00:30.000Z')
        expect((yield* read.account).evidence.observedAt).toBe('1970-01-01T00:00:50.000Z')
        expect(source.calls.length).toBe(initialCalls * 2)
        yield* TestClock.adjust(10_000)
        yield* read.account
      }),
    )
  })

  test('rejects expired evidence while a background poll is blocked', async () => {
    const source = fixture()
    await run(
      Effect.gen(function* () {
        const read = yield* makeCachedBrokerRead(source.read, config)
        source.blockAccount(Effect.never)
        yield* TestClock.adjust(30_000)
        const clock = yield* Clock.Clock
        const at = (currentTimeMillis: number): Clock.Clock => ({
          currentTimeMillisUnsafe: () => currentTimeMillis,
          currentTimeMillis: Effect.succeed(currentTimeMillis),
          currentTimeNanosUnsafe: () => BigInt(currentTimeMillis) * 1_000_000n,
          currentTimeNanos: Effect.succeed(BigInt(currentTimeMillis) * 1_000_000n),
          sleep: (duration) => clock.sleep(duration),
        })
        yield* read.account.pipe(Effect.provideService(Clock.Clock, at(59_999)))
        const error = yield* Effect.flip(readStableBrokerSnapshot(read, currentUtcInstant)).pipe(
          Effect.provideService(Clock.Clock, at(60_000)),
        )
        expect(error.message).toBe('Broker snapshot cache is stale')
        expect(error).toBeInstanceOf(BrokerReadError)
        if (error instanceof BrokerReadError) expect(error.retryable).toBe(true)
      }),
    )
  })

  test('invalidates cached reads on polling failure, preserves the typed error, and recovers on a later poll', async () => {
    const source = fixture()
    const failure = new BrokerReadError({
      operation: 'account',
      kind: BrokerReadErrorKind.Authentication,
      retryable: false,
      message: 'fixture account authentication failed',
      requestId: 'failed-request',
    })
    await run(
      Effect.gen(function* () {
        const read = yield* makeCachedBrokerRead(source.read, config)
        source.failAccount(failure)
        yield* TestClock.adjust(30_000)
        yield* settle
        expect(yield* Effect.flip(read.account)).toBe(failure)
        expect(yield* Effect.flip(read.positions)).toBe(failure)
        source.failAccount(undefined)
        source.setEquity('800000000')
        yield* TestClock.adjust(30_000)
        yield* settle
        expect((yield* read.account).value.equityMicros).toBe('800000000')
      }),
    )
  })

  test('prevents an in-flight poll from republishing a snapshot after mutation invalidation', async () => {
    const source = fixture()
    await run(
      Effect.gen(function* () {
        const read = yield* makeCachedBrokerRead(source.read, config)
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        source.blockAccount(Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))))
        yield* TestClock.adjust(30_000)
        yield* Deferred.await(started)
        if (read.projection === undefined) return yield* Effect.die(new Error('cache projection missing'))
        yield* read.projection.invalidate
        expect((yield* Effect.flip(read.account)).retryable).toBe(true)
        source.blockAccount(Effect.void)
        yield* Deferred.succeed(release, undefined)
        yield* settle
        expect((yield* Effect.flip(read.account)).message).toContain('invalidation')
        yield* TestClock.adjust(30_000)
        yield* settle
        yield* read.account
      }),
    )
  })

  test('interrupts the polling request exactly once and expires escaped reads on scope closure', async () => {
    const source = fixture()
    let finalizations = 0
    const escaped = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const read = yield* makeCachedBrokerRead(source.read, config)
          const started = yield* Deferred.make<void>()
          source.blockAccount(
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  finalizations += 1
                }),
              ),
            ),
          )
          yield* TestClock.adjust(30_000)
          yield* Deferred.await(started)
          return read
        }),
      ),
    )
    expect(finalizations).toBe(1)
    expect((await Effect.runPromise(Effect.flip(escaped.account))).message).toContain('invalidation')
    const calls = source.calls.length
    await run(TestClock.adjust(120_000))
    expect(source.calls.length).toBe(calls)
  })

  test.each([
    [10_000, 30_000],
    [45_000, 15_000],
  ] as const)(
    'bounds acquisition with a %i ms poll interval and cancels the request',
    async (pollIntervalMs, deadlineMs) => {
      const source = fixture()
      let finalizations = 0
      const failure = await run(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          source.blockAccount(
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  finalizations += 1
                }),
              ),
            ),
          )
          const fiber = yield* makeCachedBrokerRead(source.read, { ...config, pollIntervalMs }).pipe(Effect.forkChild)
          yield* Deferred.await(started)
          yield* TestClock.adjust(deadlineMs)
          return yield* Effect.flip(Fiber.join(fiber))
        }),
      )
      expect(failure.kind).toBe(BrokerReadErrorKind.Timeout)
      expect(finalizations).toBe(1)
    },
  )

  test('propagates defects during initial acquisition', async () => {
    const source = fixture()
    source.blockAccount(Effect.die(new Error('fixture poll defect')))
    const exit = await Effect.runPromiseExit(makeCachedBrokerRead(source.read, config).pipe(Effect.scoped))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true)
  })

  test('validates polling configuration at startup', async () => {
    for (const maxAgeMs of ['10000', '30000']) {
      const provider = ConfigProvider.fromEnv({
        env: { BAYN_BROKER_POLL_INTERVAL_MS: '30000', BAYN_BROKER_CACHE_MAX_AGE_MS: maxAgeMs },
      })
      const error = await Effect.runPromise(
        Effect.flip(brokerSnapshotCacheConfig).pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider)),
      )
      expect(error.kind).toBe(BrokerReadErrorKind.Configuration)
      expect(error.message).toContain('exceed its poll interval')
    }
    const defaults = await Effect.runPromise(
      brokerSnapshotCacheConfig.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: {} })),
      ),
    )
    expect(defaults).toEqual(config)
  })
})
