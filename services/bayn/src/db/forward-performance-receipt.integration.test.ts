import { describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Redacted, Result } from 'effect'
import { PostgresClientLive } from './postgres-client'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import {
  makeForwardPerformanceReceiptEnvelope,
  makePersistableForwardPerformanceReceiptEnvelope,
  persistForwardPerformanceReceipt,
} from './forward-performance-receipt'
import { makePersistenceReceipt } from './forward-performance-receipt.test-support'

const postgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const generation = 'a'.repeat(64)
const successor = 'f'.repeat(64)
const packet = () =>
  Result.getOrThrow(makePersistableForwardPerformanceReceiptEnvelope(generation, makePersistenceReceipt()))

const withDatabase = <A, E>(program: Effect.Effect<A, E, PgClient.PgClient>) => {
  const url = baynTestPostgresUrl ?? ''
  const parsed = new URL(url)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
    throw new Error('Receipt persistence tests require an isolated local _test database')
  return Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`CREATE TEMP TABLE authority_generations (
          generation_hash text PRIMARY KEY, previous_generation_hash text, authority_version bigint,
          account_id text, qualification_run_id text, research_plan_hash text, maximum text,
          broker_identity_hash text, broker_provider text, broker_environment text, activated_at timestamptz
        ) ON COMMIT DROP`
          yield* sql`CREATE TEMP TABLE authority_state (singleton boolean, generation_hash text, version bigint) ON COMMIT DROP`
          yield* sql`CREATE TEMP TABLE autonomous_cycles (
          cycle_id text PRIMARY KEY, account_id text, qualification_run_id text, state text, terminal_at timestamptz,
          decision_hash text
        ) ON COMMIT DROP`
          yield* sql`CREATE TEMP TABLE intents (
          cycle_id text, account_id text, authority_generation_hash text, state text, updated_at timestamptz
        ) ON COMMIT DROP`
          yield* sql`CREATE TEMP TABLE autonomous_cycle_shadow_decisions (
          cycle_id text, decision_hash text, schema_version text, document jsonb
        ) ON COMMIT DROP`
          yield* sql`CREATE TEMP TABLE autonomous_forward_performance_receipts (
          authority_generation_hash text PRIMARY KEY, cycle_id text NOT NULL REFERENCES autonomous_cycles(cycle_id),
          document jsonb NOT NULL, created_at timestamptz NOT NULL
        ) ON COMMIT DROP`
          yield* sql`CREATE OR REPLACE FUNCTION pg_temp.reject_performance_receipt_mutation() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt is append-only'; END $$`
          yield* sql`CREATE TRIGGER receipt_append_only BEFORE UPDATE OR DELETE ON autonomous_forward_performance_receipts
          FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_performance_receipt_mutation()`
          yield* sql`INSERT INTO authority_generations VALUES (
          ${generation}, NULL, 1, 'persistence-test-account', ${'1'.repeat(64)}, NULL, 'PAPER',
          ${'d'.repeat(64)}, 'alpaca', 'sandbox', '2026-07-20T12:00:00Z'
        )`
          yield* sql`INSERT INTO authority_generations VALUES (
          ${successor}, ${generation}, 2, 'persistence-test-account', NULL, NULL, 'OBSERVE',
          ${'d'.repeat(64)}, 'alpaca', 'sandbox', '2026-07-20T21:02:00Z'
        )`
          yield* sql`INSERT INTO authority_state VALUES (true, ${successor}, 2)`
          yield* sql`INSERT INTO autonomous_cycles VALUES (
          ${generation}, 'persistence-test-account', ${'1'.repeat(64)}, 'COMPLETED', '2026-07-20T21:00:00Z', NULL
        )`
          yield* sql`INSERT INTO intents VALUES (
          ${generation}, 'persistence-test-account', ${generation}, 'TERMINAL', '2026-07-20T21:00:00Z'
        )`
          return yield* program
        }),
      )
    }).pipe(
      Effect.scoped,
      Effect.provide(
        PostgresClientLive({
          operationTimeoutMs: 5_000,
          postgres: { url: Redacted.make(url), tls: false, caPath: '/unused' },
        }),
      ),
      Effect.provide(NodeServices.layer),
    ),
  )
}

