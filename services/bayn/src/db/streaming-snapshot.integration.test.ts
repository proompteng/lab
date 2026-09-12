import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Exit, Layer, ManagedRuntime, Redacted } from 'effect'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'
import { streamingFixture } from '../testing/streaming-market-fixture'
import { recoverStreamingSnapshotReference, streamingSnapshotReference } from '../market-data/streaming/reference'
import { StreamingIntradayMarketDataLive } from '../market-data/streaming/service'
import { KafkaMarketProjection } from '../market-data/streaming/kafka'
import { IntradayMarketData } from '../market-data/intraday/model'
import { withRecordedArchiveReads } from '../market-data/intraday/availability'
import { availabilityReader } from '../testing/archive-availability-fixture'
import { simulationFixture } from '../testing/simulated-streaming-fixture'
import { prepareFreshReplayDatabase } from '../intraday-replay/session-program'
import { makeSimulatedMarketData } from '../market-data/streaming/simulation-service'
import { loadIntradaySnapshot } from '../observe-composition/intraday-market-data'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn@127.0.0.1:55439/bayn_streaming_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const postgres = PostgresClientLive({
  operationTimeoutMs: 5000,
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
})
const makeRuntime = () => ManagedRuntime.make(postgres.pipe(Layer.provideMerge(NodeServices.layer)))
const fixture = streamingFixture()
const insert = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const reference = streamingSnapshotReference(fixture.snapshot)
  const manifest = reference.manifest
  yield* sql`INSERT INTO streaming_snapshot_references (snapshot_id,schema_version,content_hash,observed_at,manifest)
    VALUES (${manifest.snapshotId},${reference.schemaVersion},${manifest.contentHash},${manifest.observedAt}::timestamptz,${sql.json(manifest)})`
})

