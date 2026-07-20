import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime, Option, Redacted } from 'effect'

import type { RuntimeConfig } from '../config'
import { buildLedgerPlan } from '../ledger'
import { evaluateTsmom } from '../strategy'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from '../test-fixtures'
import {
  DatabaseError,
  EvidenceStore,
  EvidenceStoreLive,
  PostgresClientLive,
  type PersistEvaluationInput,
} from './evidence-store'

const postgresUrl = process.env.BAYN_TEST_POSTGRES_URL
const testUrl = postgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = postgresUrl === undefined ? describe.skip : describe

const makeConfig = (url = testUrl): RuntimeConfig => ({
  host: '127.0.0.1',
  port: 8080,
  build: {
    sourceRevision: 'a'.repeat(40),
    imageRepository: 'registry.ide-newton.ts.net/lab/bayn',
    imageDigest: `sha256:${'b'.repeat(64)}`,
    strategyBehaviorHash: 'c'.repeat(64),
    verification: 'embedded',
  },
  runOnStartup: true,
  operationTimeoutMs: 1_000,
  clickhouse: {
    url: 'http://clickhouse.invalid',
    username: 'bayn',
    password: Redacted.make('unused'),
    snapshotId: '1'.repeat(64),
    publicationAsOf: '2026-07-17',
    calendarVersion: 'fixture-calendar-v1',
    bounds: {
      schemaVersion: 'bayn.evaluation-bounds.v1',
      dataStart: '2018-01-02',
      dataEnd: '2026-07-17',
      lookbackStart: '2018-01-02',
      evaluationStart: '2019-01-02',
      evaluationEnd: '2026-07-17',
    },
  },
  postgres: { url: Redacted.make(url), tls: false, caPath: '/unused' },
  tigerBeetle: { clusterId: 2_001n, replicaAddresses: ['127.0.0.1:3000'], ledger: 7_001 },
})

const makeEvidenceRuntime = (config = makeConfig()) =>
  ManagedRuntime.make(EvidenceStoreLive(config).pipe(Layer.provide(NodeServices.layer)))

const makeClientRuntime = (config = makeConfig()) =>
  ManagedRuntime.make(PostgresClientLive(config).pipe(Layer.provide(NodeServices.layer)))

const snapshot = makeSnapshot(800)

const makeInput = (sourceRevision = 'a'.repeat(40)): PersistEvaluationInput => {
  const provenance = makeTestProvenance(fixtureProtocol, { sourceRevision })
  const evaluation = evaluateTsmom(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance)
  const ledger = buildLedgerPlan(evaluation, 7_001)
  return {
    provenance,
    parameters: fixtureProtocol,
    evaluation,
    reconciliation: {
      runId: evaluation.runId,
      accountCount: ledger.accounts.length,
      transferCount: ledger.transfers.length,
      exact: true,
    },
  }
}

