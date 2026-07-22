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
  OrderSide,
  OrderStatus,
  OrderType,
  ReconciliationStatus,
  TimeInForce,
} from '../paper'
import type {
  BrokerEventInput,
  FillEventInput,
  PositionEventInput,
  PositionSnapshotInput,
  ValuationInput,
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

const accountEvent = (): Extract<BrokerEventInput, { readonly _tag: 'Account' }> => ({
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
): PositionSnapshotInput => ({
  accountId,
  sourceHash,
  observedAt,
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
      await runtime.runPromise(
        Effect.flatMap(PaperStore, (store) =>
          store.ingest({
            ...accountEvent(),
            sourceEventId: 'opening-account',
            contentHash: hash('opening-account'),
            occurredAt: '2026-07-22T15:29:59.000Z',
            observedAt: '2026-07-22T15:29:59.000Z',
            account: {
              ...accountEvent().account,
              equityMicros: accountEvent().account.cashMicros,
              observedAt: '2026-07-22T15:29:59.000Z',
            },
          }),
        ),
      )
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
      expect(stored.counts).toEqual({ events: 3, transactions: 2, receipts: 2 })
      expect(Exit.isFailure(stored.immutable)).toBe(true)
      expect(Exit.isFailure(stored.truncate)).toBe(true)

      const exact = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
          const currentAccount = {
            ...accountEvent(),
            sourceEventId: 'current-account',
            contentHash: hash('current-account'),
            account: {
              ...accountEvent().account,
              cashMicros: '819999800',
              equityMicros: '1019999800',
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
          return yield* store.reconcile({
            account: currentAccount.account,
            positions: [position.position],
            positionsObservedAt: observedAt,
            orders: [],
            ordersObservedAt: observedAt,
            fills: [buy.fill, sell.fill],
            valuation,
            reconciledAt: '2026-07-22T15:31:00.000Z',
          })
        }),
      )
      expect(exact.reconciliation.status).toBe(ReconciliationStatus.Exact)
      expect(exact.reconciliation.discrepancies).toEqual([])
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
      expect(result.replay).toEqual(result.mismatch)
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
