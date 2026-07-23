import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Cause, Effect, Exit, Layer, ManagedRuntime, Redacted } from 'effect'

import type { RuntimeConfig } from '../config'
import { operationalError } from '../errors'
import { canonicalHashV1 } from '../hash'
import { hashLedgerPlan } from '../ledger-plan'
import { Journal, type JournalService } from '../ledger'
import {
  AccountStatus,
  Authority,
  Broker,
  DiscrepancyKind,
  KillState,
  OrderSide,
  OrderStatus,
  OrderType,
  ReconciliationStatus,
  TimeInForce,
} from '../paper'
import {
  sourceTimestamp,
  type BrokerEventInput,
  type FillEventInput,
  type PositionEventInput,
  type PositionSnapshotInput,
  type ValuationInput,
} from '../broker/observations'
import { EvidenceStore, EvidenceStoreLive, PostgresClientLive } from './evidence-store'
import { PaperStore, PaperStoreLive } from './paper-store'

const postgresUrl = process.env.BAYN_TEST_POSTGRES_URL
const testUrl = postgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = postgresUrl === undefined ? describe.skip : describe
const accountId = 'paper-account-1'
const observedAt = '2026-07-22T15:30:01.000Z'
const occurredAt = '2026-07-22T15:30:00.000Z'
const hash = (value: string): string => canonicalHashV1({ value })

const config: RuntimeConfig = {
  host: '127.0.0.1',
  port: 8080,
  maximumAuthority: Authority.Observe,
  build: {
    sourceRevision: 'a'.repeat(40),
    imageRepository: 'registry.ide-newton.ts.net/lab/bayn',
    imageDigest: `sha256:${'b'.repeat(64)}`,
    strategyBehaviorHash: 'c'.repeat(64),
    strategyParameterHash: 'd'.repeat(64),
    verification: 'embedded',
  },
  healthIntervalMs: 30_000,
  operationTimeoutMs: 5_000,
  cycleStallThresholdMs: 300_000,
  reconciliationStaleThresholdMs: 120_000,
  unknownMutationThresholdMs: 300_000,
  clickhouse: {
    url: 'http://clickhouse.invalid',
    username: 'bayn',
    password: Redacted.make('unused'),
    snapshotId: '1'.repeat(64),
    publicationAsOf: '2026-07-17',
    calendarVersion: 'fixture-calendar-v1',
    bounds: {
      schemaVersion: 'bayn.evaluation-bounds.v1',
      dataStart: '2018-01-02',
      dataEnd: '2026-07-17',
      lookbackStart: '2018-01-02',
      evaluationStart: '2019-01-02',
      evaluationEnd: '2026-07-17',
    },
  },
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
  tigerBeetle: { clusterId: 2_001n, replicaAddresses: ['127.0.0.1:3000'], ledger: 7_001 },
}

interface JournalControl {
  fail: boolean
  readonly planHashes: string[]
}

const journal = (control: JournalControl): JournalService => ({
  post: (plan) =>
    Effect.suspend(() => {
      control.planHashes.push(hashLedgerPlan(plan))
      return control.fail
        ? Effect.fail(operationalError('journal', 'post', 'injected TigerBeetle failure'))
        : Effect.void
    }),
  verifyAccount: () => Effect.succeed(true),
  journalAndReconcile: () => Effect.die(new Error('unexpected simulation journal call')),
  check: Effect.void,
  checkRun: () => Effect.void,
})

const makeStoreRuntime = (control: JournalControl) =>
  ManagedRuntime.make(
    PaperStoreLive(config).pipe(
      Layer.provideMerge(Layer.succeed(Journal, journal(control))),
      Layer.provideMerge(PostgresClientLive(config)),
      Layer.provide(NodeServices.layer),
    ),
  )

const makeClientRuntime = () => ManagedRuntime.make(PostgresClientLive(config).pipe(Layer.provide(NodeServices.layer)))

const makeEvidenceRuntime = () => ManagedRuntime.make(EvidenceStoreLive(config).pipe(Layer.provide(NodeServices.layer)))

const accountEvent = (eventAccountId = accountId): Extract<BrokerEventInput, { readonly _tag: 'Account' }> => ({
  _tag: 'Account',
  broker: Broker.Alpaca,
  accountId: eventAccountId,
  sourceEventId: 'account-response-1',
  contentHash: hash('account-response-1'),
  occurredAt,
  observedAt,
  account: {
    schemaVersion: 'bayn.paper-account-snapshot.v1',
    accountId: eventAccountId,
    status: AccountStatus.Active,
    currency: 'USD',
    cashMicros: '1000000000',
    equityMicros: '1150000000',
    buyingPowerMicros: '2000000000',
    observedAt,
  },
})

const orderEvent = (): Extract<BrokerEventInput, { readonly _tag: 'Order' }> => ({
  _tag: 'Order',
  broker: Broker.Alpaca,
  accountId,
  sourceEventId: 'order-1:2026-07-22T15:30:00.000Z',
  contentHash: hash('order-1'),
  occurredAt,
  observedAt,
  order: {
    schemaVersion: 'bayn.paper-order.v1',
    accountId,
    brokerOrderId: 'order-1',
    clientOrderId: 'client-order-1',
    symbol: 'NVDA',
    side: OrderSide.Buy,
    orderType: OrderType.Market,
    timeInForce: TimeInForce.Day,
    quantityMicros: '3000000',
    filledQuantityMicros: '0',
    status: OrderStatus.New,
    observedAt,
  },
})

