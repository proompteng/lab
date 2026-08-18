import assert from 'node:assert/strict'

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import {
  Cause,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Redacted,
  Result,
  Schema,
} from 'effect'

import type { RuntimeConfig } from '../config'
import {
  executionObserveSuccessorGenerationHash,
  recoverTerminalGenerationToObserve,
} from '../blocked-generation-recovery'
import { orderRequestBody } from '../broker/alpaca-mutations'
import { makeStrategyProtocolHash } from '../contracts.test-support'
import { operationalError } from '../errors'
import { BrokerAccess, BrokerEnvironment, noCapitalAuthority, grantedCapitalAuthority } from '../execution/authority'
import { WriterFence, WriterFenceError, WriterFenceLive, type WriterFenceService } from '../execution/writer-fence'
import { canonicalHashV1 } from '../hash'
import { hashLedgerPlanResult } from '../ledger-plan'
import { Journal, type JournalService } from '../ledger'
import {
  AccountStatus,
  Authority,
  Broker,
  DiscrepancyKind,
  KillState,
  OrderSide,
  OrderStatus,
  OrderType,
  ReconciliationStatus,
  TimeInForce,
  makeCapitalGrantGenerationResult,
  makeResearchCapitalGrantGenerationResult,
  type CapitalGrantGeneration,
  type ResearchCapitalGrantGeneration,
} from '../execution/contracts'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import {
  defaultQualificationStatisticsPolicyDocument,
  makeQualificationLock,
  makeQualificationPolicyDocument,
  makeQualificationResult,
  type QualificationLock,
  type QualificationResult,
} from '../qualification'
import {
  analyzeQualification,
  defaultQualificationStatisticsPolicy,
  type QualificationSeries,
} from '../qualification-statistics'
import { fixtureProtocol } from '../test-fixtures'
import {
  sourceTimestamp,
  type BrokerEventInput,
  type FillEventInput,
  type PositionEventInput,
  type PositionSnapshotInput,
  type ValuationInput,
} from '../broker/observations'
import { BrokerProvider, alpacaSandboxBaseUrl } from '../broker/alpaca'
import { makeBrokerIdentity, type BrokerIdentity } from '../broker/identity'
import { incompletePassReason } from '../simulation-reconciliation/broker-reconciler-model'
import {
  executionActivationExpiredRestrictionReason,
  executionMandateCompletedRestrictionReason,
  executionMandateFailureRestrictionPrefix,
  legacyV1CompletedRestrictionReason,
} from '../execution/mandate'
import {
  BlockedCycleIntentStore,
  BlockedCycleIntentStoreLive,
  type BlockedCycleIntentStoreShape,
} from '../execution/intents'
import { EvidenceStore, EvidenceStoreFromPostgres, PostgresClientLive } from './evidence-store'
import {
  BrokerEventStore,
  AuthorityGenerationStore,
  AuthorityRestrictionStore,
  CapitalGrantLifecycleStore,
  ExecutionStoreError,
  ExecutionStoreLive,
  FillAccountingStore,
  ReconciliationStore,
  ValuationStore,
} from './execution-store'
import { LEGACY_AUTONOMOUS_OBSERVE_GENERATION_HASH } from './execution-store/observe-authority'

const ExecutionStore = Effect.gen(function* () {
  const events = yield* BrokerEventStore
  const accounting = yield* FillAccountingStore
  const valuation = yield* ValuationStore
  const reconciliation = yield* ReconciliationStore
  const authorityGeneration = yield* AuthorityGenerationStore
  const capitalGrantLifecycle = yield* CapitalGrantLifecycleStore
  const authorityRestriction = yield* AuthorityRestrictionStore
  return {
    ...events,
    ...accounting,
    ...valuation,
    ...reconciliation,
    ...authorityGeneration,
    ...capitalGrantLifecycle,
    ...authorityRestriction,
  }
})

const encodeSqlJson = Schema.encodeSync(Schema.UnknownFromJsonString)
const postgresUrl = baynTestPostgresUrl
const testUrl = postgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = postgresUrl === undefined ? describe.skip : describe
const accountId = 'paper-account-1'

const successOfResult = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result), 'fixture Result must succeed')
  return result.success
}
const makeCapitalGrantGeneration = (input: Parameters<typeof makeCapitalGrantGenerationResult>[0]) =>
  successOfResult(makeCapitalGrantGenerationResult(input))
const makeResearchCapitalGrantGeneration = (input: Parameters<typeof makeResearchCapitalGrantGenerationResult>[0]) =>
  successOfResult(makeResearchCapitalGrantGenerationResult(input))
const observedAt = '2026-07-22T15:30:01.000Z'
const occurredAt = '2026-07-22T15:30:00.000Z'
const hash = (value: string): string => canonicalHashV1({ value })
const qualifiedSourceRevision = '1'.repeat(40)
const qualifiedImageRepository = 'registry.example.test/lab/bayn'
const qualifiedImageDigest = `sha256:${'2'.repeat(64)}` as const
const qualifiedStrategyBehaviorHash = hash('qualified-strategy-behavior')
const qualifiedStrategyParameterHash = canonicalHashV1(fixtureProtocol)
const qualifiedProtocolHash = makeStrategyProtocolHash({
  name: 'risk-balanced-trend',
  behaviorHash: qualifiedStrategyBehaviorHash,
  parameterHash: qualifiedStrategyParameterHash,
  parameterSchemaVersion: fixtureProtocol.schemaVersion,
})
const sandboxBrokerIdentity = (brokerAccountId: string) =>
  Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      accountId: brokerAccountId,
    }),
  )

const brokerIdentity = <Environment extends BrokerEnvironment>(environment: Environment, brokerAccountId: string) =>
  Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment,
      accountId: brokerAccountId,
    }),
  )

const observeConfigWithIdentity = (identity: BrokerIdentity): RuntimeConfig => ({
  ...config,
  execution: {
    brokerIdentity: identity,
    brokerAccess: BrokerAccess.ReadOnly,
    capitalAuthority: noCapitalAuthority,
  },
})

const qualificationPolicy = (name: string) =>
  successOfResult(
    makeQualificationPolicyDocument(`bayn.${name}.v1`, {
      schemaVersion: `bayn.${name}.v1`,
      enabled: true,
    }),
  )

const qualificationSeries = (runId: string): QualificationSeries => {
  const sessionDate = (index: number): `${number}-${number}-${number}` =>
    DateTime.makeUnsafe('2000-01-01T00:00:00.000Z').pipe(
      DateTime.add({ days: index }),
      DateTime.formatIsoDate,
    ) as `${number}-${number}-${number}`
  const blockCount = 90
  return {
    schemaVersion: 'bayn.qualification-series.v1',
    runId,
    observations: Array.from({ length: blockCount * 21 + 10 }, (_, index) => {
      const noise = (((index * 17) % 23) - 11) / 100_000
      return {
        sessionDate: sessionDate(index),
        strategyReturn: 0.0005 + noise,
        cashReturn: 0,
        buyAndHoldReturn: 0.00015 + noise * 1.1,
        directVolatilityReturn: 0.0001 + noise * 0.8,
      }
    }),
    rebalanceExecutionDates: Array.from({ length: blockCount + 1 }, (_, index) => sessionDate(index * 21)),
  }
}

interface QualificationFixture {
  readonly lock: QualificationLock
  readonly result: QualificationResult
}

const makeQualificationFixture = (name: string, qualified: boolean): QualificationFixture => {
  const runId = hash(`${name}-run`)
  const snapshotId = hash(`${name}-snapshot`)
  const lock = successOfResult(
    makeQualificationLock({
      schemaVersion: 'bayn.qualification-lock.v3',
      candidateRunId: runId,
      protocolHash: qualifiedProtocolHash,
      sourceRevision: qualifiedSourceRevision,
      image: {
        repository: qualifiedImageRepository,
        digest: qualifiedImageDigest,
      },
      universeId: fixtureProtocol.universeId,
      universeSymbolHash: fixtureProtocol.universeSymbolHash,
      universe: fixtureProtocol.universe,
      universeRationale: 'Precommitted cross-asset universe for the authority activation persistence test.',
      data: {
        snapshotId,
        publicationId: hash(`${name}-publication`),
        inputManifestHash: hash(`${name}-manifest`),
        contentHash: hash(`${name}-content`),
        sessionsContentHash: hash(`${name}-sessions`),
        provider: 'alpaca',
        sourceFeed: 'sip',
        adjustment: 'all',
        calendarVersion: 'alpaca-us-equity-calendar-v1',
        firstSession: '2016-01-04',
        lastSession: '2026-07-21',
        selectedSessionCount: 1_900,
        selectedRebalanceCount: 91,
        bounds: {
          schemaVersion: 'bayn.evaluation-bounds.v1',
          dataStart: '2016-01-04',
          dataEnd: '2026-07-21',
          lookbackStart: '2016-01-04',
          evaluationStart: '2017-01-03',
          evaluationEnd: '2026-07-21',
        },
      },
      policies: {
        benchmark: qualificationPolicy(`${name}-benchmark-policy`),
        thresholds: qualificationPolicy(`${name}-threshold-policy`),
        uncertainty: successOfResult(defaultQualificationStatisticsPolicyDocument),
        execution: successOfResult(
          makeQualificationPolicyDocument(fixtureProtocol.executionModel.schemaVersion, fixtureProtocol.executionModel),
        ),
      },
      priorTrialRunIds: [],
    }),
  )
  const analysis = successOfResult(
    analyzeQualification(qualificationSeries(runId), defaultQualificationStatisticsPolicy, []),
  )
  const evaluationVerdict = qualified
    ? {
        status: 'PASS' as const,
        gates: [{ name: 'paper_activation_fixture', passed: true, actual: 1, required: 1 }],
      }
    : {
        status: 'FAIL_CLOSED' as const,
        gates: [{ name: 'paper_activation_fixture', passed: false, actual: 0, required: 1 }],
      }
  return {
    lock,
    result: successOfResult(makeQualificationResult(lock, evaluationVerdict, analysis)),
  }
}

const qualifiedEvidence = makeQualificationFixture('qualified-authority', true)
const rejectedEvidence = makeQualificationFixture('rejected-authority', false)

interface ReconciliationFixture {
  readonly reconciliationId: string
  readonly contentHash: string
  readonly databaseAgeMs: number
}

const exactReconciliation = (name: string, databaseAgeMs = 0): ReconciliationFixture => ({
  reconciliationId: hash(`${name}-reconciliation`),
  contentHash: hash(`${name}-reconciliation-content`),
  databaseAgeMs,
})

const config: RuntimeConfig = {
  host: '127.0.0.1',
  port: 8080,
  execution: {
    brokerIdentity: sandboxBrokerIdentity(accountId),
    brokerAccess: BrokerAccess.ReadOnly,
    capitalAuthority: noCapitalAuthority,
  },
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
  cycleStallThresholdMs: 300_000,
  reconciliationStaleThresholdMs: 120_000,
  unknownMutationThresholdMs: 300_000,
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
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
  tigerBeetle: { clusterId: 2_001n, replicaAddresses: ['127.0.0.1:3000'], ledger: 7_001 },
}

interface JournalControl {
  fail: boolean
  readonly planHashes: string[]
}

const journal = (control: JournalControl): JournalService => ({
  post: (plan) =>
    Effect.suspend(() => {
      control.planHashes.push(successOfResult(hashLedgerPlanResult(plan)))
      return control.fail
        ? Effect.fail(
            operationalError({ component: 'journal', operation: 'post', message: 'injected TigerBeetle failure' }),
          )
        : Effect.void
    }),
  verifyAccount: () => Effect.succeed(true),
  journalAndReconcile: () => Effect.die(new Error('unexpected simulation journal call')),
  check: Effect.void,
  checkRun: () => Effect.void,
})

const makeStoreRuntime = (control: JournalControl, runtimeConfig: RuntimeConfig = config) =>
  ManagedRuntime.make(
    Layer.mergeAll(ExecutionStoreLive(runtimeConfig), BlockedCycleIntentStoreLive).pipe(
      Layer.provideMerge(WriterFenceLive),
      Layer.provideMerge(Layer.succeed(Journal, journal(control))),
      Layer.provideMerge(PostgresClientLive(runtimeConfig)),
      Layer.provide(NodeServices.layer),
    ),
  )

type TestTransactionBoundary =
  | { readonly _tag: 'Return' }
  | { readonly _tag: 'DieAfterBody'; readonly defect: unknown }
  | { readonly _tag: 'InterruptAfterBody' }

// Keep a real SQL transaction while bypassing the process-wide writer lease so independent runtimes exercise
// ExecutionStore's database authority locks, rollback, and Effect exit channels directly.
const testTransactionFenceLive = (boundary: TestTransactionBoundary) =>
  Layer.effect(
    WriterFence,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const [backend] = yield* sql<{ backend_pid: number }>`
        SELECT pg_backend_pid()::integer AS backend_pid
      `
      if (backend === undefined) {
        return yield* Effect.die(new Error('test transaction fence could not identify its PostgreSQL backend'))
      }
      const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
        const bounded =
          boundary._tag === 'Return'
            ? effect
            : effect.pipe(
                Effect.flatMap(() =>
                  boundary._tag === 'DieAfterBody' ? Effect.die(boundary.defect) : Effect.interrupt,
                ),
              )
        return sql.withTransaction(bounded).pipe(
          Effect.catchTag('SqlError', (cause) =>
            Effect.fail(
              new WriterFenceError({
                failure: 'unavailable',
                operation: 'transaction',
                message: 'test PostgreSQL transaction fence failed',
                cause,
              }),
            ),
          ),
        )
      }
      return {
        backendPid: backend.backend_pid,
        check: Effect.void,
        transaction,
      } satisfies WriterFenceService
    }),
  )

const makeIndependentStoreRuntime = (
  control: JournalControl,
  runtimeConfig: RuntimeConfig,
  boundary: TestTransactionBoundary = { _tag: 'Return' },
) =>
  ManagedRuntime.make(
    ExecutionStoreLive(runtimeConfig).pipe(
      Layer.provideMerge(testTransactionFenceLive(boundary)),
      Layer.provideMerge(Layer.succeed(Journal, journal(control))),
      Layer.provideMerge(PostgresClientLive(runtimeConfig)),
      Layer.provide(NodeServices.layer),
    ),
  )

const makeClientRuntime = () => ManagedRuntime.make(PostgresClientLive(config).pipe(Layer.provide(NodeServices.layer)))

const makeEvidenceRuntime = () =>
  ManagedRuntime.make(
    EvidenceStoreFromPostgres(config).pipe(
      Layer.provideMerge(PostgresClientLive(config)),
      Layer.provide(NodeServices.layer),
    ),
  )

interface AuthorityTupleRow {
  readonly row: Readonly<Record<string, unknown>>
  readonly tupleId: string
}

const readAuthorityTupleEvidence = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const [evidence] = yield* sql<{
    authority: readonly AuthorityTupleRow[] | null
    history: readonly AuthorityTupleRow[] | null
  }>`
    SELECT
      (
        SELECT jsonb_agg(
          jsonb_build_object('row', to_jsonb(authority), 'tupleId', authority.xmin::text)
        )
        FROM authority_state AS authority
      ) AS authority,
      (
        SELECT jsonb_agg(
          jsonb_build_object('row', to_jsonb(history), 'tupleId', history.xmin::text)
          ORDER BY history.authority_version
        )
        FROM authority_generations AS history
      ) AS history
  `
  return evidence
})

const seedQualificationEvidence = (fixture: QualificationFixture) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const { lock, result } = fixture
    yield* sql`
      INSERT INTO protocol_locks (
        protocol_hash, schema_version, strategy_name, behavior_hash, parameter_hash, parameters
      ) VALUES (
        ${lock.protocolHash}, ${fixtureProtocol.schemaVersion}, 'risk-balanced-trend',
        ${qualifiedStrategyBehaviorHash}, ${qualifiedStrategyParameterHash}, ${sql.json(fixtureProtocol)}
      )
      ON CONFLICT (protocol_hash) DO NOTHING
    `
    yield* sql`
      INSERT INTO snapshot_references (
        snapshot_id, schema_version, database_name, table_name, dataset_version, source,
        source_feed, adjustment, content_hash, row_count, first_session, last_session, manifest
      ) VALUES (
        ${lock.data.snapshotId}, 'bayn.finalized-snapshot.v3', 'signal', 'adjusted_daily_bars_v2',
        'signal.adjusted-daily-snapshot.v2', 'alpaca', 'sip', 'all', ${lock.data.contentHash},
        ${lock.data.selectedSessionCount * lock.universe.length}, ${lock.data.firstSession},
        ${lock.data.lastSession}, ${sql.json(lock.data)}
      )
    `
    yield* sql`
      INSERT INTO evaluation_runs (
        run_id, protocol_hash, snapshot_id, evaluation_schema_version, source_revision,
        image_repository, image_digest, strategy_name, initial_capital_micros,
        expected_artifact_count, expected_event_count, expected_gate_count,
        status, completed_at
      ) VALUES (
        ${result.runId}, ${lock.protocolHash}, ${lock.data.snapshotId}, 'bayn.evaluation.v6',
        ${lock.sourceRevision}, ${lock.image.repository}, ${lock.image.digest}, 'risk-balanced-trend',
        1000000000000, 1, 0, 1, 'COMPLETE', clock_timestamp()
      )
    `
    yield* sql`
      INSERT INTO evaluation_artifacts (
        run_id, artifact_name, schema_version, content_hash, payload
      ) VALUES (
        ${result.runId}, 'qualification-artifact-manifest', 'bayn.qualification-artifact-manifest.v1',
        ${hash(`${result.runId}-artifact`)}, ${sql.json({ runId: result.runId })}
      )
    `
    yield* sql`
      INSERT INTO gate_outcomes (
        run_id, ordinal, gate_name, passed, actual, required, content_hash
      ) VALUES (
        ${result.runId}, 0, 'paper_activation_fixture',
        ${result.evaluationVerdict.gates[0].passed},
        ${sql.json(encodeSqlJson(result.evaluationVerdict.gates[0].actual))},
        ${sql.json(encodeSqlJson(result.evaluationVerdict.gates[0].required))},
        ${hash(`${result.runId}-gate`)}
      )
    `
    yield* sql`
      INSERT INTO status_history (run_id, status, detail)
      VALUES
        (
          ${result.runId}, 'WRITING',
          ${sql.json({ artifactCount: 1, eventCount: 0, gateCount: 1 })}
        ),
        (
          ${result.runId}, 'COMPLETE',
          ${sql.json({ reconciliationExact: true, verdict: result.evaluationVerdict.status })}
        )
    `
    yield* sql`
      INSERT INTO qualification_locks (
        lock_id, schema_version, candidate_run_id, protocol_hash, snapshot_id,
        source_revision, image_repository, image_digest, payload
      ) VALUES (
        ${lock.lockId}, ${lock.schemaVersion}, ${lock.candidateRunId}, ${lock.protocolHash},
        ${lock.data.snapshotId}, ${lock.sourceRevision}, ${lock.image.repository},
        ${lock.image.digest}, ${sql.json(lock)}
      )
    `
    yield* sql`
      INSERT INTO qualification_results (
        lock_id, schema_version, run_id, verdict, analysis_hash, result_hash, payload
      ) VALUES (
        ${result.lockId}, ${result.schemaVersion}, ${result.runId}, ${result.verdict},
        ${result.analysis.analysisHash}, ${result.resultHash}, ${sql.json(result)}
      )
    `
  })

const seedExactReconciliation = (fixture: ReconciliationFixture, reconciliationAccountId = accountId) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const stateHash = hash(`${fixture.reconciliationId}-state`)
    yield* sql`
      INSERT INTO reconciliations (
        reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
        content_hash, status, discrepancies, reconciled_at
      ) VALUES (
        ${fixture.reconciliationId}, 'bayn.paper-reconciliation.v1', ${reconciliationAccountId},
        ${stateHash}, ${stateHash}, ${fixture.contentHash}, 'EXACT', ${sql.json(encodeSqlJson([]))},
        clock_timestamp() - (${fixture.databaseAgeMs} * interval '1 millisecond')
      )
    `
  })

