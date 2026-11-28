import { ValkeyCache } from '../../valkey-cache'
import { observedBrokerState } from './observed-snapshot'
import { describe, expect, test } from 'bun:test'
import type { PgClient } from '@effect/sql-pg'
import {
  Cause,
  Option,
  Clock,
  ConfigProvider,
  Deferred,
  Effect,
  Fiber,
  Logger,
  Ref,
  Result,
  Exit,
  Redacted,
} from 'effect'
import {
  BrokerObservations,
  decodeObservedBrokerSnapshot,
  requireSettledCashFees,
  validateObservedBrokerSnapshot,
  type ObservedBrokerSnapshot,
} from './observed-snapshot'
import { TestClock } from 'effect/testing'
import { observedBrokerSnapshotFixture } from './observed-snapshot.fixture'

import { canonicalHashV1Result } from '../../hash'
import { brokerPollFailureAnnotations } from '../../composition/broker-observation-runtime'
import { checkHealth } from '../../health/program'
import { makeBrokerObservationStore } from '../../db/broker-observations'
import { config as runtimeConfig, provenance, readyState } from '../../testing/runtime-fixtures'
import { statusFacts } from '../../http'
import { readStableBrokerSnapshot } from '../../simulation-reconciliation/broker-history'
import { currentUtcInstant } from '../../time'
import { unusedAssetBySymbol, unusedMarketCalendar } from '../alpaca-test-support'
import { decodeFeeActivityWitness } from './activity-fees'
import { BrokerPollFailureReason, BrokerReadError, BrokerReadErrorKind } from './failures'
import {
  AccountStatus,
  OrderClass,
  OrderCollection,
  OrderSide,
  OrderStatus,
  OrderType,
  SortDirection,
  TimeInForce,
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
import { BrokerEnvironment, BrokerProvider } from '../identity'
import { alpacaSandboxBaseUrl, decodeBrokerConnection } from '../connection'
import { ordersUrl } from './requests'
import { brokerSnapshotCacheConfig, makeBrokerObservationCapture, makeProjectedBrokerRead } from './snapshot-cache'

const config = { maxAgeMs: 60_000 }
const accountId = '61e69015-8549-4bfd-b9c3-01e75843f47d'
const forReconciliation = <E, R>(read: Effect.Effect<ObservedBrokerSnapshot, E, R>) =>
  read.pipe(Effect.map((observation) => ({ observation, complete: Effect.void })))

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
  test('status identifies pending cash fees and clears the reason only after the canonical cut settles', async () => {
    const source = fixture()
    let snapshot = { ...observedBrokerSnapshotFixture(accountId, '1970-01-01T00:00:00.000Z'), pendingCashFeeCount: 2 }
    let failure: Cause.Cause<BrokerReadError> | undefined
    const observed = Effect.suspend(() =>
      failure === undefined ? Effect.succeed(snapshot) : Effect.failCause(failure),
    )
    await run(
      Effect.gen(function* () {
        const projected = yield* makeProjectedBrokerRead(source.read).pipe(
          Effect.provideService(BrokerObservations, {
            read: observed,
            readForReconciliation: forReconciliation(observed),
            readState: observed,
            readForSubmit: () => observed,
            invalidate: Effect.void,
          }),
        )
        const facts = () =>
          healthPass(projected).pipe(
            Effect.map((broker) =>
              statusFacts(
                { ...readyState(), broker },
                runtimeConfig.execution,
                provenance,
                runtimeConfig.build.verification,
              ),
            ),
          )
        expect(yield* facts()).toMatchObject({
          operational: { ready: false },
          broker: { readAvailable: false, reasonCode: 'BROKER_CASH_FEES_PENDING', error: 'BROKER_CASH_FEES_PENDING' },
        })
        const blockedSnapshot = {
          ...snapshot,
          snapshot: {
            ...snapshot.snapshot,
            account: {
              ...snapshot.snapshot.account,
              value: { ...snapshot.snapshot.account.value, tradingBlocked: true },
            },
          },
        }
        snapshot = blockedSnapshot
        expect(yield* facts()).toMatchObject({
          operational: { ready: false },
          broker: {
            readAvailable: false,
            reasonCode: 'BROKER_ACCOUNT_PERMISSION_DRIFT',
            error: 'BROKER_ACCOUNT_PERMISSION_DRIFT',
          },
        })
        snapshot = { ...observedBrokerSnapshotFixture(accountId, '1970-01-01T00:00:00.000Z'), pendingCashFeeCount: 0 }
        expect(yield* facts()).toMatchObject({
          operational: { ready: true },
          broker: { readAvailable: true, reasonCode: null, error: null },
        })
        const timeout = Cause.fail(
          new BrokerReadError({
            operation: 'preflight',
            kind: BrokerReadErrorKind.Timeout,
            retryable: true,
            message: 'Broker observation is awaiting authoritative cash fee records',
          }),
        )
        failure = timeout
        expect(yield* facts()).toMatchObject({
          operational: { ready: false },
          broker: { readAvailable: false, reasonCode: 'BROKER_READ_UNAVAILABLE' },
        })
        const feeWait = yield* Effect.flip(requireSettledCashFees({ pendingCashFeeCount: 1 }))
        failure = Cause.combine(Cause.fail(feeWait), timeout)
        expect(yield* facts()).toMatchObject({
          operational: { ready: false },
          broker: { readAvailable: false, reasonCode: 'BROKER_READ_UNAVAILABLE' },
        })
        expect(source.calls).toEqual([])
      }),
    )
  })

  test('requires a new poll cut after history changes instead of retrying the original ticket', async () => {
    const source = fixture()
    let scans = 0
    const changing: BrokerReadShape = {
      ...source.read,
      feeActivities: (query) =>
        source.read.feeActivities(query).pipe(
          Effect.map((result) => ({
            ...result,
            value: {
              items:
                ++scans === 1 ? [] : [{ accountId, activityId: 'fee-1', date: '1970-01-01', netAmountMicros: '-1' }],
            },
          })),
        ),
    }
    await run(
      Effect.gen(function* () {
        const captureBrokerObservation = yield* makeBrokerObservationCapture
        const pending = yield* captureBrokerObservation(
          changing,
          { generation: 1, startedAt: yield* currentUtcInstant },
          15_000,
        ).pipe(Effect.result, Effect.forkChild({ startImmediately: true }))
        yield* TestClock.adjust(1_000)
        const result = yield* Fiber.join(pending)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure.cause).toMatchObject({ failure: { _tag: 'Snapshot', reason: 'HistoryChanged' } })
          expect(result.failure).toMatchObject({ pollFailureReason: 'SNAPSHOT_REJECTED' })
          expect(brokerPollFailureAnnotations(result.failure)).toEqual({
            'broker.poll_failure_reason': 'SNAPSHOT_REJECTED',
            'broker.snapshot_failure_reason': 'HistoryChanged',
          })
        }
        expect(scans).toBe(2)
        const fresh = yield* captureBrokerObservation(
          changing,
          { generation: 2, startedAt: yield* currentUtcInstant },
          15_000,
        )
        expect(fresh.startedAt).toBe('1970-01-01T00:00:01.000Z')
        expect(fresh.snapshot.history.fees).toHaveLength(1)
        expect(scans).toBe(4)
        scans = 0
        const direct = yield* readStableBrokerSnapshot(changing, currentUtcInstant).pipe(
          Effect.forkChild({ startImmediately: true }),
        )
        yield* TestClock.adjust(1_000)
        expect((yield* Fiber.join(direct)).history.fees).toHaveLength(1)
        expect(scans).toBe(4)
      }),
    )
  })
  test('cancels broker acquisition at the polling deadline without producing a partial cut', async () => {
    const source = fixture()
    await run(
      Effect.gen(function* () {
        const captureBrokerObservation = yield* makeBrokerObservationCapture
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
        const pending = yield* captureBrokerObservation(
          source.read,
          { generation: 1, startedAt: yield* currentUtcInstant },
          1000,
        ).pipe(Effect.result, Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(started)
        yield* TestClock.adjust(1000)
        const result = yield* Fiber.join(pending)
        expect(Result.isFailure(result)).toBe(true)
        expect(cancelled).toBe(1)
        if (Result.isFailure(result)) expect(result.failure).toMatchObject({ pollFailureReason: 'POLL_DEADLINE' })
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
        const captureBrokerObservation = yield* makeBrokerObservationCapture
        return yield* captureBrokerObservation(
          source.read,
          { generation: 1, startedAt: yield* currentUtcInstant },
          15_000,
        )
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
        const captureBrokerObservation = yield* makeBrokerObservationCapture
        const value = yield* captureBrokerObservation(
          source.read,
          { generation: 1, startedAt: yield* currentUtcInstant },
          15_000,
        )
        const directCalls = source.calls.length
        let reads = 0
        const projected = yield* makeProjectedBrokerRead(source.read).pipe(
          Effect.provideService(BrokerObservations, {
            read: Effect.sync(() => {
              reads += 1
              return value
            }),
            readForReconciliation: forReconciliation(Effect.succeed(value)),
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
        const captureBrokerObservation = yield* makeBrokerObservationCapture
        const value = yield* captureBrokerObservation(
          source.read,
          { generation: 1, startedAt: yield* currentUtcInstant },
          15_000,
        )
        let payload: unknown = {
          snapshotHash: Result.getOrThrow(canonicalHashV1Result(value)),
          state: observedBrokerState(value),
        }
        let snapshotHash = Result.getOrThrow(canonicalHashV1Result(payload))
        let queries = 0
        const sql = (() =>
          Effect.sync(() => {
            queries += 1
            return [
              {
                generation: 1,
                state_hash: snapshotHash,
                snapshot_hash: Result.getOrThrow(canonicalHashV1Result(value)),
                observedAt: value.observedAt,
              },
            ]
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
            putAll: () => Effect.die('read-only probe'),
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
        const captureBrokerObservation = yield* makeBrokerObservationCapture
        const value = yield* captureBrokerObservation(
          source.read,
          { generation: 1, startedAt: yield* currentUtcInstant },
          15_000,
        )
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
            readForReconciliation: forReconciliation(Effect.succeed(value)),
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
              readForReconciliation: Effect.die('unexpected reconciliation read'),
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
        const captureBrokerObservation = yield* makeBrokerObservationCapture
        const value = yield* captureBrokerObservation(
          source.read,
          { generation: 1, startedAt: yield* currentUtcInstant },
          15_000,
        )
        const initial = source.calls.length
        const projected = yield* makeProjectedBrokerRead(source.read).pipe(
          Effect.provideService(BrokerObservations, {
            read: Effect.succeed(value),
            readForReconciliation: forReconciliation(Effect.succeed(value)),
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
        const captureBrokerObservation = yield* makeBrokerObservationCapture
        const value = yield* captureBrokerObservation(
          source.read,
          { generation: 1, startedAt: yield* currentUtcInstant },
          15_000,
        )
        let invalidations = 0
        const projected = yield* makeProjectedBrokerRead(source.read).pipe(
          Effect.provideService(BrokerObservations, {
            read: Effect.succeed(value),
            readForReconciliation: forReconciliation(Effect.succeed(value)),
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
        const captureBrokerObservation = yield* makeBrokerObservationCapture
        return yield* captureBrokerObservation(
          source.read,
          { generation: 1, startedAt: yield* currentUtcInstant },
          15_000,
        )
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
            readForReconciliation: Effect.die('unexpected reconciliation read'),
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
  test.each([0, 999, 60_001])('rejects an invalid maximum cache age %s', async (maxAgeMs) => {
    const result = await Effect.runPromise(
      brokerSnapshotCacheConfig.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ BAYN_BROKER_CACHE_MAX_AGE_MS: maxAgeMs }),
        ),
        Effect.result,
      ),
    )
    expect(Result.isFailure(result)).toBe(true)
  })
})

describe('complete open broker order capture', () => {
  const at = '2026-11-13T18:00:00.000Z'
  const protectionFixture = () => {
    const template = observedBrokerSnapshotFixture(accountId, at, '2026-11-13T17:59:00.000Z')
    const original = template.snapshot.history.orders.rows[0]?.value
    if (original === undefined) throw new Error('Missing parent order fixture')
    const { filledAt: _filledAt, filledAveragePriceMicros: _filledPrice, ...base } = original
    const profit: Order = {
      ...base,
      brokerOrderId: 'profit',
      parentBrokerOrderId: original.brokerOrderId,
      clientOrderId: 'broker-profit',
      filledQuantityAtoms: '0',
      orderClass: OrderClass.Simple,
      side: OrderSide.Sell,
      timeInForce: TimeInForce.Day,
      status: OrderStatus.New,
      limitPriceMicros: '202000000',
    }
    const stop: Order = {
      ...profit,
      brokerOrderId: 'stop',
      clientOrderId: 'broker-stop',
      orderType: OrderType.StopLimit,
      stopPriceMicros: '198000000',
      limitPriceMicros: '197900000',
    }
    const parent: Order = {
      ...original,
      orderClass: OrderClass.Bracket,
      timeInForce: TimeInForce.Day,
      legs: [profit, stop],
    }
    const pending: Order = {
      ...base,
      brokerOrderId: 'unrelated',
      clientOrderId: 'unrelated-client',
      symbol: 'MSFT',
      filledQuantityAtoms: '0',
      status: OrderStatus.Accepted,
      limitPriceMicros: '300000000',
    }
    const source = fixture({
      orders: [parent, pending],
      fills: template.snapshot.history.fills.map(({ value }) => value),
    })
    const standalone = ({ parentBrokerOrderId: _parent, ...order }: Order): Order => order
    let openRows: readonly Order[] = [standalone(profit), standalone(stop), pending]
    let openFailure: BrokerReadError | undefined
    const read: BrokerReadShape = {
      ...source.read,
      orders: (query) =>
        source.read.orders(query).pipe(
          Effect.flatMap((result) =>
            query?.status !== OrderCollection.Open
              ? Effect.succeed(result)
              : openFailure !== undefined
                ? Effect.fail(openFailure)
                : Effect.succeed({
                    value: openRows,
                    evidence: { ...result.evidence, contentHash: Result.getOrThrow(canonicalHashV1Result(openRows)) },
                  }),
          ),
        ),
    }
    return {
      source,
      read,
      parent,
      profit,
      stop,
      pending,
      standalone,
      setOpen: (rows: readonly Order[]) => {
        openRows = rows
      },
      failOpen: (error: BrokerReadError | undefined) => {
        openFailure = error
      },
    }
  }

  test('Black Friday: a filled GOOGL short bracket does not hide either live DAY child', async () => {
    const checkedAt = '2026-11-27T16:28:02.379Z'
    const fillAt = '2026-11-27T15:02:09.000Z'
    const template = observedBrokerSnapshotFixture(accountId, checkedAt, fillAt)
    const parent = template.snapshot.history.orders.rows[0]?.value
    const fill = template.snapshot.history.fills[0]?.value
    if (parent === undefined || fill === undefined) throw new Error('Expected broker fill fixture')
    const positionQuantity = '103000000000'
    const f = protectionFixture()
    const profit: Order = {
      ...f.profit,
      symbol: 'GOOGL',
      side: OrderSide.Buy,
      quantityAtoms: positionQuantity,
      limitPriceMicros: '261810000',
      createdAt: fillAt,
      submittedAt: fillAt,
      updatedAt: fillAt,
      observedAt: checkedAt,
    }
    const stop: Order = {
      ...profit,
      brokerOrderId: f.stop.brokerOrderId,
      clientOrderId: f.stop.clientOrderId,
      orderType: OrderType.StopLimit,
      stopPriceMicros: '275310000',
      limitPriceMicros: '275580000',
    }
    const bracket: Order = {
      ...parent,
      symbol: 'GOOGL',
      side: OrderSide.Sell,
      quantityAtoms: positionQuantity,
      filledQuantityAtoms: positionQuantity,
      filledAveragePriceMicros: '271025500',
      limitPriceMicros: '270810000',
      orderClass: OrderClass.Bracket,
      timeInForce: TimeInForce.Day,
      legs: [profit, stop],
    }
    const source = fixture({
      orders: [bracket],
      fills: [
        {
          ...fill,
          symbol: 'GOOGL',
          side: OrderSide.Sell,
          quantityAtoms: positionQuantity,
          cumulativeQuantityAtoms: positionQuantity,
          priceAtoms: '271025500000',
        },
      ],
    })
    const connection = Result.getOrThrow(
      decodeBrokerConnection({
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Sandbox,
        baseUrl: alpacaSandboxBaseUrl,
        expectedAccountId: accountId,
        key: Redacted.make('key'),
        secret: Redacted.make('secret'),
        proxyUrl: 'http://proxy.test:3128',
        operationTimeoutMs: 15_000,
        retryAttempts: 2,
      }),
    )
    const read: BrokerReadShape = {
      ...source.read,
      orders: (query) =>
        source.read.orders(query).pipe(
          Effect.map((response) =>
            query?.status !== OrderCollection.Open
              ? response
              : {
                  ...response,
                  value:
                    ordersUrl(connection, query).searchParams.get('nested') === 'false'
                      ? [f.standalone(profit), f.standalone(stop)]
                      : [],
                },
          ),
        ),
    }
    await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(checkedAt))
        const capture = yield* makeBrokerObservationCapture
        const snapshot = yield* capture(read, { generation: 1, startedAt: checkedAt }, 15_000)
        expect(snapshot.openOrders.value).toEqual([profit, stop])
        expect(snapshot.snapshot.history.orders.rows[0]?.value).toEqual(bracket)
      }),
    )
  })

  test('retains both protective children and every unrelated open order without another broker request', async () => {
    const f = protectionFixture()
    await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(at))
        const capture = yield* makeBrokerObservationCapture
        const value = yield* capture(f.read, { generation: 1, startedAt: at }, 15_000)
        expect(value.openOrders.value).toEqual([f.profit, f.stop, f.pending])
        expect(value.snapshot.history.orders.rows.map(({ value }) => value)).toEqual([f.parent, f.pending])
        expect(f.source.calls.filter((call) => call.startsWith('orders:') && call.includes('"status":"open"'))).toEqual(
          ['orders:{"status":"open","limit":500}'],
        )
        const requests = f.source.calls.length
        const projected = yield* makeProjectedBrokerRead(f.read).pipe(
          Effect.provideService(BrokerObservations, {
            read: Effect.succeed(value),
            readState: Effect.succeed(value),
            readForSubmit: () => Effect.succeed(value),
            readForReconciliation: forReconciliation(Effect.succeed(value)),
            invalidate: Effect.void,
          }),
        )
        const projection = projected.projection
        if (projection === undefined) throw new Error('Missing broker projection')
        expect((yield* projection.submissionSnapshot('candidate')).openOrders).toEqual(value.openOrders)
        expect((yield* projected.orders({ status: OrderCollection.Open, limit: 1 })).value).toEqual([f.profit])
        expect((yield* projected.orders({ status: OrderCollection.Open, limit: 10 })).value).toEqual([
          f.profit,
          f.stop,
          f.pending,
        ])
        expect(f.source.calls.length).toBe(requests)
      }),
    )
  })

  test('preserves nested lineage and collapses only an identical standalone child alias', async () => {
    const f = protectionFixture()
    f.setOpen([f.parent, f.standalone(f.profit), f.pending])
    await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(at))
        const capture = yield* makeBrokerObservationCapture
        const value = yield* capture(f.read, { generation: 1, startedAt: at }, 15_000)
        expect(value.openOrders.value).toEqual([f.profit, f.stop, f.pending])
        expect(value.openOrders.value.every((order) => order.legs === undefined)).toBe(true)
        expect(value.snapshot.history.orders.rows[0]?.value).toEqual(f.parent)
      }),
    )
  })

  test.each([
    'missing-child',
    'changed-price',
    'wrong-parent',
    'duplicate-root',
    'duplicate-nested',
    'duplicate-client',
    'full-page',
    'nested-overflow',
  ] as const)('rejects an unproven open-order cut: %s', async (changed) => {
    const f = protectionFixture()
    const rows: readonly Order[] =
      changed === 'missing-child'
        ? [f.profit, f.pending]
        : changed === 'changed-price'
          ? [f.profit, { ...f.stop, stopPriceMicros: '197000000' }, f.pending]
          : changed === 'wrong-parent'
            ? [{ ...f.profit, parentBrokerOrderId: 'different-parent' }, f.stop, f.pending]
            : changed === 'duplicate-root'
              ? [f.profit, f.profit, f.stop, f.pending]
              : changed === 'duplicate-nested'
                ? [{ ...f.parent, legs: [f.profit, f.profit] }, f.pending]
                : changed === 'duplicate-client'
                  ? [f.profit, f.stop, { ...f.pending, clientOrderId: f.profit.clientOrderId }]
                  : changed === 'full-page'
                    ? Array.from({ length: 500 }, (_, i) => ({
                        ...f.pending,
                        brokerOrderId: `open-${i}`,
                        clientOrderId: `open-client-${i}`,
                      }))
                    : [
                        f.parent,
                        ...Array.from({ length: 497 }, (_, i) => ({
                          ...f.pending,
                          brokerOrderId: `open-${i}`,
                          clientOrderId: `open-client-${i}`,
                        })),
                      ]
    f.setOpen(rows)
    await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(at))
        const capture = yield* makeBrokerObservationCapture
        const failure = yield* capture(f.read, { generation: 1, startedAt: at }, 15_000).pipe(Effect.flip)
        expect(failure.kind).toBe(BrokerReadErrorKind.Timeout)
        expect(failure.pollFailureReason).toBe(BrokerPollFailureReason.SnapshotRejected)
        expect(f.source.calls.filter((call) => call.includes('"status":"open"'))).toHaveLength(1)
      }),
    )
  })

  test('a failed open-order read stays unavailable and prevents reuse of the prior complete history', async () => {
    const f = protectionFixture()
    await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(at))
        const capture = yield* makeBrokerObservationCapture
        yield* capture(f.read, { generation: 1, startedAt: at }, 15_000)
        const failed = new BrokerReadError({
          operation: 'orders',
          kind: BrokerReadErrorKind.Timeout,
          retryable: true,
          message: 'open orders failed',
        })
        f.failOpen(failed)
        yield* TestClock.adjust(1)
        expect(
          yield* capture(f.read, { generation: 2, startedAt: yield* currentUtcInstant }, 15_000).pipe(Effect.flip),
        ).toBe(failed)
        f.failOpen(undefined)
        f.source.calls.length = 0
        yield* TestClock.adjust(1)
        const refreshed = yield* capture(f.read, { generation: 3, startedAt: yield* currentUtcInstant }, 15_000)
        expect(refreshed.openOrders.value).toEqual([f.profit, f.stop, f.pending])
        expect(f.source.calls.filter((call) => call.includes('"status":"all"'))).toHaveLength(2)
      }),
    )
  })
})

