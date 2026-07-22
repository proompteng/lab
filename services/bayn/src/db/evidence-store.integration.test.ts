import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient, PgMigrator } from '@effect/sql-pg'
import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime, Option, Redacted } from 'effect'

import type { RuntimeConfig } from '../config'
import { canonicalHashV1 } from '../hash'
import { buildLedgerPlan } from '../ledger'
import { makeQualificationResult } from '../qualification'
import { evaluateRiskBalancedTrend } from '../risk-balanced-trend'
import { makeStrategy } from '../strategy-service'
import { makeSnapshot, makeTestProvenance, fixtureProtocol } from '../test-fixtures'
import type { Protocol } from '../types'
import {
  DatabaseError,
  EvidenceStore,
  EvidenceStoreLive,
  PostgresClientLive,
  type PersistEvaluationInput,
} from './evidence-store'
import { migrationLoader } from './migrations'

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
    strategyParameterHash: 'd'.repeat(64),
    verification: 'embedded',
  },
  healthIntervalMs: 30_000,
  operationTimeoutMs: 5_000,
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

const riskBalancedTrendSnapshot = makeSnapshot(800)

const makeInput = (
  sourceRevision = 'a'.repeat(40),
  behaviorHash = 'd'.repeat(64),
  protocol: Protocol = fixtureProtocol,
): PersistEvaluationInput => {
  const provenance = makeTestProvenance(protocol, { sourceRevision, behaviorHash })
  const evaluation = evaluateRiskBalancedTrend(
    riskBalancedTrendSnapshot.bars,
    riskBalancedTrendSnapshot.manifest,
    protocol,
    provenance,
  )
  const ledger = buildLedgerPlan(evaluation, 7_001)
  return {
    provenance,
    parameters: protocol,
    evaluation,
    reconciliation: {
      runId: evaluation.runId,
      accountCount: ledger.accounts.length,
      transferCount: ledger.transfers.length,
      exact: true,
    },
  }
}

