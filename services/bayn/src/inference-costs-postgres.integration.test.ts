import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Cause, Effect, Exit, ManagedRuntime, Redacted, Result } from 'effect'
import { Statement } from 'effect/sql'

import { readInferenceExpenseSnapshot } from './inference-costs-postgres'
import { InferenceStage, makeInferenceCostReport } from './inference-costs'
import { evaluationRequestFixture } from './jev/test-support'
import { baynTestPostgresUrl } from './test-environment.test-support'
import { WriterFence, WriterFenceLive } from './execution/writer-fence'
import { forwardPerformanceSnapshot } from './forward-performance/postgres/snapshot'
import { expenseRateFixture, expenseSourceFixture } from './inference-expense.test-support'
import { makeInferenceExpenseQuote, type InferenceExpenseSource } from './inference-expense'
import { canonicalHashV1Result } from './hash'

const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn@127.0.0.1:55436/bayn_inference_test'
const ownedSchema = 'bayn_inference_cost_test'
const request = evaluationRequestFixture()
const otherRequest = expenseSourceFixture({ key: 'e' })
const jsonText = (value: unknown) =>
  JSON.stringify(value, (_, item: unknown) => (typeof item === 'bigint' ? item.toString() : item))
const retainedSource = (index: number, repeats: number) =>
  expenseSourceFixture({
    authorityGenerationHash: Result.getOrThrow(canonicalHashV1Result({ index })),
    state: `retained source evidence ${index} `.repeat(repeats),
  })
