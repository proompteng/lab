import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { NodeServices } from '@effect/platform-node'
import { ConfigProvider, Context, Effect, ManagedRuntime, Redacted, Result, Schema } from 'effect'
import { SqlClient } from 'effect/sql'

import requestMigration from '../migrations/0076_jev_evaluation_evidence'
import resolutionMigration from '../migrations/0077_jev_evaluation_resolution'
import expenseMigration from '../migrations/0091_inference_expense_quotes'
import inferenceRequestVersion from '../migrations/0150_inference_request_version'
import { makeInferenceExpenseQuote, type InferenceExpenseSource } from './inference-expense'
import { expenseRateFixture, expenseSourceFixture } from './inference-expense.test-support'
import { makeInferenceExpenseStore } from './inference-expense-postgres'
import { baynTestPostgresUrl, baynTestTigerBeetleAddress } from './test-environment.test-support'
import { runInferenceExpensePass } from './inference-expense-runtime'
import { readInferenceExpenseLedger } from './inference-expense-journal'
import { readInferenceExpenseSnapshot } from './inference-costs-postgres'
import { makeTigerBeetleRequestClient } from './tigerbeetle-client'
import { readForwardInferenceExpenses } from './forward-performance/inference-expenses'
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
      PgClient.layer({ url: Redacted.make(url.toString()), transformJson: false, maxConnections: 2 }),
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
          ADD COLUMN handoff_hash text GENERATED ALWAYS AS (payload #>> '{line,handoffHash}') STORED`
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
        yield* store.freeze([frozenQuote])
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
  nativeTest('keeps a PostgreSQL quote capture stable while a later request posts to the native ledger', async () => {
    const address = baynTestTigerBeetleAddress
    if (address === undefined || !/^127\.0\.0\.1:\d+$/.test(address))
      throw new Error('Native inference expense acceptance requires an isolated loopback TigerBeetle cluster')
    const result = await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const source = expenseSourceFixture({ accountId: `synthetic-expense-cut-${crypto.randomUUID()}` })
          yield* persistSource(source)
          const sql = yield* PgClient.PgClient
          const store = makeInferenceExpenseStore(sql, source.accountId, '1970-01-01')
          const client = yield* makeTigerBeetleRequestClient({
            operationTimeoutMs: 5_000,
            tigerBeetle: { clusterId: 20912n, replicaAddresses: [address], ledger: 7_001 },
          })
          yield* runInferenceExpensePass(store, client, expenseRateFixture)
          const { captured, report } = yield* forwardPerformanceSnapshot(sql).withTransaction(
            Effect.gen(function* () {
              const captured = yield* readInferenceExpenseSnapshot(sql, source.accountId, source.sessionDate)
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
              return { captured, report }
            }),
          )
          const current = yield* readInferenceExpenseSnapshot(sql, source.accountId, source.sessionDate)
          const next = yield* readInferenceExpenseLedger(client, current, store.currentSession(source.sessionDate))
          return { captured, report, current, next }
        }),
      ),
    )
    expect(result.captured.evidence.requests).toHaveLength(1)
    expect(result.captured.quotes).toHaveLength(1)
    expect(result.report.transferCount).toBe(1)
    expect(result.report.verifiedSessionTransferCount).toBe(2)
    expect(result.report.knownEstimatedCostPicoUsd).toBe('42000')
    expect(result.current.evidence.requests).toHaveLength(2)
    expect(result.current.quotes).toHaveLength(2)
    expect(result.next.transferCount).toBe(2)
    expect(result.next.knownEstimatedCostPicoUsd).toBe('126000')
    expect(BigInt(result.next.ledgerTimestampMax)).toBe(BigInt(result.report.ledgerTimestampMax))
  })
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
              yield* readInferenceExpenseSnapshot(yield* PgClient.PgClient, source.accountId, source.sessionDate),
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
                    source.authorityGenerationHash,
                    fence,
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
