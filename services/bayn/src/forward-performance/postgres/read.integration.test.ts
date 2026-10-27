import { describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted, Result, Schema } from 'effect'
import type { Statement } from 'effect/sql/Statement'
import { StreamingPerformanceManifestSchema } from '../intraday-schema'

import { PostgresClientLive } from '../../db/postgres-client'
import { baynTestPostgresUrl } from '../../test-environment.test-support'
import { readForwardPerformanceMarketVolumeBindings, readForwardPerformanceUnclosedCycleCount } from './read'
import { completedIntradayCycles, makeStreamingPerformanceFixture } from '../intraday-cycle.test-support'
import { readForwardPerformancePostgres } from './read'
import { runForwardPerformanceReport, type ForwardPerformanceReaders } from '../program'
import type { ForwardPerformanceConfig } from '../config'
import { coinRoundTrip } from '../coin-fee-episodes.test-support'
import { postgresMigrations } from '../../db/postgres-migrations'
import { makeAuthorityPostgres } from '../../db/execution-store/authority-shared'
import { makeObserveAuthorityInterpreter } from '../../db/execution-store/observe-authority'
import { Authority } from '../../execution/contracts'
import { makeCycleStore } from '../../cycle/store/postgres'
import { makeCycleExecutionPolicyFromModel } from '../../cycle/construction'
import { makeIntradayCycleDraft } from '../../cycle/runner/calendar-decisions'
import { continuousExecutionPolicy, continuousMarketHours, tradingWindow } from '../../market-hours'
import { defaultJevProtocolDocument } from '../../jev/protocol'
import { planAccountingReceipt } from '../../db/execution-store/decisions'
import { makeBrokerIdentity, BrokerEnvironment, BrokerProvider } from '../../broker/identity'
import { config as runtimeConfig } from '../../testing/runtime-fixtures'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const config = {
  operationTimeoutMs: 5_000,
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
}

const hash = (character: string): string => character.repeat(64)

