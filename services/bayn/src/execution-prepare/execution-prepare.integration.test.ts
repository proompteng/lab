import assert from 'node:assert/strict'

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted, Result } from 'effect'

import { BrokerProvider, alpacaSandboxBaseUrl } from '../broker/alpaca'
import { makeBrokerIdentity } from '../broker/identity'
import type { RuntimeConfig } from '../config'
import { makeStrategyProtocolHash } from '../contracts'
import { makeAuthorityPostgres } from '../db/execution-store/authority-shared'
import { makeObserveAuthorityInterpreter } from '../db/execution-store/observe-authority'
import { EvidenceStore, EvidenceStoreFromPostgres, PostgresClientLive } from '../db/evidence-store'
import { BrokerAccess, BrokerEnvironment, CapitalAuthorityKind, noCapitalAuthority } from '../execution/authority'
import { Authority } from '../execution/contracts'
import { WriterFenceLive } from '../execution/writer-fence'
import { canonicalHashV1OrThrow } from '../hash'
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
import type { ExecutionPrepareRequest, ExecutionPrepareRuntimeBinding } from './model'
import { ExecutionPrepareStoreLive } from './live'
import { prepareExecution } from './program'
import { makeExecutionPrepareDiscoveryReceiptFixture } from './test-fixture'

const postgresUrl = process.env.BAYN_TEST_POSTGRES_URL
const testUrl = postgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = postgresUrl === undefined ? describe.skip : describe
const accountId = 'execution-prepare-account'
const sourceRevision = 'a'.repeat(40)
const imageRepository = 'registry.ide-newton.ts.net/lab/bayn'
const imageDigest = `sha256:${'b'.repeat(64)}` as const
const qualificationSourceRevision = 'c'.repeat(40)
const qualificationImageDigest = `sha256:${'d'.repeat(64)}` as const
const hash = (value: string): string => canonicalHashV1OrThrow({ value })

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result), 'fixture construction must succeed')
  return result.success
}

const brokerIdentity = Result.getOrThrow(
  makeBrokerIdentity({
    schemaVersion: 'bayn.broker-identity.v2',
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    accountId,
  }),
)

const strategy = {
  name: 'risk-balanced-trend' as const,
  behaviorHash: hash('strategy-behavior'),
  parameterHash: canonicalHashV1OrThrow(fixtureProtocol),
  parameterSchemaVersion: fixtureProtocol.schemaVersion,
}
const strategyProtocolHash = makeStrategyProtocolHash(strategy)

const baseConfig: RuntimeConfig = {
  host: '127.0.0.1',
  port: 8080,
  execution: {
    brokerIdentity,
    brokerAccess: BrokerAccess.ReadOnly,
    capitalAuthority: noCapitalAuthority,
  },
  build: {
    sourceRevision,
    imageRepository,
    imageDigest,
    strategyBehaviorHash: strategy.behaviorHash,
    strategyParameterHash: strategy.parameterHash,
    verification: 'embedded',
  },
  healthIntervalMs: 30_000,
  operationTimeoutMs: 5_000,
  cycleStallThresholdMs: 300_000,
  reconciliationStaleThresholdMs: 120_000,
  unknownMutationThresholdMs: 300_000,
  alpaca: {
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    identity: brokerIdentity,
    baseUrl: alpacaSandboxBaseUrl,
    expectedAccountId: accountId,
    authorityGenerationHash: hash('observe-generation'),
    key: Redacted.make('unused-key'),
    secret: Redacted.make('unused-secret'),
    proxyUrl: 'http://bayn-egress-proxy.invalid',
    operationTimeoutMs: 5_000,
    retryAttempts: 0,
    reconciliationIntervalMs: 30_000,
  },
  clickhouse: {
    url: 'http://clickhouse.invalid',
    username: 'bayn',
    password: Redacted.make('unused'),
    snapshotId: hash('configured-snapshot'),
    publicationAsOf: '2026-07-21',
    calendarVersion: 'alpaca-us-equity-calendar-v1',
    bounds: {
      schemaVersion: 'bayn.evaluation-bounds.v1',
      dataStart: '2016-01-04',
      dataEnd: '2026-07-21',
      lookbackStart: '2016-01-04',
      evaluationStart: '2017-01-03',
      evaluationEnd: '2026-07-21',
    },
  },
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
  tigerBeetle: { clusterId: 2_001n, replicaAddresses: ['127.0.0.1:3000'], ledger: 7_001 },
}

