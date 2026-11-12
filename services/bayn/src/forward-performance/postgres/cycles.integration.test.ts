import { describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect'
import { PostgresClientLive } from '../../db/postgres-client'
import { baynTestPostgresUrl } from '../../test-environment.test-support'
import { firstCapturedCycleQuery, readForwardPerformanceCycles } from './cycles'
import { generationScope } from './scope'

const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const hash = (value: number) => value.toString(16).padStart(64, '0')
const preciseTime = (micros: string) => '2026-09-04T14:00:00.' + micros + 'Z'

describePostgres('Forward-performance captured first cycle', () => {
  test('reuses the exact scoped ordering and PostgreSQL timestamp without rereading decision proofs', async () => {
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
        { maxConnections: 1, applicationName: 'bayn-captured-first-cycle-test' },
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    )
    try {
      const results = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          // The single owned connection retains these fixtures for the following read-only snapshot.
          yield* sql`CREATE TEMP TABLE autonomous_cycles (
            cycle_id text PRIMARY KEY, account_id text, qualification_run_id text, strategy_name text,
            strategy_protocol_hash text, execution_policy_hash text, strategy_execution_model_hash text,
            decision_hash text, state text, submission_open_at timestamptz, terminal_at timestamptz,
            created_at timestamptz
          )`
          yield* sql`CREATE TEMP TABLE authority_generations (
            generation_hash text PRIMARY KEY, account_id text, maximum text, qualification_run_id text,
            research_plan_hash text, activated_at timestamptz, previous_generation_hash text
          )`
          yield* sql`CREATE TEMP TABLE autonomous_cycle_shadow_decisions (
            cycle_id text, decision_hash text, schema_version text, document jsonb
          )`
          yield* sql`CREATE TEMP TABLE intents (
            cycle_id text, account_id text, authority_generation_hash text
          )`
          for (const [generation, account, maximum, previous] of [
            [100, 'account', 'PAPER', null],
            [101, 'account', 'PAPER', 100],
            [102, 'foreign', 'PAPER', null],
            [103, 'account', 'OBSERVE', 101],
          ] as const)
            yield* sql`INSERT INTO authority_generations VALUES (
              ${hash(generation)}, ${account}, ${maximum}, NULL, ${hash(200)},
              '2026-09-03T20:00:00Z', ${previous === null ? null : hash(previous)}
            )`
          const fixtures = [
            { id: 40, generation: 100, state: 'COMPLETED', at: preciseTime('000001'), binding: 'intent' },
            { id: 50, generation: 100, state: 'NO_TRADE', at: preciseTime('000001'), binding: 'decision' },
            { id: 1, generation: 100, state: 'COMPLETED', at: preciseTime('000002'), binding: 'decision' },
            { id: 60, generation: 101, state: 'COMPLETED', at: preciseTime('000003'), binding: 'decision' },
            { id: 61, generation: 101, state: 'NO_TRADE', at: preciseTime('000004'), binding: 'decision' },
            { id: 0, generation: 100, state: 'ACTIVE', at: '2026-09-04T13:00:00Z', binding: 'decision' },
            { id: 2, generation: 100, state: 'PENDING', at: '2026-09-04T13:01:00Z', binding: 'decision' },
            { id: 3, generation: 100, state: 'BLOCKED', at: '2026-09-04T13:02:00Z', binding: 'intent' },
            { id: 4, generation: 100, state: 'COMPLETED', at: '2026-09-04T13:03:00Z', binding: 'wrong-plan' },
            { id: 5, generation: 100, state: 'COMPLETED', at: '2026-09-04T13:04:00Z', binding: 'wrong-decision' },
            { id: 6, generation: 100, state: 'NO_TRADE', at: '2026-09-04T13:05:00Z', binding: 'missing' },
            { id: 7, generation: 100, state: 'COMPLETED', at: '2026-09-04T13:06:00Z', binding: 'wrong-account' },
            { id: 8, generation: 100, state: 'COMPLETED', at: '2026-09-04T13:07:00Z', binding: 'wrong-generation' },
            { id: 9, generation: 102, state: 'COMPLETED', at: '2026-09-04T13:08:00Z', binding: 'decision' },
            { id: 10, generation: 103, state: 'COMPLETED', at: '2026-09-04T13:09:00Z', binding: 'decision' },
            { id: 11, generation: 100, state: 'COMPLETED', at: '2026-09-04T13:10:00Z', binding: 'intent-account' },
            { id: 12, generation: 100, state: 'COMPLETED', at: '2026-09-04T13:11:00Z', binding: 'intent-generation' },
          ] as const
          for (const fixture of fixtures) {
            const account = fixture.generation === 102 ? 'foreign' : 'account'
            const plan = hash(fixture.binding === 'wrong-plan' ? 201 : 200)
            const decision = hash(300 + fixture.id)
            yield* sql`INSERT INTO autonomous_cycles VALUES (
              ${hash(fixture.id)}, ${account}, ${plan}, 'jev', ${hash(400)}, ${hash(401)}, ${hash(402)},
              ${decision}, ${fixture.state}, ${fixture.at}::timestamptz,
              ${fixture.at}::timestamptz + INTERVAL '1 minute', '2026-09-03T12:00:00Z'
            )`
            if (fixture.binding.startsWith('intent'))
              yield* sql`INSERT INTO intents VALUES (
                ${hash(fixture.id)}, ${fixture.binding === 'intent-account' ? 'foreign' : account},
                ${hash(fixture.binding === 'intent-generation' ? 999 : fixture.generation)}
              )`
            else if (fixture.binding !== 'missing')
              yield* sql`INSERT INTO autonomous_cycle_shadow_decisions VALUES (
                ${hash(fixture.id)}, ${fixture.binding === 'wrong-decision' ? hash(999) : decision},
                'bayn.paper-cycle-decision.v2',
                ${sql.json({
                  mode: 'PAPER',
                  bindings: {
                    accountId: fixture.binding === 'wrong-account' ? 'foreign' : account,
                    qualificationRunId: plan,
                    authorityGenerationHash: hash(fixture.binding === 'wrong-generation' ? 999 : fixture.generation),
                  },
                })}
              )`
          }
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`
              const cases = [
                { name: 'retained', account: 'account', generation: hash(100) },
                { name: 'current', account: 'account', generation: hash(101) },
                { name: 'unscoped', account: 'account', generation: undefined },
                { name: 'foreign', account: 'foreign', generation: hash(102) },
                { name: 'wrong-account', account: 'foreign', generation: hash(100) },
                { name: 'missing-generation', account: 'account', generation: hash(999) },
                { name: 'observe-generation', account: 'account', generation: hash(103) },
                { name: 'empty-account', account: 'empty', generation: undefined },
              ] as const
              return yield* Effect.forEach(cases, (scope) =>
                Effect.gen(function* () {
                  const captured = yield* readForwardPerformanceCycles(sql, scope.account, scope.generation)
                  const readCount = sql<{ count: string }>`SELECT (
                    pg_stat_get_xact_tuples_returned('autonomous_cycle_shadow_decisions'::regclass) +
                    pg_stat_get_xact_tuples_fetched('autonomous_cycle_shadow_decisions'::regclass)
                  )::text AS count`
                  const [beforeOriginal] = yield* readCount
                  const original = yield* sql<{ cycle_id: string; boundary: string }>`
                    SELECT cycle.cycle_id,
                      to_char(cycle.submission_open_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS boundary
                    FROM autonomous_cycles AS cycle
                    WHERE cycle.account_id = ${scope.account}
                      AND cycle.state IN ('COMPLETED', 'NO_TRADE')
                      AND ${generationScope(sql, scope.account, scope.generation, 'cycle')}
                    ORDER BY cycle.submission_open_at, cycle.cycle_id COLLATE "C"
                    LIMIT 1
                  `
                  const [beforeCaptured] = yield* readCount
                  const repeated = yield* Effect.forEach(
                    [0, 1, 2],
                    () =>
                      sql<{ boundary: string }>`
                      SELECT to_char(first_cycle.submission_open_at AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS boundary
                      FROM (${firstCapturedCycleQuery(sql, captured)}) AS first_cycle
                    `,
                  )
                  const [afterCaptured] = yield* readCount
                  return {
                    ...scope,
                    captured,
                    original,
                    repeated,
                    originalReads: Number(beforeCaptured?.count) - Number(beforeOriginal?.count),
                    capturedReads: Number(afterCaptured?.count) - Number(beforeCaptured?.count),
                  }
                }),
              )
            }),
          )
        }),
      )
      for (const result of results) {
        expect(result.captured[0]?.cycle_id).toBe(result.original[0]?.cycle_id)
        for (const repeated of result.repeated)
          expect(repeated).toEqual(result.original.map(({ boundary }) => ({ boundary })))
        expect(result.capturedReads).toBe(0)
      }
      const retained = results.find((result) => result.name === 'retained')
      expect(retained?.captured.map((cycle) => cycle.cycle_id)).toEqual([hash(40), hash(50), hash(1)])
      expect(retained?.captured.map((cycle) => cycle.submission_open_at.getTime())).toEqual(
        Array.from({ length: 3 }, () => Date.parse(preciseTime('000000'))),
      )
      expect(retained?.original).toEqual([{ cycle_id: hash(40), boundary: preciseTime('000001') }])
      expect(retained?.originalReads).toBeGreaterThan(0)
      expect(results.find((result) => result.name === 'current')?.captured.map((cycle) => cycle.cycle_id)).toEqual([
        hash(60),
        hash(61),
      ])
      expect(results.find((result) => result.name === 'unscoped')?.captured[0]?.cycle_id).toBe(hash(4))
      expect(results.find((result) => result.name === 'foreign')?.captured[0]?.cycle_id).toBe(hash(9))
      for (const name of ['wrong-account', 'missing-generation', 'observe-generation', 'empty-account'])
        expect(results.find((result) => result.name === name)?.captured).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })
})
