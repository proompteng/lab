import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted, Result } from 'effect'

import {
  sourceTimestamp,
  type BrokerEventInput,
  type FillEventInput,
  type PositionEventInput,
  type PositionSnapshotInput,
} from '../broker/observations'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import type { RuntimeConfig } from '../config'
import { operationalError } from '../errors'
import { BrokerAccess, noCapitalAuthority } from '../execution/authority'
import {
  AccountStatus,
  Authority,
  Broker,
  KillState,
  OrderSide,
  OrderStatus,
  OrderType,
  ReconciliationStatus,
  TimeInForce,
} from '../execution/contracts'
import { WriterFenceLive } from '../execution/writer-fence'
import { canonicalHashV1 } from '../hash'
import { Journal, type JournalService } from '../ledger'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { config as fixtureConfig } from '../testing/runtime-fixtures'
import {
  AuthorityGenerationStore,
  AuthorityRestrictionStore,
  BrokerEventStore,
  ExecutionStoreLive,
  FillAccountingStore,
  ReconciliationStore,
  ValuationStore,
} from './execution-store'
import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'
import { accountBrokerFees } from './broker-fees'
import { readForwardPerformancePostgres } from '../forward-performance/postgres/read'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const accountId = 'paper-account-execution-store'
const observedAt = '2026-08-28T14:31:00.000Z'
const occurredAt = '2026-08-28T14:30:59.000Z'
const hash = (value: string): string => canonicalHashV1({ value })
const brokerIdentity = Result.getOrThrow(
  makeBrokerIdentity({
    schemaVersion: 'bayn.broker-identity.v2',
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    accountId,
  }),
)
const config: RuntimeConfig = {
  ...fixtureConfig,
  operationTimeoutMs: 5_000,
  execution: {
    brokerIdentity,
    brokerAccess: BrokerAccess.ReadOnly,
    capitalAuthority: noCapitalAuthority,
  },
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
}

interface JournalControl {
  failPosts: boolean
  postCount: number
}

const journal = (control: JournalControl): JournalService => ({
  post: () =>
    Effect.suspend(() => {
      control.postCount += 1
      return control.failPosts
        ? Effect.fail(
            operationalError({
              component: 'journal',
              operation: 'post',
              message: 'injected TigerBeetle failure',
            }),
          )
        : Effect.void
    }),
  verifyAccount: () => Effect.succeed(true),
  journalAndReconcile: () => Effect.die(new Error('unexpected simulation journal call')),
  check: Effect.void,
  checkRun: () => Effect.void,
})

const makeRuntime = (control: JournalControl) =>
  ManagedRuntime.make(
    ExecutionStoreLive(config).pipe(
      Layer.provideMerge(WriterFenceLive),
      Layer.provideMerge(Layer.succeed(Journal, journal(control))),
      Layer.provideMerge(PostgresClientLive(config)),
      Layer.provide(NodeServices.layer),
    ),
  )

const resetDatabase = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  yield* sql`DROP SCHEMA public CASCADE`
  yield* sql`CREATE SCHEMA public`
  yield* postgresMigrations
})

const accountEvent = (
  sourceEventId = 'account-response-1',
): Extract<BrokerEventInput, { readonly _tag: 'Account' }> => {
  const account = {
    schemaVersion: 'bayn.paper-account-snapshot.v1' as const,
    accountId,
    status: AccountStatus.Active,
    currency: 'USD' as const,
    cashMicros: '1000000000',
    equityMicros: '1150000000',
    buyingPowerMicros: '2000000000',
    observedAt,
  }
  return {
    _tag: 'Account',
    broker: Broker.Alpaca,
    accountId,
    sourceEventId,
    contentHash: canonicalHashV1({ sourceEventId, account }),
    occurredAt,
    observedAt,
    account,
  }
}

const flatAccountEvent = (): Extract<BrokerEventInput, { readonly _tag: 'Account' }> => {
  const event = accountEvent('flat-account-response')
  const account = { ...event.account, equityMicros: event.account.cashMicros }
  return { ...event, contentHash: canonicalHashV1({ sourceEventId: event.sourceEventId, account }), account }
}

const order = () => ({
  schemaVersion: 'bayn.paper-order.v1' as const,
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
})

const positionEvent = (
  sourceHash: string,
  symbol: string,
  quantityMicros: string,
  marketValueMicros: string,
): PositionEventInput => {
  const position = {
    schemaVersion: 'bayn.paper-position.v1' as const,
    accountId,
    symbol,
    quantityMicros,
    averageEntryPriceMicros: '100000000',
    marketPriceMicros: '100000000',
    marketValueMicros,
    unrealizedPnlMicros: '0',
    observedAt,
  }
  return {
    _tag: 'Position',
    broker: Broker.Alpaca,
    accountId,
    sourceEventId: `position:${sourceHash}:${observedAt}:${symbol}`,
    contentHash: canonicalHashV1({ sourceHash, position }),
    occurredAt: observedAt,
    observedAt,
    position,
  }
}

