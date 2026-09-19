import { describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect'
import { PostgresClientLive } from '../../db/postgres-client'
import { baynTestPostgresUrl } from '../../test-environment.test-support'
import { readForwardPerformanceStrategyRows } from './read'

const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const hash = (value: string) => value.repeat(64)

describePostgres('Forward-performance strategy generation binding', () => {
  test('resolves a pre-created cycle through its durable decision and preserves generation isolation', async () => {
    const url = baynTestPostgresUrl ?? ''
    const parsed = new URL(url)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local test database')
    const runtime = ManagedRuntime.make(
      PostgresClientLive({
        operationTimeoutMs: 5_000,
        postgres: { url: Redacted.make(url), tls: false, caPath: '/unused' },
      }).pipe(Layer.provideMerge(NodeServices.layer)),
    )
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`CREATE TEMP TABLE autonomous_cycles (
                cycle_id text, account_id text, qualification_run_id text, strategy_protocol_hash text,
                decision_hash text, state text, submission_open_at timestamptz, created_at timestamptz
              ) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE authority_generations (
                generation_hash text, account_id text, qualification_run_id text, research_plan_hash text,
                strategy_name text, strategy_protocol_hash text, strategy_behavior_hash text,
                strategy_parameter_hash text, strategy_parameter_schema_version text,
                activation_source_revision text, activation_image_repository text, activation_image_digest text,
                activation_schema_version text, maximum text, activated_at timestamptz, previous_generation_hash text
              ) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE autonomous_cycle_shadow_decisions (
                cycle_id text, decision_hash text, schema_version text, document jsonb
              ) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE intents (
                cycle_id text, account_id text, authority_generation_hash text
              ) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE qualification_results (run_id text, verdict text, lock_id text) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE qualification_locks (
                lock_id text, protocol_hash text, source_revision text, image_repository text, image_digest text
              ) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE evaluation_runs (
                run_id text, strategy_name text, source_revision text, image_repository text, image_digest text,
                protocol_hash text, status text
              ) ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE protocol_locks (
                protocol_hash text, behavior_hash text, parameter_hash text, schema_version text
              ) ON COMMIT DROP`
              yield* sql`INSERT INTO autonomous_cycles VALUES (
                'cycle', 'account', ${hash('b')}, ${hash('c')}, ${hash('d')}, 'COMPLETED',
                '2026-09-18T13:30:00Z', '2026-09-17T19:57:13Z'
              )`
              yield* sql`INSERT INTO authority_generations VALUES (
                ${hash('a')}, 'account', NULL, ${hash('b')}, 'intraday-momentum', ${hash('c')},
                ${hash('1')}, ${hash('2')}, 'parameters.v1', 'source-revision', 'registry/bayn',
                ${`sha256:${hash('3')}`}, 'bayn.paper-authority-generation.v3', 'PAPER',
                '2026-09-17T21:03:42Z', NULL
              )`
              const decision = {
                mode: 'PAPER',
                bindings: { accountId: 'account', qualificationRunId: hash('b'), authorityGenerationHash: hash('a') },
              }
              yield* sql`INSERT INTO autonomous_cycle_shadow_decisions VALUES (
                'cycle', ${hash('d')}, 'bayn.paper-cycle-decision.v1', ${JSON.stringify(decision)}::jsonb
              )`
              const fromDecision = yield* readForwardPerformanceStrategyRows(sql, 'account', hash('a'))
              const unscoped = yield* readForwardPerformanceStrategyRows(sql, 'account')
              const foreignAccount = yield* readForwardPerformanceStrategyRows(sql, 'foreign', hash('a'))
              yield* sql`INSERT INTO authority_generations
                SELECT ${hash('f')}, account_id, qualification_run_id, research_plan_hash, strategy_name,
                  strategy_protocol_hash, strategy_behavior_hash, strategy_parameter_hash, strategy_parameter_schema_version,
                  activation_source_revision, activation_image_repository, activation_image_digest,
                  activation_schema_version, maximum, '2026-09-18T21:00:00Z', generation_hash
                FROM authority_generations`
              const afterSuccessor = yield* readForwardPerformanceStrategyRows(sql, 'account', hash('a'))
              const foreignGeneration = yield* readForwardPerformanceStrategyRows(sql, 'account', hash('f'))
              const unscopedAfterSuccessor = yield* readForwardPerformanceStrategyRows(sql, 'account')
              yield* sql`UPDATE autonomous_cycles SET strategy_protocol_hash = ${hash('4')}`
              const foreignProtocol = yield* readForwardPerformanceStrategyRows(sql, 'account', hash('a'))
              yield* sql`UPDATE autonomous_cycles SET strategy_protocol_hash = ${hash('c')}, state = 'NO_TRADE'`
              const noTrade = yield* readForwardPerformanceStrategyRows(sql, 'account', hash('a'))
              yield* sql`UPDATE autonomous_cycles SET decision_hash = ${hash('5')}`
              const wrongDecision = yield* readForwardPerformanceStrategyRows(sql, 'account', hash('a'))
              yield* sql`INSERT INTO intents VALUES ('cycle', 'foreign', ${hash('a')})`
              const foreignIntent = yield* readForwardPerformanceStrategyRows(sql, 'account', hash('a'))
              yield* sql`UPDATE intents SET account_id = 'account'`
              const fromIntent = yield* readForwardPerformanceStrategyRows(sql, 'account', hash('a'))
              yield* sql`DELETE FROM intents`
              yield* sql`DELETE FROM autonomous_cycle_shadow_decisions`
              yield* sql`UPDATE autonomous_cycles SET created_at = '2026-09-18T14:00:00Z'`
              const unbound = yield* readForwardPerformanceStrategyRows(sql, 'account')
              return {
                fromDecision,
                unscoped,
                foreignAccount,
                afterSuccessor,
                foreignGeneration,
                unscopedAfterSuccessor,
                foreignProtocol,
                noTrade,
                wrongDecision,
                foreignIntent,
                fromIntent,
                unbound,
              }
            }),
          )
        }),
      )
      expect(result.fromDecision).toHaveLength(1)
      expect(result.fromDecision[0]?.strategy_protocol_hash).toBe(hash('c'))
      for (const rows of [
        result.unscoped,
        result.afterSuccessor,
        result.unscopedAfterSuccessor,
        result.noTrade,
        result.fromIntent,
      ])
        expect(rows).toEqual(result.fromDecision)
      for (const rows of [
        result.foreignAccount,
        result.foreignGeneration,
        result.foreignProtocol,
        result.wrongDecision,
        result.foreignIntent,
        result.unbound,
      ])
        expect(rows).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })
})