describe('complete history reuse between broker captures', () => {
  test('projects recent history from the verified cut without redundant requests at production page counts', async () => {
    const at = '2026-11-13T18:00:00.000Z'
    const template = observedBrokerSnapshotFixture(accountId, at, '2026-11-12T18:00:00.000Z')
    const order = template.snapshot.history.orders.rows[0]?.value
    const fill = template.snapshot.history.fills[0]?.value
    if (order === undefined || fill === undefined) throw new Error('missing history fixture')
    // Match the traced capture: four order pages, twenty-two fill pages and five fee pages.
    const orders = Array.from({ length: 1500 }, (_, i) => ({
      ...order,
      brokerOrderId: `order-${i}`,
      clientOrderId: `client-${i}`,
      submittedAt: new Date(Date.parse('2026-11-12T18:00:00.000Z') - i * 1000).toISOString(),
      filledQuantityAtoms: i === 0 ? '2168000000000' : '0',
      quantityAtoms: i === 0 ? '2168000000000' : '1000000000',
      status: i === 0 ? OrderStatus.Filled : OrderStatus.Canceled,
    }))
    const fills = Array.from({ length: 2168 }, (_, i) => ({
      ...fill,
      activityId: `fill::${i}`,
      brokerOrderId: 'order-0',
      transactionTime: new Date(Date.parse(at) - (2200 - i) * 1000).toISOString(),
    }))
    const fees = Array.from({ length: 401 }, (_, i) => ({
      accountId,
      activityId: `fee-${i}`,
      date: '2026-11-12',
      netAmountMicros: '-1',
    }))
    const source = fixture({ orders, fills, fees })
    const pageEvidence = <A>(result: ReadResult<unknown>, value: A): ReadResult<A> => ({
      value,
      evidence: { ...result.evidence, contentHash: Result.getOrThrow(canonicalHashV1Result(value)) },
    })
    const read: BrokerReadShape = {
      ...source.read,
      orders: (query) =>
        source.read.orders(query).pipe(
          Effect.map((result) =>
            pageEvidence(
              result,
              result.value
                .filter((row) => query?.until === undefined || (row.submittedAt ?? '') < query.until)
                .slice(0, query?.limit)
                .map((row) => ({ ...row, observedAt: result.evidence.observedAt })),
            ),
          ),
        ),
      fillActivities: (query) =>
        source.read.fillActivities(query).pipe(
          Effect.map((result) => {
            const ordered = query?.direction === SortDirection.Descending ? [...fills].reverse() : fills
            const start =
              query?.pageToken === undefined ? 0 : ordered.findIndex((row) => row.activityId === query.pageToken) + 1
            const items = ordered.slice(start, start + (query?.pageSize ?? 100))
            const last = items.at(-1)
            return pageEvidence(result, {
              items,
              ...(items.length === query?.pageSize && last !== undefined ? { nextPageToken: last.activityId } : {}),
            })
          }),
        ),
      feeActivities: (query) =>
        source.read.feeActivities(query).pipe(
          Effect.map((result) => {
            const start =
              query?.pageToken === undefined ? 0 : fees.findIndex((row) => row.activityId === query.pageToken) + 1
            const items = fees.slice(start, start + (query?.pageSize ?? 100))
            const last = items.at(-1)
            return pageEvidence(result, {
              items,
              ...(items.length === query?.pageSize && last !== undefined ? { nextPageToken: last.activityId } : {}),
            })
          }),
        ),
    }
    await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(at))
        const capture = yield* makeBrokerObservationCapture
        const first = yield* capture(read, { generation: 1, startedAt: yield* currentUtcInstant }, 15_000)
        expect(source.calls).toHaveLength(66)
        expect(first.snapshot.history.orders.rows).toHaveLength(1500)
        expect(first.snapshot.history.fills).toHaveLength(2168)
        expect(first.snapshot.history.fees).toHaveLength(401)
        const recentOrder = first.snapshot.history.orders.rows[0]
        const recentFill = first.snapshot.history.fills.at(-1)
        if (recentOrder === undefined || recentFill === undefined) throw new Error('missing captured history')
        expect(first.recentOrders.value).toEqual([recentOrder.value])
        expect(first.recentOrders.evidence).toEqual(recentOrder.evidence)
        expect(first.recentFills.value).toEqual({ items: [recentFill.value], nextPageToken: 'fill::2167' })
        expect(first.recentFills.evidence).toEqual(recentFill.evidence)
        yield* TestClock.adjust(40_000)
        source.calls.length = 0
        const second = yield* capture(read, { generation: 2, startedAt: yield* currentUtcInstant }, 15_000)
        expect(source.calls).toHaveLength(36)
        expect(second.snapshot.history.fills.map((row) => row.value)).toEqual(fills)
        expect(second.recentOrders.evidence.observedAt).toBe('2026-11-13T18:00:40.000Z')
        expect(second.recentFills.evidence.observedAt).toBe('2026-11-13T18:00:40.000Z')
        const replayRead: BrokerReadShape = {
          ...read,
          fillActivities: () => Effect.die('unexpected REST fill read on PAPER stream'),
          accountActivity: currentUtcInstant.pipe(
            Effect.map((observedAt) => {
              source.calls.push('execution-stream-view')
              const evidence = { status: 200, requestId: 'stream', contentHash: '0'.repeat(64), observedAt }
              return {
                version: `${fills.length}:${JSON.stringify([...feeCounts])}`,
                feeVersion: JSON.stringify([...feeCounts]),
                fills: fills.map((value) => ({ value, evidence })),
                feeCounts,
                evidence,
              }
            }),
          ),
        }
        const feeCounts = new Map([['["FEE","2026-11-12","-1","0"]', 401]])
        const previousOrder = orders[0]
        if (previousOrder === undefined) throw new Error('missing filled order')
        fills.push({
          ...fill,
          activityId: 'fill::2168',
          brokerOrderId: 'order-0',
          transactionTime: '2026-11-13T18:00:50.000Z',
        })
        orders[0] = { ...previousOrder, filledQuantityAtoms: '2169000000000', quantityAtoms: '2169000000000' }
        yield* TestClock.adjust(20_000)
        source.calls.length = 0
        const changed = yield* capture(replayRead, { generation: 4, startedAt: yield* currentUtcInstant }, 15_000)
        expect(source.calls.filter((call) => call === 'execution-stream-view')).toHaveLength(3)
        expect(source.calls.filter((call) => call === 'fees')).toHaveLength(5)
        expect(changed.snapshot.history.fills.map((row) => row.value)).toEqual(fills)
        expect(changed.snapshot.history.fees.map((row) => row.value)).toEqual(fees)
        const oldFill = fills[0]
        if (oldFill === undefined) throw new Error('missing retained fill')
        fills[0] = { ...oldFill, priceAtoms: '199000000000' }
        const correction = yield* capture(
          replayRead,
          { generation: 5, startedAt: yield* currentUtcInstant },
          15_000,
        ).pipe(Effect.result)
        expect(correction).toMatchObject({
          _tag: 'Failure',
          failure: { cause: { failure: { reason: 'HistoryChanged' } } },
        })
        const recovered = yield* capture(replayRead, { generation: 6, startedAt: yield* currentUtcInstant }, 15_000)
        expect(recovered.snapshot.history.fills[0]?.value).toEqual(fills[0])
        expect(source.calls.filter((call) => call === 'fees')).toHaveLength(5)
        const unavailableReplay = (kind: BrokerReadErrorKind) => ({
          ...read,
          accountActivity: Effect.fail(
            new BrokerReadError({ operation: 'fill-activities', kind, message: 'fixture', retryable: true }),
          ),
        })
        const timedOut = yield* capture(
          unavailableReplay(BrokerReadErrorKind.Timeout),
          { generation: 7, startedAt: yield* currentUtcInstant },
          15_000,
        ).pipe(Effect.result)
        expect(timedOut).toMatchObject({ _tag: 'Failure', failure: { kind: BrokerReadErrorKind.Timeout } })
        const rateLimited = yield* capture(
          unavailableReplay(BrokerReadErrorKind.RateLimited),
          { generation: 8, startedAt: yield* currentUtcInstant },
          15_000,
        ).pipe(Effect.result)
        expect(rateLimited).toMatchObject({ _tag: 'Failure', failure: { kind: BrokerReadErrorKind.RateLimited } })
      }),
    )
  })

  test('reads PAPER fee identities and coin prices once per streamed change and rejects a fee gap', async () => {
    const fees: FeeActivity[] = []
    let feeCounts: ReadonlyMap<string, number> = new Map()
    const source = fixture({ fees })
    const read: BrokerReadShape = {
      ...source.read,
      fillActivities: () => Effect.die('unexpected REST fill read'),
      accountActivity: currentUtcInstant.pipe(
        Effect.map((observedAt) => ({
          version: JSON.stringify([...feeCounts]),
          feeVersion: JSON.stringify([...feeCounts]),
          fills: [],
          feeCounts,
          evidence: { status: 200, requestId: 'stream', contentHash: '0'.repeat(64), observedAt },
        })),
      ),
    }
    const publishedFee = Result.getOrThrow(
      decodeFeeActivityWitness({
        activity_type: 'CFEE',
        ref_id: 'streamed-fee',
        status: 'executed',
        currency: 'USD',
        net_amount: '0.0',
        qty: '-0.000200',
        price: '260.102',
        settle_date: '2026-11-14',
        details: { system_date: '2026-11-13' },
      }),
    )
    const confirmed = {
      accountId,
      activityId: 'rest-fee',
      date: '2026-11-13',
      netAmountMicros: '0',
      sourceCreatedAt: '2026-11-13T18:00:01.000Z',
      coinDebit: { symbol: 'ETH/USD', quantityAtoms: '200000', priceAtoms: '260100000000' },
    } satisfies FeeActivity
    await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-11-13T18:00:01.000Z'))
        const capture = yield* makeBrokerObservationCapture
        const observe = (generation: number) =>
          currentUtcInstant.pipe(Effect.flatMap((startedAt) => capture(read, { startedAt, generation }, 15_000)))
        yield* observe(1)
        expect(source.calls.filter((call) => call === 'fees')).toHaveLength(1)
        yield* observe(2)
        expect(source.calls.filter((call) => call === 'fees')).toHaveLength(1)
        feeCounts = new Map([[publishedFee.key, 1]])
        const missing = yield* observe(3).pipe(Effect.flip)
        expect(missing.message).toBe('Alpaca Activity SSE and fee authority have not converged')
        fees.push({ ...confirmed, coinDebit: { ...confirmed.coinDebit, quantityAtoms: '100000' } })
        const incorrect = yield* observe(4).pipe(Effect.flip)
        expect(incorrect.message).toBe(missing.message)
        fees[0] = confirmed
        const recovered = yield* observe(5)
        expect(recovered.snapshot.history.fees.map(({ value }) => value)).toEqual([confirmed])
        expect(source.calls.filter((call) => call === 'fees')).toHaveLength(4)
        yield* observe(6)
        expect(source.calls.filter((call) => call === 'fees')).toHaveLength(4)
      }),
    )
  })

  test('keeps witnessed cash fees pending across UTC rollover and restart until REST settles them', async () => {
    const fees: FeeActivity[] = []
    const source = fixture({ fees })
    const key = Result.getOrThrow(
      decodeFeeActivityWitness({
        activity_type: 'FEE',
        ref_id: 'streamed-cash-fee',
        status: 'executed',
        currency: 'USD',
        net_amount: '-0.02',
        details: { system_date: '2026-11-19' },
      }),
    ).key
    let feeCounts = new Map([[key, 2]])
    const read: BrokerReadShape = {
      ...source.read,
      fillActivities: () => Effect.die('unexpected REST fill read'),
      accountActivity: currentUtcInstant.pipe(
        Effect.map((observedAt) => ({
          version: JSON.stringify([...feeCounts]),
          feeVersion: JSON.stringify([...feeCounts]),
          fills: [],
          feeCounts,
          evidence: { status: 200, requestId: 'stream', contentHash: '0'.repeat(64), observedAt },
        })),
      ),
    }
    await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-11-20T01:15:00.000Z'))
        const capture = yield* makeBrokerObservationCapture
        const observe = (generation: number) =>
          currentUtcInstant.pipe(Effect.flatMap((startedAt) => capture(read, { startedAt, generation }, 15_000)))
        const pending = yield* observe(1)
        expect(pending.pendingCashFeeCount).toBe(2)
        expect(pending.snapshot.history.fees).toEqual([])
        expect(source.calls.filter((call) => call === 'fees')).toHaveLength(1)
        expect(Result.isSuccess(decodeObservedBrokerSnapshot(pending))).toBe(true)
        fees.push({ accountId, activityId: 'rest-one', date: '2026-11-19', netAmountMicros: '-20000' })
        const partial = yield* observe(2)
        expect(partial.pendingCashFeeCount).toBe(1)
        expect(partial.snapshot.history.fees.map(({ value }) => value)).toEqual(fees)
        fees.push({ ...fees[0], accountId, activityId: 'rest-two', date: '2026-11-19', netAmountMicros: '-30000' })
        expect(yield* observe(3).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
          failure: { message: 'Alpaca Activity SSE and fee authority have not converged' },
        })
        fees.pop()
        yield* TestClock.setTime(Date.parse('2026-11-20T23:59:59.999Z'))
        expect((yield* observe(4)).pendingCashFeeCount).toBe(1)

        yield* TestClock.setTime(Date.parse('2026-11-21T00:00:00.000Z'))
        const restarted = yield* makeBrokerObservationCapture
        const observeAfterRestart = (generation: number) =>
          currentUtcInstant.pipe(Effect.flatMap((startedAt) => restarted(read, { startedAt, generation }, 15_000)))
        const lingering = yield* observeAfterRestart(5)
        expect(lingering.observedAt).toBe('2026-11-21T00:00:00.000Z')
        expect(lingering.pendingCashFeeCount).toBe(1)
        expect(lingering.snapshot.history.fees.map(({ value }) => value)).toEqual(fees)
        expect(Result.isSuccess(decodeObservedBrokerSnapshot(lingering))).toBe(true)

        fees.push({ accountId, activityId: 'rest-two', date: '2026-11-19', netAmountMicros: '-20000' })
        const settled = yield* observeAfterRestart(6)
        expect(settled.pendingCashFeeCount).toBe(0)
        expect(settled.snapshot.history.fees.map(({ value }) => value)).toEqual(fees)
        expect(source.calls.filter((call) => call === 'fees')).toHaveLength(6)
        yield* observeAfterRestart(7)
        expect(source.calls.filter((call) => call === 'fees')).toHaveLength(6)
        feeCounts = new Map([
          [key, 2],
          [key.replace('2026-11-19', '2026-11-22'), 1],
        ])
        expect(yield* observeAfterRestart(8).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
          failure: { message: 'Alpaca Activity SSE and fee authority have not converged' },
        })
      }),
    )
  })

  test('empty recent-history projections retain real response evidence without additional probes', async () => {
    const source = fixture()
    await run(
      Effect.gen(function* () {
        const capture = yield* makeBrokerObservationCapture
        const value = yield* capture(source.read, { generation: 1, startedAt: yield* currentUtcInstant }, 15_000)
        expect(value.recentOrders.value).toEqual([])
        expect(value.recentFills.value).toEqual({ items: [] })
        expect(value.recentOrders.evidence.requestId).toContain('orders:')
        expect(value.recentFills.evidence.requestId).toContain('fills:')
        expect(source.calls).toHaveLength(10)
        expect(Result.isSuccess(decodeObservedBrokerSnapshot(value))).toBe(true)
      }),
    )
  })

  test('a new latest fill rebuilds the bracket, while a correction with the same identity still rejects it', async () => {
    const at = '2026-11-13T18:00:00.000Z'
    const template = observedBrokerSnapshotFixture(accountId, at, '2026-11-13T17:59:59.000Z')
    const order = template.snapshot.history.orders.rows[0]?.value
    const fill = template.snapshot.history.fills[0]?.value
    if (order === undefined || fill === undefined) throw new Error('missing history fixture')
    const orders: Order[] = []
    const fills: FillActivity[] = []
    const source = fixture({ orders, fills })
    await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(at))
        const capture = yield* makeBrokerObservationCapture
        yield* capture(source.read, { generation: 1, startedAt: yield* currentUtcInstant }, 15_000)
        orders.push(order)
        fills.push(fill)
        const fresh = yield* capture(source.read, { generation: 2, startedAt: yield* currentUtcInstant }, 15_000)
        expect(source.calls.filter((call) => call === 'fees')).toHaveLength(4)
        expect(fresh.recentFills.value.items).toEqual([fill])
        fills[0] = { ...fill, priceAtoms: '199000000000' }
        const corrected = yield* capture(
          source.read,
          { generation: 3, startedAt: yield* currentUtcInstant },
          15_000,
        ).pipe(Effect.result)
        expect(corrected).toMatchObject({
          _tag: 'Failure',
          failure: { cause: { failure: { reason: 'HistoryChanged' } } },
        })
        const rebuilt = yield* capture(source.read, { generation: 4, startedAt: yield* currentUtcInstant }, 15_000)
        expect(rebuilt.recentFills.value.items[0]?.priceAtoms).toBe('199000000000')
        expect(source.calls.filter((call) => call === 'fees')).toHaveLength(7)
      }),
    )
  })

  test('stable polls use one fresh full scan after the initial bracket', async () => {
    const source = fixture()
    await run(
      Effect.gen(function* () {
        const capture = yield* makeBrokerObservationCapture
        const first = yield* capture(source.read, { generation: 1, startedAt: yield* currentUtcInstant }, 15_000)
        expect(source.calls.filter((call) => call === 'fees')).toHaveLength(2)
        yield* TestClock.adjust(1_000)
        const second = yield* capture(source.read, { generation: 2, startedAt: yield* currentUtcInstant }, 15_000)
        expect(source.calls.filter((call) => call === 'fees')).toHaveLength(3)
        expect(second.snapshot.history).not.toBe(first.snapshot.history)
        expect(second.snapshot.history.orders.observedAt).toBe('1970-01-01T00:00:01.000Z')
        expect(second.observedAt).toBe('1970-01-01T00:00:01.000Z')
      }),
    )
  })

  test('an old fee correction rejects the retained bracket and rebuilds on the next capture', async () => {
    const source = fixture()
    let amount = '-1'
    const read: BrokerReadShape = {
      ...source.read,
      feeActivities: (query) =>
        source.read.feeActivities(query).pipe(
          Effect.map((page) => ({
            ...page,
            value: { items: [{ accountId, activityId: 'old-fee', date: '1970-01-01', netAmountMicros: amount }] },
          })),
        ),
    }
    await run(
      Effect.gen(function* () {
        const capture = yield* makeBrokerObservationCapture
        yield* capture(read, { generation: 1, startedAt: yield* currentUtcInstant }, 15_000)
        amount = '-2'
        const changed = yield* capture(read, { generation: 2, startedAt: yield* currentUtcInstant }, 15_000).pipe(
          Effect.result,
        )
        expect(changed).toMatchObject({
          _tag: 'Failure',
          failure: { cause: { failure: { reason: 'HistoryChanged' } } },
        })
        const rebuilt = yield* capture(read, { generation: 3, startedAt: yield* currentUtcInstant }, 15_000)
        expect(rebuilt.snapshot.history.fees[0]?.value.netAmountMicros).toBe('-2')
        expect(source.calls.filter((call) => call === 'fees')).toHaveLength(5)
      }),
    )
  })

  test('a typed account failure discards the retained before-history', async () => {
    const source = fixture()
    const error = new BrokerReadError({
      operation: 'account',
      kind: BrokerReadErrorKind.Transport,
      retryable: true,
      message: 'unavailable',
    })
    await run(
      Effect.gen(function* () {
        const capture = yield* makeBrokerObservationCapture
        yield* capture(source.read, { generation: 1, startedAt: yield* currentUtcInstant }, 15_000)
        source.failAccount(error)
        const failed = yield* capture(source.read, { generation: 2, startedAt: yield* currentUtcInstant }, 15_000).pipe(
          Effect.result,
        )
        expect(failed).toMatchObject({ _tag: 'Failure', failure: error })
        source.failAccount(undefined)
        yield* capture(source.read, { generation: 3, startedAt: yield* currentUtcInstant }, 15_000)
        expect(source.calls.filter((call) => call === 'fees')).toHaveLength(4)
      }),
    )
  })

  test('defects and timeout cancellation discard retained history and release the capture permit', async () => {
    for (const defect of [true, false]) {
      const source = fixture()
      let cancelled = 0
      await run(
        Effect.gen(function* () {
          const capture = yield* makeBrokerObservationCapture
          yield* capture(source.read, { generation: 1, startedAt: yield* currentUtcInstant }, 15_000)
          const entered = yield* Deferred.make<void>()
          source.blockAccount(
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(
                defect
                  ? Effect.die('broken broker adapter')
                  : Effect.never.pipe(
                      Effect.onInterrupt(() =>
                        Effect.sync(() => {
                          cancelled++
                        }),
                      ),
                    ),
              ),
            ),
          )
          const pending = yield* capture(
            source.read,
            { generation: 2, startedAt: yield* currentUtcInstant },
            1_000,
          ).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(entered)
          if (!defect) yield* TestClock.adjust(1_000)
          const exit = yield* Fiber.join(pending)
          expect(Exit.isFailure(exit)).toBe(true)
          expect(cancelled).toBe(defect ? 0 : 1)
          source.blockAccount(Effect.void)
          yield* capture(source.read, { generation: 3, startedAt: yield* currentUtcInstant }, 15_000)
          expect(source.calls.filter((call) => call === 'fees')).toHaveLength(4)
        }),
      )
    }
  })

  test('concurrent captures serialize around the complete account/history bracket', async () => {
    const source = fixture()
    await run(
      Effect.gen(function* () {
        const capture = yield* makeBrokerObservationCapture
        yield* capture(source.read, { generation: 1, startedAt: yield* currentUtcInstant }, 15_000)
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let accounts = 0
        source.blockAccount(
          Effect.sync(() => {
            accounts++
          }).pipe(Effect.andThen(Deferred.succeed(entered, undefined)), Effect.andThen(Deferred.await(release))),
        )
        const first = yield* capture(source.read, { generation: 2, startedAt: yield* currentUtcInstant }, 15_000).pipe(
          Effect.forkChild({ startImmediately: true }),
        )
        yield* Deferred.await(entered)
        const second = yield* capture(source.read, { generation: 3, startedAt: yield* currentUtcInstant }, 15_000).pipe(
          Effect.forkChild({ startImmediately: true }),
        )
        expect(accounts).toBe(1)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        expect(accounts).toBe(2)
        expect(source.calls.filter((call) => call === 'fees')).toHaveLength(4)
      }),
    )
  })
})