const makeLockedInput = (input: PersistEvaluationInput, priorTrialRunIds: readonly string[] = []) => {
  const strategy = makeStrategy(fixtureProtocol, input.provenance)
  const sessionDates = [...new Set(riskBalancedTrendSnapshot.bars.map((bar) => bar.sessionDate))].sort()
  const lock = strategy.prepareLock(input.evaluation.inputManifest, sessionDates, priorTrialRunIds)
  const result = makeQualificationResult(
    lock,
    input.evaluation.verdict,
    strategy.analyze(input.evaluation, priorTrialRunIds),
  )
  return {
    open: {
      lock,
      inputManifest: input.evaluation.inputManifest,
      parameters: input.parameters,
      provenance: input.provenance,
    },
    persist: { ...input, qualification: { lock, result } },
    lock,
    result,
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
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
      }),
    )
    await runtime.dispose()
    runtime = makeEvidenceRuntime()
    await runtime.runPromise(Effect.flatMap(EvidenceStore, (store) => store.check))
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
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          ORDER BY table_name
        `
      }),
    )

    expect(tables.map((row) => row.table_name)).toEqual([
      'evaluation_artifacts',
      'evaluation_events',
      'evaluation_runs',
      'gate_outcomes',
      'protocol_locks',
      'qualification_locks',
      'qualification_results',
      'qualification_trials',
      'schema_migrations',
      'snapshot_references',
      'status_history',
    ])
  })

  test('rejects the legacy migration tracker instead of renaming it', async () => {
    await runtime.dispose()
    const client = makeClientRuntime()
    await client.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* sql`CREATE TABLE bayn_schema_migrations (migration_id integer PRIMARY KEY)`
      }),
    )

    const legacyRuntime = makeEvidenceRuntime()
    const exit = await legacyRuntime.runPromiseExit(Effect.flatMap(EvidenceStore, (store) => store.check))
    await legacyRuntime.dispose()

    const trackers = await client.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const rows = yield* sql<{ current_exists: boolean; legacy_exists: boolean }>`
          SELECT
            to_regclass('public.schema_migrations') IS NOT NULL AS current_exists,
            to_regclass('public.bayn_schema_migrations') IS NOT NULL AS legacy_exists
        `
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        return rows[0]
      }),
    )
    await client.dispose()
    runtime = makeEvidenceRuntime()
    await runtime.runPromise(Effect.flatMap(EvidenceStore, (store) => store.check))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain('legacy migration tracker is unsupported')
    expect(trackers).toEqual({ current_exists: false, legacy_exists: true })
  })

  test('hard-migrates the deployed schema by deleting previous evidence and preserving migration history', async () => {
    const runId = '9'.repeat(64)
    const snapshotId = '6'.repeat(64)
    const lockId = '5'.repeat(64)
    const resultHash = '4'.repeat(64)
    const analysisHash = '3'.repeat(64)
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* sql`DROP SCHEMA IF EXISTS restore_probe CASCADE`
        yield* sql`CREATE SCHEMA restore_probe`
        yield* sql`CREATE TABLE restore_probe.evidence (proof_id text PRIMARY KEY, proof_value text NOT NULL)`
        yield* sql`INSERT INTO restore_probe.evidence VALUES ('legacy-restore-proof', 'must-be-deleted')`
        const deployedMigrations = migrationLoader.pipe(
          Effect.map((migrations) => migrations.filter(([id]) => id <= 5)),
        )
        yield* PgMigrator.run({ loader: deployedMigrations, table: 'schema_migrations' }).pipe(
          Effect.provide(NodeServices.layer),
        )
        yield* sql`
          INSERT INTO bayn_protocol_locks (
            protocol_hash,
            schema_version,
            strategy_name,
            behavior_hash,
            parameter_hash,
            parameters
          ) VALUES (
            ${runId},
            'bayn.tsmom.protocol.v2',
            'tsmom',
            ${'8'.repeat(64)},
            ${'7'.repeat(64)},
            '{}'::jsonb
          )
        `
        yield* sql`
          INSERT INTO bayn_protocol_locks (
            protocol_hash,
            schema_version,
            strategy_name,
            behavior_hash,
            parameter_hash,
            parameters
          ) VALUES (
            ${'e'.repeat(64)},
            'bayn.tsmom.protocol.v1',
            'tsmom',
            ${'f'.repeat(64)},
            ${'0'.repeat(64)},
            '{}'::jsonb
          )
        `
        yield* sql`
          INSERT INTO bayn_snapshot_references (
            snapshot_id,
            schema_version,
            database_name,
            table_name,
            dataset_version,
            source,
            source_feed,
            adjustment,
            content_hash,
            row_count,
            first_session,
            last_session,
            manifest
          ) VALUES (
            ${snapshotId},
            'bayn.finalized-snapshot.v2',
            'signal',
            'adjusted_daily_bars_v2',
            'signal.adjusted-daily-snapshot.v1',
            'alpaca',
            'sip',
            'all',
            ${'2'.repeat(64)},
            1,
            '2026-07-17',
            '2026-07-17',
            '{}'::jsonb
          )
        `
        yield* sql`
          INSERT INTO bayn_evaluation_runs (
            run_id,
            protocol_hash,
            snapshot_id,
            evaluation_schema_version,
            source_revision,
            image_repository,
            image_digest,
            strategy_name,
            initial_capital_micros,
            expected_artifact_count,
            expected_event_count,
            expected_gate_count,
            status,
            completed_at
          ) VALUES (
            ${runId},
            ${runId},
            ${snapshotId},
            'bayn.evaluation.v4',
            ${'1'.repeat(40)},
            'registry.example/bayn',
            ${`sha256:${'0'.repeat(64)}`},
            'tsmom',
            1000000,
            1,
            1,
            1,
            'COMPLETE',
            transaction_timestamp()
          )
        `
        yield* sql`
          INSERT INTO bayn_evaluation_artifacts (
            run_id, artifact_name, schema_version, content_hash, payload
          ) VALUES (${runId}, 'legacy', 'bayn.legacy.v1', ${'a'.repeat(64)}, '{}'::jsonb)
        `
        yield* sql`
          INSERT INTO bayn_evaluation_events (
            run_id, ordinal, event_id, event_kind, content_hash, payload
          ) VALUES (${runId}, 0, ${'b'.repeat(64)}, 'decision', ${'c'.repeat(64)}, '{}'::jsonb)
        `
        yield* sql`
          INSERT INTO bayn_gate_outcomes (
            run_id, ordinal, gate_name, passed, actual, required, content_hash
          ) VALUES (${runId}, 0, 'legacy-gate', false, '0'::jsonb, '1'::jsonb, ${'d'.repeat(64)})
        `
        yield* sql`
          INSERT INTO bayn_status_history (run_id, status, detail)
          VALUES (${runId}, 'COMPLETE', '{}'::jsonb)
        `
        yield* sql`
          INSERT INTO bayn_qualification_trials (
            run_id, schema_version, disposition, reason_codes, observed_at
          ) VALUES (
            ${runId},
            'bayn.qualification-trial.v1',
            'BURNED',
            ARRAY['PRE_LOCK_RESULT_OBSERVED'],
            transaction_timestamp()
          )
        `
        const lock = {
          schemaVersion: 'bayn.qualification-lock.v2',
          lockId,
          candidateRunId: runId,
          protocolHash: runId,
          sourceRevision: '1'.repeat(40),
          image: { repository: 'registry.example/bayn', digest: `sha256:${'0'.repeat(64)}` },
          data: { snapshotId },
        }
        yield* sql`
          INSERT INTO bayn_qualification_locks (
            lock_id,
            schema_version,
            candidate_run_id,
            protocol_hash,
            snapshot_id,
            source_revision,
            image_repository,
            image_digest,
            payload
          ) VALUES (
            ${lockId},
            'bayn.qualification-lock.v2',
            ${runId},
            ${runId},
            ${snapshotId},
            ${'1'.repeat(40)},
            'registry.example/bayn',
            ${`sha256:${'0'.repeat(64)}`},
            ${sql.json(lock)}
          )
        `
        const result = {
          schemaVersion: 'bayn.qualification-result.v2',
          lockId,
          runId,
          verdict: 'REJECTED',
          analysis: { analysisHash },
          resultHash,
        }
        yield* sql`
          INSERT INTO bayn_qualification_results (
            lock_id, schema_version, run_id, verdict, analysis_hash, result_hash, payload
          ) VALUES (
            ${lockId},
            'bayn.qualification-result.v2',
            ${runId},
            'REJECTED',
            ${analysisHash},
            ${resultHash},
            ${sql.json(result)}
          )
        `
      }),
    )

    await runtime.dispose()
    runtime = makeEvidenceRuntime()
    await runtime.runPromise(Effect.flatMap(EvidenceStore, (store) => store.check))

    const migrated = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const legacyTables = yield* sql<{ count: number }>`
          SELECT count(*)::integer AS count
          FROM pg_catalog.pg_tables
          WHERE schemaname = 'public' AND tablename LIKE 'bayn\_%' ESCAPE '\'
        `
        const legacyRelations = yield* sql<{ count: number }>`
          SELECT count(*)::integer AS count
          FROM pg_catalog.pg_class AS relation
          INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public' AND left(relation.relname, 5) = 'bayn_'
        `
        const currentSequence = yield* sql<{ exists: boolean }>`
          SELECT to_regclass('public.status_history_sequence_seq') IS NOT NULL AS exists
        `
        const restoreProbe = yield* sql<{ exists: boolean }>`
          SELECT to_regnamespace('restore_probe') IS NOT NULL AS exists
        `
        const migrations = yield* sql<{ count: number }>`
          SELECT count(*)::integer AS count FROM schema_migrations
        `
        const evidence = yield* sql<{ count: number }>`
          SELECT (
            (SELECT count(*) FROM protocol_locks) +
            (SELECT count(*) FROM snapshot_references) +
            (SELECT count(*) FROM evaluation_runs) +
            (SELECT count(*) FROM evaluation_artifacts) +
            (SELECT count(*) FROM evaluation_events) +
            (SELECT count(*) FROM gate_outcomes) +
            (SELECT count(*) FROM status_history) +
            (SELECT count(*) FROM qualification_trials) +
            (SELECT count(*) FROM qualification_locks) +
            (SELECT count(*) FROM qualification_results)
          )::integer AS count
        `
        return {
          legacyTableCount: legacyTables[0]?.count,
          legacyRelationCount: legacyRelations[0]?.count,
          currentSequenceExists: currentSequence[0]?.exists,
          restoreProbeExists: restoreProbe[0]?.exists,
          migrationCount: migrations[0]?.count,
          evidenceCount: evidence[0]?.count,
        }
      }),
    )

    expect(migrated).toEqual({
      legacyTableCount: 0,
      legacyRelationCount: 0,
      currentSequenceExists: true,
      restoreProbeExists: false,
      migrationCount: 8,
      evidenceCount: 0,
    })
  })

  test('rejects legacy protocol rows after the hard cut', async () => {
    const exits = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const legacy = yield* Effect.exit(sql`
          INSERT INTO protocol_locks (
            protocol_hash, schema_version, strategy_name, behavior_hash, parameter_hash, parameters
          ) VALUES (
            ${'0'.repeat(64)},
            'bayn.tsmom.protocol.v2',
            'tsmom',
            ${'1'.repeat(64)},
            ${'2'.repeat(64)},
            '{}'::jsonb
          )
        `)
        const current = yield* Effect.exit(sql`
          INSERT INTO protocol_locks (
            protocol_hash, schema_version, strategy_name, behavior_hash, parameter_hash, parameters
          ) VALUES (
            ${'3'.repeat(64)},
            'bayn.risk-balanced-trend.protocol.v2',
            'risk-balanced-trend',
            ${'4'.repeat(64)},
            ${'5'.repeat(64)},
            '{}'::jsonb
          )
        `)
        return { current, legacy }
      }),
    )

    expect(Exit.isFailure(exits.legacy)).toBe(true)
    expect(Exit.isSuccess(exits.current)).toBe(true)
  })

  test('keeps the audit snapshot repeatable-read and rejects writes', async () => {
    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`CREATE TABLE audit_read_only_probe (id integer PRIMARY KEY)`
        const transaction = yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
            const mode = yield* sql<{ isolation: string; read_only: boolean }>`
              SELECT
                current_setting('transaction_isolation') AS isolation,
                current_setting('transaction_read_only') = 'on' AS read_only
            `
            const write = yield* Effect.exit(sql`INSERT INTO audit_read_only_probe (id) VALUES (1)`)
            return { mode: mode[0], write }
          }),
        )
        const rows = yield* sql<{ count: number }>`
          SELECT count(*)::integer AS count FROM audit_read_only_probe
        `
        return { ...transaction, rows }
      }),
    )

    expect(observed.mode).toEqual({ isolation: 'repeatable read', read_only: true })
    expect(Exit.isFailure(observed.write)).toBe(true)
    expect(observed.rows).toEqual([{ count: 0 }])
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
            (SELECT count(*)::integer FROM evaluation_artifacts WHERE run_id = run.run_id) AS artifact_count,
            (SELECT count(*)::integer FROM evaluation_events WHERE run_id = run.run_id) AS event_count,
            (SELECT count(*)::integer FROM gate_outcomes WHERE run_id = run.run_id) AS gate_count
          FROM evaluation_runs AS run
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
          FROM gate_outcomes
          WHERE run_id = ${input.evaluation.runId}
          ORDER BY ordinal
        `
        return { first, second, runs, gates }
      }),
    )

    expect(result.first).toMatchObject({ runId: input.evaluation.runId, deduplicated: false })
    expect(result.first.artifactCount).toBe(17)
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

  test('opens one concurrent lock and commits one terminal qualification result', async () => {
    const input = makeInput()
    const qualification = makeLockedInput(input)
    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        const sql = yield* PgClient.PgClient
        const opened = yield* Effect.all(
          [store.openQualification(qualification.open), store.openQualification(qualification.open)],
          { concurrency: 'unbounded' },
        )
        const before = yield* store.readQualification(input.evaluation.runId)
        const bypass = yield* store.persist(input).pipe(Effect.flip)
        const receipt = yield* store.persist(qualification.persist)
        const terminal = yield* store.readQualification(input.evaluation.runId)
        const reopened = yield* store.openQualification(qualification.open)
        const trials = yield* store.listPriorTrials
        const counts = yield* sql<{
          locks: number
          results: number
          runs: number
          trials: number
        }>`
          SELECT
            (SELECT count(*)::integer FROM qualification_locks) AS locks,
            (SELECT count(*)::integer FROM qualification_results) AS results,
            (SELECT count(*)::integer FROM evaluation_runs) AS runs,
            (SELECT count(*)::integer FROM qualification_trials) AS trials
        `
        return { before, bypass, counts: counts[0], opened, receipt, reopened, terminal, trials }
      }),
    )

    expect(observed.opened.map((result) => result.state).sort()).toEqual(['ACQUIRED', 'OPENED_INCOMPLETE'])
    expect(observed.before).toEqual(Option.some({ state: 'OPENED_INCOMPLETE', lock: qualification.lock }))
    expect(observed.bypass).toMatchObject({ failure: 'invariant', operation: 'persist-qualification' })
    expect(observed.receipt).toMatchObject({ runId: input.evaluation.runId, deduplicated: false })
    expect(observed.terminal).toEqual(
      Option.some({ state: 'TERMINAL', lock: qualification.lock, result: qualification.result }),
    )
    expect(observed.reopened).toEqual({
      state: 'TERMINAL',
      lock: qualification.lock,
      result: qualification.result,
    })
    expect(observed.trials).toEqual([input.evaluation.runId])
    expect(observed.counts).toEqual({ locks: 1, results: 1, runs: 1, trials: 0 })
  })

  test('builds the next candidate lineage from both burned and terminal trials', async () => {
    const burned = makeInput('0'.repeat(40))
    const terminal = makeInput('1'.repeat(40))
    const terminalQualification = makeLockedInput(terminal, [burned.evaluation.runId])
    const candidate = makeInput()
    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        yield* store.persist(burned)
        yield* store.openQualification(terminalQualification.open)
        yield* store.persist(terminalQualification.persist)
        const priorTrialRunIds = yield* store.listPriorTrials
        const strategy = makeStrategy(fixtureProtocol, candidate.provenance)
        const sessionDates = [...new Set(riskBalancedTrendSnapshot.bars.map((bar) => bar.sessionDate))].sort()
        const lock = strategy.prepareLock(candidate.evaluation.inputManifest, sessionDates, priorTrialRunIds)
        return { lock, priorTrialRunIds }
      }),
    )

    expect(observed.priorTrialRunIds).toEqual([burned.evaluation.runId, terminal.evaluation.runId].sort())
    expect(observed.lock.priorTrialRunIds).toEqual(observed.priorTrialRunIds)
  })

  test('rolls back the evaluation graph when terminal qualification insertion fails', async () => {
    const input = makeInput()
    const qualification = makeLockedInput(input)
    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        const sql = yield* PgClient.PgClient
        yield* store.openQualification(qualification.open)
        yield* sql`
          CREATE FUNCTION bayn_test_reject_qualification_result()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $function$
          BEGIN
            RAISE EXCEPTION 'injected terminal result failure' USING ERRCODE = 'P0001';
          END
          $function$
        `
        yield* sql`
          CREATE TRIGGER bayn_test_reject_qualification_result
          BEFORE INSERT ON qualification_results
          FOR EACH ROW EXECUTE FUNCTION bayn_test_reject_qualification_result()
        `
        const failure = yield* store.persist(qualification.persist).pipe(Effect.flip)
        const record = yield* store.readQualification(input.evaluation.runId)
        const counts = yield* sql<{
          locks: number
          results: number
          runs: number
          artifacts: number
          events: number
          gates: number
          statuses: number
        }>`
          SELECT
            (SELECT count(*)::integer FROM qualification_locks) AS locks,
            (SELECT count(*)::integer FROM qualification_results) AS results,
            (SELECT count(*)::integer FROM evaluation_runs) AS runs,
            (SELECT count(*)::integer FROM evaluation_artifacts) AS artifacts,
            (SELECT count(*)::integer FROM evaluation_events) AS events,
            (SELECT count(*)::integer FROM gate_outcomes) AS gates,
            (SELECT count(*)::integer FROM status_history) AS statuses
        `
        return { counts: counts[0], failure, record }
      }),
    )

    expect(observed.failure).toBeInstanceOf(DatabaseError)
    expect(observed.record).toEqual(Option.some({ state: 'OPENED_INCOMPLETE', lock: qualification.lock }))
    expect(observed.counts).toEqual({
      locks: 1,
      results: 0,
      runs: 0,
      artifacts: 0,
      events: 0,
      gates: 0,
      statuses: 0,
    })
  })

  test('persists and recovers fee, partial-fill, and nonzero cash-yield evidence', async () => {
    const protocol: Protocol = {
      ...fixtureProtocol,
      executionModel: {
        ...fixtureProtocol.executionModel,
        cash: { ...fixtureProtocol.executionModel.cash, annualYieldBps: 500 },
      },
    }
    const input = makeInput('a'.repeat(40), 'c'.repeat(64), protocol)
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        yield* store.persist(input)
        return {
          stored: yield* store.read(input.evaluation.runId),
          recovered: yield* store.recover(input.evaluation.runId, input.provenance),
        }
      }),
    )

    expect(Option.isSome(result.stored)).toBe(true)
    expect(Option.isSome(result.recovered)).toBe(true)
    if (Option.isNone(result.stored) || Option.isNone(result.recovered)) throw new Error('evidence is missing')
    expect(result.stored.value.events.some((event) => event.kind === 'fee')).toBe(true)
    expect(result.stored.value.events.some((event) => event.kind === 'cash-yield')).toBe(true)
    expect(input.evaluation.simulation.orders.some((order) => order.status === 'partially-filled')).toBe(true)
    expect(result.recovered.value.evaluation.strategy.totalCashYieldMicros).toBe(
      input.evaluation.strategy.totalCashYieldMicros,
    )
    expect(result.recovered.value.evaluation.markedEquityReconciliation.exact).toBe(true)
  })

  test('burns observed runs and preserves qualification state as append-only', async () => {
    const input = makeInput()
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        const sql = yield* PgClient.PgClient
        yield* store.persist(input)

        const lock = makeLockedInput(input, [input.evaluation.runId]).lock

        yield* sql`
          INSERT INTO qualification_locks (
            lock_id,
            schema_version,
            candidate_run_id,
            protocol_hash,
            snapshot_id,
            source_revision,
            image_repository,
            image_digest,
            payload
          ) VALUES (
            ${lock.lockId},
            ${lock.schemaVersion},
            ${lock.candidateRunId},
            ${lock.protocolHash},
            ${lock.data.snapshotId},
            ${lock.sourceRevision},
            ${lock.image.repository},
            ${lock.image.digest},
            ${sql.json(lock)}
          )
        `

        const trials = yield* sql<{
          run_id: string
          disposition: string
          prelock_observed: boolean
          failed_benchmark: boolean
        }>`
          SELECT
            run_id,
            disposition,
            'PRE_LOCK_RESULT_OBSERVED' = ANY(reason_codes) AS prelock_observed,
            'FAILED_BENCHMARK_GATE' = ANY(reason_codes) AS failed_benchmark
          FROM qualification_trials
        `
        const locks = yield* sql<{ lock_id: string; payload: unknown }>`
          SELECT lock_id, payload FROM qualification_locks
        `
        const results = yield* sql<{ count: number }>`
          SELECT count(*)::integer AS count FROM qualification_results
        `
        const trialUpdate = yield* Effect.exit(sql`
          UPDATE qualification_trials SET disposition = 'BURNED' WHERE run_id = ${input.evaluation.runId}
        `)
        const trialDelete = yield* Effect.exit(sql`
          DELETE FROM qualification_trials WHERE run_id = ${input.evaluation.runId}
        `)
        const lockUpdate = yield* Effect.exit(sql`
          UPDATE qualification_locks SET payload = payload WHERE lock_id = ${lock.lockId}
        `)
        const lockDelete = yield* Effect.exit(sql`
          DELETE FROM qualification_locks WHERE lock_id = ${lock.lockId}
        `)
        const divergentLock = yield* Effect.exit(sql`
          INSERT INTO qualification_locks (
            lock_id,
            schema_version,
            candidate_run_id,
            protocol_hash,
            snapshot_id,
            source_revision,
            image_repository,
            image_digest,
            payload
          ) VALUES (
            ${'f'.repeat(64)},
            ${lock.schemaVersion},
            ${lock.candidateRunId},
            ${lock.protocolHash},
            ${lock.data.snapshotId},
            ${lock.sourceRevision},
            ${lock.image.repository},
            ${lock.image.digest},
            ${sql.json(lock)}
          )
        `)
        return { lock, locks, results, trials, trialUpdate, trialDelete, lockUpdate, lockDelete, divergentLock }
      }),
    )

    expect(result.trials).toEqual([
      {
        run_id: input.evaluation.runId,
        disposition: 'BURNED',
        prelock_observed: true,
        failed_benchmark: !input.evaluation.verdict.gates.find((gate) => gate.name === 'benchmark_sharpe_improvement')!
          .passed,
      },
    ])
    expect(result.locks).toEqual([{ lock_id: result.lock.lockId, payload: result.lock }])
    expect(result.results).toEqual([{ count: 0 }])
    expect(Exit.isFailure(result.trialUpdate)).toBe(true)
    expect(Exit.isFailure(result.trialDelete)).toBe(true)
    expect(Exit.isFailure(result.lockUpdate)).toBe(true)
    expect(Exit.isFailure(result.lockDelete)).toBe(true)
    expect(Exit.isFailure(result.divergentLock)).toBe(true)
  })

  test('reads and recovers the complete current evidence contract without evaluating it again', async () => {
    const input = makeInput()
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        yield* store.persist(input)
        const stored = yield* store.read(input.evaluation.runId)
        const recovered = yield* store.recover(input.evaluation.runId, input.provenance)
        const missing = yield* store.read('f'.repeat(64))
        return { stored, recovered, missing }
      }),
    )

    expect(Option.isSome(result.stored)).toBe(true)
    if (Option.isSome(result.stored)) {
      expect(result.stored.value.protocol).toMatchObject({
        protocolHash: input.evaluation.protocolHash,
        schemaVersion: fixtureProtocol.schemaVersion,
        strategyName: 'risk-balanced-trend',
        behaviorHash: input.provenance.strategy.behaviorHash,
        parameterHash: input.provenance.strategy.parameterHash,
        parameters: fixtureProtocol,
      })
      expect(result.stored.value.run).toMatchObject({
        runId: input.evaluation.runId,
        evaluationSchemaVersion: 'bayn.evaluation.v6',
        artifactCount: 17,
        eventCount: input.evaluation.events.length,
      })
      expect(result.stored.value.artifacts.map((artifact) => artifact.name)).toEqual([
        'buy-and-hold',
        'buy-and-hold-series',
        'cash-changes',
        'daily-position-marks',
        'direct-volatility-timing',
        'direct-volatility-timing-series',
        'double-cost-strategy',
        'double-cost-strategy-series',
        'equity-series',
        'evaluation-summary',
        'input-manifest',
        'marked-equity-reconciliation',
        'qualification-artifact-manifest',
        'reconciliation',
        'risk-balanced-trend-decisions',
        'simulated-orders',
        'strategy',
      ])
      const manifest = result.stored.value.artifacts.find(
        (artifact) => artifact.name === 'qualification-artifact-manifest',
      )
      if (manifest === undefined) throw new Error('qualification artifact manifest is missing')
      expect(manifest.payload).toMatchObject({
        schemaVersion: 'bayn.qualification-artifact-manifest.v1',
        identity: {
          runId: input.evaluation.runId,
          protocolHash: input.evaluation.protocolHash,
          snapshotId: input.evaluation.inputManifest.finalizedSnapshot.snapshotId,
          sourceRevision: input.provenance.sourceRevision,
          image: input.provenance.image,
        },
        events: { count: input.evaluation.events.length },
        gates: { count: input.evaluation.verdict.gates.length },
      })
      expect(canonicalHashV1(manifest.payload)).toBe(manifest.contentHash)
    }
    expect(Option.isSome(result.recovered)).toBe(true)
    if (Option.isSome(result.recovered)) {
      expect(result.recovered.value).toMatchObject({
        evaluation: {
          runId: input.evaluation.runId,
          markedEquityReconciliation: { withinTolerance: true },
        },
        reconciliation: { runId: input.evaluation.runId, exact: true },
        persistence: { runId: input.evaluation.runId, deduplicated: true, artifactCount: 17 },
      })
    }
    expect(Option.isNone(result.missing)).toBe(true)
  })

  test('persists and recovers the complete risk-balanced trend v6 evidence contract', async () => {
    const input = makeInput()
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        const receipt = yield* store.persist(input)
        const stored = yield* store.read(input.evaluation.runId)
        const recovered = yield* store.recover(input.evaluation.runId, input.provenance)
        return { receipt, stored, recovered }
      }),
    )

    expect(result.receipt).toMatchObject({ runId: input.evaluation.runId, artifactCount: 17 })
    expect(Option.isSome(result.stored)).toBe(true)
    if (Option.isSome(result.stored)) {
      expect(result.stored.value.protocol).toMatchObject({
        strategyName: 'risk-balanced-trend',
        schemaVersion: 'bayn.risk-balanced-trend.protocol.v2',
        parameters: fixtureProtocol,
      })
      expect(result.stored.value.run).toMatchObject({
        evaluationSchemaVersion: 'bayn.evaluation.v6',
        artifactCount: 17,
      })
      expect(result.stored.value.artifacts.map((artifact) => artifact.name)).toContain('risk-balanced-trend-decisions')
      expect(result.stored.value.artifacts.find((artifact) => artifact.name === 'evaluation-summary')).toMatchObject({
        schemaVersion: 'bayn.evaluation-summary.v5',
      })
    }
    expect(Option.isSome(result.recovered)).toBe(true)
    if (Option.isSome(result.recovered)) {
      expect(result.recovered.value).toMatchObject({
        evaluation: {
          schemaVersion: 'bayn.evaluation-summary.v5',
          evaluationSchemaVersion: 'bayn.evaluation.v6',
          runId: input.evaluation.runId,
        },
        reconciliation: { runId: input.evaluation.runId, exact: true },
        persistence: { runId: input.evaluation.runId, deduplicated: true, artifactCount: 17 },
      })
    }
  })

  test('retrieves ordered artifact items through bounded contiguous pages', async () => {
    const input = makeInput()
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        yield* store.persist(input)
        const items: unknown[] = []
        const pageSizes: number[] = []
        let afterOrdinal = -1
        let contentHash = ''
        while (true) {
          const page = yield* store.readArtifactItems({
            runId: input.evaluation.runId,
            artifactName: 'daily-position-marks',
            afterOrdinal,
            limit: 31,
          })
          if (Option.isNone(page)) throw new Error('daily-position-marks page is missing')
          contentHash = page.value.contentHash
          pageSizes.push(page.value.items.length)
          items.push(...page.value.items.map((item) => item.payload))
          if (page.value.nextAfterOrdinal === null) break
          afterOrdinal = page.value.nextAfterOrdinal
        }
        const scalar = yield* store.readArtifactItems({
          runId: input.evaluation.runId,
          artifactName: 'strategy',
          limit: 1,
        })
        const invalidLimit = yield* store
          .readArtifactItems({
            runId: input.evaluation.runId,
            artifactName: 'daily-position-marks',
            limit: 257,
          })
          .pipe(Effect.flip)
        return { contentHash, invalidLimit, items, pageSizes, scalar }
      }),
    )

    expect(result.items).toEqual([...input.evaluation.simulation.dailyMarks])
    expect(result.contentHash).toBe(
      canonicalHashV1({
        schemaVersion: 'bayn.daily-position-marks.v3',
        items: input.evaluation.simulation.dailyMarks,
      }),
    )
    expect(result.pageSizes.length).toBeGreaterThan(2)
    expect(result.pageSizes.every((size) => size > 0 && size <= 31)).toBe(true)
    expect(Option.isNone(result.scalar)).toBe(true)
    expect(result.invalidLimit).toMatchObject({
      failure: 'invariant',
      operation: 'read-artifact-items',
    })
  })

  test('rejects a simulation whose declared costs diverge from its locked protocol', async () => {
    const input = makeInput()
    const error = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        return yield* store
          .persist({
            ...input,
            evaluation: {
              ...input.evaluation,
              simulation: {
                ...input.evaluation.simulation,
                executionModel: {
                  ...input.evaluation.simulation.executionModel,
                  priceImpact: {
                    ...input.evaluation.simulation.executionModel.priceImpact,
                    slippageBps: input.evaluation.simulation.executionModel.priceImpact.slippageBps + 1,
                  },
                },
              },
            },
          })
          .pipe(Effect.flip)
      }),
    )

    expect(error).toBeInstanceOf(DatabaseError)
    expect(error.failure).toBe('invariant')
    expect(error.operation).toBe('plan')
    expect(error.message).toContain('simulation execution model does not match')
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

  test('locks strategy behavior and parameters under a composite protocol identity', async () => {
    const first = makeInput('a'.repeat(40), 'c'.repeat(64))
    const second = makeInput('a'.repeat(40), 'd'.repeat(64))
    const protocols = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        const sql = yield* PgClient.PgClient
        yield* store.persist(first)
        yield* store.persist(second)
        return yield* sql<{ protocol_hash: string; behavior_hash: string; parameter_hash: string }>`
          SELECT protocol_hash, behavior_hash, parameter_hash
          FROM protocol_locks
          ORDER BY behavior_hash
        `
      }),
    )

    expect(first.evaluation.protocolHash).not.toBe(second.evaluation.protocolHash)
    expect(protocols).toEqual([
      {
        protocol_hash: first.evaluation.protocolHash,
        behavior_hash: first.provenance.strategy.behaviorHash,
        parameter_hash: first.provenance.strategy.parameterHash,
      },
      {
        protocol_hash: second.evaluation.protocolHash,
        behavior_hash: second.provenance.strategy.behaviorHash,
        parameter_hash: second.provenance.strategy.parameterHash,
      },
    ])
  })

  test('rejects updates and deletes across the completed evidence graph', async () => {
    const input = makeInput()
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* EvidenceStore
        const sql = yield* PgClient.PgClient
        yield* store.persist(input)
        const artifactUpdate = yield* Effect.exit(sql`
          UPDATE evaluation_artifacts
          SET payload = ${sql.json({ corrupted: true })}
          WHERE run_id = ${input.evaluation.runId} AND artifact_name = 'strategy'
        `)
        const snapshotUpdate = yield* Effect.exit(sql`
          UPDATE snapshot_references
          SET first_session = first_session + 1
          WHERE snapshot_id = ${input.evaluation.inputManifest.finalizedSnapshot.snapshotId}
        `)
        const runUpdate = yield* Effect.exit(sql`
          UPDATE evaluation_runs
          SET initial_capital_micros = initial_capital_micros + 1
          WHERE run_id = ${input.evaluation.runId}
        `)
        const statusUpdate = yield* Effect.exit(sql`
          UPDATE status_history
          SET detail = ${sql.json({ corrupted: true })}
          WHERE run_id = ${input.evaluation.runId} AND status = 'COMPLETE'
        `)
        const eventDelete = yield* Effect.exit(sql`
          DELETE FROM evaluation_events WHERE run_id = ${input.evaluation.runId}
        `)
        const gateDelete = yield* Effect.exit(sql`
          DELETE FROM gate_outcomes WHERE run_id = ${input.evaluation.runId}
        `)
        const protocolDelete = yield* Effect.exit(sql`
          DELETE FROM protocol_locks WHERE protocol_hash = ${input.evaluation.protocolHash}
        `)
        const runDelete = yield* Effect.exit(sql`
          DELETE FROM evaluation_runs WHERE run_id = ${input.evaluation.runId}
        `)
        const read = yield* store.read(input.evaluation.runId)
        return {
          exits: [
            artifactUpdate,
            snapshotUpdate,
            runUpdate,
            statusUpdate,
            eventDelete,
            gateDelete,
            protocolDelete,
            runDelete,
          ],
          read,
        }
      }),
    )

    expect(result.exits.every(Exit.isFailure)).toBe(true)
    expect(Option.isSome(result.read)).toBe(true)
  })

  test('rejects truncation of evidence and qualification tables', async () => {
    const exits = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return yield* Effect.forEach(
          [
            sql`TRUNCATE evaluation_runs CASCADE`,
            sql`TRUNCATE evaluation_artifacts`,
            sql`TRUNCATE qualification_trials`,
            sql`TRUNCATE qualification_locks CASCADE`,
            sql`TRUNCATE qualification_results`,
          ],
          Effect.exit,
        )
      }),
    )

    expect(exits.every(Exit.isFailure)).toBe(true)
  })

  test('rolls back every table when a terminal evidence constraint fails', async () => {
    const input = makeInput()
    const invalid: PersistEvaluationInput = {
      ...input,
      evaluation: {
        ...input.evaluation,
        verdict: {
          ...input.evaluation.verdict,
          gates: input.evaluation.verdict.gates.map((gate, index) => (index === 0 ? { ...gate, name: '' } : gate)),
        },
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
            (SELECT count(*)::integer FROM evaluation_runs) AS runs,
            (SELECT count(*)::integer FROM protocol_locks) AS protocols,
            (SELECT count(*)::integer FROM snapshot_references) AS snapshots,
            (SELECT count(*)::integer FROM evaluation_events) AS events
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