postgres('Forward-performance receipt terminality', () => {
  test('rejects an active generation even if a successor row has been prepared', async () => {
    const result = await withDatabase(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`UPDATE authority_state SET generation_hash = ${generation}, version = 1`
        const refused = yield* persistForwardPerformanceReceipt(packet()).pipe(Effect.result)
        const rows = yield* sql`SELECT * FROM autonomous_forward_performance_receipts`
        return { refused, rows }
      }),
    )
    expect(Result.isFailure(result.refused)).toBe(true)
    expect(result.rows).toHaveLength(0)
  })

  test('appends a sufficient retired report once and leaves the first receipt unchanged on conflict', async () => {
    const result = await withDatabase(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const original = packet()
        yield* persistForwardPerformanceReceipt(original)
        yield* persistForwardPerformanceReceipt(packet())
        const different = Result.getOrThrow(
          makePersistableForwardPerformanceReceiptEnvelope(
            generation,
            makePersistenceReceipt({ startingCapitalMicros: '2000' }),
          ),
        )
        const conflict = yield* persistForwardPerformanceReceipt(different).pipe(Effect.result)
        const rows = yield* sql`SELECT document FROM autonomous_forward_performance_receipts`
        const mutation = yield* sql
          .withTransaction(sql`UPDATE autonomous_forward_performance_receipts SET cycle_id = cycle_id`)
          .pipe(Effect.result)
        return { original, conflict, rows, mutation }
      }),
    )
    expect(result.rows).toEqual([{ document: result.original }])
    expect(Result.isFailure(result.conflict)).toBe(true)
    expect(Result.isFailure(result.mutation)).toBe(true)
  })

  test('refuses UNCLOSED_WINDOW despite non-null cut and completed cycle', async () => {
    const result = await withDatabase(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const receipt = makePersistenceReceipt({ unclosedCycleCount: 1 })
        const { contentHash: _contentHash, ...material } = packet()
        const invalid = Result.getOrThrow(
          makeForwardPerformanceReceiptEnvelope({
            ...material,
            receipt,
            receiptHash: receipt.receiptHash,
          }),
        )
        const refused = yield* persistForwardPerformanceReceipt(invalid).pipe(Effect.result)
        const rows = yield* sql`SELECT * FROM autonomous_forward_performance_receipts`
        return { refused, rows }
      }),
    )
    expect(Result.isFailure(result.refused)).toBe(true)
    expect(result.rows).toHaveLength(0)
  })

  for (const change of [
    'foreign-account',
    'unbound-cycle',
    'unfinished-intent',
    'later-intent',
    'missing-successor',
  ] as const) {
    test(`rejects ${change} at the persistence boundary`, async () => {
      const result = await withDatabase(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          switch (change) {
            case 'foreign-account':
              yield* sql`UPDATE authority_generations SET broker_identity_hash = ${'e'.repeat(64)}`
              break
            case 'unbound-cycle':
              yield* sql`UPDATE intents SET cycle_id = ${'e'.repeat(64)}`
              break
            case 'unfinished-intent':
              yield* sql`UPDATE intents SET state = 'SUBMITTING'`
              break
            case 'later-intent':
              yield* sql`UPDATE intents SET updated_at = '2026-07-20T21:01:01Z'`
              break
            case 'missing-successor':
              yield* sql`DELETE FROM authority_generations WHERE generation_hash = ${successor}`
              break
          }
          const refused = yield* persistForwardPerformanceReceipt(packet()).pipe(Effect.result)
          const rows = yield* sql`SELECT * FROM autonomous_forward_performance_receipts`
          return { refused, rows }
        }),
      )
      expect(Result.isFailure(result.refused)).toBe(true)
      expect(result.rows).toHaveLength(0)
    })
  }
})
