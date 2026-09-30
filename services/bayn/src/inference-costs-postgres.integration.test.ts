import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Effect, ManagedRuntime, Redacted, Result } from 'effect'

import { readInferenceCostEvidence } from './inference-costs-postgres'
import { makeInferenceCostReport } from './inference-costs'
import { evaluationRequestFixture } from './jev/test-support'
import { baynTestPostgresUrl } from './test-environment.test-support'

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
        yield* sql`CREATE TABLE IF NOT EXISTS jev_evaluation_receipts (request_id text PRIMARY KEY, payload jsonb NOT NULL)`
        yield* sql`CREATE TABLE IF NOT EXISTS jev_evaluation_resolutions (request_id text PRIMARY KEY, payload jsonb NOT NULL)`
      }),
    )
  })
  beforeEach(async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`TRUNCATE autonomous_cycles, jev_evaluation_requests, jev_evaluation_receipts, jev_evaluation_resolutions`
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
        return yield* readInferenceCostEvidence(sql, 'fixture-account', '1970-01-01')
      }),
    )
    expect(result.requests.map((row) => row.requestId).sort()).toEqual([request.requestId, 'e'.repeat(64)].sort())
    expect(result.requests.every((row) => row.receipt === null && row.resolution === null)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('fixture-account')
  })

  test('an unreceipted claim yields incomplete costs, not free inference', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DELETE FROM jev_evaluation_requests WHERE request_id = ${'e'.repeat(64)}`
        return yield* readInferenceCostEvidence(sql, 'fixture-account', '1970-01-01')
      }),
    )
    const report = Result.getOrThrow(
      makeInferenceCostReport(result, { schemaVersion: 'bayn.inference-rate-card.v1', rates: [] }),
    )
    expect(report.unknownUsageCount).toBe(1)
    expect(report.estimatedTotalCostMicros).toBeNull()
  })

  test('fails instead of silently truncating a large session', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DELETE FROM jev_evaluation_requests`
        yield* sql`INSERT INTO jev_evaluation_requests
        SELECT md5(n::text) || md5(n::text), ${request.cycleId}, ${request.authorityGenerationHash}, '{}'::jsonb
        FROM generate_series(1, 10001) AS n`
        return yield* Effect.result(readInferenceCostEvidence(sql, 'fixture-account', '1970-01-01'))
      }),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.message).toContain('complete-report limit')
  })
})
