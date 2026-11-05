import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { NodeServices } from '@effect/platform-node'
import { ConfigProvider, Context, Deferred, Effect, Fiber, ManagedRuntime, Redacted, Result, Schema } from 'effect'
import { SqlClient, Statement } from 'effect/sql'
import { canonicalHashV1Result } from './hash'

import requestMigration from '../migrations/0076_jev_evaluation_evidence'
import resolutionMigration from '../migrations/0077_jev_evaluation_resolution'
import expenseMigration from '../migrations/0091_inference_expense_quotes'
import inferenceRequestVersion from '../migrations/0150_inference_request_version'
import expenseSourceQueue from '../migrations/0173_inference_expense_source_queue'
import {
  buildInferenceExpensePlan,
  inferenceExpenseBatchSize,
  makeInferenceExpenseQuote,
  type InferenceExpenseSource,
} from './inference-expense'
import { expenseRateFixture, expenseSourceFixture } from './inference-expense.test-support'
import { makeInferenceExpenseStore } from './inference-expense-postgres'
import { baynTestPostgresUrl, baynTestTigerBeetleAddress } from './test-environment.test-support'
import { runInferenceExpensePass } from './inference-expense-runtime'
import { postInferenceExpenses, readInferenceExpenseLedger } from './inference-expense-journal'
import { acquireInferenceExpenseSnapshot } from './inference-costs-postgres'
import { makeTigerBeetleRequestClient } from './tigerbeetle-client'
import {
  readForwardInferenceExpenses,
  readForwardInferenceExpenseSnapshots,
} from './forward-performance/inference-expenses'
import { readInferenceExpenseSession } from './inference-cost-command'
import { WriterFence, WriterFenceLive } from './execution/writer-fence'
import { forwardPerformanceSnapshot } from './forward-performance/postgres/snapshot'

const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn@127.0.0.1:55436/bayn_expense_test'
const schema = 'bayn_inference_expense_test'