const positionSnapshot = (sourceHash: string, positions: readonly PositionEventInput[]): PositionSnapshotInput => ({
  accountId,
  sourceHash,
  observedAt,
  positions,
})

const fillEvent = (id: string, side: OrderSide, quantityMicros: string, priceMicros: string): FillEventInput => {
  const timestamp = Result.getOrThrow(sourceTimestamp(occurredAt))
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
    sourceTimestamp: timestamp,
    contentHash: canonicalHashV1({ fill, timestamp }),
    occurredAt,
    observedAt,
    fill,
  }
}

describePostgres('PostgreSQL execution persistence', () => {
  const journalControl: JournalControl = { failPosts: false, postCount: 0 }
  let runtime: ReturnType<typeof makeRuntime>

  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local database whose name ends in _test')
    }
    runtime = makeRuntime(journalControl)
  })

  beforeEach(async () => {
    journalControl.failPosts = false
    journalControl.postCount = 0
    await runtime.runPromise(resetDatabase.pipe(Effect.provide(NodeServices.layer)))
  })

  afterAll(async () => {
    await runtime?.dispose()
  })

  test('initializes, replays, and restricts one broker-bound OBSERVE generation', async () => {
    const generationHash = hash('observe-generation')
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const authority = yield* AuthorityGenerationStore
        const restriction = yield* AuthorityRestrictionStore
        if (
          authority.readOrInitializeObserveAuthority === undefined ||
          authority.readAuthorityState === undefined ||
          authority.readAuthorityGenerationLineage === undefined
        ) {
          return yield* Effect.die(new Error('live authority persistence is incomplete'))
        }
        const initial = yield* authority.readOrInitializeObserveAuthority({
          generationHash,
          maximum: Authority.Observe,
        })
        const replay = yield* authority.readOrInitializeObserveAuthority({
          generationHash,
          maximum: Authority.Observe,
        })
        const lineage = yield* authority.readAuthorityGenerationLineage(generationHash)
        yield* restriction.restrictAuthority('reconciliation discrepancy fixture', '2026-08-28T14:32:00.000Z')
        yield* restriction.restrictAuthority('reconciliation discrepancy fixture', '2026-08-28T14:33:00.000Z')
        return { initial, replay, lineage, restricted: yield* authority.readAuthorityState }
      }),
    )

    expect(result.initial).toMatchObject({
      generationHash,
      maximum: Authority.Observe,
      effective: Authority.Observe,
      kill: KillState.Clear,
      version: 1,
    })
    expect(result.replay).toEqual(result.initial)
    expect(result.lineage).toEqual({
      generationHash,
      previousGenerationHash: null,
      maximum: Authority.Observe,
    })
    expect(result.restricted).toMatchObject({
      generationHash,
      effective: Authority.Observe,
      kill: KillState.Active,
      reason: 'reconciliation discrepancy fixture',
      version: 2,
    })
  })

  test('deduplicates broker observations and derives valuation from one complete position snapshot', async () => {
    const sourceHash = hash('positions-response-1')
    const positions = [
      positionEvent(sourceHash, 'NVDA', '2000000', '200000000'),
      positionEvent(sourceHash, 'AMD', '-500000', '-50000000'),
    ] as const
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const events = yield* BrokerEventStore
        const valuations = yield* ValuationStore
        const baselineBefore = yield* valuations.hasAccountBaseline(accountId)
        const account = accountEvent()
        const accountReceipt = yield* events.ingest(account)
        const accountReplay = yield* events.ingest(account)
        const accountConflict = yield* events
          .ingest({ ...account, contentHash: hash('conflicting-account-content') })
          .pipe(Effect.flip)
        const standalonePosition = yield* events.ingest(positions[0]).pipe(Effect.flip)
        const snapshot = yield* events.ingestPositions(positionSnapshot(sourceHash, positions))
        const snapshotReplay = yield* events.ingestPositions(positionSnapshot(sourceHash, positions))
        const valuation = yield* valuations.value({
          accountEventId: accountReceipt.eventId,
          positionSnapshotId: snapshot.snapshotId,
        })
        const valuationReplay = yield* valuations.value({
          accountEventId: accountReceipt.eventId,
          positionSnapshotId: snapshot.snapshotId,
        })
        const sql = yield* PgClient.PgClient
        const [counts] = yield* sql<{ events: number; snapshots: number; valuations: number }>`
          SELECT
            (SELECT count(*)::integer FROM broker_events) AS events,
            (SELECT count(*)::integer FROM position_snapshots) AS snapshots,
            (SELECT count(*)::integer FROM valuations) AS valuations
        `
        return {
          baselineBefore,
          baselineAfter: yield* valuations.hasAccountBaseline(accountId),
          accountReceipt,
          accountReplay,
          accountConflict,
          standalonePosition,
          snapshot,
          snapshotReplay,
          valuation,
          valuationReplay,
          counts,
        }
      }),
    )

    expect(result.baselineBefore).toBeFalse()
    expect(result.baselineAfter).toBeTrue()
    expect(result.accountReplay).toEqual({ ...result.accountReceipt, deduplicated: true })
    expect(result.accountConflict).toMatchObject({ operation: 'ingest', failure: 'conflict' })
    expect(result.standalonePosition).toMatchObject({ operation: 'ingest', failure: 'invariant' })
    expect(result.snapshotReplay).toEqual({ ...result.snapshot, deduplicated: true })
    expect(result.valuation).toMatchObject({
      accountId,
      cashMicros: '1000000000',
      longMarketValueMicros: '200000000',
      shortMarketValueMicros: '-50000000',
      equityMicros: '1150000000',
    })
    expect(result.valuationReplay).toEqual(result.valuation)
    expect(result.counts).toEqual({ events: 3, snapshots: 1, valuations: 1 })
  })

  test('persists exact broker cost basis beside legacy position history', async () => {
    const sourceHash = hash('position-cost-basis-v2')
    const legacy = positionEvent(sourceHash, 'NVDA', '3000000', '303000000')
    const position = {
      ...legacy.position,
      schemaVersion: 'bayn.position.v2' as const,
      averageEntryPriceMicros: '100333333',
      costBasisMicros: '301000000',
    }
    const current: PositionEventInput = { ...legacy, position, contentHash: canonicalHashV1({ sourceHash, position }) }
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const events = yield* BrokerEventStore
        const receipt = yield* events.ingestPositions(positionSnapshot(sourceHash, [current]))
        const replay = yield* events.ingestPositions(positionSnapshot(sourceHash, [current]))
        const sql = yield* PgClient.PgClient
        const rows = yield* sql<{ schema_version: string; cost_basis_micros: string; content_hash: string }>`
        SELECT p.schema_version, p.cost_basis_micros::text, e.content_hash
        FROM positions p JOIN broker_events e ON e.event_id = p.event_id
        WHERE p.snapshot_id = ${receipt.snapshotId}
      `
        return { receipt, replay, rows }
      }),
    )
    expect(result.replay.snapshotId).toBe(result.receipt.snapshotId)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      schema_version: 'bayn.position.v2',
      cost_basis_micros: '301000000',
      content_hash: current.contentHash,
    })
  })

  test('resumes a prepared fill after a ledger failure without duplicating durable accounting', async () => {
    const fill = fillEvent('fill-buy-1', OrderSide.Buy, '3000000', '100000000')
    journalControl.failPosts = true
    const failed = await runtime.runPromise(
      Effect.flatMap(FillAccountingStore, (store) => store.account(fill)).pipe(Effect.flip),
    )

    journalControl.failPosts = false
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const accounting = yield* FillAccountingStore
        const recovered = yield* accounting.account(fill)
        const replay = yield* accounting.account(fill)
        const sql = yield* PgClient.PgClient
        const [counts] = yield* sql<{ events: number; receipts: number; transactions: number }>`
          SELECT
            (SELECT count(*)::integer FROM broker_events) AS events,
            (SELECT count(*)::integer FROM accounting_transactions) AS transactions,
            (SELECT count(*)::integer FROM accounting_receipts) AS receipts
        `
        return { recovered, replay, counts }
      }),
    )

    expect(failed).toMatchObject({ operation: 'account', failure: 'ledger' })
    expect(result.replay).toEqual(result.recovered)
    expect(result.counts).toEqual({ events: 1, transactions: 1, receipts: 1 })
    expect(journalControl.postCount).toBe(3)
  })

  test('recovers delayed broker fee posting and rejects changed or missing activity identities', async () => {
    await runtime.runPromise(Effect.flatMap(BrokerEventStore, (events) => events.ingest(flatAccountEvent())))
    const fees = ['-210000', '-10000', '-10000'].map((netAmountMicros, index) => ({
      value: { accountId, activityId: `fee-${index}`, date: '2026-08-28', netAmountMicros },
      evidence: { requestId: 'fee-request', status: 200, contentHash: hash('fee-response'), observedAt },
    }))
    const post = (items: typeof fees) =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return yield* sql.withTransaction(
          accountBrokerFees(sql, journal(journalControl), accountId, items, config.tigerBeetle),
        )
      })
    const prebaseline = fees.map((item) => ({ ...item, value: { ...item.value, date: '2026-08-27' } }))
    expect(await runtime.runPromise(post(prebaseline).pipe(Effect.flip))).toMatchObject({ failure: 'invariant' })
    expect(journalControl.postCount).toBe(0)
    journalControl.failPosts = true
    const failed = await runtime.runPromise(post(fees).pipe(Effect.flip))
    expect(failed).toMatchObject({ failure: 'ledger' })
    journalControl.failPosts = false
    const recovered = await runtime.runPromise(post(fees))
    const replay = await runtime.runPromise(post(fees))
    expect(replay).toEqual(recovered)
    expect(recovered.fees.reduce((sum, fee) => sum + BigInt(fee.netAmountMicros), 0n)).toBe(-230000n)
    expect(journalControl.postCount).toBe(4)
    const changed = fees.map((item, index) =>
      index === 0 ? { ...item, value: { ...item.value, netAmountMicros: '-220000' } } : item,
    )
    expect(await runtime.runPromise(post(changed).pipe(Effect.flip))).toMatchObject({ failure: 'invariant' })
    expect(await runtime.runPromise(post([]).pipe(Effect.flip))).toMatchObject({ failure: 'invariant' })
    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return yield* sql`SELECT count(*)::integer AS count, sum(net_amount_micros)::text AS net FROM broker_fee_accounting WHERE posted_at IS NOT NULL`
      }),
    )
    expect(rows).toEqual([{ count: 3, net: '-230000' }])
    const forward = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return yield* readForwardPerformancePostgres(sql, accountId)
      }),
    )
    expect(forward.brokerFeeRecords).toHaveLength(3)
    expect(forward.generationBrokerFeeIds).toEqual(['fee-0', 'fee-1', 'fee-2'])
    expect(forward.ambiguousBrokerFeeCount).toBe(0)
  })

  test('persists exact and discrepant reconciliation history and never clears a safety restriction implicitly', async () => {
    const generationHash = hash('reconciliation-observe-generation')
    const account = flatAccountEvent()
    const emptyPositionsHash = hash('empty-position-snapshot')
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const authority = yield* AuthorityGenerationStore
        const events = yield* BrokerEventStore
        const valuations = yield* ValuationStore
        const reconciliation = yield* ReconciliationStore
        if (authority.readOrInitializeObserveAuthority === undefined || authority.readAuthorityState === undefined) {
          return yield* Effect.die(new Error('live authority persistence is incomplete'))
        }
        yield* authority.readOrInitializeObserveAuthority({ generationHash, maximum: Authority.Observe })
        const accountReceipt = yield* events.ingest(account)
        const positionsReceipt = yield* events.ingestPositions(positionSnapshot(emptyPositionsHash, []))
        const valuation = yield* valuations.value({
          accountEventId: accountReceipt.eventId,
          positionSnapshotId: positionsReceipt.snapshotId,
        })
        const baseline = {
          account: account.account,
          positions: [],
          positionsObservedAt: observedAt,
          orders: [],
          ordersObservedAt: observedAt,
          fills: [],
          fees: [],
          valuation,
          reconciledAt: '2026-08-28T14:32:00.000Z',
        } as const
        const exact = yield* reconciliation.reconcile(baseline)
        const discrepant = yield* reconciliation.reconcile({
          ...baseline,
          orders: [order()],
          reconciledAt: '2026-08-28T14:33:00.000Z',
        })
        const resolved = yield* reconciliation.reconcile({
          ...baseline,
          reconciledAt: '2026-08-28T14:34:00.000Z',
        })
        const sql = yield* PgClient.PgClient
        const rows = yield* sql<{ status: string }>`
          SELECT status FROM reconciliations ORDER BY reconciled_at, reconciliation_id COLLATE "C"
        `
        return {
          exact,
          discrepant,
          resolved,
          bindings: yield* reconciliation.bindings(accountId),
          authority: yield* authority.readAuthorityState,
          rows,
        }
      }),
    )

    expect(result.exact.reconciliation).toMatchObject({
      accountId,
      status: ReconciliationStatus.Exact,
      discrepancies: [],
    })
    expect(result.discrepant.reconciliation.status).toBe(ReconciliationStatus.Discrepancy)
    expect(result.discrepant.reconciliation.discrepancies).toHaveLength(1)
    expect(result.resolved.reconciliation).toMatchObject({ status: ReconciliationStatus.Exact, discrepancies: [] })
    expect(result.bindings).toEqual([])
    expect(result.authority).toMatchObject({
      generationHash,
      maximum: Authority.Observe,
      effective: Authority.Observe,
      kill: KillState.Active,
      reason: `reconciliation discrepancy ${result.discrepant.reconciliation.reconciliationId}`,
      version: 2,
    })
    expect(result.rows).toEqual([
      { status: ReconciliationStatus.Exact },
      { status: ReconciliationStatus.Discrepancy },
      { status: ReconciliationStatus.Exact },
    ])
  })
})