const fillEvent = (
  id: string,
  side: OrderSide,
  quantityMicros: string,
  priceMicros: string,
  eventOccurredAt = occurredAt,
  brokerTimestamp = sourceTimestamp(eventOccurredAt),
  eventAccountId = accountId,
  eventObservedAt = observedAt,
): FillEventInput => {
  const fill = {
    schemaVersion: 'bayn.paper-fill.v1' as const,
    accountId: eventAccountId,
    fillId: id,
    brokerOrderId: `order-${id}`,
    clientOrderId: `client-${id}`,
    symbol: 'NVDA',
    side,
    quantityMicros,
    priceMicros,
    feeMicros: '100',
    occurredAt: eventOccurredAt,
  }
  return {
    _tag: 'Fill',
    broker: Broker.Alpaca,
    accountId: eventAccountId,
    sourceEventId: id,
    sourceTimestamp: brokerTimestamp,
    contentHash: canonicalHashV1({
      schemaVersion: 'bayn.paper-fill-source.v1',
      fill,
      brokerTransactionTime: brokerTimestamp,
    }),
    occurredAt: eventOccurredAt,
    observedAt: eventObservedAt,
    fill,
  }
}

const positionEvent = (
  sourceHash: string,
  assetId: string,
  symbol: string,
  quantityMicros: string,
  marketValueMicros: string,
): PositionEventInput => ({
  _tag: 'Position',
  broker: Broker.Alpaca,
  accountId,
  sourceEventId: `position:${sourceHash}:${observedAt}:${assetId}`,
  contentHash: hash(`position:${assetId}`),
  occurredAt: observedAt,
  observedAt,
  position: {
    schemaVersion: 'bayn.paper-position.v1',
    accountId,
    symbol,
    quantityMicros,
    averageEntryPriceMicros: '100000000',
    marketPriceMicros: '100000000',
    marketValueMicros,
    unrealizedPnlMicros: '0',
    observedAt,
  },
})

const positionSnapshotInput = (
  sourceHash: string,
  positions: readonly PositionEventInput[],
  snapshotAccountId = accountId,
  snapshotObservedAt = observedAt,
): PositionSnapshotInput => ({
  accountId: snapshotAccountId,
  sourceHash,
  observedAt: snapshotObservedAt,
  positions,
})

