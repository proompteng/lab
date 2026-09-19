import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted, Result } from 'effect'

import migration from '../../migrations/0076_forward_performance_windows'
import { WriterFenceLive } from '../execution/writer-fence'
import {
  makeWindowReceiptFixture,
  performanceWindowAccountId,
  performanceWindowGenerationHash,
} from '../forward-performance/window.test-support'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'
import { CycleObservability, CycleObservabilityLive } from '../cycle/store/observability'
import { ForwardPerformanceReceiptKind } from '../forward-performance/model'
import { makeForwardPerformanceWindow } from './forward-performance-window'
import { publishForwardPerformanceWindow } from './forward-performance-window-postgres'

const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const accountId = performanceWindowAccountId
const generationHash = performanceWindowGenerationHash
const receipt = makeWindowReceiptFixture()
const window = Result.getOrThrow(makeForwardPerformanceWindow(generationHash, receipt))

const makeRuntime = () => {
  const url = new URL(baynTestPostgresUrl ?? 'postgresql://invalid')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test'))
    throw new Error('Performance-window tests require a local disposable *_test database')
  url.searchParams.set('options', '-c search_path=bayn_performance_window_test,public')
  return ManagedRuntime.make(
    Layer.mergeAll(WriterFenceLive, CycleObservabilityLive).pipe(
      Layer.provideMerge(
        PostgresClientLive({
          operationTimeoutMs: 5_000,
          postgres: { url: Redacted.make(url.toString()), tls: false, caPath: '/unused' },
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  )
}

describePostgres('immutable performance-window PostgreSQL publication', () => {
  let runtime: ReturnType<typeof makeRuntime>
  beforeAll(async () => {
    runtime = makeRuntime()
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* postgresMigrations
        yield* sql`CREATE SCHEMA bayn_performance_window_test`
        yield* sql`CREATE TABLE authority_generations AS SELECT * FROM public.authority_generations WITH NO DATA`
        yield* sql`ALTER TABLE authority_generations ADD PRIMARY KEY (generation_hash)`
        yield* sql`CREATE TABLE authority_state AS SELECT * FROM public.authority_state WITH NO DATA`
        yield* sql`CREATE TABLE autonomous_cycles AS SELECT * FROM public.autonomous_cycles WITH NO DATA`
        yield* sql`ALTER TABLE autonomous_cycles ADD PRIMARY KEY (cycle_id)`
        yield* sql`CREATE TABLE reconciliations AS SELECT * FROM public.reconciliations WITH NO DATA`
        yield* sql`ALTER TABLE reconciliations ADD PRIMARY KEY (reconciliation_id)`
        yield* sql`CREATE FUNCTION reject_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN RAISE EXCEPTION 'immutable test evidence' USING ERRCODE='55000'; END;
      $body$`
        yield* migration
        yield* sql`INSERT INTO authority_generations (
        generation_hash, account_id, broker_identity_hash, strategy_name, strategy_protocol_hash,
        strategy_behavior_hash, strategy_parameter_hash, qualification_run_id, research_plan_hash,
        broker_provider, broker_environment, strategy_parameter_schema_version
      ) VALUES (
        ${generationHash}, ${accountId}, ${receipt.bindings.account.accountReferenceHash},
        'intraday-momentum', ${'3'.repeat(64)}, ${'4'.repeat(64)}, ${'5'.repeat(64)}, NULL, ${'2'.repeat(64)},
        'alpaca', 'sandbox', 'bayn.intraday-momentum.protocol.v3'
      )`
        yield* sql`INSERT INTO autonomous_cycles (cycle_id,account_id,state,terminal_at,qualification_run_id,strategy_protocol_hash)
        VALUES (${receipt.window.firstCycleId}, ${accountId}, 'COMPLETED', '2026-09-18T20:00:00Z',${'2'.repeat(64)},${'3'.repeat(64)})`
        yield* sql`INSERT INTO reconciliations (reconciliation_id, account_id, content_hash, reconciled_at, status, discrepancies) VALUES (
        ${receipt.window.reconciliationId}, ${accountId}, ${receipt.window.reconciliationContentHash}, ${receipt.window.closedAt}, 'EXACT', '[]'::jsonb
      )`
      }),
    )
  })
  afterAll(async () => {
    if (runtime !== undefined) {
      try {
        await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient
            yield* sql`DROP SCHEMA bayn_performance_window_test CASCADE`
          }),
        )
      } finally {
        await runtime.dispose()
      }
    }
  })

  test('publishes, reads back and retries the same cut without duplicating it', async () => {
    const first = await runtime.runPromise(publishForwardPerformanceWindow(accountId, window))
    const retried = await runtime.runPromise(publishForwardPerformanceWindow(accountId, window))
    expect(first).toEqual(retried)
    expect(first.window).toEqual(window)
    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return yield* sql<{ count: number }>`SELECT count(*)::integer AS count FROM forward_performance_windows`
      }),
    )
    expect(rows).toEqual([{ count: 1 }])
  })

  test('rejects wrong account and generation bindings before persistence', async () => {
    const foreign = Result.getOrThrow(makeForwardPerformanceWindow('f'.repeat(64), receipt))
    for (const [account, candidate] of [
      [accountId, foreign],
      ['foreign-account', window],
    ] as const) {
      const failure = await runtime.runPromise(publishForwardPerformanceWindow(account, candidate).pipe(Effect.flip))
      expect(failure.failure).toBe('binding')
    }
  })

  test('the status reader exposes the published cut with a non-authoritative window label', async () => {
    await runtime.runPromise(publishForwardPerformanceWindow(accountId, window))
    const projection = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* CycleObservability).read('0'.repeat(64), accountId)
      }),
    )
    expect(projection.economics?.forwardPerformance).toMatchObject({
      kind: ForwardPerformanceReceiptKind.ReconciledWindow,
      windowId: window.windowId,
      authorityGenerationHash: generationHash,
      evidenceCutoffAt: receipt.window.closedAt,
      netRealizedPnlAfterCostsMicros: '99000000',
      completedExecutionCount: 2,
      accountingReceiptsExact: true,
    })
    expect(projection.authority).toBeNull()
    const foreign = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* CycleObservability).read('f'.repeat(64), 'foreign-account')
      }),
    )
    expect(foreign.economics?.forwardPerformance).toBeNull()
  })

  test('rejects changed content for the same cut without overwriting the original', async () => {
    const altered = Result.getOrThrow(
      makeForwardPerformanceWindow(
        generationHash,
        makeWindowReceiptFixture({
          totals: { ...receipt.totals, otherChargedCostsMicros: '1000000' },
        }),
      ),
    )
    expect(altered.windowId).toBe(window.windowId)
    const failure = await runtime.runPromise(publishForwardPerformanceWindow(accountId, altered).pipe(Effect.flip))
    expect(failure.failure).toBe('conflict')
    expect((await runtime.runPromise(publishForwardPerformanceWindow(accountId, window))).window).toEqual(window)
  })

  test('permits another reconciliation cut without replacing a standing generation receipt', async () => {
    const nextReceipt = makeWindowReceiptFixture({
      window: { ...receipt.window, reconciliationId: 'e'.repeat(64), closedAt: '2026-09-18T20:02:00.000Z' },
    })
    const next = Result.getOrThrow(makeForwardPerformanceWindow(generationHash, nextReceipt))
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`INSERT INTO reconciliations (reconciliation_id,account_id,content_hash,reconciled_at,status,discrepancies) VALUES (
        ${nextReceipt.window.reconciliationId}, ${accountId}, ${nextReceipt.window.reconciliationContentHash}, ${nextReceipt.window.closedAt}, 'EXACT', '[]'::jsonb
      )`
      }),
    )
    expect((await runtime.runPromise(publishForwardPerformanceWindow(accountId, next))).window.windowId).toBe(
      next.windowId,
    )
    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return yield* sql<{ count: number }>`SELECT count(*)::integer AS count FROM forward_performance_windows`
      }),
    )
    expect(rows).toEqual([{ count: 2 }])
    const olderReceipt = makeWindowReceiptFixture({
      window: { ...receipt.window, reconciliationId: 'f'.repeat(64), closedAt: '2026-09-18T20:01:30.000Z' },
    })
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`INSERT INTO reconciliations (reconciliation_id,account_id,content_hash,reconciled_at,status,discrepancies) VALUES (
        ${olderReceipt.window.reconciliationId}, ${accountId}, ${olderReceipt.window.reconciliationContentHash}, ${olderReceipt.window.closedAt}, 'EXACT', '[]'::jsonb
      )`
        yield* publishForwardPerformanceWindow(
          accountId,
          Result.getOrThrow(makeForwardPerformanceWindow(generationHash, olderReceipt)),
        )
      }),
    )
    const latest = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* CycleObservability).read('0'.repeat(64), accountId)
      }),
    )
    expect(latest.economics?.forwardPerformance?.windowId).toBe(next.windowId)
  })

  test('the migration rejects updates, deletes and truncation of published evidence', async () => {
    const outcomes = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return [
          yield* sql`UPDATE forward_performance_windows SET recorded_at = recorded_at`.pipe(Effect.result),
          yield* sql`DELETE FROM forward_performance_windows`.pipe(Effect.result),
          yield* sql`TRUNCATE forward_performance_windows`.pipe(Effect.result),
        ]
      }),
    )
    for (const outcome of outcomes) expect(Result.isFailure(outcome)).toBe(true)
  })
})
