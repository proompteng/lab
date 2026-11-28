import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient, PgMigrator } from '@effect/sql-pg'
import { Data, Effect, Layer, ManagedRuntime, Redacted } from 'effect'
import type { SqlClient } from 'effect/sql'

import migrateDecisions from '../../migrations/0122_explicit_limit_decisions'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { migrationLoader } from './migrations'
import { PostgresClientLive } from './postgres-client'

const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const makeRuntime = () =>
  ManagedRuntime.make(
    PostgresClientLive({
      operationTimeoutMs: 10_000,
      postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
    }).pipe(Layer.provideMerge(NodeServices.layer)),
  )

class RollbackCase extends Data.TaggedError('RollbackCase') {}

describePostgres('explicit LIMIT decision database cutover', () => {
  let runtime: ReturnType<typeof makeRuntime>
  beforeAll(async () => {
    const url = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test'))
      throw new Error('Migration tests require a local _test database')
    runtime = makeRuntime()
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* PgMigrator.run({
          loader: migrationLoader.pipe(Effect.map((migrations) => migrations.filter(([id]) => id < 122))),
          table: 'schema_migrations',
        })
      }),
    )
  })
  afterAll(async () => runtime.dispose())

  const runCase = (program: Effect.Effect<void, unknown, PgClient.PgClient | SqlClient.SqlClient>) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`CREATE TEMP TABLE autonomous_cycle_shadow_decisions
              (LIKE public.autonomous_cycle_shadow_decisions INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING GENERATED)
              ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE autonomous_cycle_paper_closures
              (LIKE public.autonomous_cycle_paper_closures INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING GENERATED)
              ON COMMIT DROP`
              yield* sql`CREATE TEMP TABLE autonomous_cycle_paper_close_replans
              (LIKE public.autonomous_cycle_paper_close_replans INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING GENERATED)
              ON COMMIT DROP`
              yield* program
              return yield* new RollbackCase()
            }),
          )
          .pipe(
            Effect.catchIf(
              (cause) => cause instanceof RollbackCase,
              () => Effect.void,
            ),
          )
      }),
    )

  const insertDecision = (schemaVersion: string, mode: 'OBSERVE' | 'PAPER', character = 'a') =>
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const at = '2026-10-18T12:00:00.000Z'
      yield* sql`INSERT INTO autonomous_cycle_shadow_decisions (cycle_id,schema_version,document,created_at)
        VALUES (${character.repeat(64)},${schemaVersion},${sql.json({
          schemaVersion,
          mode,
          dispatchable: mode === 'PAPER',
          bindings: { cycleId: character.repeat(64) },
          contentHash: 'b'.repeat(64),
          createdAt: at,
        })},${at}::timestamptz)`
    })

  test.each([
    ['bayn.observe-shadow-decision', 'OBSERVE'],
    ['bayn.paper-cycle-decision', 'PAPER'],
  ] as const)('preserves immutable %s v1 history and permits only v2 new writes', (prefix, mode) =>
    runCase(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* insertDecision(`${prefix}.v1`, mode)
        const before = yield* sql`SELECT to_jsonb(d) AS row FROM autonomous_cycle_shadow_decisions d`
        yield* migrateDecisions
        expect(yield* sql`SELECT to_jsonb(d) AS row FROM autonomous_cycle_shadow_decisions d`).toEqual(before)
        yield* insertDecision(`${prefix}.v2`, mode, 'c')
        const rejected = yield* sql.withTransaction(insertDecision(`${prefix}.v1`, mode, 'd')).pipe(Effect.result)
        expect(rejected).toMatchObject({ _tag: 'Failure', failure: { reason: { cause: { code: '23514' } } } })
      }),
    ),
  )

  test.each(['autonomous_cycle_paper_closures', 'autonomous_cycle_paper_close_replans'] as const)(
    '%s retains old documents and enforces the nested execution version on new writes',
    (table) =>
      runCase(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const insert = (version: number | null, character: string) => {
            const cycleId = character.repeat(64)
            const createdAt = '2026-10-18T12:00:00.000Z'
            const expiresAt = '2026-10-18T12:01:00.000Z'
            const common = {
              cycle_id: cycleId,
              document: sql.json({
                schemaVersion: 'bayn.paper-cycle-closure.v1',
                cycleId,
                createdAt,
                expiresAt,
                contentHash: cycleId,
                document: {
                  ...(version === null ? {} : { schemaVersion: `bayn.paper-cycle-decision.v${version}` }),
                  mode: 'PAPER',
                  contentHash: 'e'.repeat(64),
                  bindings: { cycleId },
                  expiresAt,
                  submissionCutoffAt: expiresAt,
                },
              }),
              created_at: createdAt,
              expires_at: expiresAt,
            }
            return sql`INSERT INTO ${sql(table)} ${sql.insert(
              table === 'autonomous_cycle_paper_close_replans' ? { ...common, content_hash: cycleId } : common,
            )}`
          }
          yield* insert(1, 'a')
          const before = yield* sql`SELECT to_jsonb(d) AS row FROM ${sql(table)} d`
          yield* migrateDecisions
          expect(yield* sql`SELECT to_jsonb(d) AS row FROM ${sql(table)} d`).toEqual(before)
          yield* insert(2, 'b')
          expect(yield* sql.withTransaction(insert(1, 'c')).pipe(Effect.result)).toMatchObject({
            _tag: 'Failure',
            failure: { reason: { cause: { code: '23514' } } },
          })
          expect(yield* sql.withTransaction(insert(null, 'd')).pipe(Effect.result)).toMatchObject({
            _tag: 'Failure',
            failure: { reason: { cause: { code: '23514' } } },
          })
        }),
      ),
  )
})
