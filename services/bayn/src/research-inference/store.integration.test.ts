import gepaEditorMigration from '../../migrations/0139_jev_gepa_editor'
import structuredEditorMigration from '../../migrations/0138_jev_editor_structured_output'
import jevEditorMigration from '../../migrations/0135_jev_editor_identity'
import jevHarnessMigration from '../../migrations/0132_jev_harness2'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Redacted, Result, Schema } from 'effect'
import { NodeHttpClient } from '@effect/platform-node'
import { SqlClient } from 'effect/sql'

import migration from '../../migrations/0093_research_inference'
import harnessMigration from '../../migrations/0129_harness2_research'
import { baynTestPostgresUrl, baynTestTigerBeetleAddress } from '../test-environment.test-support'
import { decodeResearchRun, hashResearch, ResearchOutcome, researchServingIdentity } from './contract'
import {
  fullTokenBudgetStreamFixture,
  editorFixture,
  retainedEditorFixture,
  retainedReceiptFixture,
  streamFixture,
} from './test-support'
import { makeResearchStore, projectResearchExpenses, researchExpensePlan, verifyResearchReceipt } from './store'
import { makeResearchRunner } from './runner'
import { makeTigerBeetleRequestClient } from '../tigerbeetle-client'

const integration = baynTestPostgresUrl === undefined ? describe.skip : describe
integration('research attempt durability with real PostgreSQL', () => {
  const retainedEditor = { ...editorFixture(), schemaVersion: 'bayn.jev-harness2-editor.v3' }
  const retainedId = Result.getOrThrow(hashResearch(retainedEditor))
  let retainedBytes = ''
  let runtime: ManagedRuntime.ManagedRuntime<
    PgClient.PgClient | SqlClient.SqlClient | import('effect/http/HttpClient').HttpClient,
    unknown
  >
  beforeAll(async () => {
    const url = new URL(baynTestPostgresUrl ?? '')
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test'))
      throw new Error('Research persistence tests require an isolated local _test database')
    url.searchParams.set('options', '-c search_path=bayn_research_inference_test')
    runtime = ManagedRuntime.make(
      Layer.mergeAll(
        PgClient.layer({ url: Redacted.make(url.toString()), transformJson: false, maxConnections: 2 }),
        NodeHttpClient.layerNodeHttp,
      ),
    )
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA IF EXISTS bayn_research_inference_test CASCADE`
        yield* sql`CREATE SCHEMA bayn_research_inference_test`
        yield* sql`CREATE FUNCTION reject_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable fixture'; END; $$`
        yield* migration
        yield* harnessMigration
        yield* jevHarnessMigration
        yield* jevEditorMigration
        yield* structuredEditorMigration
        yield* sql`INSERT INTO research_inference_runs (run_id, payload) VALUES (${retainedId}, ${sql.json(retainedEditor)})`
        const [row] = yield* sql<{
          payload: string
        }>`SELECT payload::text AS payload FROM research_inference_runs WHERE run_id = ${retainedId}`
        if (row === undefined) throw new Error('Missing retained registration')
        retainedBytes = row.payload
        yield* gepaEditorMigration
      }),
    )
  })
  afterAll(async () => {
    if (runtime !== undefined) await runtime.dispose()
  })
  test('hard migration preserves retained bytes and rejects new retired registrations', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const [row] = yield* sql<{
          payload: string
        }>`SELECT payload::text AS payload FROM research_inference_runs WHERE run_id = ${retainedId}`
        expect(row?.payload).toBe(retainedBytes)
        const changed = { ...retainedEditor, attempt: 1 }
        const changedId = Result.getOrThrow(hashResearch(changed))
        expect(
          Result.isFailure(
            yield* sql`INSERT INTO research_inference_runs (run_id, payload) VALUES (${changedId}, ${sql.json(changed)})`.pipe(
              Effect.result,
            ),
          ),
        ).toBe(true)
      }),
    )
  })
  test.each([false, true])(
    'research cutover observes an in-flight claim only when locked before validation (lock first: %s)',
    async (lockFirst) => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const schema = `bayn_research_cutover_${crypto.randomUUID().replaceAll('-', '')}_test`
          yield* sql`CREATE SCHEMA ${sql(schema)}`
          yield* Effect.gen(function* () {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`SET LOCAL search_path TO ${sql(schema)}`
                yield* sql`CREATE FUNCTION reject_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable fixture'; END; $$`
                yield* migration
                yield* harnessMigration
                yield* jevHarnessMigration
                yield* jevEditorMigration
                yield* structuredEditorMigration
              }),
            )
            const now = new Date().toISOString()
            const registration = {
              ...retainedEditor,
              registeredAt: now,
              featureCutoff: now,
              deadlineAt: new Date(Date.now() + 60_000).toISOString(),
            }
            const runId = Result.getOrThrow(hashResearch(registration))
            const claimed = yield* Deferred.make<void>()
            const migratingPid = yield* Deferred.make<number>()
            // Fork outside either transaction so the pool supplies independent connections.
            const migrating = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql`SET LOCAL search_path TO ${sql(schema)}`
                  yield* sql`SET LOCAL lock_timeout = '5s'`
                  yield* sql`SET LOCAL statement_timeout = '10s'`
                  yield* Deferred.await(claimed)
                  const [backend] = yield* sql`SELECT pg_backend_pid() AS pid`.pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ pid: Schema.Int })]))),
                  )
                  yield* Deferred.succeed(migratingPid, backend.pid)
                  // Preventive control, not a rewrite of applied migration 139. Without this lock,
                  // its drain checks cannot see the other connection's uncommitted registration.
                  if (lockFirst)
                    yield* sql`LOCK TABLE research_inference_runs, research_inference_receipts IN ACCESS EXCLUSIVE MODE`
                  yield* gepaEditorMigration
                }),
              )
              .pipe(Effect.result, Effect.forkScoped)
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`SET LOCAL search_path TO ${sql(schema)}`
                yield* sql`SET LOCAL statement_timeout = '10s'`
                yield* sql`INSERT INTO research_inference_runs (run_id, payload) VALUES (${runId}, ${sql.json(registration)})`
                yield* Deferred.succeed(claimed, undefined)
                const pid = yield* Deferred.await(migratingPid)
                // Observe the actual conflicting table lock, rather than guessing at timing.
                yield* Effect.gen(function* () {
                  while (true) {
                    const [lock] = yield* sql`SELECT EXISTS (
                      SELECT 1 FROM pg_locks WHERE pid = ${pid}
                        AND relation = ${`${schema}.research_inference_runs`}::regclass
                        AND mode = 'AccessExclusiveLock' AND NOT granted
                    ) AS waiting`.pipe(
                      Effect.flatMap(
                        Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ waiting: Schema.Boolean })])),
                      ),
                    )
                    if (lock.waiting) break
                    yield* Effect.sleep('10 millis')
                  }
                }).pipe(Effect.timeout('3 seconds'))
              }),
            )
            const outcome = yield* Fiber.join(migrating)
            expect(Result.isFailure(outcome)).toBe(lockFirst)
            if (Result.isFailure(outcome)) {
              // PostgreSQL Error.message is non-enumerable and is omitted by JSON.stringify.
              const failure = yield* Schema.decodeUnknownEffect(
                Schema.Struct({
                  reason: Schema.Struct({ cause: Schema.Struct({ code: Schema.String, message: Schema.String }) }),
                }),
              )(outcome.failure)
              expect(failure.reason.cause).toEqual({
                code: 'P0001',
                message: 'Let in-flight research registrations finish before the Jev editor hard migration',
              })
            }
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`SET LOCAL search_path TO ${sql(schema)}`
                const [row] = yield* sql`SELECT payload FROM research_inference_runs WHERE run_id = ${runId}`.pipe(
                  Effect.flatMap(
                    Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ payload: Schema.Unknown })])),
                  ),
                )
                expect(row?.payload).toEqual(registration)
                const receiptHash = '8'.repeat(64)
                const receipt = {
                  schemaVersion: 'bayn.research-receipt.v1',
                  runId,
                  receiptHash,
                  qualification: 'UNQUALIFIED',
                  costPicoUsd: '1',
                }
                const finished = yield* sql
                  .withTransaction(
                    sql`INSERT INTO research_inference_receipts (run_id, receipt_hash, payload)
                      VALUES (${runId}, ${receiptHash}, ${sql.json(receipt)})`,
                  )
                  .pipe(Effect.result)
                expect(Result.isSuccess(finished)).toBe(lockFirst)
                if (Result.isFailure(finished))
                  expect(JSON.stringify(finished.failure)).toContain('research_inference_receipts_check')
                expect(yield* sql`SELECT payload FROM research_inference_receipts WHERE run_id = ${runId}`).toEqual(
                  lockFirst ? [{ payload: receipt }] : [],
                )
              }),
            )
          }).pipe(
            Effect.scoped,
            Effect.timeout('15 seconds'),
            Effect.ensuring(
              sql
                .withTransaction(
                  Effect.gen(function* () {
                    yield* sql`SET LOCAL lock_timeout = '2s'`
                    yield* sql`SET LOCAL statement_timeout = '3s'`
                    yield* sql`DROP SCHEMA ${sql(schema)} CASCADE`
                  }),
                )
                .pipe(Effect.orDie),
            ),
          )
        }),
      )
    },
    20_000,
  )
  test('rejects a receipt inserted as already expense-verified', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const run = { ...editorFixture(), attempt: 3 }
        const runId = Result.getOrThrow(hashResearch(run))
        yield* makeResearchStore(sql).claim(runId, run)
        const receiptHash = '9'.repeat(64)
        const payload = {
          schemaVersion: 'bayn.research-receipt.v2',
          runId,
          receiptHash,
          qualification: 'UNQUALIFIED',
        }
        const inserted = yield* sql`INSERT INTO research_inference_receipts (run_id, receipt_hash, payload, verified_at)
          VALUES (${runId}, ${receiptHash}, ${sql.json(payload)}, transaction_timestamp())`.pipe(Effect.result)
        expect(Result.isFailure(inserted)).toBe(true)
        expect(yield* makeResearchStore(sql).read(runId)).toBeUndefined()
      }),
    )
  })
  test('claims and replays an instruction proposal through the same immutable store', async () => {
    let calls = 0
    const text = '{"entry":"Assess complete entry plans"}'
    const model = Bun.serve({
      port: 0,
      fetch: () => {
        calls++
        return new Response(streamFixture(text, editorFixture().policy.model), {
          headers: {
            'content-type': 'text/event-stream',
            'x-model-serving-identity': JSON.stringify(researchServingIdentity(editorFixture().policy)),
          },
        })
      },
    })
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const store = makeResearchStore(sql)
          const runner = yield* makeResearchRunner(store, `${model.url}v1/chat/completions`, () => ({}), 'b'.repeat(40))
          const now = new Date().toISOString()
          const fixture = editorFixture()
          const run = Result.getOrThrow(
            decodeResearchRun({
              ...fixture,
              registeredAt: now,
              featureCutoff: now,
              deadlineAt: new Date(Date.now() + 30_000).toISOString(),
              costBasis: null,
            }),
          )
          const first = yield* runner.run(run)
          expect(first.outcome).toBe(ResearchOutcome.Complete)
          expect(first.responseText).toBe(text)
          expect(first.instructions).toEqual({ entry: 'Assess complete entry plans' })
          expect(first.workerSourceRevision).toBe('b'.repeat(40))
          expect(run.sourceRevision).toBe('a'.repeat(40))
          const replacedWorker = yield* makeResearchRunner(
            store,
            `${model.url}v1/chat/completions`,
            () => ({}),
            'c'.repeat(40),
          )
          expect(yield* replacedWorker.run(run)).toEqual(first)
          expect(yield* runner.run(run)).toEqual(first)
          expect(calls).toBe(1)
          const forged = { ...run, purpose: 'trade' }
          expect(
            Result.isFailure(
              yield* sql`INSERT INTO research_inference_runs (run_id, payload) VALUES (${'4'.repeat(64)}, ${sql.json(forged)})`.pipe(
                Effect.result,
              ),
            ),
          ).toBe(true)
        }),
      )
    } finally {
      await model.stop(true)
    }
  })
  test('replays a retained receipt without inference and never resends a claimed crash tail', async () => {
    let calls = 0
    const model = Bun.serve({
      port: 0,
      fetch: () => {
        calls++
        return new Response(fullTokenBudgetStreamFixture(editorFixture().policy.model, '{"entry":"Assess"}'), {
          headers: {
            'content-type': 'text/event-stream',
            'x-model-serving-identity': JSON.stringify(researchServingIdentity(editorFixture().policy)),
          },
        })
      },
    })
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const store = makeResearchStore(sql)
          const runner = yield* makeResearchRunner(store, `${model.url}v1/chat/completions`)
          const now = new Date().toISOString()
          const run = {
            ...editorFixture(),
            featureCutoff: now,
            registeredAt: now,
            deadlineAt: new Date(Date.now() + 30_000).toISOString(),
            costBasis: null,
          }
          const first = yield* runner.run(run)
          expect(first.outcome).toBe(ResearchOutcome.Complete)
          expect(first.usage?.completion_tokens).toBe(4096)
          expect(Result.isSuccess(verifyResearchReceipt(run, first))).toBe(true)
          expect(yield* runner.run(run)).toEqual(first)
          expect(calls).toBe(1)
          const crash = { ...run, attempt: 1 }
          expect(yield* store.claim(Result.getOrThrow(hashResearch(crash)), crash)).toBe(true)
          expect((yield* runner.run(crash)).outcome).toBe(ResearchOutcome.Ambiguous)
          expect(calls).toBe(1)
          const changed = { ...first, responseText: 'changed' }
          expect(Result.isFailure(yield* store.finish(run, changed).pipe(Effect.result))).toBe(true)
          expect(
            Result.isFailure(yield* sql`UPDATE research_inference_runs SET payload = payload`.pipe(Effect.result)),
          ).toBe(true)
          expect(Result.isFailure(yield* sql`DELETE FROM research_inference_receipts`.pipe(Effect.result))).toBe(true)
        }),
      )
    } finally {
      await model.stop(true)
    }
  })
  const ledgerTest = baynTestTigerBeetleAddress === undefined ? test.skip : test
  ledgerTest(
    'posts and acknowledges a retained old-policy expense without rewriting its evidence or dispatching inference',
    async () => {
      await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient
            const store = makeResearchStore(sql)
            const run = { ...retainedEditorFixture(), studyHash: crypto.randomUUID().replaceAll('-', '').repeat(2) }
            const receipt = retainedReceiptFixture(run)
            expect(Result.isFailure(decodeResearchRun(run))).toBe(true)
            yield* sql`INSERT INTO research_inference_runs (run_id, payload) VALUES (${receipt.runId}, ${sql.json(run)})`
            yield* sql`INSERT INTO research_inference_receipts (run_id, receipt_hash, payload) VALUES (${receipt.runId}, ${receipt.receiptHash}, ${sql.json(receipt)})`
            const before =
              yield* sql`SELECT payload::text AS payload FROM research_inference_receipts WHERE run_id = ${receipt.runId}`
            const client = yield* makeTigerBeetleRequestClient({
              operationTimeoutMs: 5000,
              tigerBeetle: {
                clusterId: 20912n,
                replicaAddresses: [baynTestTigerBeetleAddress ?? '127.0.0.1:3000'],
                ledger: 7001,
              },
            })
            yield* projectResearchExpenses(store, client)
            yield* projectResearchExpenses(store, client)
            const plan = yield* Effect.fromResult(researchExpensePlan(run, receipt))
            const transfers = yield* client.request('research-retained-expense', (active) =>
              active.lookupTransfers(plan.transfers.map((transfer) => transfer.id)),
            )
            expect(transfers.map(({ id, amount }) => ({ id, amount }))).toEqual(
              plan.transfers.map(({ id, amount }) => ({ id, amount })),
            )
            const after =
              yield* sql`SELECT payload::text AS payload FROM research_inference_receipts WHERE run_id = ${receipt.runId} AND verified_at IS NOT NULL`
            expect(after).toEqual(before)
          }),
        ),
      )
    },
  )
  ledgerTest('recovers post-before-ack with exact native ledger transfers and balances', async () => {
    const model = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(streamFixture('{"entry":"Assess"}', editorFixture().policy.model), {
          headers: {
            'content-type': 'text/event-stream',
            'x-model-serving-identity': JSON.stringify(researchServingIdentity(editorFixture().policy)),
          },
        }),
    })
    try {
      await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient
            const store = makeResearchStore(sql)
            const runner = yield* makeResearchRunner(store, `${model.url}v1/chat/completions`)
            const now = new Date().toISOString()
            const run = {
              ...editorFixture(),
              attempt: 2,
              studyHash: crypto.randomUUID().replaceAll('-', '').repeat(2),
              featureCutoff: now,
              registeredAt: now,
              deadlineAt: new Date(Date.now() + 30_000).toISOString(),
              costBasis: {
                ...editorFixture().costBasis,
                sourceEvidenceHash: '4'.repeat(64),
                effectiveFrom: '2026-01-01T00:00:00.000Z',
                effectiveUntil: '2027-01-01T00:00:00.000Z',
                allocation: 'reserved-capacity-wall-time' as const,
                picoUsdPerSecond: '1000000000',
              },
            }
            const receipt = yield* runner.run(run)
            expect(BigInt(receipt.costPicoUsd ?? '0')).toBeGreaterThan(0n)
            const client = yield* makeTigerBeetleRequestClient({
              operationTimeoutMs: 5000,
              tigerBeetle: {
                clusterId: 20912n,
                replicaAddresses: [baynTestTigerBeetleAddress ?? '127.0.0.1:3000'],
                ledger: 7001,
              },
            })
            let acknowledgements = 0
            const losesAcknowledgement = {
              ...store,
              acknowledge: (id: string) =>
                ++acknowledgements === 1 ? sql`SELECT 1 / 0`.pipe(Effect.asVoid) : store.acknowledge(id),
            }
            expect(
              Result.isFailure(yield* projectResearchExpenses(losesAcknowledgement, client).pipe(Effect.result)),
            ).toBe(true)
            yield* projectResearchExpenses(store, client)
            yield* projectResearchExpenses(store, client)
            const plan = yield* Effect.fromResult(researchExpensePlan(run, receipt))
            const accounts = yield* client.request('research-test-account-balances', (active) =>
              active.lookupAccounts(plan.accounts.map((account) => account.id)),
            )
            expect(accounts).toHaveLength(2)
            for (const account of accounts) {
              const debits = plan.transfers.filter((transfer) => transfer.debit_account_id === account.id)
              const credits = plan.transfers.filter((transfer) => transfer.credit_account_id === account.id)
              expect(account.debits_pending).toBe(0n)
              expect(account.credits_pending).toBe(0n)
              expect(account.debits_posted).toBe(debits.reduce((total, transfer) => total + transfer.amount, 0n))
              expect(account.credits_posted).toBe(credits.reduce((total, transfer) => total + transfer.amount, 0n))
            }
            const rows =
              yield* sql`SELECT count(*)::int AS n FROM research_inference_receipts WHERE run_id = ${receipt.runId} AND verified_at IS NOT NULL`.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ n: Schema.Int })))),
              )
            expect(rows[0]?.n).toBe(1)
          }),
        ),
      )
    } finally {
      await model.stop(true)
    }
  })
})