test('a durable invalidation starts a fresh bracket instead of comparing across a known mutation', async () => {
  const source = fixture()
  let amount = '-1'
  const read: BrokerReadShape = {
    ...source.read,
    feeActivities: (query) =>
      source.read.feeActivities(query).pipe(
        Effect.map((page) => ({
          ...page,
          value: { items: [{ accountId, activityId: 'old-fee', date: '1970-01-01', netAmountMicros: amount }] },
        })),
      ),
  }
  await run(
    Effect.gen(function* () {
      const capture = yield* makeBrokerObservationCapture
      yield* capture(read, { generation: 1, startedAt: yield* currentUtcInstant }, 15_000)
      amount = '-2'
      const refreshed = yield* capture(read, { generation: 3, startedAt: yield* currentUtcInstant }, 15_000)
      expect(refreshed.snapshot.history.fees[0]?.value.netAmountMicros).toBe('-2')
      expect(source.calls.filter((call) => call === 'fees')).toHaveLength(4)
    }),
  )
})

test.each([500, 1_500])(
  'a clock regression discards future history with a durable ticket at %sms',
  async (ticketAt) => {
    const source = fixture()
    await run(
      Effect.gen(function* () {
        const capture = yield* makeBrokerObservationCapture
        yield* TestClock.setTime(1_000)
        yield* capture(source.read, { generation: 1, startedAt: yield* currentUtcInstant }, 15_000)
        yield* TestClock.setTime(500)
        const refreshed = yield* capture(
          source.read,
          { generation: 2, startedAt: new Date(ticketAt).toISOString() },
          15_000,
        )
        expect(refreshed.observedAt).toBe('1970-01-01T00:00:00.500Z')
        expect(source.calls.filter((call) => call === 'fees')).toHaveLength(4)
      }),
    )
  },
)

