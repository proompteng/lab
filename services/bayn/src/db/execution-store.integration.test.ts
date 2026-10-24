import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient, PgMigrator } from '@effect/sql-pg'
import { Cause, Effect, Exit, Layer, ManagedRuntime, Redacted, Result, Schema, Tracer } from 'effect'
import type { Statement } from 'effect/sql/Statement'

import {
  sourceTimestamp,
  type BrokerEventInput,
  type FillEventInput,
  type PositionEventInput,
  type PositionSnapshotInput,
} from '../broker/observations'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import type { RuntimeConfig } from '../config/model'
import { operationalError, type OperationalError } from '../errors'
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
import { WriterFence, WriterFenceLive } from '../execution/writer-fence'
import { executionMandateFailureRestrictionPrefix } from '../execution/mandate'
import { canonicalHashV1Result } from '../hash'
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
  type ReconciliationStoreShape,
  ValuationStore,
} from './execution-store'
import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'
import cashSettlementMigration from '../../migrations/0112_broker_cash_settlements'
import { migrationLoader } from './migrations'
import { prepareFeeAccrual } from '../accounting/fee-accrual'
import { brokerFeeLedgerPlan } from '../accounting/domain'
import { hashLedgerPlanResult } from '../ledger-plan'
import type { LedgerPlan } from '../ledger-plan'
import { reportedCashMicros } from '../broker/alpaca/cash-reporting'
import { makeAccountingInterpreter } from './execution-store/accounting'
import { makeBrokerEventInterpreter } from './execution-store/broker-events'
import type { FeeActivity } from '../broker/alpaca/model'
import type { Observed } from '../simulation-reconciliation/broker-reconciler-model'
import { persistStableSnapshot } from '../simulation-reconciliation/broker-persistence'
import { AccountStatus as BrokerAccountStatus } from '../broker/alpaca/model'
import { verifyBrokerStateVersion, type BrokerSnapshot } from './reconciliation'
import { retainAccountCashReporting, readOpeningCash } from './account-baseline'
import { prepareFeeActivities, postBrokerFeePlans } from './broker-fees'
import { postCashSettlements, prepareCashSettlements, readCashSettlements } from './cash-settlements'
import { readForwardPerformancePostgres } from '../forward-performance/postgres/read'
import { makeCycleStore } from '../cycle/store/postgres'
import { makeCycleExecutionPolicyFromModel } from '../cycle/construction'
import { makeIntradayCycleDraft } from '../cycle/runner/calendar-decisions'
import { continuousMarketHours, continuousExecutionPolicy, tradingWindow } from '../market-hours'
import { defaultJevProtocolDocument } from '../jev/protocol'
import {
  cashAccrualReportingOffsetMicros,
  prepareObservedCoinFees,
  prepareObservedCashFees,
  readFeeAccruals,
} from './fee-accruals'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const accountId = 'paper-account-execution-store'
const observedAt = '2026-08-28T14:31:00.000Z'
const occurredAt = '2026-08-28T14:30:59.000Z'
const hash = (value: string): string => Result.getOrThrow(canonicalHashV1Result({ value }))
const reconcileSnapshot = (store: ReconciliationStoreShape, snapshot: BrokerSnapshot) =>
  store.reconcile(snapshot.account.accountId, Effect.succeed(snapshot)).pipe(Effect.map((result) => result.persisted))
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
  beforePost?: Effect.Effect<void, OperationalError>
}

