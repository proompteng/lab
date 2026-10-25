import { ValkeyCache } from '../../valkey-cache'
import { observedBrokerState } from './observed-snapshot'
import { describe, expect, test } from 'bun:test'
import type { PgClient } from '@effect/sql-pg'
import { Option, Clock, ConfigProvider, Deferred, Effect, Fiber, Logger, Ref, Result, Exit } from 'effect'
import { BrokerObservations, decodeObservedBrokerSnapshot, validateObservedBrokerSnapshot } from './observed-snapshot'
import { TestClock } from 'effect/testing'

import { canonicalHashV1Result } from '../../hash'
import { checkHealth } from '../../health/program'
import { makeBrokerObservationStore } from '../../db/broker-observations'
import { config as runtimeConfig, readyState } from '../../testing/runtime-fixtures'
import { readStableBrokerSnapshot } from '../../simulation-reconciliation/broker-history'
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
          contentHash: Result.getOrThrow(canonicalHashV1Result(observed)),
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
                  cryptoStatus: null,
                  cryptoFeeTier: null,
                  cashReportingQuantumMicros: '1' as const,
                  nonMarginableBuyingPowerMicros: null,

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

const healthPass = (read: BrokerReadShape, timeoutMs = 1000) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(readyState())
    yield* checkHealth(
      { ...runtimeConfig, operationTimeoutMs: timeoutMs },
      state,
      {
        postgresql: Effect.void,
        journal: {
          check: Effect.void,
          post: () => Effect.die('unexpected ledger write'),
          verifyAccount: () => Effect.die('unexpected ledger verification'),
          journalAndReconcile: () => Effect.die('unexpected ledger mutation'),
          checkRun: () => Effect.die('unexpected ledger result check'),
        },
        cycleObservability: { read: () => Effect.die('unexpected unbound cycle read') },
      },
      { read, expectedAccountId: accountId, executionEligible: true, executionDisabledReason: null },
    )
    return (yield* Ref.get(state)).broker
  })

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
  test('independent history endpoints complete in one wave per stability scan', async () => {
    const source = fixture()
    const delayed: BrokerReadShape = {
      ...source.read,
      account: Effect.sleep(100).pipe(Effect.andThen(source.read.account)),
      positions: Effect.sleep(100).pipe(Effect.andThen(source.read.positions)),
      orders: (query) => Effect.sleep(100).pipe(Effect.andThen(source.read.orders(query))),
      fillActivities: (query) => Effect.sleep(100).pipe(Effect.andThen(source.read.fillActivities(query))),
      feeActivities: (query) => Effect.sleep(100).pipe(Effect.andThen(source.read.feeActivities(query))),
    }
    const elapsed = await run(
      Effect.gen(function* () {
        const start = yield* Clock.currentTimeMillis
        const task = yield* readStableBrokerSnapshot(delayed, currentUtcInstant).pipe(
          Effect.andThen(Clock.currentTimeMillis),
          Effect.forkChild({ startImmediately: true }),
        )
        for (let step = 0; step < 6; step++) yield* TestClock.adjust(100)
        return (yield* Fiber.join(task)) - start
      }),
    )
    expect(elapsed).toBe(300)
    expect(source.calls.filter((call) => call === 'fees')).toHaveLength(2)
    expect(source.calls.filter((call) => call.startsWith('fills:'))).toHaveLength(2)
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
  test('each health pass reads one fresh complete broker cut instead of six copies', async () => {
    const source = fixture()
    await run(
      Effect.gen(function* () {
        const value = yield* captureBrokerObservation(source.read, yield* currentUtcInstant, 15_000)
        const directCalls = source.calls.length
        let reads = 0
        const projected = yield* makeProjectedBrokerRead(source.read).pipe(
          Effect.provideService(BrokerObservations, {
            read: Effect.sync(() => {
              reads += 1
              return value
            }),
            readState: Effect.sync(() => {
              reads += 1
              return value
            }),
            readForSubmit: () => Effect.die('unexpected submit read'),
            invalidate: Effect.void,
          }),
        )
        expect((yield* healthPass(projected))?.readAvailable).toBe(true)
        expect(reads).toBe(1)
        expect((yield* healthPass(projected))?.readAvailable).toBe(true)
        expect(reads).toBe(2)
        expect(source.calls.length).toBe(directCalls)
      }),
    )
  })

  test('health reads the compact Valkey materialization and rejects corrupted or stale state', async () => {
    const source = fixture()
    await run(
      Effect.gen(function* () {
        const value = yield* captureBrokerObservation(source.read, yield* currentUtcInstant, 15_000)
        let payload: unknown = {
          snapshotHash: Result.getOrThrow(canonicalHashV1Result(value)),
          state: observedBrokerState(value),
        }
        let snapshotHash = Result.getOrThrow(canonicalHashV1Result(payload))
        let queries = 0
        const sql = (() =>
          Effect.sync(() => {
            queries += 1
            return [{ state_hash: snapshotHash, snapshot_hash: Result.getOrThrow(canonicalHashV1Result(value)) }]
          })) as unknown as PgClient.PgClient
        const store = makeBrokerObservationStore(
          sql,
          accountId,
          'a'.repeat(40),
          60_000,
          ValkeyCache.of({
            get: (key) => {
              expect(key.startsWith('bayn:broker:state:')).toBe(true)
              return Effect.succeed(Option.some(JSON.stringify(payload)))
            },
            put: () => Effect.die('read-only probe'),
            remove: () => Effect.die('read-only probe'),
          }),
        )
        const projected = yield* makeProjectedBrokerRead(source.read).pipe(
          Effect.provideService(BrokerObservations, store),
        )
        expect((yield* healthPass(projected))?.readAvailable).toBe(true)
        expect(queries).toBe(1)
        snapshotHash = 'b'.repeat(64)
        const changed = yield* healthPass(projected)
        expect(changed?.readAvailable).toBe(false)
        expect(changed?.error).toContain('content hash changed')
        expect(queries).toBe(2)
        payload = {
          snapshotHash: Result.getOrThrow(canonicalHashV1Result(value)),
          state: { snapshot: { account: {} } },
        }
        snapshotHash = Result.getOrThrow(canonicalHashV1Result(payload))
        expect((yield* healthPass(projected))?.readAvailable).toBe(false)
        expect(queries).toBe(3)
        payload = { snapshotHash: Result.getOrThrow(canonicalHashV1Result(value)), state: observedBrokerState(value) }
        snapshotHash = Result.getOrThrow(canonicalHashV1Result(payload))
        expect((yield* healthPass(projected))?.readAvailable).toBe(true)
        yield* TestClock.adjust(60_001)
        const expired = yield* healthPass(projected)
        expect(expired?.readAvailable).toBe(false)
        expect(expired?.error).toContain('stale-observation')
        expect(queries).toBe(5)
      }),
    )
  })

  test('a failed first health cut is not cached and account/configuration permission drift remains visible', async () => {
    const source = fixture()
    await run(
      Effect.gen(function* () {
        const value = yield* captureBrokerObservation(source.read, yield* currentUtcInstant, 15_000)
        let unavailable = true
        let reads = 0
        let current = value
        const projected = yield* makeProjectedBrokerRead(source.read).pipe(
          Effect.provideService(BrokerObservations, {
            read: Effect.suspend(() => {
              reads += 1
              return unavailable
                ? Effect.fail(
                    new BrokerReadError({
                      operation: 'preflight',
                      kind: BrokerReadErrorKind.ObservationPending,
                      retryable: true,
                      message: 'post-mutation cut pending',
                    }),
                  )
                : Effect.succeed(current)
            }),
            readState: Effect.suspend(() => {
              reads += 1
              return unavailable
                ? Effect.fail(
                    new BrokerReadError({
                      operation: 'preflight',
                      kind: BrokerReadErrorKind.ObservationPending,
                      retryable: true,
                      message: 'post-mutation cut pending',
                    }),
                  )
                : Effect.succeed(current)
            }),
            readForSubmit: () => Effect.die('unexpected submit read'),
            invalidate: Effect.sync(() => {
              unavailable = true
            }),
          }),
        )
        const failed = yield* healthPass(projected)
        expect(failed?.readAvailable).toBe(false)
        for (const name of [
          'account read',
          'account configuration read',
          'positions read',
          'open orders read',
          'recent orders read',
          'recent fills read',
        ])
          expect(failed?.error).toContain(`Alpaca ${name} unavailable: post-mutation cut pending`)
        expect(reads).toBe(1)
        unavailable = false
        expect((yield* healthPass(projected))?.readAvailable).toBe(true)
        current = {
          ...value,
          configuration: { ...value.configuration, value: { ...value.configuration.value, fractionalTrading: false } },
        }
        expect((yield* healthPass(projected))?.error).toContain('fractional trading is disabled')
        current = {
          ...value,
          snapshot: {
            ...value.snapshot,
            account: { ...value.snapshot.account, value: { ...value.snapshot.account.value, tradingBlocked: true } },
          },
        }
        expect((yield* healthPass(projected))?.error).toContain('trading is blocked')
        yield* projected.projection?.invalidate ?? Effect.die('missing projection')
        expect((yield* healthPass(projected))?.readAvailable).toBe(false)
        expect(reads).toBe(5)
      }),
    )
  })

  test('health timeout and caller interruption cancel the single read exactly once', async () => {
    for (const interrupt of [false, true]) {
      const source = fixture()
      await run(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          let reads = 0
          let finalized = 0
          const projected = yield* makeProjectedBrokerRead(source.read).pipe(
            Effect.provideService(BrokerObservations, {
              read: Effect.sync(() => {
                reads += 1
              }).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Effect.sync(() => {
                    finalized += 1
                  }),
                ),
              ),
              readState: Effect.sync(() => {
                reads += 1
              }).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Effect.sync(() => {
                    finalized += 1
                  }),
                ),
              ),
              readForSubmit: () => Effect.die('unexpected submit read'),
              invalidate: Effect.void,
            }),
          )
          const fiber = yield* healthPass(projected, 1000).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(started)
          if (interrupt) {
            yield* Fiber.interrupt(fiber)
            expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
          } else {
            yield* TestClock.adjust(1000)
            const result = yield* Fiber.join(fiber)
            expect(result?.readAvailable).toBe(false)
            for (const name of [
              'account read',
              'account configuration read',
              'positions read',
              'open orders read',
              'recent orders read',
              'recent fills read',
            ])
              expect(result?.error).toContain(`Alpaca ${name} timed out after 1000ms`)
          }
          expect(reads).toBe(1)
          expect(finalized).toBe(1)
        }),
      )
    }
  })

  test('unprojected health retains all six independent broker reads', async () => {
    const source = fixture()
    await run(
      Effect.gen(function* () {
        expect((yield* healthPass(source.read))?.readAvailable).toBe(true)
        expect(source.calls).toHaveLength(6)
        expect(source.calls).toContain('account')
        expect(source.calls).toContain('configuration')
        expect(source.calls).toContain('positions')
        source.failAccount(
          new BrokerReadError({
            operation: 'account',
            kind: BrokerReadErrorKind.Timeout,
            retryable: true,
            message: 'account failed',
          }),
        )
        expect((yield* healthPass(source.read))?.error).toContain('Alpaca account read unavailable: account failed')
      }),
    )
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
            readState: Effect.succeed(value),
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
            readState: Effect.succeed(value),
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
            readState: Effect.fail(
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
