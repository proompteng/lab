import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, FileSystem, Layer, ManagedRuntime, Redacted, Result, Schema } from 'effect'
import { fileURLToPath } from 'node:url'

import { baynTestPostgresUrl } from '../test-environment.test-support'
import { evidenceReaderUrl } from './evidence-reader'
import { postgresMigrations } from './postgres-migrations'
import { PostgresClientLive } from './postgres-client'

const integration = baynTestPostgresUrl === undefined ? test.skip : test
integration(
  'the evidence identity reads only its native graph and cannot mutate trading or research',
  async () => {
    if (baynTestPostgresUrl === undefined) throw new Error('Missing isolated test database')
    const url = new URL(baynTestPostgresUrl)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test'))
      throw new Error('Evidence role test requires an isolated local _test database')
    const runtime = ManagedRuntime.make(
      PostgresClientLive({
        operationTimeoutMs: 10_000,
        postgres: { url: Redacted.make(baynTestPostgresUrl), tls: false, caPath: '/unused' },
      }).pipe(Layer.provideMerge(NodeServices.layer)),
    )
    let created = false
    let disposeReader: (() => Promise<void>) | undefined
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const fs = yield* FileSystem.FileSystem
          const existing = yield* sql`SELECT 1 FROM pg_roles WHERE rolname='bayn_evidence'`
          if (existing.length !== 0) throw new Error('Refusing to replace an existing evidence test identity')
          yield* sql`DROP SCHEMA public CASCADE`
          yield* sql`CREATE SCHEMA public`
          yield* postgresMigrations
          yield* sql`CREATE ROLE bayn_evidence LOGIN PASSWORD 'isolated-test-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2`
          created = true
          const script = yield* fs.readFileString(
            fileURLToPath(new URL('../../tools/grant-evidence-reader.sql', import.meta.url)),
          )
          const withoutPsqlMeta = script.replace(/^\\set[^\n]*\n/, '')
          const database = decodeURIComponent(url.pathname.slice(1)).replaceAll('"', '""')
          const scoped = withoutPsqlMeta.replace(
            'GRANT CONNECT ON DATABASE bayn TO bayn_evidence;',
            `GRANT CONNECT ON DATABASE "${database}" TO bayn_evidence;`,
          )
          const statements = scoped
            .split(';')
            .map((statement) => statement.trim())
            .filter((statement) => statement !== '' && statement !== 'BEGIN' && statement !== 'COMMIT')
          yield* sql.withTransaction(Effect.forEach(statements, (statement) => sql.unsafe(statement)))
        }),
      )
      url.username = 'bayn_evidence'
      url.password = 'isolated-test-only'
      const restricted = await Effect.runPromise(Effect.fromResult(evidenceReaderUrl(Redacted.make(url.toString()))))
      const scopedReader = ManagedRuntime.make(
        PostgresClientLive(
          { operationTimeoutMs: 10_000, postgres: { url: restricted, tls: false, caPath: '/unused' } },
          { maxConnections: 1, applicationName: 'bayn-evidence-permission-test' },
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      )
      disposeReader = () => scopedReader.dispose()
      await scopedReader.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          expect((yield* sql`SHOW default_transaction_read_only`)[0]?.['default_transaction_read_only']).toBe('on')
          const granted = yield* sql`SELECT tablename FROM pg_tables WHERE schemaname='public'
        AND has_table_privilege(current_user,quote_ident(schemaname)||'.'||quote_ident(tablename),'SELECT') ORDER BY tablename`
          expect(granted.map((row) => row['tablename'])).toEqual([
            'autonomous_cycle_shadow_decisions',
            'autonomous_cycles',
            'inference_expense_quotes',
            'intraday_candidate_observations',
            'jev_batch_plans',
            'jev_batch_results',
            'jev_evaluation_receipts',
            'jev_evaluation_requests',
            'jev_evaluation_resolutions',
            'native_arrival_chunks',
            'native_arrival_ends',
            'native_arrival_epochs',
          ])
          yield* sql`SELECT capture_id FROM native_arrival_epochs LIMIT 0`
          yield* sql`SELECT payload FROM inference_expense_quotes LIMIT 0`
          yield* sql`SET default_transaction_read_only=off`
          expect((yield* sql`SHOW default_transaction_read_only`)[0]?.['default_transaction_read_only']).toBe('off')
          for (const query of [
            sql`DELETE FROM native_arrival_chunks WHERE false`,
            sql`DELETE FROM autonomous_cycles WHERE false`,
            sql`SELECT * FROM accounting_transactions LIMIT 0`,
            sql`SELECT * FROM research_inference_runs LIMIT 0`,
            sql`CREATE TABLE evidence_write_probe(value integer)`,
          ]) {
            const result = yield* Effect.result(query)
            expect(result._tag).toBe('Failure')
            if (Result.isFailure(result))
              expect(
                Schema.is(
                  Schema.Struct({ reason: Schema.Struct({ cause: Schema.Struct({ code: Schema.Literal('42501') }) }) }),
                )(result.failure),
              ).toBeTrue()
          }
        }),
      )
    } finally {
      await disposeReader?.()
      if (created)
        await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient
            yield* sql`DROP OWNED BY bayn_evidence`
            yield* sql`DROP ROLE bayn_evidence`
          }),
        )
      await runtime.dispose()
    }
  },
  30_000,
)