describePostgres('PostgreSQL streaming decision source evidence', () => {
  let runtime: ReturnType<typeof makeRuntime>
  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw new Error('Streaming integration tests require a local _test database')
    runtime = makeRuntime()
  })
  beforeEach(async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* postgresMigrations
      }),
    )
  })
  afterAll(async () => {
    await runtime?.dispose()
  })

  test('fresh replay rejects an occupied old schema before applying any migration', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* sql`CREATE TABLE authority_state (legacy_value text NOT NULL)`
        yield* sql`INSERT INTO authority_state VALUES ('preserve-existing-run')`
        const outcome = yield* Effect.exit(prepareFreshReplayDatabase)
        expect(Exit.isFailure(outcome)).toBe(true)
        expect(JSON.stringify(outcome)).toContain('Fresh replay requires an unused database')
        expect(yield* sql`SELECT legacy_value FROM authority_state`).toEqual([
          { legacy_value: 'preserve-existing-run' },
        ])
        expect(yield* sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`).toEqual([
          { tablename: 'authority_state' },
        ])
      }),
    )
  })

  test('fresh replay preserves a pre-authority schema and its migration history', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* sql`CREATE TABLE schema_migrations (migration_id integer, name text)`
        yield* sql`INSERT INTO schema_migrations VALUES (1, 'initial_schema')`
        yield* sql`CREATE TABLE evaluation_runs (run_id text)`
        yield* sql`INSERT INTO evaluation_runs VALUES ('preserve-pre-authority-evidence')`
        const outcome = yield* Effect.exit(prepareFreshReplayDatabase)
        expect(Exit.isFailure(outcome)).toBe(true)
        expect(JSON.stringify(outcome)).toContain('Fresh replay requires an unused database')
        expect(yield* sql`SELECT * FROM schema_migrations`).toEqual([{ migration_id: 1, name: 'initial_schema' }])
        expect(yield* sql`SELECT * FROM evaluation_runs`).toEqual([{ run_id: 'preserve-pre-authority-evidence' }])
        expect(yield* sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`).toEqual([
          { tablename: 'evaluation_runs' },
          { tablename: 'schema_migrations' },
        ])
      }),
    )
  })

  test('fresh replay rejects a different effective schema without migrating it', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`CREATE SCHEMA replay_schema_guard_test`
            yield* sql`CREATE TABLE replay_schema_guard_test.evaluation_runs (run_id text)`
            yield* sql`INSERT INTO replay_schema_guard_test.evaluation_runs VALUES ('preserve-other-schema')`
            yield* sql`SET LOCAL search_path TO replay_schema_guard_test, public`
            const outcome = yield* Effect.exit(prepareFreshReplayDatabase)
            expect(Exit.isFailure(outcome)).toBe(true)
            expect(JSON.stringify(outcome)).toContain('only effective schema')
            expect(yield* sql`SELECT * FROM replay_schema_guard_test.evaluation_runs`).toEqual([
              { run_id: 'preserve-other-schema' },
            ])
            expect(yield* sql`SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'`).toEqual([])
            expect(
              yield* sql`SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'replay_schema_guard_test'`,
            ).toEqual([{ tablename: 'evaluation_runs' }])
            yield* sql`DROP SCHEMA replay_schema_guard_test CASCADE`
          }),
        )
      }),
    )
  })

  test('fresh replay preserves routines and domains in an otherwise table-free schema', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* sql`CREATE FUNCTION public.replay_guard_existing_function() RETURNS integer LANGUAGE sql AS 'SELECT 73'`
        yield* sql`CREATE DOMAIN public.replay_guard_existing_domain AS integer CHECK (VALUE > 0)`
        const outcome = yield* Effect.exit(prepareFreshReplayDatabase)
        expect(Exit.isFailure(outcome)).toBe(true)
        expect(JSON.stringify(outcome)).toContain('empty public schema')
        expect(yield* sql`SELECT public.replay_guard_existing_function() AS result`).toEqual([{ result: 73 }])
        expect(
          yield* sql`SELECT typname FROM pg_catalog.pg_type WHERE typnamespace = 'public'::regnamespace AND typtype = 'd'`,
        ).toEqual([{ typname: 'replay_guard_existing_domain' }])
        expect(yield* sql`SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'`).toEqual([])
      }),
    )
  })

  test('fresh replay migrates only an empty public schema', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* prepareFreshReplayDatabase
        expect(yield* sql`SELECT count(*)::int AS count FROM authority_state`).toEqual([{ count: 0 }])
        const second = yield* Effect.exit(prepareFreshReplayDatabase)
        expect(Exit.isFailure(second)).toBe(true)
      }),
    )
  })

  test('simulation recovers only its committed source and cannot enter the live reference table', async () => {
    const fixture = simulationFixture()
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const market = yield* makeSimulatedMarketData(fixture.source, Effect.succeed(fixture.cursor))
        const snapshot = yield* market.simulation.loadSnapshot(fixture.query)
        const wrapped = withRecordedArchiveReads(market, availabilityReader, () =>
          Effect.die('unexpected archive receipt'),
        )
        const loaded = yield* loadIntradaySnapshot(wrapped, fixture.query)
        const reference = yield* market.simulation.verifyReference(snapshot)
        const fresh = yield* makeSimulatedMarketData(fixture.source, Effect.succeed(fixture.cursor))
        const missing = yield* Effect.exit(fresh.simulation.verifyReference(snapshot))
        const insert = sql`INSERT INTO simulated_snapshot_references (snapshot_id,schema_version,content_hash,observed_at,manifest)
        VALUES (${snapshot.manifest.snapshotId},${reference.schemaVersion},${snapshot.manifest.contentHash},${snapshot.manifest.observedAt}::timestamptz,${sql.json(snapshot.manifest)})`
        yield* Effect.exit(sql.withTransaction(insert.pipe(Effect.andThen(Effect.fail('decision rejected')))))
        const rolledBack = yield* Effect.exit(fresh.simulation.verifyReference(snapshot))
        yield* sql.withTransaction(insert)
        const recovered = yield* fresh.simulation.verifyReference(snapshot)
        const other = yield* makeSimulatedMarketData(
          { ...fixture.source, runId: 'f'.repeat(64) },
          Effect.succeed(fixture.cursor),
        )
        const crossRun = yield* Effect.exit(other.simulation.verifyReference(snapshot))
        const changed = yield* Effect.exit(fresh.simulation.verifyReference({ ...snapshot, bars: [] }))
        const liveTable =
          yield* Effect.exit(sql`INSERT INTO streaming_snapshot_references (snapshot_id,schema_version,content_hash,observed_at,manifest)
        VALUES (${snapshot.manifest.snapshotId},'bayn.streaming-snapshot-reference.v1',${snapshot.manifest.contentHash},${snapshot.manifest.observedAt}::timestamptz,${sql.json(snapshot.manifest)})`)
        const update = yield* Effect.exit(
          sql`UPDATE simulated_snapshot_references SET content_hash = ${'c'.repeat(64)}`,
        )
        const remove = yield* Effect.exit(sql`DELETE FROM simulated_snapshot_references`)
        const truncate = yield* Effect.exit(sql`TRUNCATE simulated_snapshot_references`)
        return {
          snapshot,
          loaded,
          recovered,
          missing,
          rolledBack,
          crossRun,
          changed,
          liveTable,
          update,
          remove,
          truncate,
        }
      }),
    )
    expect(result.loaded.manifest).toEqual(result.snapshot.manifest)
    expect(result.recovered.manifest).toEqual(result.snapshot.manifest)
    for (const rejected of [
      result.missing,
      result.rolledBack,
      result.crossRun,
      result.changed,
      result.liveTable,
      result.update,
      result.remove,
      result.truncate,
    ])
      expect(rejected._tag).toBe('Failure')
  })

  test('only recovers an exact committed cut and rolls evidence back with a failed decision transaction', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const missing = yield* Effect.exit(recoverStreamingSnapshotReference(fixture.snapshot.manifest))
        yield* Effect.exit(sql.withTransaction(insert.pipe(Effect.andThen(Effect.fail('decision rejected')))))
        const rolledBack = yield* Effect.exit(recoverStreamingSnapshotReference(fixture.snapshot.manifest))
        yield* sql.withTransaction(insert)
        const exact = yield* recoverStreamingSnapshotReference(fixture.snapshot.manifest)
        const different = yield* Effect.exit(
          recoverStreamingSnapshotReference({ ...fixture.snapshot.manifest, observedAt: '2026-09-04T14:30:03.000Z' }),
        )
        return { missing, rolledBack, exact, different }
      }),
    )
    expect(Exit.isFailure(result.missing)).toBe(true)
    expect(Exit.isFailure(result.rolledBack)).toBe(true)
    expect(result.exact.manifest).toEqual(fixture.snapshot.manifest)
    expect(Exit.isFailure(result.different)).toBe(true)
  })

  test('rejects incomplete manifests and every mutation of saved source evidence', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const incomplete =
          yield* Effect.exit(sql`INSERT INTO streaming_snapshot_references (snapshot_id,schema_version,content_hash,observed_at,manifest)
        VALUES (${'a'.repeat(64)},'bayn.streaming-snapshot-reference.v1',${'b'.repeat(64)},${fixture.query.observedAt}::timestamptz,'{}'::jsonb)`)
        yield* insert
        const update = yield* Effect.exit(
          sql`UPDATE streaming_snapshot_references SET content_hash = ${'c'.repeat(64)}`,
        )
        const remove = yield* Effect.exit(sql`DELETE FROM streaming_snapshot_references`)
        const truncate = yield* Effect.exit(sql`TRUNCATE streaming_snapshot_references`)
        const exact = yield* recoverStreamingSnapshotReference(fixture.snapshot.manifest)
        return { incomplete, update, remove, truncate, exact }
      }),
    )
    for (const rejected of [result.incomplete, result.update, result.remove, result.truncate])
      expect(rejected._tag).toBe('Failure')
    expect(result.exact.manifest.snapshotId).toBe(fixture.snapshot.manifest.snapshotId)
  })

  test('preserves streaming through the archive wrapper and verifies a fresh observation without archive reads', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const archive = {
          check: Effect.void,
          captureVersion: () => Effect.die('unexpected archive read'),
          loadSnapshot: () => Effect.die('unexpected archive read'),
          verifyArchiveSnapshot: () => Effect.die('unexpected archive verification'),
        }
        const live = StreamingIntradayMarketDataLive.pipe(
          Layer.provide(Layer.succeed(IntradayMarketData, archive)),
          Layer.provide(Layer.succeed(PgClient.PgClient, sql)),
          Layer.provide(
            Layer.succeed(KafkaMarketProjection, {
              read: Effect.succeed(fixture.cut),
              status: Effect.succeed({
                epoch: 'fixture-epoch',
                ready: true,
                sequence: fixture.cut.projection.sequence,
              }),
            }),
          ),
        )
        return yield* Effect.gen(function* () {
          const service = yield* IntradayMarketData
          const wrapped = withRecordedArchiveReads(service, availabilityReader, () =>
            Effect.die('unexpected archive receipt'),
          )
          if (wrapped.streaming === undefined) return yield* Effect.die('streaming capability lost')
          const snapshot = yield* wrapped.streaming.loadSnapshot(fixture.query)
          const reference = yield* wrapped.streaming.verifyReference(snapshot)
          const forged = yield* Effect.exit(
            wrapped.streaming.verifyReference({ ...snapshot, bars: snapshot.bars.slice(1) }),
          )
          return { reference, forged }
        }).pipe(Effect.provide(live))
      }),
    )
    expect(result.reference.manifest.snapshotId).toBe(fixture.snapshot.manifest.snapshotId)
    expect(Exit.isFailure(result.forged)).toBe(true)
  })
})
