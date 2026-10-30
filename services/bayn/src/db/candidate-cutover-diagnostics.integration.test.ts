import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted, Result, Schema } from 'effect'
import { SqlClient } from 'effect/sql'

import candidateEntryEvidence from '../../migrations/0166_candidate_entry_evidence'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { PostgresClientLive } from './postgres-client'

const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const admitted = { _tag: 'CutoverGuardAdmitted' } as const
const fixtureBlock = (seed: string) => `DO $fixture$ BEGIN ${seed.replace(/;$/, '')}; END $fixture$`

test.each(['PERFORM 1', 'PERFORM 1;'])('fixture terminator is normalized: %s', (seed) => {
  expect(fixtureBlock(seed)).toBe('DO $fixture$ BEGIN PERFORM 1; END $fixture$')
})

const cases = [
  {
    name: 'nonterminal intent',
    seed: "INSERT INTO intents VALUES ('i','PLANNED','a')",
    labels: ['nonterminal_intents'],
  },
  {
    name: 'pending cycle',
    seed: "INSERT INTO autonomous_cycles VALUES ('PENDING')",
    labels: ['pending_or_active_cycles'],
  },
  {
    name: 'active cycle',
    seed: "INSERT INTO autonomous_cycles VALUES ('ACTIVE')",
    labels: ['pending_or_active_cycles'],
  },
  {
    name: 'inventory quantity',
    seed: "INSERT INTO accounting_transactions VALUES ('a','X',1,0,'e'); INSERT INTO accounting_receipts VALUES ('e','r')",
    labels: ['nonflat_accounting_inventory'],
  },
  {
    name: 'inventory cost',
    seed: "INSERT INTO accounting_transactions VALUES ('a','X',0,1,'e'); INSERT INTO accounting_receipts VALUES ('e','r')",
    labels: ['nonflat_accounting_inventory'],
  },
  {
    name: 'posted debit',
    seed: "INSERT INTO broker_inventory_debits VALUES ('a','X',1,1,true)",
    labels: ['nonflat_accounting_inventory'],
  },
  {
    name: 'position snapshot',
    seed: "INSERT INTO position_snapshots VALUES ('a',1,clock_timestamp(),'s')",
    labels: ['nonflat_latest_positions'],
  },
  {
    name: 'missing receipt',
    seed: "INSERT INTO accounting_transactions VALUES ('a','X',0,0,'e')",
    labels: ['transactions_without_receipts'],
  },
  {
    name: 'missing accounting',
    seed: "INSERT INTO fills VALUES ('e')",
    labels: ['fills_without_accounting'],
  },
  {
    name: 'order NEW',
    seed: "INSERT INTO orders VALUES ('a','o','NEW','e'); INSERT INTO broker_events VALUES ('e',1)",
    labels: ['unsettled_latest_orders'],
  },
  {
    name: 'order PENDING',
    seed: "INSERT INTO orders VALUES ('a','o','PENDING','e'); INSERT INTO broker_events VALUES ('e',1)",
    labels: ['unsettled_latest_orders'],
  },
  {
    name: 'order PARTIALLY_FILLED',
    seed: "INSERT INTO orders VALUES ('a','o','PARTIALLY_FILLED','e'); INSERT INTO broker_events VALUES ('e',1)",
    labels: ['unsettled_latest_orders'],
  },
  {
    name: 'order HELD',
    seed: "INSERT INTO orders VALUES ('a','o','HELD','e'); INSERT INTO broker_events VALUES ('e',1)",
    labels: ['unsettled_latest_orders'],
  },
  {
    name: 'missing reconciliation',
    seed: 'DELETE FROM reconciliations',
    labels: ['paper_reconciliation'],
  },
  {
    name: 'nonexact reconciliation',
    seed: "UPDATE reconciliations SET status='DISCREPANCY'",
    labels: ['paper_reconciliation'],
  },
  {
    name: 'null reconciliation time',
    seed: 'UPDATE reconciliations SET reconciled_at=NULL',
    labels: ['paper_reconciliation'],
  },
  {
    name: 'future reconciliation',
    seed: "UPDATE reconciliations SET reconciled_at=clock_timestamp()+interval '1 hour'",
    labels: ['paper_reconciliation'],
  },
  {
    name: 'stale reconciliation',
    seed: "UPDATE reconciliations SET reconciled_at=clock_timestamp()-interval '61 seconds'",
    labels: ['paper_reconciliation'],
  },
  {
    name: 'post-reconciliation mutation',
    seed: "INSERT INTO intents VALUES ('i','TERMINAL','a'); INSERT INTO mutation_events VALUES ('i',clock_timestamp()+interval '1 second')",
    labels: ['paper_reconciliation'],
  },
  {
    name: 'unexpired inference',
    seed: "INSERT INTO jev_evaluation_requests VALUES ('q',jsonb_build_object('expiresAt',clock_timestamp()+interval '1 hour'))",
    labels: ['unexpired_unresolved_inference'],
  },
  {
    name: 'multiple blockers',
    seed: "INSERT INTO intents VALUES ('i','PLANNED','a'); INSERT INTO autonomous_cycles VALUES ('ACTIVE'); DELETE FROM reconciliations",
    labels: ['nonterminal_intents', 'pending_or_active_cycles', 'paper_reconciliation'],
  },
  {
    name: 'clean',
    seed: '',
    labels: [],
  },
  {
    name: 'terminal rows',
    seed: "INSERT INTO intents VALUES ('i','TERMINAL','a'); INSERT INTO autonomous_cycles VALUES ('BLOCKED')",
    labels: [],
  },
  {
    name: 'balanced inventory',
    seed: "INSERT INTO accounting_transactions VALUES ('a','X',1,2,'e'); INSERT INTO accounting_receipts VALUES ('e','r'); INSERT INTO broker_inventory_debits VALUES ('a','X',1,2,true)",
    labels: [],
  },
  {
    name: 'unposted debit',
    seed: "INSERT INTO broker_inventory_debits VALUES ('a','X',1,2,false)",
    labels: [],
  },
  {
    name: 'latest position flat',
    seed: "INSERT INTO position_snapshots VALUES ('a',1,clock_timestamp()-interval '1 second','s1'),('a',0,clock_timestamp(),'s2')",
    labels: [],
  },
  {
    name: 'settled latest order',
    seed: "INSERT INTO orders VALUES ('a','o','NEW','e1'),('a','o','FILLED','e2'); INSERT INTO broker_events VALUES ('e1',1),('e2',2)",
    labels: [],
  },
  {
    name: 'expired inference',
    seed: "INSERT INTO jev_evaluation_requests VALUES ('q',jsonb_build_object('expiresAt',clock_timestamp()-interval '1 second'))",
    labels: [],
  },
  {
    name: 'resolved future inference',
    seed: "INSERT INTO jev_evaluation_requests VALUES ('q',jsonb_build_object('expiresAt',clock_timestamp()+interval '1 hour')); INSERT INTO jev_evaluation_resolutions VALUES ('q')",
    labels: [],
  },
  {
    name: 'observe authority without reconciliation',
    seed: "UPDATE authority_state SET maximum='OBSERVE'; DELETE FROM reconciliations",
    labels: [],
  },
  {
    name: 'expiry crosses during diagnostics',
    seed: "UPDATE authority_state SET maximum='OBSERVE';\nINSERT INTO jev_evaluation_requests VALUES ('q','{\"expiresAt\":\"2050-01-01T00:00:00Z\"}');\nCREATE TEMP TABLE diagnostic_clock(calls integer) ON COMMIT DROP;\nINSERT INTO diagnostic_clock VALUES (0);\nCREATE SCHEMA candidate_guard_clock;\nCREATE FUNCTION candidate_guard_clock.clock_timestamp() RETURNS timestamptz LANGUAGE plpgsql VOLATILE AS $clock$ DECLARE n integer; BEGIN UPDATE diagnostic_clock SET calls=calls+1 RETURNING calls INTO n; RETURN CASE WHEN n=1 THEN '2000-01-01'::timestamptz ELSE '2100-01-01'::timestamptz END; END $clock$;\nSET LOCAL search_path=candidate_guard_clock,pg_temp,public,pg_catalog;",
    labels: ['guard_changed_during_diagnosis'],
  },
  {
    name: 'diagnostic error retains original rejection',
    seed: "UPDATE authority_state SET maximum='OBSERVE';\nINSERT INTO jev_evaluation_requests VALUES ('q','{\"expiresAt\":\"2050-01-01T00:00:00Z\"}');\nCREATE TEMP TABLE diagnostic_clock(calls integer) ON COMMIT DROP;\nINSERT INTO diagnostic_clock VALUES (0);\nCREATE SCHEMA candidate_guard_clock;\nCREATE FUNCTION candidate_guard_clock.clock_timestamp() RETURNS timestamptz LANGUAGE plpgsql VOLATILE AS $clock$ DECLARE n integer; BEGIN UPDATE diagnostic_clock SET calls=calls+1 RETURNING calls INTO n; IF n>1 THEN RAISE EXCEPTION 'private fixture content must not escape'; END IF; RETURN '2000-01-01'::timestamptz; END $clock$;\nSET LOCAL search_path=candidate_guard_clock,pg_temp,public,pg_catalog;",
    labels: ['unavailable'],
  },
]