describePostgres('immutable inference expense PostgreSQL queue', () => {
  let runtime: ManagedRuntime.ManagedRuntime<PgClient.PgClient | SqlClient.SqlClient, unknown>
  beforeAll(() => {
    const url = new URL(testUrl)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test'))
      throw new Error('Inference expense tests require an isolated local _test database')
    url.searchParams.set('options', `-c search_path=${schema}`)
    runtime = ManagedRuntime.make(
      PgClient.layer({ url: Redacted.make(url.toString()), transformJson: false, maxConnections: 3 }),
    )
  })
  const resetDatabase = async (withRequestVersion = true) => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA IF EXISTS bayn_inference_expense_test CASCADE`
        yield* sql`CREATE SCHEMA bayn_inference_expense_test`
        yield* sql`CREATE TABLE autonomous_cycles (cycle_id text PRIMARY KEY, account_id text NOT NULL, execution_session_date date NOT NULL)`
        yield* sql`CREATE TABLE authority_generations (generation_hash text PRIMARY KEY)`
        yield* sql`CREATE FUNCTION reject_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'immutable fixture evidence'; END; $$`
        yield* requestMigration
        if (withRequestVersion) yield* inferenceRequestVersion
        yield* resolutionMigration
        yield* expenseMigration
        yield* sql`CREATE TABLE jev_inference_handoffs (request_id text PRIMARY KEY, handoff_hash text NOT NULL, payload jsonb NOT NULL)`
        yield* sql`ALTER TABLE inference_expense_quotes
          ADD COLUMN provider_stage text GENERATED ALWAYS AS (COALESCE(payload #>> '{line,stage}', 'JEV')) STORED,
          ADD COLUMN handoff_hash text GENERATED ALWAYS AS (payload #>> '{line,handoffHash}') STORED,
          ADD COLUMN chart_claim_hash text GENERATED ALWAYS AS (payload #>> '{line,chartClaimHash}') STORED,
          ADD COLUMN chart_terminal_hash text GENERATED ALWAYS AS (payload #>> '{line,chartTerminalHash}') STORED,
          ADD COLUMN stage_claim_hash text GENERATED ALWAYS AS (payload #>> '{line,stageClaimHash}') STORED,
          ADD COLUMN stage_terminal_hash text GENERATED ALWAYS AS (payload #>> '{line,stageTerminalHash}') STORED,
          ADD COLUMN stage_skip_hash text GENERATED ALWAYS AS (payload #>> '{line,stageSkipHash}') STORED`
        yield* sql`CREATE TABLE jev_chart_dispatch_claims (request_id text PRIMARY KEY, claim_hash text NOT NULL, payload jsonb NOT NULL)`
        yield* sql`CREATE TABLE jev_chart_terminal_receipts (request_id text PRIMARY KEY, terminal_hash text NOT NULL, payload jsonb NOT NULL)`
        yield* sql`CREATE TABLE jev_staged_dispatch_claims (request_id text NOT NULL, stage text NOT NULL, claim_hash text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY(request_id,stage))`
        yield* sql`CREATE TABLE jev_staged_terminal_receipts (request_id text NOT NULL, stage text NOT NULL, terminal_hash text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY(request_id,stage))`
        yield* sql`CREATE TABLE jev_staged_skip_receipts (request_id text NOT NULL, stage text NOT NULL, skip_hash text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY(request_id,stage))`
        if (withRequestVersion) yield* expenseSourceQueue
      }),
    )
  }
  beforeEach(() => resetDatabase())
  afterAll(async () => {
    if (runtime === undefined) return
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA bayn_inference_expense_test CASCADE`
      }),
    )
    await runtime.dispose()
  })
  const persistSource = (source: InferenceExpenseSource) =>
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const quote = Result.getOrThrow(makeInferenceExpenseQuote(source, expenseRateFixture))
      yield* sql`INSERT INTO autonomous_cycles VALUES (${source.cycleId}, ${source.accountId}, ${source.sessionDate}::date) ON CONFLICT DO NOTHING`
      yield* sql`INSERT INTO authority_generations VALUES (${source.authorityGenerationHash}) ON CONFLICT DO NOTHING`
      yield* sql`INSERT INTO jev_evaluation_requests (request_id, cycle_id, authority_generation_hash, payload)
      VALUES (${source.requestId}, ${source.cycleId}, ${source.authorityGenerationHash}, ${sql.json(source.request)}) ON CONFLICT DO NOTHING`
      if (source.receipt !== null)
        yield* sql`INSERT INTO jev_evaluation_receipts VALUES (${source.requestId}, ${quote.line.receiptHash}, ${sql.json(source.receipt)}) ON CONFLICT DO NOTHING`
      yield* sql`INSERT INTO jev_evaluation_resolutions (request_id, resolution_hash, payload)
      VALUES (${source.requestId}, ${quote.line.resolutionHash}, ${sql.json(source.resolution)}) ON CONFLICT DO NOTHING`
      return quote
    })

  test('backfills populated legacy requests without changing retained evidence or expense discovery', async () => {
    await resetDatabase(false)
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const pending = expenseSourceFixture()
        const frozen = expenseSourceFixture({ key: 'b' })
        const missing = expenseSourceFixture({ key: 'c', missing: true })
        const other = expenseSourceFixture({ key: 'd', accountId: 'other-account' })
        yield* persistSource(pending)
        const frozenQuote = yield* persistSource(frozen)
        yield* persistSource(missing)
        yield* persistSource(other)
        const store = makeInferenceExpenseStore(sql, pending.accountId, '1970-01-01')
        yield* sql`INSERT INTO inference_expense_quotes(quote_hash,account_id,session_date,payload)
          VALUES(${frozenQuote.quoteHash},${frozen.accountId},${frozen.sessionDate}::date,${sql.json(frozenQuote)})`
        const evidence = () => sql`SELECT request_id, payload::text AS payload_bytes,
          payload->>'schemaVersion' AS wire_version FROM jev_evaluation_requests ORDER BY request_id COLLATE "C"`
        const before = yield* evidence()
        // This legacy fixture has one provider stage, no handoff and one immutable quote at most.
        const oldDiscovery = yield* sql`SELECT request.request_id
          FROM autonomous_cycles AS cycle
          JOIN jev_evaluation_requests AS request ON request.cycle_id=cycle.cycle_id
          JOIN jev_evaluation_resolutions AS resolution ON resolution.request_id=request.request_id
          LEFT JOIN jev_evaluation_receipts AS receipt ON receipt.request_id=request.request_id
          WHERE cycle.account_id=${pending.accountId} AND cycle.execution_session_date >= '1970-01-01'::date
          AND (SELECT count(*) FROM inference_expense_quotes AS quote
            WHERE quote.request_id=request.request_id AND quote.handoff_hash IS NULL
            AND quote.receipt_hash IS NOT DISTINCT FROM receipt.receipt_hash)
            < CASE WHEN request.payload->>'schemaVersion'='bayn.jev-evaluation-request.v2' THEN 2 ELSE 1 END
          ORDER BY request.request_id COLLATE "C" LIMIT 64`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ request_id: Schema.String })))),
        )
        yield* inferenceRequestVersion
        yield* expenseSourceQueue
        expect(yield* evidence()).toEqual(before)
        expect(
          yield* sql`SELECT request_id FROM jev_evaluation_requests
          WHERE schema_version IS DISTINCT FROM payload->>'schemaVersion'`,
        ).toHaveLength(0)
        const discovered = yield* store.newSources
        expect(discovered.map((source) => ({ request_id: source.requestId }))).toEqual([...oldDiscovery])
        expect(discovered.map((source) => source.requestId).sort()).toEqual(
          [pending.requestId, missing.requestId].sort(),
        )
        expect(discovered.find((source) => source.requestId === pending.requestId)?.request).toEqual(pending.request)
        expect(discovered.find((source) => source.requestId === missing.requestId)?.request).toEqual(missing.request)
      }),
    )
  })

  test('retains the immutable request payload with its database-derived wire version', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const source = expenseSourceFixture()
        yield* persistSource(source)
        const sql = yield* PgClient.PgClient
        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([Schema.Struct({ schemaVersion: Schema.String, payload: Schema.Unknown })]),
        )(
          yield* sql`SELECT schema_version AS "schemaVersion", payload FROM jev_evaluation_requests WHERE request_id=${source.requestId}`,
        )
        expect(rows[0]).toEqual({ schemaVersion: source.request.schemaVersion, payload: source.request })
        expect(
          Result.isFailure(
            yield* sql`UPDATE jev_evaluation_requests SET schema_version='invented' WHERE request_id=${source.requestId}`.pipe(
              Effect.result,
            ),
          ),
        ).toBe(true)
      }),
    )
  })

  test('does not reopen large historical request bodies once every source is quoted', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`ALTER TABLE jev_evaluation_requests ALTER COLUMN payload SET STORAGE EXTERNAL`
        const count = 64
        const state = 'retained market evidence '.repeat(5_000)
        const quotes = []
        for (let index = 0; index < count; index++)
          quotes.push(
            yield* persistSource(
              expenseSourceFixture({
                authorityGenerationHash: Result.getOrThrow(canonicalHashV1Result({ index })),
                state,
              }),
            ),
          )
        const store = makeInferenceExpenseStore(sql, 'fixture-account', '1970-01-01')
        yield* store.freeze(quotes)
        yield* sql`ANALYZE jev_evaluation_requests, jev_evaluation_receipts, inference_expense_quotes`
        let compiled: ReturnType<Statement.Statement<unknown>['compile']> | undefined
        expect(
          yield* store.newSources.pipe(
            Effect.provideService(Statement.CurrentTransformer, (statement) =>
              Effect.sync(() => {
                compiled = statement.compile()
                return statement
              }),
            ),
          ),
        ).toHaveLength(0)
        if (compiled === undefined) return yield* Effect.die('Expense lookup was not executed')
        const [text, parameters] = compiled
        const explain = yield* sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${text}`, parameters)
        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({
              'QUERY PLAN': Schema.Array(
                Schema.Struct({
                  Plan: Schema.Struct({ 'Shared Hit Blocks': Schema.Int, 'Shared Read Blocks': Schema.Int }),
                }),
              ),
            }),
          ),
        )(explain)
        const plan = rows[0]?.['QUERY PLAN'][0]?.Plan
        if (plan === undefined) return yield* Effect.die('Expense lookup buffer evidence is absent')
        expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(
          count * Math.ceil(state.length / 8_192),
        )
        expect(yield* store.session('1970-01-01')).toHaveLength(count)
      }),
    )
  })

  test('discovers only the bound account and replays frozen quotes before and after verification', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const source = expenseSourceFixture()
        const quote = yield* persistSource(source)
        yield* persistSource(expenseSourceFixture({ key: 'b', accountId: 'other-account' }))
        const store = makeInferenceExpenseStore(yield* PgClient.PgClient, source.accountId, '1970-01-01')
        const discovered = yield* store.newSources
        yield* store.freeze([quote])
        yield* store.freeze([quote])
        const pending = yield* store.pending
        yield* store.acknowledge(pending)
        yield* store.acknowledge(pending)
        return {
          discovered,
          pending,
          remaining: yield* store.pending,
          newSources: yield* store.newSources,
          rows: yield* store.session(source.sessionDate),
        }
      }),
    )
    expect(result.discovered).toHaveLength(1)
    expect(result.pending).toHaveLength(1)
    expect(result.remaining).toHaveLength(0)
    expect(result.newSources).toHaveLength(0)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.verifiedAt).not.toBeNull()
  })

  test('freezes the first tariff and rejects an alternative price for the same retained receipt', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const source = expenseSourceFixture()
        const quote = yield* persistSource(source)
        const store = makeInferenceExpenseStore(yield* PgClient.PgClient, source.accountId, '1970-01-01')
        yield* store.freeze([quote])
        const alternative = Result.getOrThrow(
          makeInferenceExpenseQuote(source, {
            ...expenseRateFixture,
            rates: [{ ...expenseRateFixture.rates[0], inputMicrosPerMillionTokens: '43000' }],
          }),
        )
        const outcome = yield* store.freeze([alternative]).pipe(Effect.result)
        expect(Result.isFailure(outcome)).toBe(true)
        expect((yield* store.pending)[0]?.quoteHash).toBe(quote.quoteHash)
      }),
    )
  })

  test('discovers ordered pending batches after quoted history without borrowing another account', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const accountId = 'bounded-expense-account'
        const sources = Array.from({ length: inferenceExpenseBatchSize * 3 + 3 }, (_, index) =>
          expenseSourceFixture({
            key: (index % 15).toString(16),
            authorityGenerationHash: index.toString(16).padStart(64, '0'),
            accountId,
          }),
        )
        const store = makeInferenceExpenseStore(yield* PgClient.PgClient, accountId, '1970-01-01')
        for (const [index, source] of sources.entries()) {
          const quote = yield* persistSource(source)
          if (index < inferenceExpenseBatchSize * 2) yield* store.freeze([quote])
        }
        yield* persistSource(expenseSourceFixture({ key: 'f', accountId: 'foreign-expense-account' }))
        const pending = sources
          .slice(inferenceExpenseBatchSize * 2)
          .map((source) => source.requestId)
          .sort()
        const first = yield* store.newSources
        expect(first.map((source) => source.requestId)).toEqual(pending.slice(0, inferenceExpenseBatchSize))
        expect(first.every((source) => source.accountId === accountId)).toBe(true)
        yield* store.freeze(
          yield* Effect.forEach(first, (source) =>
            Effect.fromResult(makeInferenceExpenseQuote(source, expenseRateFixture)),
          ),
        )
        expect((yield* store.newSources).map((source) => source.requestId)).toEqual(
          pending.slice(inferenceExpenseBatchSize),
        )
      }),
    )
  }, 30_000)

  test('retains an abandoned gap and later discovers its immutable late receipt', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const source = expenseSourceFixture({ missing: true })
        const missing = yield* persistSource(source)
        const store = makeInferenceExpenseStore(yield* PgClient.PgClient, source.accountId, '1970-01-01')
        yield* store.freeze([missing])
        yield* store.acknowledge([missing])
        yield* persistSource(expenseSourceFixture({ abandoned: true }))
        const discovered = yield* store.newSources
        expect(discovered).toHaveLength(1)
        const current = discovered[0]
        if (current === undefined) return yield* Effect.die('synthetic late source is absent')
        const late = Result.getOrThrow(makeInferenceExpenseQuote(current, expenseRateFixture))
        yield* store.freeze([late])
        expect((yield* store.pending)[0]?.line.estimatedCostPicoUsd).toBe('42000')
        expect(yield* store.session(source.sessionDate)).toHaveLength(2)
      }),
    )
  })

  test('does not lose a late receipt while retiring an older frozen source revision', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const source = expenseSourceFixture({ missing: true })
        const quote = yield* persistSource(source)
        const store = makeInferenceExpenseStore(sql, source.accountId, '1970-01-01')
        const written = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const writer = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* persistSource(expenseSourceFixture({ abandoned: true }))
              yield* Deferred.succeed(written, undefined)
              yield* Deferred.await(release)
            }),
          )
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(written)
        const freezer = yield* store.freeze([quote]).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.gen(function* () {
          while (true) {
            const blocked = yield* sql`SELECT 1 FROM pg_stat_activity
              WHERE datname=current_database() AND wait_event_type='Lock'
                AND query LIKE '%DELETE FROM inference_expense_source_pending%'
                AND pid<>pg_backend_pid()`
            if (blocked.length > 0) break
            yield* Effect.sleep('5 millis')
          }
        }).pipe(Effect.timeout('5 seconds'), Effect.ensuring(Deferred.succeed(release, undefined)))
        yield* Fiber.join(writer)
        yield* Fiber.join(freezer)
        expect(
          yield* sql`SELECT 1 FROM inference_expense_source_pending WHERE request_id=${source.requestId}`,
        ).toHaveLength(1)
        const discovered = yield* store.newSources
        expect(discovered).toHaveLength(1)
        const late = discovered[0]
        if (late === undefined) return yield* Effect.die('Late receipt was lost')
        yield* store.freeze([Result.getOrThrow(makeInferenceExpenseQuote(late, expenseRateFixture))])
        expect(yield* store.newSources).toEqual([])
        expect(yield* store.session(source.sessionDate)).toHaveLength(2)
      }),
    )
  })

  test('rolls source work back with its evidence and re-enqueues after a prior retirement', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const source = expenseSourceFixture({ missing: true })
        const quote = yield* persistSource(source)
        const store = makeInferenceExpenseStore(sql, source.accountId, '1970-01-01')
        const before =
          yield* sql`SELECT revision::text AS revision FROM inference_expense_source_pending WHERE request_id=${source.requestId}`
        const rolledBack = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* persistSource(expenseSourceFixture({ abandoned: true }))
              return yield* Effect.fail('rollback fixture')
            }),
          )
          .pipe(Effect.result)
        expect(Result.isFailure(rolledBack)).toBe(true)
        expect(
          yield* sql`SELECT revision::text AS revision FROM inference_expense_source_pending WHERE request_id=${source.requestId}`,
        ).toEqual(before)
        yield* store.freeze([quote])
        expect(yield* sql`SELECT 1 FROM inference_expense_source_pending`).toEqual([])
        yield* persistSource(expenseSourceFixture({ abandoned: true }))
        const after =
          yield* sql`SELECT revision::text AS revision FROM inference_expense_source_pending WHERE request_id=${source.requestId}`
        expect(after).not.toEqual(before)
        expect(yield* store.newSources).toHaveLength(1)
      }),
    )
  })

  test('does not allow repricing, deletion, truncation or a second verification timestamp', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const source = expenseSourceFixture()
        const quote = yield* persistSource(source)
        const sql = yield* PgClient.PgClient
        const store = makeInferenceExpenseStore(sql, source.accountId, '1970-01-01')
        yield* store.freeze([quote])
        for (const mutation of [
          sql`UPDATE inference_expense_quotes SET payload = payload`,
          sql`DELETE FROM inference_expense_quotes`,
          sql`TRUNCATE inference_expense_quotes`,
        ])
          expect(Result.isFailure(yield* mutation.pipe(Effect.result))).toBe(true)
        for (const mutation of [
          sql`UPDATE inference_expense_quotes SET verified_at = transaction_timestamp(), quote_hash = repeat('a', 64)`,
          sql`UPDATE inference_expense_quotes SET verified_at = transaction_timestamp(), account_id = 'different-account'`,
          sql`UPDATE inference_expense_quotes SET verified_at = transaction_timestamp(), session_date = session_date + 1`,
          sql`UPDATE inference_expense_quotes SET verified_at = transaction_timestamp(), payload = payload || '{"extra":"mutation"}'::jsonb`,
          sql`UPDATE inference_expense_quotes SET verified_at = transaction_timestamp(), created_at = created_at + interval '1 second'`,
        ])
          expect(Result.isFailure(yield* mutation.pipe(Effect.result))).toBe(true)
        yield* store.acknowledge([quote])
        expect(
          Result.isFailure(
            yield* sql`UPDATE inference_expense_quotes SET verified_at = transaction_timestamp()`.pipe(Effect.result),
          ),
        ).toBe(true)
        expect(
          Result.isFailure(yield* sql`UPDATE inference_expense_quotes SET verified_at = NULL`.pipe(Effect.result)),
        ).toBe(true)
      }),
    )
  })

  const nativeTest = baynTestTigerBeetleAddress === undefined ? test.skip : test
  nativeTest(
    'keeps a 10,002-quote PostgreSQL capture stable while a later request posts to the native ledger',
    async () => {
      const address = baynTestTigerBeetleAddress
      if (address === undefined || !/^127\.0\.0\.1:\d+$/.test(address))
        throw new Error('Native inference expense acceptance requires an isolated loopback TigerBeetle cluster')
      const result = await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const source = expenseSourceFixture({ accountId: `synthetic-expense-cut-${crypto.randomUUID()}` })
            const sources = Array.from({ length: 10_002 }, (_, index) =>
              expenseSourceFixture({
                accountId: source.accountId,
                authorityGenerationHash: Result.getOrThrow(canonicalHashV1Result({ index })),
              }),
            )
            const quotes = sources.map((source) =>
              Result.getOrThrow(makeInferenceExpenseQuote(source, expenseRateFixture)),
            )
            const sql = yield* PgClient.PgClient
            // Bulk fixture writes retain the real foreign keys and immutable evidence guards.
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO autonomous_cycles VALUES (${source.cycleId}, ${source.accountId}, ${source.sessionDate}::date)`
                yield* sql`INSERT INTO authority_generations
              SELECT value FROM jsonb_array_elements_text(${sql.json(sources.map((source) => source.authorityGenerationHash))})`
                yield* sql`INSERT INTO jev_evaluation_requests (request_id, cycle_id, authority_generation_hash, payload)
              SELECT item->>'requestId', item->>'cycleId', item->>'authorityGenerationHash', item->'request'
              FROM jsonb_array_elements(${sql.json(sources)}) AS item`
                yield* sql`INSERT INTO jev_evaluation_receipts (request_id, receipt_hash, payload)
              SELECT item->>'requestId', item #>> '{receipt,receiptHash}', item->'receipt'
              FROM jsonb_array_elements(${sql.json(sources)}) AS item`
                yield* sql`INSERT INTO jev_evaluation_resolutions (request_id, resolution_hash, payload)
              SELECT item->>'requestId', item #>> '{resolution,resolutionHash}', item->'resolution'
              FROM jsonb_array_elements(${sql.json(sources)}) AS item`
                yield* sql`INSERT INTO inference_expense_quotes (quote_hash, account_id, session_date, payload)
              SELECT item->>'quoteHash', ${source.accountId}, ${source.sessionDate}::date, item
              FROM jsonb_array_elements(${sql.json(quotes)}) AS item`
              }),
            )
            const store = makeInferenceExpenseStore(sql, source.accountId, '1970-01-01')
            const client = yield* makeTigerBeetleRequestClient({
              operationTimeoutMs: 5_000,
              tigerBeetle: { clusterId: 20912n, replicaAddresses: [address], ledger: 7_001 },
            })
            for (let offset = 0; offset < quotes.length; offset += inferenceExpenseBatchSize)
              yield* postInferenceExpenses(
                client,
                Result.getOrThrow(buildInferenceExpensePlan(quotes.slice(offset, offset + inferenceExpenseBatchSize))),
              )
            yield* store.acknowledge(quotes)
            const { captured, report, sessionRows } = yield* forwardPerformanceSnapshot(sql).withTransaction(
              Effect.gen(function* () {
                const captured = yield* acquireInferenceExpenseSnapshot(sql, source.accountId, source.sessionDate).pipe(
                  Effect.flatMap(({ verify }) => verify),
                )
                yield* Effect.gen(function* () {
                  yield* persistSource(expenseSourceFixture({ accountId: source.accountId, key: 'b', inputTokens: 2 }))
                  yield* runInferenceExpensePass(store, client, expenseRateFixture)
                }).pipe(
                  Effect.updateContext((context: Context.Context<PgClient.PgClient>) =>
                    Context.omit(sql.transactionService, sql.transactionSemaphoreService)(context),
                  ),
                )
                const report = yield* readInferenceExpenseLedger(
                  client,
                  captured,
                  store.currentSession(source.sessionDate),
                )
                return { captured, report, sessionRows: yield* store.session(source.sessionDate) }
              }),
            )
            const current = yield* acquireInferenceExpenseSnapshot(sql, source.accountId, source.sessionDate).pipe(
              Effect.flatMap(({ verify }) => verify),
            )
            const next = yield* readInferenceExpenseLedger(client, current, store.currentSession(source.sessionDate))
            return {
              captured,
              report,
              current,
              next,
              sessionRows,
              currentRows: yield* store.currentSession(source.sessionDate),
            }
          }),
        ),
      )
      expect(result.captured.evidence.requests).toHaveLength(10_002)
      expect(result.captured.quotes).toHaveLength(10_002)
      expect(result.sessionRows).toEqual([...result.captured.quotes])
      expect(result.sessionRows.map(({ quote }) => quote.quoteHash)).toEqual(
        result.sessionRows.map(({ quote }) => quote.quoteHash).toSorted(),
      )
      expect(result.report.exactLedgerPrefix).toBe(true)
      expect(result.report.transferCount).toBe(10_002)
      expect(result.report.verifiedSessionTransferCount).toBe(10_003)
      expect(result.report.knownEstimatedCostPicoUsd).toBe('420084000')
      expect(result.current.evidence.requests).toHaveLength(10_003)
      expect(result.current.quotes).toHaveLength(10_003)
      expect(result.currentRows).toEqual([...result.current.quotes])
      expect(result.next.exactLedgerPrefix).toBe(true)
      expect(result.next.transferCount).toBe(10_003)
      expect(result.next.knownEstimatedCostPicoUsd).toBe('420168000')
      expect(BigInt(result.next.ledgerTimestampMax)).toBe(BigInt(result.report.ledgerTimestampMax))
    },
    120_000,
  )
  nativeTest(
    'projects a real PostgreSQL receipt into native TigerBeetle and verifies it once after replay',
    async () => {
      const address = baynTestTigerBeetleAddress
      if (address === undefined || !/^127\.0\.0\.1:\d+$/.test(address))
        throw new Error('Native inference expense acceptance requires an isolated loopback TigerBeetle cluster')
      const result = await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const source = expenseSourceFixture({ accountId: `synthetic-expense-queue-${crypto.randomUUID()}` })
            yield* persistSource(source)
            const store = makeInferenceExpenseStore(yield* PgClient.PgClient, source.accountId, '1970-01-01')
            const client = yield* makeTigerBeetleRequestClient({
              operationTimeoutMs: 5_000,
              tigerBeetle: { clusterId: 20912n, replicaAddresses: [address], ledger: 7_001 },
            })
            const concurrent = yield* Effect.all(
              [
                runInferenceExpensePass(store, client, expenseRateFixture),
                runInferenceExpensePass(store, client, expenseRateFixture),
              ],
              { concurrency: 2 },
            )
            const replay = yield* runInferenceExpensePass(store, client, expenseRateFixture)
            const rows = yield* store.session(source.sessionDate)
            const quote = rows[0]?.quote
            if (quote === undefined) return yield* Effect.die('synthetic frozen native quote is absent')
            const ledger = yield* readInferenceExpenseLedger(
              client,
              yield* acquireInferenceExpenseSnapshot(
                yield* PgClient.PgClient,
                source.accountId,
                source.sessionDate,
              ).pipe(Effect.flatMap(({ verify }) => verify)),
              store.currentSession(source.sessionDate),
            )
            const url = new URL(testUrl)
            url.searchParams.set('options', `-c search_path=${schema}`)
            const report = yield* readInferenceExpenseSession(source.sessionDate).pipe(
              Effect.provideService(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromUnknown({
                  BAYN_POSTGRES_URL: url.toString(),
                  BAYN_ALPACA_ACCOUNT_ID: source.accountId,
                  BAYN_POSTGRES_TLS: false,
                  BAYN_TIGERBEETLE_CLUSTER_ID: '20912',
                  BAYN_TIGERBEETLE_ADDRESSES: address,
                }),
              ),
              Effect.provide(NodeServices.layer),
            )
            const sql = yield* PgClient.PgClient
            const forwardExpenses = yield* Effect.gen(function* () {
              const fence = yield* WriterFence
              return yield* fence.transaction(
                Effect.gen(function* () {
                  yield* sql`SELECT 1`
                  return yield* readForwardInferenceExpenses(
                    {
                      operationTimeoutMs: 30_000,
                      tigerBeetle: { clusterId: 20912n, replicaAddresses: [address], ledger: 7001 },
                    },
                    sql,
                    source.accountId,
                    yield* readForwardInferenceExpenseSnapshots(
                      sql,
                      source.accountId,
                      source.authorityGenerationHash,
                      fence,
                    ),
                    source.authorityGenerationHash,
                  )
                }),
              )
            }).pipe(Effect.provide(WriterFenceLive))
            const foreignExpenses = yield* readForwardInferenceExpenses(
              {
                operationTimeoutMs: 30_000,
                tigerBeetle: { clusterId: 20912n, replicaAddresses: [address], ledger: 7001 },
              },
              sql,
              source.accountId,
              yield* readForwardInferenceExpenseSnapshots(sql, source.accountId, 'f'.repeat(64)),
              'f'.repeat(64),
            )
            const openReaderConnections = yield* sql<{
              count: number
            }>`SELECT count(*)::integer AS count FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = 'bayn' AND pid <> pg_backend_pid()`
            return { concurrent, replay, rows, ledger, report, openReaderConnections, forwardExpenses, foreignExpenses }
          }),
        ),
      )
      expect(result.concurrent.some((pass) => pass.transferCount === 1)).toBe(true)
      expect(result.replay.transferCount).toBe(0)
      expect(result.rows[0]?.verifiedAt).not.toBeNull()
      expect(result.foreignExpenses).toEqual([])
      expect(result.forwardExpenses).toMatchObject([
        {
          knownEstimatedCostPicoUsd: '42000',
          claimedRequestCount: 1,
          exactSessionLedger: true,
          completeMeteredCoverage: true,
          invoiceReconciled: false,
        },
      ])
      expect(result.ledger.transferCount).toBe(1)
      expect(result.ledger.knownEstimatedCostPicoUsd).toBe('42000')
      expect(result.report.coverage.completeMeteredCoverage).toBe(true)
      expect(result.report.coverage.claimedRequestCount).toBe(1)
      expect(result.report.invoiceReconciled).toBe(false)
      expect(result.openReaderConnections[0]?.count).toBe(0)
    },
  )
})