describePostgres('paper accounting persistence', () => {
  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local database whose name ends in _test')
    }
  })

  beforeEach(async () => {
    const client = makeClientRuntime()
    await client.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
      }),
    )
    await client.dispose()

    const migrations = makeEvidenceRuntime()
    await migrations.runPromise(Effect.flatMap(EvidenceStore, (store) => store.check))
    await migrations.dispose()
  }, 15_000)

  test('initializes, exactly replays, and rotates one OBSERVE authority generation', async () => {
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
          const sql = yield* PgClient.PgClient
          const [databaseBefore] = yield* sql<{ observed_at: Date }>`
            SELECT clock_timestamp() AS observed_at
          `
          const first = yield* store.ensureAuthorityGeneration({
            generationHash: hash('authority-generation-a'),
            maximum: Authority.Observe,
          })
          const [databaseAfter] = yield* sql<{ observed_at: Date }>`
            SELECT clock_timestamp() AS observed_at
          `
          const [beforeReplay] = yield* sql<{ tuple_id: string; version: number }>`
            SELECT xmin::text AS tuple_id, version::integer
            FROM authority_state
          `
          const replay = yield* store.ensureAuthorityGeneration({
            generationHash: hash('authority-generation-a'),
            maximum: Authority.Observe,
          })
          const [afterReplay] = yield* sql<{ tuple_id: string; version: number }>`
            SELECT xmin::text AS tuple_id, version::integer
            FROM authority_state
          `
          const rotated = yield* store.ensureAuthorityGeneration({
            generationHash: hash('authority-generation-b'),
            maximum: Authority.Observe,
          })
          const [afterRotation] = yield* sql<{ rows: number; tuple_id: string; version: number }>`
            SELECT
              count(*) OVER ()::integer AS rows,
              xmin::text AS tuple_id,
              version::integer
            FROM authority_state
          `
          return {
            first,
            replay,
            rotated,
            databaseBefore: databaseBefore.observed_at,
            databaseAfter: databaseAfter.observed_at,
            beforeReplay,
            afterReplay,
            afterRotation,
          }
        }),
      )

      expect(result.first).toEqual({
        schemaVersion: 'bayn.paper-authority.v1',
        generationHash: hash('authority-generation-a'),
        maximum: Authority.Observe,
        effective: Authority.Observe,
        kill: KillState.Clear,
        version: 1,
        updatedAt: expect.any(String),
      })
      expect(Date.parse(result.first.updatedAt)).toBeGreaterThanOrEqual(result.databaseBefore.getTime())
      expect(Date.parse(result.first.updatedAt)).toBeLessThanOrEqual(result.databaseAfter.getTime())
      expect(result.replay).toEqual(result.first)
      expect(result.afterReplay).toEqual(result.beforeReplay)
      expect(result.rotated).toEqual({
        ...result.first,
        generationHash: hash('authority-generation-b'),
        version: 2,
        updatedAt: expect.any(String),
      })
      expect(Date.parse(result.rotated.updatedAt)).toBeGreaterThan(Date.parse(result.first.updatedAt))
      expect(result.afterRotation).toMatchObject({ rows: 1, version: 2 })
      expect(result.afterRotation.tuple_id).not.toBe(result.afterReplay.tuple_id)
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('serializes concurrent absent-row authority initialization', async () => {
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
          const states = yield* Effect.all(
            Array.from({ length: 12 }, () =>
              store.ensureAuthorityGeneration({
                generationHash: hash('concurrent-authority-generation'),
                maximum: Authority.Observe,
              }),
            ),
            { concurrency: 'unbounded' },
          )
          const sql = yield* PgClient.PgClient
          const [stored] = yield* sql<{ rows: number; version: number }>`
            SELECT count(*) OVER ()::integer AS rows, version::integer
            FROM authority_state
          `
          return { states, stored }
        }),
      )

      expect(result.states).toHaveLength(12)
      expect(result.states.every((state) => state.version === 1)).toBe(true)
      expect(new Set(result.states.map((state) => JSON.stringify(state))).size).toBe(1)
      expect(result.stored).toEqual({ rows: 1, version: 1 })
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('rotates monotonically while preserving an active kill exactly', async () => {
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
          yield* store.ensureAuthorityGeneration({
            generationHash: hash('killed-authority-generation'),
            maximum: Authority.Observe,
          })
          const sql = yield* PgClient.PgClient
          const [killed] = yield* sql<{ updated_at: Date }>`
            UPDATE authority_state
            SET
              kill_state = 'ACTIVE',
              reason = 'operator kill',
              version = version + 1,
              updated_at = clock_timestamp() + interval '1 hour'
            WHERE singleton
            RETURNING updated_at
          `
          const rotated = yield* store.ensureAuthorityGeneration({
            generationHash: hash('rotated-killed-authority-generation'),
            maximum: Authority.Observe,
          })
          return { killedAt: killed.updated_at.toISOString(), rotated }
        }),
      )

      expect(result.rotated).toEqual({
        schemaVersion: 'bayn.paper-authority.v1',
        generationHash: hash('rotated-killed-authority-generation'),
        maximum: Authority.Observe,
        effective: Authority.Observe,
        kill: KillState.Active,
        reason: 'operator kill',
        version: 3,
        updatedAt: expect.any(String),
      })
      expect(Date.parse(result.rotated.updatedAt)).toBeGreaterThan(Date.parse(result.killedAt))
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('rejects maximum conflicts, invalid input, and every PAPER request without writing', async () => {
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
          const invalid = yield* Effect.flip(
            store.ensureAuthorityGeneration({
              generationHash: 'not-a-sha256',
              maximum: Authority.Observe,
            }),
          )
          const paper = yield* Effect.flip(
            store.ensureAuthorityGeneration({
              generationHash: hash('paper-authority-generation'),
              maximum: Authority.Paper,
            }),
          )
          const sql = yield* PgClient.PgClient
          const [empty] = yield* sql<{ rows: number }>`
            SELECT count(*)::integer AS rows FROM authority_state
          `
          yield* sql`
            INSERT INTO authority_state (
              schema_version, generation_hash, maximum, effective, kill_state, reason, version, updated_at
            ) VALUES (
              'bayn.paper-authority.v1', ${hash('conflicting-authority-generation')},
              'PAPER', 'PAPER', 'CLEAR', NULL, 1, clock_timestamp()
            )
          `
          const [beforeConflict] = yield* sql<{ tuple_id: string; version: number }>`
            SELECT xmin::text AS tuple_id, version::integer FROM authority_state
          `
          const conflict = yield* Effect.flip(
            store.ensureAuthorityGeneration({
              generationHash: hash('conflicting-authority-generation'),
              maximum: Authority.Observe,
            }),
          )
          const [afterConflict] = yield* sql<{ tuple_id: string; version: number }>`
            SELECT xmin::text AS tuple_id, version::integer FROM authority_state
          `
          const rotated = yield* store.ensureAuthorityGeneration({
            generationHash: hash('observe-authority-generation'),
            maximum: Authority.Observe,
          })
          return { invalid, paper, empty, conflict, beforeConflict, afterConflict, rotated }
        }),
      )

      expect(result.invalid).toMatchObject({ operation: 'authority', failure: 'decode' })
      expect(result.paper).toMatchObject({ operation: 'authority', failure: 'invariant' })
      expect(result.empty).toEqual({ rows: 0 })
      expect(result.conflict).toMatchObject({ operation: 'authority', failure: 'conflict' })
      expect(result.afterConflict).toEqual(result.beforeConflict)
      expect(result.rotated).toMatchObject({
        generationHash: hash('observe-authority-generation'),
        maximum: Authority.Observe,
        effective: Authority.Observe,
        kill: KillState.Clear,
        version: 2,
      })
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('appends typed broker events once and rejects conflicting source reuse', async () => {
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
          const baselineBefore = yield* store.hasAccountBaseline(accountId)
          const first = yield* store.ingest(accountEvent())
          const baselineAfter = yield* store.hasAccountBaseline(accountId)
          const replay = yield* store.ingest(accountEvent())
          const order = yield* store.ingest(orderEvent())
          const conflict = yield* Effect.exit(
            store.ingest({ ...accountEvent(), contentHash: hash('conflicting-account-response') }),
          )
          const sql = yield* PgClient.PgClient
          const [counts] = yield* sql<{ accounts: number; events: number; orders: number }>`
            SELECT
              (SELECT count(*)::integer FROM broker_events) AS events,
              (SELECT count(*)::integer FROM account_snapshots) AS accounts,
              (SELECT count(*)::integer FROM orders) AS orders
          `
          return { baselineAfter, baselineBefore, first, replay, order, conflict, counts }
        }),
      )

      expect(result.first).toMatchObject({ sourceSequence: '0', deduplicated: false })
      expect(result.baselineBefore).toBe(false)
      expect(result.baselineAfter).toBe(true)
      expect(result.replay).toEqual({ ...result.first, deduplicated: true })
      expect(result.order).toMatchObject({ sourceSequence: '1', deduplicated: false })
      expect(Exit.isFailure(result.conflict)).toBe(true)
      if (Exit.isFailure(result.conflict)) expect(Cause.pretty(result.conflict.cause)).toContain('different content')
      expect(result.counts).toEqual({ events: 2, accounts: 1, orders: 1 })
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('treats cancel history as newer than submit history when broker timestamps tie', async () => {
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    const intentId = 'a'.repeat(64)
    const brokerOrderId = orderEvent().order.brokerOrderId
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
          const exactAccount = {
            ...accountEvent(),
            account: { ...accountEvent().account, equityMicros: accountEvent().account.cashMicros },
          } satisfies BrokerEventInput
          const accountReceipt = yield* store.ingest(exactAccount)
          const positionsReceipt = yield* store.ingestPositions(
            positionSnapshotInput(hash('mutation-ordering-empty-positions'), []),
          )
          const valuation = yield* store.value({
            accountEventId: accountReceipt.eventId,
            positionSnapshotId: positionsReceipt.snapshotId,
          })
          const sql = yield* PgClient.PgClient
          yield* sql`
            INSERT INTO intents (
              intent_id, schema_version, account_id, client_order_id, symbol, side,
              order_type, time_in_force, quantity_micros, notional_limit_micros,
              state, state_version, created_at, updated_at,
              strategy_name, cycle_id, decision_hash, policy_hash
            ) VALUES (
              ${intentId}, 'bayn.paper-intent.v2', ${accountId}, ${orderEvent().order.clientOrderId},
              ${orderEvent().order.symbol}, 'BUY', 'MARKET', 'DAY', 3000000, 300000000,
              'PLANNED', 1, ${occurredAt}, ${occurredAt},
              'tsmom-v1', ${'9'.repeat(64)}, ${'b'.repeat(64)}, ${'c'.repeat(64)}
            )
          `
          yield* sql`
            INSERT INTO mutation_events (
              event_id, schema_version, mutation_id, intent_id, sequence, operation, event_type,
              request_hash, consistency_delay_ms, broker_order_id, request_id,
              response_status, response_content_hash, occurred_at
            ) VALUES
              (
                ${'1'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${'3'.repeat(64)}, ${intentId}, 1,
                'SUBMIT', 'SUBMIT_STARTED', ${'4'.repeat(64)}, 1000, NULL, NULL, NULL, NULL, ${occurredAt}
              ),
              (
                ${'f'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${'3'.repeat(64)}, ${intentId}, 2,
                'SUBMIT', 'SUBMIT_ACCEPTED', ${'4'.repeat(64)}, 1000, ${brokerOrderId}, 'submit-request',
                200, ${'5'.repeat(64)}, ${occurredAt}
              ),
              (
                ${'2'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${'6'.repeat(64)}, ${intentId}, 1,
                'CANCEL', 'CANCEL_STARTED', ${'7'.repeat(64)}, 1000, ${brokerOrderId}, NULL, NULL, NULL, ${occurredAt}
              ),
              (
                ${'0'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${'6'.repeat(64)}, ${intentId}, 2,
                'CANCEL', 'CANCEL_ACCEPTED', ${'7'.repeat(64)}, 1000, ${brokerOrderId}, 'cancel-request',
                204, ${'8'.repeat(64)}, ${occurredAt}
              )
          `
          return yield* store.reconcile({
            account: exactAccount.account,
            positions: [],
            positionsObservedAt: observedAt,
            orders: [{ ...orderEvent().order, intentId }],
            ordersObservedAt: observedAt,
            fills: [],
            valuation,
            reconciledAt: '2026-07-22T15:30:03.000Z',
          })
        }),
      )

      expect(result.reconciliation.discrepancies).toHaveLength(1)
      expect(result.reconciliation.discrepancies[0]).toMatchObject({
        kind: DiscrepancyKind.Mutation,
        identity: intentId,
        observed: `UNKNOWN:${occurredAt}`,
      })
      expect(result.metrics.oldestUnknownMutationAgeMs).toBe(3_000)
      expect(result.riskContext).toMatchObject({
        tradingDate: '2026-07-22',
        authority: null,
        authorityObservedAt: null,
        unknownMutationCount: 1,
        dailyTradedNotionalMicros: '0',
        dayStartEquityMicros: accountEvent().account.cashMicros,
        peakEquityMicros: accountEvent().account.cashMicros,
      })
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('recovers the PostgreSQL-to-TigerBeetle crash window without duplicate accounting', async () => {
    const control: JournalControl = { fail: false, planHashes: [] }
    const runtime = makeStoreRuntime(control)
    const buy = fillEvent('fill-buy', OrderSide.Buy, '3000000', '100000000')
    const sell = fillEvent('fill-sell', OrderSide.Sell, '1000000', '120000000')
    const priorBuy = fillEvent(
      'fill-prior-buy',
      OrderSide.Buy,
      '1000000',
      '70000000',
      '2026-07-21T19:58:00.000Z',
      sourceTimestamp('2026-07-21T19:58:00.000Z'),
      accountId,
      '2026-07-21T19:58:01.000Z',
    )
    const priorSell = fillEvent(
      'fill-prior-sell',
      OrderSide.Sell,
      '1000000',
      '70000000',
      '2026-07-21T19:59:00.000Z',
      sourceTimestamp('2026-07-21T19:59:00.000Z'),
      accountId,
      '2026-07-21T19:59:01.000Z',
    )
    const otherAccountId = 'paper-account-2'
    const otherFill = fillEvent(
      'fill-other-account',
      OrderSide.Buy,
      '1000000',
      '70000000',
      occurredAt,
      sourceTimestamp(occurredAt),
      otherAccountId,
    )
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
          const opening = {
            ...accountEvent(),
            sourceEventId: 'opening-account',
            contentHash: hash('opening-account'),
            occurredAt: '2026-07-21T19:57:00.000Z',
            observedAt: '2026-07-21T19:57:01.000Z',
            account: {
              ...accountEvent().account,
              equityMicros: accountEvent().account.cashMicros,
              observedAt: '2026-07-21T19:57:01.000Z',
            },
          } satisfies BrokerEventInput
          const openingReceipt = yield* store.ingest(opening)
          const openingPositions = yield* store.ingestPositions(
            positionSnapshotInput(hash('opening-empty-positions'), [], accountId, '2026-07-21T19:57:01.000Z'),
          )
          yield* store.value({
            accountEventId: openingReceipt.eventId,
            positionSnapshotId: openingPositions.snapshotId,
          })

          const otherOpening = {
            ...accountEvent(otherAccountId),
            sourceEventId: 'other-opening-account',
            contentHash: hash('other-opening-account'),
            account: {
              ...accountEvent(otherAccountId).account,
              equityMicros: accountEvent(otherAccountId).account.cashMicros,
            },
          } satisfies BrokerEventInput
          const otherReceipt = yield* store.ingest(otherOpening)
          const otherPositions = yield* store.ingestPositions(
            positionSnapshotInput(hash('other-opening-empty-positions'), [], otherAccountId),
          )
          yield* store.value({
            accountEventId: otherReceipt.eventId,
            positionSnapshotId: otherPositions.snapshotId,
          })

          yield* store.account(priorBuy)
          yield* store.account(priorSell)

          const dayStartObservedAt = '2026-07-22T13:30:00.000Z'
          const dayStartAccount = {
            ...accountEvent(),
            sourceEventId: 'day-start-account',
            contentHash: hash('day-start-account'),
            occurredAt: dayStartObservedAt,
            observedAt: dayStartObservedAt,
            account: {
              ...accountEvent().account,
              cashMicros: '999999800',
              equityMicros: '999999800',
              observedAt: dayStartObservedAt,
            },
          } satisfies BrokerEventInput
          const dayStartReceipt = yield* store.ingest(dayStartAccount)
          const dayStartPositions = yield* store.ingestPositions(
            positionSnapshotInput(hash('day-start-empty-positions'), [], accountId, dayStartObservedAt),
          )
          yield* store.value({
            accountEventId: dayStartReceipt.eventId,
            positionSnapshotId: dayStartPositions.snapshotId,
          })
        }),
      )
      control.fail = true
      const failed = await runtime.runPromiseExit(Effect.flatMap(PaperStore, (store) => store.account(buy)))
      expect(Exit.isFailure(failed)).toBe(true)

      const afterFailure = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const [counts] = yield* sql<{ receipts: number; transactions: number }>`
            SELECT
              (SELECT count(*)::integer FROM accounting_transactions) AS transactions,
              (SELECT count(*)::integer FROM accounting_receipts) AS receipts
          `
          return counts
        }),
      )
      expect(afterFailure).toEqual({ transactions: 3, receipts: 2 })

      control.fail = false
      const outOfOrder = await runtime.runPromiseExit(Effect.flatMap(PaperStore, (store) => store.account(sell)))
      expect(Exit.isFailure(outOfOrder)).toBe(true)
      if (Exit.isFailure(outOfOrder)) expect(Cause.pretty(outOfOrder.cause)).toContain('earlier fill')
      expect(control.planHashes).toHaveLength(3)

      const [receipt, replay, sale, otherAccountFill] = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
          const receipt = yield* store.account(buy)
          const replay = yield* store.account(buy)
          const sale = yield* store.account(sell)
          const otherAccountFill = yield* store.account(otherFill)
          return [receipt, replay, sale, otherAccountFill] as const
        }),
      )
      expect(replay).toEqual(receipt)
      expect(sale.brokerEventId).not.toBe(receipt.brokerEventId)
      expect(otherAccountFill.brokerEventId).not.toBe(sale.brokerEventId)
      expect(new Set(control.planHashes.slice(2, 5)).size).toBe(1)

      const stored = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const transactions = yield* sql<{
            cost_basis_micros: string
            ledger_plan_hash: string
            realized_pnl_micros: string
            side: string
          }>`
            SELECT side, cost_basis_micros::text, realized_pnl_micros::text, ledger_plan_hash
            FROM accounting_transactions
            ORDER BY transaction_id
          `
          const [counts] = yield* sql<{ events: number; receipts: number; transactions: number }>`
            SELECT
              (SELECT count(*)::integer FROM broker_events) AS events,
              (SELECT count(*)::integer FROM accounting_transactions) AS transactions,
              (SELECT count(*)::integer FROM accounting_receipts) AS receipts
          `
          const immutable = yield* Effect.exit(sql`
            UPDATE accounting_transactions SET content_hash = ${'f'.repeat(64)}
          `)
          const truncate = yield* Effect.exit(sql`TRUNCATE accounting_transactions CASCADE`)
          return { transactions, counts, immutable, truncate }
        }),
      )
      expect(stored.transactions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ side: 'BUY', cost_basis_micros: '300000000', realized_pnl_micros: '0' }),
          expect.objectContaining({ side: 'SELL', cost_basis_micros: '100000000', realized_pnl_micros: '20000000' }),
        ]),
      )
      expect(stored.transactions.every((transaction) => /^[a-f0-9]{64}$/.test(transaction.ledger_plan_hash))).toBe(true)
      expect(stored.counts).toEqual({ events: 8, transactions: 5, receipts: 5 })
      expect(Exit.isFailure(stored.immutable)).toBe(true)
      expect(Exit.isFailure(stored.truncate)).toBe(true)

      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
          const currentAccount = {
            ...accountEvent(),
            sourceEventId: 'current-account',
            contentHash: hash('current-account'),
            account: {
              ...accountEvent().account,
              cashMicros: '819999600',
              equityMicros: '1019999600',
            },
          } satisfies BrokerEventInput
          const accountReceipt = yield* store.ingest(currentAccount)
          const position = positionEvent(hash('accounted-position'), 'asset-accounted', 'NVDA', '2000000', '200000000')
          const positionsReceipt = yield* store.ingestPositions(
            positionSnapshotInput(hash('accounted-position'), [position]),
          )
          const valuation = yield* store.value({
            accountEventId: accountReceipt.eventId,
            positionSnapshotId: positionsReceipt.snapshotId,
          })
          const sql = yield* PgClient.PgClient
          yield* sql`
            INSERT INTO valuations (
              valuation_id, schema_version, account_id, source_hash, cash_micros,
              long_market_value_micros, short_market_value_micros, equity_micros, as_of
            ) VALUES
              (
                ${hash('future-primary-valuation')}, 'bayn.paper-valuation.v1', ${accountId},
                ${hash('future-primary-source')}, 9000000000, 0, 0, 9000000000,
                '2026-07-22T16:00:00.000Z'
              ),
              (
                ${hash('other-account-valuation')}, 'bayn.paper-valuation.v1', ${otherAccountId},
                ${hash('other-account-source')}, 8000000000, 0, 0, 8000000000,
                '2026-07-22T15:30:30.000Z'
              )
          `
          yield* sql`
            INSERT INTO authority_state (
              schema_version, generation_hash, maximum, effective, kill_state, version, updated_at
            ) VALUES (
              'bayn.paper-authority.v1', ${hash('observe-generation')}, 'OBSERVE', 'OBSERVE', 'CLEAR', 1,
              '2026-07-22T15:30:02.000Z'
            )
          `
          const [observationBefore] = yield* sql<{ observed_at: Date }>`
            SELECT clock_timestamp() AS observed_at
          `
          const exact = yield* store.reconcile({
            account: currentAccount.account,
            positions: [position.position],
            positionsObservedAt: observedAt,
            orders: [],
            ordersObservedAt: observedAt,
            fills: [priorBuy.fill, priorSell.fill, buy.fill, sell.fill],
            valuation,
            reconciledAt: '2026-07-22T15:31:00.000Z',
          })
          const [observationAfter] = yield* sql<{ observed_at: Date }>`
            SELECT clock_timestamp() AS observed_at
          `
          return {
            exact,
            observationBefore: observationBefore.observed_at,
            observationAfter: observationAfter.observed_at,
          }
        }),
      )
      const { exact, observationBefore, observationAfter } = result
      expect(exact.reconciliation.status).toBe(ReconciliationStatus.Exact)
      expect(exact.reconciliation.discrepancies).toEqual([])
      const { authorityObservedAt, ...riskContext } = exact.riskContext
      expect(riskContext).toMatchObject({
        tradingDate: '2026-07-22',
        authority: {
          generationHash: hash('observe-generation'),
          maximum: Authority.Observe,
          effective: Authority.Observe,
          kill: KillState.Clear,
          version: 1,
          updatedAt: '2026-07-22T15:30:02.000Z',
        },
        unknownMutationCount: 0,
        dailyTradedNotionalMicros: '420000000',
        dayStartEquityMicros: '999999800',
        peakEquityMicros: '1019999600',
      })
      if (authorityObservedAt === null) throw new Error('expected a durable authority observation')
      expect(Date.parse(authorityObservedAt)).toBeGreaterThanOrEqual(observationBefore.getTime())
      expect(Date.parse(authorityObservedAt)).toBeLessThanOrEqual(observationAfter.getTime())
      expect(Date.parse(authorityObservedAt)).toBeGreaterThanOrEqual(Date.parse('2026-07-22T15:30:02.000Z'))
    } finally {
      await runtime.dispose()
    }
  }, 20_000)

  test('persists one valuation from a complete account and position observation set', async () => {
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    const positionsSourceHash = hash('positions-response-1')
    const positions = [
      positionEvent(positionsSourceHash, 'asset-1', 'NVDA', '2000000', '200000000'),
      positionEvent(positionsSourceHash, 'asset-2', 'AMD', '-500000', '-50000000'),
    ] as const
    const snapshotInput = positionSnapshotInput(positionsSourceHash, positions)
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
          const account = yield* store.ingest(accountEvent())
          const directPosition = yield* Effect.exit(store.ingest(positions[0]))
          const snapshot = yield* store.ingestPositions(snapshotInput)
          const snapshotReplay = yield* store.ingestPositions(snapshotInput)
          const conflictingSnapshot = yield* Effect.exit(
            store.ingestPositions(positionSnapshotInput(positionsSourceHash, [positions[0]])),
          )
          const input: ValuationInput = {
            accountEventId: account.eventId,
            positionSnapshotId: snapshot.snapshotId,
          }
          const valuation = yield* store.value(input)
          const replay = yield* store.value(input)
          const missingSnapshot = yield* Effect.exit(
            store.value({ ...input, positionSnapshotId: hash('missing-position-snapshot') }),
          )
          const emptySnapshot = yield* store.ingestPositions(
            positionSnapshotInput(hash('empty-positions-response'), []),
          )
          const emptyValuation = yield* store.value({
            accountEventId: account.eventId,
            positionSnapshotId: emptySnapshot.snapshotId,
          })
          const sql = yield* PgClient.PgClient
          const [counts] = yield* sql<{ position_snapshots: number; positions: number; valuations: number }>`
            SELECT
              (SELECT count(*)::integer FROM position_snapshots) AS position_snapshots,
              (SELECT count(*)::integer FROM positions) AS positions,
              (SELECT count(*)::integer FROM valuations) AS valuations
          `
          return {
            valuation,
            replay,
            snapshot,
            snapshotReplay,
            directPosition,
            conflictingSnapshot,
            missingSnapshot,
            emptyValuation,
            counts,
          }
        }),
      )

      expect(result.valuation).toMatchObject({
        accountId,
        cashMicros: '1000000000',
        longMarketValueMicros: '200000000',
        shortMarketValueMicros: '-50000000',
        equityMicros: '1150000000',
      })
      expect(result.replay).toEqual(result.valuation)
      expect(result.snapshot).toMatchObject({ eventIds: expect.any(Array), deduplicated: false })
      expect(result.snapshotReplay).toEqual({ ...result.snapshot, deduplicated: true })
      expect(Exit.isFailure(result.directPosition)).toBe(true)
      expect(Exit.isFailure(result.conflictingSnapshot)).toBe(true)
      expect(Exit.isFailure(result.missingSnapshot)).toBe(true)
      expect(result.emptyValuation).toMatchObject({
        cashMicros: '1000000000',
        longMarketValueMicros: '0',
        shortMarketValueMicros: '0',
        equityMicros: '1000000000',
      })
      expect(result.counts).toEqual({ position_snapshots: 2, positions: 2, valuations: 2 })
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('derives cost basis in broker economic order and rejects a late predecessor', async () => {
    const control: JournalControl = { fail: false, planHashes: [] }
    const runtime = makeStoreRuntime(control)
    const first = fillEvent(
      'fill-z',
      OrderSide.Buy,
      '3000000',
      '100000000',
      occurredAt,
      '2026-07-22T15:30:00.000100000Z',
    )
    const second = fillEvent(
      'fill-a',
      OrderSide.Sell,
      '1000000',
      '120000000',
      occurredAt,
      '2026-07-22T15:30:00.000900000Z',
    )
    const latePredecessor = fillEvent(
      'fill-0',
      OrderSide.Buy,
      '1000000',
      '90000000',
      occurredAt,
      '2026-07-22T15:30:00.000050000Z',
    )
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
          const arrivedFirst = yield* store.ingest(second)
          const firstReceipt = yield* store.account(first)
          yield* store.account(second)
          const replay = yield* store.account(first)
          const rejected = yield* Effect.exit(store.account(latePredecessor))
          const sql = yield* PgClient.PgClient
          const transactions = yield* sql<{
            cost_basis_micros: string
            realized_pnl_micros: string
            side: string
            source_event_id: string
            source_sequence: string
          }>`
            SELECT
              event.source_event_id,
              event.source_sequence::text,
              transaction.side,
              transaction.cost_basis_micros::text,
              transaction.realized_pnl_micros::text
            FROM accounting_transactions AS transaction
            JOIN broker_events AS event ON event.event_id = transaction.broker_event_id
            JOIN fills AS fill ON fill.event_id = event.event_id
            ORDER BY fill.source_timestamp COLLATE "C", fill.fill_id COLLATE "C"
          `
          const [counts] = yield* sql<{ events: number; transactions: number }>`
            SELECT
              (SELECT count(*)::integer FROM broker_events) AS events,
              (SELECT count(*)::integer FROM accounting_transactions) AS transactions
          `
          return { arrivedFirst, firstReceipt, replay, rejected, transactions, counts }
        }),
      )

      expect(result.arrivedFirst).toMatchObject({ sourceSequence: '0', deduplicated: false })
      expect(result.replay).toEqual(result.firstReceipt)
      expect(result.transactions).toEqual([
        {
          source_event_id: 'fill-z',
          source_sequence: '1',
          side: 'BUY',
          cost_basis_micros: '300000000',
          realized_pnl_micros: '0',
        },
        {
          source_event_id: 'fill-a',
          source_sequence: '0',
          side: 'SELL',
          cost_basis_micros: '100000000',
          realized_pnl_micros: '20000000',
        },
      ])
      expect(Exit.isFailure(result.rejected)).toBe(true)
      if (Exit.isFailure(result.rejected)) {
        expect(Cause.pretty(result.rejected.cause)).toContain('later fill was already accounted')
      }
      expect(result.counts).toEqual({ events: 2, transactions: 2 })
      expect(control.planHashes).toHaveLength(3)
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('fails closed when an economic predecessor has no accounting transaction', async () => {
    const control: JournalControl = { fail: false, planHashes: [] }
    const runtime = makeStoreRuntime(control)
    const first = fillEvent('fill-missing', OrderSide.Buy, '1000000', '100000000', '2026-07-22T15:29:59.000Z')
    const second = fillEvent('fill-later', OrderSide.Sell, '1000000', '120000000')
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
          yield* store.ingest(first)
          const rejected = yield* Effect.exit(store.account(second))
          const sql = yield* PgClient.PgClient
          const [counts] = yield* sql<{ events: number; transactions: number }>`
            SELECT
              (SELECT count(*)::integer FROM broker_events) AS events,
              (SELECT count(*)::integer FROM accounting_transactions) AS transactions
          `
          return { rejected, counts }
        }),
      )

      expect(Exit.isFailure(result.rejected)).toBe(true)
      if (Exit.isFailure(result.rejected)) {
        expect(Cause.pretty(result.rejected.cause)).toContain('earlier fill has not been posted')
      }
      expect(result.counts).toEqual({ events: 1, transactions: 0 })
      expect(control.planHashes).toHaveLength(0)
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('keeps discrepancy history in immutable reconciliation rows and never restores authority', async () => {
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    const exactAccount = {
      ...accountEvent(),
      account: { ...accountEvent().account, equityMicros: accountEvent().account.cashMicros },
    } satisfies BrokerEventInput
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
          const accountReceipt = yield* store.ingest(exactAccount)
          const positionsReceipt = yield* store.ingestPositions(
            positionSnapshotInput(hash('reconciliation-empty-positions'), []),
          )
          const valuation = yield* store.value({
            accountEventId: accountReceipt.eventId,
            positionSnapshotId: positionsReceipt.snapshotId,
          })
          const baseline = {
            account: exactAccount.account,
            positions: [],
            positionsObservedAt: observedAt,
            orders: [],
            ordersObservedAt: observedAt,
            fills: [],
            valuation,
            reconciledAt: '2026-07-22T15:30:02.000Z',
          } as const
          const exact = yield* store.reconcile(baseline)

          const sql = yield* PgClient.PgClient
          yield* sql`
            INSERT INTO authority_state (
              schema_version, generation_hash, maximum, effective, kill_state, version, updated_at
            ) VALUES (
              'bayn.paper-authority.v1', ${hash('paper-generation')}, 'PAPER', 'PAPER', 'CLEAR', 1,
              '2026-07-22T15:30:02.500Z'
            )
          `

          const mismatchInput = {
            ...baseline,
            orders: [orderEvent().order],
            reconciledAt: '2026-07-22T15:30:03.000Z',
          } as const
          const mismatch = yield* store.reconcile(mismatchInput)
          const replay = yield* store.reconcile(mismatchInput)
          const ongoing = yield* store.reconcile({
            ...mismatchInput,
            reconciledAt: '2026-07-22T15:30:04.000Z',
          })
          const resolved = yield* store.reconcile({
            ...baseline,
            reconciledAt: '2026-07-22T15:30:05.000Z',
          })

          const rows = yield* sql<{ discrepancy_count: number; status: string }>`
            SELECT status, jsonb_array_length(discrepancies)::integer AS discrepancy_count
            FROM reconciliations
            ORDER BY reconciled_at
          `
          const [authority] = yield* sql<{
            effective: string
            kill_state: string
            reason: string | null
            version: number
          }>`
            SELECT effective, kill_state, reason, version::integer
            FROM authority_state
          `
          const mutateReconciliation = yield* Effect.exit(sql`
            UPDATE reconciliations
            SET content_hash = ${hash('mutated-reconciliation')}
            WHERE reconciliation_id = ${mismatch.reconciliation.reconciliationId}
          `)
          return {
            exact,
            mismatch,
            replay,
            ongoing,
            resolved,
            rows,
            authority,
            mutateReconciliation,
          }
        }),
      )

      expect(result.exact.reconciliation.status).toBe(ReconciliationStatus.Exact)
      expect(result.mismatch.reconciliation.status).toBe(ReconciliationStatus.Discrepancy)
      const mismatchRiskContext = result.mismatch.riskContext
      const replayRiskContext = result.replay.riskContext
      if (mismatchRiskContext.authorityObservedAt === null || replayRiskContext.authorityObservedAt === null) {
        throw new Error('expected authority observations for discrepancy replay')
      }
      expect(result.replay).toEqual({
        ...result.mismatch,
        riskContext: {
          ...mismatchRiskContext,
          authorityObservedAt: replayRiskContext.authorityObservedAt,
        },
      })
      expect(Date.parse(replayRiskContext.authorityObservedAt)).toBeGreaterThanOrEqual(
        Date.parse(mismatchRiskContext.authorityObservedAt),
      )
      expect(result.mismatch.reconciliation.discrepancies).toHaveLength(1)
      expect(result.ongoing.reconciliation.discrepancies[0]).toMatchObject({
        discrepancyId: result.mismatch.reconciliation.discrepancies[0]?.discrepancyId,
        firstObservedAt: '2026-07-22T15:30:03.000Z',
        lastObservedAt: '2026-07-22T15:30:04.000Z',
      })
      expect(result.resolved.reconciliation.status).toBe(ReconciliationStatus.Exact)
      expect(result.resolved.reconciliation.discrepancies).toEqual([])
      expect(result.rows).toEqual([
        { status: ReconciliationStatus.Exact, discrepancy_count: 0 },
        { status: ReconciliationStatus.Discrepancy, discrepancy_count: 1 },
        { status: ReconciliationStatus.Discrepancy, discrepancy_count: 1 },
        { status: ReconciliationStatus.Exact, discrepancy_count: 0 },
      ])
      expect(result.authority).toEqual({
        effective: 'OBSERVE',
        kill_state: 'ACTIVE',
        reason: `reconciliation discrepancy ${result.mismatch.reconciliation.reconciliationId}`,
        version: 2,
      })
      expect(Exit.isFailure(result.mutateReconciliation)).toBe(true)
    } finally {
      await runtime.dispose()
    }
  }, 15_000)
})
