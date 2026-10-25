import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient, PgMigrator } from '@effect/sql-pg'
import { Cause, Effect, Exit, Layer, ManagedRuntime, Redacted } from 'effect'

import removeUnusedSchema from '../../migrations/0134_remove_unused_schema'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { migrationLoader } from './migrations'
import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'

const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const retiredTables = [
  'broker_errors',
  'rate_limits',
  'opening_drive_qualification_locks',
  'opening_drive_qualification_replay_versions',
  'opening_drive_qualification_results',
  'opening_drive_qualification_session_replays',
] as const

const insertEvent = (id: string, kind: string, sourceSequence = 1) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    yield* sql`INSERT INTO broker_events (
      event_id, schema_version, content_hash, event_kind, broker, account_id,
      source_event_id, source_sequence, occurred_at, observed_at
    ) VALUES (${id}, 'bayn.paper-broker-event.v1', ${id}, ${kind}, 'ALPACA', 'cleanup-test',
      ${id}, ${sourceSequence}, '2026-10-20T12:00:00Z', '2026-10-20T12:00:00Z')`
  })

describePostgres('unused schema hard cutover', () => {
  const runtime = ManagedRuntime.make(
    PostgresClientLive({
      operationTimeoutMs: 10_000,
      postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
    }).pipe(Layer.provideMerge(NodeServices.layer)),
  )
  beforeAll(() => {
    const url = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test'))
      throw new Error('Migration tests require a local _test database')
  })
  beforeEach(async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* PgMigrator.run({
          loader: migrationLoader.pipe(Effect.map((rows) => rows.filter(([id]) => id < 134))),
          table: 'schema_migrations',
        })
      }),
    )
  })
  afterAll(() => runtime.dispose())

  test('removes only empty retired tables, preserves events and still enforces typed payloads', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const id = 'a'.repeat(64)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* insertEvent(id, 'ACCOUNT')
            yield* sql`INSERT INTO account_snapshots (
              event_id, account_id, schema_version, status, currency, cash_micros, equity_micros, buying_power_micros
            ) VALUES (${id}, 'cleanup-test', 'bayn.paper-account-snapshot.v1', 'ACTIVE', 'USD', 100, 100, 100)`
          }),
        )
        const evidence = sql`SELECT to_jsonb(event) AS event, to_jsonb(snapshot) - 'crypto_fee_tier' AS snapshot
          FROM broker_events AS event JOIN account_snapshots AS snapshot USING (event_id)`
        const before = yield* evidence
        yield* postgresMigrations
        expect(yield* evidence).toEqual(before)
        expect(yield* sql`SELECT migration_id::integer AS id FROM schema_migrations WHERE migration_id = 134`).toEqual([
          { id: 134 },
        ])
        for (const table of retiredTables)
          expect(yield* sql`SELECT to_regclass(${`public.${table}`}) AS relation`).toEqual([{ relation: null }])
        for (const table of [
          'lifecycle_commands',
          'research_capture_chunks',
          'native_arrival_chunks',
          'accounting_transactions',
        ])
          expect(yield* sql`SELECT to_regclass(${`public.${table}`})::text AS relation`).toEqual([{ relation: table }])
        const missingPayload = yield* Effect.exit(sql.withTransaction(insertEvent('b'.repeat(64), 'ACCOUNT', 2)))
        expect(Exit.isFailure(missingPayload)).toBe(true)
        if (Exit.isFailure(missingPayload))
          expect(Cause.pretty(missingPayload.cause)).toContain('exactly one typed payload')
        for (const kind of ['ERROR', 'RATE_LIMIT']) {
          const retired = yield* Effect.exit(sql.withTransaction(insertEvent('c'.repeat(64), kind)))
          expect(Exit.isFailure(retired)).toBe(true)
          if (Exit.isFailure(retired)) expect(Cause.pretty(retired.cause)).toContain('broker_events_event_kind_check')
        }
        yield* postgresMigrations
        expect(yield* evidence).toEqual(before)
      }),
    )
  })

  test.each(['ERROR', 'RATE_LIMIT'])(
    'preserves existing %s evidence and rolls back the entire cutover',
    async (kind) => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const id = 'd'.repeat(64)
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* insertEvent(id, kind)
              if (kind === 'ERROR')
                yield* sql`INSERT INTO broker_errors VALUES (${id}, 'cleanup-test', DEFAULT,
                'bayn.paper-broker-error.v1', 'request', 'TIMEOUT', 'retained fixture', false, 'UNKNOWN')`
              else
                yield* sql`INSERT INTO rate_limits VALUES (${id}, 'cleanup-test', DEFAULT,
                'bayn.paper-rate-limit.v1', 200, 0, '2026-10-20T12:01:00Z')`
            }),
          )
          const before = yield* sql`SELECT to_jsonb(event) AS event FROM broker_events AS event`
          const result = yield* Effect.exit(sql.withTransaction(removeUnusedSchema))
          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain('requires empty retired tables')
          expect(yield* sql`SELECT to_jsonb(event) AS event FROM broker_events AS event`).toEqual(before)
          for (const table of retiredTables)
            expect(yield* sql`SELECT to_regclass(${`public.${table}`})::text AS relation`).toEqual([
              { relation: table },
            ])
        }),
      )
    },
  )

  test('refuses to discard a prior opening-drive qualification lock', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const hash = 'e'.repeat(64)
        const binding = {
          sourceRevision: 'f'.repeat(40),
          strategyBehaviorHash: hash,
          protocolHash: hash,
          policyHash: hash,
          costModelHash: hash,
          evaluationCalendarHash: hash,
          replayVersionGraphHash: hash,
          priorTrialReceiptHashes: [],
        }
        const calendar = {
          schemaVersion: 'bayn.opening-drive.qualification-calendar.v1',
          contentHash: hash,
          firstSession: '2026-10-20',
          lastSession: '2026-10-20',
        }
        yield* sql`INSERT INTO opening_drive_qualification_locks VALUES (
          ${hash}, ${hash}, 'bayn.opening-drive.qualification-lock.v1', ${binding.sourceRevision},
          ${hash}, ${hash}, ${hash}, ${hash}, ${hash}, ${hash}, '2026-10-20', '2026-10-20',
          '[]', ${sql.json(binding)}, ${sql.json(calendar)}, DEFAULT)`
        const result = yield* Effect.exit(sql.withTransaction(removeUnusedSchema))
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain('requires empty retired tables')
        expect(yield* sql`SELECT lock_id FROM opening_drive_qualification_locks`).toEqual([{ lock_id: hash }])
      }),
    )
  })
})