const runtimeConfig = (qualificationRunId: string): RuntimeConfig => ({
  ...baseConfig,
  qualificationRunId,
})

const makeRuntime = (qualificationRunId: string) => {
  const config = runtimeConfig(qualificationRunId)
  return ManagedRuntime.make(
    ExecutionPrepareStoreLive(config).pipe(
      Layer.provideMerge(WriterFenceLive),
      Layer.provideMerge(PostgresClientLive(config)),
      Layer.provide(NodeServices.layer),
    ),
  )
}

const makeClientRuntime = () =>
  ManagedRuntime.make(PostgresClientLive(baseConfig).pipe(Layer.provide(NodeServices.layer)))

const makeEvidenceRuntime = () =>
  ManagedRuntime.make(
    EvidenceStoreFromPostgres(baseConfig).pipe(
      Layer.provideMerge(PostgresClientLive(baseConfig)),
      Layer.provide(NodeServices.layer),
    ),
  )

const qualificationPolicy = (name: string) =>
  success(
    makeQualificationPolicyDocument(`bayn.${name}.v1`, {
      schemaVersion: `bayn.${name}.v1`,
      enabled: true,
    }),
  )

const qualificationSeries = (runId: string): QualificationSeries => {
  const sessionDate = (index: number): `${number}-${number}-${number}` => {
    const date = new Date('2000-01-01T00:00:00.000Z')
    date.setUTCDate(date.getUTCDate() + index)
    return date.toISOString().slice(0, 10) as `${number}-${number}-${number}`
  }
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

const qualificationFixture = (name: string, qualified: boolean): QualificationFixture => {
  const runId = hash(`${name}-run`)
  const snapshotId = hash(`${name}-snapshot`)
  const lock = success(
    makeQualificationLock({
      schemaVersion: 'bayn.qualification-lock.v3',
      candidateRunId: runId,
      protocolHash: strategyProtocolHash,
      sourceRevision: qualificationSourceRevision,
      image: { repository: imageRepository, digest: qualificationImageDigest },
      universeId: fixtureProtocol.universeId,
      universeSymbolHash: fixtureProtocol.universeSymbolHash,
      universe: fixtureProtocol.universe,
      universeRationale: 'Precommitted universe for the bounded EXECUTION_PREPARE integration proof.',
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
        bounds: baseConfig.clickhouse.bounds,
      },
      policies: {
        benchmark: qualificationPolicy(`${name}-benchmark`),
        thresholds: qualificationPolicy(`${name}-thresholds`),
        uncertainty: success(defaultQualificationStatisticsPolicyDocument),
        execution: success(
          makeQualificationPolicyDocument(fixtureProtocol.executionModel.schemaVersion, fixtureProtocol.executionModel),
        ),
      },
      priorTrialRunIds: [],
    }),
  )
  const analysis = success(analyzeQualification(qualificationSeries(runId), defaultQualificationStatisticsPolicy, []))
  const evaluationVerdict = qualified
    ? {
        status: 'PASS' as const,
        gates: [{ name: 'execution_prepare_fixture', passed: true, actual: 1, required: 1 }],
      }
    : {
        status: 'FAIL_CLOSED' as const,
        gates: [{ name: 'execution_prepare_fixture', passed: false, actual: 0, required: 1 }],
      }
  return {
    lock,
    result: success(makeQualificationResult(lock, evaluationVerdict, analysis)),
  }
}

