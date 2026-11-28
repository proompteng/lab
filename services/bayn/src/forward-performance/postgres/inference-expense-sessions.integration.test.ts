import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Effect, ManagedRuntime, Redacted, Schema } from 'effect'
import { SqlClient } from 'effect/sql'

import inferenceRequestGenerationIndex from '../../../migrations/0187_inference_request_generation_index'
import { baynTestPostgresUrl } from '../../test-environment.test-support'
import { inferenceExpenseSessionQuery } from '../inference-expenses'

const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const Explain = Schema.Array(
  Schema.Struct({
    'QUERY PLAN': Schema.Array(
      Schema.Struct({
        Plan: Schema.Struct({
          'Shared Hit Blocks': Schema.Number,
          'Shared Read Blocks': Schema.Number,
          'Local Hit Blocks': Schema.optionalKey(Schema.Number),
          'Local Read Blocks': Schema.optionalKey(Schema.Number),
        }),
      }),
    ),
  }),
)

describePostgres('inference expense session discovery index', () => {
  let runtime: ManagedRuntime.ManagedRuntime<PgClient.PgClient, unknown>
  beforeAll(() => {
    if (baynTestPostgresUrl === undefined) throw new Error('Missing disposable PostgreSQL endpoint')
    const url = new URL(baynTestPostgresUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test'))
      throw new Error('Inference session tests require an isolated local _test database')
    runtime = ManagedRuntime.make(PgClient.layer({ url: Redacted.make(url.toString()), maxConnections: 1 }))
  })
  afterAll(async () => runtime?.dispose())

  test.each([1, 2000])(
    'generic plans retain complete scope across %d unrelated generations',
    async (generations) => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SET LOCAL plan_cache_mode = force_generic_plan`
              yield* sql`CREATE TEMP TABLE autonomous_cycles (
              cycle_id text PRIMARY KEY, account_id text NOT NULL, execution_session_date date NOT NULL
            ) ON COMMIT DROP`
              yield* sql`CREATE INDEX autonomous_cycles_inference_expense_scope
              ON autonomous_cycles (account_id, execution_session_date, cycle_id)
              WHERE execution_session_date >= DATE '2026-10-05'`
              yield* sql`CREATE TEMP TABLE jev_evaluation_requests (
              request_id text PRIMARY KEY, cycle_id text NOT NULL, authority_generation_hash text NOT NULL,
              snapshot_id text NOT NULL, symbol text NOT NULL,
              UNIQUE (cycle_id, authority_generation_hash, snapshot_id, symbol)
            ) ON COMMIT DROP`
              yield* sql`CREATE INDEX jev_evaluation_requests_cycle ON jev_evaluation_requests (cycle_id)`
              yield* sql`INSERT INTO autonomous_cycles
              SELECT i::text, 'fixture-account', DATE '2026-10-01' + (i % 30)
              FROM generate_series(1, 5000) AS series(i)`
              yield* sql`INSERT INTO jev_evaluation_requests
              SELECT i::text, (i % 5000 + 1)::text, 'other-generation-' || (i % ${generations}::int), i::text, 'QQQ'
              FROM generate_series(1, 200000) AS series(i)`
              yield* sql`INSERT INTO autonomous_cycles
              SELECT 'target-' || i, 'fixture-account', DATE '2026-11-01' + i - 1
              FROM generate_series(1, 5) AS series(i)`
              yield* sql`INSERT INTO jev_evaluation_requests
              SELECT 'target-' || i, 'target-' || i, 'target-generation', i::text, 'QQQ'
              FROM generate_series(1, 5) AS series(i)`
              yield* sql`INSERT INTO autonomous_cycles VALUES ('foreign', 'other-account', DATE '2099-01-01')`
              yield* sql`INSERT INTO jev_evaluation_requests VALUES
              ('foreign', 'foreign', 'target-generation', 'foreign', 'QQQ')`
              yield* sql`ANALYZE autonomous_cycles`
              yield* sql`ANALYZE jev_evaluation_requests`
              const query = inferenceExpenseSessionQuery(sql, 'fixture-account', 'target-generation')
              const [statement] = query.compile()
              yield* sql`PREPARE inference_session_discovery(text, text) AS ${sql.literal(statement)}`
              const buffers = sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
              EXECUTE inference_session_discovery('fixture-account', 'target-generation')`.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Explain)),
                Effect.map((rows) => {
                  const plan = rows[0]?.['QUERY PLAN'][0]?.Plan
                  if (plan === undefined) throw new Error('Missing executed inference session plan')
                  return (
                    plan['Shared Hit Blocks'] +
                    plan['Shared Read Blocks'] +
                    (plan['Local Hit Blocks'] ?? 0) +
                    (plan['Local Read Blocks'] ?? 0)
                  )
                }),
              )
              const expected = Array.from({ length: 5 }, (_, i) => ({ sessionDate: `2026-11-0${i + 1}` }))
              expect(yield* query).toEqual(expected)
              const before = yield* buffers
              expect(before).toBeGreaterThan(1000)
              yield* inferenceRequestGenerationIndex.pipe(Effect.provideService(SqlClient.SqlClient, sql))
              yield* sql`ANALYZE jev_evaluation_requests`
              const after = yield* buffers
              if (generations === 2000) expect(after).toBeLessThan(before / 10)
              expect(yield* query).toEqual(expected)
              expect(yield* inferenceExpenseSessionQuery(sql, 'fixture-account', 'missing-generation')).toEqual([])
              expect(yield* inferenceExpenseSessionQuery(sql, 'other-account', 'target-generation')).toEqual([
                { sessionDate: '2099-01-01' },
              ])
              expect(yield* inferenceExpenseSessionQuery(sql, 'fixture-account')).toEqual([
                ...Array.from({ length: 30 }, (_, i) => ({ sessionDate: `2026-10-${String(i + 1).padStart(2, '0')}` })),
                ...expected,
              ])
              yield* sql`DEALLOCATE inference_session_discovery`
            }),
          )
        }),
      )
    },
    30_000,
  )
})
