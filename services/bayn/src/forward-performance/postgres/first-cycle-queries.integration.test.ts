import { describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect'
import { PostgresClientLive } from '../../db/postgres-client'
import { baynTestPostgresUrl } from '../../test-environment.test-support'
import { firstCycleQuery, readForwardPerformanceCycles } from './cycles'
import { ledgerReceiptQuery, ledgerTransactionQuery, receiptQuery, transactionQuery } from './queries'
import { readForwardPerformanceStrategyRows } from './read'

const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const hash = (value: number) => value.toString(16).padStart(64, '0')
const preciseTime = (micros: string) => '2026-09-04T14:00:00.' + micros + 'Z'

describePostgres('Forward-performance captured cycle query boundaries', () => {
  test('preserves independent strategy and accounting reads while eliminating repeated scoped selection', async () => {
    const url = baynTestPostgresUrl ?? ''
    const parsed = new URL(url)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local test database')
    const runtime = ManagedRuntime.make(
      PostgresClientLive(
        {
          operationTimeoutMs: 5_000,
          postgres: { url: Redacted.make(url), tls: false, caPath: '/unused' },
        },
        { maxConnections: 1, applicationName: 'bayn-captured-cycle-queries-test' },
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    )
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          // Fixture writes finish before the read-only snapshot, on the same owned connection.
          yield* sql`CREATE TEMP TABLE autonomous_cycles (
            cycle_id text PRIMARY KEY, account_id text, qualification_run_id text, strategy_name text,
            strategy_protocol_hash text, execution_policy_hash text, strategy_execution_model_hash text,
            decision_hash text, state text, submission_open_at timestamptz, terminal_at timestamptz,
            created_at timestamptz
          )`
          yield* sql`CREATE TEMP TABLE authority_generations (
            generation_hash text PRIMARY KEY, account_id text, qualification_run_id text, research_plan_hash text,
            strategy_name text, strategy_protocol_hash text, strategy_behavior_hash text,
            strategy_parameter_hash text, strategy_parameter_schema_version text,
            activation_source_revision text, activation_image_repository text, activation_image_digest text,
            activation_schema_version text, maximum text, activated_at timestamptz, previous_generation_hash text
          )`
          yield* sql`CREATE TEMP TABLE autonomous_cycle_shadow_decisions (
            cycle_id text, decision_hash text, schema_version text, document jsonb
          )`
          yield* sql`CREATE TEMP TABLE intents (
            intent_id text PRIMARY KEY, cycle_id text, account_id text, authority_generation_hash text
          )`
          yield* sql`CREATE TEMP TABLE qualification_results (run_id text, verdict text, lock_id text)`
          yield* sql`CREATE TEMP TABLE qualification_locks (
            lock_id text, protocol_hash text, source_revision text, image_repository text, image_digest text
          )`
          yield* sql`CREATE TEMP TABLE evaluation_runs (
            run_id text, strategy_name text, source_revision text, image_repository text, image_digest text,
            protocol_hash text, status text
          )`
          yield* sql`CREATE TEMP TABLE protocol_locks (
            protocol_hash text, behavior_hash text, parameter_hash text, schema_version text
          )`
          yield* sql`CREATE TEMP TABLE reconciliations (
            reconciliation_id text PRIMARY KEY, account_id text, reconciled_at timestamptz
          )`
          yield* sql`CREATE TEMP TABLE account_snapshots (event_id text, account_id text)`
          yield* sql`CREATE TEMP TABLE broker_events (
            event_id text PRIMARY KEY, account_id text, event_kind text, observed_at timestamptz, source_sequence bigint
          )`
          yield* sql`CREATE TEMP TABLE accounting_transactions (
            schema_version text, transaction_id text PRIMARY KEY, broker_event_id text, intent_id text, account_id text,
            symbol text, side text, quantity_atoms bigint, price_atoms bigint, notional_micros bigint,
            fee_micros bigint, cost_basis_micros bigint, realized_pnl_micros bigint, quantity_delta_atoms bigint,
            cost_basis_delta_micros bigint, cash_delta_micros bigint, ledger_plan_hash text, content_hash text,
            occurred_at timestamptz
          )`
          yield* sql`CREATE TEMP TABLE accounting_receipts (
            schema_version text, receipt_id text PRIMARY KEY, intent_id text, broker_event_id text,
            tigerbeetle_cluster_id bigint, tigerbeetle_ledger integer, account_ids bigint[], transfer_ids bigint[],
            debit_micros bigint, credit_micros bigint, content_hash text, recorded_at timestamptz
          )`
          for (const [id, account, maximum, activatedAt, previous] of [
            [100, 'account', 'PAPER', '2026-09-04T13:00:00Z', null],
            [101, 'account', 'PAPER', '2026-09-04T14:30:00Z', 100],
            [102, 'foreign', 'PAPER', '2026-09-04T13:00:00Z', null],
            [103, 'account', 'OBSERVE', '2026-09-04T16:00:00Z', 101],
          ] as const)
            yield* sql`INSERT INTO authority_generations VALUES (
              ${hash(id)}, ${account}, NULL, ${hash(200)}, 'research', ${hash(400)},
              ${hash(401)}, ${hash(402)}, 'parameters.v1', 'research-source', 'registry/bayn',
              ${'sha256:' + hash(403)}, 'bayn.paper-authority-generation.v3', ${maximum},
              ${activatedAt}::timestamptz, ${previous === null ? null : hash(previous)}
            )`
          const cycleFixtures = [
            { id: 40, generation: 100, state: 'NO_TRADE', at: preciseTime('000001'), plan: 200 },
            { id: 50, generation: 100, state: 'COMPLETED', at: preciseTime('000001'), plan: 200 },
            { id: 1, generation: 100, state: 'COMPLETED', at: preciseTime('000002'), plan: 200 },
            { id: 60, generation: 101, state: 'COMPLETED', at: '2026-09-04T14:30:00Z', plan: 200 },
            { id: 61, generation: 101, state: 'NO_TRADE', at: '2026-09-04T14:31:00Z', plan: 200 },
            { id: 0, generation: 100, state: 'ACTIVE', at: '2026-09-04T12:00:00Z', plan: 200 },
            { id: 2, generation: 100, state: 'PENDING', at: '2026-09-04T12:01:00Z', plan: 200 },
            { id: 3, generation: 100, state: 'BLOCKED', at: '2026-09-04T12:02:00Z', plan: 200 },
            { id: 70, generation: 100, state: 'COMPLETED', at: '2026-09-04T13:00:00Z', plan: 201 },
            { id: 9, generation: 102, state: 'COMPLETED', at: '2026-09-04T13:08:00Z', plan: 200 },
            { id: 10, generation: 103, state: 'COMPLETED', at: '2026-09-04T16:01:00Z', plan: 200 },
          ] as const
          for (const fixture of cycleFixtures) {
            const account = fixture.generation === 102 ? 'foreign' : 'account'
            yield* sql`INSERT INTO autonomous_cycles VALUES (
              ${hash(fixture.id)}, ${account}, ${hash(fixture.plan)}, 'research', ${hash(400)},
              ${hash(401)}, ${hash(402)}, ${hash(500 + fixture.id)}, ${fixture.state},
              ${fixture.at}::timestamptz, ${fixture.at}::timestamptz + INTERVAL '1 minute',
              '2026-09-03T12:00:00Z'
            )`
            yield* sql`INSERT INTO autonomous_cycle_shadow_decisions VALUES (
              ${hash(fixture.id)}, ${hash(500 + fixture.id)}, 'bayn.paper-cycle-decision.v2',
              ${sql.json({
                mode: 'PAPER',
                bindings: {
                  accountId: account,
                  qualificationRunId: hash(fixture.plan),
                  authorityGenerationHash: hash(fixture.generation),
                },
              })}
            )`
          }
          yield* sql`INSERT INTO qualification_results VALUES (${hash(201)}, 'QUALIFIED', ${hash(202)})`
          yield* sql`INSERT INTO qualification_locks VALUES (
            ${hash(202)}, ${hash(400)}, 'qualified-source', 'registry/bayn', ${'sha256:' + hash(404)}
          )`
          yield* sql`INSERT INTO evaluation_runs VALUES (
            ${hash(201)}, 'qualified', 'qualified-source', 'registry/bayn', ${'sha256:' + hash(404)},
            ${hash(400)}, 'COMPLETE'
          )`
          yield* sql`INSERT INTO protocol_locks VALUES (
            ${hash(400)}, ${hash(401)}, ${hash(402)}, 'parameters.v1'
          )`
          for (const [id, account, at] of [
            [800, 'account', '2026-09-04T14:15:00Z'],
            [801, 'account', '2026-09-04T15:00:00Z'],
            [802, 'foreign', '2026-09-04T14:15:00Z'],
            [803, 'empty', '2026-09-04T14:15:00Z'],
          ] as const)
            yield* sql`INSERT INTO reconciliations VALUES (${hash(id)}, ${account}, ${at}::timestamptz)`
          for (const [id, account, at] of [
            [900, 'account', '2026-09-04T12:59:00Z'],
            [901, 'account', preciseTime('000000')],
            [902, 'account', preciseTime('000001')],
            [903, 'account', preciseTime('000002')],
            [904, 'account', '2026-09-04T14:30:00Z'],
            [905, 'account', '2026-09-04T15:01:00Z'],
            [906, 'foreign', '2026-09-04T13:08:00Z'],
            [907, 'empty', '2026-09-04T13:00:00Z'],
          ] as const) {
            yield* sql`INSERT INTO broker_events VALUES (
              ${hash(id)}, ${account}, 'ACCOUNT', ${at}::timestamptz, ${id}
            )`
            yield* sql`INSERT INTO account_snapshots VALUES (${hash(id)}, ${account})`
          }
          const transactions = [
            { id: 301, cycle: 50, generation: 100, account: 'account', at: preciseTime('000000') },
            { id: 302, cycle: 50, generation: 100, account: 'account', at: preciseTime('000001') },
            { id: 303, cycle: 1, generation: 100, account: 'account', at: preciseTime('000002') },
            { id: 304, cycle: 1, generation: 100, account: 'account', at: '2026-09-04T14:15:00Z' },
            { id: 305, cycle: 1, generation: 100, account: 'account', at: '2026-09-04T14:15:00.000001Z' },
            { id: 310, cycle: 60, generation: 101, account: 'account', at: '2026-09-04T14:29:59Z' },
            { id: 311, cycle: 60, generation: 101, account: 'account', at: '2026-09-04T14:30:00Z' },
            { id: 312, cycle: 60, generation: 101, account: 'account', at: '2026-09-04T15:00:00Z' },
            { id: 313, cycle: 60, generation: 101, account: 'account', at: '2026-09-04T15:00:00.000001Z' },
            { id: 321, cycle: 9, generation: 102, account: 'foreign', at: '2026-09-04T13:08:00Z' },
            { id: 331, cycle: 99, generation: 999, account: 'empty', at: '2026-09-04T13:08:00Z' },
          ] as const
          for (const transaction of transactions) {
            yield* sql`INSERT INTO intents VALUES (
              ${hash(1000 + transaction.id)}, ${hash(transaction.cycle)}, ${transaction.account},
              ${hash(transaction.generation)}
            )`
            yield* sql`INSERT INTO accounting_transactions VALUES (
              'bayn.accounting-transaction.v1', ${hash(transaction.id)}, ${hash(2000 + transaction.id)},
              ${hash(1000 + transaction.id)}, ${transaction.account}, 'AAPL', 'BUY', 1, 2, 3, 4, 5, 6, 1, 5, -7,
              ${hash(600)}, ${hash(601)}, ${transaction.at}::timestamptz
            )`
            yield* sql`INSERT INTO accounting_receipts VALUES (
              'bayn.accounting-receipt.v1', ${hash(3000 + transaction.id)}, ${hash(1000 + transaction.id)},
              ${hash(2000 + transaction.id)}, 0, 1, ARRAY[2,1], ARRAY[4,3], 7, 7,
              ${hash(602)}, ${transaction.at}::timestamptz
            )`
          }
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`
              const scopes = [
                { name: 'retained', account: 'account', generation: hash(100) },
                { name: 'current', account: 'account', generation: hash(101) },
                { name: 'unscoped', account: 'account', generation: undefined },
                { name: 'foreign', account: 'foreign', generation: hash(102) },
                { name: 'wrong-account', account: 'foreign', generation: hash(100) },
                { name: 'missing-generation', account: 'account', generation: hash(999) },
                { name: 'observe-generation', account: 'account', generation: hash(103) },
                { name: 'empty-account', account: 'empty', generation: undefined },
              ] as const
              const readCount = sql<{ count: string }>`SELECT (
                pg_stat_get_xact_tuples_returned('autonomous_cycle_shadow_decisions'::regclass) +
                pg_stat_get_xact_tuples_fetched('autonomous_cycle_shadow_decisions'::regclass)
              )::text AS count`
              const cases = yield* Effect.forEach(scopes, (scope) =>
                Effect.gen(function* () {
                  const captured = yield* readForwardPerformanceCycles(sql, scope.account, scope.generation)
                  const [beforeStrategy] = yield* readCount
                  const independentStrategy = yield* readForwardPerformanceStrategyRows(
                    sql,
                    scope.account,
                    scope.generation,
                  )
                  const [beforeIndependent] = yield* readCount
                  const independentBoundary = yield* sql<{ cycle_id: string; boundary: string }>`
                    SELECT cycle_id, to_char(submission_open_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS boundary
                    FROM (${firstCycleQuery(sql, scope.account, scope.generation)}) AS first_cycle
                  `
                  const independentTransactions = yield* transactionQuery(sql, scope.account, scope.generation)
                  const independentReceipts = yield* receiptQuery(sql, scope.account, scope.generation)
                  const [beforeCaptured] = yield* readCount
                  const capturedBoundary = yield* sql<{ cycle_id: string; boundary: string }>`
                    SELECT cycle_id, to_char(submission_open_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS boundary
                    FROM (${firstCycleQuery(sql, scope.account, scope.generation, captured)}) AS first_cycle
                  `
                  const capturedTransactions = yield* transactionQuery(sql, scope.account, scope.generation, captured)
                  const capturedReceipts = yield* receiptQuery(sql, scope.account, scope.generation, captured)
                  const [afterCaptured] = yield* readCount
                  const capturedStrategy = yield* readForwardPerformanceStrategyRows(
                    sql,
                    scope.account,
                    scope.generation,
                    captured,
                  )
                  const [afterStrategy] = yield* readCount
                  return {
                    ...scope,
                    captured,
                    independentBoundary,
                    capturedBoundary,
                    independentTransactions,
                    capturedTransactions,
                    independentReceipts,
                    capturedReceipts,
                    independentStrategy,
                    capturedStrategy,
                    independentReads: Number(beforeCaptured?.count) - Number(beforeIndependent?.count),
                    capturedReads: Number(afterCaptured?.count) - Number(beforeCaptured?.count),
                    independentStrategyReads: Number(beforeIndependent?.count) - Number(beforeStrategy?.count),
                    capturedStrategyReads: Number(afterStrategy?.count) - Number(afterCaptured?.count),
                  }
                }),
              )
              const explicitlyEmpty = {
                strategy: yield* readForwardPerformanceStrategyRows(sql, 'account', hash(100), []),
                transactions: yield* transactionQuery(sql, 'account', hash(100), []),
                receipts: yield* receiptQuery(sql, 'account', hash(100), []),
              }
              const accountCut = new Date('2026-09-04T15:00:00Z')
              const ledgerTransactions = yield* ledgerTransactionQuery(sql, 'account', accountCut)
              const ledgerReceipts = yield* ledgerReceiptQuery(sql, 'account', accountCut)
              return { cases, explicitlyEmpty, ledgerTransactions, ledgerReceipts }
            }),
          )
        }),
      )
      for (const scope of result.cases) {
        expect(scope.capturedBoundary).toEqual(scope.independentBoundary)
        expect(scope.capturedStrategy).toEqual(scope.independentStrategy)
        expect(scope.capturedTransactions).toEqual(scope.independentTransactions)
        expect(scope.capturedReceipts).toEqual(scope.independentReceipts)
        expect(scope.capturedReads).toBe(0)
      }
      const retained = result.cases.find((scope) => scope.name === 'retained')
      expect(retained?.captured.map((cycle) => cycle.cycle_id)).toEqual([hash(40), hash(50), hash(1)])
      expect(retained?.captured.map((cycle) => cycle.submission_open_at.getTime())).toEqual(
        Array.from({ length: 3 }, () => Date.parse(preciseTime('000000'))),
      )
      expect(retained?.capturedBoundary).toEqual([{ cycle_id: hash(40), boundary: preciseTime('000001') }])
      expect(retained?.independentReads).toBeGreaterThan(0)
      expect(retained?.capturedStrategyReads).toBeGreaterThan(0)
      expect(retained?.capturedStrategyReads).toBeLessThan(retained?.independentStrategyReads ?? 0)
      expect(retained?.capturedStrategy[0]?.strategy_name).toBe('research')
      const expectedTransactions = {
        retained: [302, 303, 304],
        current: [311, 312],
        unscoped: [301, 302, 303, 304, 305, 310, 311, 312],
        foreign: [321],
        'wrong-account': [],
        'missing-generation': [],
        'observe-generation': [],
        'empty-account': [],
      }
      for (const scope of result.cases) {
        const expected = expectedTransactions[scope.name]
        expect(scope.capturedTransactions.map((transaction) => transaction['transaction_id'])).toEqual(
          expected.map(hash),
        )
        expect(scope.capturedReceipts.map((receipt) => receipt['receipt_id'])).toEqual(
          expected.map((id) => hash(3000 + id)),
        )
        if (expected.length === 0) expect(scope.capturedStrategy).toEqual([])
      }
      expect(result.cases.find((scope) => scope.name === 'current')?.captured.map((cycle) => cycle.cycle_id)).toEqual([
        hash(60),
        hash(61),
      ])
      expect(result.cases.find((scope) => scope.name === 'current')?.capturedStrategy[0]?.strategy_name).toBe(
        'research',
      )
      expect(result.cases.find((scope) => scope.name === 'unscoped')?.capturedStrategy[0]?.strategy_name).toBe(
        'qualified',
      )
      expect(result.cases.find((scope) => scope.name === 'foreign')?.capturedStrategy[0]?.strategy_name).toBe(
        'research',
      )
      expect(result.explicitlyEmpty).toEqual({ strategy: [], transactions: [], receipts: [] })
      expect(result.ledgerTransactions.map((transaction) => transaction['transaction_id'])).toEqual(
        expectedTransactions.unscoped.map(hash),
      )
      expect(result.ledgerReceipts.map((receipt) => receipt['receipt_id'])).toEqual(
        expectedTransactions.unscoped.map((id) => hash(3000 + id)),
      )
    } finally {
      await runtime.dispose()
    }
  })
})
