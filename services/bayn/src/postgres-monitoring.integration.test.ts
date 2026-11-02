import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PgClient } from '@effect/sql-pg'
import { Effect, ManagedRuntime, Redacted, Schema } from 'effect'

import { baynTestPostgresUrl } from './test-environment.test-support'

const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const Manifest = Schema.Struct({ data: Schema.Struct({ queries: Schema.String }) })
const Queries = Schema.Record(
  Schema.String,
  Schema.Struct({
    query: Schema.String,
    target_databases: Schema.Array(Schema.String),
    metrics: Schema.Array(
      Schema.Record(Schema.String, Schema.Struct({ usage: Schema.String, description: Schema.String })),
    ),
  }),
)

describePostgres('PostgreSQL 18 monitoring query execution', () => {
  let runtime: ManagedRuntime.ManagedRuntime<PgClient.PgClient, unknown>

  beforeAll(() => {
    if (baynTestPostgresUrl === undefined) throw new Error('Missing disposable PostgreSQL endpoint')
    const url = new URL(baynTestPostgresUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test'))
      throw new Error('Monitoring tests require an isolated local _test database')
    runtime = ManagedRuntime.make(PgClient.layer({ url: Redacted.make(url.toString()), maxConnections: 1 }))
  })

  afterAll(async () => runtime?.dispose())

  test('executes the deployed catalog queries read-only with pg_monitor privileges and matching metric columns', async () => {
    const manifest = Schema.decodeUnknownSync(Manifest)(
      Bun.YAML.parse(
        readFileSync(new URL('../../../argocd/applications/bayn/postgres-monitoring.yaml', import.meta.url), 'utf8'),
      ),
    )
    const queries = Schema.decodeUnknownSync(Queries)(Bun.YAML.parse(manifest.data.queries))
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SET TRANSACTION READ ONLY`
            yield* sql`SET LOCAL ROLE pg_monitor`
            yield* sql`SET LOCAL statement_timeout = '5s'`
            const version = yield* sql<{
              version: number
            }>`SELECT current_setting('server_version_num')::integer AS version`
            expect(version[0]?.version).toBeGreaterThanOrEqual(180000)
            expect(version[0]?.version).toBeLessThan(190000)
            for (const [name, query] of Object.entries(queries)) {
              expect(query.target_databases).toEqual(['bayn'])
              const rows = yield* sql.unsafe<Record<string, unknown>>(query.query)
              expect(rows.length).toBeGreaterThan(0)
              expect(Object.keys(rows[0] ?? {}).sort()).toEqual(query.metrics.flatMap(Object.keys).sort())
              if (name === 'bayn_replication') {
                expect(Number(rows[0]?.['connected_standbys'])).toBe(0)
                expect(Number(rows[0]?.['measured_flush_lag_standbys'])).toBe(0)
                expect(rows[0]?.['max_flush_lag_seconds']).toBeNull()
              }
            }
          }),
        )
      }),
    )
  })
})