describePostgres('candidate cutover failure diagnostics', () => {
  let runtime: ManagedRuntime.ManagedRuntime<PgClient.PgClient | SqlClient.SqlClient, unknown>
  beforeAll(() => {
    const url = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test'))
      throw new Error('Migration tests require a local _test database')
    runtime = ManagedRuntime.make(
      PostgresClientLive({
        operationTimeoutMs: 10_000,
        postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
      }).pipe(Layer.provideMerge(NodeServices.layer)),
    )
  })
  afterAll(async () => {
    await runtime.dispose()
  })

  test.each(cases)('$name preserves admission and atomicity', async ({ seed, labels }) => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql.withTransaction(
          Effect.gen(function* () {
            // Transaction-local shadow tables exercise the real migration guard without touching live data.
            yield* sql.unsafe(`DO $fixture$ BEGIN
          CREATE TEMP TABLE intents(intent_id text,state text,account_id text) ON COMMIT DROP;
          CREATE TEMP TABLE autonomous_cycles(state text) ON COMMIT DROP;
          CREATE TEMP TABLE accounting_transactions(account_id text,symbol text,quantity_delta_atoms bigint,cost_basis_delta_micros bigint,broker_event_id text,transaction_id text DEFAULT 't') ON COMMIT DROP;
          CREATE TEMP TABLE broker_inventory_debits(account_id text,symbol text,quantity_atoms bigint,cost_basis_micros bigint,posted boolean) ON COMMIT DROP;
          CREATE TEMP TABLE position_snapshots(account_id text,position_count integer,observed_at timestamptz,snapshot_id text) ON COMMIT DROP;
          CREATE TEMP TABLE accounting_receipts(broker_event_id text,receipt_id text) ON COMMIT DROP;
          CREATE TEMP TABLE fills(event_id text) ON COMMIT DROP;
          CREATE TEMP TABLE orders(account_id text,broker_order_id text,status text,event_id text) ON COMMIT DROP;
          CREATE TEMP TABLE broker_events(event_id text,source_sequence bigint) ON COMMIT DROP;
          CREATE TEMP TABLE authority_generations(generation_hash text,account_id text) ON COMMIT DROP;
          CREATE TEMP TABLE authority_state(generation_hash text,maximum text,effective text,kill_state text,version bigint) ON COMMIT DROP;
          CREATE TEMP TABLE reconciliations(account_id text,status text,reconciled_at timestamptz,reconciliation_id text) ON COMMIT DROP;
          CREATE TEMP TABLE mutation_events(intent_id text,occurred_at timestamptz) ON COMMIT DROP;
          CREATE TEMP TABLE jev_evaluation_requests(request_id text,payload jsonb) ON COMMIT DROP;
          CREATE TEMP TABLE jev_evaluation_resolutions(request_id text) ON COMMIT DROP;
          CREATE TEMP TABLE jev_evaluation_receipts(unused integer) ON COMMIT DROP;
          CREATE TEMP TABLE jev_inference_handoffs(unused integer) ON COMMIT DROP;
          CREATE TEMP TABLE jev_chart_dispatch_claims(unused integer) ON COMMIT DROP;
          CREATE TEMP TABLE jev_chart_terminal_receipts(unused integer) ON COMMIT DROP;
          CREATE TEMP TABLE inference_expense_quotes(unused integer) ON COMMIT DROP;
          CREATE TEMP TABLE jev_staged_dispatch_claims(unused integer) ON COMMIT DROP;
          CREATE TEMP TABLE jev_staged_terminal_receipts(unused integer) ON COMMIT DROP;
          CREATE TEMP TABLE jev_staged_skip_receipts(unused integer) ON COMMIT DROP;
          INSERT INTO authority_generations VALUES ('g','a');
          INSERT INTO authority_state VALUES ('g','PAPER','PAPER','CLEAR',1);
          INSERT INTO reconciliations VALUES ('a','EXACT',clock_timestamp(),'r');
          END $fixture$;
        `)
            if (seed !== '') yield* sql.unsafe(fixtureBlock(seed))
            const before = yield* sql`SELECT * FROM authority_state`
            let statements = 0
            const guarded = new Proxy(sql, {
              apply(target, receiver, args) {
                statements++
                // Execute the actual advisory lock, table lock and DO block. Stop before authority UPDATE.
                // Successful full migration/retained bytes are covered by entry-inference-postgres integration.
                return statements === 4 ? Effect.fail(admitted) : Reflect.apply(target, receiver, args)
              },
            })
            const result = yield* sql
              .withTransaction(candidateEntryEvidence.pipe(Effect.provideService(SqlClient.SqlClient, guarded)))
              .pipe(Effect.result)
            if (Result.isSuccess(result)) throw new Error('Expected guard outcome before authority update')
            if (labels.length === 0) {
              expect(result.failure).toEqual(expect.objectContaining(admitted))
              expect(statements).toBe(4)
            } else {
              expect(statements).toBe(3)
              const error = yield* Schema.decodeUnknownEffect(
                Schema.Struct({
                  reason: Schema.Struct({
                    cause: Schema.Struct({
                      code: Schema.Literal('55000'),
                      message: Schema.String,
                      detail: Schema.String,
                    }),
                  }),
                }),
              )(result.failure)
              expect(error.reason.cause.message).toBe(
                'candidate-evidence cutover requires terminal cycles, flat positions, settled orders, fresh exact reconciliation, complete accounting and no unexpired inference claims',
              )
              expect(error.reason.cause.detail).toBe('diagnostic_snapshot: ' + labels.join(','))
            }
            expect(yield* sql`SELECT * FROM authority_state`).toEqual(before)
            if (labels.includes('guard_changed_during_diagnosis') || labels.includes('unavailable'))
              yield* sql`DROP SCHEMA candidate_guard_clock CASCADE`
          }),
        )
      }),
    )
  })
})