describePostgres('PostgreSQL evaluation evidence', () => {
  let runtime: ReturnType<typeof makeEvidenceRuntime>

  beforeAll(async () => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local database whose name ends in _test')
    }
    runtime = makeEvidenceRuntime()
    await runtime.runPromise(Effect.flatMap(EvidenceStore, (store) => store.check))
  })

  beforeEach(async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`
          TRUNCATE
            bayn_evaluation_runs,
            bayn_protocol_locks,
            bayn_snapshot_references
          RESTART IDENTITY CASCADE
        `
      }),
    )
  })

  afterAll(async () => {
    await runtime?.dispose()
  })

  test('migrates the complete evidence schema', async () => {
    const tables = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return yield* sql<{ table_name: string }>`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name LIKE 'bayn_%'
          ORDER BY table_name
        `
      }),
    )

    expect(tables.map((row) => row.table_name)).toEqual([
      'bayn_evaluation_artifacts',
      'bayn_evaluation_events',
      'bayn_evaluation_runs',
      'bayn_gate_outcomes',
      'bayn_protocol_locks',
      'bayn_schema_migrations',
      'bayn_snapshot_references',
      'bayn_status_history',
    ])
  })

  test('commits one complete run and deduplicates an exact replay', async () => {
    const input = makeInput()
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        const sql = yield* PgClient.PgClient
        const first = yield* store.persist(input)
        const second = yield* store.persist(input)
        const runs = yield* sql<{
          status: string
          artifact_count: number
          event_count: number
          gate_count: number
        }>`
          SELECT
            run.status,
            (SELECT count(*)::integer FROM bayn_evaluation_artifacts WHERE run_id = run.run_id) AS artifact_count,
            (SELECT count(*)::integer FROM bayn_evaluation_events WHERE run_id = run.run_id) AS event_count,
            (SELECT count(*)::integer FROM bayn_gate_outcomes WHERE run_id = run.run_id) AS gate_count
          FROM bayn_evaluation_runs AS run
        `
        const gates = yield* sql<{
          gate_name: string
          actual: unknown
          required: unknown
          actual_type: string
          required_type: string
        }>`
          SELECT
            gate_name,
            actual,
            required,
            jsonb_typeof(actual) AS actual_type,
            jsonb_typeof(required) AS required_type
          FROM bayn_gate_outcomes
          WHERE run_id = ${input.evaluation.runId}
          ORDER BY ordinal
        `
        return { first, second, runs, gates }
      }),
    )

    expect(result.first).toMatchObject({ runId: input.evaluation.runId, deduplicated: false })
    expect(result.first.artifactCount).toBe(6)
    expect(result.second).toEqual({ ...result.first, deduplicated: true })
    expect(result.runs).toEqual([
      {
        status: 'COMPLETE',
        artifact_count: result.first.artifactCount,
        event_count: result.first.eventCount,
        gate_count: result.first.gateCount,
      },
    ])
    expect(result.gates).toEqual(
      input.evaluation.verdict.gates.map((gate) => ({
        gate_name: gate.name,
        actual: gate.actual,
        required: gate.required,
        actual_type: typeof gate.actual,
        required_type: typeof gate.required,
      })),
    )
  })

  test('creates distinct runs when bound runtime provenance changes', async () => {
    const first = makeInput('a'.repeat(40))
    const second = makeInput('d'.repeat(40))
    const receipts = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        return [yield* store.persist(first), yield* store.persist(second)] as const
      }),
    )

    expect(first.evaluation.runId).not.toBe(second.evaluation.runId)
    expect(receipts.map((receipt) => receipt.runId)).toEqual([first.evaluation.runId, second.evaluation.runId])
  })

  test('rejects a complete receipt whose stored evidence was altered', async () => {
    const input = makeInput()
    const error = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        const sql = yield* PgClient.PgClient
        yield* store.persist(input)
        yield* sql`
          UPDATE bayn_evaluation_artifacts
          SET payload = ${sql.json({ corrupted: true })}
          WHERE run_id = ${input.evaluation.runId} AND artifact_name = 'strategy'
        `
        return yield* store.persist(input).pipe(Effect.flip)
      }),
    )

    expect(error).toBeInstanceOf(DatabaseError)
    expect(error.failure).toBe('invariant')
    expect(error.operation).toBe('read-receipt')
  })

  test('rejects a replay whose normalized snapshot bounds were altered', async () => {
    const input = makeInput()
    const error = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        const sql = yield* PgClient.PgClient
        yield* store.persist(input)
        yield* sql`
          UPDATE bayn_snapshot_references
          SET first_session = first_session + 1
          WHERE snapshot_id = ${input.evaluation.inputManifest.finalizedSnapshot.snapshotId}
        `
        return yield* store.persist(input).pipe(Effect.flip)
      }),
    )

    expect(error).toBeInstanceOf(DatabaseError)
    expect(error.failure).toBe('invariant')
    expect(error.operation).toBe('snapshot-reference')
    expect(error.message).toContain('stored snapshot reference diverged')
  })

  test('rejects a replay whose initial capital was altered', async () => {
    const input = makeInput()
    const error = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        const sql = yield* PgClient.PgClient
        yield* store.persist(input)
        yield* sql`
          UPDATE bayn_evaluation_runs
          SET initial_capital_micros = initial_capital_micros + 1
          WHERE run_id = ${input.evaluation.runId}
        `
        return yield* store.persist(input).pipe(Effect.flip)
      }),
    )

    expect(error).toBeInstanceOf(DatabaseError)
    expect(error.failure).toBe('invariant')
    expect(error.operation).toBe('read-receipt')
    expect(error.message).toContain('stored run identity diverged')
  })

  test('rejects a replay whose status detail was altered', async () => {
    const input = makeInput()
    const error = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        const sql = yield* PgClient.PgClient
        yield* store.persist(input)
        yield* sql`
          UPDATE bayn_status_history
          SET detail = ${sql.json({ reconciliationExact: false, verdict: 'corrupted' })}
          WHERE run_id = ${input.evaluation.runId} AND status = 'COMPLETE'
        `
        return yield* store.persist(input).pipe(Effect.flip)
      }),
    )

    expect(error).toBeInstanceOf(DatabaseError)
    expect(error.failure).toBe('invariant')
    expect(error.operation).toBe('read-receipt')
    expect(error.message).toContain('stored status history diverged')
  })

  test('rolls back every table when an event constraint fails', async () => {
    const input = makeInput()
    const duplicateId = input.evaluation.events[0].id
    const invalid: PersistEvaluationInput = {
      ...input,
      evaluation: {
        ...input.evaluation,
        events: input.evaluation.events.map((event, index) => (index === 1 ? { ...event, id: duplicateId } : event)),
      },
    }
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        const error = yield* store.persist(invalid).pipe(Effect.flip)
        const sql = yield* PgClient.PgClient
        const counts = yield* sql<{
          runs: number
          protocols: number
          snapshots: number
          events: number
        }>`
          SELECT
            (SELECT count(*)::integer FROM bayn_evaluation_runs) AS runs,
            (SELECT count(*)::integer FROM bayn_protocol_locks) AS protocols,
            (SELECT count(*)::integer FROM bayn_snapshot_references) AS snapshots,
            (SELECT count(*)::integer FROM bayn_evaluation_events) AS events
        `
        return { error, counts: counts[0] }
      }),
    )

    expect(result.error).toBeInstanceOf(DatabaseError)
    expect(result.error.failure).toBe('constraint')
    expect(result.counts).toEqual({ runs: 0, protocols: 0, snapshots: 0, events: 0 })
  })

  test('cancels an interrupted query and returns its pooled connection', async () => {
    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const sleeper = yield* Effect.forkChild(sql`SELECT pg_sleep(30)`)
        yield* Effect.sleep('250 millis')
        yield* Fiber.interrupt(sleeper)
        return yield* sql<{ value: number }>`SELECT 1::integer AS value`.pipe(
          Effect.timeoutOrElse({
            duration: '2 seconds',
            orElse: () => Effect.fail(new Error('PostgreSQL pool did not recover')),
          }),
        )
      }),
    )

    expect(rows).toEqual([{ value: 1 }])
  })

  test('closes the PostgreSQL pool when its managed scope is disposed', async () => {
    const scoped = makeClientRuntime()
    const pid = await scoped.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const rows = yield* sql<{ pid: number }>`SELECT pg_backend_pid()::integer AS pid`
        return rows[0].pid
      }),
    )
    await scoped.dispose()

    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return yield* sql<{ count: number }>`
          SELECT count(*)::integer AS count FROM pg_stat_activity WHERE pid = ${pid}
        `
      }),
    )
    expect(rows).toEqual([{ count: 0 }])
  })

  test('reports an unreachable database as a typed availability failure', async () => {
    const invalid = makeEvidenceRuntime(makeConfig('postgresql://bayn:bayn@127.0.0.1:1/bayn_test'))
    try {
      const exit = await invalid.runPromiseExit(Effect.void)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error('unreachable PostgreSQL unexpectedly initialized')
      const failure = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(failure)).toBe(true)
      if (Option.isNone(failure)) throw new Error(Cause.pretty(exit.cause))
      expect(failure.value).toBeInstanceOf(DatabaseError)
      expect((failure.value as DatabaseError).failure).toBe('unavailable')
    } finally {
      await invalid.dispose()
    }
  })
})
