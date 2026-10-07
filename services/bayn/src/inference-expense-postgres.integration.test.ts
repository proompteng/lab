import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { NodeServices } from '@effect/platform-node'
import { ConfigProvider, Effect, ManagedRuntime, Redacted, Result } from 'effect'
import { SqlClient } from 'effect/sql'

import requestMigration from '../migrations/0076_jev_evaluation_evidence'
import resolutionMigration from '../migrations/0077_jev_evaluation_resolution'
import expenseMigration from '../migrations/0091_inference_expense_quotes'
import { makeInferenceExpenseQuote, type InferenceExpenseSource } from './inference-expense'
import { expenseRateFixture, expenseSourceFixture } from './inference-expense.test-support'
import { makeInferenceExpenseStore } from './inference-expense-postgres'
import { baynTestPostgresUrl, baynTestTigerBeetleAddress } from './test-environment.test-support'
import { runInferenceExpensePass } from './inference-expense-runtime'
import { readInferenceExpenseLedger } from './inference-expense-journal'
import { makeTigerBeetleRequestClient } from './tigerbeetle-client'
import { readInferenceExpenseSession } from './inference-cost-command'

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
      PgClient.layer({ url: Redacted.make(url.toString()), transformJson: false, maxConnections: 2 }),
    )
  })
  beforeEach(async () => {
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
        yield* resolutionMigration
        yield* expenseMigration
      }),
    )
  })
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
              quote.accountBindingHash,
              source.sessionDate,
              rows.map((row) => row.quote),
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
            const openReaderConnections = yield* sql<{
              count: number
            }>`SELECT count(*)::integer AS count FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = 'bayn' AND pid <> pg_backend_pid()`
            return { concurrent, replay, rows, ledger, report, openReaderConnections }
          }),
        ),
      )
      expect(result.concurrent.some((pass) => pass.transferCount === 1)).toBe(true)
      expect(result.replay.transferCount).toBe(0)
      expect(result.rows[0]?.verifiedAt).not.toBeNull()
      expect(result.ledger.transferCount).toBe(1)
      expect(result.ledger.knownEstimatedCostPicoUsd).toBe('42000')
      expect(result.report.coverage.completeMeteredCoverage).toBe(true)
      expect(result.report.coverage.claimedRequestCount).toBe(1)
      expect(result.report.invoiceReconciled).toBe(false)
      expect(result.openReaderConnections[0]?.count).toBe(0)
    },
  )
})
