import { describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect'

import { PostgresClientLive } from '../../db/postgres-client'
import { baynTestPostgresUrl } from '../../test-environment.test-support'
import { readForwardPerformanceMarketVolumeBindings, readForwardPerformanceUnclosedCycleCountDataFirst } from './read'
import { completedIntradayCycles } from '../intraday-cycle.test-support'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const config = {
  operationTimeoutMs: 5_000,
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
}

const hash = (character: string): string => character.repeat(64)

describePostgres('Forward-performance PostgreSQL read boundary', () => {
  test('loads the completed native cycles and respects account, terminal state and reconciliation cutoff', async () => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local test database')
    const runtime = ManagedRuntime.make(PostgresClientLive(config).pipe(Layer.provideMerge(NodeServices.layer)))
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
              yield* sql`INSERT INTO reconciliations VALUES ('receipt', 'test-account', '2026-09-11T21:00:00Z')`
              for (const cycle of completedIntradayCycles) {
                yield* sql`INSERT INTO autonomous_cycles VALUES (${cycle.cycleId}, ${cycle.manifest.snapshotId}, 'test-account', 'COMPLETED', ${cycle.session}::date, ${cycle.windowOpenedAt}::timestamptz, ${cycle.windowClosedAt}::timestamptz, ${cycle.windowClosedAt}::timestamptz, ${cycle.windowOpenedAt}::timestamptz)`
                yield* sql`INSERT INTO intraday_snapshot_references VALUES (${cycle.manifest.snapshotId}, ${JSON.stringify(cycle.manifest)}::jsonb)`
              }
              const included = yield* readForwardPerformanceMarketVolumeBindings(sql, 'test-account')
              const otherAccount = yield* readForwardPerformanceMarketVolumeBindings(sql, 'another-account')
              yield* sql`UPDATE reconciliations SET reconciled_at = '2026-09-10T21:00:00Z'`
              const beforeSecondClose = yield* readForwardPerformanceMarketVolumeBindings(sql, 'test-account')
              yield* sql`UPDATE autonomous_cycles SET state = 'ACTIVE'`
              const open = yield* readForwardPerformanceMarketVolumeBindings(sql, 'test-account')
              return { included, otherAccount, beforeSecondClose, open }
            }),
          )
        }),
      )
      expect(rows.included.map((row) => row.cycle_id)).toEqual(completedIntradayCycles.map((cycle) => cycle.cycleId))
      expect(rows.included.every((row) => row.manifest.schemaVersion === 'bayn.intraday-market-snapshot.v1')).toBe(true)
      expect(rows.otherAccount).toHaveLength(0)
      expect(rows.beforeSecondClose.map((row) => row.cycle_id)).toEqual([completedIntradayCycles[0].cycleId])
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
                cycle_id text NOT NULL
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

              const withoutReconciliation = yield* readForwardPerformanceUnclosedCycleCountDataFirst(
                sql,
                accountId,
                authorityGenerationHash,
              )

              yield* sql`INSERT INTO reconciliations (reconciliation_id, account_id, reconciled_at)
                VALUES
                  (${hash('c')}, ${accountId}, '2026-09-04T21:00:00.000Z'::timestamptz),
                  (${hash('d')}, ${accountId}, '2026-09-05T21:00:00.000Z'::timestamptz)`

              const withoutFutureFacts = yield* readForwardPerformanceUnclosedCycleCountDataFirst(
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

              const withDurableAndPastFacts = yield* readForwardPerformanceUnclosedCycleCountDataFirst(
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
})
