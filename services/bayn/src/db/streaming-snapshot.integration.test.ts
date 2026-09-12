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