test('the unchanged capture deadline cancels an endlessly advancing history cursor', async () => {
  const source = fixture()
  let pages = 0
  let cancellations = 0
  const read: BrokerReadShape = {
    ...source.read,
    feeActivities: () =>
      Effect.sleep(10).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            cancellations++
          }),
        ),
        Effect.map(() => {
          const id = `fee-${++pages}`
          return {
            value: {
              items: [{ accountId, activityId: id, date: '1970-01-01', netAmountMicros: '-1' }],
              nextPageToken: id,
            },
            evidence: {
              requestId: id,
              status: 200,
              contentHash: 'a'.repeat(64),
              observedAt: '1970-01-01T00:00:00.000Z',
            },
          }
        }),
      ),
  }
  await run(
    Effect.gen(function* () {
      const capture = yield* makeBrokerObservationCapture
      const pending = yield* capture(read, { generation: 1, startedAt: yield* currentUtcInstant }, 50).pipe(
        Effect.result,
        Effect.forkChild({ startImmediately: true }),
      )
      yield* TestClock.adjust(50)
      const result = yield* Fiber.join(pending)
      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { message: 'Broker observation polling exceeded its deadline' },
      })
      expect(pages).toBeGreaterThan(0)
      expect(cancellations).toBe(1)
      const stoppedAt = pages
      yield* TestClock.adjust(1_000)
      expect(pages).toBe(stoppedAt)
    }),
  )
})
