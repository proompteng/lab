import { describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Redacted } from 'effect'

import auditReaderGrants from '../../migrations/0226_audit_reader_grants'
import { localPostgresTestUrl } from '../../tools/postgres-test-databases'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { postgresMigrations } from './postgres-migrations'

const integration = baynTestPostgresUrl === undefined ? describe.skip : describe

integration('Bayn audit reader grants', () => {
  test('migrates without CNPG and grants only the audit allowlist when its login exists', async () => {
    const url = Redacted.make(localPostgresTestUrl(baynTestPostgresUrl).toString())
    const rollback = Symbol('discard test role and grants')
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* postgresMigrations
        expect(yield* sql`SELECT name FROM schema_migrations WHERE migration_id = 226`).toEqual([
          { name: 'audit_reader_grants' },
        ])
        expect(yield* sql`SELECT rolname FROM pg_roles WHERE rolname = 'bayn_audit_ro'`).toEqual([])

        // PostgreSQL roles are cluster-wide. Roll the test role back even on success.
        const result = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`CREATE ROLE bayn_audit_ro LOGIN NOINHERIT`
              // Require migration 0226's explicit schema grant rather than PostgreSQL's default grant to PUBLIC.
              yield* sql`REVOKE USAGE ON SCHEMA public FROM PUBLIC`
              yield* auditReaderGrants
              yield* sql`SET LOCAL ROLE bayn_audit_ro`
              expect(
                yield* sql`
                SELECT has_schema_privilege('public', 'USAGE') AS usage,
                  has_schema_privilege('public', 'CREATE') AS create
              `,
              ).toEqual([{ usage: true, create: false }])
              expect(
                yield* sql`
                  SELECT c.relname, has_table_privilege(c.oid, 'SELECT') AS full_table
                  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
                    AND has_any_column_privilege(c.oid, 'SELECT')
                  ORDER BY c.relname COLLATE "C"
                `,
              ).toEqual(
                [
                  'account_snapshots',
                  'accounting_receipts',
                  'accounting_transactions',
                  'authority_generations',
                  'autonomous_cycle_paper_close_replans',
                  'autonomous_cycle_paper_closures',
                  'autonomous_cycle_shadow_decisions',
                  'autonomous_cycles',
                  'autonomous_forward_performance_receipts',
                  'broker_events',
                  'broker_fee_accounting',
                  'broker_inventory_debits',
                  'broker_observations',
                  'execution_controller_observations',
                  'fills',
                  'intents',
                  'intraday_alpha_baseline_preparations',
                  'intraday_candidate_observations',
                  'live_capital_grants',
                  'mutation_events',
                  'orders',
                  'position_snapshots',
                  'positions',
                  'reconciliations',
                  'system_durable_observations',
                ].map((relname) => ({ relname, full_table: true })),
              )
              expect(
                yield* sql`
                SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
                  AND (has_table_privilege(c.oid, 'DELETE, TRUNCATE, TRIGGER, MAINTAIN')
                    OR has_any_column_privilege(c.oid, 'INSERT, UPDATE, REFERENCES, SELECT WITH GRANT OPTION'))
              `,
              ).toEqual([])
              expect(yield* sql`SELECT 1 FROM public.orders LIMIT 0`).toEqual([])
              const write = yield* sql.withTransaction(sql`DELETE FROM public.orders WHERE false`).pipe(Effect.result)
              expect(write).toMatchObject({ _tag: 'Failure', failure: { reason: { cause: { code: '42501' } } } })
              return yield* Effect.fail(rollback)
            }),
          )
          .pipe(Effect.flip)
        expect(result).toBe(rollback)
      }).pipe(Effect.provide(PgClient.layer({ url, maxConnections: 1 }).pipe(Layer.provideMerge(NodeServices.layer)))),
    )
  }, 30_000)
})