const journal = (control: JournalControl): JournalService => ({
  post: () =>
    Effect.gen(function* () {
      control.postCount += 1
      if (control.beforePost !== undefined) yield* control.beforePost
      if (control.failPosts)
        return yield* operationalError({
          component: 'journal',
          operation: 'post',
          message: 'injected TigerBeetle failure',
        })
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
    contentHash: Result.getOrThrow(canonicalHashV1Result({ sourceEventId, account })),
    occurredAt,
    observedAt,
    account,
  }
}

const flatAccountEvent = (): Extract<BrokerEventInput, { readonly _tag: 'Account' }> => {
  const event = accountEvent('flat-account-response')
  const account = { ...event.account, equityMicros: event.account.cashMicros }
  return {
    ...event,
    contentHash: Result.getOrThrow(canonicalHashV1Result({ sourceEventId: event.sourceEventId, account })),
    account,
  }
}

const order = () => ({
  schemaVersion: 'bayn.order.v3' as const,
  accountId,
  brokerOrderId: 'order-1',
  clientOrderId: 'client-order-1',
  symbol: 'NVDA',
  side: OrderSide.Buy,
  orderType: OrderType.Market,
  timeInForce: TimeInForce.Day,
  quantityAtoms: '3000000000',
  filledQuantityAtoms: '0',
  status: OrderStatus.New,
  observedAt,
})

const orderEvent = (): Extract<BrokerEventInput, { readonly _tag: 'Order' }> => {
  const observedOrder = order()
  return {
    _tag: 'Order',
    broker: Broker.Alpaca,
    accountId,
    sourceEventId: 'order-observation-1',
    contentHash: Result.getOrThrow(canonicalHashV1Result(observedOrder)),
    occurredAt,
    observedAt,
    order: observedOrder,
  }
}

const positionEvent = (
  sourceHash: string,
  symbol: string,
  quantityAtoms: string,
  marketValueMicros: string,
): PositionEventInput => {
  const position = {
    schemaVersion: 'bayn.position.v2' as const,
    costBasisMicros: ((BigInt(quantityAtoms) * BigInt('100000000')) / 1_000_000_000n).toString(),
    accountId,
    symbol,
    quantityAtoms,
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
    contentHash: Result.getOrThrow(canonicalHashV1Result({ sourceHash, position })),
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

const fillEvent = (id: string, side: OrderSide, quantityAtoms: string, priceMicros: string): FillEventInput => {
  const timestamp = Result.getOrThrow(sourceTimestamp(occurredAt))
  const fill = {
    schemaVersion: 'bayn.fill.v2' as const,
    accountId,
    fillId: id,
    brokerOrderId: `order-${id}`,
    clientOrderId: `client-${id}`,
    symbol: 'NVDA',
    side,
    quantityAtoms,
    priceAtoms: (BigInt(priceMicros) * 1000n).toString(),
    feeMicros: '100',
    occurredAt,
  }
  return {
    _tag: 'Fill',
    broker: Broker.Alpaca,
    accountId,
    sourceEventId: id,
    sourceTimestamp: timestamp,
    contentHash: Result.getOrThrow(canonicalHashV1Result({ fill, timestamp })),
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
    delete journalControl.beforePost
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
        yield* restriction.restrictAuthority('reconciliation pass incomplete', '2026-08-28T14:31:00.000Z')
        yield* restriction.restrictAuthority(
          `reconciliation discrepancy ${hash('first-discrepancy')}`,
          '2026-08-28T14:32:00.000Z',
        )
        yield* restriction.restrictAuthority(
          `reconciliation discrepancy ${hash('first-discrepancy')}`,
          '2026-08-28T14:33:00.000Z',
        )
        yield* restriction.restrictAuthority(
          `reconciliation discrepancy ${hash('next-discrepancy')}`,
          '2026-08-28T14:33:00.000Z',
        )
        const restricted = yield* authority.readAuthorityState
        yield* restriction.restrictAuthority(
          `${executionMandateFailureRestrictionPrefix} permanent failure`,
          '2026-08-28T14:34:00.000Z',
        )
        const promoted = yield* authority.readAuthorityState
        yield* restriction.restrictAuthority('operator hold', '2026-08-28T14:35:00.000Z')
        const held = yield* authority.readAuthorityState
        yield* restriction.restrictAuthority(
          `${executionMandateFailureRestrictionPrefix} later automatic failure`,
          '2026-08-28T14:36:00.000Z',
        )
        return {
          initial,
          replay,
          lineage,
          restricted,
          promoted,
          held,
          afterLaterFailure: yield* authority.readAuthorityState,
        }
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
      reason: `reconciliation discrepancy ${hash('first-discrepancy')}`,
      version: 3,
    })
    expect(result.promoted).toMatchObject({
      effective: Authority.Observe,
      kill: KillState.Active,
      reason: `${executionMandateFailureRestrictionPrefix} permanent failure`,
      version: 4,
    })
    expect(result.held).toMatchObject({
      effective: Authority.Observe,
      kill: KillState.Active,
      reason: 'operator hold',
      version: 5,
    })
    expect(result.afterLaterFailure).toEqual(result.held)
  })

  test('deduplicates broker observations and derives valuation from one complete position snapshot', async () => {
    const sourceHash = hash('positions-response-1')
    const positions = [
      positionEvent(sourceHash, 'NVDA', '2000000000', '200000000'),
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

  test('rejects an ambient transaction before running reconciliation ingestion', async () => {
    let ingested = false
    await runtime.runPromise(
      Effect.gen(function* () {
        const reconciliation = yield* ReconciliationStore
        const fence = yield* WriterFence
        const failure = yield* Effect.flip(
          fence.transaction(
            reconciliation.reconcile(
              accountId,
              Effect.sync(() => {
                ingested = true
              }).pipe(Effect.andThen(Effect.die('ingestion must remain lazy'))),
            ),
          ),
        )
        expect(failure).toMatchObject({ operation: 'reconciliation', failure: 'invariant' })
        expect(ingested).toBe(false)
        expect(journalControl.postCount).toBe(0)
      }),
    )
  })

  test('reconciles a stable broker cut in two durable transactions, including replay', async () => {
    const commits: string[] = []
    const tracer = Tracer.make({
      span(options) {
        if (options.name === 'bayn.postgres.commit') commits.push(options.name)
        return new Tracer.NativeSpan(options)
      },
    })
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = {
          events: yield* BrokerEventStore,
          accounting: yield* FillAccountingStore,
          valuation: yield* ValuationStore,
          reconciliation: yield* ReconciliationStore,
          authorityRestriction: yield* AuthorityRestrictionStore,
        }
        const evidence = (kind: string) => ({
          requestId: `co-commit-${kind}`,
          status: 200,
          contentHash: hash(`co-commit-${kind}`),
          observedAt,
        })
        const snapshot = {
          account: {
            value: {
              id: accountId,
              status: BrokerAccountStatus.Active,
              currency: 'USD' as const,
              cashMicros: '1000000000',
              equityMicros: '1000000000',
              lastEquityMicros: '1000000000',
              buyingPowerMicros: '1000000000',
              cashReportingQuantumMicros: '1' as const,
              cryptoStatus: null,
              nonMarginableBuyingPowerMicros: null,
              accountBlocked: false,
              tradingBlocked: false,
              tradeSuspendedByUser: false,
              observedAt,
            },
            evidence: evidence('account'),
          },
          positions: { value: [], evidence: evidence('positions') },
          history: { orders: { rows: [], observedAt }, fills: [], fees: [] },
        }
        for (const replay of [false, true]) {
          commits.length = 0
          const result = yield* persistStableSnapshot(store, snapshot, Effect.succeed(observedAt)).pipe(
            Effect.provideService(Tracer.Tracer, tracer),
          )
          expect(result.report.reconciliation.status).toBe(ReconciliationStatus.Exact)
          expect(result.brokerState.positions).toEqual([])
          expect(commits, `replay=${replay}`).toHaveLength(2)
        }
        const sql = yield* PgClient.PgClient
        const [counts] = yield* sql<{ accounts: number; snapshots: number; reconciliations: number }>`
          SELECT (SELECT count(*)::integer FROM account_snapshots) AS accounts,
            (SELECT count(*)::integer FROM position_snapshots) AS snapshots,
            (SELECT count(*)::integer FROM reconciliations) AS reconciliations`
        expect(counts).toEqual({ accounts: 1, snapshots: 1, reconciliations: 1 })
      }),
    )
  })

  test('commits fee preparation with its source cut before posting and recovers it before replaying ingestion', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const reconciliation = yield* ReconciliationStore
        const events = yield* BrokerEventStore
        const valuations = yield* ValuationStore
        const sql = yield* PgClient.PgClient
        const ingest = (at: string, cashMicros: string, fees: readonly Observed<FeeActivity>[]) =>
          Effect.gen(function* () {
            const raw = flatAccountEvent()
            const account = { ...raw.account, observedAt: at, cashMicros, equityMicros: cashMicros }
            const accountReceipt = yield* events.ingest({
              ...raw,
              sourceEventId: `fee-cut:${at}`,
              contentHash: Result.getOrThrow(canonicalHashV1Result(account)),
              occurredAt: at,
              observedAt: at,
              account,
            })
            const positions = yield* events.ingestPositions({
              accountId,
              sourceHash: hash(`fee-cut:${at}`),
              observedAt: at,
              positions: [],
            })
            const valuation = yield* valuations.value({
              accountEventId: accountReceipt.eventId,
              positionSnapshotId: positions.snapshotId,
            })
            return {
              account,
              cashReportingQuantumMicros: '1' as const,
              positions: [],
              positionsObservedAt: at,
              positionSnapshotId: positions.snapshotId,
              accountEventId: accountReceipt.eventId,
              orders: [],
              ordersObservedAt: at,
              fills: [],
              fees,
              valuation,
              reconciledAt: at,
            }
          })
        yield* reconciliation.reconcile(accountId, ingest(observedAt, '1000000000', []))
        const at = '2026-08-28T14:32:00.000Z'
        const fee: Observed<FeeActivity> = {
          value: { accountId, activityId: 'co-committed-fee', date: '2026-08-28', netAmountMicros: '-10000' },
          evidence: { requestId: 'fee-read', status: 200, contentHash: hash('fee-read'), observedAt: at },
        }
        // A separately reserved connection cannot see uncommitted preparation on the writer connection.
        journalControl.beforePost = Effect.scoped(
          Effect.gen(function* () {
            const observer = yield* sql.reserve
            const rows = yield* observer.executeValues(
              `SELECT EXISTS (
              SELECT 1 FROM broker_fee_accounting f
              JOIN account_snapshots a ON a.account_id=f.account_id AND a.cash_micros=999990000
              JOIN account_cash_reporting r ON r.account_event_id=a.event_id
              WHERE f.activity_id='co-committed-fee' AND f.xmin=a.xmin AND a.xmin=r.xmin
            )`,
              [],
            )
            expect(rows).toEqual([[true]])
          }),
        ).pipe(
          Effect.mapError((cause) =>
            operationalError({
              component: 'journal',
              operation: 'post',
              message: 'independent commit witness failed',
              cause,
            }),
          ),
        )
        journalControl.failPosts = true
        const failed = yield* Effect.flip(reconciliation.reconcile(accountId, ingest(at, '999990000', [fee])))
        expect(failed).toMatchObject({ failure: 'ledger' })
        expect(journalControl.postCount).toBe(1)
        const [prepared] = yield* sql<{ pending: number; reconciliations: number }>`SELECT
          (SELECT count(*)::integer FROM broker_fee_accounting WHERE posted_at IS NULL) AS pending,
          (SELECT count(*)::integer FROM reconciliations) AS reconciliations`
        expect(prepared).toEqual({ pending: 1, reconciliations: 1 })

        journalControl.failPosts = false
        const recovered = yield* reconciliation.reconcile(
          accountId,
          Effect.sync(() => expect(journalControl.postCount).toBe(2)).pipe(
            Effect.andThen(ingest(at, '999990000', [fee])),
          ),
        )
        expect(recovered.persisted.reconciliation.status).toBe(ReconciliationStatus.Exact)
        const replay = yield* reconciliation.reconcile(accountId, ingest(at, '999990000', [fee]))
        expect(replay.persisted).toEqual(recovered.persisted)
        expect(journalControl.postCount).toBe(2)
        const [counts] = yield* sql<{ accounts: number; fees: number; acknowledgements: number }>`SELECT
          (SELECT count(*)::integer FROM account_snapshots) AS accounts,
          (SELECT count(*)::integer FROM broker_fee_accounting) AS fees,
          (SELECT count(*)::integer FROM broker_fee_posting_acknowledgements) AS acknowledgements`
        expect(counts).toEqual({ accounts: 2, fees: 1, acknowledgements: 1 })
      }),
    )
  })

  test('reuses the writer transaction for snapshot persistence and completed accounting verification', async () => {
    const fill = fillEvent('transaction-fill', OrderSide.Buy, '3000000000', '100000000')
    const sourceHash = hash('transaction-positions')
    const positions = [positionEvent(sourceHash, 'NVDA', '3000000000', '300000000')]
    const spanEvents: string[] = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        const event = span.event.bind(span)
        span.event = (name, time, attributes) => {
          spanEvents.push(name)
          event(name, time, attributes)
        }
        return span
      },
    })
    await runtime.runPromise(
      Effect.gen(function* () {
        const authority = yield* AuthorityGenerationStore
        if (authority.readOrInitializeObserveAuthority === undefined) throw new Error('Missing authority initializer')
        yield* authority.readOrInitializeObserveAuthority({
          generationHash: hash('transaction-generation'),
          maximum: Authority.Observe,
        })
        const events = yield* BrokerEventStore
        const accounting = yield* FillAccountingStore
        const valuations = yield* ValuationStore
        const reconciliation = yield* ReconciliationStore
        const fence = yield* WriterFence
        const opening = flatAccountEvent()
        const openingAt = '2026-08-28T14:00:00.000Z'
        const openingAccount = { ...opening.account, observedAt: openingAt }
        yield* events.ingest({
          ...opening,
          account: openingAccount,
          contentHash: Result.getOrThrow(canonicalHashV1Result(openingAccount)),
          observedAt: openingAt,
          occurredAt: openingAt,
        })
        yield* accounting.account(fill)
        const material = yield* fence
          .transaction(
            Effect.gen(function* () {
              const originalAccount = accountEvent()
              const account = {
                ...originalAccount,
                account: { ...originalAccount.account, cashMicros: '699999900', equityMicros: '999999900' },
              }
              const accountReceipt = yield* events.ingest(account)
              yield* reconciliation.retainCashReporting({
                account: account.account,
                accountEventId: accountReceipt.eventId,
                cashReportingQuantumMicros: '1',
              })
              const snapshot = yield* events.ingestPositions(positionSnapshot(sourceHash, positions))
              const completed = yield* events.completeHistory([fill])
              expect(completed.has(fill.sourceEventId)).toBeTrue()
              yield* accounting.verifyCompleted([fill])
              const valuation = yield* valuations.value({
                accountEventId: accountReceipt.eventId,
                positionSnapshotId: snapshot.snapshotId,
              })
              return {
                account: account.account,
                positions: positions.map((event) => event.position),
                positionsObservedAt: observedAt,
                orders: [],
                ordersObservedAt: observedAt,
                fills: [fill.fill],
                fees: [],
                cashReportingQuantumMicros: '1' as const,
                positionSnapshotId: snapshot.snapshotId,
                accountEventId: accountReceipt.eventId,
                valuation,
                reconciledAt: '2026-08-28T14:32:00.000Z',
              }
            }),
          )
          .pipe(Effect.provideService(Tracer.Tracer, tracer))
        const reconciled = yield* reconcileSnapshot(reconciliation, material).pipe(
          Effect.provideService(Tracer.Tracer, tracer),
        )
        expect(reconciled.reconciliation.status).toBe(ReconciliationStatus.Exact)
        const sql = yield* PgClient.PgClient
        const [reporting] = yield* sql<{ same_transaction: boolean }>`
          SELECT a.xmin=r.xmin AS same_transaction FROM account_snapshots a
          JOIN account_cash_reporting r ON r.account_event_id=a.event_id WHERE a.event_id=${material.accountEventId}`
        expect(reporting?.same_transaction).toBe(true)
        yield* reconciliation.retainCashReporting(material)
        for (const changed of [
          { ...material, cashReportingQuantumMicros: '10000' as const },
          { ...material, account: { ...material.account, accountId: 'foreign-account' } },
          { ...material, account: { ...material.account, cashMicros: '1' } },
          { ...material, account: { ...material.account, observedAt: '2026-08-28T14:30:00.000Z' } },
        ]) {
          expect(Exit.isFailure(yield* Effect.exit(reconciliation.retainCashReporting(changed)))).toBe(true)
        }
        yield* reconciliation.retainCashReporting(material)
      }),
    )
    expect(spanEvents.filter((name) => name === 'db.transaction.savepoint')).toHaveLength(0)
  })

  for (const failure of ['typed', 'defect', 'interruption'] as const) {
    test(`rolls back co-committed reconciliation preparation after ${failure} failure`, async () => {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const events = yield* BrokerEventStore
          const valuations = yield* ValuationStore
          const reconciliation = yield* ReconciliationStore
          const exit = yield* reconciliation
            .reconcile(
              accountId,
              Effect.gen(function* () {
                const accountReceipt = yield* events.ingest(flatAccountEvent())
                yield* reconciliation.retainCashReporting({
                  account: flatAccountEvent().account,
                  accountEventId: accountReceipt.eventId,
                  cashReportingQuantumMicros: '1',
                })
                const snapshot = yield* events.ingestPositions(positionSnapshot(hash('rollback-positions'), []))
                yield* valuations.value({
                  accountEventId: accountReceipt.eventId,
                  positionSnapshotId: snapshot.snapshotId,
                })
                return yield* failure === 'typed'
                  ? Effect.fail('injected failure')
                  : failure === 'defect'
                    ? Effect.die('injected defect')
                    : Effect.interrupt
              }),
            )
            .pipe(Effect.exit)
          const sql = yield* PgClient.PgClient
          const [counts] = yield* sql<{
            events: number
            snapshots: number
            valuations: number
            reporting: number
          }>`SELECT (SELECT count(*)::integer FROM broker_events) AS events, (SELECT count(*)::integer FROM position_snapshots) AS snapshots, (SELECT count(*)::integer FROM valuations) AS valuations, (SELECT count(*)::integer FROM account_cash_reporting) AS reporting`
          const recovered = yield* events.ingest(flatAccountEvent())
          return { exit, counts, recovered }
        }),
      )
      expect(Exit.isFailure(result.exit)).toBeTrue()
      expect(result.counts).toEqual({ events: 0, snapshots: 0, valuations: 0, reporting: 0 })
      expect(result.recovered.deduplicated).toBeFalse()
    })
  }

  test('persists exact broker cost basis and rejects new cost-less position writes', async () => {
    const sourceHash = hash('position-cost-basis-v2')
    const legacy = positionEvent(sourceHash, 'NVDA', '3000000000', '303000000')
    const position = {
      ...legacy.position,
      schemaVersion: 'bayn.position.v2' as const,
      averageEntryPriceMicros: '100333333',
      costBasisMicros: '301000000',
    }
    const current: PositionEventInput = {
      ...legacy,
      position,
      contentHash: Result.getOrThrow(canonicalHashV1Result({ sourceHash, position })),
    }
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
        for (const schema of ['bayn.paper-position.v1', 'bayn.position.v2']) {
          const rejected = yield* sql`
            INSERT INTO positions (event_id, account_id, schema_version, symbol, quantity_atoms,
              average_entry_price_micros, market_price_micros, market_value_micros,
              unrealized_pnl_micros, snapshot_id, cost_basis_micros)
            SELECT ${hash(schema)}, account_id, ${schema}, symbol, quantity_atoms,
              average_entry_price_micros, market_price_micros, market_value_micros,
              unrealized_pnl_micros, snapshot_id, NULL
            FROM positions WHERE snapshot_id = ${receipt.snapshotId}
          `.pipe(Effect.exit)
          expect(Exit.isFailure(rejected)).toBe(true)
          if (Exit.isFailure(rejected)) expect(Cause.pretty(rejected.cause)).toContain('positions_schema_version_check')
        }
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
    const fill = fillEvent('fill-buy-1', OrderSide.Buy, '3000000000', '100000000')
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

  test.each([
    { priceMicros: '100004900', rounding: '4900' },
    { priceMicros: '100005100', rounding: '-4900' },
  ])(
    'cash settlement recovers its $rounding posting without rewriting the precise fill',
    async ({ priceMicros, rounding }) => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const events = yield* BrokerEventStore
          const accounting = yield* FillAccountingStore
          const base = fillEvent('rounded-crypto-buy', OrderSide.Buy, '1000000000', priceMicros)
          const fill = { ...base.fill, symbol: 'BTC/USD', feeMicros: '0' }
          yield* accounting.account({ ...base, fill, contentHash: Result.getOrThrow(canonicalHashV1Result(fill)) })
          const original =
            yield* sql`SELECT transaction_id,content_hash,cash_delta_micros::text AS cash_delta_micros,ledger_plan_hash
        FROM accounting_transactions`
          expect(original[0]?.['cash_delta_micros']).toBe((-BigInt(priceMicros)).toString())
          const account = flatAccountEvent()
          const receipt = yield* events.ingest(account)
          const positions = yield* events.ingestPositions(positionSnapshot(hash('rounded-crypto-flat'), []))
          const valuation = yield* (yield* ValuationStore).value({
            accountEventId: receipt.eventId,
            positionSnapshotId: positions.snapshotId,
          })
          const snapshot: BrokerSnapshot = {
            account: account.account,
            accountEventId: receipt.eventId,
            cashReportingQuantumMicros: '10000',
            positions: [],
            positionsObservedAt: observedAt,
            positionSnapshotId: positions.snapshotId,
            orders: [],
            ordersObservedAt: observedAt,
            fills: [fill],
            fees: [],
            valuation,
            reconciledAt: observedAt,
          }
          yield* retainAccountCashReporting(sql, snapshot)
          yield* sql.withTransaction(prepareCashSettlements(sql, snapshot, config.tigerBeetle))
          yield* sql.withTransaction(prepareCashSettlements(sql, snapshot, config.tigerBeetle))
          const prepared = yield* readCashSettlements(sql, accountId)
          expect(prepared).toHaveLength(1)
          expect(prepared[0]).toMatchObject({ rounding_delta_micros: rounding, posted: false })
          journalControl.failPosts = true
          const failed = yield* postCashSettlements(sql, journal(journalControl), accountId, config.tigerBeetle).pipe(
            Effect.flip,
          )
          expect(failed).toMatchObject({ failure: 'ledger', cause: { message: 'injected TigerBeetle failure' } })
          expect(yield* readCashSettlements(sql, accountId)).toEqual(prepared)
          journalControl.failPosts = false
          const completedPlans: LedgerPlan[] = []
          const controlledJournal = {
            ...journal(journalControl),
            post: (plan: LedgerPlan) =>
              journal(journalControl)
                .post(plan)
                .pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      completedPlans.push(plan)
                    }),
                  ),
                ),
          }
          const interrupted = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* postCashSettlements(sql, controlledJournal, accountId, config.tigerBeetle)
                return yield* Effect.fail('database acknowledgement rolled back after ledger posting')
              }),
            )
            .pipe(Effect.result)
          expect(Result.isFailure(interrupted)).toBe(true)
          expect(yield* readCashSettlements(sql, accountId)).toEqual(prepared)
          const recovered = yield* postCashSettlements(sql, controlledJournal, accountId, config.tigerBeetle)
          const replay = yield* postCashSettlements(sql, controlledJournal, accountId, config.tigerBeetle)
          expect(replay).toEqual(recovered)
          expect(recovered.cashDeltaMicros).toBe(rounding)
          expect(journalControl.postCount).toBe(4)
          expect(completedPlans).toHaveLength(2)
          expect(completedPlans[1]).toEqual(completedPlans[0])
          expect(
            yield* sql`SELECT transaction_id,content_hash,cash_delta_micros::text AS cash_delta_micros,ledger_plan_hash
        FROM accounting_transactions`,
          ).toEqual(original)
          const immutable = yield* sql
            .withTransaction(sql`UPDATE broker_cash_settlements SET rounding_delta_micros=1`)
            .pipe(Effect.result)
          expect(Result.isFailure(immutable)).toBe(true)
          const deleted = yield* sql.withTransaction(sql`DELETE FROM broker_cash_settlements`).pipe(Effect.result)
          expect(Result.isFailure(deleted)).toBe(true)
          const reposted = yield* sql
            .withTransaction(sql`UPDATE broker_cash_settlements SET posted_at=clock_timestamp()`)
            .pipe(Effect.result)
          expect(Result.isFailure(reposted)).toBe(true)
        }),
      )
    },
  )

  test('cash settlement keeps a database failure in the query error channel', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const result = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`DROP TABLE broker_cash_settlements`
              yield* readCashSettlements(sql, accountId)
            }),
          )
          .pipe(Effect.flip)
        expect(result).toMatchObject({ failure: 'query', cause: { _tag: 'SqlError' } })
      }),
    )
  })

  test('batches completed broker history while retaining conflicts and incomplete fill recovery', async () => {
    const observedOrder = orderEvent()
    const accountedFill = fillEvent('fill-accounted', OrderSide.Buy, '3000000000', '100000000')
    const preparedFill = fillEvent('fill-pending', OrderSide.Buy, '1000000000', '101000000')
    const unaccountedFill = fillEvent('fill-unaccounted', OrderSide.Buy, '1000000000', '101000000')
    const newOrder = { ...observedOrder, sourceEventId: 'order-observation-2' }

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const events = yield* BrokerEventStore
        const accounting = yield* FillAccountingStore
        yield* events.ingest(observedOrder)
        yield* accounting.account(accountedFill)
        yield* events.ingest(unaccountedFill)
        journalControl.failPosts = true
        const postingFailure = yield* accounting.account(preparedFill).pipe(Effect.flip)
        journalControl.failPosts = false

        const history = [observedOrder, accountedFill, preparedFill, unaccountedFill, newOrder]
        const completed = yield* events.completeHistory(history)
        yield* accounting.verifyCompleted([accountedFill])
        const accountingMismatch = yield* accounting
          .verifyCompleted([{ ...accountedFill, fill: { ...accountedFill.fill, quantityAtoms: '2000000000' } }])
          .pipe(Effect.flip)
        yield* accounting.account(preparedFill)
        const completedAfterRecovery = yield* events.completeHistory(history)
        yield* accounting.verifyCompleted([accountedFill, preparedFill])
        const conflict = yield* events
          .completeHistory([{ ...observedOrder, contentHash: hash('changed-order-content') }])
          .pipe(Effect.flip)
        return { completed, completedAfterRecovery, postingFailure, accountingMismatch, conflict }
      }),
    )

    expect([...result.completed].sort()).toEqual([accountedFill.sourceEventId, observedOrder.sourceEventId])
    expect([...result.completedAfterRecovery].sort()).toEqual([
      accountedFill.sourceEventId,
      preparedFill.sourceEventId,
      observedOrder.sourceEventId,
    ])
    expect(result.postingFailure).toMatchObject({ operation: 'account', failure: 'ledger' })
    expect(result.accountingMismatch).toMatchObject({ operation: 'account', failure: 'conflict' })
    expect(result.conflict).toMatchObject({ operation: 'ingest', failure: 'conflict' })
  })

  test('completed fill verification reads the inventory fee sources once per history', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const fence = yield* WriterFence
        const accounting = yield* FillAccountingStore
        yield* (yield* BrokerEventStore).ingest(flatAccountEvent())
        const inputs = Array.from({ length: 8 }, (_, index) => {
          const event = fillEvent(`completed-history-${index}`, OrderSide.Buy, '1000000000', '100000000')
          const fill = { ...event.fill, symbol: 'SOL/USD', feeMicros: '0' }
          return { ...event, fill, contentHash: Result.getOrThrow(canonicalHashV1Result(fill)) }
        })
        for (const input of inputs) yield* accounting.account(input)
        const lookups: Statement<Record<string, unknown>>[] = []
        const monitored = new Proxy(sql, {
          apply(target, receiver, argumentsList) {
            const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
            if (statement.compile()[0].includes('AS prior_quantity_atoms')) lookups.push(statement)
            return statement
          },
        })
        const verifier = makeAccountingInterpreter(
          monitored,
          journal(journalControl),
          config,
          makeBrokerEventInterpreter(monitored, fence),
          fence,
        )
        yield* verifier.verifyCompleted(inputs)
        expect(lookups).toHaveLength(1)
        const lookup = lookups[0]
        if (lookup === undefined) throw new Error('Completed accounting verification did not issue a query')
        const [query, parameters] = lookup.compile()
        const explanation = yield* sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, parameters)
        const plans = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ 'QUERY PLAN': Schema.Array(Schema.Struct({ Plan: Schema.Unknown })) })),
        )(explanation)
        const feeSourceReads = (node: unknown): number => {
          if (node === null || typeof node !== 'object') return 0
          const reads =
            'Relation Name' in node &&
            node['Relation Name'] === 'broker_fee_accounting' &&
            'Actual Loops' in node &&
            typeof node['Actual Loops'] === 'number'
              ? node['Actual Loops']
              : 0
          return (
            reads +
            ('Plans' in node && Array.isArray(node.Plans)
              ? node.Plans.reduce((sum: number, child: unknown) => sum + feeSourceReads(child), 0)
              : 0)
          )
        }
        expect(feeSourceReads(plans[0]?.['QUERY PLAN'][0]?.Plan)).toBe(1)
        expect(journalControl.postCount).toBe(inputs.length)
      }),
    )
  })

  test('opening cash and fee baselines avoid scanning account history', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const authority = yield* AuthorityGenerationStore
        const events = yield* BrokerEventStore
        const valuations = yield* ValuationStore
        const sql = yield* PgClient.PgClient
        const fence = yield* WriterFence
        if (authority.readOrInitializeObserveAuthority === undefined)
          throw new Error('Missing native authority initializer')
        yield* authority.readOrInitializeObserveAuthority({
          generationHash: hash('opening-history-generation'),
          maximum: Authority.Observe,
        })
        const account = flatAccountEvent()
        const accountReceipt = yield* events.ingest(account)
        const positionsReceipt = yield* events.ingestPositions(positionSnapshot(hash('opening-empty-positions'), []))
        const valuation = yield* valuations.value({
          accountEventId: accountReceipt.eventId,
          positionSnapshotId: positionsReceipt.snapshotId,
        })
        yield* fence.transaction(
          Effect.gen(function* () {
            yield* sql`CREATE TEMP TABLE broker_events (LIKE public.broker_events INCLUDING ALL) ON COMMIT DROP`
            yield* sql`CREATE TRIGGER broker_event_projection_hash BEFORE INSERT ON pg_temp.broker_events FOR EACH ROW EXECUTE FUNCTION initialize_broker_event_projection_hash()`
            yield* sql`CREATE TEMP TABLE account_snapshots (LIKE public.account_snapshots INCLUDING ALL) ON COMMIT DROP`
            yield* sql`INSERT INTO broker_events
              (event_id, schema_version, content_hash, event_kind, broker, account_id, source_event_id,
                source_sequence, occurred_at, observed_at)
              SELECT md5(n::text) || md5('event-' || n::text), 'bayn.paper-broker-event.v1',
                md5(n::text) || md5('content-' || n::text), CASE WHEN n = 0 THEN 'ORDER' ELSE 'ACCOUNT' END,
                'ALPACA', CASE WHEN n < 8192 THEN ${accountId} ELSE 'foreign-account' END,
                'history-' || n, n, '2026-08-27T14:30:59.000Z'::timestamptz,
                CASE WHEN n < 2 OR n >= 8192 THEN '2026-08-29T14:31:00.000Z'::timestamptz
                  WHEN n = 2 THEN ${observedAt}::timestamptz
                  ELSE '2026-08-27T14:31:00.000Z'::timestamptz END
              FROM generate_series(0, 16383) AS n`
            yield* sql`INSERT INTO account_snapshots
              (event_id, account_id, schema_version, status, currency, cash_micros, equity_micros, buying_power_micros)
              SELECT event_id, account_id, 'bayn.paper-account-snapshot.v1', 'ACTIVE', 'USD',
                CASE WHEN source_sequence = 2 THEN 1000000000 ELSE 999000000 END,
                CASE WHEN source_sequence = 2 THEN 1000000000 ELSE 999000000 END, 2000000000
              FROM broker_events WHERE event_kind = 'ACCOUNT' AND source_sequence <> 1`
            yield* sql`ANALYZE broker_events`
            yield* sql`ANALYZE account_snapshots`
            const lookups: Statement<Record<string, unknown>>[] = []
            const monitored = new Proxy(sql, {
              apply(target, receiver, argumentsList) {
                const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
                const query = statement.compile()[0]
                if (query.includes('FROM account_snapshots') && query.includes('source_sequence'))
                  lookups.push(statement)
                return statement
              },
            })
            const fee = {
              value: { accountId, activityId: 'opening-fee', date: '2026-08-28', netAmountMicros: '0' },
              evidence: { requestId: 'opening-fee-request', status: 200, contentHash: hash('opening-fee'), observedAt },
            }
            yield* prepareFeeActivities(monitored, accountId, [fee], config.tigerBeetle)
            yield* prepareObservedCashFees(
              monitored,
              {
                account: account.account,
                accountEventId: accountReceipt.eventId,
                cashReportingQuantumMicros: '1',
                positions: [],
                positionSnapshotId: positionsReceipt.snapshotId,
                positionsObservedAt: observedAt,
                orders: [],
                ordersObservedAt: observedAt,
                fills: [],
                fees: [fee],
                valuation,
                reconciledAt: observedAt,
              },
              config.tigerBeetle,
            )
            const opening = yield* readOpeningCash(monitored, accountId)
            expect(opening).toEqual({ cash_micros: '1000000000', observed_at: observedAt })
            expect(lookups).toHaveLength(3)
            for (const lookup of lookups) {
              const [query, parameters] = lookup.compile()
              const explanation = yield* sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, parameters)
              const plans = yield* Schema.decodeUnknownEffect(
                Schema.Array(
                  Schema.Struct({
                    'QUERY PLAN': Schema.Array(Schema.Struct({ Plan: Schema.Record(Schema.String, Schema.Unknown) })),
                  }),
                ),
              )(explanation)
              const root = plans[0]?.['QUERY PLAN'][0]?.Plan
              if (root === undefined) throw new Error('PostgreSQL did not return the opening query plan')
              const touchedBlocks = [
                'Shared Hit Blocks',
                'Shared Read Blocks',
                'Local Hit Blocks',
                'Local Read Blocks',
              ].reduce((sum, key) => sum + Number(root[key] ?? 0), 0)
              expect(touchedBlocks).toBeLessThan(32)
            }
            const prebaseline = { ...fee, value: { ...fee.value, date: '2026-08-27' } }
            expect(
              yield* prepareFeeActivities(sql, accountId, [prebaseline], config.tigerBeetle).pipe(Effect.flip),
            ).toMatchObject({ failure: 'invariant', message: expect.stringContaining('predates') })
          }),
        )
      }),
    )
    expect(journalControl.postCount).toBe(0)
  })

  test('coin fees survive a ledger retry and a fractional close without changing cash or replaying inventory', async () => {
    const buyBase = fillEvent('crypto-buy', OrderSide.Buy, '1000000000', '100000000')
    const buyFill = { ...buyBase.fill, symbol: 'SOL/USD', feeMicros: '0' }
    const buy = { ...buyBase, fill: buyFill, contentHash: Result.getOrThrow(canonicalHashV1Result(buyFill)) }
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* (yield* BrokerEventStore).ingest(flatAccountEvent())
        yield* (yield* FillAccountingStore).account(buy)
      }),
    )
    const fees = ['coin-fee-1', 'coin-fee-2'].map((activityId) => ({
      value: {
        accountId,
        activityId,
        date: '2026-08-28',
        netAmountMicros: '0',
        coinDebit: { symbol: 'SOL/USD', quantityAtoms: '2000000', priceAtoms: '100000000000' },
      },
      evidence: { requestId: 'coin-fees', status: 200, contentHash: hash('coin-fees'), observedAt },
    }))
    const post = (items: typeof fees) =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const fence = yield* WriterFence
        yield* fence.transaction(prepareFeeActivities(sql, accountId, items, config.tigerBeetle))
        return yield* fence.transaction(postBrokerFeePlans(sql, journal(journalControl), accountId, config.tigerBeetle))
      })
    journalControl.failPosts = true
    expect(await runtime.runPromise(post(fees).pipe(Effect.flip))).toMatchObject({ failure: 'ledger' })
    journalControl.failPosts = false
    const posted = await runtime.runPromise(post(fees))
    const posts = journalControl.postCount
    expect(await runtime.runPromise(post(fees))).toEqual(posted)
    expect(journalControl.postCount).toBe(posts)
    expect(posted.plans.flatMap((plan) => plan.transfers).map((transfer) => transfer.amount)).toEqual([
      200000n,
      200000n,
    ])
    const secondBuyAt = '2026-08-28T14:31:01.000Z'
    const secondBase = fillEvent('crypto-buy-2', OrderSide.Buy, '1000000000', '200000000')
    const secondFill = { ...secondBase.fill, symbol: 'SOL/USD', feeMicros: '0', occurredAt: secondBuyAt }
    const secondBuy = {
      ...secondBase,
      fill: secondFill,
      contentHash: Result.getOrThrow(canonicalHashV1Result(secondFill)),
      occurredAt: secondBuyAt,
      observedAt: secondBuyAt,
      sourceTimestamp: Result.getOrThrow(sourceTimestamp(secondBuyAt)),
    }
    const sellAt = '2026-08-28T14:31:02.000Z'
    const sellBase = fillEvent('crypto-sell', OrderSide.Sell, '1996000000', '201000000')
    const sellFill = { ...sellBase.fill, symbol: 'SOL/USD', feeMicros: '0', occurredAt: sellAt }
    const sell = {
      ...sellBase,
      fill: sellFill,
      contentHash: Result.getOrThrow(canonicalHashV1Result(sellFill)),
      occurredAt: sellAt,
      observedAt: sellAt,
      sourceTimestamp: Result.getOrThrow(sourceTimestamp(sellAt)),
    }
    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const accounting = yield* FillAccountingStore
        yield* accounting.account(secondBuy)
        yield* accounting.account(sell)
        yield* accounting.verifyCompleted([buy, secondBuy, sell])
        const sql = yield* PgClient.PgClient
        return yield* sql`SELECT
        (sum(quantity_delta_atoms) - (SELECT sum((data->'coinDebit'->>'quantityAtoms')::numeric) FROM broker_fee_accounting))::text AS quantity,
        (sum(cost_basis_delta_micros) - (SELECT sum(coin_cost_basis_micros) FROM broker_fee_accounting))::text AS cost,
        (SELECT sum(net_amount_micros)::text FROM broker_fee_accounting) AS fee_cash,
        (SELECT realized_pnl_micros::text FROM accounting_transactions WHERE side = 'SELL') AS realized
        FROM accounting_transactions`
      }),
    )
    expect(rows).toEqual([{ quantity: '0', cost: '0', fee_cash: '0', realized: '101596000' }])
    expect(await runtime.runPromise(post([]).pipe(Effect.flip))).toMatchObject({ failure: 'invariant' })
  })

  const settlementScenarios = ['crypto', 'cross-date', 'regulatory', 'retained', 'partial', 'overreleased'] as const
  test.each([...settlementScenarios])('crypto fee settlement: %s', async (scenario) => {
    const historical = scenario === 'retained'
    const overreleased = scenario === 'overreleased'
    const hasRegulatory = scenario !== 'crypto' && scenario !== 'cross-date'
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        if (historical || overreleased) {
          yield* sql`DROP SCHEMA public CASCADE`
          yield* sql`CREATE SCHEMA public`
          yield* PgMigrator.run({
            loader: migrationLoader.pipe(Effect.map((rows) => rows.filter(([id]) => id < (overreleased ? 106 : 105)))),
            table: 'schema_migrations',
          }).pipe(Effect.provide(NodeServices.layer))
          // Keep the historical fee migration under test while satisfying the current cash store contract.
          yield* sql.withTransaction(cashSettlementMigration)
        }
        const fence = yield* WriterFence
        const postRetainedAccrual = (kind: 'COIN' | 'CASH') =>
          Effect.gen(function* () {
            const [row] = yield* sql<{
              accrual_id: string
              data: unknown
              ledger_plan_hash: string
            }>`SELECT accrual_id,data,ledger_plan_hash FROM broker_fee_accruals WHERE kind=${kind}`
            if (row === undefined) throw new Error('Missing retained accrual')
            const verified = Result.getOrThrow(prepareFeeAccrual(row.data, config.tigerBeetle.ledger))
            expect(Result.getOrThrow(hashLedgerPlanResult(verified.plan))).toBe(row.ledger_plan_hash)
            yield* journal(journalControl).post(verified.plan)
            yield* sql`UPDATE broker_fee_accruals SET posted_at=${verified.data.observedAt} WHERE accrual_id=${row.accrual_id}`
          })
        const events = yield* BrokerEventStore
        const accounting = yield* FillAccountingStore
        const valuations = yield* ValuationStore
        const authority = yield* AuthorityGenerationStore
        if (authority.readOrInitializeObserveAuthority === undefined) throw new Error('Missing authority initializer')
        const generationHash = hash('settlement-generation')
        yield* authority.readOrInitializeObserveAuthority({ generationHash, maximum: Authority.Observe })
        const start = '2026-08-28T14:30:00.000Z'
        const window = Result.getOrThrow(
          tradingWindow(continuousMarketHours, start, { ...continuousExecutionPolicy, sessionEntryCutoffMs: 0 }),
        )
        if (window === null) throw new Error('Missing continuous window')
        const policy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(defaultJevProtocolDocument.executionModel))
        if (policy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3')
          throw new Error('Unexpected execution policy')
        const draft = Result.getOrThrow(
          makeIntradayCycleDraft(
            {
              cycleBindingId: hash('settlement-cycle'),
              strategyName: 'jev',
              strategyProtocolHash: hash('settlement-protocol'),
              accountId,
              executionPolicy: policy,
            },
            continuousMarketHours,
            window,
          ),
        )
        let cycleId = draft.identity.cycleId
        if (historical || overreleased) {
          const calendar = {
            executionCalendarSchemaVersion: 'bayn.continuous-market-hours.v1',
            executionCalendarSource: 'alpaca-crypto-us',
            executionSessionDate: '2026-08-28',
            executionOpenAt: start,
            executionCloseAt: '2026-08-28T14:49:00.000Z',
          }
          const identity = {
            ...draft.identity,
            executionCalendarHash: Result.getOrThrow(canonicalHashV1Result(calendar)),
          }
          const { cycleId: _currentCycleId, ...material } = identity
          cycleId = Result.getOrThrow(canonicalHashV1Result(material))
          // Seed the immutable 19-minute format required by the pre-144 fee fixtures.
          yield* sql`INSERT INTO autonomous_cycles ${sql.insert({
            cycle_id: cycleId,
            schema_version: 'bayn.autonomous-cycle.v4',
            identity_schema_version: identity.schemaVersion,
            strategy_name: identity.strategyName,
            qualification_run_id: identity.qualificationRunId,
            strategy_protocol_hash: identity.strategyProtocolHash,
            account_id: accountId,
            entry_attempt_ordinal: identity.entryAttemptOrdinal,
            execution_policy_schema_version: policy.schemaVersion,
            execution_policy_hash: policy.executionPolicyHash,
            strategy_execution_model_hash: policy.strategyExecutionModelHash,
            submission_window_ms: 60_000,
            warmup_after_open_ms: policy.warmupAfterOpenMs,
            submission_cutoff_before_close_ms: policy.submissionCutoffBeforeCloseMs,
            window_schema_version: 'bayn.autonomous-cycle-window.v3',
            execution_calendar_schema_version: calendar.executionCalendarSchemaVersion,
            execution_calendar_source: calendar.executionCalendarSource,
            execution_calendar_hash: identity.executionCalendarHash,
            execution_session_date: calendar.executionSessionDate,
            submission_open_at: start,
            execution_open_at: start,
            execution_close_at: calendar.executionCloseAt,
            submission_cutoff_at: '2026-08-28T14:31:00.000Z',
            state: 'PENDING',
            state_version: 1,
            created_at: start,
            updated_at: start,
          })}`
          yield* sql`UPDATE autonomous_cycles SET state='ACTIVE', state_version=2 WHERE cycle_id=${cycleId}`
        } else {
          const cycles = yield* makeCycleStore()
          yield* cycles.acquire(draft, start)
          yield* cycles.activate(cycleId, start)
        }
        const opening = flatAccountEvent()
        const openingReceipt = yield* events.ingest({
          ...opening,
          sourceEventId: 'settlement-opening',
          observedAt: start,
          occurredAt: start,
          account: { ...opening.account, observedAt: start },
        })
        const makeFill = (id: string, side: OrderSide, qty: string, price: string, at: string) => {
          const base = fillEvent(id, side, qty, price)
          const fill = { ...base.fill, intentId: hash(id), symbol: 'ETH/USD', feeMicros: '0', occurredAt: at }
          return {
            ...base,
            fill,
            contentHash: Result.getOrThrow(canonicalHashV1Result(fill)),
            occurredAt: at,
            observedAt: at,
            sourceTimestamp: Result.getOrThrow(sourceTimestamp(at)),
          }
        }
        const retain = (fill: FillEventInput) =>
          Effect.gen(function* () {
            const intentId = hash(fill.fill.fillId)
            if (historical || overreleased) {
              // Preserve the actual pre-cutover format when testing immutable fee migrations.
              yield* sql`INSERT INTO intents(intent_id,schema_version,account_id,client_order_id,symbol,side,order_type,time_in_force,quantity_atoms,notional_limit_micros,state,created_at,updated_at,cycle_id,strategy_name,decision_hash,policy_hash,authority_generation_hash)
          VALUES(${intentId},'bayn.paper-intent.v3',${accountId},${fill.fill.clientOrderId},'ETH/USD',${fill.fill.side},'LIMIT','IOC',${fill.fill.quantityAtoms},'100000000','PLANNED',${fill.occurredAt},${fill.occurredAt},${cycleId},'jev',${hash(fill.fill.fillId + 'decision')},${hash('settlement-policy')},${generationHash})`
            } else {
              const price = BigInt(fill.fill.priceAtoms) / 1000n
              const notional =
                (BigInt(fill.fill.quantityAtoms) * price + (fill.fill.side === OrderSide.Buy ? 999999999n : 0n)) /
                1000000000n
              yield* sql`INSERT INTO intents(intent_id,schema_version,account_id,client_order_id,symbol,side,order_type,time_in_force,quantity_atoms,notional_limit_micros,limit_price_micros,state,created_at,updated_at,cycle_id,strategy_name,decision_hash,policy_hash,authority_generation_hash)
          VALUES(${intentId},'bayn.execution-intent.v5',${accountId},${fill.fill.clientOrderId},'ETH/USD',${fill.fill.side},'LIMIT','IOC',${fill.fill.quantityAtoms},${notional.toString()},${price.toString()},'PLANNED',${fill.occurredAt},${fill.occurredAt},${cycleId},'jev',${hash(fill.fill.fillId + 'decision')},${hash('settlement-policy')},${generationHash})`
            }
            yield* accounting.account(fill)
            return {
              ...order(),
              schemaVersion: 'bayn.order.v3' as const,
              brokerOrderId: fill.fill.brokerOrderId,
              clientOrderId: fill.fill.clientOrderId,
              symbol: 'ETH/USD',
              side: fill.fill.side,
              quantityAtoms: fill.fill.quantityAtoms,
              filledQuantityAtoms: fill.fill.quantityAtoms,
              status: OrderStatus.Filled,
              observedAt: fill.observedAt,
            }
          })
        const buy = makeFill('observed-eth-buy', OrderSide.Buy, '33050000', '2425310000', occurredAt)
        const buyOrder = yield* retain(buy)
        const position = {
          schemaVersion: 'bayn.position.v2' as const,
          accountId,
          symbol: 'ETH/USD',
          quantityAtoms: '32967375',
          costBasisMicros: '79956104',
          averageEntryPriceMicros: '2425310000',
          marketPriceMicros: '2425310000',
          unrealizedPnlMicros: '0',
          marketValueMicros: '79956104',
          observedAt,
        }
        const positionInput = {
          _tag: 'Position' as const,
          broker: Broker.Alpaca,
          accountId,
          sourceEventId: `position:${hash('settlement-net-eth')}:${observedAt}:ETH/USD`,
          contentHash: Result.getOrThrow(canonicalHashV1Result({ sourceHash: hash('settlement-net-eth'), position })),
          occurredAt: observedAt,
          observedAt,
          position,
        }
        const snapshotReceipt = yield* events.ingestPositions(
          positionSnapshot(hash('settlement-net-eth'), [positionInput]),
        )
        const acct = { ...opening.account, cashMicros: '919840000', equityMicros: '999800104', observedAt }
        const acctReceipt = yield* events.ingest({
          ...opening,
          sourceEventId: 'settlement-bought-account',
          contentHash: Result.getOrThrow(canonicalHashV1Result(acct)),
          occurredAt: observedAt,
          observedAt,
          account: acct,
        })
        const valuation = yield* valuations.value({
          accountEventId: acctReceipt.eventId,
          positionSnapshotId: snapshotReceipt.snapshotId,
        })
        const snapshot = {
          account: acct,
          positions: [position],
          positionsObservedAt: observedAt,
          orders: [buyOrder],
          ordersObservedAt: observedAt,
          fills: [buy.fill],
          fees: [],
          cashReportingQuantumMicros: '10000' as const,
          positionSnapshotId: snapshotReceipt.snapshotId,
          accountEventId: acctReceipt.eventId,
          valuation,
          reconciledAt: observedAt,
        }
        yield* retainAccountCashReporting(sql, {
          ...snapshot,
          account: { ...opening.account, observedAt: start },
          accountEventId: openingReceipt.eventId,
          cashReportingQuantumMicros: '1',
        })
        yield* fence.transaction(prepareObservedCoinFees(sql, snapshot, config.tigerBeetle))
        if (historical || overreleased) yield* fence.transaction(postRetainedAccrual('COIN'))
        else {
          journalControl.failPosts = true
          expect(
            yield* fence
              .transaction(postBrokerFeePlans(sql, journal(journalControl), accountId, config.tigerBeetle))
              .pipe(Effect.flip),
          ).toMatchObject({ failure: 'ledger' })
          const prepared = yield* readFeeAccruals(sql, accountId, config.tigerBeetle)
          expect(prepared.map((row) => [row.coinQuantityAtoms, row.expenseMicros, row.posted])).toEqual([
            ['82625', '200392', false],
          ])
          journalControl.failPosts = false
          yield* fence.transaction(postBrokerFeePlans(sql, journal(journalControl), accountId, config.tigerBeetle))
        }
        yield* fence.transaction(prepareObservedCoinFees(sql, snapshot, config.tigerBeetle))
        yield* retainAccountCashReporting(sql, snapshot)
        if (historical)
          expect(yield* sql`SELECT count(*)::integer AS count FROM broker_fee_accruals`).toEqual([{ count: 1 }])
        else expect(yield* readFeeAccruals(sql, accountId, config.tigerBeetle)).toHaveLength(1)
        const sellAt = historical ? '2026-08-29T00:01:01.000Z' : '2026-08-28T14:31:01.000Z'
        const sell = makeFill('observed-eth-sell', OrderSide.Sell, '32967375', '2500000000', sellAt)
        const sellOrder = yield* retain(sell)
        const cashAccount = { ...acct, cashMicros: '1002060000', equityMicros: '1002060000', observedAt: sellAt }
        const cashReceipt = yield* events.ingest({
          ...opening,
          sourceEventId: 'settlement-sold-account',
          contentHash: Result.getOrThrow(canonicalHashV1Result(cashAccount)),
          occurredAt: sellAt,
          observedAt: sellAt,
          account: cashAccount,
        })
        const cashSnapshot = {
          ...snapshot,
          account: cashAccount,
          accountEventId: cashReceipt.eventId,
          positions: [],
          orders: [buyOrder, sellOrder],
          reconciledAt: sellAt,
        }
        yield* retainAccountCashReporting(sql, cashSnapshot)
        expect(
          yield* fence
            .transaction(
              Effect.gen(function* () {
                const unknownOpening = { ...acct, observedAt: '2026-08-28T14:31:00.500Z' }
                yield* events.ingest({
                  ...opening,
                  sourceEventId: 'settlement-opening-without-reporting',
                  contentHash: Result.getOrThrow(canonicalHashV1Result(unknownOpening)),
                  occurredAt: unknownOpening.observedAt,
                  observedAt: unknownOpening.observedAt,
                  account: unknownOpening,
                })
                yield* prepareObservedCashFees(sql, cashSnapshot, config.tigerBeetle)
              }),
            )
            .pipe(Effect.flip),
        ).toMatchObject({ failure: 'invariant' })
        if (historical) {
          const [source] = yield* sql<{
            transaction_id: string
            quantity_atoms: string
            price_atoms: string
          }>`SELECT transaction_id,quantity_atoms::text,price_atoms::text FROM accounting_transactions WHERE account_id=${accountId} AND side='SELL'`
          const [projected] = yield* sql<{
            cash: string
          }>`SELECT ((SELECT a.cash_micros FROM account_snapshots a JOIN broker_events e USING(event_id) WHERE a.account_id=${accountId} ORDER BY e.source_sequence LIMIT 1)
            +(SELECT sum(cash_delta_micros) FROM accounting_transactions WHERE account_id=${accountId})
            +COALESCE((SELECT sum(cash_delta_micros) FROM broker_cash_fee_deltas WHERE account_id=${accountId}),0))::text AS cash`
          if (source === undefined || projected === undefined) throw new Error('Missing historical source')
          const legacy = Result.getOrThrow(
            prepareFeeAccrual(
              {
                schemaVersion: 'bayn.broker-fee-accrual.v2',
                kind: 'CASH',
                accountId,
                symbol: 'USD',
                cycleId,
                date: '2026-08-28',
                observedAt: sellAt,
                openingAccountEventId: acctReceipt.eventId,
                openingCashReportingQuantumMicros: '10000',
                accountEventId: cashReceipt.eventId,
                projectedCashMicros: projected.cash,
                observedCashMicros: cashAccount.cashMicros,
                cashReportingQuantumMicros: '10000',
                sourceTrades: [
                  {
                    transactionId: source.transaction_id,
                    quantityAtoms: source.quantity_atoms,
                    priceAtoms: source.price_atoms,
                  },
                ],
              },
              config.tigerBeetle.ledger,
            ),
          )
          const legacyPlanHash = Result.getOrThrow(hashLedgerPlanResult(legacy.plan))
          yield* fence.transaction(sql`INSERT INTO broker_fee_accruals(accrual_id,account_id,kind,symbol,cycle_id,fee_date,account_event_id,observed_at,
            cash_debit_micros,expense_micros,data,content_hash,ledger_plan_hash,tigerbeetle_cluster_id,tigerbeetle_ledger)
            VALUES(${legacy.accrualId},${accountId},'CASH','USD',${cycleId},'2026-08-28',${cashReceipt.eventId},${sellAt},
              ${legacy.cashDebitMicros},${legacy.expenseMicros},${sql.json(legacy.data)},${legacy.contentHash},${legacyPlanHash},${config.tigerBeetle.clusterId.toString()},${config.tigerBeetle.ledger})`)
        } else yield* fence.transaction(prepareObservedCashFees(sql, cashSnapshot, config.tigerBeetle))
        if (historical || overreleased) yield* fence.transaction(postRetainedAccrual('CASH'))
        else yield* fence.transaction(postBrokerFeePlans(sql, journal(journalControl), accountId, config.tigerBeetle))
        const regulatory = {
          accountId,
          activityId: 'historical-regulatory-fee',
          date: '2026-08-28',
          netAmountMicros: '-1140000',
        }
        const regulatoryPlan = brokerFeeLedgerPlan(
          accountId,
          regulatory.activityId,
          '-940000',
          config.tigerBeetle.ledger,
        )
        if (historical) {
          const [accrual] = yield* sql<{
            accrual_id: string
          }>`SELECT accrual_id FROM broker_fee_accruals WHERE kind='CASH'`
          if (accrual === undefined) throw new Error('Missing historical cash accrual')
          const readEvidence = {
            requestId: 'settled-fees',
            status: 200,
            contentHash: hash('settled-fees'),
            observedAt: sellAt,
          }
          yield* fence.transaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO broker_fee_accounting(account_id,activity_id,fee_date,net_amount_micros,data,read_evidence,content_hash,ledger_plan_hash,tigerbeetle_cluster_id,tigerbeetle_ledger,first_observed_at)
              VALUES(${accountId},${regulatory.activityId},${regulatory.date},${regulatory.netAmountMicros},${sql.json(regulatory)},${sql.json(readEvidence)},
                ${Result.getOrThrow(canonicalHashV1Result({ schemaVersion: 'bayn.broker-fee.v1', ...regulatory }))},${Result.getOrThrow(hashLedgerPlanResult(regulatoryPlan))},${config.tigerBeetle.clusterId.toString()},${config.tigerBeetle.ledger},${sellAt})`
              yield* sql`INSERT INTO broker_fee_accrual_matches(accrual_id,account_id,activity_id,activity_cash_micros,accrual_cash_micros)
              VALUES(${accrual.accrual_id},${accountId},${regulatory.activityId},200000,200000)`
            }),
          )
          yield* journal(journalControl).post(regulatoryPlan)
          yield* sql`UPDATE broker_fee_accounting SET posted_at=${sellAt} WHERE activity_id=${regulatory.activityId}`
          yield* PgMigrator.run({
            loader: migrationLoader.pipe(Effect.map((rows) => rows.filter(([id]) => id < 108))),
            table: 'schema_migrations',
          }).pipe(Effect.provide(NodeServices.layer))
        }
        expect(
          (yield* readFeeAccruals(sql, accountId, config.tigerBeetle))
            .map((row) => [row.data.kind, row.expenseMicros, row.posted])
            .sort(),
        ).toEqual([
          ['CASH', '200000', true],
          ['COIN', '200392', true],
        ])
        expect(cashAccrualReportingOffsetMicros(yield* readFeeAccruals(sql, accountId, config.tigerBeetle))).toBe(
          historical ? '0' : '-1942',
        )
        const cashAccrual = (yield* readFeeAccruals(sql, accountId, config.tigerBeetle)).find(
          (row) => row.data.kind === 'CASH',
        )
        expect(String(cashAccrual?.settlement_date)).toBe(sellAt.slice(0, 10))
        expect(cashAccrual?.data).toMatchObject({
          schemaVersion: 'bayn.broker-fee-accrual.v2',
          openingAccountEventId: acctReceipt.eventId,
          openingCashReportingQuantumMicros: '10000',
        })
        yield* fence
          .transaction(sql`INSERT INTO broker_fee_accruals(
            accrual_id,account_id,kind,symbol,cycle_id,fee_date,position_snapshot_id,account_event_id,observed_at,
            coin_quantity_atoms,cash_debit_micros,expense_micros,data,content_hash,ledger_plan_hash,tigerbeetle_cluster_id,tigerbeetle_ledger)
            SELECT ${hash('forged-opening-precision')},account_id,kind,symbol,cycle_id,fee_date,position_snapshot_id,account_event_id,observed_at,
              coin_quantity_atoms,cash_debit_micros,expense_micros,jsonb_set(data,'{openingCashReportingQuantumMicros}','"1"'::jsonb),content_hash,ledger_plan_hash,tigerbeetle_cluster_id,tigerbeetle_ledger
            FROM broker_fee_accruals WHERE kind='CASH'`)
          .pipe(Effect.flip)
        expect(yield* readFeeAccruals(sql, accountId, config.tigerBeetle)).toHaveLength(2)
        if (scenario === 'partial' || overreleased) {
          if (cashAccrual === undefined) throw new Error('Missing cash accrual')
          const partial: Observed<FeeActivity> = {
            value: {
              accountId,
              activityId: 'partial-cash-fee',
              date: sellAt.slice(0, 10),
              cryptoCashFee: true,
              netAmountMicros: '-190000',
            },
            evidence: {
              requestId: 'partial-fee-read',
              status: 200,
              contentHash: hash('partial-fee-read'),
              observedAt: sellAt,
            },
          }
          const originalPlan = brokerFeeLedgerPlan(
            accountId,
            partial.value.activityId,
            '10000',
            config.tigerBeetle.ledger,
          )
          const originalPlanHash = Result.getOrThrow(hashLedgerPlanResult(originalPlan))
          if (overreleased) {
            yield* fence.transaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO broker_fee_accounting(account_id,activity_id,fee_date,net_amount_micros,data,read_evidence,content_hash,ledger_plan_hash,tigerbeetle_cluster_id,tigerbeetle_ledger,first_observed_at)
                VALUES(${accountId},${partial.value.activityId},${partial.value.date},${partial.value.netAmountMicros},${sql.json(partial.value)},${sql.json(partial.evidence)},
                  ${Result.getOrThrow(canonicalHashV1Result({ schemaVersion: 'bayn.broker-fee.v1', ...partial.value }))},${originalPlanHash},${config.tigerBeetle.clusterId.toString()},${config.tigerBeetle.ledger},${sellAt})`
                yield* sql`INSERT INTO broker_fee_accrual_matches(accrual_id,account_id,activity_id,activity_cash_micros,accrual_cash_micros)
                VALUES(${cashAccrual.accrualId},${accountId},${partial.value.activityId},190000,200000)`
              }),
            )
            yield* journal(journalControl).post(originalPlan)
            yield* sql`UPDATE broker_fee_accounting SET posted_at=${sellAt} WHERE activity_id=${partial.value.activityId}`
            yield* PgMigrator.run({
              loader: migrationLoader.pipe(Effect.map((rows) => rows.filter(([id]) => id < 108))),
              table: 'schema_migrations',
            }).pipe(Effect.provide(NodeServices.layer))
          } else {
            expect(
              yield* fence
                .transaction(
                  Effect.gen(function* () {
                    yield* sql`INSERT INTO broker_fee_accounting(account_id,activity_id,fee_date,net_amount_micros,data,read_evidence,content_hash,ledger_plan_hash,tigerbeetle_cluster_id,tigerbeetle_ledger,first_observed_at)
                VALUES(${accountId},${partial.value.activityId},${partial.value.date},${partial.value.netAmountMicros},${sql.json(partial.value)},${sql.json(partial.evidence)},
                  ${Result.getOrThrow(canonicalHashV1Result({ schemaVersion: 'bayn.broker-fee.v1', ...partial.value }))},${originalPlanHash},${config.tigerBeetle.clusterId.toString()},${config.tigerBeetle.ledger},${sellAt})`
                    yield* sql`INSERT INTO broker_fee_accrual_matches(accrual_id,account_id,activity_id,activity_cash_micros,accrual_cash_micros)
                VALUES(${cashAccrual.accrualId},${accountId},${partial.value.activityId},190000,200000)`
                  }),
                )
                .pipe(Effect.flip),
            ).toMatchObject({ _tag: 'WriterFenceError' })
          }
          const settle = (items: readonly Observed<FeeActivity>[]) =>
            Effect.gen(function* () {
              yield* fence.transaction(prepareFeeActivities(sql, accountId, items, config.tigerBeetle))
              return yield* fence.transaction(
                postBrokerFeePlans(sql, journal(journalControl), accountId, config.tigerBeetle),
              )
            })
          if (overreleased) {
            yield* fence.transaction(prepareFeeActivities(sql, accountId, [partial], config.tigerBeetle))
            journalControl.failPosts = true
            expect(yield* settle([partial]).pipe(Effect.flip)).toMatchObject({ failure: 'ledger' })
            expect(
              yield* sql`SELECT cash_debit_micros::text,posted_at IS NULL AS pending FROM broker_fee_match_corrections`,
            ).toEqual([{ cash_debit_micros: '10000', pending: true }])
            journalControl.failPosts = false
          }
          const partialResult = yield* settle([partial])
          expect(partialResult.cashDeltaMicros).toBe('0')
          const posts = journalControl.postCount
          expect(yield* settle([partial])).toEqual(partialResult)
          expect(journalControl.postCount).toBe(posts)
          const partialAccruals = yield* readFeeAccruals(sql, accountId, config.tigerBeetle)
          expect(partialAccruals.find((row) => row.data.kind === 'CASH')?.matched_cash_micros).toBe('190000')
          expect(cashAccrualReportingOffsetMicros(partialAccruals)).toBe('-1942')
          const [projection] = yield* sql<{
            cash: string
          }>`SELECT ((SELECT a.cash_micros FROM account_snapshots a JOIN broker_events e USING(event_id) WHERE a.account_id=${accountId} ORDER BY e.source_sequence LIMIT 1)
            +(SELECT sum(cash_delta_micros) FROM accounting_transactions WHERE account_id=${accountId})
            +(SELECT sum(cash_delta_micros) FROM broker_cash_fee_deltas WHERE account_id=${accountId}))::text AS cash`
          if (projection === undefined) throw new Error('Missing cash projection')
          const reported = reportedCashMicros(
            (BigInt(projection.cash) + BigInt(cashAccrualReportingOffsetMicros(partialAccruals))).toString(),
            '10000',
          )
          expect(reported).toBe(cashAccount.cashMicros)
          expect(reported).not.toBe((BigInt(cashAccount.cashMicros) + 10000n).toString())
          expect(
            yield* sql`SELECT activity_cash_micros::text,accrual_cash_micros::text FROM broker_fee_accrual_matches WHERE activity_id=${partial.value.activityId}`,
          ).toEqual([{ activity_cash_micros: '190000', accrual_cash_micros: overreleased ? '200000' : '190000' }])
          if (overreleased)
            expect(
              yield* sql`SELECT ledger_plan_hash FROM broker_fee_accounting WHERE activity_id=${partial.value.activityId}`,
            ).toEqual([{ ledger_plan_hash: originalPlanHash }])
          const rest: Observed<FeeActivity> = {
            ...partial,
            value: { ...partial.value, activityId: 'remaining-cash-fee', netAmountMicros: '-16046' },
          }
          const final = yield* settle([partial, rest])
          expect(final.cashDeltaMicros).toBe('-6046')
          const finalAccruals = yield* readFeeAccruals(sql, accountId, config.tigerBeetle)
          expect(finalAccruals.find((row) => row.data.kind === 'CASH')?.matched_cash_micros).toBe('200000')
          expect(cashAccrualReportingOffsetMicros(finalAccruals)).toBe('0')
          expect(yield* sql`SELECT count(*)::integer AS count FROM broker_fee_match_corrections`).toEqual([
            { count: overreleased ? 1 : 0 },
          ])
          const finalPosts = journalControl.postCount
          expect(yield* settle([partial, rest])).toEqual(final)
          expect(journalControl.postCount).toBe(finalPosts)
          return
        }
        const fees: Observed<FeeActivity>[] = [
          {
            value: {
              accountId,
              activityId: 'settled-coin-fee',
              date: '2026-08-28',
              netAmountMicros: '0',
              coinDebit: { symbol: 'ETH/USD', quantityAtoms: '82625', priceAtoms: '2425310000000' },
            },
            evidence: {
              requestId: 'settled-fees',
              status: 200,
              contentHash: hash('settled-fees'),
              observedAt: sellAt,
            },
          },
          {
            value: {
              accountId,
              activityId: 'settled-cash-fee',
              date: sellAt.slice(0, 10),
              cryptoCashFee: true as const,
              netAmountMicros: '-206046',
            },
            evidence: {
              requestId: 'settled-fees',
              status: 200,
              contentHash: hash('settled-fees'),
              observedAt: sellAt,
            },
          },
        ]
        if (hasRegulatory)
          fees.push({
            value: regulatory,
            evidence: {
              requestId: 'settled-fees',
              status: 200,
              contentHash: hash('settled-fees'),
              observedAt: sellAt,
            },
          })
        if (scenario === 'cross-date') {
          for (const fee of fees) {
            Object.assign(fee.value, {
              sourceCreatedAt: `${sellAt.slice(0, 19)}.123456000Z`,
              date: '2026-08-31',
            })
            Object.assign(fee.evidence, { observedAt: '2026-08-31T08:00:00.000Z' })
          }
          const first = fees[0]
          if (first === undefined || first.value.coinDebit === undefined) throw new Error('Missing coin fee')
          const { sourceCreatedAt: _sourceCreatedAt, ...withoutSource } = first.value
          for (const invalid of [
            withoutSource,
            { ...first.value, sourceCreatedAt: '2026-08-29T14:31:01.123456000Z' },
            { ...first.value, sourceCreatedAt: '2026-08-31T08:00:00.000000001Z' },
            { ...first.value, accountId: 'other-account' },
            { ...first.value, coinDebit: { ...first.value.coinDebit, quantityAtoms: '82626' } },
          ]) {
            expect(
              yield* fence
                .transaction(
                  prepareFeeActivities(
                    sql,
                    accountId,
                    [{ ...first, value: invalid }, ...fees.slice(1)],
                    config.tigerBeetle,
                  ),
                )
                .pipe(Effect.flip),
            ).toMatchObject({ _tag: 'ReconciliationStoreError' })
          }
        }
        const post = Effect.gen(function* () {
          yield* fence.transaction(prepareFeeActivities(sql, accountId, fees, config.tigerBeetle))
          return yield* fence.transaction(
            postBrokerFeePlans(sql, journal(journalControl), accountId, config.tigerBeetle),
          )
        })
        if (historical) {
          yield* fence.transaction(prepareFeeActivities(sql, accountId, fees, config.tigerBeetle))
          expect(yield* sql`SELECT count(*)::integer AS count FROM broker_fee_match_corrections`).toEqual([
            { count: 1 },
          ])
          journalControl.failPosts = true
          expect(
            yield* fence
              .transaction(postBrokerFeePlans(sql, journal(journalControl), accountId, config.tigerBeetle))
              .pipe(Effect.flip),
          ).toMatchObject({ failure: 'ledger' })
          expect(yield* sql`SELECT posted_at IS NULL AS pending FROM broker_fee_match_corrections`).toEqual([
            { pending: true },
          ])
          journalControl.failPosts = false
        }
        const result = yield* post
        if (scenario === 'cross-date') {
          expect(
            yield* sql`SELECT fee_date::text,data ? 'sourceCreatedAt' AS provenance_in_content,
              read_evidence->>'sourceCreatedAt' AS source_created_at FROM broker_fee_accounting ORDER BY activity_id`,
          ).toEqual([
            {
              fee_date: '2026-08-31',
              provenance_in_content: false,
              source_created_at: '2026-08-28T14:31:01.123456000Z',
            },
            {
              fee_date: '2026-08-31',
              provenance_in_content: false,
              source_created_at: '2026-08-28T14:31:01.123456000Z',
            },
          ])
        }
        const posts = journalControl.postCount
        expect(yield* post).toEqual(result)
        expect(journalControl.postCount).toBe(posts)
        if (scenario === 'cross-date') {
          const first = fees[0]
          if (first === undefined) throw new Error('Missing source fee')
          expect(
            yield* fence
              .transaction(
                prepareFeeActivities(
                  sql,
                  accountId,
                  [
                    { ...first, value: { ...first.value, sourceCreatedAt: '2026-08-28T14:31:01.123456001Z' } },
                    ...fees.slice(1),
                  ],
                  config.tigerBeetle,
                ),
              )
              .pipe(Effect.flip),
          ).toMatchObject({ failure: 'invariant', message: 'broker fee source timestamp changed' })
          const future = yield* fence
            .transaction(sql`
            INSERT INTO broker_fee_accounting(account_id,activity_id,fee_date,net_amount_micros,coin_cost_basis_micros,
              data,read_evidence,content_hash,ledger_plan_hash,tigerbeetle_cluster_id,tigerbeetle_ledger,first_observed_at)
            SELECT account_id,activity_id||':future',fee_date,net_amount_micros,coin_cost_basis_micros,
              data||jsonb_build_object('activityId',activity_id||':future'),
              read_evidence||jsonb_build_object('sourceCreatedAt','2026-08-31T08:00:00.000000001Z'),
              content_hash,ledger_plan_hash,tigerbeetle_cluster_id,tigerbeetle_ledger,first_observed_at
            FROM broker_fee_accounting WHERE activity_id=${first.value.activityId}
          `)
            .pipe(Effect.flip)
          expect(JSON.stringify(future)).toContain('broker_fee_source_created_at_check')
        }
        expect(result.cashDeltaMicros).toBe(hasRegulatory ? '-1146046' : '-6046')
        expect(cashAccrualReportingOffsetMicros(yield* readFeeAccruals(sql, accountId, config.tigerBeetle))).toBe('0')
        expect(result.plans.flatMap((plan) => plan.transfers).map((transfer) => transfer.amount)).toEqual(
          historical ? [200000n, 940000n, 6046n] : hasRegulatory ? [1140000n, 6046n] : [6046n],
        )
        if (historical) {
          const [original] = yield* sql<{
            ledger_plan_hash: string
          }>`SELECT ledger_plan_hash FROM broker_fee_accounting WHERE activity_id=${regulatory.activityId}`
          expect(original?.ledger_plan_hash).toBe(Result.getOrThrow(hashLedgerPlanResult(regulatoryPlan)))
          expect(
            yield* sql`SELECT count(*)::integer AS count,bool_and(posted_at IS NOT NULL) AS posted FROM broker_fee_match_corrections`,
          ).toEqual([{ count: 1, posted: true }])
          expect(
            yield* sql`SELECT count(*)::integer AS count FROM broker_fee_accrual_matches WHERE activity_id=${regulatory.activityId}`,
          ).toEqual([{ count: 1 }])
          const [cash] = yield* sql<{
            cash: string
          }>`SELECT ((SELECT a.cash_micros FROM account_snapshots a JOIN broker_events e USING(event_id) WHERE a.account_id=${accountId} ORDER BY e.source_sequence LIMIT 1)
            +(SELECT sum(cash_delta_micros) FROM accounting_transactions WHERE account_id=${accountId})
            +(SELECT sum(cash_delta_micros) FROM broker_cash_fee_deltas WHERE account_id=${accountId}))::text AS cash`
          expect(cash?.cash).toBe('1000915896')
          expect(reportedCashMicros(String(cash?.cash), '10000')).toBe('1000920000')
        }
        if (scenario === 'regulatory') {
          expect(
            yield* sql`SELECT count(*)::integer AS count FROM broker_fee_accrual_matches WHERE activity_id=${regulatory.activityId}`,
          ).toEqual([{ count: 0 }])
          expect(yield* sql`SELECT count(*)::integer AS count FROM broker_fee_match_corrections`).toEqual([
            { count: 0 },
          ])
        }
        const [postingCut] = yield* sql<{ posted_at: Date }>`SELECT max(at) AS posted_at FROM (
          SELECT posted_at AS at FROM broker_fee_match_corrections
          UNION ALL SELECT acknowledged_at FROM broker_fee_posting_acknowledgements) postings`
        const reportAt = new Date(
          Math.max(Date.parse(sellAt), postingCut?.posted_at?.getTime() ?? 0) + 2000,
        ).toISOString()
        {
          const settledAccount = {
            ...cashAccount,
            cashMicros: hasRegulatory ? '1000920000' : cashAccount.cashMicros,
            equityMicros: hasRegulatory ? '1000920000' : cashAccount.equityMicros,
            observedAt: reportAt,
          }
          const settledReceipt = yield* events.ingest({
            ...opening,
            sourceEventId: 'after-regulatory-settlement',
            contentHash: Result.getOrThrow(canonicalHashV1Result(settledAccount)),
            occurredAt: reportAt,
            observedAt: reportAt,
            account: settledAccount,
          })
          yield* retainAccountCashReporting(sql, {
            ...cashSnapshot,
            account: settledAccount,
            accountEventId: settledReceipt.eventId,
          })
        }
        yield* sql`INSERT INTO reconciliations(reconciliation_id,schema_version,account_id,expected_hash,observed_hash,content_hash,status,discrepancies,reconciled_at) VALUES(${hash('settlement-report-cut')},'bayn.paper-reconciliation.v1',${accountId},${hash('settlement-report-state')},${hash('settlement-report-state')},${hash('settlement-report-content')},'EXACT','[]'::jsonb,${reportAt})`
        yield* fence.transaction(
          Effect.gen(function* () {
            yield* sql`CREATE TEMP TABLE autonomous_cycles ON COMMIT DROP AS SELECT * FROM public.autonomous_cycles`
            yield* sql`UPDATE autonomous_cycles SET state='COMPLETED',terminal_at=${sellAt},execution_close_at=${sellAt}`
            const report = yield* readForwardPerformancePostgres(sql, accountId, undefined, fence)
            expect(report.cashReportingPrecisionKnown).toBe(true)
            expect(report.cashYieldEvidence).toMatchObject({
              schemaVersion: 'bayn.forward-performance-cash-yield-evidence.v3',
              cashYieldMicros: '0',
              openingCashReportingQuantumMicros: '1',
              closingCashReportingQuantumMicros: '10000',
            })
            expect(report.cashYieldEvidence?.accountedCashDeltaMicros).toBe(hasRegulatory ? '915896' : '2055896')
          }),
        )
        yield* accounting.verifyCompleted([buy, sell])
        expect(
          yield* sql`SELECT sum(quantity_atoms)::text AS quantity,sum(cost_basis_micros)::text AS cost FROM broker_inventory_debits WHERE posted`,
        ).toEqual([{ quantity: '82625', cost: '200392' }])
        expect(
          yield* sql`SELECT (sum(quantity_delta_atoms)-(SELECT sum(quantity_atoms) FROM broker_inventory_debits WHERE posted))::text AS quantity,(sum(cost_basis_delta_micros)-(SELECT sum(cost_basis_micros) FROM broker_inventory_debits WHERE posted))::text AS cost FROM accounting_transactions`,
        ).toEqual([{ quantity: '0', cost: '0' }])
      }),
    )
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
        const fence = yield* WriterFence
        yield* fence.transaction(prepareFeeActivities(sql, accountId, items, config.tigerBeetle))
        return yield* fence.transaction(postBrokerFeePlans(sql, journal(journalControl), accountId, config.tigerBeetle))
      })
    const prebaseline = fees.map((item) => ({ ...item, value: { ...item.value, date: '2026-08-27' } }))
    expect(await runtime.runPromise(post(prebaseline).pipe(Effect.flip))).toMatchObject({ failure: 'invariant' })
    expect(journalControl.postCount).toBe(0)
    const retryStarted = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return (yield* sql<{ at: Date }>`SELECT clock_timestamp() AS at`)[0]?.at
      }),
    )
    if (retryStarted === undefined) throw new Error('Missing database retry clock')
    journalControl.failPosts = true
    const failed = await runtime.runPromise(post(fees).pipe(Effect.flip))
    expect(failed).toMatchObject({ failure: 'ledger' })
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        expect(yield* sql`SELECT count(*)::integer AS count FROM broker_fee_posting_acknowledgements`).toEqual([
          { count: 0 },
        ])
      }),
    )
    journalControl.failPosts = false
    const recovered = await runtime.runPromise(post(fees))
    const replay = await runtime.runPromise(post(fees))
    expect(replay).toEqual(recovered)
    expect(recovered.fees.reduce((sum, fee) => sum + BigInt(fee.netAmountMicros), 0n)).toBe(-230000n)
    expect(journalControl.postCount).toBe(4)
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        expect(
          yield* sql`SELECT count(*)::integer AS count,bool_and(a.acknowledged_at>=${retryStarted}::timestamptz
        AND f.posted_at>=${retryStarted}::timestamptz) AS actual_retry_clock
        FROM broker_fee_posting_acknowledgements a JOIN broker_fee_accounting f
          ON a.account_id=f.account_id AND a.source_id=f.activity_id WHERE a.source_kind='ACTIVITY'`,
        ).toEqual([{ count: 3, actual_retry_clock: true }])
        yield* sql`UPDATE broker_fee_posting_acknowledgements SET acknowledged_at=clock_timestamp()`.pipe(Effect.flip)
        yield* sql`DELETE FROM broker_fee_posting_acknowledgements`.pipe(Effect.flip)
        yield* sql`TRUNCATE broker_fee_posting_acknowledgements`.pipe(Effect.flip)
        yield* sql`INSERT INTO broker_fee_posting_acknowledgements(account_id,source_kind,source_id,ledger_plan_hash,acknowledged_at)
        SELECT account_id,'ACTIVITY',activity_id,ledger_plan_hash,first_observed_at FROM broker_fee_accounting LIMIT 1`.pipe(
          Effect.flip,
        )
      }),
    )
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
    const cuts = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const reports = []
        const [acknowledgedCut] = yield* sql<{ at: Date }>`SELECT clock_timestamp() AS at`
        if (acknowledgedCut === undefined) throw new Error('Missing posting cut')
        for (const cut of [occurredAt, acknowledgedCut.at.toISOString()]) {
          yield* sql`INSERT INTO reconciliations (
            reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
            content_hash, status, discrepancies, reconciled_at
          ) VALUES (
            ${hash(`fee-cut-${cut}`)}, 'bayn.paper-reconciliation.v1', ${accountId}, ${hash('fee-cut-state')},
            ${hash('fee-cut-state')}, ${hash(`fee-cut-content-${cut}`)}, 'EXACT', '[]'::jsonb, ${cut}::timestamptz
          )`
          reports.push(yield* readForwardPerformancePostgres(sql, accountId))
        }
        return reports
      }),
    )
    expect(cuts.map((report) => report.postReconciliationActivityCount)).toEqual([3, 0])
    for (const report of cuts) {
      expect(report.brokerFeeRecords).toEqual(forward.brokerFeeRecords)
      expect(report.generationBrokerFeeIds).toEqual(forward.generationBrokerFeeIds)
    }
  })

  test('binds the submit cache to the latest exact reconciliation, broker observations and authority version', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const authority = yield* AuthorityGenerationStore
        const events = yield* BrokerEventStore
        const valuations = yield* ValuationStore
        const store = yield* ReconciliationStore
        const sql = yield* PgClient.PgClient
        if (authority.readOrInitializeObserveAuthority === undefined)
          return yield* Effect.die('missing native authority initializer')
        const generationHash = hash('broker-state-cache-generation')
        const state = yield* authority.readOrInitializeObserveAuthority({ generationHash, maximum: Authority.Observe })
        const account = flatAccountEvent()
        const accountReceipt = yield* events.ingest(account)
        const positionsReceipt = yield* events.ingestPositions(positionSnapshot(hash('cache-empty-positions'), []))
        const valuation = yield* valuations.value({
          accountEventId: accountReceipt.eventId,
          positionSnapshotId: positionsReceipt.snapshotId,
        })
        const snapshot = {
          account: account.account,
          positions: [],
          positionsObservedAt: observedAt,
          orders: [],
          ordersObservedAt: observedAt,
          fills: [],
          fees: [],
          cashReportingQuantumMicros: '1' as const,
          positionSnapshotId: hash('fixture-position-snapshot'),
          accountEventId: accountReceipt.eventId,
          valuation,
          reconciledAt: '2026-08-28T14:32:00.000Z',
        } as const
        const exact = yield* reconcileSnapshot(store, snapshot)
        const version = {
          reconciliationId: exact.reconciliation.reconciliationId,
          reconciledAt: exact.reconciliation.reconciledAt,
          authorityGenerationHash: generationHash,
          authorityVersion: state.version,
        }
        yield* verifyBrokerStateVersion(sql, accountId, version, hash('current-intent'))
        const newer = yield* reconcileSnapshot(store, { ...snapshot, reconciledAt: '2026-08-28T14:33:00.000Z' })
        expect(
          (yield* verifyBrokerStateVersion(sql, accountId, version, hash('current-intent')).pipe(Effect.flip)).failure,
        ).toBe('invariant')
        const latestVersion = {
          ...version,
          reconciliationId: newer.reconciliation.reconciliationId,
          reconciledAt: newer.reconciliation.reconciledAt,
        }
        yield* verifyBrokerStateVersion(sql, accountId, latestVersion, hash('current-intent'))
        expect(
          (yield* verifyBrokerStateVersion(
            sql,
            accountId,
            { ...latestVersion, authorityVersion: state.version + 1 },
            hash('current-intent'),
          ).pipe(Effect.flip)).failure,
        ).toBe('invariant')
        expect(
          (yield* verifyBrokerStateVersion(
            sql,
            accountId,
            { ...latestVersion, reconciledAt: '2026-08-28T14:35:00.000Z' },
            hash('current-intent'),
          ).pipe(Effect.flip)).failure,
        ).toBe('invariant')
        const laterAt = '2026-08-28T14:34:00.000Z'
        yield* events.ingest({
          ...account,
          sourceEventId: 'new-cache-account',
          observedAt: laterAt,
          account: { ...account.account, observedAt: laterAt },
        })
        expect(
          (yield* verifyBrokerStateVersion(sql, accountId, latestVersion, hash('current-intent')).pipe(Effect.flip))
            .failure,
        ).toBe('invariant')
        yield* (yield* AuthorityRestrictionStore).restrictAuthority('cache test restriction', laterAt)
        expect(
          (yield* verifyBrokerStateVersion(
            sql,
            accountId,
            { ...latestVersion, reconciledAt: laterAt },
            hash('current-intent'),
          ).pipe(Effect.flip)).failure,
        ).toBe('invariant')
      }),
    )
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
          cashReportingQuantumMicros: '1' as const,
          positionSnapshotId: hash('fixture-position-snapshot'),
          accountEventId: accountReceipt.eventId,
          valuation,
          reconciledAt: '2026-08-28T14:32:00.000Z',
        } as const
        const exact = yield* reconcileSnapshot(reconciliation, baseline)
        const discrepant = yield* reconcileSnapshot(reconciliation, {
          ...baseline,
          orders: [order()],
          reconciledAt: '2026-08-28T14:33:00.000Z',
        })
        const resolved = yield* reconcileSnapshot(reconciliation, {
          ...baseline,
          reconciledAt: '2026-08-28T14:34:00.000Z',
        })
        const sql = yield* PgClient.PgClient
        const rows = yield* sql<{ status: string }>`
          SELECT status FROM reconciliations ORDER BY reconciled_at, reconciliation_id COLLATE "C"
        `
        const readAuthority = authority.readAuthorityState
        const transactionalAuthority = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* sql.reserve
            return yield* sql.withTransaction(readAuthority)
          }),
        )
        return {
          exact,
          discrepant,
          resolved,
          bindings: yield* reconciliation.bindings(accountId),
          authority: yield* authority.readAuthorityState,
          transactionalAuthority,
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
    expect(result.transactionalAuthority).toEqual(result.authority)
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