const insertSources = (sql: PgClient.PgClient, sources: readonly InferenceExpenseSource[], completed = false) =>
  Effect.gen(function* () {
    const requests = sources.map((source) => ({
      request_id: source.requestId,
      cycle_id: source.cycleId,
      authority_generation_hash: source.authorityGenerationHash,
      payload: source.request,
    }))
    yield* sql`INSERT INTO jev_evaluation_requests
      SELECT * FROM jsonb_to_recordset(${sql.json(requests)})
      AS row(request_id text,cycle_id text,authority_generation_hash text,payload jsonb)`
    if (completed) {
      yield* sql`INSERT INTO jev_evaluation_receipts
        SELECT * FROM jsonb_to_recordset(${sql.json(sources.map((source) => ({ request_id: source.requestId, payload: source.receipt })))})
        AS row(request_id text,payload jsonb)`
      yield* sql`INSERT INTO jev_evaluation_resolutions
        SELECT * FROM jsonb_to_recordset(${sql.json(sources.map((source) => ({ request_id: source.requestId, payload: source.resolution })))})
        AS row(request_id text,payload jsonb)`
    }
  })

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
        yield* sql`CREATE TABLE IF NOT EXISTS jev_inference_handoffs (request_id text PRIMARY KEY, payload jsonb NOT NULL)`
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
          (${otherRequest.requestId}, ${otherRequest.cycleId}, ${otherRequest.authorityGenerationHash}, ${sql.json(otherRequest.request)})`
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
      [request.requestId, otherRequest.requestId].sort(),
    )
    expect(result.evidence.requests.every((row) => row.receipt === null && row.resolution === null)).toBe(true)
    expect(jsonText(result)).not.toContain('fixture-account')
  })

  test('retains and orders a wide claimed session without spilling its evidence payloads to disk', async () => {
    const sources = Array.from({ length: 512 }, (_, index) => retainedSource(index, 48))
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DELETE FROM jev_evaluation_requests`
        yield* insertSources(sql, sources)
        yield* sql`SET work_mem='64kB'`
        yield* sql`SET temp_file_limit='0'`
        return yield* readInferenceExpenseSnapshot(sql, 'fixture-account', '1970-01-01').pipe(
          Effect.ensuring(sql`RESET work_mem`.pipe(Effect.andThen(sql`RESET temp_file_limit`), Effect.orDie)),
        )
      }),
    )
    expect(result.evidence.requests).toHaveLength(512)
    expect(result.evidence.requests.map((row) => row.requestId)).toEqual(
      sources.map((source) => source.requestId).toSorted(),
    )
    expect(new Set(result.evidence.requests.map((row) => row.requestId)).size).toBe(512)
    expect(result.evidence.requests.every((row) => row.receipt === null && row.resolution === null)).toBe(true)
    const originals = new Map(sources.map((source) => [source.requestId, source.request]))
    for (const row of result.evidence.requests) expect(row.request).toEqual(originals.get(row.requestId))
  })

  test('an unreceipted claim yields incomplete costs, not free inference', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DELETE FROM jev_evaluation_requests WHERE request_id = ${otherRequest.requestId}`
        return yield* readInferenceExpenseSnapshot(sql, 'fixture-account', '1970-01-01')
      }),
    )
    const report = Result.getOrThrow(
      makeInferenceCostReport(result.evidence, { schemaVersion: 'bayn.inference-rate-card.v1', rates: [] }),
    )
    expect(report.unknownUsageCount).toBe(2)
    expect(report.requests.flatMap((line) => ('stage' in line ? [line.stage] : [])).sort()).toEqual([
      InferenceStage.Chart,
      InferenceStage.Jev,
    ])
    expect(report.estimatedTotalCostMicros).toBeNull()
  })

  test('retains a session larger than one PostgreSQL protocol message', async () => {
    const sources = Array.from({ length: 512 }, (_, index) => retainedSource(index, 1_600))
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DELETE FROM jev_evaluation_requests`
        yield* insertSources(sql, sources, true)
        return yield* readInferenceExpenseSnapshot(sql, 'fixture-account', '1970-01-01')
      }),
    )
    expect(result.evidence.requests).toHaveLength(512)
    expect(result.evidence.requests.map((row) => row.requestId)).toEqual(
      sources.map((source) => source.requestId).toSorted(),
    )
    expect(new TextEncoder().encode(jsonText(result.evidence)).byteLength).toBeGreaterThan(16_777_216)
    const originals = new Map(sources.map((source) => [source.requestId, source]))
    for (const row of result.evidence.requests) {
      const source = originals.get(row.requestId)
      expect(row.request).toEqual(source?.request)
      expect(row.receipt).toEqual(source?.receipt)
      expect(row.resolution).toEqual(source?.resolution)
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
          yield* sql`DELETE FROM jev_evaluation_requests WHERE request_id = ${otherRequest.requestId}`
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
        yield* insertSources(
          sql,
          Array.from({ length: 10_001 }, (_, index) => retainedSource(index, 1)),
        )
        return yield* Effect.result(readInferenceExpenseSnapshot(sql, 'fixture-account', '1970-01-01'))
      }),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.message).toContain('complete-report limit')
  })

  test('keeps one cursor snapshot across concurrent writes in a read-committed writer transaction', async () => {
    const parsed = new URL(testUrl)
    parsed.searchParams.set('options', `-c search_path=${ownedSchema}`)
    const writer = ManagedRuntime.make(
      PgClient.layer({ url: Redacted.make(parsed.toString()), maxConnections: 1, transformJson: false }),
    )
    const source = expenseSourceFixture()
    const quote = Result.getOrThrow(makeInferenceExpenseQuote(source, expenseRateFixture))
    let fetches = 0
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`INSERT INTO jev_evaluation_requests VALUES
            (${source.requestId},${source.cycleId},${source.authorityGenerationHash},${sql.json(source.request)})`
          yield* sql`INSERT INTO jev_evaluation_receipts VALUES (${source.requestId},${sql.json(source.receipt)})`
          yield* sql`INSERT INTO jev_evaluation_resolutions VALUES (${source.requestId},${sql.json(source.resolution)})`
          yield* sql`INSERT INTO inference_expense_quotes VALUES
            (${quote.quoteHash},${source.accountId},${source.sessionDate}::date,${sql.json(quote)},NULL)`
          const fence = yield* WriterFence
          return yield* fence.transaction(
            Effect.gen(function* () {
              yield* sql`SELECT 1`
              const captured = yield* readInferenceExpenseSnapshot(
                sql,
                source.accountId,
                source.sessionDate,
                fence,
              ).pipe(
                Effect.provideService(Statement.CurrentTransformer, (statement) =>
                  Effect.gen(function* () {
                    if (statement.compile()[0].trimStart().startsWith('FETCH NEXT')) {
                      fetches++
                      if (fetches === 2)
                        yield* Effect.promise(() =>
                          writer.runPromise(
                            Effect.gen(function* () {
                              const write = yield* PgClient.PgClient
                              yield* write`DELETE FROM jev_evaluation_requests WHERE request_id=${request.requestId}`
                              yield* write`UPDATE inference_expense_quotes SET verified_at=clock_timestamp() WHERE quote_hash=${quote.quoteHash}`
                            }),
                          ),
                        )
                    }
                    return statement
                  }),
                ),
              )
              expect(
                yield* sql`SELECT count(*)::integer AS count FROM pg_cursors WHERE name LIKE 'bayn_expense_%'`,
              ).toEqual([{ count: 0 }])
              return captured
            }),
          )
        }).pipe(Effect.provide(WriterFenceLive)),
      )
      expect(fetches).toBeGreaterThan(2)
      expect(result.evidence.requests.map((row) => row.requestId)).toContain(request.requestId)
      expect(result.quotes).toEqual([{ quote, verifiedAt: null }])
      const after = await writer.runPromise(
        Effect.flatMap(
          PgClient.PgClient,
          (sql) => sql`SELECT verified_at IS NOT NULL AS verified FROM inference_expense_quotes`,
        ),
      )
      expect(after).toEqual([{ verified: true }])
    } finally {
      await writer.dispose()
    }
  })

  test('rolls back its cursor when capture is interrupted', async () => {
    const exit = await runtime.runPromiseExit(
      Effect.flatMap(PgClient.PgClient, (sql) =>
        readInferenceExpenseSnapshot(sql, 'fixture-account', '1970-01-01').pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) =>
            statement.compile()[0].trimStart().startsWith('FETCH NEXT') ? Effect.interrupt : Effect.succeed(statement),
          ),
        ),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(
      await runtime.runPromise(
        Effect.flatMap(
          PgClient.PgClient,
          (sql) => sql`SELECT count(*)::integer AS count FROM pg_cursors WHERE name LIKE 'bayn_expense_%'`,
        ),
      ),
    ).toEqual([{ count: 0 }])
  })

  test('rolls back its cursor when a fetched source fails validation', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`UPDATE jev_evaluation_requests SET authority_generation_hash='invalid'`
        return yield* readInferenceExpenseSnapshot(sql, 'fixture-account', '1970-01-01').pipe(Effect.result)
      }),
    )
    expect(Result.isFailure(result)).toBe(true)
    expect(
      await runtime.runPromise(
        Effect.flatMap(
          PgClient.PgClient,
          (sql) => sql`SELECT count(*)::integer AS count FROM pg_cursors WHERE name LIKE 'bayn_expense_%'`,
        ),
      ),
    ).toEqual([{ count: 0 }])
  })
})