const seedTerminalCanceledMutation = (authorityGenerationHash: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const intentId = hash('terminal-canceled-intent')
    const decisionId = hash('terminal-canceled-risk-decision')
    const submitMutationId = hash('terminal-canceled-submit')
    const cancelMutationId = hash('terminal-canceled-cancel')
    const brokerOrderId = '61e69015-8549-4bfd-b9c3-01e75843f47d'
    yield* sql`
    INSERT INTO intents (
      intent_id, schema_version, authority_generation_hash, account_id, client_order_id, symbol, side,
      order_type, time_in_force, quantity_micros, notional_limit_micros,
      state, terminal_outcome, state_version, created_at, updated_at,
      strategy_name, cycle_id, decision_hash, policy_hash
    ) VALUES (
      ${intentId}, 'bayn.paper-intent.v3', ${authorityGenerationHash}, ${accountId},
      'terminal-canceled-client-order', 'SPY', 'BUY', 'MARKET', 'DAY', 1000000, 100000000,
      'PLANNED', NULL, 1, '2026-07-22T15:30:00.000Z', '2026-07-22T15:30:00.000Z',
      'risk-balanced-trend', ${hash('terminal-canceled-cycle')},
      ${hash('terminal-canceled-decision')}, ${hash('terminal-canceled-policy')}
    )
    `
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
        INSERT INTO risk_decisions (
          decision_id, schema_version, input_hash, intent_id, policy_hash,
          outcome, reason_codes, decided_at, expires_at
        ) VALUES (
          ${decisionId}, 'bayn.paper-risk-decision.v1', ${hash('terminal-canceled-risk-input')}, ${intentId},
          ${hash('terminal-canceled-policy')}, 'APPROVED', ARRAY[]::text[],
          '2026-07-22T15:30:00.001Z', '2099-01-01T00:00:00.000Z'
        )
      `
        yield* sql`
        UPDATE intents
        SET
          risk_decision_id = ${decisionId},
          state = 'APPROVED',
          state_version = 2,
          updated_at = '2026-07-22T15:30:00.002Z'
        WHERE intent_id = ${intentId}
      `
        yield* sql`
        INSERT INTO mutation_events (
          event_id, schema_version, mutation_id, intent_id, sequence, operation,
          event_type, request_hash, consistency_delay_ms, broker_order_id,
          request_id, response_status, response_content_hash, occurred_at
        ) VALUES (
          ${hash('terminal-canceled-submit-started')}, 'bayn.paper-mutation-event.v1',
          ${submitMutationId}, ${intentId}, 1, 'SUBMIT', 'SUBMIT_STARTED',
          ${hash('terminal-canceled-submit-request')}, 1000, NULL,
          NULL, NULL, NULL, '2026-07-22T15:30:01.000Z'
        )
      `
        yield* sql`
        UPDATE intents
        SET state = 'IO_STARTED', state_version = 3, updated_at = '2026-07-22T15:30:01.000Z'
        WHERE intent_id = ${intentId}
      `
        yield* sql`
        INSERT INTO mutation_events (
          event_id, schema_version, mutation_id, intent_id, sequence, operation,
          event_type, request_hash, consistency_delay_ms, broker_order_id,
          request_id, response_status, response_content_hash, occurred_at
        ) VALUES (
          ${hash('terminal-canceled-submit-unknown')}, 'bayn.paper-mutation-event.v1',
          ${submitMutationId}, ${intentId}, 2, 'SUBMIT', 'SUBMIT_UNKNOWN',
          ${hash('terminal-canceled-submit-request')}, 1000, ${brokerOrderId},
          'mismatched-submit', 200, ${hash('terminal-canceled-submit-response')}, '2026-07-22T15:30:02.000Z'
        )
      `
        yield* sql`
        UPDATE intents
        SET state = 'UNKNOWN', state_version = 4, updated_at = '2026-07-22T15:30:02.000Z'
        WHERE intent_id = ${intentId}
      `
        yield* sql`
        INSERT INTO mutation_events (
          event_id, schema_version, mutation_id, intent_id, sequence, operation,
          event_type, request_hash, consistency_delay_ms, broker_order_id,
          request_id, response_status, response_content_hash, occurred_at
        ) VALUES (
          ${hash('terminal-canceled-submit-not-found')}, 'bayn.paper-mutation-event.v1',
          ${submitMutationId}, ${intentId}, 3, 'SUBMIT', 'RECOVERY_NOT_FOUND',
          ${hash('terminal-canceled-submit-request')}, 1000, ${brokerOrderId},
          'submit-not-found', 404, ${hash('terminal-canceled-submit-lookup')}, '2026-07-22T15:30:03.000Z'
        )
      `
        yield* sql`
        INSERT INTO mutation_events (
          event_id, schema_version, mutation_id, intent_id, sequence, operation,
          event_type, request_hash, consistency_delay_ms, broker_order_id,
          request_id, response_status, response_content_hash, occurred_at
        ) VALUES (
          ${hash('terminal-canceled-cancel-started')}, 'bayn.paper-mutation-event.v1',
          ${cancelMutationId}, ${intentId}, 1, 'CANCEL', 'CANCEL_STARTED',
          ${hash('terminal-canceled-cancel-request')}, 1000, ${brokerOrderId},
          NULL, NULL, NULL, '2026-07-22T15:30:04.000Z'
        )
      `
        yield* sql`
        INSERT INTO mutation_events (
          event_id, schema_version, mutation_id, intent_id, sequence, operation,
          event_type, request_hash, consistency_delay_ms, broker_order_id,
          request_id, response_status, response_content_hash, occurred_at
        ) VALUES (
          ${hash('terminal-canceled-cancel-accepted')}, 'bayn.paper-mutation-event.v1',
          ${cancelMutationId}, ${intentId}, 2, 'CANCEL', 'CANCEL_ACCEPTED',
          ${hash('terminal-canceled-cancel-request')}, 1000, ${brokerOrderId},
          'cancel-accepted', 204, ${hash('terminal-canceled-cancel-response')}, '2026-07-22T15:30:05.000Z'
        )
      `
        yield* sql`
        INSERT INTO mutation_events (
          event_id, schema_version, mutation_id, intent_id, sequence, operation,
          event_type, request_hash, consistency_delay_ms, broker_order_id,
          request_id, response_status, response_content_hash, occurred_at
        ) VALUES (
          ${hash('terminal-canceled-cancel-found')}, 'bayn.paper-mutation-event.v1',
          ${cancelMutationId}, ${intentId}, 3, 'CANCEL', 'RECOVERY_FOUND',
          ${hash('terminal-canceled-cancel-request')}, 1000, ${brokerOrderId},
          'cancel-terminal', 200, ${hash('terminal-canceled-cancel-lookup')}, '2026-07-22T15:30:06.000Z'
        )
      `
        yield* sql`
        UPDATE intents
        SET state = 'RECOVERED', state_version = 5, updated_at = '2026-07-22T15:30:06.000Z'
        WHERE intent_id = ${intentId}
      `
        yield* sql`
        UPDATE intents
        SET
          state = 'TERMINAL',
          terminal_outcome = 'CANCELED',
          state_version = 6,
          updated_at = '2026-07-22T15:30:06.000001Z'
        WHERE intent_id = ${intentId}
      `
      }),
    )
  })

const makeActivation = (
  previousGenerationHash: string,
  qualification: QualificationFixture,
  reconciliation: Pick<ReconciliationFixture, 'contentHash' | 'reconciliationId'>,
  overrides: Partial<Parameters<typeof makeCapitalGrantGeneration>[0]> = {},
) =>
  makeCapitalGrantGeneration({
    schemaVersion: 'bayn.paper-authority-generation.v2',
    maximum: Authority.Execution,
    previousGenerationHash,
    qualificationRunId: qualification.result.runId,
    qualificationLockId: qualification.lock.lockId,
    qualificationResultHash: qualification.result.resultHash,
    protocolHash: qualification.lock.protocolHash,
    qualificationExecutionPolicyHash: qualification.lock.policies.execution.contentHash,
    qualificationSourceRevision: qualification.lock.sourceRevision,
    qualificationImageRepository: qualification.lock.image.repository,
    qualificationImageDigest: qualification.lock.image.digest,
    activationSourceRevision: config.build.sourceRevision,
    activationImageRepository: config.build.imageRepository,
    activationImageDigest: config.build.imageDigest,
    strategyName: 'risk-balanced-trend',
    strategyBehaviorHash: qualifiedStrategyBehaviorHash,
    strategyParameterHash: qualifiedStrategyParameterHash,
    strategyParameterSchemaVersion: fixtureProtocol.schemaVersion,
    accountId,
    riskPolicyHash: hash('paper-risk-policy'),
    proofPlanHash: hash('bounded-paper-proof-plan'),
    reconciliationId: reconciliation.reconciliationId,
    reconciliationContentHash: reconciliation.contentHash,
    ...overrides,
  })

const proofBinding = (activation: CapitalGrantGeneration) => ({
  schemaVersion: 'bayn.paper-authority-proof-binding.v1' as const,
  riskPolicyHash: activation.riskPolicyHash,
  proofPlanHash: activation.proofPlanHash,
})

const makeResearchActivation = (
  previousGenerationHash: string,
  reconciliation: Pick<ReconciliationFixture, 'contentHash' | 'reconciliationId'>,
): ResearchCapitalGrantGeneration =>
  makeResearchCapitalGrantGeneration({
    schemaVersion: 'bayn.paper-authority-generation.v3',
    maximum: Authority.Execution,
    previousGenerationHash,
    grant: { _tag: 'Research', planHash: hash('bounded-research-paper-plan') },
    activationSourceRevision: config.build.sourceRevision,
    activationImageRepository: config.build.imageRepository,
    activationImageDigest: config.build.imageDigest,
    strategyName: 'risk-balanced-trend',
    strategyBehaviorHash: config.build.strategyBehaviorHash,
    strategyParameterHash: config.build.strategyParameterHash,
    strategyParameterSchemaVersion: fixtureProtocol.schemaVersion,
    strategyProtocolHash: makeStrategyProtocolHash({
      name: 'risk-balanced-trend',
      behaviorHash: config.build.strategyBehaviorHash,
      parameterHash: config.build.strategyParameterHash,
      parameterSchemaVersion: fixtureProtocol.schemaVersion,
    }),
    accountId,
    brokerIdentityHash: sandboxBrokerIdentity(accountId).identityHash,
    riskPolicyHash: hash('bounded-research-risk-policy'),
    proofPlanHash: hash('bounded-research-paper-plan'),
    reconciliationId: reconciliation.reconciliationId,
    reconciliationContentHash: reconciliation.contentHash,
  })

const researchProofBinding = (activation: ResearchCapitalGrantGeneration) => ({
  schemaVersion: 'bayn.research-paper-grant-proof.v1' as const,
  grant: activation.grant,
  activationSourceRevision: activation.activationSourceRevision,
  activationImageRepository: activation.activationImageRepository,
  activationImageDigest: activation.activationImageDigest,
  strategyName: activation.strategyName,
  strategyBehaviorHash: activation.strategyBehaviorHash,
  strategyParameterHash: activation.strategyParameterHash,
  strategyParameterSchemaVersion: activation.strategyParameterSchemaVersion,
  strategyProtocolHash: activation.strategyProtocolHash,
  accountId: activation.accountId,
  brokerIdentityHash: activation.brokerIdentityHash,
  riskPolicyHash: activation.riskPolicyHash,
  proofPlanHash: activation.proofPlanHash,
})

const paperRuntimeConfig = (
  activation: CapitalGrantGeneration,
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig => ({
  ...config,
  execution: {
    brokerIdentity: sandboxBrokerIdentity(activation.accountId),
    brokerAccess: BrokerAccess.Mutation,
    capitalAuthority: grantedCapitalAuthority(activation.generationHash),
  },
  qualificationRunId: activation.qualificationRunId,
  build: {
    ...config.build,
    strategyBehaviorHash: activation.strategyBehaviorHash,
    strategyParameterHash: activation.strategyParameterHash,
  },
  alpaca: {
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    identity: sandboxBrokerIdentity(activation.accountId),
    baseUrl: alpacaSandboxBaseUrl,
    expectedAccountId: activation.accountId,
    authorityGenerationHash: activation.generationHash,
    key: Redacted.make('unused'),
    secret: Redacted.make('unused'),
    proxyUrl: 'http://bayn-egress-proxy.invalid',
    operationTimeoutMs: config.operationTimeoutMs,
    retryAttempts: 0,
    reconciliationIntervalMs: 30_000,
  },
  ...overrides,
})

const prepareRuntimeConfig = (activation: CapitalGrantGeneration): RuntimeConfig => {
  const runtimeConfig = paperRuntimeConfig(activation)
  const alpaca = runtimeConfig.alpaca
  if (alpaca === undefined) {
    throw new Error('capital grant PREPARE fixture requires an Alpaca binding')
  }
  return {
    ...runtimeConfig,
    execution: {
      brokerIdentity: alpaca.identity,
      brokerAccess: BrokerAccess.ReadOnly,
      capitalAuthority: noCapitalAuthority,
    },
    alpaca: {
      ...alpaca,
      authorityGenerationHash: activation.previousGenerationHash,
    },
  }
}

const researchRuntimeConfig = (sourceGenerationHash: string): RuntimeConfig => {
  const identity = sandboxBrokerIdentity(accountId)
  return {
    ...config,
    execution: {
      brokerIdentity: identity,
      brokerAccess: BrokerAccess.ReadOnly,
      capitalAuthority: noCapitalAuthority,
    },
    alpaca: {
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      identity,
      baseUrl: alpacaSandboxBaseUrl,
      expectedAccountId: accountId,
      authorityGenerationHash: sourceGenerationHash,
      key: Redacted.make('unused'),
      secret: Redacted.make('unused'),
      proxyUrl: 'http://bayn-egress-proxy.invalid',
      operationTimeoutMs: config.operationTimeoutMs,
      retryAttempts: 0,
      reconciliationIntervalMs: 30_000,
    },
  }
}

const makeActivationRuntime = (
  control: JournalControl,
  activation: CapitalGrantGeneration,
  overrides: Partial<RuntimeConfig> = {},
) => makeStoreRuntime(control, paperRuntimeConfig(activation, overrides))

const accountEvent = (eventAccountId = accountId): Extract<BrokerEventInput, { readonly _tag: 'Account' }> => ({
  _tag: 'Account',
  broker: Broker.Alpaca,
  accountId: eventAccountId,
  sourceEventId: 'account-response-1',
  contentHash: hash('account-response-1'),
  occurredAt,
  observedAt,
  account: {
    schemaVersion: 'bayn.paper-account-snapshot.v1',
    accountId: eventAccountId,
    status: AccountStatus.Active,
    currency: 'USD',
    cashMicros: '1000000000',
    equityMicros: '1150000000',
    buyingPowerMicros: '2000000000',
    observedAt,
  },
})

const orderEvent = (): Extract<BrokerEventInput, { readonly _tag: 'Order' }> => ({
  _tag: 'Order',
  broker: Broker.Alpaca,
  accountId,
  sourceEventId: 'order-1:2026-07-22T15:30:00.000Z',
  contentHash: hash('order-1'),
  occurredAt,
  observedAt,
  order: {
    schemaVersion: 'bayn.paper-order.v1',
    accountId,
    brokerOrderId: 'order-1',
    clientOrderId: 'client-order-1',
    symbol: 'NVDA',
    side: OrderSide.Buy,
    orderType: OrderType.Market,
    timeInForce: TimeInForce.Day,
    quantityMicros: '3000000',
    filledQuantityMicros: '0',
    status: OrderStatus.New,
    observedAt,
  },
})

const notionalOrderEvent = (): Extract<BrokerEventInput, { readonly _tag: 'Order' }> => {
  const baseEvent = orderEvent()
  const { quantityMicros: _omittedQuantityMicros, ...baseOrder } = baseEvent.order

  return {
    ...baseEvent,
    sourceEventId: 'order-notional-1:2026-07-22T15:30:00.000Z',
    contentHash: hash('order-notional-1'),
    order: {
      ...baseOrder,
      schemaVersion: 'bayn.paper-order.v2',
      brokerOrderId: 'order-notional-1',
      clientOrderId: 'client-order-notional-1',
      notionalMicros: '300000000',
    },
  }
}

const fillEvent = (
  id: string,
  side: OrderSide,
  quantityMicros: string,
  priceMicros: string,
  eventOccurredAt = occurredAt,
  brokerTimestamp = Result.getOrThrow(sourceTimestamp(eventOccurredAt)),
  eventAccountId = accountId,
  eventObservedAt = observedAt,
): FillEventInput => {
  const fill = {
    schemaVersion: 'bayn.paper-fill.v1' as const,
    accountId: eventAccountId,
    fillId: id,
    brokerOrderId: `order-${id}`,
    clientOrderId: `client-${id}`,
    symbol: 'NVDA',
    side,
    quantityMicros,
    priceMicros,
    feeMicros: '100',
    occurredAt: eventOccurredAt,
  }
  return {
    _tag: 'Fill',
    broker: Broker.Alpaca,
    accountId: eventAccountId,
    sourceEventId: id,
    sourceTimestamp: brokerTimestamp,
    contentHash: canonicalHashV1({
      schemaVersion: 'bayn.paper-fill-source.v1',
      fill,
      brokerTransactionTime: brokerTimestamp,
    }),
    occurredAt: eventOccurredAt,
    observedAt: eventObservedAt,
    fill,
  }
}

const positionEvent = (
  sourceHash: string,
  assetId: string,
  symbol: string,
  quantityMicros: string,
  marketValueMicros: string,
): PositionEventInput => ({
  _tag: 'Position',
  broker: Broker.Alpaca,
  accountId,
  sourceEventId: `position:${sourceHash}:${observedAt}:${assetId}`,
  contentHash: hash(`position:${assetId}`),
  occurredAt: observedAt,
  observedAt,
  position: {
    schemaVersion: 'bayn.paper-position.v1',
    accountId,
    symbol,
    quantityMicros,
    averageEntryPriceMicros: '100000000',
    marketPriceMicros: '100000000',
    marketValueMicros,
    unrealizedPnlMicros: '0',
    observedAt,
  },
})

const positionSnapshotInput = (
  sourceHash: string,
  positions: readonly PositionEventInput[],
  snapshotAccountId = accountId,
  snapshotObservedAt = observedAt,
): PositionSnapshotInput => ({
  accountId: snapshotAccountId,
  sourceHash,
  observedAt: snapshotObservedAt,
  positions,
})

describePostgres('paper accounting persistence', () => {
  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local database whose name ends in _test')
    }
  })

  beforeEach(async () => {
    const client = makeClientRuntime()
    await client.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
      }),
    )
    await client.dispose()

    const migrations = makeEvidenceRuntime()
    await migrations.runPromise(Effect.flatMap(EvidenceStore, (store) => store.check))
    await migrations.dispose()
  }, 15_000)

  test('initializes, exactly replays, and rotates one OBSERVE authority generation', async () => {
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const sql = yield* PgClient.PgClient
          const readOrInitializeObserveAuthority = store.readOrInitializeObserveAuthority
          assert(readOrInitializeObserveAuthority !== undefined, 'OBSERVE authority initialization must be implemented')
          const [databaseBefore] = yield* sql<{ observed_at: Date }>`
            SELECT clock_timestamp() AS observed_at
          `
          const first = yield* readOrInitializeObserveAuthority({
            generationHash: hash('authority-generation-a'),
            maximum: Authority.Observe,
          })
          const [databaseAfter] = yield* sql<{ observed_at: Date }>`
            SELECT clock_timestamp() AS observed_at
          `
          const [beforeReplay] = yield* sql<{ tuple_id: string; version: number }>`
            SELECT xmin::text AS tuple_id, version::integer
            FROM authority_state
          `
          const replay = yield* store.ensureAuthorityGeneration({
            generationHash: hash('authority-generation-a'),
            maximum: Authority.Observe,
          })
          const [afterReplay] = yield* sql<{ tuple_id: string; version: number }>`
            SELECT xmin::text AS tuple_id, version::integer
            FROM authority_state
          `
          const rotated = yield* store.ensureAuthorityGeneration({
            generationHash: hash('authority-generation-b'),
            maximum: Authority.Observe,
          })
          const preserved = yield* readOrInitializeObserveAuthority({
            generationHash: hash('authority-generation-a'),
            maximum: Authority.Observe,
          })
          const [afterRotation] = yield* sql<{ rows: number; tuple_id: string; version: number }>`
            SELECT
              count(*) OVER ()::integer AS rows,
              xmin::text AS tuple_id,
              version::integer
            FROM authority_state
          `
          const historyVersions = yield* sql<{ authority_version: number }>`
            SELECT authority_version::integer
            FROM authority_generations
            ORDER BY authority_version
          `
          return {
            first,
            replay,
            rotated,
            preserved,
            databaseBefore: databaseBefore.observed_at,
            databaseAfter: databaseAfter.observed_at,
            beforeReplay,
            afterReplay,
            afterRotation,
            historyVersions,
          }
        }),
      )

      expect(result.first).toEqual({
        schemaVersion: 'bayn.paper-authority.v1',
        generationHash: hash('authority-generation-a'),
        maximum: Authority.Observe,
        effective: Authority.Observe,
        kill: KillState.Clear,
        version: 1,
        updatedAt: expect.any(String),
      })
      expect(Date.parse(result.first.updatedAt)).toBeGreaterThanOrEqual(result.databaseBefore.getTime())
      expect(Date.parse(result.first.updatedAt)).toBeLessThanOrEqual(result.databaseAfter.getTime())
      expect(result.replay).toEqual(result.first)
      expect(result.afterReplay).toEqual(result.beforeReplay)
      expect(result.rotated).toEqual({
        ...result.first,
        generationHash: hash('authority-generation-b'),
        version: 2,
        updatedAt: expect.any(String),
      })
      expect(Date.parse(result.rotated.updatedAt)).toBeGreaterThan(Date.parse(result.first.updatedAt))
      expect(result.preserved).toEqual(result.rotated)
      expect(result.afterRotation).toMatchObject({ rows: 1, version: 2 })
      expect(result.afterRotation.tuple_id).not.toBe(result.afterReplay.tuple_id)
      expect(result.historyVersions.map(({ authority_version }) => authority_version)).toEqual([1, 2])
      expect(result.historyVersions[1]?.authority_version).toBe(result.rotated.version)
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('persists OBSERVE reconciliation failures and recovers only the legacy transient kill', async () => {
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const sql = yield* PgClient.PgClient
          const initial = yield* store.ensureAuthorityGeneration({
            generationHash: hash('observe-recovery-generation-a'),
            maximum: Authority.Observe,
          })
          const [failedAt] = yield* sql<{ updated_at: Date }>`
            SELECT greatest(clock_timestamp(), updated_at + interval '1 millisecond') AS updated_at
            FROM authority_state
            WHERE singleton
          `
          if (failedAt === undefined) return yield* Effect.die(new Error('OBSERVE restriction time is unavailable'))

          yield* store.restrictAuthority(incompletePassReason, failedAt.updated_at.toISOString())
          const [afterReadOnlyFailure] = yield* sql<{
            generation_hash: string
            kill_state: KillState
            reason: string | null
            version: number
          }>`
            SELECT generation_hash, kill_state, reason, version::integer
            FROM authority_state
            WHERE singleton
          `

          const preservedWithoutReconciliation = yield* store.ensureAuthorityGeneration({
            generationHash: hash('observe-recovery-generation-b'),
            maximum: Authority.Observe,
          })
          const [reconciliationTime] = yield* sql<{ reconciled_at: Date }>`
            SELECT greatest(clock_timestamp(), updated_at + interval '1 millisecond') AS reconciled_at
            FROM authority_state
            WHERE singleton
          `
          if (reconciliationTime === undefined) {
            return yield* Effect.die(new Error('OBSERVE reconciliation time is unavailable'))
          }
          const reconciliationId = hash('observe-recovery-exact-reconciliation')
          const reconciliationContentHash = hash('observe-recovery-exact-content')
          const reconciliationStateHash = hash('observe-recovery-exact-state')
          yield* sql`
            INSERT INTO reconciliations (
              reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
              content_hash, status, discrepancies, reconciled_at
            ) VALUES (
              ${reconciliationId}, 'bayn.paper-reconciliation.v1', ${accountId},
              ${reconciliationStateHash}, ${reconciliationStateHash}, ${reconciliationContentHash},
              'EXACT', ${sql.json(encodeSqlJson([]))}, ${reconciliationTime.reconciled_at.toISOString()}
            )
          `
          const recovered = yield* store.ensureAuthorityGeneration({
            generationHash: hash('observe-recovery-generation-c'),
            maximum: Authority.Observe,
          })

          const [operatorKillAt] = yield* sql<{ updated_at: Date }>`
            SELECT greatest(clock_timestamp(), updated_at + interval '1 millisecond') AS updated_at
            FROM authority_state
            WHERE singleton
          `
          if (operatorKillAt === undefined) return yield* Effect.die(new Error('operator kill time is unavailable'))
          yield* sql`
            UPDATE authority_state
            SET
              effective = 'OBSERVE',
              kill_state = 'ACTIVE',
              reason = 'operator kill',
              version = version + 1,
              updated_at = ${operatorKillAt.updated_at.toISOString()}
            WHERE singleton
          `
          const preserved = yield* store.ensureAuthorityGeneration({
            generationHash: hash('observe-recovery-generation-d'),
            maximum: Authority.Observe,
          })

          return { initial, afterReadOnlyFailure, preservedWithoutReconciliation, recovered, preserved }
        }),
      )

      expect(result.afterReadOnlyFailure).toEqual({
        generation_hash: result.initial.generationHash,
        kill_state: KillState.Active,
        reason: incompletePassReason,
        version: result.initial.version + 1,
      })
      expect(result.preservedWithoutReconciliation).toMatchObject({
        maximum: Authority.Observe,
        effective: Authority.Observe,
        kill: KillState.Active,
        reason: incompletePassReason,
        version: 3,
      })
      expect(result.recovered).toMatchObject({
        maximum: Authority.Observe,
        effective: Authority.Observe,
        kill: KillState.Clear,
        version: 4,
      })
      expect(result.preserved).toMatchObject({
        maximum: Authority.Observe,
        effective: Authority.Observe,
        kill: KillState.Active,
        reason: 'operator kill',
        version: 6,
      })
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('recovers the exact identity-less autonomous OBSERVE root onto the configured sandbox identity', async () => {
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const sql = yield* PgClient.PgClient
          const activatedAt = '2026-07-28T06:49:28.305Z'
          yield* sql`
            INSERT INTO authority_generations (
              generation_hash, schema_version, previous_generation_hash, maximum,
              authority_version, activated_at
            ) VALUES (
              ${LEGACY_AUTONOMOUS_OBSERVE_GENERATION_HASH},
              'bayn.authority-generation-history.v1', NULL, 'OBSERVE', 1, ${activatedAt}
            )
          `
          yield* sql`
            INSERT INTO authority_state (
              schema_version, generation_hash, maximum, effective, kill_state,
              reason, version, updated_at
            ) VALUES (
              'bayn.paper-authority.v1', ${LEGACY_AUTONOMOUS_OBSERVE_GENERATION_HASH},
              'OBSERVE', 'OBSERVE', 'CLEAR', NULL, 1, ${activatedAt}
            )
          `
          const [failedAt] = yield* sql<{ updated_at: Date }>`
            SELECT greatest(clock_timestamp(), updated_at + interval '1 millisecond') AS updated_at
            FROM authority_state
            WHERE singleton
          `
          if (failedAt === undefined) return yield* Effect.die(new Error('legacy restriction time is unavailable'))
          yield* sql`
            UPDATE authority_state
            SET
              kill_state = 'ACTIVE',
              reason = ${incompletePassReason},
              version = 2,
              updated_at = ${failedAt.updated_at.toISOString()}
            WHERE singleton
          `
          const [reconciliationTime] = yield* sql<{ reconciled_at: Date }>`
            SELECT greatest(clock_timestamp(), updated_at + interval '1 millisecond') AS reconciled_at
            FROM authority_state
            WHERE singleton
          `
          if (reconciliationTime === undefined) {
            return yield* Effect.die(new Error('legacy reconciliation time is unavailable'))
          }
          const reconciliationStateHash = hash('legacy-observe-recovery-state')
          yield* sql`
            INSERT INTO reconciliations (
              reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
              content_hash, status, discrepancies, reconciled_at
            ) VALUES (
              ${hash('legacy-observe-recovery-reconciliation')}, 'bayn.paper-reconciliation.v1', ${accountId},
              ${reconciliationStateHash}, ${reconciliationStateHash},
              ${hash('legacy-observe-recovery-content')}, 'EXACT', ${sql.json(encodeSqlJson([]))},
              ${reconciliationTime.reconciled_at.toISOString()}
            )
          `
          const recovered = yield* store.ensureAuthorityGeneration({
            generationHash: hash('legacy-observe-recovery-generation-v2'),
            maximum: Authority.Observe,
          })
          const history = yield* sql<{
            account_id: string | null
            broker_environment: string | null
            broker_identity_schema_version: string | null
            broker_provider: string | null
            previous_generation_hash: string | null
          }>`
            SELECT
              previous_generation_hash,
              broker_identity_schema_version,
              broker_provider,
              broker_environment,
              account_id
            FROM authority_generations
            ORDER BY authority_version
          `
          return { history, recovered }
        }),
      )

      expect(result.recovered).toMatchObject({
        maximum: Authority.Observe,
        effective: Authority.Observe,
        kill: KillState.Clear,
        version: 3,
      })
      expect(result.history).toEqual([
        {
          previous_generation_hash: null,
          broker_identity_schema_version: null,
          broker_provider: null,
          broker_environment: null,
          account_id: null,
        },
        {
          previous_generation_hash: LEGACY_AUTONOMOUS_OBSERVE_GENERATION_HASH,
          broker_identity_schema_version: 'bayn.broker-identity.v2',
          broker_provider: BrokerProvider.Alpaca,
          broker_environment: BrokerEnvironment.Sandbox,
          account_id: accountId,
        },
      ])
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('preserves the transient kill for an arbitrary identity-less OBSERVE root', async () => {
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const sql = yield* PgClient.PgClient
          const untrustedRoot = hash('untrusted-identity-less-observe-root')
          const activatedAt = '2026-07-28T06:49:28.305Z'
          yield* sql`
            INSERT INTO authority_generations (
              generation_hash, schema_version, previous_generation_hash, maximum,
              authority_version, activated_at
            ) VALUES (
              ${untrustedRoot}, 'bayn.authority-generation-history.v1', NULL, 'OBSERVE', 1, ${activatedAt}
            )
          `
          yield* sql`
            INSERT INTO authority_state (
              schema_version, generation_hash, maximum, effective, kill_state,
              reason, version, updated_at
            ) VALUES (
              'bayn.paper-authority.v1', ${untrustedRoot},
              'OBSERVE', 'OBSERVE', 'CLEAR', NULL, 1, ${activatedAt}
            )
          `
          const [failedAt] = yield* sql<{ updated_at: Date }>`
            SELECT greatest(clock_timestamp(), updated_at + interval '1 millisecond') AS updated_at
            FROM authority_state
            WHERE singleton
          `
          if (failedAt === undefined) return yield* Effect.die(new Error('untrusted restriction time is unavailable'))
          yield* sql`
            UPDATE authority_state
            SET
              kill_state = 'ACTIVE',
              reason = ${incompletePassReason},
              version = 2,
              updated_at = ${failedAt.updated_at.toISOString()}
            WHERE singleton
          `
          const [reconciliationTime] = yield* sql<{ reconciled_at: Date }>`
            SELECT greatest(clock_timestamp(), updated_at + interval '1 millisecond') AS reconciled_at
            FROM authority_state
            WHERE singleton
          `
          if (reconciliationTime === undefined) {
            return yield* Effect.die(new Error('untrusted reconciliation time is unavailable'))
          }
          const reconciliationStateHash = hash('untrusted-observe-recovery-state')
          yield* sql`
            INSERT INTO reconciliations (
              reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
              content_hash, status, discrepancies, reconciled_at
            ) VALUES (
              ${hash('untrusted-observe-recovery-reconciliation')}, 'bayn.paper-reconciliation.v1', ${accountId},
              ${reconciliationStateHash}, ${reconciliationStateHash},
              ${hash('untrusted-observe-recovery-content')}, 'EXACT', ${sql.json(encodeSqlJson([]))},
              ${reconciliationTime.reconciled_at.toISOString()}
            )
          `
          return yield* store.ensureAuthorityGeneration({
            generationHash: hash('untrusted-observe-recovery-generation-v2'),
            maximum: Authority.Observe,
          })
        }),
      )

      expect(result).toMatchObject({
        maximum: Authority.Observe,
        effective: Authority.Observe,
        kill: KillState.Active,
        reason: incompletePassReason,
        version: 3,
      })
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('preserves the transient reconciliation kill across a broker identity rotation', async () => {
    const initialRuntime = makeStoreRuntime({ fail: false, planHashes: [] })
    try {
      await initialRuntime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const sql = yield* PgClient.PgClient
          yield* store.ensureAuthorityGeneration({
            generationHash: hash('observe-recovery-identity-generation-a'),
            maximum: Authority.Observe,
          })
          const [failedAt] = yield* sql<{ updated_at: Date }>`
            SELECT greatest(clock_timestamp(), updated_at + interval '1 millisecond') AS updated_at
            FROM authority_state
            WHERE singleton
          `
          if (failedAt === undefined) return yield* Effect.die(new Error('identity restriction time is unavailable'))
          yield* sql`
            UPDATE authority_state
            SET
              effective = 'OBSERVE',
              kill_state = 'ACTIVE',
              reason = ${incompletePassReason},
              version = version + 1,
              updated_at = ${failedAt.updated_at.toISOString()}
            WHERE singleton
          `
        }),
      )
    } finally {
      await initialRuntime.dispose()
    }

    const changedIdentity = brokerIdentity(BrokerEnvironment.Sandbox, 'changed-observe-recovery-account')
    const changedRuntime = makeStoreRuntime({ fail: false, planHashes: [] }, observeConfigWithIdentity(changedIdentity))
    try {
      const result = await changedRuntime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const sql = yield* PgClient.PgClient
          const [reconciliationTime] = yield* sql<{ reconciled_at: Date }>`
            SELECT greatest(clock_timestamp(), updated_at + interval '1 millisecond') AS reconciled_at
            FROM authority_state
            WHERE singleton
          `
          if (reconciliationTime === undefined) {
            return yield* Effect.die(new Error('identity reconciliation time is unavailable'))
          }
          const reconciliationStateHash = hash('observe-recovery-identity-state')
          yield* sql`
            INSERT INTO reconciliations (
              reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
              content_hash, status, discrepancies, reconciled_at
            ) VALUES (
              ${hash('observe-recovery-identity-reconciliation')}, 'bayn.paper-reconciliation.v1',
              ${changedIdentity.accountId}, ${reconciliationStateHash}, ${reconciliationStateHash},
              ${hash('observe-recovery-identity-content')}, 'EXACT', ${sql.json(encodeSqlJson([]))},
              ${reconciliationTime.reconciled_at.toISOString()}
            )
          `
          const rotated = yield* store.ensureAuthorityGeneration({
            generationHash: hash('observe-recovery-identity-generation-b'),
            maximum: Authority.Observe,
          })
          const history = yield* sql<{ account_id: string | null }>`
            SELECT account_id
            FROM authority_generations
            ORDER BY authority_version
          `
          return { history, rotated }
        }),
      )

      expect(result.rotated).toMatchObject({
        maximum: Authority.Observe,
        effective: Authority.Observe,
        kill: KillState.Active,
        reason: incompletePassReason,
        version: 3,
      })
      expect(result.history).toEqual([{ account_id: accountId }, { account_id: changedIdentity.accountId }])
    } finally {
      await changedRuntime.dispose()
    }
  }, 15_000)

  test('rejects OBSERVE replay and request-free startup across v2 broker identities', async () => {
    const generationHash = hash('observe-replay-broker-identity')
    const initialRuntime = makeStoreRuntime({ fail: false, planHashes: [] })
    try {
      await initialRuntime.runPromise(
        Effect.flatMap(ExecutionStore, (store) =>
          store.ensureAuthorityGeneration({ generationHash, maximum: Authority.Observe }),
        ),
      )
    } finally {
      await initialRuntime.dispose()
    }

    for (const configuredIdentity of [
      brokerIdentity(BrokerEnvironment.Sandbox, 'changed-observe-account'),
      brokerIdentity(BrokerEnvironment.Live, accountId),
    ]) {
      const replayRuntime = makeStoreRuntime(
        { fail: false, planHashes: [] },
        observeConfigWithIdentity(configuredIdentity),
      )
      try {
        const observed = await replayRuntime.runPromise(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient
            const store = yield* ExecutionStore
            const readOrInitializeObserveAuthority = store.readOrInitializeObserveAuthority
            assert(
              readOrInitializeObserveAuthority !== undefined,
              'OBSERVE authority initialization must be implemented',
            )
            const [before] = yield* sql<{ authority: unknown; history: unknown }>`
              SELECT
                (SELECT to_jsonb(state) FROM authority_state AS state WHERE singleton) AS authority,
                (
                  SELECT to_jsonb(history)
                  FROM authority_generations AS history
                  WHERE generation_hash = ${generationHash}
                ) AS history
            `
            const replayFailure = yield* Effect.flip(
              store.ensureAuthorityGeneration({ generationHash, maximum: Authority.Observe }),
            )
            const startupFailure = yield* Effect.flip(
              readOrInitializeObserveAuthority({
                generationHash: hash('changed-identity-configured-observe-root'),
                maximum: Authority.Observe,
              }),
            )
            const [after] = yield* sql<{ authority: unknown; history: unknown }>`
              SELECT
                (SELECT to_jsonb(state) FROM authority_state AS state WHERE singleton) AS authority,
                (
                  SELECT to_jsonb(history)
                  FROM authority_generations AS history
                  WHERE generation_hash = ${generationHash}
                ) AS history
            `
            return { after, before, replayFailure, startupFailure }
          }),
        )
        expect(observed.replayFailure).toMatchObject({
          operation: 'authority',
          failure: 'conflict',
          message: 'authority generation broker identity does not match configured broker identity',
        })
        expect(observed.startupFailure).toEqual(observed.replayFailure)
        expect(observed.after).toEqual(observed.before)
      } finally {
        await replayRuntime.dispose()
      }
    }
  }, 15_000)

  test('replays only the source-controlled pre-v2 autonomous OBSERVE root under sandbox identity', async () => {
    const activatedAt = '2026-07-28T06:49:28.305Z'
    const sandboxRuntime = makeStoreRuntime({ fail: false, planHashes: [] })
    try {
      const observed = await sandboxRuntime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`
            INSERT INTO authority_generations (
              generation_hash, schema_version, previous_generation_hash, maximum,
              authority_version, activated_at
            ) VALUES (
              ${LEGACY_AUTONOMOUS_OBSERVE_GENERATION_HASH},
              'bayn.authority-generation-history.v1', NULL, 'OBSERVE', 1, ${activatedAt}
            )
          `
          yield* sql`
            INSERT INTO authority_state (
              schema_version, generation_hash, maximum, effective, kill_state,
              reason, version, updated_at
            ) VALUES (
              'bayn.paper-authority.v1', ${LEGACY_AUTONOMOUS_OBSERVE_GENERATION_HASH},
              'OBSERVE', 'OBSERVE', 'CLEAR', NULL, 1, ${activatedAt}
            )
          `
          const [before] = yield* sql<{ authority_xmin: string; history_xmin: string }>`
            SELECT
              state.xmin::text AS authority_xmin,
              history.xmin::text AS history_xmin
            FROM authority_state AS state
            JOIN authority_generations AS history USING (generation_hash)
            WHERE state.singleton
          `
          const replay = yield* Effect.flatMap(ExecutionStore, (store) =>
            store.ensureAuthorityGeneration({
              generationHash: LEGACY_AUTONOMOUS_OBSERVE_GENERATION_HASH,
              maximum: Authority.Observe,
            }),
          )
          const [after] = yield* sql<{ authority_xmin: string; history_xmin: string }>`
            SELECT
              state.xmin::text AS authority_xmin,
              history.xmin::text AS history_xmin
            FROM authority_state AS state
            JOIN authority_generations AS history USING (generation_hash)
            WHERE state.singleton
          `
          return { after, before, replay }
        }),
      )
      expect(observed.replay).toMatchObject({
        generationHash: LEGACY_AUTONOMOUS_OBSERVE_GENERATION_HASH,
        maximum: Authority.Observe,
        effective: Authority.Observe,
        version: 1,
      })
      expect(observed.after).toEqual(observed.before)
    } finally {
      await sandboxRuntime.dispose()
    }

    const liveRuntime = makeStoreRuntime(
      { fail: false, planHashes: [] },
      observeConfigWithIdentity(brokerIdentity(BrokerEnvironment.Live, accountId)),
    )
    try {
      const failure = await liveRuntime.runPromise(
        Effect.flip(
          Effect.flatMap(ExecutionStore, (store) =>
            store.ensureAuthorityGeneration({
              generationHash: LEGACY_AUTONOMOUS_OBSERVE_GENERATION_HASH,
              maximum: Authority.Observe,
            }),
          ),
        ),
      )
      expect(failure).toMatchObject({
        operation: 'authority',
        failure: 'conflict',
        message: 'identity-less authority generation is not the compatible legacy autonomous OBSERVE root',
      })
    } finally {
      await liveRuntime.dispose()
    }
  }, 15_000)

  test('serializes concurrent absent-row authority initialization', async () => {
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const states = yield* Effect.all(
            Array.from({ length: 12 }, () =>
              store.ensureAuthorityGeneration({
                generationHash: hash('concurrent-authority-generation'),
                maximum: Authority.Observe,
              }),
            ),
            { concurrency: 'unbounded' },
          )
          const sql = yield* PgClient.PgClient
          const [stored] = yield* sql<{ rows: number; version: number }>`
            SELECT count(*) OVER ()::integer AS rows, version::integer
            FROM authority_state
          `
          return { states, stored }
        }),
      )

      expect(result.states).toHaveLength(12)
      expect(result.states.every((state) => state.version === 1)).toBe(true)
      expect(new Set(result.states.map((state) => JSON.stringify(state))).size).toBe(1)
      expect(result.stored).toEqual({ rows: 1, version: 1 })
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('fails an absent-row restriction and persists a restriction once OBSERVE authority is initialized', async () => {
    const generationHash = hash('restriction-initialization-generation')
    const reason = 'operator requested fail-closed initialization'
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const sql = yield* PgClient.PgClient
          const [databaseTime] = yield* sql<{ updated_at: Date }>`SELECT clock_timestamp() AS updated_at`
          if (databaseTime === undefined) return yield* Effect.die(new Error('database time is unavailable'))
          const beforeInitialization = yield* Effect.flip(
            store.restrictAuthority(reason, databaseTime.updated_at.toISOString()),
          )
          const initialized = yield* store.ensureAuthorityGeneration({
            generationHash,
            maximum: Authority.Observe,
          })
          const [restrictionTime] = yield* sql<{ updated_at: Date }>`
            SELECT greatest(clock_timestamp(), updated_at + interval '1 millisecond') AS updated_at
            FROM authority_state
            WHERE singleton
          `
          if (restrictionTime === undefined) return yield* Effect.die(new Error('restriction time is unavailable'))
          yield* store.restrictAuthority(reason, restrictionTime.updated_at.toISOString())
          const readAuthorityState = store.readAuthorityState
          assert(readAuthorityState !== undefined, 'authority reads must be available')
          const restricted = yield* readAuthorityState
          return { beforeInitialization, initialized, restricted }
        }),
      )

      expect(result.beforeInitialization).toMatchObject({
        operation: 'authority',
        failure: 'invariant',
      })
      expect(result.beforeInitialization.message).toContain(
        'authority restriction requires initialized durable authority state',
      )
      expect(result.initialized).toMatchObject({
        generationHash,
        maximum: Authority.Observe,
        effective: Authority.Observe,
        kill: KillState.Clear,
      })
      expect(result.restricted).toMatchObject({
        generationHash,
        maximum: Authority.Observe,
        effective: Authority.Observe,
        kill: KillState.Active,
        reason,
        version: 2,
      })
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('persists a restriction after its observed timestamp loses an authority-generation race', async () => {
    const initialGenerationHash = hash('stale-restriction-initial-generation')
    const rotatedGenerationHash = hash('stale-restriction-rotated-generation')
    const reason = 'operator requested fail-closed restriction after rotation'
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const sql = yield* PgClient.PgClient
          yield* store.ensureAuthorityGeneration({
            generationHash: initialGenerationHash,
            maximum: Authority.Observe,
          })
          const [observedBeforeRotation] = yield* sql<{ updated_at: Date }>`
            SELECT updated_at
            FROM authority_state
            WHERE singleton
          `
          if (observedBeforeRotation === undefined) {
            return yield* Effect.die(new Error('initial authority timestamp is unavailable'))
          }
          const rotated = yield* store.ensureAuthorityGeneration({
            generationHash: rotatedGenerationHash,
            maximum: Authority.Observe,
          })
          yield* store.restrictAuthority(reason, observedBeforeRotation.updated_at.toISOString())
          const readAuthorityState = store.readAuthorityState
          assert(readAuthorityState !== undefined, 'durable authority state reads must be implemented')
          const restricted = yield* readAuthorityState
          return { observedBeforeRotation: observedBeforeRotation.updated_at, rotated, restricted }
        }),
      )

      expect(Date.parse(result.rotated.updatedAt)).toBeGreaterThan(result.observedBeforeRotation.getTime())
      expect(result.restricted).toMatchObject({
        generationHash: rotatedGenerationHash,
        maximum: Authority.Observe,
        effective: Authority.Observe,
        kill: KillState.Active,
        reason,
        version: result.rotated.version + 1,
      })
      expect(Date.parse(result.restricted.updatedAt)).toBeGreaterThan(Date.parse(result.rotated.updatedAt))
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('preserves the first terminal PAPER restriction when reconciliation restricts authority again', async () => {
    const sourceGenerationHash = hash('terminal-restriction-source-generation')
    const activationReconciliation = exactReconciliation('terminal-restriction-activation')
    const activation = makeResearchActivation(sourceGenerationHash, activationReconciliation)
    const terminalReason = `${executionMandateFailureRestrictionPrefix} build-decision failed`
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] }, researchRuntimeConfig(sourceGenerationHash))
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const sql = yield* PgClient.PgClient
          yield* seedExactReconciliation(activationReconciliation)
          yield* store.ensureAuthorityGeneration({
            generationHash: sourceGenerationHash,
            maximum: Authority.Observe,
          })
          yield* store.activateResearchCapitalGrant(researchProofBinding(activation), sourceGenerationHash)
          const [firstRestrictionTime] = yield* sql<{ updated_at: Date }>`
            SELECT greatest(clock_timestamp(), updated_at + interval '1 millisecond') AS updated_at
            FROM authority_state
            WHERE singleton
          `
          if (firstRestrictionTime === undefined) {
            return yield* Effect.die(new Error('first restriction time is unavailable'))
          }
          yield* store.restrictAuthority(terminalReason, firstRestrictionTime.updated_at.toISOString())
          const [first] = yield* sql<{
            effective: Authority
            kill_state: KillState
            reason: string | null
            tuple_id: string
            updated_at: Date
            version: number
          }>`
            SELECT
              effective, kill_state, reason, xmin::text AS tuple_id,
              updated_at, version::integer
            FROM authority_state
            WHERE singleton
          `
          const [secondRestrictionTime] = yield* sql<{ updated_at: Date }>`
            SELECT greatest(clock_timestamp(), updated_at + interval '1 millisecond') AS updated_at
            FROM authority_state
            WHERE singleton
          `
          if (secondRestrictionTime === undefined) {
            return yield* Effect.die(new Error('second restriction time is unavailable'))
          }
          yield* store.restrictAuthority(
            `reconciliation discrepancy ${hash('later-reconciliation-discrepancy')}`,
            secondRestrictionTime.updated_at.toISOString(),
          )
          const [second] = yield* sql<{
            effective: Authority
            kill_state: KillState
            reason: string | null
            tuple_id: string
            updated_at: Date
            version: number
          }>`
            SELECT
              effective, kill_state, reason, xmin::text AS tuple_id,
              updated_at, version::integer
            FROM authority_state
            WHERE singleton
          `
          return { first, second }
        }),
      )

      expect(result.first).toMatchObject({
        effective: Authority.Observe,
        kill_state: KillState.Active,
        reason: terminalReason,
      })
      expect(result.second).toEqual(result.first)
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('promotes a terminal PAPER restriction over an earlier reconciliation discrepancy', async () => {
    const sourceGenerationHash = hash('promoted-terminal-restriction-source-generation')
    const activationReconciliation = exactReconciliation('promoted-terminal-restriction-activation')
    const activation = makeResearchActivation(sourceGenerationHash, activationReconciliation)
    const discrepancyReason = `reconciliation discrepancy ${hash('earlier-reconciliation-discrepancy')}`
    const terminalReason = `${executionMandateFailureRestrictionPrefix} bound cycle blocked: BLOCKED_RISK`
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] }, researchRuntimeConfig(sourceGenerationHash))
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const sql = yield* PgClient.PgClient
          yield* seedExactReconciliation(activationReconciliation)
          yield* store.ensureAuthorityGeneration({
            generationHash: sourceGenerationHash,
            maximum: Authority.Observe,
          })
          yield* store.activateResearchCapitalGrant(researchProofBinding(activation), sourceGenerationHash)
          const readAuthorityState = store.readAuthorityState
          assert(readAuthorityState !== undefined, 'durable authority state reads must be implemented')
          const [restrictionTime] = yield* sql<{ updated_at: Date }>`
            SELECT greatest(clock_timestamp(), updated_at + interval '1 millisecond') AS updated_at
            FROM authority_state
            WHERE singleton
          `
          if (restrictionTime === undefined) {
            return yield* Effect.die(new Error('restriction time is unavailable'))
          }
          yield* store.restrictAuthority(discrepancyReason, restrictionTime.updated_at.toISOString())
          const first = yield* readAuthorityState
          yield* store.restrictAuthority(terminalReason, restrictionTime.updated_at.toISOString())
          const second = yield* readAuthorityState
          return { first, second }
        }),
      )

      expect(result.first).toMatchObject({
        effective: Authority.Observe,
        kill: KillState.Active,
        reason: discrepancyReason,
      })
      expect(result.second).toMatchObject({
        effective: Authority.Observe,
        kill: KillState.Active,
        reason: terminalReason,
        version: result.first.version + 1,
      })
      expect(Date.parse(result.second.updatedAt)).toBeGreaterThan(Date.parse(result.first.updatedAt))
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('rotates monotonically while preserving an active kill exactly', async () => {
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          yield* store.ensureAuthorityGeneration({
            generationHash: hash('killed-authority-generation'),
            maximum: Authority.Observe,
          })
          const sql = yield* PgClient.PgClient
          const [killed] = yield* sql<{ updated_at: Date }>`
            UPDATE authority_state
            SET
              kill_state = 'ACTIVE',
              reason = 'operator kill',
              version = version + 1,
              updated_at = clock_timestamp()
            WHERE singleton
            RETURNING updated_at
          `
          const rotated = yield* store.ensureAuthorityGeneration({
            generationHash: hash('rotated-killed-authority-generation'),
            maximum: Authority.Observe,
          })
          return { killedAt: killed.updated_at.toISOString(), rotated }
        }),
      )

      expect(result.rotated).toEqual({
        schemaVersion: 'bayn.paper-authority.v1',
        generationHash: hash('rotated-killed-authority-generation'),
        maximum: Authority.Observe,
        effective: Authority.Observe,
        kill: KillState.Active,
        reason: 'operator kill',
        version: 3,
        updatedAt: expect.any(String),
      })
      expect(Date.parse(result.rotated.updatedAt)).toBeGreaterThan(Date.parse(result.killedAt))
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('rejects a future durable authority timestamp without rotating it', async () => {
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          yield* store.ensureAuthorityGeneration({
            generationHash: hash('future-authority-generation'),
            maximum: Authority.Observe,
          })
          const sql = yield* PgClient.PgClient
          yield* sql`
            UPDATE authority_state
            SET
              version = version + 1,
              updated_at = clock_timestamp() + interval '1 hour'
            WHERE singleton
          `
          const [before] = yield* sql<{
            generation_hash: string
            tuple_id: string
            updated_at: Date
            version: number
          }>`
            SELECT generation_hash, xmin::text AS tuple_id, updated_at, version::integer
            FROM authority_state
          `
          const failure = yield* Effect.flip(
            store.ensureAuthorityGeneration({
              generationHash: hash('rejected-future-authority-generation'),
              maximum: Authority.Observe,
            }),
          )
          const [after] = yield* sql<{
            generation_hash: string
            tuple_id: string
            updated_at: Date
            version: number
          }>`
            SELECT generation_hash, xmin::text AS tuple_id, updated_at, version::integer
            FROM authority_state
          `
          return { before, failure, after }
        }),
      )

      expect(result.failure).toMatchObject({
        operation: 'authority',
        failure: 'invariant',
        message: 'durable authority update follows its database observation time',
      })
      expect(result.after).toEqual(result.before)
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('rejects maximum conflicts, invalid input, and every PAPER request without writing', async () => {
    const observeGenerationHash = hash('conflicting-observe-generation')
    const reconciliation = exactReconciliation('maximum-conflict')
    const activation = makeActivation(observeGenerationHash, qualifiedEvidence, reconciliation)
    const runtime = makeActivationRuntime({ fail: false, planHashes: [] }, activation)
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const invalid = yield* Effect.flip(
            store.ensureAuthorityGeneration({
              generationHash: 'not-a-sha256',
              maximum: Authority.Observe,
            }),
          )
          const paper = yield* Effect.flip(
            store.ensureAuthorityGeneration({
              generationHash: hash('paper-authority-generation'),
              maximum: Authority.Execution,
            }),
          )
          const sql = yield* PgClient.PgClient
          const directPaper = yield* Effect.exit(sql`
            INSERT INTO authority_state (
              schema_version, generation_hash, maximum, effective, kill_state,
              reason, version, updated_at
            ) VALUES (
              'bayn.paper-authority.v1', ${hash('direct-initial-paper')},
              'PAPER', 'PAPER', 'CLEAR', NULL, 1, clock_timestamp()
            )
          `)
          const directObserveWithoutHistory = yield* Effect.exit(sql`
            INSERT INTO authority_state (
              schema_version, generation_hash, maximum, effective, kill_state,
              reason, version, updated_at
            ) VALUES (
              'bayn.paper-authority.v1', ${hash('direct-initial-observe-without-history')},
              'OBSERVE', 'OBSERVE', 'CLEAR', NULL, 1, clock_timestamp()
            )
          `)
          const [empty] = yield* sql<{ authority_rows: number; history_rows: number }>`
            SELECT
              (SELECT count(*)::integer FROM authority_state) AS authority_rows,
              (SELECT count(*)::integer FROM authority_generations) AS history_rows
          `
          yield* seedQualificationEvidence(qualifiedEvidence)
          yield* seedExactReconciliation(reconciliation)
          yield* store.ensureAuthorityGeneration({
            generationHash: observeGenerationHash,
            maximum: Authority.Observe,
          })
          yield* store.activateCapitalGrant(proofBinding(activation))
          const [beforeConflict] = yield* sql<{ tuple_id: string; version: number }>`
            SELECT xmin::text AS tuple_id, version::integer FROM authority_state
          `
          const conflict = yield* Effect.flip(
            store.ensureAuthorityGeneration({
              generationHash: activation.generationHash,
              maximum: Authority.Observe,
            }),
          )
          const [afterConflict] = yield* sql<{ tuple_id: string; version: number }>`
            SELECT xmin::text AS tuple_id, version::integer FROM authority_state
          `
          return {
            invalid,
            paper,
            directObserveWithoutHistory,
            directPaper,
            empty,
            conflict,
            beforeConflict,
            afterConflict,
          }
        }),
      )

      expect(result.invalid).toMatchObject({ operation: 'authority', failure: 'decode' })
      expect(result.paper).toMatchObject({ operation: 'authority', failure: 'invariant' })
      expect(Exit.isFailure(result.directPaper)).toBe(true)
      expect(Exit.isFailure(result.directObserveWithoutHistory)).toBe(true)
      expect(result.empty).toEqual({ authority_rows: 0, history_rows: 0 })
      expect(result.conflict).toMatchObject({ operation: 'authority', failure: 'conflict' })
      expect(result.afterConflict).toEqual(result.beforeConflict)
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('prepares one deterministic PAPER receipt without writes and activates it from unchanged durable inputs', async () => {
    const initialGenerationHash = hash('prepared-paper-observe-generation')
    const reconciliation = exactReconciliation('prepared-paper')
    const expected = makeActivation(initialGenerationHash, qualifiedEvidence, reconciliation)
    const prepareRuntime = makeStoreRuntime({ fail: false, planHashes: [] }, prepareRuntimeConfig(expected))
    const preparation = await (async () => {
      try {
        return await prepareRuntime.runPromise(
          Effect.gen(function* () {
            const store = yield* ExecutionStore
            yield* seedQualificationEvidence(qualifiedEvidence)
            yield* seedExactReconciliation(reconciliation)
            yield* store.ensureAuthorityGeneration({
              generationHash: initialGenerationHash,
              maximum: Authority.Observe,
            })
            const before = yield* readAuthorityTupleEvidence
            const first = yield* store.prepareCapitalGrant(proofBinding(expected))
            const second = yield* store.prepareCapitalGrant(proofBinding(expected))
            const after = yield* readAuthorityTupleEvidence
            return { after, before, first, second }
          }),
        )
      } finally {
        await prepareRuntime.dispose()
      }
    })()

    expect(preparation.first).toEqual(expected)
    expect(preparation.second).toEqual(preparation.first)
    expect(preparation.after).toEqual(preparation.before)

    const activationRuntime = makeActivationRuntime({ fail: false, planHashes: [] }, preparation.first)
    try {
      const activated = await activationRuntime.runPromise(
        Effect.flatMap(ExecutionStore, (store) => store.activateCapitalGrant(proofBinding(preparation.first))),
      )
      expect(activated).toMatchObject({
        generationHash: preparation.first.generationHash,
        maximum: Authority.Execution,
        effective: Authority.Execution,
        version: 2,
      })
    } finally {
      await activationRuntime.dispose()
    }
  }, 15_000)

  test('atomically activates, reads, and exactly replays one reconciliation-bound research execution generation', async () => {
    const initialGenerationHash = hash('research-paper-observe-generation')
    const reconciliation = exactReconciliation('research-paper')
    const expected = makeResearchActivation(initialGenerationHash, reconciliation)
    const staticRequest = makeResearchActivation(initialGenerationHash, exactReconciliation('static-request'))
    expect(staticRequest.generationHash).toBe(expected.generationHash)
    expect(staticRequest.reconciliationId).not.toBe(expected.reconciliationId)
    expect(staticRequest.reconciliationContentHash).not.toBe(expected.reconciliationContentHash)
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] }, researchRuntimeConfig(initialGenerationHash))
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const sql = yield* PgClient.PgClient
          const activateResearch = store.activateResearchCapitalGrant
          const readResearch = store.readResearchAuthorityGeneration
          const readQualified = store.readAuthorityGeneration
          assert(activateResearch !== undefined, 'research PAPER activation must be implemented')
          assert(readResearch !== undefined, 'research execution history read must be implemented')
          assert(readQualified !== undefined, 'qualified execution history read must be implemented')
          yield* seedExactReconciliation(reconciliation)
          yield* store.ensureAuthorityGeneration({
            generationHash: initialGenerationHash,
            maximum: Authority.Observe,
          })
          const activated = yield* activateResearch(researchProofBinding(staticRequest), initialGenerationHash)
          const beforeReplay = yield* readAuthorityTupleEvidence
          const replay = yield* activateResearch(researchProofBinding(staticRequest), initialGenerationHash)
          const afterReplay = yield* readAuthorityTupleEvidence
          const research = yield* readResearch(expected.generationHash)
          const qualified = yield* readQualified(expected.generationHash)
          const [history] = yield* sql<{
            activation_schema_version: string
            history_count: number
            research_plan_hash: string
            strategy_protocol_hash: string
          }>`
            SELECT
              count(*)::integer AS history_count,
              min(activation_schema_version) AS activation_schema_version,
              min(research_plan_hash) AS research_plan_hash,
              min(strategy_protocol_hash) AS strategy_protocol_hash
            FROM authority_generations
            WHERE generation_hash = ${expected.generationHash}
          `
          return {
            activated,
            afterReplay,
            beforeReplay,
            history,
            qualified,
            replay,
            research,
          }
        }),
      )

      expect(result.activated).toMatchObject({
        generationHash: expected.generationHash,
        maximum: Authority.Execution,
        effective: Authority.Execution,
        version: 2,
      })
      expect(result.replay).toEqual(result.activated)
      expect(result.afterReplay).toEqual(result.beforeReplay)
      expect(result.research).toEqual(expected)
      expect(result.qualified).toBeUndefined()
      expect(result.history).toEqual({
        activation_schema_version: 'bayn.paper-authority-generation.v3',
        history_count: 1,
        research_plan_hash: expected.grant.planHash,
        strategy_protocol_hash: expected.strategyProtocolHash,
      })
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('rolls back research PAPER rearm after the cycle submission window opens', async () => {
    const sourceGenerationHash = hash('research-paper-rearm-source')
    const nextSourceGenerationHash = hash('research-paper-rearm-next-source')
    const activationReconciliation = exactReconciliation('research-paper-rearm-activation')
    const activation = makeResearchActivation(sourceGenerationHash, activationReconciliation)
    const cycleId = hash('research-paper-rearm-cycle')
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] }, researchRuntimeConfig(sourceGenerationHash))
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const sql = yield* PgClient.PgClient
          const activateResearch = store.activateResearchCapitalGrant
          assert(activateResearch !== undefined, 'research PAPER activation must be implemented')

          yield* seedExactReconciliation(activationReconciliation)
          yield* store.ensureAuthorityGeneration({
            generationHash: sourceGenerationHash,
            maximum: Authority.Observe,
          })
          const activated = yield* activateResearch(researchProofBinding(activation), sourceGenerationHash)
          const [restrictionTime] = yield* sql<{ updated_at: Date }>`
            SELECT greatest(clock_timestamp(), updated_at + interval '1 millisecond') AS updated_at
            FROM authority_state
            WHERE singleton
          `
          if (restrictionTime === undefined) return yield* Effect.die(new Error('restriction time is unavailable'))
          yield* store.restrictAuthority(
            `${executionMandateFailureRestrictionPrefix} build-decision failed`,
            restrictionTime.updated_at.toISOString(),
          )

          yield* sql`
            WITH timing AS (
              SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date - 1 AS execution_date
            )
            INSERT INTO autonomous_cycles (
              cycle_id, schema_version, identity_schema_version, strategy_name,
              qualification_run_id, strategy_protocol_hash, account_id,
              signal_session_date, signal_calendar_version,
              execution_policy_schema_version, execution_policy_hash,
              strategy_execution_model_hash, submission_window_ms,
              submission_cutoff_before_open_ms, window_schema_version,
              execution_calendar_schema_version, execution_calendar_source,
              execution_calendar_hash, execution_session_date, signal_close_at,
              publication_deadline_at, submission_open_at, execution_open_at,
              execution_close_at, submission_cutoff_at, state, snapshot_id,
              decision_hash, terminal_reason, state_version, created_at, updated_at, terminal_at
            )
            SELECT
              ${cycleId}, 'bayn.autonomous-cycle.v1', 'bayn.autonomous-cycle-identity.v1',
              'risk-balanced-trend', ${activation.grant.planHash}, ${activation.strategyProtocolHash}, ${accountId},
              execution_date - 1, 'test-calendar-v1',
              'bayn.autonomous-cycle-execution-policy.v1', ${hash('research-paper-rearm-policy')},
              ${hash('research-paper-rearm-execution-model')}, 1800000, 1800000,
              'bayn.autonomous-cycle-window.v1', 'bayn.alpaca-market-calendar-observation.v1',
              'alpaca-v2-calendar', ${hash('research-paper-rearm-calendar')}, execution_date,
              ((execution_date - 1) + time '20:00') AT TIME ZONE 'UTC',
              (execution_date + time '12:30') AT TIME ZONE 'UTC',
              (execution_date + time '12:30') AT TIME ZONE 'UTC',
              (execution_date + time '13:30') AT TIME ZONE 'UTC',
              (execution_date + time '20:00') AT TIME ZONE 'UTC',
              (execution_date + time '13:00') AT TIME ZONE 'UTC',
              'PENDING', NULL, NULL, NULL, 1,
              ((execution_date - 1) + time '20:00') AT TIME ZONE 'UTC',
              ((execution_date - 1) + time '20:00') AT TIME ZONE 'UTC', NULL
            FROM timing
          `
          yield* seedExactReconciliation(exactReconciliation('research-paper-rearm-after-submission-open'))
          const beforePremature = yield* readAuthorityTupleEvidence
          const premature = yield* Effect.flip(
            store.ensureAuthorityGeneration({
              generationHash: nextSourceGenerationHash,
              maximum: Authority.Observe,
            }),
          )
          const afterPremature = yield* readAuthorityTupleEvidence
          const [rollback] = yield* sql<{
            candidate_history_count: number
            cycle_state: string
            cycle_state_version: number
          }>`
            SELECT
              cycle.state AS cycle_state,
              cycle.state_version AS cycle_state_version,
              (
                SELECT count(*)::integer
                FROM authority_generations
                WHERE generation_hash = ${nextSourceGenerationHash}
              ) AS candidate_history_count
            FROM autonomous_cycles AS cycle
            WHERE cycle.cycle_id = ${cycleId}
          `
          return { activated, afterPremature, beforePremature, premature, rollback }
        }),
      )

      expect(result.activated).toMatchObject({
        generationHash: activation.generationHash,
        maximum: Authority.Execution,
        effective: Authority.Execution,
        kill: KillState.Clear,
      })
      expect(result.premature).toMatchObject({ operation: 'authority', failure: 'invariant' })
      expect(result.afterPremature).toEqual(result.beforePremature)
      expect(result.rollback).toEqual({
        candidate_history_count: 0,
        cycle_state: 'PENDING',
        cycle_state_version: 1,
      })
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('atomically supersedes an active zero-intent research PAPER cycle before submission and rearms', async () => {
    const sourceGenerationHash = hash('clear-research-paper-rearm-source')
    const nextSourceGenerationHash = hash('clear-research-paper-rearm-next-source')
    const activationReconciliation = exactReconciliation('clear-research-paper-rearm-activation')
    const activation = makeResearchActivation(sourceGenerationHash, activationReconciliation)
    const cycleId = hash('clear-research-paper-rearm-cycle')
    const snapshotId = hash('clear-research-paper-rearm-snapshot')
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] }, researchRuntimeConfig(sourceGenerationHash))
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const sql = yield* PgClient.PgClient
          const activateResearch = store.activateResearchCapitalGrant
          assert(activateResearch !== undefined, 'research PAPER activation must be implemented')

          yield* seedExactReconciliation(activationReconciliation)
          yield* store.ensureAuthorityGeneration({
            generationHash: sourceGenerationHash,
            maximum: Authority.Observe,
          })
          const activated = yield* activateResearch(researchProofBinding(activation), sourceGenerationHash)
          yield* sql`
            WITH timing AS (
              SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date + 2 AS execution_date
            )
            INSERT INTO snapshot_references (
              snapshot_id, schema_version, database_name, table_name, dataset_version,
              source, source_feed, adjustment, content_hash, row_count,
              first_session, last_session, manifest
            )
            SELECT
              ${snapshotId}, 'bayn.finalized-snapshot.v3', 'signal', 'adjusted_daily_bars_v2',
              'signal.adjusted-daily-snapshot.v2', 'alpaca', 'sip', 'all', ${snapshotId}, 1,
              execution_date - 1, execution_date - 1,
              jsonb_build_object('calendarVersion', 'test-calendar-v1')
            FROM timing
          `
          yield* sql`
            WITH timing AS (
              SELECT
                clock_timestamp() AS created_at,
                (clock_timestamp() AT TIME ZONE 'UTC')::date + 2 AS execution_date
            )
            INSERT INTO autonomous_cycles (
              cycle_id, schema_version, identity_schema_version, strategy_name,
              qualification_run_id, strategy_protocol_hash, account_id,
              signal_session_date, signal_calendar_version,
              execution_policy_schema_version, execution_policy_hash,
              strategy_execution_model_hash, submission_window_ms,
              submission_cutoff_before_open_ms, window_schema_version,
              execution_calendar_schema_version, execution_calendar_source,
              execution_calendar_hash, execution_session_date, signal_close_at,
              publication_deadline_at, submission_open_at, execution_open_at,
              execution_close_at, submission_cutoff_at, state, snapshot_id,
              decision_hash, terminal_reason, state_version, created_at, updated_at, terminal_at
            )
            SELECT
              ${cycleId}, 'bayn.autonomous-cycle.v1', 'bayn.autonomous-cycle-identity.v1',
              'risk-balanced-trend', ${activation.grant.planHash}, ${activation.strategyProtocolHash}, ${accountId},
              execution_date - 1, 'test-calendar-v1',
              'bayn.autonomous-cycle-execution-policy.v1', ${hash('clear-rearm-policy')},
              ${hash('clear-rearm-execution-model')}, 1800000, 1800000,
              'bayn.autonomous-cycle-window.v1', 'bayn.alpaca-market-calendar-observation.v1',
              'alpaca-v2-calendar', ${hash('clear-rearm-calendar')}, execution_date,
              created_at, (execution_date + time '12:30') AT TIME ZONE 'UTC',
              (execution_date + time '12:30') AT TIME ZONE 'UTC',
              (execution_date + time '13:30') AT TIME ZONE 'UTC',
              (execution_date + time '20:00') AT TIME ZONE 'UTC',
              (execution_date + time '13:00') AT TIME ZONE 'UTC',
              'PENDING', NULL, NULL, NULL, 1, created_at, created_at, NULL
            FROM timing
          `
          yield* sql`
            WITH timing AS (
              SELECT clock_timestamp() AS updated_at
              FROM autonomous_cycles
              WHERE cycle_id = ${cycleId}
            )
            UPDATE autonomous_cycles AS cycle
            SET
              snapshot_id = ${snapshotId},
              state_version = 2,
              updated_at = timing.updated_at
            FROM timing
            WHERE cycle.cycle_id = ${cycleId}
          `
          yield* sql`
            WITH timing AS (
              SELECT clock_timestamp() AS updated_at
              FROM autonomous_cycles
              WHERE cycle_id = ${cycleId}
            )
            UPDATE autonomous_cycles AS cycle
            SET
              state = 'ACTIVE',
              state_version = 3,
              updated_at = timing.updated_at
            FROM timing
            WHERE cycle.cycle_id = ${cycleId}
          `
          // Activation timestamps are deliberately monotonic and may lead the wall clock by one millisecond.
          // Sample reconciliation only after that boundary, then let the rollover take a strictly later timestamp.
          yield* sql`SELECT pg_sleep(0.01)`
          yield* seedExactReconciliation(exactReconciliation('clear-research-paper-rearm-before-rollover'))
          yield* sql`SELECT pg_sleep(0.01)`
          const rearmed = yield* store.ensureAuthorityGeneration({
            generationHash: nextSourceGenerationHash,
            maximum: Authority.Observe,
          })
          const [history] = yield* sql<{
            maximum: Authority
            previous_generation_hash: string | null
          }>`
            SELECT maximum, previous_generation_hash
            FROM authority_generations
            WHERE generation_hash = ${nextSourceGenerationHash}
          `
          const [cycle] = yield* sql<{
            decision_hash: string | null
            intent_count: number
            state: string
            state_version: number
            terminal_reason: string | null
          }>`
            SELECT
              cycle.state,
              cycle.state_version,
              cycle.decision_hash,
              cycle.terminal_reason,
              (
                SELECT count(*)::integer
                FROM intents AS intent
                WHERE intent.cycle_id = cycle.cycle_id
              ) AS intent_count
            FROM autonomous_cycles AS cycle
            WHERE cycle.cycle_id = ${cycleId}
          `
          return { activated, cycle, history, rearmed }
        }),
      )

      expect(result.activated).toMatchObject({
        generationHash: activation.generationHash,
        maximum: Authority.Execution,
        effective: Authority.Execution,
        kill: KillState.Clear,
      })
      expect(result.rearmed).toMatchObject({
        generationHash: nextSourceGenerationHash,
        maximum: Authority.Observe,
        effective: Authority.Observe,
        kill: KillState.Clear,
      })
      expect(result.rearmed.reason).toBeUndefined()
      expect(result.history).toEqual({
        maximum: Authority.Observe,
        previous_generation_hash: activation.generationHash,
      })
      expect(result.cycle).toEqual({
        decision_hash: null,
        intent_count: 0,
        state: 'BLOCKED',
        state_version: 4,
        terminal_reason: 'BLOCKED_PROVENANCE_MISMATCH',
      })
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('clears a failure-restricted qualified v2 execution generation only after fresh exact reconciliation', async () => {
    const sourceGenerationHash = hash('qualified-v2-recovery-source')
    const nextSourceGenerationHash = hash('qualified-v2-recovery-next-source')
    const activationReconciliation = exactReconciliation('qualified-v2-recovery-activation')
    const activation = makeActivation(sourceGenerationHash, qualifiedEvidence, activationReconciliation)
    const runtime = makeActivationRuntime({ fail: false, planHashes: [] }, activation)
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const sql = yield* PgClient.PgClient

          yield* seedQualificationEvidence(qualifiedEvidence)
          yield* seedExactReconciliation(activationReconciliation)
          yield* store.ensureAuthorityGeneration({
            generationHash: sourceGenerationHash,
            maximum: Authority.Observe,
          })
          const activated = yield* store.activateCapitalGrant(proofBinding(activation))
          const [restrictionTime] = yield* sql<{ updated_at: Date }>`
            SELECT greatest(clock_timestamp(), updated_at + interval '1 millisecond') AS updated_at
            FROM authority_state
            WHERE singleton
          `
          if (restrictionTime === undefined) return yield* Effect.die(new Error('restriction time is unavailable'))
          yield* store.restrictAuthority(
            `${executionMandateFailureRestrictionPrefix} qualified v2 recovery`,
            restrictionTime.updated_at.toISOString(),
          )

          const beforeFreshReconciliation = yield* Effect.flip(
            store.ensureAuthorityGeneration({
              generationHash: nextSourceGenerationHash,
              maximum: Authority.Observe,
            }),
          )
          const rolloverReconciliation = exactReconciliation('qualified-v2-recovery-rollover')
          const rolloverStateHash = hash('qualified-v2-recovery-rollover-state')
          yield* sql`
            INSERT INTO reconciliations (
              reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
              content_hash, status, discrepancies, reconciled_at
            )
            SELECT
              ${rolloverReconciliation.reconciliationId}, 'bayn.paper-reconciliation.v1', ${accountId},
              ${rolloverStateHash}, ${rolloverStateHash}, ${rolloverReconciliation.contentHash}, 'EXACT',
              ${sql.json(encodeSqlJson([]))}, greatest(clock_timestamp(), state.updated_at + interval '1 millisecond')
            FROM authority_state AS state
            WHERE state.singleton
          `
          // Recovery requires a strictly later, independently sampled activation time.
          yield* sql`SELECT pg_sleep(0.01)`
          const rearmed = yield* store.ensureAuthorityGeneration({
            generationHash: nextSourceGenerationHash,
            maximum: Authority.Observe,
          })
          return { activated, beforeFreshReconciliation, rearmed }
        }),
      )

      expect(result.activated).toMatchObject({
        generationHash: activation.generationHash,
        maximum: Authority.Execution,
        effective: Authority.Execution,
        kill: KillState.Clear,
      })
      expect(result.beforeFreshReconciliation).toMatchObject({
        operation: 'authority',
        failure: 'invariant',
      })
      expect(result.rearmed).toMatchObject({
        generationHash: nextSourceGenerationHash,
        maximum: Authority.Observe,
        effective: Authority.Observe,
        kill: KillState.Clear,
      })
      expect(result.rearmed.reason).toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('rolls a settled execution generation into one fresh restart-safe OBSERVE successor', async () => {
    const configuredObserveGenerationHash = hash('blocked-rollover-configured-observe')
    const activationReconciliation = exactReconciliation('blocked-rollover-activation')
    const activation = makeResearchActivation(configuredObserveGenerationHash, activationReconciliation)
    const runtime = makeStoreRuntime(
      { fail: false, planHashes: [] },
      researchRuntimeConfig(configuredObserveGenerationHash),
    )
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const sql = yield* PgClient.PgClient
          const writerFence = yield* WriterFence
          const activateResearch = store.activateResearchCapitalGrant
          assert(activateResearch !== undefined, 'research PAPER activation must be implemented')

          yield* seedExactReconciliation(activationReconciliation)
          yield* store.ensureAuthorityGeneration({
            generationHash: configuredObserveGenerationHash,
            maximum: Authority.Observe,
          })
          const paper = yield* activateResearch(researchProofBinding(activation), configuredObserveGenerationHash)
          const [restrictionTime] = yield* sql<{ updated_at: Date }>`
            SELECT greatest(clock_timestamp(), updated_at + interval '1 millisecond') AS updated_at
            FROM authority_state
            WHERE singleton
          `
          if (restrictionTime === undefined) return yield* Effect.die(new Error('restriction time is unavailable'))
          yield* store.restrictAuthority(
            `${executionMandateFailureRestrictionPrefix} blocked rollover regression`,
            restrictionTime.updated_at.toISOString(),
          )

          const blockedIntents: BlockedCycleIntentStoreShape = {
            terminalizeUntouchedApproved: () => Effect.die(new Error('startup settlement only')),
            settleCurrentTerminalGeneration: () =>
              Effect.succeed({
                _tag: 'TerminalGenerationSettled' as const,
                authorityGenerationHash: paper.generationHash,
                blockedCycleCount: 1,
                blockedIntentCount: 0,
                expiredIntentCount: 0,
                intentCount: 0,
                terminalIntentCount: 0,
              }),
          }
          const reconciliation = exactReconciliation('blocked-rollover-after-settlement')
          const reconcileAfterSettlement = Effect.gen(function* () {
            const stateHash = hash('blocked-rollover-after-settlement-state')
            yield* sql`
                INSERT INTO reconciliations (
                  reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
                  content_hash, status, discrepancies, reconciled_at
                )
                SELECT
                  ${reconciliation.reconciliationId}, 'bayn.paper-reconciliation.v1', ${accountId},
                  ${stateHash}, ${stateHash}, ${reconciliation.contentHash}, 'EXACT',
                  ${sql.json(encodeSqlJson([]))}, greatest(clock_timestamp(), state.updated_at + interval '1 millisecond')
                FROM authority_state AS state
                WHERE state.singleton
              `
          }).pipe(
            Effect.mapError((cause) =>
              operationalError({
                component: 'database',
                operation: 'test-blocked-rollover',
                message: 'test reconciliation write failed',
                cause,
              }),
            ),
          )
          const first = yield* recoverTerminalGenerationToObserve({
            accountId,
            blockedIntents,
            authorityStore: store,
            writerFence,
            reconcileAfterSettlement,
          })
          if (first._tag !== 'RolledOver') return yield* Effect.die(new Error('rollover receipt is missing'))
          const replay = yield* store.ensureAuthorityGeneration({
            generationHash: first.generationHash,
            maximum: Authority.Observe,
          })
          const reusedBootstrap = yield* Effect.flip(
            store.ensureAuthorityGeneration({
              generationHash: configuredObserveGenerationHash,
              maximum: Authority.Observe,
            }),
          )
          const nextReconciliation = exactReconciliation('blocked-rollover-next-activation')
          const nextStateHash = hash('blocked-rollover-next-activation-state')
          yield* sql`
            INSERT INTO reconciliations (
              reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
              content_hash, status, discrepancies, reconciled_at
            )
            SELECT
              ${nextReconciliation.reconciliationId}, 'bayn.paper-reconciliation.v1', ${accountId},
              ${nextStateHash}, ${nextStateHash}, ${nextReconciliation.contentHash}, 'EXACT',
              ${sql.json(encodeSqlJson([]))}, greatest(clock_timestamp(), state.updated_at + interval '1 millisecond')
            FROM authority_state AS state
            WHERE state.singleton
          `
          const nextPaper = yield* activateResearch(researchProofBinding(activation), first.generationHash)
          const history = yield* sql<{
            generation_hash: string
            maximum: Authority
            previous_generation_hash: string | null
          }>`
            SELECT generation_hash, maximum, previous_generation_hash
            FROM authority_generations
            ORDER BY authority_version
          `
          return { first, history, nextPaper, paper, replay, reusedBootstrap }
        }),
      )

      const expectedSuccessor = Result.getOrThrow(
        executionObserveSuccessorGenerationHash({
          previousExecutionGenerationHash: result.paper.generationHash,
        }),
      )
      expect(result.first).toMatchObject({
        _tag: 'RolledOver',
        previousGenerationHash: result.paper.generationHash,
        generationHash: expectedSuccessor,
      })
      expect(result.replay).toMatchObject({
        generationHash: expectedSuccessor,
        maximum: Authority.Observe,
        effective: Authority.Observe,
        kill: KillState.Clear,
      })
      expect(result.reusedBootstrap).toMatchObject({
        operation: 'authority',
        failure: 'conflict',
        message: 'authority generation hash was already used',
      })
      expect(result.nextPaper).toMatchObject({
        maximum: Authority.Execution,
        effective: Authority.Execution,
        kill: KillState.Clear,
      })
      expect(result.nextPaper.version).toBe(result.replay.version + 1)
      expect(result.nextPaper.generationHash).not.toBe(result.paper.generationHash)
      expect(result.history).toEqual([
        {
          generation_hash: configuredObserveGenerationHash,
          maximum: Authority.Observe,
          previous_generation_hash: null,
        },
        {
          generation_hash: result.paper.generationHash,
          maximum: Authority.Execution,
          previous_generation_hash: configuredObserveGenerationHash,
        },
        {
          generation_hash: expectedSuccessor,
          maximum: Authority.Observe,
          previous_generation_hash: result.paper.generationHash,
        },
        {
          generation_hash: result.nextPaper.generationHash,
          maximum: Authority.Execution,
          previous_generation_hash: expectedSuccessor,
        },
      ])
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test.each([
    ['completed', executionMandateCompletedRestrictionReason],
    ['legacy v1 completed', legacyV1CompletedRestrictionReason],
    ['expired', executionActivationExpiredRestrictionReason],
  ] as const)(
    'rolls a receipt-finalized %s execution generation to clear OBSERVE only after durable receipt evidence',
    async (fixture, restrictionReason) => {
      const configuredObserveGenerationHash = hash(`receipt-rollover-${fixture}-configured-observe`)
      const activationReconciliation = exactReconciliation(`receipt-rollover-${fixture}-activation`)
      const activation = makeResearchActivation(configuredObserveGenerationHash, activationReconciliation)
      const cycleId = hash(`receipt-rollover-${fixture}-cycle`)
      const receiptHash = hash(`receipt-rollover-${fixture}-receipt`)
      const contentHash = hash(`receipt-rollover-${fixture}-envelope`)
      const runtime = makeStoreRuntime(
        { fail: false, planHashes: [] },
        researchRuntimeConfig(configuredObserveGenerationHash),
      )
      try {
        const result = await runtime.runPromise(
          Effect.gen(function* () {
            const store = yield* ExecutionStore
            const blockedIntents = yield* BlockedCycleIntentStore
            const sql = yield* PgClient.PgClient
            const writerFence = yield* WriterFence
            const activateResearch = store.activateResearchCapitalGrant
            assert(activateResearch !== undefined, 'research PAPER activation must be implemented')
            const readAuthorityState = store.readAuthorityState
            assert(readAuthorityState !== undefined, 'durable authority state reads must be implemented')
            const readAuthorityGenerationLineage = store.readAuthorityGenerationLineage
            assert(
              readAuthorityGenerationLineage !== undefined,
              'durable authority generation lineage reads must be implemented',
            )

            yield* seedExactReconciliation(activationReconciliation)
            yield* store.ensureAuthorityGeneration({
              generationHash: configuredObserveGenerationHash,
              maximum: Authority.Observe,
            })
            const paper = yield* activateResearch(researchProofBinding(activation), configuredObserveGenerationHash)
            yield* sql`
            WITH timing AS (
              SELECT
                ((execution_date + time '22:00:00') AT TIME ZONE 'UTC') AS terminal_at,
                execution_date
              FROM (
                SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date - 1 AS execution_date
              ) AS dates
            )
            INSERT INTO autonomous_cycles (
              cycle_id, schema_version, identity_schema_version, strategy_name,
              qualification_run_id, strategy_protocol_hash, account_id,
              signal_session_date, signal_calendar_version,
              execution_policy_schema_version, execution_policy_hash,
              strategy_execution_model_hash, submission_window_ms,
              submission_cutoff_before_open_ms, window_schema_version,
              execution_calendar_schema_version, execution_calendar_source,
              execution_calendar_hash, execution_session_date, signal_close_at,
              publication_deadline_at, submission_open_at, execution_open_at,
              execution_close_at, submission_cutoff_at, state, snapshot_id,
              decision_hash, terminal_reason, state_version, created_at, updated_at, terminal_at
            )
            SELECT
              ${cycleId}, 'bayn.autonomous-cycle.v1', 'bayn.autonomous-cycle-identity.v1',
              'risk-balanced-trend', ${activation.grant.planHash}, ${activation.strategyProtocolHash}, ${accountId},
              execution_date - 1, 'test-calendar-v1',
              'bayn.autonomous-cycle-execution-policy.v1', ${hash(`receipt-rollover-${fixture}-policy`)},
              ${hash(`receipt-rollover-${fixture}-execution-model`)}, 1800000, 1800000,
              'bayn.autonomous-cycle-window.v1', 'bayn.alpaca-market-calendar-observation.v1',
              'alpaca-v2-calendar', ${hash(`receipt-rollover-${fixture}-calendar`)}, execution_date,
              terminal_at - interval '25 hours', terminal_at - interval '8 hours 30 minutes',
              terminal_at - interval '8 hours 30 minutes', terminal_at - interval '7 hours 30 minutes',
              terminal_at - interval '1 hour', terminal_at - interval '8 hours',
              'BLOCKED', NULL, NULL, 'BLOCKED_MISSED_PUBLICATION_DEADLINE', 1,
              terminal_at, terminal_at, terminal_at
            FROM timing
          `
            const [restrictionTime] = yield* sql<{ updated_at: Date }>`
            SELECT greatest(clock_timestamp(), updated_at + interval '1 millisecond') AS updated_at
            FROM authority_state
            WHERE singleton
          `
            if (restrictionTime === undefined) return yield* Effect.die(new Error('restriction time is unavailable'))
            yield* store.restrictAuthority(restrictionReason, restrictionTime.updated_at.toISOString())

            const beforeReceipt = yield* writerFence.transaction(
              blockedIntents.settleCurrentTerminalGeneration({
                accountId,
                observedAt: restrictionTime.updated_at.toISOString(),
              }),
            )
            const [receiptTime] = yield* sql<{ created_at: Date }>`SELECT clock_timestamp() AS created_at`
            if (receiptTime === undefined) return yield* Effect.die(new Error('receipt time is unavailable'))
            const createdAt = receiptTime.created_at.toISOString()
            yield* sql`
            INSERT INTO autonomous_forward_performance_receipts (
              authority_generation_hash, cycle_id, document, created_at
            ) VALUES (
              ${paper.generationHash},
              ${cycleId},
              ${sql.json(
                encodeSqlJson({
                  schemaVersion: 'bayn.forward-performance-receipt-envelope.v1',
                  authorityGenerationHash: paper.generationHash,
                  cycleId,
                  createdAt,
                  contentHash,
                  receiptHash,
                  receipt: { receiptHash },
                }),
              )},
              ${createdAt}
            )
          `
            const rolloverReconciliation = exactReconciliation(`receipt-rollover-${fixture}-after-terminal-settlement`)
            const reconcileAfterSettlement = Effect.gen(function* () {
              const stateHash = hash(`receipt-rollover-${fixture}-after-terminal-settlement-state`)
              yield* sql`
              INSERT INTO reconciliations (
                reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
                content_hash, status, discrepancies, reconciled_at
              )
              SELECT
                ${rolloverReconciliation.reconciliationId}, 'bayn.paper-reconciliation.v1', ${accountId},
                ${stateHash}, ${stateHash}, ${rolloverReconciliation.contentHash}, 'EXACT',
                ${sql.json(encodeSqlJson([]))}, greatest(clock_timestamp(), state.updated_at + interval '1 millisecond')
              FROM authority_state AS state
              WHERE state.singleton
            `
              yield* sql`SELECT pg_sleep(0.01)`
            }).pipe(
              Effect.mapError((cause) =>
                operationalError({
                  component: 'database',
                  operation: 'test-receipt-rollover',
                  message: 'test reconciliation write failed',
                  cause,
                }),
              ),
            )
            const rollover = yield* recoverTerminalGenerationToObserve({
              accountId,
              blockedIntents,
              authorityStore: store,
              writerFence,
              reconcileAfterSettlement,
            })
            const authority = yield* readAuthorityState
            const lineage = yield* readAuthorityGenerationLineage(authority.generationHash)
            return { authority, beforeReceipt, lineage, paper, rollover }
          }),
        )

        expect(result.beforeReceipt).toEqual({ _tag: 'NoTerminalGeneration' })
        expect(result.rollover).toMatchObject({
          _tag: 'RolledOver',
          previousGenerationHash: result.paper.generationHash,
        })
        expect(result.authority).toMatchObject({
          generationHash: result.rollover._tag === 'RolledOver' ? result.rollover.generationHash : '',
          maximum: Authority.Observe,
          effective: Authority.Observe,
          kill: KillState.Clear,
        })
        expect(result.lineage).toEqual({
          generationHash: result.authority.generationHash,
          previousGenerationHash: result.paper.generationHash,
          maximum: Authority.Observe,
        })
      } finally {
        await runtime.dispose()
      }
    },
    15_000,
  )

  test.each([
    [
      'a legacy broker-denial restriction',
      `bound PAPER cycle ${hash('legacy-denial-cycle')} restricted effective authority: intent ${hash('legacy-denial-intent')} submit settled denied`,
      'RolledOver',
    ],
    ['an operator kill', 'operator requested PAPER stop', 'NotRequired'],
    [
      'a malformed legacy restriction',
      `bound PAPER cycle short restricted effective authority: intent ${hash('malformed-legacy-intent')} submit settled denied`,
      'NotRequired',
    ],
  ] as const)(
    'handles %s through the durable terminal-generation recovery boundary',
    async (_fixture, reason, expectedTag) => {
      const configuredObserveGenerationHash = hash(`restriction-classification-${_fixture}-observe`)
      const activationReconciliation = exactReconciliation(`restriction-classification-${_fixture}-activation`)
      const activation = makeResearchActivation(configuredObserveGenerationHash, activationReconciliation)
      const runtime = makeStoreRuntime(
        { fail: false, planHashes: [] },
        researchRuntimeConfig(configuredObserveGenerationHash),
      )
      try {
        const result = await runtime.runPromise(
          Effect.gen(function* () {
            const store = yield* ExecutionStore
            const blockedIntents = yield* BlockedCycleIntentStore
            const sql = yield* PgClient.PgClient
            const writerFence = yield* WriterFence
            const activateResearch = store.activateResearchCapitalGrant
            assert(activateResearch !== undefined, 'research PAPER activation must be implemented')

            yield* seedExactReconciliation(activationReconciliation)
            yield* store.ensureAuthorityGeneration({
              generationHash: configuredObserveGenerationHash,
              maximum: Authority.Observe,
            })
            const paper = yield* activateResearch(researchProofBinding(activation), configuredObserveGenerationHash)
            const [restrictionTime] = yield* sql<{ updated_at: Date }>`
            SELECT greatest(clock_timestamp(), updated_at + interval '1 millisecond') AS updated_at
            FROM authority_state
            WHERE singleton
          `
            if (restrictionTime === undefined) return yield* Effect.die(new Error('restriction time is unavailable'))
            yield* store.restrictAuthority(reason, restrictionTime.updated_at.toISOString())
            const reconciliation = exactReconciliation(`restriction-classification-${_fixture}-settlement`)
            const reconcileAfterSettlement = Effect.gen(function* () {
              const stateHash = hash(`restriction-classification-${_fixture}-state`)
              yield* sql`
                INSERT INTO reconciliations (
                  reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
                  content_hash, status, discrepancies, reconciled_at
                )
                SELECT
                  ${reconciliation.reconciliationId}, 'bayn.paper-reconciliation.v1', ${accountId},
                  ${stateHash}, ${stateHash}, ${reconciliation.contentHash}, 'EXACT',
                  ${sql.json(encodeSqlJson([]))}, greatest(clock_timestamp(), state.updated_at + interval '1 millisecond')
                FROM authority_state AS state
                WHERE state.singleton
              `
            }).pipe(
              Effect.mapError((cause) =>
                operationalError({
                  component: 'database',
                  operation: 'test-legacy-restriction-recovery',
                  message: 'test reconciliation write failed',
                  cause,
                }),
              ),
            )
            const recovery = yield* recoverTerminalGenerationToObserve({
              accountId,
              blockedIntents,
              authorityStore: store,
              writerFence,
              reconcileAfterSettlement,
            })
            const [authority] = yield* sql<{
              effective: Authority
              generation_hash: string
              kill_state: KillState
              maximum: Authority
              reason: string | null
            }>`
              SELECT generation_hash, maximum, effective, kill_state, reason
              FROM authority_state
              WHERE singleton
            `
            if (authority === undefined) return yield* Effect.die(new Error('authority state is unavailable'))
            return { authority, paper, recovery }
          }),
        )

        expect(result.recovery._tag).toBe(expectedTag)
        if (result.recovery._tag === 'RolledOver') {
          expect(result.recovery.previousGenerationHash).toBe(result.paper.generationHash)
          expect(result.authority).toEqual({
            effective: Authority.Observe,
            generation_hash: result.recovery.generationHash,
            kill_state: KillState.Clear,
            maximum: Authority.Observe,
            reason: null,
          })
        } else {
          expect(result.authority).toMatchObject({
            effective: Authority.Observe,
            generation_hash: result.paper.generationHash,
            kill_state: KillState.Active,
            maximum: Authority.Execution,
            reason,
          })
        }
      } finally {
        await runtime.dispose()
      }
    },
    15_000,
  )

  test('rotates a non-rearm research PAPER kill to OBSERVE without clearing it', async () => {
    const sourceGenerationHash = hash('operator-killed-research-paper-source')
    const nextSourceGenerationHash = hash('operator-killed-research-paper-next-source')
    const activationReconciliation = exactReconciliation('operator-killed-research-paper-activation')
    const activation = makeResearchActivation(sourceGenerationHash, activationReconciliation)
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] }, researchRuntimeConfig(sourceGenerationHash))
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const sql = yield* PgClient.PgClient
          const activateResearch = store.activateResearchCapitalGrant
          assert(activateResearch !== undefined, 'research PAPER activation must be implemented')

          yield* seedExactReconciliation(activationReconciliation)
          yield* store.ensureAuthorityGeneration({
            generationHash: sourceGenerationHash,
            maximum: Authority.Observe,
          })
          yield* activateResearch(researchProofBinding(activation), sourceGenerationHash)
          const [restrictionTime] = yield* sql<{ updated_at: Date }>`
            SELECT greatest(clock_timestamp(), updated_at + interval '1 millisecond') AS updated_at
            FROM authority_state
            WHERE singleton
          `
          if (restrictionTime === undefined) return yield* Effect.die(new Error('restriction time is unavailable'))
          yield* store.restrictAuthority('operator requested PAPER stop', restrictionTime.updated_at.toISOString())

          return yield* store.ensureAuthorityGeneration({
            generationHash: nextSourceGenerationHash,
            maximum: Authority.Observe,
          })
        }),
      )

      expect(result).toMatchObject({
        generationHash: nextSourceGenerationHash,
        maximum: Authority.Observe,
        effective: Authority.Observe,
        kill: KillState.Active,
        reason: 'operator requested PAPER stop',
      })
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('activates PAPER after fresh exact reconciliation covers terminal cancel mutation history', async () => {
    const initialGenerationHash = hash('terminal-canceled-observe-generation')
    const reconciliation = exactReconciliation('terminal-canceled-paper')
    const expected = makeActivation(initialGenerationHash, qualifiedEvidence, reconciliation)
    const prepareRuntime = makeStoreRuntime({ fail: false, planHashes: [] }, prepareRuntimeConfig(expected))
    const preparation = await (async () => {
      try {
        return await prepareRuntime.runPromise(
          Effect.gen(function* () {
            const store = yield* ExecutionStore
            const sql = yield* PgClient.PgClient
            yield* seedQualificationEvidence(qualifiedEvidence)
            yield* store.ensureAuthorityGeneration({
              generationHash: initialGenerationHash,
              maximum: Authority.Observe,
            })
            yield* seedTerminalCanceledMutation(initialGenerationHash)
            yield* seedExactReconciliation(reconciliation)
            const prepared = yield* store.prepareCapitalGrant(proofBinding(expected))
            const [history] = yield* sql<{ event_count: number; latest_mutation_at: Date }>`
              SELECT
                count(*)::integer AS event_count,
                max(occurred_at) AS latest_mutation_at
              FROM mutation_events
            `
            return { history, prepared }
          }),
        )
      } finally {
        await prepareRuntime.dispose()
      }
    })()

    expect(preparation.prepared).toEqual(expected)
    expect(preparation.history.event_count).toBe(6)

    const activationRuntime = makeActivationRuntime({ fail: false, planHashes: [] }, preparation.prepared)
    try {
      const result = await activationRuntime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const sql = yield* PgClient.PgClient
          const [reconciliationRow] = yield* sql<{ reconciled_at: Date }>`
            SELECT reconciled_at
            FROM reconciliations
            WHERE reconciliation_id = ${reconciliation.reconciliationId}
          `
          const activated = yield* store.activateCapitalGrant(proofBinding(preparation.prepared))
          return { activated, reconciliationRow }
        }),
      )

      expect(result.reconciliationRow.reconciled_at.getTime()).toBeGreaterThanOrEqual(
        preparation.history.latest_mutation_at.getTime(),
      )
      expect(result.activated).toMatchObject({
        generationHash: preparation.prepared.generationHash,
        maximum: Authority.Execution,
        effective: Authority.Execution,
        version: 2,
      })
    } finally {
      await activationRuntime.dispose()
    }
  }, 15_000)

  test('rejects PREPARE when configured OBSERVE generation is not current without writing', async () => {
    const initialGenerationHash = hash('prepare-config-mismatch-observe')
    const reconciliation = exactReconciliation('prepare-config-mismatch')
    const expected = makeActivation(initialGenerationHash, qualifiedEvidence, reconciliation)
    const setupRuntime = makeStoreRuntime({ fail: false, planHashes: [] }, prepareRuntimeConfig(expected))
    try {
      await setupRuntime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          yield* seedQualificationEvidence(qualifiedEvidence)
          yield* seedExactReconciliation(reconciliation)
          yield* store.ensureAuthorityGeneration({
            generationHash: initialGenerationHash,
            maximum: Authority.Observe,
          })
        }),
      )
    } finally {
      await setupRuntime.dispose()
    }

    const validConfig = prepareRuntimeConfig(expected)
    const validAlpaca = validConfig.alpaca
    if (validAlpaca === undefined) {
      throw new Error('capital grant PREPARE fixture requires an Alpaca binding')
    }
    const runtime = makeStoreRuntime(
      { fail: false, planHashes: [] },
      {
        ...validConfig,
        alpaca: {
          ...validAlpaca,
          authorityGenerationHash: hash('wrong-current-observe-generation'),
        },
      },
    )
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const before = yield* readAuthorityTupleEvidence
          const failure = yield* Effect.flip(store.prepareCapitalGrant(proofBinding(expected)))
          const after = yield* readAuthorityTupleEvidence
          return { after, before, failure }
        }),
      )
      expect(result.failure).toMatchObject({
        operation: 'authority',
        failure: 'invariant',
        message: 'capital grant PREPARE current authority differs from the configured OBSERVE generation',
      })
      expect(result.after).toEqual(result.before)
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('keeps generation identity stable while activation records the latest exact reconciliation', async () => {
    const initialGenerationHash = hash('prepare-reconciliation-drift-observe')
    const reconciliation = exactReconciliation('prepare-reconciliation-drift')
    const activationReconciliation = exactReconciliation('post-prepare-reconciliation')
    const expected = makeActivation(initialGenerationHash, qualifiedEvidence, reconciliation)
    const prepareRuntime = makeStoreRuntime({ fail: false, planHashes: [] }, prepareRuntimeConfig(expected))
    const preparation = await (async () => {
      try {
        return await prepareRuntime.runPromise(
          Effect.gen(function* () {
            const store = yield* ExecutionStore
            yield* seedQualificationEvidence(qualifiedEvidence)
            yield* seedExactReconciliation(reconciliation)
            yield* store.ensureAuthorityGeneration({
              generationHash: initialGenerationHash,
              maximum: Authority.Observe,
            })
            const before = yield* readAuthorityTupleEvidence
            const prepared = yield* store.prepareCapitalGrant(proofBinding(expected))
            yield* seedExactReconciliation(activationReconciliation)
            const refreshed = yield* store.prepareCapitalGrant(proofBinding(expected))
            const after = yield* readAuthorityTupleEvidence
            return { after, before, prepared, refreshed }
          }),
        )
      } finally {
        await prepareRuntime.dispose()
      }
    })()

    expect(preparation.after).toEqual(preparation.before)
    expect(preparation.refreshed.generationHash).toBe(preparation.prepared.generationHash)
    expect(preparation.refreshed).toMatchObject({
      reconciliationContentHash: activationReconciliation.contentHash,
      reconciliationId: activationReconciliation.reconciliationId,
    })

    const activationRuntime = makeActivationRuntime({ fail: false, planHashes: [] }, preparation.prepared)
    try {
      const result = await activationRuntime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const before = yield* readAuthorityTupleEvidence
          const activated = yield* store.activateCapitalGrant(proofBinding(preparation.prepared))
          const after = yield* readAuthorityTupleEvidence
          const sql = yield* PgClient.PgClient
          const [history] = yield* sql<{ reconciliation_content_hash: string; reconciliation_id: string }>`
            SELECT reconciliation_id, reconciliation_content_hash
            FROM authority_generations
            WHERE generation_hash = ${preparation.prepared.generationHash}
          `
          return { activated, after, before, history }
        }),
      )
      expect(result.activated).toMatchObject({
        generationHash: preparation.prepared.generationHash,
        maximum: Authority.Execution,
        effective: Authority.Execution,
      })
      expect(result.after).not.toEqual(result.before)
      expect(result.history).toEqual({
        reconciliation_id: activationReconciliation.reconciliationId,
        reconciliation_content_hash: activationReconciliation.contentHash,
      })
      expect(result.history.reconciliation_id).not.toBe(preparation.prepared.reconciliationId)
    } finally {
      await activationRuntime.dispose()
    }
  }, 15_000)

  test('rejects current-generation drift between PREPARE and activation without further writes', async () => {
    const initialGenerationHash = hash('prepare-generation-drift-observe')
    const reconciliation = exactReconciliation('prepare-generation-drift')
    const expected = makeActivation(initialGenerationHash, qualifiedEvidence, reconciliation)
    const prepareRuntime = makeStoreRuntime({ fail: false, planHashes: [] }, prepareRuntimeConfig(expected))
    const prepared = await (async () => {
      try {
        return await prepareRuntime.runPromise(
          Effect.gen(function* () {
            const store = yield* ExecutionStore
            yield* seedQualificationEvidence(qualifiedEvidence)
            yield* seedExactReconciliation(reconciliation)
            yield* store.ensureAuthorityGeneration({
              generationHash: initialGenerationHash,
              maximum: Authority.Observe,
            })
            const receipt = yield* store.prepareCapitalGrant(proofBinding(expected))
            yield* store.ensureAuthorityGeneration({
              generationHash: hash('post-prepare-observe-generation'),
              maximum: Authority.Observe,
            })
            return receipt
          }),
        )
      } finally {
        await prepareRuntime.dispose()
      }
    })()

    const activationRuntime = makeActivationRuntime({ fail: false, planHashes: [] }, prepared)
    try {
      const result = await activationRuntime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const before = yield* readAuthorityTupleEvidence
          const failure = yield* Effect.flip(
            store.activatePreparedCapitalGrant(proofBinding(prepared), {
              generationHash: prepared.generationHash,
              sourceGenerationHash: initialGenerationHash,
            }),
          )
          const after = yield* readAuthorityTupleEvidence
          return { after, before, failure }
        }),
      )
      expect(result.failure).toMatchObject({
        operation: 'authority',
        failure: 'invariant',
        message: 'capital grant PREPARE current authority differs from the configured OBSERVE generation',
      })
      expect(result.after).toEqual(result.before)
    } finally {
      await activationRuntime.dispose()
    }
  }, 15_000)

  test('requires the exact configured PAPER activation binding before any authority write', async () => {
    const initialGenerationHash = hash('configured-paper-binding-observe-generation')
    const reconciliation = exactReconciliation('configured-paper-binding')
    const activation = makeActivation(initialGenerationHash, qualifiedEvidence, reconciliation)
    const setupRuntime = makeStoreRuntime({ fail: false, planHashes: [] })
    const validConfig = paperRuntimeConfig(activation)
    const validAlpaca = validConfig.alpaca
    if (validAlpaca === undefined) {
      throw new Error('valid PAPER activation config requires an Alpaca binding')
    }
    const { alpaca: _alpaca, ...missingAlpacaConfig } = validConfig
    const invalidConfigs: readonly RuntimeConfig[] = [
      {
        ...validConfig,
        execution: {
          brokerIdentity: validAlpaca.identity,
          brokerAccess: BrokerAccess.ReadOnly,
          capitalAuthority: noCapitalAuthority,
        },
      },
      missingAlpacaConfig,
      {
        ...validConfig,
        alpaca: {
          ...validAlpaca,
          authorityGenerationHash: hash('wrong-configured-paper-generation'),
        },
      },
      {
        ...validConfig,
        alpaca: {
          ...validAlpaca,
          expectedAccountId: 'wrong-configured-paper-account',
        },
      },
      { ...validConfig, qualificationRunId: hash('wrong-configured-qualification-run') },
    ]
    const readAuthorityEvidence = Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const [evidence] = yield* sql<{ authority: unknown; history: unknown }>`
        SELECT
          (
            SELECT jsonb_agg(
              jsonb_build_object('row', to_jsonb(authority), 'tupleId', authority.xmin::text)
            )
            FROM authority_state AS authority
          ) AS authority,
          (
            SELECT jsonb_agg(
              jsonb_build_object('row', to_jsonb(history), 'tupleId', history.xmin::text)
              ORDER BY history.authority_version
            )
            FROM authority_generations AS history
          ) AS history
      `
      return evidence
    })
    const before = await (async () => {
      try {
        return await setupRuntime.runPromise(
          Effect.gen(function* () {
            const store = yield* ExecutionStore
            yield* seedQualificationEvidence(qualifiedEvidence)
            yield* seedExactReconciliation(reconciliation)
            yield* store.ensureAuthorityGeneration({
              generationHash: initialGenerationHash,
              maximum: Authority.Observe,
            })
            return yield* readAuthorityEvidence
          }),
        )
      } finally {
        await setupRuntime.dispose()
      }
    })()
    const failures = []
    for (const invalidConfig of invalidConfigs) {
      const runtime = makeStoreRuntime({ fail: false, planHashes: [] }, invalidConfig)
      try {
        failures.push(
          await runtime.runPromise(
            Effect.flatMap(ExecutionStore, (store) =>
              Effect.flip(store.activateCapitalGrant(proofBinding(activation))),
            ),
          ),
        )
      } finally {
        await runtime.dispose()
      }
    }
    const wrongBuildActivation = makeActivation(initialGenerationHash, qualifiedEvidence, reconciliation, {
      activationSourceRevision: 'f'.repeat(40),
    })
    const wrongBuildRuntime = makeActivationRuntime({ fail: false, planHashes: [] }, wrongBuildActivation)
    const wrongBuildFailure = await (async () => {
      try {
        return await wrongBuildRuntime.runPromise(
          Effect.flatMap(ExecutionStore, (store) =>
            Effect.flip(store.activateCapitalGrant(proofBinding(wrongBuildActivation))),
          ),
        )
      } finally {
        await wrongBuildRuntime.dispose()
      }
    })()
    const correctBuild = paperRuntimeConfig(activation).build
    const wrongStrategyRuntime = makeActivationRuntime({ fail: false, planHashes: [] }, activation, {
      build: {
        ...correctBuild,
        strategyBehaviorHash: hash('wrong-current-strategy-behavior'),
      },
    })
    const wrongStrategyFailure = await (async () => {
      try {
        return await wrongStrategyRuntime.runPromise(
          Effect.flatMap(ExecutionStore, (store) => Effect.flip(store.activateCapitalGrant(proofBinding(activation)))),
        )
      } finally {
        await wrongStrategyRuntime.dispose()
      }
    })()
    const client = makeClientRuntime()
    const afterRejected = await (async () => {
      try {
        return await client.runPromise(readAuthorityEvidence)
      } finally {
        await client.dispose()
      }
    })()
    const correctRuntime = makeActivationRuntime({ fail: false, planHashes: [] }, activation)
    try {
      const activated = await correctRuntime.runPromise(
        Effect.flatMap(ExecutionStore, (store) => store.activateCapitalGrant(proofBinding(activation))),
      )
      expect(activated).toMatchObject({
        generationHash: activation.generationHash,
        maximum: Authority.Execution,
        effective: Authority.Execution,
        version: 2,
      })
    } finally {
      await correctRuntime.dispose()
    }

    expect(failures).toHaveLength(5)
    for (const failure of failures) {
      expect(failure).toMatchObject({
        operation: 'authority',
        failure: 'invariant',
      })
    }
    expect(wrongBuildFailure).toMatchObject({
      operation: 'authority',
      failure: 'invariant',
      message: 'derived capital grant generation differs from the configured generation',
    })
    expect(wrongStrategyFailure).toMatchObject({
      operation: 'authority',
      failure: 'invariant',
      message: 'capital grant generation differs from terminal qualification evidence or current strategy build',
    })
    expect(afterRejected).toEqual(before)
  }, 15_000)

  test('activates one exact QUALIFIED execution generation and replays it without writing', async () => {
    const initialGenerationHash = hash('paper-activation-observe-generation')
    const reconciliation = exactReconciliation('paper-activation')
    const activation = makeActivation(initialGenerationHash, qualifiedEvidence, reconciliation)
    const runtime = makeActivationRuntime({ fail: false, planHashes: [] }, activation)
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const sql = yield* PgClient.PgClient
          yield* seedQualificationEvidence(qualifiedEvidence)
          yield* seedExactReconciliation(reconciliation)
          const observe = yield* store.ensureAuthorityGeneration({
            generationHash: initialGenerationHash,
            maximum: Authority.Observe,
          })
          const activated = yield* store.activateCapitalGrant(proofBinding(activation))
          const beforeReplay = yield* readAuthorityTupleEvidence
          yield* seedExactReconciliation(exactReconciliation('paper-replay-later-reconciliation'))
          const replay = yield* store.activateCapitalGrant(proofBinding(activation))
          const changedProof = yield* Effect.flip(
            store.activateCapitalGrant({
              ...proofBinding(activation),
              proofPlanHash: hash('paper-replay-changed-proof'),
            }),
          )
          const afterReplay = yield* readAuthorityTupleEvidence
          const history = yield* sql<{
            account_id: string | null
            activation_image_digest: string | null
            activation_image_repository: string | null
            activation_source_revision: string | null
            authority_version: number
            generation_hash: string
            maximum: string
            previous_generation_hash: string | null
            proof_plan_hash: string | null
            qualification_image_digest: string | null
            qualification_image_repository: string | null
            qualification_result_hash: string | null
            qualification_source_revision: string | null
            risk_policy_hash: string | null
          }>`
            SELECT
              generation_hash, previous_generation_hash, maximum,
              authority_version::integer, qualification_result_hash, account_id,
              risk_policy_hash, proof_plan_hash, qualification_source_revision,
              qualification_image_repository, qualification_image_digest,
              activation_source_revision, activation_image_repository, activation_image_digest
            FROM authority_generations
            ORDER BY authority_version
          `
          const mutateHistory = yield* Effect.exit(sql`
            UPDATE authority_generations
            SET proof_plan_hash = ${hash('mutated-proof-plan')}
            WHERE generation_hash = ${activation.generationHash}
          `)
          const deleteHistory = yield* Effect.exit(sql`
            DELETE FROM authority_generations
            WHERE generation_hash = ${activation.generationHash}
          `)
          const truncateHistory = yield* Effect.exit(sql`TRUNCATE authority_generations CASCADE`)
          return {
            activated,
            activation,
            afterReplay,
            beforeReplay,
            changedProof,
            deleteHistory,
            history,
            mutateHistory,
            observe,
            replay,
            truncateHistory,
          }
        }),
      )

      expect(result.activated).toEqual({
        ...result.observe,
        generationHash: result.activation.generationHash,
        maximum: Authority.Execution,
        effective: Authority.Execution,
        version: 2,
        updatedAt: expect.any(String),
      })
      expect(result.replay).toEqual(result.activated)
      expect(result.changedProof).toMatchObject({ operation: 'authority', failure: 'conflict' })
      expect(result.afterReplay).toEqual(result.beforeReplay)
      expect(Exit.isFailure(result.mutateHistory)).toBe(true)
      expect(Exit.isFailure(result.deleteHistory)).toBe(true)
      expect(Exit.isFailure(result.truncateHistory)).toBe(true)
      expect(result.history).toEqual([
        {
          generation_hash: result.observe.generationHash,
          previous_generation_hash: null,
          maximum: Authority.Observe,
          authority_version: 1,
          qualification_result_hash: null,
          account_id: accountId,
          risk_policy_hash: null,
          proof_plan_hash: null,
          qualification_source_revision: null,
          qualification_image_repository: null,
          qualification_image_digest: null,
          activation_source_revision: null,
          activation_image_repository: null,
          activation_image_digest: null,
        },
        {
          generation_hash: result.activation.generationHash,
          previous_generation_hash: result.observe.generationHash,
          maximum: Authority.Execution,
          authority_version: 2,
          qualification_result_hash: qualifiedEvidence.result.resultHash,
          account_id: accountId,
          risk_policy_hash: result.activation.riskPolicyHash,
          proof_plan_hash: result.activation.proofPlanHash,
          qualification_source_revision: qualifiedEvidence.lock.sourceRevision,
          qualification_image_repository: qualifiedEvidence.lock.image.repository,
          qualification_image_digest: qualifiedEvidence.lock.image.digest,
          activation_source_revision: config.build.sourceRevision,
          activation_image_repository: config.build.imageRepository,
          activation_image_digest: config.build.imageDigest,
        },
      ])
      expect(result.history[1]?.authority_version).toBe(result.activated.version)
      expect(result.activation.qualificationSourceRevision).not.toBe(result.activation.activationSourceRevision)
      expect(result.activation.qualificationImageRepository).not.toBe(result.activation.activationImageRepository)
      expect(result.activation.qualificationImageDigest).not.toBe(result.activation.activationImageDigest)
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('rejects PAPER activation version exhaustion without changing authority bytes or xmin', async () => {
    const initialGenerationHash = hash('paper-version-exhaustion-observe-generation')
    const reconciliation = exactReconciliation('paper-version-exhaustion')
    const activation = makeActivation(initialGenerationHash, qualifiedEvidence, reconciliation)
    const runtime = makeActivationRuntime({ fail: false, planHashes: [] }, activation)
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const sql = yield* PgClient.PgClient
          yield* seedQualificationEvidence(qualifiedEvidence)
          yield* seedExactReconciliation(reconciliation)
          yield* store.ensureAuthorityGeneration({
            generationHash: initialGenerationHash,
            maximum: Authority.Observe,
          })
          yield* sql`ALTER TABLE authority_generations DISABLE TRIGGER authority_generations_append_only`
          yield* sql`ALTER TABLE authority_state DISABLE TRIGGER authority_transition_only`
          yield* sql`
            UPDATE authority_generations
            SET authority_version = ${Number.MAX_SAFE_INTEGER}
            WHERE generation_hash = ${initialGenerationHash}
          `
          yield* sql`
            UPDATE authority_state
            SET version = ${Number.MAX_SAFE_INTEGER}
            WHERE singleton
          `
          yield* sql`ALTER TABLE authority_state ENABLE TRIGGER authority_transition_only`
          yield* sql`ALTER TABLE authority_generations ENABLE TRIGGER authority_generations_append_only`
          const before = yield* readAuthorityTupleEvidence
          const failure = yield* Effect.flip(store.activateCapitalGrant(proofBinding(activation)))
          const after = yield* readAuthorityTupleEvidence
          return { after, before, failure }
        }),
      )

      expect(result.before.authority?.[0]?.row['version']).toBe(Number.MAX_SAFE_INTEGER)
      expect(result.before.history?.[0]?.row['authority_version']).toBe(Number.MAX_SAFE_INTEGER)
      expect(result.failure).toMatchObject({
        operation: 'authority',
        failure: 'invariant',
        message: 'durable authority version is not a safe positive integer',
      })
      expect(result.after).toEqual(result.before)
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('preserves authority failure causes and rolls back defects and interruptions before commit', async () => {
    const initialGenerationHash = hash('authority-effect-boundary-observe-generation')
    const reconciliation = exactReconciliation('authority-effect-boundary')
    const activation = makeActivation(initialGenerationHash, qualifiedEvidence, reconciliation)
    const setupRuntime = makeActivationRuntime({ fail: false, planHashes: [] }, activation)
    try {
      await setupRuntime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          yield* seedQualificationEvidence(qualifiedEvidence)
          yield* seedExactReconciliation(reconciliation)
          yield* store.ensureAuthorityGeneration({
            generationHash: initialGenerationHash,
            maximum: Authority.Observe,
          })
        }),
      )
    } finally {
      await setupRuntime.dispose()
    }

    const client = makeClientRuntime()
    const before = await client.runPromise(readAuthorityTupleEvidence)
    const derivationCause = new Error('injected capital grant generation derivation failure')
    const validRuntimeConfig = paperRuntimeConfig(activation)
    const closedFailureRuntime = makeStoreRuntime(
      { fail: false, planHashes: [] },
      {
        ...validRuntimeConfig,
        build: {
          get sourceRevision(): string {
            throw derivationCause
          },
          imageRepository: validRuntimeConfig.build.imageRepository,
          imageDigest: validRuntimeConfig.build.imageDigest,
          strategyBehaviorHash: validRuntimeConfig.build.strategyBehaviorHash,
          strategyParameterHash: validRuntimeConfig.build.strategyParameterHash,
          verification: validRuntimeConfig.build.verification,
        },
      },
    )
    const defect = new Error('injected post-activation transaction defect')
    const defectRuntime = makeIndependentStoreRuntime({ fail: false, planHashes: [] }, validRuntimeConfig, {
      _tag: 'DieAfterBody',
      defect,
    })
    const interruptRuntime = makeIndependentStoreRuntime({ fail: false, planHashes: [] }, validRuntimeConfig, {
      _tag: 'InterruptAfterBody',
    })
    try {
      const closedExit = await closedFailureRuntime.runPromise(
        Effect.exit(Effect.flatMap(ExecutionStore, (store) => store.activateCapitalGrant(proofBinding(activation)))),
      )
      expect(Exit.isFailure(closedExit)).toBe(true)
      if (Exit.isSuccess(closedExit)) throw new Error('expected closed authority failure')
      const closedError = Cause.findError(closedExit.cause)
      expect(Result.isSuccess(closedError)).toBe(true)
      if (Result.isFailure(closedError)) throw new Error('expected typed ExecutionStoreError')
      expect(closedError.success).toBeInstanceOf(ExecutionStoreError)
      expect(closedError.success).toMatchObject({
        operation: 'authority',
        failure: 'decode',
        message: 'derived capital grant generation is invalid: injected capital grant generation derivation failure',
      })
      expect(closedError.success.cause).toBe(derivationCause)
      expect(Cause.hasDies(closedExit.cause)).toBe(false)
      expect(await client.runPromise(readAuthorityTupleEvidence)).toEqual(before)

      const defectExit = await defectRuntime.runPromise(
        Effect.exit(Effect.flatMap(ExecutionStore, (store) => store.activateCapitalGrant(proofBinding(activation)))),
      )
      expect(Exit.isFailure(defectExit)).toBe(true)
      if (Exit.isSuccess(defectExit)) throw new Error('expected authority transaction defect')
      const observedDefect = Cause.findDefect(defectExit.cause)
      expect(Result.isSuccess(observedDefect)).toBe(true)
      if (Result.isFailure(observedDefect)) throw new Error('expected defect cause')
      expect(observedDefect.success).toBe(defect)
      expect(Cause.hasFails(defectExit.cause)).toBe(false)
      expect(await client.runPromise(readAuthorityTupleEvidence)).toEqual(before)

      const interruptExit = await interruptRuntime.runPromise(
        Effect.exit(Effect.flatMap(ExecutionStore, (store) => store.activateCapitalGrant(proofBinding(activation)))),
      )
      expect(Exit.isFailure(interruptExit)).toBe(true)
      if (Exit.isSuccess(interruptExit)) throw new Error('expected authority transaction interruption')
      expect(Cause.hasInterrupts(interruptExit.cause)).toBe(true)
      expect(Cause.hasDies(interruptExit.cause)).toBe(false)
      expect(Cause.hasFails(interruptExit.cause)).toBe(false)
      expect(await client.runPromise(readAuthorityTupleEvidence)).toEqual(before)
    } finally {
      await closedFailureRuntime.dispose()
      await defectRuntime.dispose()
      await interruptRuntime.dispose()
      await client.dispose()
    }
  }, 15_000)

  test('rejects changed configured replay identity byte-identically', async () => {
    const initialGenerationHash = hash('paper-replay-config-observe-generation')
    const reconciliation = exactReconciliation('paper-replay-config')
    const activation = makeActivation(initialGenerationHash, qualifiedEvidence, reconciliation)
    const activationRuntime = makeActivationRuntime({ fail: false, planHashes: [] }, activation)
    try {
      await activationRuntime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          yield* seedQualificationEvidence(qualifiedEvidence)
          yield* seedExactReconciliation(reconciliation)
          yield* store.ensureAuthorityGeneration({
            generationHash: initialGenerationHash,
            maximum: Authority.Observe,
          })
          yield* store.activateCapitalGrant(proofBinding(activation))
        }),
      )
    } finally {
      await activationRuntime.dispose()
    }

    const validConfig = paperRuntimeConfig(activation)
    const validAlpaca = validConfig.alpaca
    if (validAlpaca === undefined) {
      throw new Error('PAPER replay fixture requires an Alpaca binding')
    }
    const replayRuntime = makeStoreRuntime(
      { fail: false, planHashes: [] },
      {
        ...validConfig,
        alpaca: {
          ...validAlpaca,
          expectedAccountId: 'changed-replay-account',
        },
      },
    )
    try {
      const result = await replayRuntime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const before = yield* readAuthorityTupleEvidence
          const failure = yield* Effect.flip(store.activateCapitalGrant(proofBinding(activation)))
          const after = yield* readAuthorityTupleEvidence
          return { after, before, failure }
        }),
      )
      expect(result.failure).toMatchObject({ operation: 'authority', failure: 'conflict' })
      expect(result.after).toEqual(result.before)
    } finally {
      await replayRuntime.dispose()
    }
  }, 15_000)

  test('rejects the exact reconciliation staleness boundary and future database time without writing', async () => {
    const initialGenerationHash = hash('reconciliation-time-observe-generation')
    const staleReconciliation = exactReconciliation('stale-reconciliation-time', config.reconciliationStaleThresholdMs)
    const staleActivation = makeActivation(initialGenerationHash, qualifiedEvidence, staleReconciliation)
    const staleRuntime = makeActivationRuntime({ fail: false, planHashes: [] }, staleActivation)
    const readAuthorityEvidence = Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const [evidence] = yield* sql<{ authority: unknown; history: unknown }>`
        SELECT
          (SELECT jsonb_agg(to_jsonb(authority)) FROM authority_state AS authority) AS authority,
          (
            SELECT jsonb_agg(to_jsonb(history) ORDER BY history.authority_version)
            FROM authority_generations AS history
          ) AS history
      `
      return evidence
    })
    const staleResult = await (async () => {
      try {
        return await staleRuntime.runPromise(
          Effect.gen(function* () {
            const store = yield* ExecutionStore
            yield* seedQualificationEvidence(qualifiedEvidence)
            yield* store.ensureAuthorityGeneration({
              generationHash: initialGenerationHash,
              maximum: Authority.Observe,
            })
            const before = yield* readAuthorityEvidence
            yield* seedExactReconciliation(staleReconciliation)
            const failure = yield* Effect.flip(store.activateCapitalGrant(proofBinding(staleActivation)))
            const after = yield* readAuthorityEvidence
            return { after, before, failure }
          }),
        )
      } finally {
        await staleRuntime.dispose()
      }
    })()
    const futureReconciliation = exactReconciliation('future-reconciliation-time', -60_000)
    const futureActivation = makeActivation(initialGenerationHash, qualifiedEvidence, futureReconciliation)
    const futureRuntime = makeActivationRuntime({ fail: false, planHashes: [] }, futureActivation)
    try {
      const futureResult = await futureRuntime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          yield* seedExactReconciliation(futureReconciliation)
          const failure = yield* Effect.flip(store.activateCapitalGrant(proofBinding(futureActivation)))
          const after = yield* readAuthorityEvidence
          return { after, failure }
        }),
      )

      expect(staleResult.failure).toMatchObject({
        operation: 'authority',
        failure: 'invariant',
        message: 'capital grant generation requires the latest fresh exact account reconciliation',
      })
      expect(futureResult.failure).toMatchObject({
        operation: 'authority',
        failure: 'invariant',
        message: 'capital grant generation requires the latest fresh exact account reconciliation',
      })
      expect(staleResult.after).toEqual(staleResult.before)
      expect(futureResult.after).toEqual(staleResult.before)
    } finally {
      await futureRuntime.dispose()
    }
  }, 15_000)

  test('resamples database time after prerequisite lock waits before accepting reconciliation freshness', async () => {
    const initialGenerationHash = hash('delayed-reconciliation-observe-generation')
    const reconciliation = exactReconciliation('delayed-reconciliation')
    const paperActivation = makeActivation(initialGenerationHash, qualifiedEvidence, reconciliation)
    const runtime = makeActivationRuntime({ fail: false, planHashes: [] }, paperActivation, {
      reconciliationStaleThresholdMs: 250,
    })
    const blocker = makeClientRuntime()
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const sql = yield* PgClient.PgClient
          yield* seedQualificationEvidence(qualifiedEvidence)
          yield* seedExactReconciliation(reconciliation)
          yield* store.ensureAuthorityGeneration({
            generationHash: initialGenerationHash,
            maximum: Authority.Observe,
          })
          const readAuthorityEvidence = sql<{ authority: unknown; history: unknown }>`
            SELECT
              (SELECT jsonb_agg(to_jsonb(authority)) FROM authority_state AS authority) AS authority,
              (
                SELECT jsonb_agg(to_jsonb(history) ORDER BY history.authority_version)
                FROM authority_generations AS history
              ) AS history
          `
          const [before] = yield* readAuthorityEvidence
          const lockHeld = yield* Deferred.make<void>()
          const releaseLock = yield* Deferred.make<void>()
          const lockHolder = yield* Effect.forkChild(
            Effect.promise(() =>
              blocker.runPromise(
                Effect.gen(function* () {
                  const blockerSql = yield* PgClient.PgClient
                  yield* blockerSql.withTransaction(
                    Effect.gen(function* () {
                      yield* blockerSql`LOCK TABLE status_history IN ACCESS EXCLUSIVE MODE`
                      yield* Deferred.succeed(lockHeld, undefined)
                      yield* Deferred.await(releaseLock)
                    }),
                  )
                }),
              ),
            ),
            { startImmediately: true },
          )
          yield* Deferred.await(lockHeld)
          return yield* Effect.gen(function* () {
            const activationFiber = yield* Effect.forkChild(
              Effect.exit(store.activateCapitalGrant(proofBinding(paperActivation))),
              { startImmediately: true },
            )
            let waiting = false
            for (let attempt = 0; attempt < 200; attempt += 1) {
              const activities = yield* sql<{ query: string; wait_event_type: string | null }>`
                SELECT query, wait_event_type
                FROM pg_stat_activity
                WHERE pid <> pg_backend_pid()
                  AND datname = current_database()
                  AND wait_event_type = 'Lock'
                  AND query ILIKE '%LOCK TABLE%status_history%'
              `
              if (activities[0] !== undefined) {
                waiting = true
                break
              }
              yield* Effect.sleep(Duration.millis(10))
            }
            if (!waiting) {
              return yield* Effect.fail('PAPER activation did not wait on the qualification evidence lock')
            }
            yield* sql`SELECT pg_sleep(0.3)`
            yield* Deferred.succeed(releaseLock, undefined)
            yield* Fiber.join(lockHolder)
            const activationExit = yield* Fiber.join(activationFiber)
            const [after] = yield* readAuthorityEvidence
            return { activationExit, after, before }
          }).pipe(Effect.ensuring(Deferred.succeed(releaseLock, undefined).pipe(Effect.ignore)))
        }),
      )

      expect(Exit.isFailure(result.activationExit)).toBe(true)
      if (Exit.isFailure(result.activationExit)) {
        expect(Cause.pretty(result.activationExit.cause)).toContain(
          'capital grant generation requires the latest fresh exact account reconciliation',
        )
      }
      expect(result.after).toEqual(result.before)
    } finally {
      await blocker.dispose()
      await runtime.dispose()
    }
  }, 15_000)

  test('serializes independent-runtime PAPER activation into one history row and replay-equivalent state', async () => {
    const initialGenerationHash = hash('concurrent-paper-observe-generation')
    const reconciliation = exactReconciliation('concurrent-paper-activation')
    const activation = makeActivation(initialGenerationHash, qualifiedEvidence, reconciliation)
    const setupRuntime = makeActivationRuntime({ fail: false, planHashes: [] }, activation)
    try {
      await setupRuntime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          yield* seedQualificationEvidence(qualifiedEvidence)
          yield* seedExactReconciliation(reconciliation)
          yield* store.ensureAuthorityGeneration({
            generationHash: initialGenerationHash,
            maximum: Authority.Observe,
          })
        }),
      )
    } finally {
      await setupRuntime.dispose()
    }

    const runtimes = Array.from({ length: 4 }, () =>
      makeIndependentStoreRuntime({ fail: false, planHashes: [] }, paperRuntimeConfig(activation)),
    )
    const client = makeClientRuntime()
    try {
      const results = await Promise.all(
        runtimes.map((runtime) =>
          runtime.runPromise(
            Effect.gen(function* () {
              const fence = yield* WriterFence
              const store = yield* ExecutionStore
              const state = yield* store.activateCapitalGrant(proofBinding(activation))
              return { backendPid: fence.backendPid, state }
            }),
          ),
        ),
      )
      const stored = await client.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const [row] = yield* sql<{ history_count: number; paper_count: number; version: number }>`
            SELECT
              authority.version::integer AS version,
              (SELECT count(*)::integer FROM authority_generations) AS history_count,
              (
                SELECT count(*)::integer
                FROM authority_generations
                WHERE maximum = 'PAPER'
              ) AS paper_count
            FROM authority_state AS authority
          `
          const evidence = yield* readAuthorityTupleEvidence
          return { evidence, row }
        }),
      )

      expect(results).toHaveLength(4)
      expect(new Set(results.map(({ backendPid }) => backendPid)).size).toBe(4)
      expect(new Set(results.map(({ state }) => JSON.stringify(state))).size).toBe(1)
      expect(results[0]?.state).toMatchObject({
        maximum: Authority.Execution,
        effective: Authority.Execution,
        version: 2,
      })
      expect(stored.row).toEqual({ history_count: 2, paper_count: 1, version: 2 })
      expect(stored.evidence.authority).toHaveLength(1)
      expect(stored.evidence.authority?.[0]).toMatchObject({
        row: { generation_hash: activation.generationHash, version: 2 },
        tupleId: expect.any(String),
      })
      expect(stored.evidence.history).toHaveLength(2)
      expect(stored.evidence.history?.[1]).toMatchObject({
        row: { generation_hash: activation.generationHash, maximum: Authority.Execution },
        tupleId: expect.any(String),
      })
    } finally {
      await Promise.all(runtimes.map((runtime) => runtime.dispose()))
      await client.dispose()
    }
  }, 15_000)

  test('serializes an independent PAPER activation and OBSERVE rotation without mixed history', async () => {
    const initialGenerationHash = hash('activation-rotation-race-observe-generation')
    const rotatedGenerationHash = hash('activation-rotation-race-next-observe-generation')
    const reconciliation = exactReconciliation('activation-rotation-race')
    const activation = makeActivation(initialGenerationHash, qualifiedEvidence, reconciliation)
    const setupRuntime = makeActivationRuntime({ fail: false, planHashes: [] }, activation)
    try {
      await setupRuntime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          yield* seedQualificationEvidence(qualifiedEvidence)
          yield* seedExactReconciliation(reconciliation)
          yield* store.ensureAuthorityGeneration({
            generationHash: initialGenerationHash,
            maximum: Authority.Observe,
          })
        }),
      )
    } finally {
      await setupRuntime.dispose()
    }

    const activationRuntime = makeIndependentStoreRuntime(
      { fail: false, planHashes: [] },
      paperRuntimeConfig(activation),
    )
    const rotationRuntime = makeIndependentStoreRuntime({ fail: false, planHashes: [] }, config)
    const client = makeClientRuntime()
    let arrivals = 0
    const raceGate = Deferred.makeUnsafe<void>()
    const awaitRace = Effect.gen(function* () {
      arrivals += 1
      if (arrivals === 2) yield* Deferred.succeed(raceGate, undefined)
      yield* Deferred.await(raceGate)
    })
    try {
      const [activationExit, rotationExit] = await Promise.all([
        activationRuntime.runPromise(
          Effect.exit(
            awaitRace.pipe(
              Effect.andThen(
                Effect.flatMap(ExecutionStore, (store) => store.activateCapitalGrant(proofBinding(activation))),
              ),
            ),
          ),
        ),
        rotationRuntime.runPromise(
          Effect.exit(
            awaitRace.pipe(
              Effect.andThen(
                Effect.flatMap(ExecutionStore, (store) =>
                  store.ensureAuthorityGeneration({
                    generationHash: rotatedGenerationHash,
                    maximum: Authority.Observe,
                  }),
                ),
              ),
            ),
          ),
        ),
      ])
      expect(Exit.isSuccess(rotationExit)).toBe(true)
      if (Exit.isFailure(rotationExit)) {
        throw new Error(`OBSERVE rotation failed unexpectedly: ${Cause.pretty(rotationExit.cause)}`)
      }

      if (Exit.isFailure(activationExit)) {
        const activationFailure = Cause.findError(activationExit.cause)
        expect(Result.isSuccess(activationFailure)).toBe(true)
        if (Result.isFailure(activationFailure)) throw new Error('expected closed activation failure')
        expect(activationFailure.success).toMatchObject({
          operation: 'authority',
          failure: 'invariant',
          message: 'derived capital grant generation differs from the configured generation',
        })
      }

      const durable = await client.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const [state] = yield* sql<{
            generation_hash: string
            maximum: Authority
            effective: Authority
            version: number
          }>`
            SELECT generation_hash, maximum, effective, version::integer
            FROM authority_state
          `
          const history = yield* sql<{
            authority_version: number
            generation_hash: string
            maximum: Authority
            previous_generation_hash: string | null
          }>`
            SELECT
              authority_version::integer,
              generation_hash,
              maximum,
              previous_generation_hash
            FROM authority_generations
            ORDER BY authority_version
          `
          return { history, state }
        }),
      )
      const activationSucceeded = Exit.isSuccess(activationExit)
      expect(durable.state).toEqual({
        generation_hash: rotatedGenerationHash,
        maximum: Authority.Observe,
        effective: Authority.Observe,
        version: activationSucceeded ? 3 : 2,
      })
      expect(durable.history).toEqual(
        activationSucceeded
          ? [
              {
                authority_version: 1,
                generation_hash: initialGenerationHash,
                maximum: Authority.Observe,
                previous_generation_hash: null,
              },
              {
                authority_version: 2,
                generation_hash: activation.generationHash,
                maximum: Authority.Execution,
                previous_generation_hash: initialGenerationHash,
              },
              {
                authority_version: 3,
                generation_hash: rotatedGenerationHash,
                maximum: Authority.Observe,
                previous_generation_hash: activation.generationHash,
              },
            ]
          : [
              {
                authority_version: 1,
                generation_hash: initialGenerationHash,
                maximum: Authority.Observe,
                previous_generation_hash: null,
              },
              {
                authority_version: 2,
                generation_hash: rotatedGenerationHash,
                maximum: Authority.Observe,
                previous_generation_hash: initialGenerationHash,
              },
            ],
      )
    } finally {
      await activationRuntime.dispose()
      await rotationRuntime.dispose()
      await client.dispose()
    }
  }, 15_000)

  test('preserves an active kill exactly while rotating maximum authority to PAPER', async () => {
    const initialGenerationHash = hash('killed-paper-observe-generation')
    const reconciliation = exactReconciliation('killed-paper-activation')
    const activation = makeActivation(initialGenerationHash, qualifiedEvidence, reconciliation)
    const runtime = makeActivationRuntime({ fail: false, planHashes: [] }, activation)
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const sql = yield* PgClient.PgClient
          yield* seedQualificationEvidence(qualifiedEvidence)
          yield* seedExactReconciliation(reconciliation)
          yield* store.ensureAuthorityGeneration({
            generationHash: initialGenerationHash,
            maximum: Authority.Observe,
          })
          yield* sql`
            UPDATE authority_state
            SET
              kill_state = 'ACTIVE',
              reason = 'operator kill',
              version = version + 1,
              updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond')
            WHERE singleton
          `
          const [before] = yield* sql<{ kill_state: string; reason: string; updated_at: Date; version: number }>`
            SELECT kill_state, reason, updated_at, version::integer
            FROM authority_state
          `
          const activated = yield* store.activateCapitalGrant(proofBinding(activation))
          return { activated, before }
        }),
      )

      expect(result.activated).toMatchObject({
        maximum: Authority.Execution,
        effective: Authority.Observe,
        kill: KillState.Active,
        reason: result.before.reason,
        version: result.before.version + 1,
      })
      expect(Date.parse(result.activated.updatedAt)).toBeGreaterThan(result.before.updated_at.getTime())
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('rejects changed proof material and reconciliation drift without writing', async () => {
    const initialGenerationHash = hash('mismatch-paper-observe-generation')
    const reconciliation = exactReconciliation('mismatch-paper-activation')
    const activation = makeActivation(initialGenerationHash, qualifiedEvidence, reconciliation)
    const runtime = makeActivationRuntime({ fail: false, planHashes: [] }, activation)
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const sql = yield* PgClient.PgClient
          yield* seedQualificationEvidence(qualifiedEvidence)
          yield* seedExactReconciliation(reconciliation)
          yield* store.ensureAuthorityGeneration({
            generationHash: initialGenerationHash,
            maximum: Authority.Observe,
          })
          const before = yield* readAuthorityTupleEvidence
          const changedProof = yield* Effect.flip(
            store.activateCapitalGrant({
              ...proofBinding(activation),
              proofPlanHash: hash('changed-paper-proof-plan'),
            }),
          )
          yield* sql`
            INSERT INTO reconciliations (
              reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
              content_hash, status, discrepancies, reconciled_at
            ) VALUES (
              ${hash('later-discrepancy')}, 'bayn.paper-reconciliation.v1', ${accountId},
              ${hash('expected-state')}, ${hash('observed-state')}, ${hash('later-discrepancy-content')},
              'DISCREPANCY', ${sql.json(encodeSqlJson([{ discrepancyId: hash('discrepancy') }]))},
              clock_timestamp()
            )
          `
          const stale = yield* Effect.flip(store.activateCapitalGrant(proofBinding(activation)))
          const after = yield* readAuthorityTupleEvidence
          return { after, before, changedProof, stale }
        }),
      )

      expect(result.changedProof).toMatchObject({ operation: 'authority', failure: 'invariant' })
      expect(result.stale).toMatchObject({ operation: 'authority', failure: 'invariant' })
      expect(result.after).toEqual(result.before)
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('rejects REJECTED evidence and unresolved mutation state without changing authority history', async () => {
    const initialGenerationHash = hash('rejected-paper-observe-generation')
    const reconciliation = exactReconciliation('rejected-paper-activation')
    const rejectedActivation = makeActivation(initialGenerationHash, rejectedEvidence, reconciliation)
    const qualifiedActivation = makeActivation(initialGenerationHash, qualifiedEvidence, reconciliation)
    const rejectedRuntime = makeActivationRuntime({ fail: false, planHashes: [] }, rejectedActivation)
    const rejected = await (async () => {
      try {
        return await rejectedRuntime.runPromise(
          Effect.gen(function* () {
            const store = yield* ExecutionStore
            yield* seedQualificationEvidence(rejectedEvidence)
            yield* seedExactReconciliation(reconciliation)
            yield* store.ensureAuthorityGeneration({
              generationHash: initialGenerationHash,
              maximum: Authority.Observe,
            })
            return yield* Effect.flip(store.activateCapitalGrant(proofBinding(rejectedActivation)))
          }),
        )
      } finally {
        await rejectedRuntime.dispose()
      }
    })()
    const qualifiedRuntime = makeActivationRuntime({ fail: false, planHashes: [] }, qualifiedActivation)
    try {
      const result = await qualifiedRuntime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const sql = yield* PgClient.PgClient
          yield* sql`
            INSERT INTO intents (
              intent_id, schema_version, authority_generation_hash, account_id, client_order_id, symbol, side,
              order_type, time_in_force, quantity_micros, notional_limit_micros,
              state, state_version, created_at, updated_at,
              strategy_name, cycle_id, decision_hash, policy_hash
            ) VALUES (
              ${hash('unresolved-intent')}, 'bayn.paper-intent.v3', ${initialGenerationHash}, ${accountId},
              'unresolved-client-order', 'SPY', 'BUY', 'MARKET', 'DAY', 1000000, 100000000,
              'PLANNED', 1, '2026-07-22T15:30:03.000Z', '2026-07-22T15:30:03.000Z',
              'risk-balanced-trend', ${hash('unresolved-cycle')},
              ${hash('unresolved-decision')}, ${hash('unresolved-policy')}
            )
          `
          yield* sql`
            INSERT INTO mutation_events (
              event_id, schema_version, mutation_id, intent_id, sequence, operation, event_type,
              request_hash, consistency_delay_ms, occurred_at
            ) VALUES (
              ${hash('unresolved-event')}, 'bayn.paper-mutation-event.v1',
              ${hash('unresolved-mutation')}, ${hash('unresolved-intent')}, 1,
              'SUBMIT', 'SUBMIT_STARTED', ${hash('unresolved-request')}, 1000,
              '2026-07-22T15:30:04.000Z'
            )
          `
          yield* seedQualificationEvidence(qualifiedEvidence)
          const unresolved = yield* Effect.flip(store.activateCapitalGrant(proofBinding(qualifiedActivation)))
          const [stored] = yield* sql<{ generation_hash: string; history_count: number; version: number }>`
            SELECT
              generation_hash,
              version::integer,
              (SELECT count(*)::integer FROM authority_generations) AS history_count
            FROM authority_state
          `
          return { stored, unresolved }
        }),
      )

      expect(rejected).toMatchObject({ operation: 'authority', failure: 'invariant' })
      expect(result.unresolved).toMatchObject({ operation: 'authority', failure: 'invariant' })
      expect(result.stored).toEqual({
        generation_hash: hash('rejected-paper-observe-generation'),
        version: 1,
        history_count: 1,
      })
    } finally {
      await qualifiedRuntime.dispose()
    }
  }, 15_000)

  test('rejects A to B to A generation reuse after an OBSERVE return', async () => {
    const firstObserveHash = hash('authority-generation-a')
    const reconciliation = exactReconciliation('generation-reuse')
    const activation = makeActivation(firstObserveHash, qualifiedEvidence, reconciliation)
    const runtime = makeActivationRuntime({ fail: false, planHashes: [] }, activation)
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const returnObserveHash = hash('authority-generation-c')
          yield* seedQualificationEvidence(qualifiedEvidence)
          yield* seedExactReconciliation(reconciliation)
          yield* store.ensureAuthorityGeneration({
            generationHash: firstObserveHash,
            maximum: Authority.Observe,
          })
          yield* store.activateCapitalGrant(proofBinding(activation))
          const returned = yield* store.ensureAuthorityGeneration({
            generationHash: returnObserveHash,
            maximum: Authority.Observe,
          })
          const reused = yield* Effect.flip(
            store.ensureAuthorityGeneration({
              generationHash: firstObserveHash,
              maximum: Authority.Observe,
            }),
          )
          const sql = yield* PgClient.PgClient
          const history = yield* sql<{ generation_hash: string }>`
            SELECT generation_hash
            FROM authority_generations
            ORDER BY authority_version
          `
          return { history, returned, reused }
        }),
      )

      expect(result.returned).toMatchObject({
        generationHash: hash('authority-generation-c'),
        maximum: Authority.Observe,
        effective: Authority.Observe,
        version: 3,
      })
      expect(result.reused).toMatchObject({ operation: 'authority', failure: 'conflict' })
      expect(new Set(result.history.map((row) => row.generation_hash)).size).toBe(3)
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('appends typed broker events once and rejects conflicting source reuse', async () => {
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const baselineBefore = yield* store.hasAccountBaseline(accountId)
          const first = yield* store.ingest(accountEvent())
          const baselineAfter = yield* store.hasAccountBaseline(accountId)
          const replay = yield* store.ingest(accountEvent())
          const order = yield* store.ingest(orderEvent())
          const notionalOrder = yield* store.ingest(notionalOrderEvent())
          const conflict = yield* Effect.exit(
            store.ingest({ ...accountEvent(), contentHash: hash('conflicting-account-response') }),
          )
          const sql = yield* PgClient.PgClient
          const [counts] = yield* sql<{ accounts: number; events: number; orders: number }>`
            SELECT
              (SELECT count(*)::integer FROM broker_events) AS events,
              (SELECT count(*)::integer FROM account_snapshots) AS accounts,
              (SELECT count(*)::integer FROM orders) AS orders
          `
          const [storedNotional] = yield* sql<{
            schema_version: string
            quantity_micros: string | null
            notional_micros: string | null
          }>`
            SELECT schema_version, quantity_micros::text, notional_micros::text
            FROM orders
            WHERE broker_order_id = ${notionalOrderEvent().order.brokerOrderId}
          `
          const orderCheckConstraints = yield* sql<{ conname: string }>`
            SELECT conname
            FROM pg_constraint
            WHERE conrelid = 'orders'::regclass AND contype = 'c'
            ORDER BY conname COLLATE "C"
          `
          return {
            baselineAfter,
            baselineBefore,
            first,
            replay,
            order,
            notionalOrder,
            conflict,
            counts,
            storedNotional,
            orderCheckConstraints,
          }
        }),
      )

      expect(result.first).toMatchObject({ sourceSequence: '0', deduplicated: false })
      expect(result.baselineBefore).toBe(false)
      expect(result.baselineAfter).toBe(true)
      expect(result.replay).toEqual({ ...result.first, deduplicated: true })
      expect(result.order).toMatchObject({ sourceSequence: '1', deduplicated: false })
      expect(result.notionalOrder).toMatchObject({ sourceSequence: '2', deduplicated: false })
      expect(result.storedNotional).toEqual({
        schema_version: 'bayn.paper-order.v2',
        quantity_micros: null,
        notional_micros: '300000000',
      })
      const orderCheckConstraints = result.orderCheckConstraints.map((constraint) => constraint.conname)
      expect(orderCheckConstraints).not.toContain('orders_check')
      expect(orderCheckConstraints).not.toContain('orders_check1')
      expect(orderCheckConstraints).not.toContain('orders_check2')
      expect(orderCheckConstraints).toEqual(
        expect.arrayContaining([
          'orders_filled_quantity_micros_check',
          'orders_notional_micros_check',
          'orders_quantity_micros_check',
          'orders_request_representation_check',
          'orders_schema_version_check',
          'orders_status_quantity_check',
          'orders_type_price_check',
        ]),
      )
      expect(Exit.isFailure(result.conflict)).toBe(true)
      if (Exit.isFailure(result.conflict)) expect(Cause.pretty(result.conflict.cause)).toContain('different content')
      expect(result.counts).toEqual({ events: 3, accounts: 1, orders: 2 })
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('treats cancel history as newer than submit history when broker timestamps tie', async () => {
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    const intentId = 'a'.repeat(64)
    const brokerOrderId = orderEvent().order.brokerOrderId
    const { quantityMicros: _omittedQuantityMicros, ...currentOrderBase } = orderEvent().order
    const submitRequestHash = canonicalHashV1(
      Result.getOrThrow(
        orderRequestBody({
          clientOrderId: orderEvent().order.clientOrderId,
          notionalLimitMicros: '300000000',
          orderType: OrderType.Market,
          quantityMicros: '3000000',
          side: OrderSide.Buy,
          symbol: orderEvent().order.symbol,
          timeInForce: TimeInForce.Day,
        }),
      ),
    )
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const exactAccount = {
            ...accountEvent(),
            account: { ...accountEvent().account, equityMicros: accountEvent().account.cashMicros },
          } satisfies BrokerEventInput
          const accountReceipt = yield* store.ingest(exactAccount)
          const positionsReceipt = yield* store.ingestPositions(
            positionSnapshotInput(hash('mutation-ordering-empty-positions'), []),
          )
          const valuation = yield* store.value({
            accountEventId: accountReceipt.eventId,
            positionSnapshotId: positionsReceipt.snapshotId,
          })
          const authorityGenerationHash = hash('mutation-ordering-authority')
          const sql = yield* PgClient.PgClient
          yield* sql`
            INSERT INTO authority_generations (
              generation_hash, schema_version, previous_generation_hash, maximum,
              authority_version, activated_at
            ) VALUES (
              ${authorityGenerationHash}, 'bayn.authority-generation-history.v1', NULL,
              'OBSERVE', 1, ${occurredAt}
            )
          `
          yield* sql`
            INSERT INTO authority_state (
              schema_version, generation_hash, maximum, effective, kill_state,
              reason, version, updated_at
            ) VALUES (
              'bayn.paper-authority.v1', ${authorityGenerationHash},
              'OBSERVE', 'OBSERVE', 'CLEAR', NULL, 1, ${occurredAt}
            )
          `
          yield* sql`
            INSERT INTO intents (
              intent_id, schema_version, authority_generation_hash, account_id, client_order_id, symbol, side,
              order_type, time_in_force, quantity_micros, notional_limit_micros,
              state, state_version, created_at, updated_at,
              strategy_name, cycle_id, decision_hash, policy_hash
            ) VALUES (
              ${intentId}, 'bayn.paper-intent.v3', ${authorityGenerationHash}, ${accountId},
              ${orderEvent().order.clientOrderId},
              ${orderEvent().order.symbol}, 'BUY', 'MARKET', 'DAY', 3000000, 300000000,
              'PLANNED', 1, ${occurredAt}, ${occurredAt},
              'tsmom-v1', ${'9'.repeat(64)}, ${'b'.repeat(64)}, ${'c'.repeat(64)}
            )
          `
          yield* sql`
            INSERT INTO mutation_events (
              event_id, schema_version, mutation_id, intent_id, sequence, operation, event_type,
              request_hash, consistency_delay_ms, broker_order_id, request_id,
              response_status, response_content_hash, occurred_at
            ) VALUES
              (
                ${'1'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${'3'.repeat(64)}, ${intentId}, 1,
                'SUBMIT', 'SUBMIT_STARTED', ${submitRequestHash}, 1000, NULL, NULL, NULL, NULL, ${occurredAt}
              ),
              (
                ${'f'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${'3'.repeat(64)}, ${intentId}, 2,
                'SUBMIT', 'SUBMIT_ACCEPTED', ${submitRequestHash}, 1000, ${brokerOrderId}, 'submit-request',
                200, ${'5'.repeat(64)}, ${occurredAt}
              ),
              (
                ${'2'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${'6'.repeat(64)}, ${intentId}, 1,
                'CANCEL', 'CANCEL_STARTED', ${'7'.repeat(64)}, 1000, ${brokerOrderId}, NULL, NULL, NULL, ${occurredAt}
              ),
              (
                ${'0'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${'6'.repeat(64)}, ${intentId}, 2,
                'CANCEL', 'CANCEL_ACCEPTED', ${'7'.repeat(64)}, 1000, ${brokerOrderId}, 'cancel-request',
                204, ${'8'.repeat(64)}, ${occurredAt}
              )
          `
          return yield* store.reconcile({
            account: exactAccount.account,
            positions: [],
            positionsObservedAt: observedAt,
            orders: [
              {
                ...currentOrderBase,
                schemaVersion: 'bayn.paper-order.v2',
                intentId,
                notionalMicros: '300000000',
              },
            ],
            ordersObservedAt: observedAt,
            fills: [],
            valuation,
            reconciledAt: '2026-07-22T15:30:03.000Z',
          })
        }),
      )

      expect(result.reconciliation.discrepancies).toHaveLength(1)
      expect(result.reconciliation.discrepancies[0]).toMatchObject({
        kind: DiscrepancyKind.Mutation,
        identity: intentId,
        observed: `UNKNOWN:${occurredAt}`,
      })
      expect(result.metrics.oldestUnknownMutationAgeMs).toBe(3_000)
      expect(result.riskContext).toMatchObject({
        tradingDate: '2026-07-22',
        authority: {
          generationHash: hash('mutation-ordering-authority'),
          maximum: Authority.Observe,
          effective: Authority.Observe,
          kill: KillState.Active,
        },
        authorityObservedAt: expect.any(String),
        unknownMutationCount: 1,
        dailyTradedNotionalMicros: '0',
        dayStartEquityMicros: accountEvent().account.cashMicros,
        peakEquityMicros: accountEvent().account.cashMicros,
      })
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('recovers the PostgreSQL-to-TigerBeetle crash window without duplicate accounting', async () => {
    const control: JournalControl = { fail: false, planHashes: [] }
    const runtime = makeStoreRuntime(control)
    const buy = fillEvent('fill-buy', OrderSide.Buy, '3000000', '100000000')
    const sell = fillEvent('fill-sell', OrderSide.Sell, '1000000', '120000000')
    const priorBuy = fillEvent(
      'fill-prior-buy',
      OrderSide.Buy,
      '1000000',
      '70000000',
      '2026-07-21T19:58:00.000Z',
      Result.getOrThrow(sourceTimestamp('2026-07-21T19:58:00.000Z')),
      accountId,
      '2026-07-21T19:58:01.000Z',
    )
    const priorSell = fillEvent(
      'fill-prior-sell',
      OrderSide.Sell,
      '1000000',
      '70000000',
      '2026-07-21T19:59:00.000Z',
      Result.getOrThrow(sourceTimestamp('2026-07-21T19:59:00.000Z')),
      accountId,
      '2026-07-21T19:59:01.000Z',
    )
    const otherAccountId = 'paper-account-2'
    const otherFill = fillEvent(
      'fill-other-account',
      OrderSide.Buy,
      '1000000',
      '70000000',
      occurredAt,
      Result.getOrThrow(sourceTimestamp(occurredAt)),
      otherAccountId,
    )
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const opening = {
            ...accountEvent(),
            sourceEventId: 'opening-account',
            contentHash: hash('opening-account'),
            occurredAt: '2026-07-21T19:57:00.000Z',
            observedAt: '2026-07-21T19:57:01.000Z',
            account: {
              ...accountEvent().account,
              equityMicros: accountEvent().account.cashMicros,
              observedAt: '2026-07-21T19:57:01.000Z',
            },
          } satisfies BrokerEventInput
          const openingReceipt = yield* store.ingest(opening)
          const openingPositions = yield* store.ingestPositions(
            positionSnapshotInput(hash('opening-empty-positions'), [], accountId, '2026-07-21T19:57:01.000Z'),
          )
          yield* store.value({
            accountEventId: openingReceipt.eventId,
            positionSnapshotId: openingPositions.snapshotId,
          })

          const otherOpening = {
            ...accountEvent(otherAccountId),
            sourceEventId: 'other-opening-account',
            contentHash: hash('other-opening-account'),
            account: {
              ...accountEvent(otherAccountId).account,
              equityMicros: accountEvent(otherAccountId).account.cashMicros,
            },
          } satisfies BrokerEventInput
          const otherReceipt = yield* store.ingest(otherOpening)
          const otherPositions = yield* store.ingestPositions(
            positionSnapshotInput(hash('other-opening-empty-positions'), [], otherAccountId),
          )
          yield* store.value({
            accountEventId: otherReceipt.eventId,
            positionSnapshotId: otherPositions.snapshotId,
          })

          yield* store.account(priorBuy)
          yield* store.account(priorSell)

          const dayStartObservedAt = '2026-07-22T13:30:00.000Z'
          const dayStartAccount = {
            ...accountEvent(),
            sourceEventId: 'day-start-account',
            contentHash: hash('day-start-account'),
            occurredAt: dayStartObservedAt,
            observedAt: dayStartObservedAt,
            account: {
              ...accountEvent().account,
              cashMicros: '999999800',
              equityMicros: '999999800',
              observedAt: dayStartObservedAt,
            },
          } satisfies BrokerEventInput
          const dayStartReceipt = yield* store.ingest(dayStartAccount)
          const dayStartPositions = yield* store.ingestPositions(
            positionSnapshotInput(hash('day-start-empty-positions'), [], accountId, dayStartObservedAt),
          )
          yield* store.value({
            accountEventId: dayStartReceipt.eventId,
            positionSnapshotId: dayStartPositions.snapshotId,
          })
        }),
      )
      control.fail = true
      const failed = await runtime.runPromiseExit(Effect.flatMap(ExecutionStore, (store) => store.account(buy)))
      expect(Exit.isFailure(failed)).toBe(true)

      const afterFailure = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const [counts] = yield* sql<{ receipts: number; transactions: number }>`
            SELECT
              (SELECT count(*)::integer FROM accounting_transactions) AS transactions,
              (SELECT count(*)::integer FROM accounting_receipts) AS receipts
          `
          return counts
        }),
      )
      expect(afterFailure).toEqual({ transactions: 3, receipts: 2 })

      control.fail = false
      const outOfOrder = await runtime.runPromiseExit(Effect.flatMap(ExecutionStore, (store) => store.account(sell)))
      expect(Exit.isFailure(outOfOrder)).toBe(true)
      if (Exit.isFailure(outOfOrder)) expect(Cause.pretty(outOfOrder.cause)).toContain('earlier fill')
      expect(control.planHashes).toHaveLength(3)

      const [receipt, replay, sale, otherAccountFill] = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const receipt = yield* store.account(buy)
          const replay = yield* store.account(buy)
          const sale = yield* store.account(sell)
          const otherAccountFill = yield* store.account(otherFill)
          return [receipt, replay, sale, otherAccountFill] as const
        }),
      )
      expect(replay).toEqual(receipt)
      expect(sale.brokerEventId).not.toBe(receipt.brokerEventId)
      expect(otherAccountFill.brokerEventId).not.toBe(sale.brokerEventId)
      expect(new Set(control.planHashes.slice(2, 5)).size).toBe(1)

      const stored = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const transactions = yield* sql<{
            cost_basis_micros: string
            ledger_plan_hash: string
            realized_pnl_micros: string
            side: string
          }>`
            SELECT side, cost_basis_micros::text, realized_pnl_micros::text, ledger_plan_hash
            FROM accounting_transactions
            ORDER BY transaction_id
          `
          const [counts] = yield* sql<{ events: number; receipts: number; transactions: number }>`
            SELECT
              (SELECT count(*)::integer FROM broker_events) AS events,
              (SELECT count(*)::integer FROM accounting_transactions) AS transactions,
              (SELECT count(*)::integer FROM accounting_receipts) AS receipts
          `
          const immutable = yield* Effect.exit(sql`
            UPDATE accounting_transactions SET content_hash = ${'f'.repeat(64)}
          `)
          const truncate = yield* Effect.exit(sql`TRUNCATE accounting_transactions CASCADE`)
          return { transactions, counts, immutable, truncate }
        }),
      )
      expect(stored.transactions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ side: 'BUY', cost_basis_micros: '300000000', realized_pnl_micros: '0' }),
          expect.objectContaining({ side: 'SELL', cost_basis_micros: '100000000', realized_pnl_micros: '20000000' }),
        ]),
      )
      expect(stored.transactions.every((transaction) => /^[a-f0-9]{64}$/.test(transaction.ledger_plan_hash))).toBe(true)
      expect(stored.counts).toEqual({ events: 8, transactions: 5, receipts: 5 })
      expect(Exit.isFailure(stored.immutable)).toBe(true)
      expect(Exit.isFailure(stored.truncate)).toBe(true)

      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const currentAccount = {
            ...accountEvent(),
            sourceEventId: 'current-account',
            contentHash: hash('current-account'),
            account: {
              ...accountEvent().account,
              cashMicros: '819999600',
              equityMicros: '1019999600',
            },
          } satisfies BrokerEventInput
          const accountReceipt = yield* store.ingest(currentAccount)
          const position = positionEvent(hash('accounted-position'), 'asset-accounted', 'NVDA', '2000000', '200000000')
          const positionsReceipt = yield* store.ingestPositions(
            positionSnapshotInput(hash('accounted-position'), [position]),
          )
          const valuation = yield* store.value({
            accountEventId: accountReceipt.eventId,
            positionSnapshotId: positionsReceipt.snapshotId,
          })
          const sql = yield* PgClient.PgClient
          yield* sql`
            INSERT INTO valuations (
              valuation_id, schema_version, account_id, source_hash, cash_micros,
              long_market_value_micros, short_market_value_micros, equity_micros, as_of
            ) VALUES
              (
                ${hash('future-primary-valuation')}, 'bayn.paper-valuation.v1', ${accountId},
                ${hash('future-primary-source')}, 9000000000, 0, 0, 9000000000,
                '2026-07-22T16:00:00.000Z'
              ),
              (
                ${hash('other-account-valuation')}, 'bayn.paper-valuation.v1', ${otherAccountId},
                ${hash('other-account-source')}, 8000000000, 0, 0, 8000000000,
                '2026-07-22T15:30:30.000Z'
              )
          `
          yield* store.ensureAuthorityGeneration({
            generationHash: hash('observe-generation'),
            maximum: Authority.Observe,
          })
          const [observationBefore] = yield* sql<{ observed_at: Date }>`
            SELECT clock_timestamp() AS observed_at
          `
          const exact = yield* store.reconcile({
            account: currentAccount.account,
            positions: [position.position],
            positionsObservedAt: observedAt,
            orders: [],
            ordersObservedAt: observedAt,
            fills: [priorBuy.fill, priorSell.fill, buy.fill, sell.fill],
            valuation,
            reconciledAt: '2026-07-22T15:31:00.000Z',
          })
          const [observationAfter] = yield* sql<{ observed_at: Date }>`
            SELECT clock_timestamp() AS observed_at
          `
          return {
            exact,
            observationBefore: observationBefore.observed_at,
            observationAfter: observationAfter.observed_at,
          }
        }),
      )
      const { exact, observationBefore, observationAfter } = result
      expect(exact.reconciliation.status).toBe(ReconciliationStatus.Exact)
      expect(exact.reconciliation.discrepancies).toEqual([])
      const { authorityObservedAt, ...riskContext } = exact.riskContext
      expect(riskContext).toMatchObject({
        tradingDate: '2026-07-22',
        authority: {
          generationHash: hash('observe-generation'),
          maximum: Authority.Observe,
          effective: Authority.Observe,
          kill: KillState.Clear,
          version: 1,
          updatedAt: expect.any(String),
        },
        unknownMutationCount: 0,
        dailyTradedNotionalMicros: '420000000',
        dayStartEquityMicros: '999999800',
        peakEquityMicros: '1019999600',
      })
      if (authorityObservedAt === null) throw new Error('expected a durable authority observation')
      expect(Date.parse(authorityObservedAt)).toBeGreaterThanOrEqual(observationBefore.getTime())
      expect(Date.parse(authorityObservedAt)).toBeLessThanOrEqual(observationAfter.getTime())
      expect(Date.parse(authorityObservedAt)).toBeGreaterThanOrEqual(Date.parse('2026-07-22T15:30:02.000Z'))
    } finally {
      await runtime.dispose()
    }
  }, 20_000)

  test('persists one valuation from a complete account and position observation set', async () => {
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    const positionsSourceHash = hash('positions-response-1')
    const positions = [
      positionEvent(positionsSourceHash, 'asset-1', 'NVDA', '2000000', '200000000'),
      positionEvent(positionsSourceHash, 'asset-2', 'AMD', '-500000', '-50000000'),
    ] as const
    const snapshotInput = positionSnapshotInput(positionsSourceHash, positions)
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const account = yield* store.ingest(accountEvent())
          const directPosition = yield* Effect.exit(store.ingest(positions[0]))
          const snapshot = yield* store.ingestPositions(snapshotInput)
          const snapshotReplay = yield* store.ingestPositions(snapshotInput)
          const conflictingSnapshot = yield* Effect.exit(
            store.ingestPositions(positionSnapshotInput(positionsSourceHash, [positions[0]])),
          )
          const input: ValuationInput = {
            accountEventId: account.eventId,
            positionSnapshotId: snapshot.snapshotId,
          }
          const valuation = yield* store.value(input)
          const replay = yield* store.value(input)
          const missingSnapshot = yield* Effect.exit(
            store.value({ ...input, positionSnapshotId: hash('missing-position-snapshot') }),
          )
          const emptySnapshot = yield* store.ingestPositions(
            positionSnapshotInput(hash('empty-positions-response'), []),
          )
          const emptyValuation = yield* store.value({
            accountEventId: account.eventId,
            positionSnapshotId: emptySnapshot.snapshotId,
          })
          const sql = yield* PgClient.PgClient
          const [counts] = yield* sql<{ position_snapshots: number; positions: number; valuations: number }>`
            SELECT
              (SELECT count(*)::integer FROM position_snapshots) AS position_snapshots,
              (SELECT count(*)::integer FROM positions) AS positions,
              (SELECT count(*)::integer FROM valuations) AS valuations
          `
          return {
            valuation,
            replay,
            snapshot,
            snapshotReplay,
            directPosition,
            conflictingSnapshot,
            missingSnapshot,
            emptyValuation,
            counts,
          }
        }),
      )

      expect(result.valuation).toMatchObject({
        accountId,
        cashMicros: '1000000000',
        longMarketValueMicros: '200000000',
        shortMarketValueMicros: '-50000000',
        equityMicros: '1150000000',
      })
      expect(result.replay).toEqual(result.valuation)
      expect(result.snapshot).toMatchObject({ eventIds: expect.any(Array), deduplicated: false })
      expect(result.snapshotReplay).toEqual({ ...result.snapshot, deduplicated: true })
      expect(Exit.isFailure(result.directPosition)).toBe(true)
      expect(Exit.isFailure(result.conflictingSnapshot)).toBe(true)
      expect(Exit.isFailure(result.missingSnapshot)).toBe(true)
      expect(result.emptyValuation).toMatchObject({
        cashMicros: '1000000000',
        longMarketValueMicros: '0',
        shortMarketValueMicros: '0',
        equityMicros: '1000000000',
      })
      expect(result.counts).toEqual({ position_snapshots: 2, positions: 2, valuations: 2 })
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('derives cost basis in broker economic order and rejects a late predecessor', async () => {
    const control: JournalControl = { fail: false, planHashes: [] }
    const runtime = makeStoreRuntime(control)
    const first = fillEvent(
      'fill-z',
      OrderSide.Buy,
      '3000000',
      '100000000',
      occurredAt,
      '2026-07-22T15:30:00.000100000Z',
    )
    const second = fillEvent(
      'fill-a',
      OrderSide.Sell,
      '1000000',
      '120000000',
      occurredAt,
      '2026-07-22T15:30:00.000900000Z',
    )
    const latePredecessor = fillEvent(
      'fill-0',
      OrderSide.Buy,
      '1000000',
      '90000000',
      occurredAt,
      '2026-07-22T15:30:00.000050000Z',
    )
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const arrivedFirst = yield* store.ingest(second)
          const firstReceipt = yield* store.account(first)
          yield* store.account(second)
          const replay = yield* store.account(first)
          const rejected = yield* Effect.exit(store.account(latePredecessor))
          const sql = yield* PgClient.PgClient
          const transactions = yield* sql<{
            cost_basis_micros: string
            realized_pnl_micros: string
            side: string
            source_event_id: string
            source_sequence: string
          }>`
            SELECT
              event.source_event_id,
              event.source_sequence::text,
              transaction.side,
              transaction.cost_basis_micros::text,
              transaction.realized_pnl_micros::text
            FROM accounting_transactions AS transaction
            JOIN broker_events AS event ON event.event_id = transaction.broker_event_id
            JOIN fills AS fill ON fill.event_id = event.event_id
            ORDER BY fill.source_timestamp COLLATE "C", fill.fill_id COLLATE "C"
          `
          const [counts] = yield* sql<{ events: number; transactions: number }>`
            SELECT
              (SELECT count(*)::integer FROM broker_events) AS events,
              (SELECT count(*)::integer FROM accounting_transactions) AS transactions
          `
          return { arrivedFirst, firstReceipt, replay, rejected, transactions, counts }
        }),
      )

      expect(result.arrivedFirst).toMatchObject({ sourceSequence: '0', deduplicated: false })
      expect(result.replay).toEqual(result.firstReceipt)
      expect(result.transactions).toEqual([
        {
          source_event_id: 'fill-z',
          source_sequence: '1',
          side: 'BUY',
          cost_basis_micros: '300000000',
          realized_pnl_micros: '0',
        },
        {
          source_event_id: 'fill-a',
          source_sequence: '0',
          side: 'SELL',
          cost_basis_micros: '100000000',
          realized_pnl_micros: '20000000',
        },
      ])
      expect(Exit.isFailure(result.rejected)).toBe(true)
      if (Exit.isFailure(result.rejected)) {
        expect(Cause.pretty(result.rejected.cause)).toContain('later fill was already accounted')
      }
      expect(result.counts).toEqual({ events: 2, transactions: 2 })
      expect(control.planHashes).toHaveLength(3)
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('fails closed when an economic predecessor has no accounting transaction', async () => {
    const control: JournalControl = { fail: false, planHashes: [] }
    const runtime = makeStoreRuntime(control)
    const first = fillEvent('fill-missing', OrderSide.Buy, '1000000', '100000000', '2026-07-22T15:29:59.000Z')
    const second = fillEvent('fill-later', OrderSide.Sell, '1000000', '120000000')
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          yield* store.ingest(first)
          const rejected = yield* Effect.exit(store.account(second))
          const sql = yield* PgClient.PgClient
          const [counts] = yield* sql<{ events: number; transactions: number }>`
            SELECT
              (SELECT count(*)::integer FROM broker_events) AS events,
              (SELECT count(*)::integer FROM accounting_transactions) AS transactions
          `
          return { rejected, counts }
        }),
      )

      expect(Exit.isFailure(result.rejected)).toBe(true)
      if (Exit.isFailure(result.rejected)) {
        expect(Cause.pretty(result.rejected.cause)).toContain('earlier fill has not been posted')
      }
      expect(result.counts).toEqual({ events: 1, transactions: 0 })
      expect(control.planHashes).toHaveLength(0)
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('keeps discrepancy history in immutable reconciliation rows and never restores authority', async () => {
    const setupRuntime = makeStoreRuntime(
      { fail: false, planHashes: [] },
      { ...config, reconciliationStaleThresholdMs: Number.MAX_SAFE_INTEGER },
    )
    const exactAccount = {
      ...accountEvent(),
      account: { ...accountEvent().account, equityMicros: accountEvent().account.cashMicros },
    } satisfies BrokerEventInput
    let runtime: ReturnType<typeof makeStoreRuntime> | undefined
    try {
      const setup = await (async () => {
        try {
          return await setupRuntime.runPromise(
            Effect.gen(function* () {
              const store = yield* ExecutionStore
              const accountReceipt = yield* store.ingest(exactAccount)
              const positionsReceipt = yield* store.ingestPositions(
                positionSnapshotInput(hash('reconciliation-empty-positions'), []),
              )
              const valuation = yield* store.value({
                accountEventId: accountReceipt.eventId,
                positionSnapshotId: positionsReceipt.snapshotId,
              })
              const baseline = {
                account: exactAccount.account,
                positions: [],
                positionsObservedAt: observedAt,
                orders: [],
                ordersObservedAt: observedAt,
                fills: [],
                valuation,
                reconciledAt: '2026-07-22T15:30:02.000Z',
              } as const
              const exact = yield* store.reconcile(baseline)
              const observeGenerationHash = hash('reconciliation-observe-generation')
              yield* seedQualificationEvidence(qualifiedEvidence)
              yield* store.ensureAuthorityGeneration({
                generationHash: observeGenerationHash,
                maximum: Authority.Observe,
              })
              return { baseline, exact, observeGenerationHash, valuation }
            }),
          )
        } finally {
          await setupRuntime.dispose()
        }
      })()
      const activation = makeActivation(setup.observeGenerationHash, qualifiedEvidence, {
        reconciliationId: setup.exact.reconciliation.reconciliationId,
        contentHash: setup.exact.reconciliation.contentHash,
      })
      runtime = makeActivationRuntime({ fail: false, planHashes: [] }, activation, {
        reconciliationStaleThresholdMs: Number.MAX_SAFE_INTEGER,
      })
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* ExecutionStore
          const sql = yield* PgClient.PgClient
          const activated = yield* store.activateCapitalGrant(proofBinding(activation))
          yield* sql`
            INSERT INTO valuations (
              valuation_id, schema_version, account_id, source_hash, cash_micros,
              long_market_value_micros, short_market_value_micros, equity_micros, as_of
            ) VALUES (
              ${hash('paper-activation-day-valuation')}, ${setup.valuation.schemaVersion},
              ${setup.valuation.accountId}, ${hash('paper-activation-day-source')},
              ${setup.valuation.cashMicros}, ${setup.valuation.longMarketValueMicros},
              ${setup.valuation.shortMarketValueMicros}, ${setup.valuation.equityMicros},
              ${activated.updatedAt}
            )
          `
          const activationTime = Date.parse(activated.updatedAt)
          const mismatchObservedAt = DateTime.formatIso(DateTime.makeUnsafe(activationTime + 1))
          const ongoingObservedAt = DateTime.formatIso(DateTime.makeUnsafe(activationTime + 2))
          const resolvedObservedAt = DateTime.formatIso(DateTime.makeUnsafe(activationTime + 3))

          const mismatchInput = {
            ...setup.baseline,
            orders: [orderEvent().order],
            reconciledAt: mismatchObservedAt,
          } as const
          const mismatch = yield* store.reconcile(mismatchInput)
          const replay = yield* store.reconcile(mismatchInput)
          const ongoing = yield* store.reconcile({
            ...mismatchInput,
            reconciledAt: ongoingObservedAt,
          })
          const resolved = yield* store.reconcile({
            ...setup.baseline,
            reconciledAt: resolvedObservedAt,
          })

          const rows = yield* sql<{
            reconciliation_id: string
            content_hash: string
            discrepancy_count: number
            status: string
          }>`
            SELECT
              reconciliation_id,
              content_hash,
              status,
              jsonb_array_length(discrepancies)::integer AS discrepancy_count
            FROM reconciliations
            ORDER BY reconciled_at, reconciliation_id COLLATE "C"
          `
          const [latest] = yield* sql<{
            reconciliation_id: string
            content_hash: string
            status: string
          }>`
            SELECT reconciliation_id, content_hash, status
            FROM reconciliations
            ORDER BY reconciled_at DESC, reconciliation_id COLLATE "C" DESC
            LIMIT 1
          `
          const [authority] = yield* sql<{
            effective: string
            kill_state: string
            reason: string | null
            version: number
          }>`
            SELECT effective, kill_state, reason, version::integer
            FROM authority_state
          `
          const mutateReconciliation = yield* Effect.exit(sql`
            UPDATE reconciliations
            SET content_hash = ${hash('mutated-reconciliation')}
            WHERE reconciliation_id = ${mismatch.reconciliation.reconciliationId}
          `)
          return {
            exact: setup.exact,
            mismatch,
            replay,
            ongoing,
            resolved,
            rows,
            latest,
            authority,
            mutateReconciliation,
            mismatchObservedAt,
            ongoingObservedAt,
          }
        }),
      )

      expect(result.exact.reconciliation.status).toBe(ReconciliationStatus.Exact)
      expect(result.mismatch.reconciliation.status).toBe(ReconciliationStatus.Discrepancy)
      const mismatchRiskContext = result.mismatch.riskContext
      const replayRiskContext = result.replay.riskContext
      if (mismatchRiskContext.authorityObservedAt === null || replayRiskContext.authorityObservedAt === null) {
        throw new Error('expected authority observations for discrepancy replay')
      }
      expect(result.replay).toEqual({
        ...result.mismatch,
        riskContext: {
          ...mismatchRiskContext,
          authorityObservedAt: replayRiskContext.authorityObservedAt,
        },
      })
      expect(Date.parse(replayRiskContext.authorityObservedAt)).toBeGreaterThanOrEqual(
        Date.parse(mismatchRiskContext.authorityObservedAt),
      )
      expect(result.mismatch.reconciliation.discrepancies).toHaveLength(1)
      expect(result.ongoing.reconciliation.discrepancies[0]).toMatchObject({
        discrepancyId: result.mismatch.reconciliation.discrepancies[0]?.discrepancyId,
        firstObservedAt: result.mismatchObservedAt,
        lastObservedAt: result.ongoingObservedAt,
      })
      expect(result.resolved.reconciliation.status).toBe(ReconciliationStatus.Exact)
      expect(result.resolved.reconciliation.discrepancies).toEqual([])
      expect(
        result.rows.map(({ status, discrepancy_count: discrepancyCount }) => ({
          status,
          discrepancy_count: discrepancyCount,
        })),
      ).toEqual([
        { status: ReconciliationStatus.Exact, discrepancy_count: 0 },
        { status: ReconciliationStatus.Discrepancy, discrepancy_count: 1 },
        { status: ReconciliationStatus.Discrepancy, discrepancy_count: 1 },
        { status: ReconciliationStatus.Exact, discrepancy_count: 0 },
      ])
      expect(
        result.rows.map(({ reconciliation_id: reconciliationId, content_hash: contentHash }) => ({
          reconciliationId,
          contentHash,
        })),
      ).toEqual(
        [result.exact, result.mismatch, result.ongoing, result.resolved].map(({ reconciliation }) => ({
          reconciliationId: reconciliation.reconciliationId,
          contentHash: reconciliation.contentHash,
        })),
      )
      expect(result.latest).toEqual({
        reconciliation_id: result.resolved.reconciliation.reconciliationId,
        content_hash: result.resolved.reconciliation.contentHash,
        status: ReconciliationStatus.Exact,
      })
      expect(result.authority).toEqual({
        effective: 'OBSERVE',
        kill_state: 'ACTIVE',
        reason: `reconciliation discrepancy ${result.mismatch.reconciliation.reconciliationId}`,
        version: 3,
      })
      expect(Exit.isFailure(result.mutateReconciliation)).toBe(true)
    } finally {
      await runtime?.dispose()
    }
  }, 15_000)
})