const seedQualification = (fixture: QualificationFixture) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const { lock, result } = fixture
    yield* sql`
      INSERT INTO protocol_locks (
        protocol_hash, schema_version, strategy_name, behavior_hash, parameter_hash, parameters
      ) VALUES (
        ${lock.protocolHash}, ${fixtureProtocol.schemaVersion}, ${strategy.name},
        ${strategy.behaviorHash}, ${strategy.parameterHash}, ${sql.json(fixtureProtocol)}
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
        expected_artifact_count, expected_event_count, expected_gate_count, status, completed_at
      ) VALUES (
        ${result.runId}, ${lock.protocolHash}, ${lock.data.snapshotId}, 'bayn.evaluation.v6',
        ${lock.sourceRevision}, ${lock.image.repository}, ${lock.image.digest}, ${strategy.name},
        1000000000000, 1, 0, 1, 'COMPLETE', clock_timestamp()
      )
    `
    yield* sql`
      INSERT INTO evaluation_artifacts (run_id, artifact_name, schema_version, content_hash, payload)
      VALUES (
        ${result.runId}, 'qualification-artifact-manifest', 'bayn.qualification-artifact-manifest.v1',
        ${hash(`${result.runId}-artifact`)}, ${sql.json({ runId: result.runId })}
      )
    `
    yield* sql`
      INSERT INTO gate_outcomes (run_id, ordinal, gate_name, passed, actual, required, content_hash)
      VALUES (
        ${result.runId}, 0, 'execution_prepare_fixture', ${result.evaluationVerdict.gates[0].passed},
        ${sql.json(JSON.stringify(result.evaluationVerdict.gates[0].actual))},
        ${sql.json(JSON.stringify(result.evaluationVerdict.gates[0].required))},
        ${hash(`${result.runId}-gate`)}
      )
    `
    yield* sql`
      INSERT INTO status_history (run_id, status, detail)
      VALUES
        (${result.runId}, 'WRITING', ${sql.json({ artifactCount: 1, eventCount: 0, gateCount: 1 })}),
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

interface ReconciliationFixture {
  readonly reconciliationId: string
  readonly contentHash: string
  readonly ageMs: number
  readonly exact: boolean
}

const reconciliationFixture = (
  name: string,
  overrides: Partial<ReconciliationFixture> = {},
): ReconciliationFixture => ({
  reconciliationId: hash(`${name}-reconciliation`),
  contentHash: hash(`${name}-reconciliation-content`),
  ageMs: 0,
  exact: true,
  ...overrides,
})

const seedReconciliation = (fixture: ReconciliationFixture) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const expectedHash = hash(`${fixture.reconciliationId}-expected`)
    const observedHash = fixture.exact ? expectedHash : hash(`${fixture.reconciliationId}-observed`)
    const discrepancies = fixture.exact
      ? []
      : [
          {
            discrepancyId: hash(`${fixture.reconciliationId}-discrepancy`),
            kind: 'ACCOUNT',
            identity: accountId,
            expected: 'expected',
            observed: 'observed',
            evidenceHash: hash(`${fixture.reconciliationId}-evidence`),
            firstObservedAt: '2026-07-22T15:30:00.000Z',
            lastObservedAt: '2026-07-22T15:30:00.000Z',
          },
        ]
    yield* sql`
      INSERT INTO reconciliations (
        reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
        content_hash, status, discrepancies, reconciled_at
      ) VALUES (
        ${fixture.reconciliationId}, 'bayn.paper-reconciliation.v1', ${accountId},
        ${expectedHash}, ${observedHash}, ${fixture.contentHash}, ${fixture.exact ? 'EXACT' : 'DISCREPANCY'},
        ${sql.json(JSON.stringify(discrepancies))},
        clock_timestamp() - (${fixture.ageMs} * interval '1 millisecond')
      )
    `
  })

const seedUnresolvedMutation = (authorityGenerationHash: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const intentId = hash('unresolved-intent')
    const decisionId = hash('unresolved-decision')
    yield* sql`
      INSERT INTO intents (
        intent_id, schema_version, authority_generation_hash, account_id, client_order_id, symbol, side,
        order_type, time_in_force, quantity_micros, notional_limit_micros,
        state, terminal_outcome, state_version, created_at, updated_at,
        strategy_name, cycle_id, decision_hash, policy_hash
      ) VALUES (
        ${intentId}, 'bayn.paper-intent.v3', ${authorityGenerationHash}, ${accountId},
        'execution-prepare-unresolved', 'SPY', 'BUY', 'MARKET', 'DAY', 1000000, 100000000,
        'PLANNED', NULL, 1, '2026-07-22T15:30:00.000Z', '2026-07-22T15:30:00.000Z',
        ${strategy.name}, ${hash('unresolved-cycle')}, ${hash('unresolved-plan')}, ${hash('unresolved-policy')}
      )
    `
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO risk_decisions (
            decision_id, schema_version, input_hash, intent_id, policy_hash,
            outcome, reason_codes, decided_at, expires_at
          ) VALUES (
            ${decisionId}, 'bayn.paper-risk-decision.v1', ${hash('unresolved-input')}, ${intentId},
            ${hash('unresolved-policy')}, 'APPROVED', ARRAY[]::text[],
            '2026-07-22T15:30:00.001Z', '2099-01-01T00:00:00.000Z'
          )
        `
        yield* sql`
          UPDATE intents
          SET risk_decision_id = ${decisionId}, state = 'APPROVED', state_version = 2,
              updated_at = '2026-07-22T15:30:00.002Z'
          WHERE intent_id = ${intentId}
        `
        yield* sql`
          INSERT INTO mutation_events (
            event_id, schema_version, mutation_id, intent_id, sequence, operation,
            event_type, request_hash, consistency_delay_ms, broker_order_id,
            request_id, response_status, response_content_hash, occurred_at
          ) VALUES (
            ${hash('unresolved-submit-started')}, 'bayn.paper-mutation-event.v1',
            ${hash('unresolved-submit')}, ${intentId}, 1, 'SUBMIT', 'SUBMIT_STARTED',
            ${hash('unresolved-request')}, 1000, NULL, NULL, NULL, NULL,
            '2026-07-22T15:30:01.000Z'
          )
        `
        yield* sql`
          UPDATE intents
          SET state = 'IO_STARTED', state_version = 3, updated_at = '2026-07-22T15:30:01.000Z'
          WHERE intent_id = ${intentId}
        `
      }),
    )
  })

