import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Exit, Layer, ManagedRuntime, Redacted, Result } from 'effect'

import { WriterFence, WriterFenceLive } from '../execution/writer-fence'
import { canonicalHashV1 } from '../hash'
import { makeArchiveAvailabilityReceipts } from '../market-data/intraday/availability'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import {
  availabilityReader,
  availabilityRequest,
  availabilitySnapshot,
  reobserveAvailabilitySnapshot,
} from '../testing/archive-availability-fixture'
import { config as fixtureConfig } from '../testing/runtime-fixtures'
import { makeArchiveAvailabilityReader, makeArchiveAvailabilityRecorder } from './archive-availability'
import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const config = {
  ...fixtureConfig,
  operationTimeoutMs: 5_000,
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
}
const makeRuntime = () =>
  ManagedRuntime.make(
    WriterFenceLive.pipe(Layer.provideMerge(PostgresClientLive(config)), Layer.provideMerge(NodeServices.layer)),
  )
const completedAt = '2026-09-04T14:30:02.500Z'
const receipts = (availableAt = completedAt) =>
  Result.getOrThrow(
    makeArchiveAvailabilityReceipts(
      availabilitySnapshot,
      availabilityReader,
      availabilityRequest.observedAt,
      availableAt,
    ),
  )

describePostgres('PostgreSQL archive reader availability', () => {
  let runtime: ReturnType<typeof makeRuntime>
  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local database whose name ends in _test')
    }
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

  test('retains a completed read, rejects earlier replay, and preserves its first observation on retry', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const fence = yield* WriterFence
        const record = makeArchiveAvailabilityRecorder(sql, fence)
        const read = makeArchiveAvailabilityReader(sql, availabilityReader.endpointHash)
        const missing = yield* Effect.exit(read(availabilitySnapshot))
        yield* record(receipts())
        const early = yield* Effect.exit(read(availabilitySnapshot))
        yield* record(receipts('2026-09-04T14:30:02.900Z'))
        const proven = yield* read(reobserveAvailabilitySnapshot(completedAt))
        return {
          missing,
          early,
          proven,
          count: yield* sql`SELECT count(*)::integer AS count FROM intraday_archive_availability`,
        }
      }),
    )
    expect(Exit.isFailure(result.missing)).toBe(true)
    expect(Exit.isFailure(result.early)).toBe(true)
    expect(result.proven.receipts).toEqual(receipts())
    expect(result.count).toEqual([{ count: 1 }])
  })

  test('rejects conflicting source-identity content rather than silently accepting ON CONFLICT', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const fence = yield* WriterFence
        const record = makeArchiveAvailabilityRecorder(sql, fence)
        const [original] = receipts()
        if (original === undefined) throw new Error('fixture has no receipt')
        yield* record([original])
        const { receiptHash: _hash, ...material } = original
        const changedRecord = { ...availabilitySnapshot.quotes[0], askPrice: 101 }
        const changed = { ...material, record: changedRecord, recordContentHash: canonicalHashV1(changedRecord) }
        const conflict = yield* Effect.exit(record([{ ...changed, receiptHash: canonicalHashV1(changed) }]))
        const proven = yield* makeArchiveAvailabilityReader(
          sql,
          availabilityReader.endpointHash,
        )(reobserveAvailabilitySnapshot(completedAt))
        return { conflict, proven }
      }),
    )
    expect(Exit.isFailure(result.conflict)).toBe(true)
    expect(result.proven.receipts).toEqual(receipts())
  })

  test('development captures cannot substitute for production receipts', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const fence = yield* WriterFence
        const development = Result.getOrThrow(
          makeArchiveAvailabilityReceipts(
            availabilitySnapshot,
            { ...availabilityReader, verification: 'development-configured' },
            availabilityRequest.observedAt,
            completedAt,
          ),
        )
        yield* makeArchiveAvailabilityRecorder(sql, fence)(development)
        return yield* Effect.exit(
          makeArchiveAvailabilityReader(
            sql,
            availabilityReader.endpointHash,
          )(reobserveAvailabilitySnapshot(completedAt)),
        )
      }),
    )
    expect(Exit.isFailure(result)).toBe(true)
  })

  test('database evidence rejects UPDATE, DELETE, and TRUNCATE without losing its first receipt', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const fence = yield* WriterFence
        yield* makeArchiveAvailabilityRecorder(sql, fence)(receipts())
        const update = yield* Effect.exit(sql`UPDATE intraday_archive_availability SET available_at = available_at`)
        const deletion = yield* Effect.exit(sql`DELETE FROM intraday_archive_availability`)
        const truncate = yield* Effect.exit(sql`TRUNCATE intraday_archive_availability`)
        return {
          update,
          deletion,
          truncate,
          count: yield* sql`SELECT count(*)::integer AS count FROM intraday_archive_availability`,
        }
      }),
    )
    expect(Exit.isFailure(result.update)).toBe(true)
    expect(Exit.isFailure(result.deletion)).toBe(true)
    expect(Exit.isFailure(result.truncate)).toBe(true)
    expect(result.count).toEqual([{ count: 1 }])
  })
})
