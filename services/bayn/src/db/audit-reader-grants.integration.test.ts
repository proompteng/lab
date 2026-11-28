import { describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Redacted, Schema } from 'effect'

import auditReaderGrants from '../../migrations/0226_audit_reader_grants'
import auditReaderViewGrant from '../../migrations/0227_audit_reader_view_grant'
import { BaynKnowledge, strictKnowledge } from '../../tools/auto-ontology-knowledge'
import { localPostgresTestUrl } from '../../tools/postgres-test-databases'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { auditReaderGrantedRelnames } from './audit-reader-allowlist.test-support'
import { postgresMigrations } from './postgres-migrations'

const integration = baynTestPostgresUrl === undefined ? describe.skip : describe
const seedJson: unknown = await Bun.file(
  new URL('../../../../docs/bayn/ontology/bayn-knowledge.json', import.meta.url),
).json()
const seed = Schema.decodeUnknownSync(BaynKnowledge, strictKnowledge)(seedJson)

integration('Bayn audit reader grants', () => {
  test('migrates without CNPG and grants only the audit allowlist including ontology views when its login exists', async () => {
    const url = Redacted.make(localPostgresTestUrl(baynTestPostgresUrl).toString())
    const rollback = Symbol('discard test role and grants')
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* postgresMigrations
        expect(
          yield* sql`SELECT migration_id, name FROM schema_migrations WHERE migration_id IN (226, 227) ORDER BY migration_id`,
        ).toEqual([
          { migration_id: 226, name: 'audit_reader_grants' },
          { migration_id: 227, name: 'audit_reader_view_grant' },
        ])
        expect(yield* sql`SELECT rolname FROM pg_roles WHERE rolname = 'bayn_audit_ro'`).toEqual([])

        // PostgreSQL roles are cluster-wide. Roll the test role back even on success.
        const result = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`CREATE ROLE bayn_audit_ro LOGIN NOINHERIT`
              // Require migrations 0226/0227's explicit schema grant rather than PostgreSQL's default grant to PUBLIC.
              yield* sql`REVOKE USAGE ON SCHEMA public FROM PUBLIC`
              yield* auditReaderGrants
              yield* auditReaderViewGrant
              // Re-running 0227 when bayn_audit_ro already exists must remain idempotent.
              yield* auditReaderViewGrant
              yield* sql`SET LOCAL ROLE bayn_audit_ro`
              expect(
                yield* sql`
                SELECT has_schema_privilege('public', 'USAGE') AS usage,
                  has_schema_privilege('public', 'CREATE') AS create
              `,
              ).toEqual([{ usage: true, create: false }])
              const granted = yield* sql<{ readonly relname: string; readonly full_table: boolean }>`
                  SELECT c.relname, has_table_privilege(c.oid, 'SELECT') AS full_table
                  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
                    AND has_any_column_privilege(c.oid, 'SELECT')
                  ORDER BY c.relname COLLATE "C"
                `
              expect(granted).toEqual(auditReaderGrantedRelnames.map((relname) => ({ relname, full_table: true })))
              const grantedSet = new Set(granted.map(({ relname }) => `public.${relname}`))
              const ontologyRelations = [
                ...new Set(seed.analyses.flatMap(({ referencedTables }) => referencedTables)),
              ].toSorted()
              expect(ontologyRelations.filter((relation) => !grantedSet.has(relation))).toEqual([])
              expect(
                yield* sql`
                SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
                  AND (has_table_privilege(c.oid, 'DELETE, TRUNCATE, TRIGGER, MAINTAIN')
                    OR has_any_column_privilege(c.oid, 'INSERT, UPDATE, REFERENCES, SELECT WITH GRANT OPTION'))
              `,
              ).toEqual([])
              expect(yield* sql`SELECT 1 FROM public.orders LIMIT 0`).toEqual([])
              expect(yield* sql`SELECT 1 FROM public.broker_fee_accounting_evidence LIMIT 0`).toEqual([])
              for (const analysis of seed.analyses) {
                const rows = yield* sql.unsafe(analysis.sql, [
                  'fixture-account',
                  '2026-11-25T05:00:00Z',
                  '2026-11-26T05:00:00Z',
                ])
                expect(rows).toEqual([])
              }
              const deniedUnderlying = yield* sql
                .withTransaction(sql`SELECT 1 FROM public.broker_fee_match_corrections LIMIT 0`)
                .pipe(Effect.result)
              expect(deniedUnderlying).toMatchObject({
                _tag: 'Failure',
                failure: { reason: { cause: { code: '42501' } } },
              })
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
