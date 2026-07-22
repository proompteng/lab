import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Cause, Effect, Exit, Layer, ManagedRuntime, Redacted } from 'effect'

import type { RuntimeConfig } from '../config'
import { operationalError } from '../errors'
import { canonicalHashV1 } from '../hash'
import { hashLedgerPlan } from '../ledger-plan'
import { Journal, type JournalService } from '../ledger'
import { AccountStatus, Authority, Broker, OrderSide, OrderStatus, OrderType, TimeInForce } from '../paper'
import type { BrokerEventInput, FillEventInput, ValuationInput } from '../broker/observations'
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

const accountEvent = (): BrokerEventInput => ({
  _tag: 'Account',
  broker: Broker.Alpaca,
  accountId,
  sourceEventId: 'account-response-1',
  contentHash: hash('account-response-1'),
  occurredAt,
  observedAt,
  account: {
    schemaVersion: 'bayn.paper-account-snapshot.v1',
    accountId,
    status: AccountStatus.Active,
    currency: 'USD',
    cashMicros: '1000000000',
    equityMicros: '1150000000',
    buyingPowerMicros: '2000000000',
    observedAt,
  },
})

const orderEvent = (): BrokerEventInput => ({
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

const fillEvent = (id: string, side: OrderSide, quantityMicros: string, priceMicros: string): FillEventInput => {
  const fill = {
    schemaVersion: 'bayn.paper-fill.v1' as const,
    accountId,
    fillId: id,
    brokerOrderId: `order-${id}`,
    clientOrderId: `client-${id}`,
    symbol: 'NVDA',
    side,
    quantityMicros,
    priceMicros,
    feeMicros: '100',
    occurredAt,
  }
  return {
    _tag: 'Fill',
    broker: Broker.Alpaca,
    accountId,
    sourceEventId: id,
    contentHash: canonicalHashV1({ schemaVersion: 'bayn.paper-fill-source.v1', fill }),
    occurredAt,
    observedAt,
    fill,
  }
}

const positionEvent = (
  sourceHash: string,
  assetId: string,
  symbol: string,
  quantityMicros: string,
  marketValueMicros: string,
): BrokerEventInput => ({
  _tag: 'Position',
  broker: Broker.Alpaca,
  accountId,
  sourceEventId: `position:${sourceHash}:${assetId}`,
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

  test('appends typed broker events once and rejects conflicting source reuse', async () => {
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
          const first = yield* store.ingest(accountEvent())
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
          return { first, replay, order, conflict, counts }
        }),
      )

      expect(result.first).toMatchObject({ sourceSequence: '0', deduplicated: false })
      expect(result.replay).toEqual({ ...result.first, deduplicated: true })
      expect(result.order).toMatchObject({ sourceSequence: '1', deduplicated: false })
      expect(Exit.isFailure(result.conflict)).toBe(true)
      if (Exit.isFailure(result.conflict)) expect(Cause.pretty(result.conflict.cause)).toContain('different content')
      expect(result.counts).toEqual({ events: 2, accounts: 1, orders: 1 })
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('recovers the PostgreSQL-to-TigerBeetle crash window without duplicate accounting', async () => {
    const control: JournalControl = { fail: true, planHashes: [] }
    const runtime = makeStoreRuntime(control)
    const buy = fillEvent('fill-buy', OrderSide.Buy, '3000000', '100000000')
    const sell = fillEvent('fill-sell', OrderSide.Sell, '1000000', '120000000')
    try {
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
      expect(afterFailure).toEqual({ transactions: 1, receipts: 0 })

      control.fail = false
      const outOfOrder = await runtime.runPromiseExit(Effect.flatMap(PaperStore, (store) => store.account(sell)))
      expect(Exit.isFailure(outOfOrder)).toBe(true)
      if (Exit.isFailure(outOfOrder)) expect(Cause.pretty(outOfOrder.cause)).toContain('earlier fill')
      expect(control.planHashes).toHaveLength(1)

      const [receipt, replay, sale] = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
          const receipt = yield* store.account(buy)
          const replay = yield* store.account(buy)
          const sale = yield* store.account(sell)
          return [receipt, replay, sale] as const
        }),
      )
      expect(replay).toEqual(receipt)
      expect(sale.brokerEventId).not.toBe(receipt.brokerEventId)
      expect(new Set(control.planHashes.slice(0, 3)).size).toBe(1)

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
      expect(stored.counts).toEqual({ events: 2, transactions: 2, receipts: 2 })
      expect(Exit.isFailure(stored.immutable)).toBe(true)
      expect(Exit.isFailure(stored.truncate)).toBe(true)
    } finally {
      await runtime.dispose()
    }
  }, 20_000)

  test('persists one valuation from a complete account and position observation set', async () => {
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    const positionsSourceHash = hash('positions-response-1')
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
          const account = yield* store.ingest(accountEvent())
          const long = yield* store.ingest(
            positionEvent(positionsSourceHash, 'asset-1', 'NVDA', '2000000', '200000000'),
          )
          const short = yield* store.ingest(
            positionEvent(positionsSourceHash, 'asset-2', 'AMD', '-500000', '-50000000'),
          )
          const input: ValuationInput = {
            accountEventId: account.eventId,
            positionEventIds: [long.eventId, short.eventId],
            positionsSourceHash,
            positionsObservedAt: observedAt,
          }
          const valuation = yield* store.value(input)
          const replay = yield* store.value(input)
          const incomplete = yield* Effect.exit(
            store.value({ ...input, positionEventIds: [...input.positionEventIds, hash('missing-position')] }),
          )
          const wrongSource = yield* Effect.exit(store.value({ ...input, positionsSourceHash: hash('wrong-source') }))
          const sql = yield* PgClient.PgClient
          const [count] = yield* sql<{ valuations: number }>`
            SELECT count(*)::integer AS valuations FROM valuations
          `
          return { valuation, replay, incomplete, wrongSource, count }
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
      expect(Exit.isFailure(result.incomplete)).toBe(true)
      expect(Exit.isFailure(result.wrongSource)).toBe(true)
      expect(result.count).toEqual({ valuations: 1 })
    } finally {
      await runtime.dispose()
    }
  }, 15_000)
})