interface DurableSnapshot {
  readonly authorityState: readonly Readonly<Record<string, unknown>>[] | null
  readonly authorityHistory: readonly Readonly<Record<string, unknown>>[] | null
  readonly intents: number
  readonly mutations: number
}

const durableSnapshot = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const [snapshot] = yield* sql<DurableSnapshot>`
    SELECT
      (SELECT jsonb_agg(to_jsonb(state) || jsonb_build_object('tupleId', state.xmin::text)) FROM authority_state state)
        AS "authorityState",
      (
        SELECT jsonb_agg(to_jsonb(history) || jsonb_build_object('tupleId', history.xmin::text)
          ORDER BY history.authority_version)
        FROM authority_generations history
      ) AS "authorityHistory",
      (SELECT count(*)::integer FROM intents) AS intents,
      (SELECT count(*)::integer FROM mutation_events) AS mutations
  `
  return {
    authorityState: snapshot.authorityState,
    authorityHistory: snapshot.authorityHistory,
    intents: snapshot.intents,
    mutations: snapshot.mutations,
  }
})

const makeRequest = (
  fixture: QualificationFixture,
  reconciliation: ReconciliationFixture,
  overrides: Partial<ExecutionPrepareRequest['proofPlan']['binding']> = {},
): ExecutionPrepareRequest => {
  const binding = {
    activationSourceRevision: sourceRevision,
    activationImageRepository: imageRepository,
    activationImageDigest: imageDigest,
    qualificationSourceRevision: fixture.lock.sourceRevision,
    qualificationImageRepository: fixture.lock.image.repository,
    qualificationImageDigest: fixture.lock.image.digest,
    strategy,
    strategyProtocolHash,
    qualificationRunId: fixture.result.runId,
    qualificationLockId: fixture.lock.lockId,
    qualificationResultHash: fixture.result.resultHash,
    protocolHash: fixture.lock.protocolHash,
    qualificationExecutionPolicyHash: fixture.lock.policies.execution.contentHash,
    accountId,
    brokerIdentityHash: brokerIdentity.identityHash,
    authorityGenerationHash: baseConfig.alpaca!.authorityGenerationHash,
    riskPolicyHash: hash('risk-policy'),
    reconciliationId: reconciliation.reconciliationId,
    reconciliationContentHash: reconciliation.contentHash,
    ...overrides,
  }
  const discoveryReceipt = makeExecutionPrepareDiscoveryReceiptFixture({
    sourceRevision: binding.activationSourceRevision,
    imageRepository: binding.activationImageRepository,
    imageDigest: binding.activationImageDigest,
    strategy: binding.strategy,
    strategyProtocolHash: binding.strategyProtocolHash,
    qualificationRunId: binding.qualificationRunId,
    accountId: binding.accountId,
    authorityGenerationHash: binding.authorityGenerationHash,
    policyHash: binding.riskPolicyHash,
    reconciliationId: binding.reconciliationId,
    reconciliationContentHash: binding.reconciliationContentHash,
  })
  const discoveredCandidate = discoveryReceipt.candidateFacts.candidates[0]!
  const proofPlan = {
    schemaVersion: 'bayn.execution-prepare-proof-plan.v1' as const,
    candidate: {
      discoveryReceiptHash: discoveryReceipt.observationReceiptHash,
      immutableBindingHash: discoveryReceipt.immutableBindingHash,
      candidateFactsHash: discoveryReceipt.candidateFactsHash,
      candidateOrdinal: discoveredCandidate.ordinal,
      observedPlanIntentId: discoveredCandidate.observedPlanIntentId,
      cycleId: discoveryReceipt.binding.cycle.cycleId,
      decisionHash: discoveryReceipt.binding.cycle.decisionHash,
    },
    binding,
  }
  return {
    schemaVersion: 'bayn.execution-prepare-request.v1',
    discoveryReceipt,
    proofPlan,
    proofPlanHash: canonicalHashV1OrThrow(proofPlan),
  }
}

