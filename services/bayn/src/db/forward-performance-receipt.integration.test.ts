import { describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Deferred, Effect, Exit, Layer, ManagedRuntime, Redacted, Result } from 'effect'
import { WriterFence, WriterFenceLive } from '../execution/writer-fence'
import {
  executionActivationExpiredRestrictionReason,
  executionMandateCompletedRestrictionReason,
  legacyExecutionActivationExpiredRestrictionReason,
  legacyV1CompletedRestrictionReason,
} from '../execution/mandate'
import { forwardPerformanceSnapshot } from '../forward-performance/postgres/snapshot'
import { PostgresClientLive } from './postgres-client'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import {
  makeForwardPerformanceReceiptEnvelope,
  makePersistableForwardPerformanceReceiptEnvelope,
  persistForwardPerformanceReceipt,
  evaluateAndPersistForwardPerformanceReceipt,
} from './forward-performance-receipt'
import { makePersistenceReceipt } from './forward-performance-receipt.test-support'

const postgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const generation = 'a'.repeat(64)
const successor = 'f'.repeat(64)
const packet = () =>
  Result.getOrThrow(makePersistableForwardPerformanceReceiptEnvelope(generation, makePersistenceReceipt()))

const makeRuntime = () => {
  const url = baynTestPostgresUrl ?? ''
  const parsed = new URL(url)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
    throw new Error('Receipt persistence tests require an isolated local _test database')
  return ManagedRuntime.make(
    WriterFenceLive.pipe(
      Layer.provideMerge(
        PostgresClientLive({
          operationTimeoutMs: 5_000,
          postgres: { url: Redacted.make(url), tls: false, caPath: '/unused' },
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  )
}

const withDatabase = <A, E>(program: Effect.Effect<A, E, PgClient.PgClient | WriterFence>) => {
  const url = baynTestPostgresUrl ?? ''
  const parsed = new URL(url)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
    throw new Error('Receipt persistence tests require an isolated local _test database')
  return Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const fence = yield* WriterFence
      return yield* fence.transaction(
        Effect.gen(function* () {
          yield* sql`CREATE TEMP TABLE authority_generations (
          generation_hash text PRIMARY KEY, previous_generation_hash text, authority_version bigint,
          account_id text, qualification_run_id text, research_plan_hash text, maximum text,
          broker_identity_hash text, broker_provider text, broker_environment text, activated_at timestamptz
        ) ON COMMIT DROP`
          yield* sql`CREATE TEMP TABLE authority_state (
          singleton boolean, generation_hash text, version bigint, maximum text, effective text,
          kill_state text, reason text, updated_at timestamptz
        ) ON COMMIT DROP`
          yield* sql`CREATE TEMP TABLE autonomous_cycles (
          cycle_id text PRIMARY KEY, account_id text, qualification_run_id text, state text, terminal_at timestamptz,
          decision_hash text
        ) ON COMMIT DROP`
          yield* sql`CREATE TEMP TABLE intents (
          cycle_id text, account_id text, authority_generation_hash text, state text, updated_at timestamptz
        ) ON COMMIT DROP`
          yield* sql`CREATE TEMP TABLE autonomous_cycle_shadow_decisions (
          cycle_id text, decision_hash text, schema_version text, document jsonb
        ) ON COMMIT DROP`
          yield* sql`CREATE TEMP TABLE autonomous_forward_performance_receipts (
          authority_generation_hash text PRIMARY KEY, cycle_id text NOT NULL REFERENCES autonomous_cycles(cycle_id),
          document jsonb NOT NULL, created_at timestamptz NOT NULL
        ) ON COMMIT DROP`
          yield* sql`CREATE OR REPLACE FUNCTION pg_temp.reject_performance_receipt_mutation() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt is append-only'; END $$`
          yield* sql`CREATE TRIGGER receipt_append_only BEFORE UPDATE OR DELETE ON autonomous_forward_performance_receipts
          FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_performance_receipt_mutation()`
          yield* sql`INSERT INTO authority_generations VALUES (
          ${generation}, NULL, 1, 'persistence-test-account', ${'1'.repeat(64)}, NULL, 'PAPER',
          ${'d'.repeat(64)}, 'alpaca', 'sandbox', '2026-07-20T12:00:00Z'
        )`
          yield* sql`INSERT INTO authority_generations VALUES (
          ${successor}, ${generation}, 2, 'persistence-test-account', NULL, NULL, 'OBSERVE',
          ${'d'.repeat(64)}, 'alpaca', 'sandbox', '2026-07-20T21:02:00Z'
        )`
          yield* sql`INSERT INTO authority_state VALUES (
          true, ${successor}, 2, 'OBSERVE', 'OBSERVE', 'CLEAR', NULL, '2026-07-20T21:02:00Z'
        )`
          yield* sql`INSERT INTO autonomous_cycles VALUES (
          ${generation}, 'persistence-test-account', ${'1'.repeat(64)}, 'COMPLETED', '2026-07-20T21:00:00Z', NULL
        )`
          yield* sql`INSERT INTO intents VALUES (
          ${generation}, 'persistence-test-account', ${generation}, 'TERMINAL', '2026-07-20T21:00:00Z'
        )`
          return yield* program
        }),
      )
    }).pipe(
      Effect.scoped,
      Effect.provide(
        WriterFenceLive.pipe(
          Layer.provideMerge(
            PostgresClientLive({
              operationTimeoutMs: 5_000,
              postgres: { url: Redacted.make(url), tls: false, caPath: '/unused' },
            }),
          ),
        ),
      ),
      Effect.provide(NodeServices.layer),
    ),
  )
}

postgres('Forward-performance receipt terminality', () => {
  for (const reason of [
    executionMandateCompletedRestrictionReason,
    executionActivationExpiredRestrictionReason,
    legacyV1CompletedRestrictionReason,
    legacyExecutionActivationExpiredRestrictionReason,
  ]) {
    test(`appends before receipt-gated rollover without changing restricted authority: ${reason}`, async () => {
      const result = await withDatabase(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`DELETE FROM authority_generations WHERE generation_hash = ${successor}`
          yield* sql`UPDATE authority_state SET generation_hash = ${generation}, version = 2,
          maximum = 'PAPER', effective = 'OBSERVE', kill_state = 'ACTIVE', reason = ${reason},
          updated_at = '2026-07-20T21:00:30Z'`
          const before = yield* sql`SELECT * FROM authority_state`
          const original = packet()
          yield* evaluateAndPersistForwardPerformanceReceipt(generation, () =>
            Effect.succeed({ receipt: original.receipt }),
          )
          yield* persistForwardPerformanceReceipt(packet())
          const after = yield* sql`SELECT * FROM authority_state`
          const rows = yield* sql`SELECT document FROM autonomous_forward_performance_receipts`
          const successors =
            yield* sql`SELECT * FROM authority_generations WHERE previous_generation_hash = ${generation}`
          return { before, after, rows, original, successors }
        }),
      )
      expect(result.rows).toEqual([{ document: result.original }])
      expect(result.after).toEqual(result.before)
      expect(result.after[0]).toMatchObject({
        generation_hash: generation,
        effective: 'OBSERVE',
        kill_state: 'ACTIVE',
        reason,
      })
      expect(result.successors).toHaveLength(0)
    })
  }

  for (const change of [
    'effective-paper',
    'clear-kill',
    'operator-kill',
    'retryable-restriction',
    'missing-reason',
    'post-cut-restriction',
    'unreconciled-restriction',
    'unfinished-intent',
    'later-intent',
    'open-cycle',
  ] as const) {
    test(`refuses a nonterminal or unsettled current restriction: ${change}`, async () => {
      const result = await withDatabase(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`DELETE FROM authority_generations WHERE generation_hash = ${successor}`
          yield* sql`UPDATE authority_state SET generation_hash = ${generation}, version = 2,
          maximum = 'PAPER', effective = 'OBSERVE', kill_state = 'ACTIVE',
          reason = ${executionMandateCompletedRestrictionReason}, updated_at = '2026-07-20T21:00:30Z'`
          switch (change) {
            case 'effective-paper':
              yield* sql`UPDATE authority_state SET effective = 'PAPER'`
              break
            case 'clear-kill':
              yield* sql`UPDATE authority_state SET kill_state = 'CLEAR'`
              break
            case 'operator-kill':
              yield* sql`UPDATE authority_state SET reason = 'operator requested kill'`
              break
            case 'retryable-restriction':
              yield* sql`UPDATE authority_state SET reason = 'execution autonomous cycle loop restricted effective authority: retryable failure'`
              break
            case 'missing-reason':
              yield* sql`UPDATE authority_state SET reason = NULL`
              break
            case 'post-cut-restriction':
              yield* sql`UPDATE authority_state SET updated_at = '2026-07-20T21:01:01Z'`
              break
            case 'unreconciled-restriction':
              yield* sql`UPDATE authority_state SET updated_at = ${packet().createdAt}::timestamptz`
              break
            case 'unfinished-intent':
              yield* sql`UPDATE intents SET state = 'SUBMITTING'`
              break
            case 'later-intent':
              yield* sql`UPDATE intents SET updated_at = '2026-07-20T21:01:01Z'`
              break
            case 'open-cycle':
              yield* sql`UPDATE autonomous_cycles SET state = 'ACTIVE', terminal_at = NULL`
              break
          }
          const before = yield* sql`SELECT * FROM authority_state`
          const refused = yield* persistForwardPerformanceReceipt(packet()).pipe(Effect.result)
          const rows = yield* sql`SELECT * FROM autonomous_forward_performance_receipts`
          const after = yield* sql`SELECT * FROM authority_state`
          return { refused, rows, before, after }
        }),
      )
      expect(Result.isFailure(result.refused)).toBe(true)
      expect(result.rows).toHaveLength(0)
      expect(result.after).toEqual(result.before)
    })
  }

  test('read-only diagnostics retain a repeatable-read, read-only snapshot', async () => {
    const runtime = makeRuntime()
    try {
      const rows = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          return yield* forwardPerformanceSnapshot(sql).withTransaction(sql`
          SELECT current_setting('transaction_isolation') AS isolation,
                 current_setting('transaction_read_only') AS read_only
        `)
        }),
      )
      expect(rows).toEqual([{ isolation: 'repeatable read', read_only: 'on' }])
    } finally {
      await runtime.dispose()
    }
  })

  test('report evaluation holds the real ingestion fence before reading and releases it on failure', async () => {
    const runtime = makeRuntime()
    const contender = makeRuntime()
    const started = await Effect.runPromise(Deferred.make<void>())
    const release = await Effect.runPromise(Deferred.make<void>())
    const attempt = runtime.runPromiseExit(
      evaluateAndPersistForwardPerformanceReceipt(generation, (fence) =>
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const rows = yield* forwardPerformanceSnapshot(sql, fence).withTransaction(sql`
          SELECT current_setting('transaction_read_only') AS read_only
        `)
          expect(rows).toEqual([{ read_only: 'off' }])
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
          return yield* Effect.fail('evidence read failed before append')
        }),
      ),
    )
    try {
      await Effect.runPromise(Deferred.await(started).pipe(Effect.timeout('5 seconds')))
      const blocked = await contender.runPromise(
        Effect.flatMap(WriterFence, (fence) => fence.check).pipe(Effect.result),
      )
      expect(Result.isFailure(blocked)).toBe(true)
      if (Result.isFailure(blocked)) expect(blocked.failure.failure).toBe('busy')
      await Effect.runPromise(Deferred.succeed(release, undefined))
      const exit = await attempt
      expect(exit).toMatchObject({
        _tag: 'Failure',
        cause: { reasons: [{ _tag: 'Fail', error: 'evidence read failed before append' }] },
      })
      await contender.runPromise(Effect.flatMap(WriterFence, (fence) => fence.check))
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined))
      await attempt
      await runtime.dispose()
      await contender.dispose()
    }
  }, 15_000)

  test('an in-flight ingester prevents receipt evidence reads until its transaction commits', async () => {
    const runtime = makeRuntime()
    const ingester = makeRuntime()
    const started = await Effect.runPromise(Deferred.make<void>())
    const release = await Effect.runPromise(Deferred.make<void>())
    const ingest = ingester.runPromiseExit(
      Effect.flatMap(WriterFence, (fence) =>
        fence.transaction(Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))),
      ),
    )
    let reads = 0
    const evaluate = () =>
      Effect.sync(() => {
        reads += 1
      }).pipe(Effect.andThen(Effect.fail('read after ingestion')))
    try {
      await Effect.runPromise(Deferred.await(started).pipe(Effect.timeout('5 seconds')))
      const blocked = await runtime.runPromise(
        evaluateAndPersistForwardPerformanceReceipt(generation, evaluate).pipe(Effect.result),
      )
      expect(Result.isFailure(blocked)).toBe(true)
      if (Result.isFailure(blocked))
        expect(blocked.failure).toMatchObject({ _tag: 'WriterFenceError', failure: 'busy' })
      expect(reads).toBe(0)
      await Effect.runPromise(Deferred.succeed(release, undefined))
      expect(Exit.isSuccess(await ingest)).toBe(true)
      const retry = await runtime.runPromise(
        evaluateAndPersistForwardPerformanceReceipt(generation, evaluate).pipe(Effect.result),
      )
      expect(retry).toEqual(Result.fail('read after ingestion'))
      expect(reads).toBe(1)
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined))
      await ingest
      await runtime.dispose()
      await ingester.dispose()
    }
  }, 15_000)

  test('rejects an active generation even if a successor row has been prepared', async () => {
    const result = await withDatabase(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`UPDATE authority_state SET generation_hash = ${generation}, version = 1,
          maximum = 'PAPER', effective = 'PAPER', kill_state = 'CLEAR', reason = NULL`
        const refused = yield* persistForwardPerformanceReceipt(packet()).pipe(Effect.result)
        const rows = yield* sql`SELECT * FROM autonomous_forward_performance_receipts`
        return { refused, rows }
      }),
    )
    expect(Result.isFailure(result.refused)).toBe(true)
    expect(result.rows).toHaveLength(0)
  })

  test('appends a sufficient retired report once and leaves the first receipt unchanged on conflict', async () => {
    const result = await withDatabase(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const original = packet()
        yield* evaluateAndPersistForwardPerformanceReceipt(generation, (fence) =>
          forwardPerformanceSnapshot(sql, fence).withTransaction(Effect.succeed({ receipt: original.receipt })),
        )
        yield* persistForwardPerformanceReceipt(packet())
        const different = Result.getOrThrow(
          makePersistableForwardPerformanceReceiptEnvelope(
            generation,
            makePersistenceReceipt({ startingCapitalMicros: '2000' }),
          ),
        )
        const conflict = yield* persistForwardPerformanceReceipt(different).pipe(Effect.result)
        const rows = yield* sql`SELECT document FROM autonomous_forward_performance_receipts`
        const mutation = yield* sql
          .withTransaction(sql`UPDATE autonomous_forward_performance_receipts SET cycle_id = cycle_id`)
          .pipe(Effect.result)
        return { original, conflict, rows, mutation }
      }),
    )
    expect(result.rows).toEqual([{ document: result.original }])
    expect(Result.isFailure(result.conflict)).toBe(true)
    expect(Result.isFailure(result.mutation)).toBe(true)
  })

  test('refuses UNCLOSED_WINDOW despite non-null cut and completed cycle', async () => {
    const result = await withDatabase(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const receipt = makePersistenceReceipt({ unclosedCycleCount: 1 })
        const { contentHash: _contentHash, ...material } = packet()
        const invalid = Result.getOrThrow(
          makeForwardPerformanceReceiptEnvelope({
            ...material,
            receipt,
            receiptHash: receipt.receiptHash,
          }),
        )
        const refused = yield* persistForwardPerformanceReceipt(invalid).pipe(Effect.result)
        const rows = yield* sql`SELECT * FROM autonomous_forward_performance_receipts`
        return { refused, rows }
      }),
    )
    expect(Result.isFailure(result.refused)).toBe(true)
    expect(result.rows).toHaveLength(0)
  })

  for (const change of [
    'foreign-account',
    'unbound-cycle',
    'unfinished-intent',
    'later-intent',
    'missing-successor',
  ] as const) {
    test(`rejects ${change} at the persistence boundary`, async () => {
      const result = await withDatabase(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          switch (change) {
            case 'foreign-account':
              yield* sql`UPDATE authority_generations SET broker_identity_hash = ${'e'.repeat(64)}`
              break
            case 'unbound-cycle':
              yield* sql`UPDATE intents SET cycle_id = ${'e'.repeat(64)}`
              break
            case 'unfinished-intent':
              yield* sql`UPDATE intents SET state = 'SUBMITTING'`
              break
            case 'later-intent':
              yield* sql`UPDATE intents SET updated_at = '2026-07-20T21:01:01Z'`
              break
            case 'missing-successor':
              yield* sql`DELETE FROM authority_generations WHERE generation_hash = ${successor}`
              break
          }
          const refused = yield* persistForwardPerformanceReceipt(packet()).pipe(Effect.result)
          const rows = yield* sql`SELECT * FROM autonomous_forward_performance_receipts`
          return { refused, rows }
        }),
      )
      expect(Result.isFailure(result.refused)).toBe(true)
      expect(result.rows).toHaveLength(0)
    })
  }
})
