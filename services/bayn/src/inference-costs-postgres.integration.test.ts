import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Effect, ManagedRuntime, Redacted, Result } from 'effect'

import { readInferenceExpenseSnapshot } from './inference-costs-postgres'
import { makeInferenceCostReport } from './inference-costs'
import { evaluationRequestFixture } from './jev/test-support'
import { baynTestPostgresUrl } from './test-environment.test-support'
import { WriterFence, WriterFenceLive } from './execution/writer-fence'
import { forwardPerformanceSnapshot } from './forward-performance/postgres/snapshot'

const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn@127.0.0.1:55436/bayn_inference_test'
const ownedSchema = 'bayn_inference_cost_test'
const request = evaluationRequestFixture()

describePostgres('read-only inference cost PostgreSQL scope', () => {
  let runtime: ManagedRuntime.ManagedRuntime<PgClient.PgClient, unknown>
  beforeAll(async () => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw new Error('Inference cost integration tests require an isolated local _test database')
    parsed.searchParams.set('options', `-c search_path=${ownedSchema}`)
    runtime = ManagedRuntime.make(
      PgClient.layer({ url: Redacted.make(parsed.toString()), maxConnections: 1, transformJson: false }),
    )
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`CREATE SCHEMA IF NOT EXISTS bayn_inference_cost_test`
        yield* sql`CREATE TABLE IF NOT EXISTS autonomous_cycles (
          cycle_id text PRIMARY KEY, account_id text NOT NULL, execution_session_date date NOT NULL, state text NOT NULL
        )`
        yield* sql`CREATE TABLE IF NOT EXISTS jev_evaluation_requests (
          request_id text PRIMARY KEY, cycle_id text NOT NULL, authority_generation_hash text NOT NULL, payload jsonb NOT NULL
        )`
        yield* sql`CREATE TABLE IF NOT EXISTS inference_expense_quotes (
          quote_hash text PRIMARY KEY, account_id text NOT NULL, session_date date NOT NULL,
          payload jsonb NOT NULL, verified_at timestamptz
        )`
        yield* sql`CREATE TABLE IF NOT EXISTS jev_evaluation_receipts (request_id text PRIMARY KEY, payload jsonb NOT NULL)`
        yield* sql`CREATE TABLE IF NOT EXISTS jev_evaluation_resolutions (request_id text PRIMARY KEY, payload jsonb NOT NULL)`
      }),
    )
  })
  beforeEach(async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`TRUNCATE inference_expense_quotes, autonomous_cycles, jev_evaluation_requests, jev_evaluation_receipts, jev_evaluation_resolutions`
        yield* sql`INSERT INTO autonomous_cycles VALUES
          (${'a'.repeat(64)}, 'fixture-account', '1970-01-01', 'BLOCKED'),
          (${'b'.repeat(64)}, 'other-account', '1970-01-01', 'COMPLETED'),
          (${'c'.repeat(64)}, 'fixture-account', '1970-01-02', 'NO_TRADE'),
          (${'e'.repeat(64)}, 'fixture-account', '1970-01-01', 'NO_TRADE')`
        yield* sql`INSERT INTO jev_evaluation_requests VALUES
          (${request.requestId}, ${request.cycleId}, ${request.authorityGenerationHash}, ${sql.json(request)}),
          (${'b'.repeat(64)}, ${'b'.repeat(64)}, ${'d'.repeat(64)}, '{}'::jsonb),
          (${'c'.repeat(64)}, ${'c'.repeat(64)}, ${'d'.repeat(64)}, '{}'::jsonb),
          (${'e'.repeat(64)}, ${'e'.repeat(64)}, ${'d'.repeat(64)}, '{}'::jsonb)`
      }),
    )
  })
  afterAll(async () => {
    if (runtime === undefined) return
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA bayn_inference_cost_test CASCADE`
      }),
    )
    await runtime.dispose()
  })

  test('filters account and session, including blocked and no-trade claims without receipts', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return yield* readInferenceExpenseSnapshot(sql, 'fixture-account', '1970-01-01')
      }),
    )
    expect(result.evidence.requests.map((row) => row.requestId).sort()).toEqual(
      [request.requestId, 'e'.repeat(64)].sort(),
    )
    expect(result.evidence.requests.every((row) => row.receipt === null && row.resolution === null)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('fixture-account')
  })

  test('retains and orders a wide claimed session without spilling its evidence payloads to disk', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DELETE FROM jev_evaluation_requests`
        yield* sql`INSERT INTO jev_evaluation_requests
          SELECT md5(n::text) || md5(n::text), ${request.cycleId}, ${request.authorityGenerationHash},
            jsonb_build_object('retained',repeat(md5(n::text),32))
          FROM generate_series(512,1,-1) AS n`
        yield* sql`SET work_mem='64kB'`
        yield* sql`SET temp_file_limit='0'`
        return yield* readInferenceExpenseSnapshot(sql, 'fixture-account', '1970-01-01').pipe(
          Effect.ensuring(sql`RESET work_mem`.pipe(Effect.andThen(sql`RESET temp_file_limit`), Effect.orDie)),
        )
      }),
    )
    expect(result.evidence.requests).toHaveLength(512)
    expect(result.evidence.requests.map((row) => row.requestId)).toEqual(
      result.evidence.requests.map((row) => row.requestId).toSorted(),
    )
    expect(new Set(result.evidence.requests.map((row) => row.requestId)).size).toBe(512)
    expect(result.evidence.requests.every((row) => row.receipt === null && row.resolution === null)).toBe(true)
    for (const row of result.evidence.requests) {
      expect(row.request).toEqual({ retained: row.requestId.slice(0, 32).repeat(32) })
    }
  })

  test('an unreceipted claim yields incomplete costs, not free inference', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DELETE FROM jev_evaluation_requests WHERE request_id = ${'e'.repeat(64)}`
        return yield* readInferenceExpenseSnapshot(sql, 'fixture-account', '1970-01-01')
      }),
    )
    const report = Result.getOrThrow(
      makeInferenceCostReport(result.evidence, { schemaVersion: 'bayn.inference-rate-card.v1', rates: [] }),
    )
    expect(report.unknownUsageCount).toBe(1)
    expect(report.estimatedTotalCostMicros).toBeNull()
  })

  test('retains a session larger than one PostgreSQL protocol message', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DELETE FROM jev_evaluation_requests`
        yield* sql`INSERT INTO jev_evaluation_requests
          SELECT md5(n::text) || md5(n::text), ${request.cycleId}, ${request.authorityGenerationHash},
            jsonb_build_object('retained',repeat(md5(n::text),512))
          FROM generate_series(512,1,-1) AS n`
        yield* sql`INSERT INTO jev_evaluation_receipts
          SELECT request_id, jsonb_build_object('retainedReceipt',repeat(left(request_id,32),256))
          FROM jev_evaluation_requests`
        yield* sql`INSERT INTO jev_evaluation_resolutions
          SELECT request_id, jsonb_build_object('retainedResolution',repeat(left(request_id,32),384))
          FROM jev_evaluation_requests`
        return yield* readInferenceExpenseSnapshot(sql, 'fixture-account', '1970-01-01')
      }),
    )
    expect(result.evidence.requests).toHaveLength(512)
    expect(result.evidence.requests.map((row) => row.requestId)).toEqual(
      result.evidence.requests.map((row) => row.requestId).toSorted(),
    )
    expect(new TextEncoder().encode(JSON.stringify(result.evidence)).byteLength).toBeGreaterThan(16_777_216)
    for (const row of result.evidence.requests) {
      const value = row.requestId.slice(0, 32)
      expect(row.request).toEqual({ retained: value.repeat(512) })
      expect(row.receipt).toEqual({ retainedReceipt: value.repeat(256) })
      expect(row.resolution).toEqual({ retainedResolution: value.repeat(384) })
    }
  }, 30_000)

  test('retains the snapshot time when the account session has no requests or quotes', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DELETE FROM jev_evaluation_requests`
        return yield* readInferenceExpenseSnapshot(sql, 'fixture-account', '1970-01-01')
      }),
    )
    expect(result.evidence.requests).toEqual([])
    expect(result.quotes).toEqual([])
    expect(Number.isFinite(Date.parse(result.evidence.asOf))).toBe(true)
  })

  test('inherits the report snapshot while a separate connection commits a request deletion', async () => {
    const parsed = new URL(testUrl)
    parsed.searchParams.set('options', `-c search_path=${ownedSchema}`)
    const writer = ManagedRuntime.make(
      PgClient.layer({ url: Redacted.make(parsed.toString()), maxConnections: 1, transformJson: false }),
    )
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`DELETE FROM jev_evaluation_requests WHERE request_id = ${'e'.repeat(64)}`
          return yield* forwardPerformanceSnapshot(sql).withTransaction(
            Effect.gen(function* () {
              const before = yield* sql<{ count: number; snapshot_at: string }>`SELECT count(*)::integer AS count,
                  to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS snapshot_at
                  FROM jev_evaluation_requests WHERE request_id = ${request.requestId}`
              yield* Effect.promise(() =>
                writer.runPromise(
                  Effect.gen(function* () {
                    const writeSql = yield* PgClient.PgClient
                    yield* writeSql`DELETE FROM jev_evaluation_requests WHERE request_id = ${request.requestId}`
                  }),
                ),
              )
              const costs = yield* readInferenceExpenseSnapshot(sql, 'fixture-account', '1970-01-01')
              return { before, costs }
            }),
          )
        }),
      )
      expect(result.before[0]?.['count']).toBe(1)
      expect(result.costs.evidence.requests.map((row) => row.requestId)).toEqual([request.requestId])
      expect(result.costs.evidence.asOf).toBe(result.before[0]?.['snapshot_at'])
      const after = await writer.runPromise(
        Effect.flatMap(
          PgClient.PgClient,
          (sql) =>
            sql`SELECT count(*)::integer AS count FROM jev_evaluation_requests WHERE request_id = ${request.requestId}`,
        ),
      )
      expect(after[0]?.['count']).toBe(0)
    } finally {
      await writer.dispose()
    }
  })

  test('inherits a queried writer transaction without changing its isolation or read-only mode', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const fence = yield* WriterFence
        return yield* fence.transaction(
          Effect.gen(function* () {
            yield* sql`SELECT 1`
            const evidence = yield* readInferenceExpenseSnapshot(sql, 'fixture-account', '1970-01-01', fence)
            yield* sql`INSERT INTO autonomous_cycles VALUES ('writer-append', 'fixture-account', '1970-01-01', 'NO_TRADE')`
            return evidence
          }),
        )
      }).pipe(Effect.provide(WriterFenceLive)),
    )
    expect(result.evidence.requests).toHaveLength(2)
  })

  test('fails instead of silently truncating a large session', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DELETE FROM jev_evaluation_requests`
        yield* sql`INSERT INTO jev_evaluation_requests
        SELECT md5(n::text) || md5(n::text), ${request.cycleId}, ${request.authorityGenerationHash}, '{}'::jsonb
        FROM generate_series(1, 10001) AS n`
        return yield* Effect.result(readInferenceExpenseSnapshot(sql, 'fixture-account', '1970-01-01'))
      }),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.message).toContain('complete-report limit')
  })
})