const runtimeBinding = (
  fixture: QualificationFixture,
  request: ExecutionPrepareRequest,
): ExecutionPrepareRuntimeBinding => ({
  sourceRevision,
  imageRepository,
  imageDigest,
  strategy,
  strategyProtocolHash,
  qualificationRunId: fixture.result.runId,
  accountId,
  brokerIdentityHash: brokerIdentity.identityHash,
  brokerProvider: BrokerProvider.Alpaca,
  brokerEnvironment: BrokerEnvironment.Sandbox,
  brokerAccess: BrokerAccess.ReadOnly,
  capitalAuthority: CapitalAuthorityKind.None,
  authorityGenerationHash: baseConfig.alpaca!.authorityGenerationHash,
  riskPolicyHash: request.proofPlan.binding.riskPolicyHash,
})

const prepareFixture = (fixture: QualificationFixture, reconciliation: ReconciliationFixture) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const authority = makeObserveAuthorityInterpreter(sql, makeAuthorityPostgres(sql), brokerIdentity)
    yield* seedQualification(fixture)
    yield* seedReconciliation(reconciliation)
    yield* authority.ensureAuthorityGeneration({
      generationHash: baseConfig.alpaca!.authorityGenerationHash,
      maximum: Authority.Observe,
    })
  })

describePostgres('EXECUTION_PREPARE PostgreSQL boundary', () => {
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

  test('does not create or migrate schema before durable PREPARE validation', async () => {
    const fixture = qualificationFixture('no-migrations', true)
    const reconciliation = reconciliationFixture('no-migrations')
    const request = makeRequest(fixture, reconciliation)
    const client = makeClientRuntime()
    await client.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
      }),
    )
    const runtime = makeRuntime(fixture.result.runId)
    try {
      let failedClosed = false
      try {
        await runtime.runPromise(prepareExecution(request, runtimeBinding(fixture, request)))
      } catch {
        failedClosed = true
      }
      expect(failedClosed).toBe(true)
      const [presence] = await client.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          return yield* sql<{
            readonly schemaMigrations: boolean
            readonly authorityState: boolean
          }>`
            SELECT
              to_regclass('public.schema_migrations') IS NOT NULL AS "schemaMigrations",
              to_regclass('public.authority_state') IS NOT NULL AS "authorityState"
          `
        }),
      )
      expect(presence).toEqual({ schemaMigrations: false, authorityState: false })
    } finally {
      await runtime.dispose()
      await client.dispose()
    }
  }, 15_000)

  test('returns proof while authority/history, intents, mutations, and broker mutation count remain unchanged', async () => {
    const fixture = qualificationFixture('success', true)
    const reconciliation = reconciliationFixture('success')
    const request = makeRequest(fixture, reconciliation)
    const runtime = makeRuntime(fixture.result.runId)
    let brokerMutationCount = 0
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          yield* prepareFixture(fixture, reconciliation)
          const before = yield* durableSnapshot
          const receipt = yield* prepareExecution(request, runtimeBinding(fixture, request))
          const after = yield* durableSnapshot
          return { after, before, receipt }
        }),
      )
      expect(result.after).toEqual(result.before)
      expect(brokerMutationCount).toBe(0)
      expect(result.receipt).toMatchObject({
        dispatchable: false,
        authority: { maximum: Authority.Observe, effective: Authority.Observe, activated: false },
        generation: { previousGenerationHash: baseConfig.alpaca!.authorityGenerationHash },
        reconciliation: {
          reconciliationId: reconciliation.reconciliationId,
          contentHash: reconciliation.contentHash,
        },
        dryRunSubmit: { included: false, reason: 'MUTATION_AUTHORITY_REQUIRED' },
      })
      expect(JSON.stringify(result.receipt)).not.toContain(accountId)
    } finally {
      brokerMutationCount = 0
      await runtime.dispose()
    }
  }, 15_000)

  test('fails closed for rejected qualification without changing durable execution state', async () => {
    const fixture = qualificationFixture('rejected', false)
    const reconciliation = reconciliationFixture('rejected')
    const request = makeRequest(fixture, reconciliation)
    const runtime = makeRuntime(fixture.result.runId)
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          yield* prepareFixture(fixture, reconciliation)
          const before = yield* durableSnapshot
          const failure = yield* Effect.flip(prepareExecution(request, runtimeBinding(fixture, request)))
          const after = yield* durableSnapshot
          return { after, before, failure }
        }),
      )
      expect(result.failure).toMatchObject({
        _tag: 'ExecutionPrepareStoreRejected',
        operation: 'authority',
        failure: 'invariant',
      })
      expect(result.after).toEqual(result.before)
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('fails closed for stale or non-exact reconciliation without changing durable execution state', async () => {
    for (const reconciliation of [
      reconciliationFixture('stale', { ageMs: baseConfig.reconciliationStaleThresholdMs + 1_000 }),
      reconciliationFixture('non-exact', { exact: false }),
    ]) {
      const fixture = qualificationFixture(reconciliation.exact ? 'stale' : 'non-exact', true)
      const request = makeRequest(fixture, reconciliation)
      const runtime = makeRuntime(fixture.result.runId)
      try {
        const result = await runtime.runPromise(
          Effect.gen(function* () {
            yield* prepareFixture(fixture, reconciliation)
            const before = yield* durableSnapshot
            const failure = yield* Effect.flip(prepareExecution(request, runtimeBinding(fixture, request)))
            const after = yield* durableSnapshot
            return { after, before, failure }
          }),
        )
        expect(result.failure).toMatchObject({
          _tag: 'ExecutionPrepareStoreRejected',
          operation: 'authority',
          failure: 'invariant',
        })
        expect(result.after).toEqual(result.before)
      } finally {
        await runtime.dispose()
      }
    }
  }, 20_000)

  test('fails closed when unresolved mutation history exists', async () => {
    const fixture = qualificationFixture('unresolved', true)
    const reconciliation = reconciliationFixture('unresolved')
    const request = makeRequest(fixture, reconciliation)
    const runtime = makeRuntime(fixture.result.runId)
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          yield* prepareFixture(fixture, reconciliation)
          yield* seedUnresolvedMutation(baseConfig.alpaca!.authorityGenerationHash)
          const before = yield* durableSnapshot
          const failure = yield* Effect.flip(prepareExecution(request, runtimeBinding(fixture, request)))
          const after = yield* durableSnapshot
          return { after, before, failure }
        }),
      )
      expect(result.failure).toMatchObject({
        _tag: 'ExecutionPrepareStoreRejected',
        operation: 'authority',
        failure: 'invariant',
      })
      expect(result.after).toEqual(result.before)
      expect(result.before).toMatchObject({ intents: 1, mutations: 1 })
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('rejects malformed and drifted operator bindings before durable PREPARE access', async () => {
    const fixture = qualificationFixture('operator-drift', true)
    const reconciliation = reconciliationFixture('operator-drift')
    const request = makeRequest(fixture, reconciliation)
    const runtime = makeRuntime(fixture.result.runId)
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          yield* prepareFixture(fixture, reconciliation)
          const before = yield* durableSnapshot
          const mixedProofPlan = {
            ...request.proofPlan,
            candidate: {
              ...request.proofPlan.candidate,
              observedPlanIntentId: hash('foreign-observed-plan-intent'),
            },
          }
          const candidates: readonly [unknown, unknown][] = [
            [{ ...request, unexpected: true }, runtimeBinding(fixture, request)],
            [request, { ...runtimeBinding(fixture, request), accountId: 'drifted-account' }],
            [request, { ...runtimeBinding(fixture, request), authorityGenerationHash: hash('drifted-generation') }],
            [
              request,
              {
                ...runtimeBinding(fixture, request),
                strategy: { ...strategy, behaviorHash: hash('drifted-strategy') },
              },
            ],
            [request, { ...runtimeBinding(fixture, request), riskPolicyHash: hash('drifted-policy') }],
            [{ ...request, proofPlanHash: hash('drifted-proof') }, runtimeBinding(fixture, request)],
            [
              {
                ...request,
                proofPlan: mixedProofPlan,
                proofPlanHash: canonicalHashV1OrThrow(mixedProofPlan),
              },
              runtimeBinding(fixture, request),
            ],
            [
              {
                ...request,
                discoveryReceipt: { ...request.discoveryReceipt, observationReceiptHash: hash('tampered-receipt') },
              },
              runtimeBinding(fixture, request),
            ],
          ]
          const failures = []
          for (const [candidateRequest, candidateRuntime] of candidates) {
            failures.push(yield* Effect.flip(prepareExecution(candidateRequest, candidateRuntime)))
          }
          const after = yield* durableSnapshot
          return { after, before, failures }
        }),
      )
      expect(result.failures.map((failure) => failure._tag)).toEqual([
        'ExecutionPrepareRequestInvalid',
        'ExecutionPrepareRuntimeMismatch',
        'ExecutionPrepareRuntimeMismatch',
        'ExecutionPrepareRuntimeMismatch',
        'ExecutionPrepareRuntimeMismatch',
        'ExecutionPrepareProofPlanHashMismatch',
        'ExecutionPrepareDiscoveryMismatch',
        'ExecutionPrepareDiscoveryMismatch',
      ])
      expect(result.after).toEqual(result.before)
    } finally {
      await runtime.dispose()
    }
  }, 15_000)
})