describePostgres('Forward-performance PostgreSQL read boundary', () => {
  test('composes gross fills and observed coin fees with an independent cumulative inventory boundary', async () => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw new Error('Coin episode integration requires an isolated local _test database')
    const accountId = 'synthetic-coin-episode-account'
    const identity = Result.getOrThrow(
      makeBrokerIdentity({
        schemaVersion: 'bayn.broker-identity.v2',
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Sandbox,
        accountId,
      }),
    )
    const reportConfig: ForwardPerformanceConfig = {
      ...runtimeConfig,
      ...config,
      runtimeMode: 'AutonomousService',
      cyclePollIntervalMs: 30_000,
      execution: { ...runtimeConfig.execution, brokerIdentity: identity },
      alpaca: {
        identity,
        provider: identity.provider,
        environment: identity.environment,
        expectedAccountId: accountId,
        baseUrl: 'https://paper-api.alpaca.markets',
        key: Redacted.make('unused'),
        secret: Redacted.make('unused'),
        proxyUrl: 'http://proxy.invalid:3128',
        operationTimeoutMs: 5_000,
        retryAttempts: 1,
        authorityGenerationHash: hash('e'),
        reconciliationIntervalMs: 30_000,
      },
    }
    const runtime = ManagedRuntime.make(
      PostgresClientLive(reportConfig, { maxConnections: 1, applicationName: 'bayn-episode-test' }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    )
    try {
      const result = await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient
            yield* sql`DROP SCHEMA public CASCADE`
            yield* sql`CREATE SCHEMA public`
            yield* postgresMigrations
            yield* makeObserveAuthorityInterpreter(
              sql,
              makeAuthorityPostgres(sql),
              identity,
            ).readOrInitializeObserveAuthority({ generationHash: hash('e'), maximum: Authority.Observe })
            const policy = Result.getOrThrow(
              makeCycleExecutionPolicyFromModel(defaultJevProtocolDocument.executionModel),
            )
            if (policy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3')
              throw new Error('Expected intraday policy')
            const window = Result.getOrThrow(
              tradingWindow(continuousMarketHours, '2026-09-18T15:29:00.000Z', {
                ...continuousExecutionPolicy,
                sessionEntryCutoffMs: 0,
              }),
            )
            if (window === null) throw new Error('Expected continuous window')
            const draft = Result.getOrThrow(
              makeIntradayCycleDraft(
                {
                  cycleBindingId: hash('f'),
                  strategyName: 'jev',
                  strategyProtocolHash: hash('d'),
                  accountId,
                  executionPolicy: policy,
                },
                continuousMarketHours,
                window,
              ),
            )
            const store = yield* makeCycleStore()
            yield* store.acquire(draft, window.openAt)
            // The reader's window fixture is independent of native decision/lifecycle qualification.
            // Fill, receipt, fee and inventory-view evidence below uses the migrated durable tables.
            yield* sql`CREATE TEMP TABLE autonomous_cycles AS SELECT * FROM public.autonomous_cycles`
            yield* sql`UPDATE pg_temp.autonomous_cycles SET state='NO_TRADE',terminal_at='2026-09-18T21:00:00Z'`
            const fixture = coinRoundTrip(0, accountId, draft.identity.cycleId)
            const accrual = fixture.accrual
            if (accrual.data.kind !== 'COIN') throw new Error('Expected coin fixture')
            const coin = accrual.data
            yield* sql.withTransaction(
              Effect.gen(function* () {
                for (const [index, prepared] of fixture.accounting.entries()) {
                  const t = prepared.transaction
                  if (t.intentId === undefined) throw new Error('Missing synthetic source intent')
                  const price = BigInt(t.priceAtoms) / 1000n
                  const intentNotional =
                    (BigInt(t.quantityAtoms) * price + (t.side === 'BUY' ? 999999999n : 0n)) / 1000000000n
                  yield* sql`INSERT INTO intents(intent_id,schema_version,account_id,client_order_id,symbol,side,order_type,time_in_force,quantity_atoms,notional_limit_micros,limit_price_micros,state,created_at,updated_at,cycle_id,strategy_name,decision_hash,policy_hash,authority_generation_hash)
                    VALUES(${t.intentId},'bayn.execution-intent.v5',${accountId},${`client-${index}`},${t.symbol},${t.side},'LIMIT','IOC',${t.quantityAtoms},${intentNotional.toString()},${price.toString()},'PLANNED',${t.occurredAt},${t.occurredAt},${draft.identity.cycleId},'jev',${hash(index === 0 ? '9' : '7')},${hash('8')},${hash('e')})`
                  yield* sql`INSERT INTO broker_events(event_id,schema_version,content_hash,event_kind,broker,account_id,
            source_event_id,source_sequence,occurred_at,observed_at)
            VALUES(${t.brokerEventId},'bayn.paper-broker-event.v1',${t.brokerEventId},'FILL','ALPACA',${accountId},
            ${`synthetic-fill-${index}`},${(index + 1) * 2},${t.occurredAt},${t.occurredAt})`
                  yield* sql`INSERT INTO fills(event_id,account_id,schema_version,fill_id,broker_order_id,client_order_id,
            symbol,side,quantity_atoms,price_atoms,fee_micros,source_timestamp,intent_id)
            VALUES(${t.brokerEventId},${accountId},'bayn.fill.v2',${`synthetic-fill-${index}`},${`order-${index}`},
            ${`client-${index}`},${t.symbol},${t.side},${t.quantityAtoms},${t.priceAtoms},${t.feeMicros},${t.occurredAt.replace('.000Z', '.000000000Z')},${t.intentId})`
                  yield* sql`INSERT INTO accounting_transactions(transaction_id,schema_version,broker_event_id,intent_id,account_id,symbol,
            side,quantity_atoms,price_atoms,notional_micros,fee_micros,cost_basis_micros,realized_pnl_micros,
            quantity_delta_atoms,cost_basis_delta_micros,cash_delta_micros,ledger_plan_hash,content_hash,occurred_at)
            VALUES(${t.transactionId},${t.schemaVersion},${t.brokerEventId},${t.intentId},${accountId},${t.symbol},${t.side},
            ${t.quantityAtoms},${t.priceAtoms},${t.notionalMicros},${t.feeMicros},${t.costBasisMicros},${t.realizedPnlMicros},
            ${t.quantityDeltaAtoms},${t.costBasisDeltaMicros},${t.cashDeltaMicros},${t.ledgerPlanHash},${t.contentHash},${t.occurredAt})`
                  const receipt = Result.getOrThrow(planAccountingReceipt(prepared, '2001', 7001))
                  yield* sql`INSERT INTO accounting_receipts(receipt_id,schema_version,broker_event_id,intent_id,tigerbeetle_cluster_id,
            tigerbeetle_ledger,account_ids,transfer_ids,debit_micros,credit_micros,content_hash,recorded_at)
            VALUES(${receipt.receiptId},${receipt.schemaVersion},${t.brokerEventId},${t.intentId},'2001',7001,${receipt.accountIds}::numeric[],
            ${receipt.transferIds}::numeric[],${receipt.debitMicros},${receipt.creditMicros},${receipt.contentHash},${t.occurredAt})`
                }
                for (const [index, at, cash] of [
                  [10, '2026-09-18T15:28:00.000Z', '100000000'],
                  [11, '2026-09-18T21:00:00.000Z', '99991738'],
                ] as const) {
                  const eventId = hash(String(index === 10 ? 1 : 2))
                  yield* sql`INSERT INTO broker_events(event_id,schema_version,content_hash,event_kind,broker,account_id,
            source_event_id,source_sequence,occurred_at,observed_at)
            VALUES(${eventId},'bayn.paper-broker-event.v1',${eventId},'ACCOUNT','ALPACA',${accountId},${`account-${index}`},${index === 10 ? 1 : 5},${at},${at})`
                  yield* sql`INSERT INTO account_snapshots(event_id,account_id,schema_version,status,currency,cash_micros,equity_micros,buying_power_micros)
            VALUES(${eventId},${accountId},'bayn.paper-account-snapshot.v2','ACTIVE','USD',${cash},${cash},${cash})`
                  yield* sql`INSERT INTO account_cash_reporting VALUES(${eventId},1)`
                }
                yield* sql`INSERT INTO position_snapshots(snapshot_id,schema_version,account_id,source_hash,observed_at,position_count,content_hash)
          VALUES(${coin.positionSnapshotId},'bayn.paper-position-snapshot.v1',${accountId},${hash('b')},${coin.observedAt},1,${hash('c')})`
                yield* sql`INSERT INTO broker_events(event_id,schema_version,content_hash,event_kind,broker,account_id,
              source_event_id,source_sequence,occurred_at,observed_at) VALUES(${hash('3')},'bayn.paper-broker-event.v1',${hash('4')},
              'POSITION','ALPACA',${accountId},'observed-net-position',3,${coin.observedAt},${coin.observedAt})`
                yield* sql`INSERT INTO positions(event_id,account_id,schema_version,symbol,quantity_atoms,average_entry_price_micros,
              market_price_micros,market_value_micros,unrealized_pnl_micros,cost_basis_micros,snapshot_id)
              VALUES(${hash('3')},${accountId},'bayn.position.v2','ETH/USD',${coin.observedQuantityAtoms},100000000,
              100000000,${coin.observedCostMicros},0,${coin.observedCostMicros},${coin.positionSnapshotId})`
                yield* sql`INSERT INTO broker_fee_accruals(accrual_id,account_id,kind,symbol,cycle_id,fee_date,position_snapshot_id,
          observed_at,coin_quantity_atoms,expense_micros,data,content_hash,ledger_plan_hash,tigerbeetle_cluster_id,tigerbeetle_ledger,posted_at)
          VALUES(${accrual.accrual_id},${accountId},'COIN','ETH/USD',${draft.identity.cycleId},${accrual.data.date},
                ${coin.positionSnapshotId},${coin.observedAt},${accrual.coin_quantity_atoms},${accrual.expense_micros},
          ${sql.json(accrual.data)},${accrual.content_hash},${accrual.ledger_plan_hash},2001,7001,${accrual.data.observedAt})`
                yield* sql`INSERT INTO reconciliations(reconciliation_id,schema_version,account_id,expected_hash,observed_hash,
          content_hash,status,discrepancies,reconciled_at)
          VALUES(${hash('9')},'bayn.paper-reconciliation.v1',${accountId},${hash('8')},${hash('8')},${hash('7')},'EXACT','[]'::jsonb,'2026-09-18T21:00:00Z')`
              }),
            )
            // Report terminality is synthetic; the cohort view still binds the real durable source intents.
            yield* sql`CREATE TEMP TABLE intents AS SELECT * FROM public.intents`
            yield* sql`UPDATE pg_temp.intents SET state='TERMINAL'`
            const postgres = yield* readForwardPerformancePostgres(sql, accountId)
            yield* sql`CREATE TEMP TABLE broker_events (LIKE public.broker_events INCLUDING ALL)`
            yield* sql`CREATE TRIGGER broker_event_projection_hash BEFORE INSERT ON pg_temp.broker_events
                  FOR EACH ROW EXECUTE FUNCTION initialize_broker_event_projection_hash()`
            yield* sql`CREATE TEMP TABLE account_snapshots (LIKE public.account_snapshots INCLUDING ALL)`
            yield* sql`INSERT INTO broker_events SELECT * FROM public.broker_events`
            yield* sql`INSERT INTO account_snapshots
                  (event_id,account_id,schema_version,status,currency,cash_micros,equity_micros,buying_power_micros,crypto_fee_tier)
                  SELECT event_id,account_id,schema_version,status,currency,cash_micros,equity_micros,buying_power_micros,crypto_fee_tier
                  FROM public.account_snapshots`
            yield* sql`INSERT INTO broker_events
                  (event_id,schema_version,content_hash,event_kind,broker,account_id,source_event_id,
                    source_sequence,occurred_at,observed_at)
                  SELECT md5('history-event-' || n) || md5('event-' || n),'bayn.paper-broker-event.v1',
                    md5('history-content-' || n) || md5('content-' || n),
                    CASE WHEN n % 4 = 0 THEN 'ORDER' ELSE 'ACCOUNT' END,'ALPACA',
                    CASE WHEN n % 4 = 1 THEN 'foreign-account' ELSE ${accountId} END,
                    'history-' || n,1000+n,'2026-09-17T15:28:00Z'::timestamptz,
                    CASE WHEN n % 4 IN (0,1,2) THEN '2026-09-19T21:00:00Z'::timestamptz
                      ELSE '2026-09-17T15:28:00Z'::timestamptz END
                  FROM generate_series(1,16384) AS n`
            yield* sql`INSERT INTO account_snapshots
                  (event_id,account_id,schema_version,status,currency,cash_micros,equity_micros,buying_power_micros)
                  SELECT event_id,account_id,'bayn.paper-account-snapshot.v2','ACTIVE','USD',
                    999000000,999000000,999000000
                  FROM broker_events WHERE source_event_id LIKE 'history-%' AND event_kind='ACCOUNT'`
            yield* sql`ANALYZE broker_events`
            yield* sql`ANALYZE account_snapshots`
            const lookups: Statement<Record<string, unknown>>[] = []
            const monitored = new Proxy(sql, {
              apply(target, receiver, argumentsList) {
                const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
                if (statement.compile()[0].includes('FROM account_snapshots AS snapshot')) lookups.push(statement)
                return statement
              },
            })
            expect(yield* readForwardPerformancePostgres(monitored, accountId)).toEqual(postgres)
            expect(lookups).toHaveLength(5)
            for (const lookup of lookups) {
              const [query, parameters] = lookup.compile()
              const explanation = yield* sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, parameters)
              const plans = yield* Schema.decodeUnknownEffect(
                Schema.Array(Schema.Struct({ 'QUERY PLAN': Schema.Array(Schema.Struct({ Plan: Schema.Unknown })) })),
              )(explanation)
              const snapshotRowsRead = (node: unknown): number => {
                if (node === null || typeof node !== 'object') return 0
                const rows =
                  'Relation Name' in node &&
                  (node['Relation Name'] === 'broker_events' || node['Relation Name'] === 'account_snapshots') &&
                  'Actual Rows' in node &&
                  typeof node['Actual Rows'] === 'number' &&
                  'Actual Loops' in node &&
                  typeof node['Actual Loops'] === 'number'
                    ? node['Actual Rows'] * node['Actual Loops']
                    : 0
                return (
                  rows +
                  ('Plans' in node && Array.isArray(node.Plans)
                    ? node.Plans.reduce((sum: number, child: unknown) => sum + snapshotRowsRead(child), 0)
                    : 0)
                )
              }
              expect(snapshotRowsRead(plans[0]?.['QUERY PLAN'][0]?.Plan)).toBeLessThan(128)
            }
            yield* sql`DROP TABLE pg_temp.account_snapshots, pg_temp.broker_events`
            const readers: ForwardPerformanceReaders = {
              postgres: readForwardPerformancePostgres,
              marketVolume: () => Effect.succeed([]),
              inferenceExpenses: () => Effect.succeed([]),
              ledger: () =>
                Effect.succeed({
                  totals: {
                    realizedGainMicros: '0',
                    cashSettlementRoundingMicros: '0',
                    realizedLossMicros: '0',
                    brokerExecutionFeesMicros: '8262',
                    otherChargedCostsMicros: null,
                    cashYieldMicros: '0',
                  },
                  ledgerExact: true,
                  missingLedgerAccountCount: 0,
                  openPositionCount: 0,
                  cashYieldEvidenceRequired: false,
                }),
            }
            const report = yield* runForwardPerformanceReport(reportConfig, readers)
            const disagreement = yield* runForwardPerformanceReport(reportConfig, {
              ...readers,
              ledger: (...args) =>
                readers.ledger(...args).pipe(Effect.map((value) => ({ ...value, openPositionCount: 1 }))),
            })
            const unrelatedScope = yield* readForwardPerformancePostgres(sql, accountId, hash('f'))
            return { postgres, report, disagreement, unrelatedScope }
          }),
        ),
      )
      expect(result.unrelatedScope.transactions).toEqual([])
      expect(result.unrelatedScope.ledgerTransactions).toHaveLength(2)
      expect(result.unrelatedScope.ledgerReceipts).toHaveLength(2)
      expect(result.unrelatedScope.accountReconciliation).toEqual(result.postgres.accountReconciliation)
      expect(result.postgres.openPositionCount).toBe(0)
      expect(result.report.positionEpisodes).toMatchObject({
        status: 'MEASURED',
        completedCount: 1,
        openCount: 0,
        crossScopeCount: 0,
      })
      expect(result.postgres.accountReconciliation).toEqual({
        reconciledAt: '2026-09-18T21:00:00.000Z',
        performanceExact: true,
      })
      expect(result.report.receipt.reconciliationProof.openPositionCount).toBe(0)
      expect(result.report.receipt.evidence.reasonCodes).toContain('BROKER_FEE_SETTLEMENT_PENDING')
      expect(result.report.receipt.profitability).toBe('UNDETERMINED')
      expect(result.disagreement.positionEpisodes).toMatchObject({
        status: 'UNDETERMINED',
        reason: 'RECONCILIATION_GAP',
      })
    } finally {
      await runtime.dispose()
    }
  }, 30_000)

  test('loads the completed native cycles and respects account, terminal state and reconciliation cutoff', async () => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local test database')
    const runtime = ManagedRuntime.make(PostgresClientLive(config).pipe(Layer.provideMerge(NodeServices.layer)))
    const streaming = makeStreamingPerformanceFixture().request
    try {
      const rows = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`CREATE TEMP TABLE reconciliations (reconciliation_id text, account_id text, reconciled_at timestamptz) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE autonomous_cycles (cycle_id text, snapshot_id text, account_id text, state text, execution_session_date date, execution_open_at timestamptz, execution_close_at timestamptz, terminal_at timestamptz, submission_open_at timestamptz) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE snapshot_references (snapshot_id text, manifest jsonb) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE intraday_snapshot_references (snapshot_id text, manifest jsonb) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE streaming_snapshot_references (snapshot_id text, manifest jsonb) ON COMMIT DROP`
              yield* sql`INSERT INTO reconciliations VALUES ('receipt', 'test-account', '2026-09-11T21:00:00Z')`
              for (const cycle of completedIntradayCycles) {
                yield* sql`INSERT INTO autonomous_cycles VALUES (${cycle.cycleId}, ${cycle.manifest.snapshotId}, 'test-account', 'COMPLETED', ${cycle.session}::date, ${cycle.windowOpenedAt}::timestamptz, ${cycle.windowClosedAt}::timestamptz, ${cycle.windowClosedAt}::timestamptz, ${cycle.windowOpenedAt}::timestamptz)`
                yield* sql`INSERT INTO intraday_snapshot_references VALUES (${cycle.manifest.snapshotId}, ${JSON.stringify(cycle.manifest)}::jsonb)`
              }
              yield* sql`INSERT INTO autonomous_cycles VALUES (${streaming.cycleId}, ${streaming.decisionSnapshotId}, 'test-account', 'COMPLETED', ${streaming.executionSessionDate}::date, ${streaming.windowOpenedAt}::timestamptz, ${streaming.windowClosedAt}::timestamptz, ${streaming.windowClosedAt}::timestamptz, ${streaming.windowOpenedAt}::timestamptz)`
              yield* sql`INSERT INTO streaming_snapshot_references VALUES (${streaming.decisionSnapshotId}, ${JSON.stringify(streaming.decisionManifest)}::jsonb)`
              const included = yield* readForwardPerformanceMarketVolumeBindings(sql, 'test-account')
              const otherAccount = yield* readForwardPerformanceMarketVolumeBindings(sql, 'another-account')
              yield* sql`UPDATE reconciliations SET reconciled_at = '2026-09-10T21:00:00Z'`
              const beforeSecondClose = yield* readForwardPerformanceMarketVolumeBindings(sql, 'test-account')
              yield* sql`UPDATE autonomous_cycles SET terminal_at = execution_open_at + interval '45 minutes'`
              yield* sql`UPDATE reconciliations SET reconciled_at = ${`${streaming.executionSessionDate}T15:00:00Z`}::timestamptz`
              const duringStreamingSession = yield* readForwardPerformanceMarketVolumeBindings(sql, 'test-account')
              yield* sql`UPDATE reconciliations SET reconciled_at = '2026-09-11T15:00:00Z'`
              const duringLastSession = yield* readForwardPerformanceMarketVolumeBindings(sql, 'test-account')
              yield* sql`UPDATE reconciliations SET reconciled_at = '2026-09-11T19:59:59.999Z'`
              const beforeSessionClose = yield* readForwardPerformanceMarketVolumeBindings(sql, 'test-account')
              yield* sql`UPDATE reconciliations SET reconciled_at = '2026-09-11T20:00:00Z'`
              const atSessionClose = yield* readForwardPerformanceMarketVolumeBindings(sql, 'test-account')
              yield* sql`UPDATE autonomous_cycles SET state = 'ACTIVE'`
              const open = yield* readForwardPerformanceMarketVolumeBindings(sql, 'test-account')
              return {
                included,
                otherAccount,
                beforeSecondClose,
                duringStreamingSession,
                duringLastSession,
                beforeSessionClose,
                atSessionClose,
                open,
              }
            }),
          )
        }),
      )
      expect(rows.included.map((row) => row.cycle_id)).toEqual([
        streaming.cycleId,
        ...completedIntradayCycles.map((cycle) => cycle.cycleId),
      ])
      expect(rows.included.map((row) => row.manifest.schemaVersion)).toEqual([
        'bayn.streaming-market-snapshot.v1',
        'bayn.intraday-market-snapshot.v1',
        'bayn.intraday-market-snapshot.v1',
      ])
      expect(rows.included[0]?.manifest).toEqual(
        Schema.decodeUnknownSync(StreamingPerformanceManifestSchema)(streaming.decisionManifest),
      )
      expect(rows.otherAccount).toHaveLength(0)
      expect(rows.beforeSecondClose.map((row) => row.cycle_id)).toEqual([
        streaming.cycleId,
        completedIntradayCycles[0].cycleId,
      ])
      expect(rows.duringStreamingSession).toHaveLength(0)
      expect(rows.duringLastSession).toEqual(rows.beforeSecondClose)
      expect(rows.beforeSessionClose).toEqual(rows.beforeSecondClose)
      expect(rows.atSessionClose).toEqual(rows.included)
      expect(rows.open).toHaveLength(0)
    } finally {
      await runtime.dispose()
    }
  })

  test('ignores future never-started cycles while preserving durable and past unfinished evidence', async () => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local database whose name ends in _test')
    }

    const runtime = ManagedRuntime.make(PostgresClientLive(config).pipe(Layer.provideMerge(NodeServices.layer)))
    const accountId = 'forward-performance-boundary-account'
    const authorityGenerationHash = hash('a')
    const researchPlanHash = hash('b')

    try {
      const counts = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`CREATE TEMP TABLE authority_generations (
                generation_hash text NOT NULL,
                maximum text NOT NULL,
                account_id text NOT NULL,
                qualification_run_id text,
                research_plan_hash text,
                activated_at timestamptz NOT NULL,
                previous_generation_hash text
              ) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE reconciliations (
                reconciliation_id text NOT NULL,
                account_id text NOT NULL,
                reconciled_at timestamptz NOT NULL
              ) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE autonomous_cycles (
                cycle_id text PRIMARY KEY,
                account_id text NOT NULL,
                state text NOT NULL,
                submission_open_at timestamptz NOT NULL,
                snapshot_id text,
                decision_hash text,
                qualification_run_id text,
                created_at timestamptz NOT NULL
              ) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE intents (
                intent_id text PRIMARY KEY,
                cycle_id text NOT NULL,
                account_id text,
                authority_generation_hash text
              ) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE autonomous_cycle_shadow_decisions (
                cycle_id text, decision_hash text, schema_version text, document jsonb
              ) ON COMMIT DROP`
              yield* sql`INSERT INTO authority_generations (
                generation_hash,
                maximum,
                account_id,
                qualification_run_id,
                research_plan_hash,
                activated_at,
                previous_generation_hash
              ) VALUES (${authorityGenerationHash}, 'PAPER', ${accountId}, NULL, ${researchPlanHash}, '2026-09-04T00:00:00.000Z'::timestamptz, NULL)`
              yield* sql`INSERT INTO autonomous_cycles (
                cycle_id,
                account_id,
                state,
                submission_open_at,
                snapshot_id,
                decision_hash,
                qualification_run_id,
                created_at
              ) VALUES
                (${hash('1')}, ${accountId}, 'COMPLETED', '2026-09-04T13:30:00.000Z'::timestamptz, ${hash('2')}, NULL, ${researchPlanHash}, '2026-09-04T12:00:00.000Z'::timestamptz),
                (${hash('3')}, ${accountId}, 'ACTIVE', '2026-09-08T13:30:00.000Z'::timestamptz, ${hash('4')}, NULL, ${researchPlanHash}, '2026-09-04T14:00:00.000Z'::timestamptz)`

              const withoutReconciliation = yield* readForwardPerformanceUnclosedCycleCount(
                sql,
                accountId,
                authorityGenerationHash,
              )

              yield* sql`INSERT INTO reconciliations (reconciliation_id, account_id, reconciled_at)
                VALUES
                  (${hash('c')}, ${accountId}, '2026-09-04T21:00:00.000Z'::timestamptz),
                  (${hash('d')}, ${accountId}, '2026-09-05T21:00:00.000Z'::timestamptz)`

              const withoutFutureFacts = yield* readForwardPerformanceUnclosedCycleCount(
                sql,
                accountId,
                authorityGenerationHash,
              )

              yield* sql`INSERT INTO autonomous_cycles (
                cycle_id,
                account_id,
                state,
                submission_open_at,
                snapshot_id,
                decision_hash,
                qualification_run_id,
                created_at
              ) VALUES
                (${hash('5')}, ${accountId}, 'PENDING', '2026-09-08T13:30:00.000Z'::timestamptz, NULL, ${hash('6')}, ${researchPlanHash}, '2026-09-04T15:00:00.000Z'::timestamptz),
                (${hash('7')}, ${accountId}, 'PENDING', '2026-09-08T13:30:00.000Z'::timestamptz, NULL, NULL, ${researchPlanHash}, '2026-09-04T15:15:00.000Z'::timestamptz),
                (${hash('8')}, ${accountId}, 'ACTIVE', '2026-09-04T13:30:00.000Z'::timestamptz, ${hash('9')}, NULL, ${researchPlanHash}, '2026-09-04T15:30:00.000Z'::timestamptz),
                (${hash('c')}, ${accountId}, 'BLOCKED', '2026-09-08T13:30:00.000Z'::timestamptz, NULL, NULL, ${researchPlanHash}, '2026-09-04T16:00:00.000Z'::timestamptz),
                (${hash('d')}, ${accountId}, 'ACTIVE', '2026-09-04T13:30:00.000Z'::timestamptz, ${hash('e')}, NULL, ${hash('f')}, '2026-09-04T16:30:00.000Z'::timestamptz)`
              yield* sql`INSERT INTO intents (intent_id, cycle_id) VALUES (${hash('0')}, ${hash('7')})`

              const withDurableAndPastFacts = yield* readForwardPerformanceUnclosedCycleCount(
                sql,
                accountId,
                authorityGenerationHash,
              )
              return { withoutReconciliation, withoutFutureFacts, withDurableAndPastFacts }
            }),
          )
        }),
      )

      expect(counts).toEqual({ withoutReconciliation: 1, withoutFutureFacts: 0, withDurableAndPastFacts: 4 })
    } finally {
      await runtime.dispose()
    }
  })

  test('counts pre-created unfinished cycles by their durable generation binding', async () => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw new Error('BAYN_TEST_POSTGRES_URL must target an isolated local _test database')
    const runtime = ManagedRuntime.make(PostgresClientLive(config).pipe(Layer.provideMerge(NodeServices.layer)))
    const accountId = 'precreated-cycle-account'
    const generationHash = hash('a')
    const planHash = hash('b')
    const cycleId = hash('c')
    const decisionHash = hash('d')
    try {
      const counts = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`CREATE TEMP TABLE authority_generations (
                generation_hash text, maximum text, account_id text, qualification_run_id text,
                research_plan_hash text, activated_at timestamptz, previous_generation_hash text
              ) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE reconciliations (
                reconciliation_id text, account_id text, reconciled_at timestamptz
              ) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE autonomous_cycles (
                cycle_id text, account_id text, state text, submission_open_at timestamptz,
                decision_hash text, qualification_run_id text, created_at timestamptz
              ) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE autonomous_cycle_shadow_decisions (
                cycle_id text, decision_hash text, schema_version text, document jsonb
              ) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE intents (
                cycle_id text, account_id text, authority_generation_hash text
              ) ON COMMIT DROP`
              yield* sql`INSERT INTO authority_generations VALUES (
                ${generationHash}, 'PAPER', ${accountId}, NULL, ${planHash}, '2026-09-04T00:00:00Z', NULL
              )`
              yield* sql`INSERT INTO reconciliations VALUES (
                ${hash('e')}, ${accountId}, '2026-09-04T21:00:00Z'
              )`
              yield* sql`INSERT INTO autonomous_cycles VALUES (
                ${cycleId}, ${accountId}, 'ACTIVE', '2026-09-04T13:30:00Z', ${decisionHash},
                ${planHash}, '2026-09-03T19:00:00Z'
              )`
              const readCount = readForwardPerformanceUnclosedCycleCount(sql, accountId, generationHash)
              const unbound = yield* readCount
              const accountWide = yield* readForwardPerformanceUnclosedCycleCount(sql, accountId)
              const decision = (binding: string) => ({
                mode: 'PAPER',
                bindings: { accountId, qualificationRunId: planHash, authorityGenerationHash: binding },
              })
              yield* sql`INSERT INTO autonomous_cycle_shadow_decisions VALUES (
                ${cycleId}, ${decisionHash}, 'bayn.paper-cycle-decision.v2', ${JSON.stringify(decision(hash('f')))}::jsonb
              )`
              const foreignDecision = yield* readCount
              yield* sql`UPDATE autonomous_cycle_shadow_decisions
                SET document = ${JSON.stringify(decision(generationHash))}::jsonb`
              const activeDecision = yield* readCount
              yield* sql`UPDATE autonomous_cycles SET state = 'PENDING'`
              const pendingDecision = yield* readCount
              yield* sql`UPDATE autonomous_cycles SET state = 'BLOCKED'`
              const blockedDecision = yield* readCount
              yield* sql`UPDATE autonomous_cycles SET state = 'ACTIVE', submission_open_at = '2026-09-08T13:30:00Z'`
              const futureBoundDecision = yield* readCount
              yield* sql`INSERT INTO authority_generations VALUES (
                ${hash('f')}, 'PAPER', ${accountId}, NULL, ${planHash}, '2026-09-05T00:00:00Z', ${generationHash}
              )`
              const afterSuccessor = yield* readCount
              const foreignGeneration = yield* readForwardPerformanceUnclosedCycleCount(sql, accountId, hash('f'))
              const foreignAccount = yield* readForwardPerformanceUnclosedCycleCount(sql, 'foreign', generationHash)
              yield* sql`UPDATE autonomous_cycles SET decision_hash = NULL`
              yield* sql`INSERT INTO intents VALUES (${cycleId}, ${accountId}, ${generationHash})`
              const boundIntent = yield* readCount
              yield* sql`UPDATE autonomous_cycles SET state = 'PENDING'`
              const pendingIntent = yield* readCount
              yield* sql`UPDATE autonomous_cycles SET state = 'BLOCKED'`
              const blockedIntent = yield* readCount
              yield* sql`UPDATE autonomous_cycles SET state = 'ACTIVE'`
              yield* sql`UPDATE intents SET account_id = 'foreign'`
              const foreignIntentAccount = yield* readCount
              yield* sql`UPDATE intents SET account_id = ${accountId}, authority_generation_hash = ${hash('f')}`
              const foreignIntentGeneration = yield* readCount
              yield* sql`UPDATE intents SET authority_generation_hash = ${generationHash}`
              yield* sql`UPDATE autonomous_cycles SET state = 'COMPLETED'`
              const completed = yield* readCount
              return {
                unbound,
                accountWide,
                foreignDecision,
                activeDecision,
                pendingDecision,
                blockedDecision,
                futureBoundDecision,
                afterSuccessor,
                foreignGeneration,
                foreignAccount,
                boundIntent,
                pendingIntent,
                blockedIntent,
                foreignIntentAccount,
                foreignIntentGeneration,
                completed,
              }
            }),
          )
        }),
      )
      expect(counts).toEqual({
        unbound: 0,
        accountWide: 1,
        foreignDecision: 0,
        activeDecision: 1,
        pendingDecision: 1,
        blockedDecision: 1,
        futureBoundDecision: 1,
        afterSuccessor: 1,
        foreignGeneration: 0,
        foreignAccount: 0,
        boundIntent: 1,
        pendingIntent: 1,
        blockedIntent: 1,
        foreignIntentAccount: 0,
        foreignIntentGeneration: 0,
        completed: 0,
      })
    } finally {
      await runtime.dispose()
    }
  })
})
