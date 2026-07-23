import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, ManagedRuntime, Redacted } from 'effect'

import type { RuntimeConfig } from '../config'
import { makeStrategyProtocolHash } from '../contracts'
import { operationalError } from '../errors'
import { WriterFenceLive } from '../execution/writer-fence'
import { canonicalHashV1 } from '../hash'
import { hashLedgerPlan } from '../ledger-plan'
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
  makePaperAuthorityGeneration,
  type PaperAuthorityGeneration,
} from '../paper'
import {
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
import { EvidenceStore, EvidenceStoreLive, PostgresClientLive } from './evidence-store'
import { PaperStore, PaperStoreLive } from './paper-store'

const postgresUrl = process.env.BAYN_TEST_POSTGRES_URL
const testUrl = postgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = postgresUrl === undefined ? describe.skip : describe
const accountId = 'paper-account-1'
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

const qualificationPolicy = (name: string) =>
  makeQualificationPolicyDocument(`bayn.${name}.v1`, {
    schemaVersion: `bayn.${name}.v1`,
    enabled: true,
  })

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

const makeQualificationFixture = (name: string, qualified: boolean): QualificationFixture => {
  const runId = hash(`${name}-run`)
  const snapshotId = hash(`${name}-snapshot`)
  const lock = makeQualificationLock({
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
      uncertainty: qualificationPolicy(`${name}-uncertainty-policy`),
      execution: makeQualificationPolicyDocument(
        fixtureProtocol.executionModel.schemaVersion,
        fixtureProtocol.executionModel,
      ),
    },
    priorTrialRunIds: [],
  })
  const analysis = analyzeQualification(qualificationSeries(runId), defaultQualificationStatisticsPolicy, [])
  const evaluationVerdict = qualified
    ? {
        status: 'PASS' as const,
        gates: [{ name: 'paper_activation_fixture', passed: true, actual: 1, required: 1 }],
      }
    : {
        status: 'FAIL_CLOSED' as const,
        gates: [{ name: 'paper_activation_fixture', passed: false, actual: 0, required: 1 }],
      }
  return { lock, result: makeQualificationResult(lock, evaluationVerdict, analysis) }
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
  maximumAuthority: Authority.Observe,
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
      control.planHashes.push(hashLedgerPlan(plan))
      return control.fail
        ? Effect.fail(operationalError('journal', 'post', 'injected TigerBeetle failure'))
        : Effect.void
    }),
  verifyAccount: () => Effect.succeed(true),
  journalAndReconcile: () => Effect.die(new Error('unexpected simulation journal call')),
  check: Effect.void,
  checkRun: () => Effect.void,
})

const makeStoreRuntime = (control: JournalControl, runtimeConfig: RuntimeConfig = config) =>
  ManagedRuntime.make(
    PaperStoreLive(runtimeConfig).pipe(
      Layer.provideMerge(WriterFenceLive),
      Layer.provideMerge(Layer.succeed(Journal, journal(control))),
      Layer.provideMerge(PostgresClientLive(runtimeConfig)),
      Layer.provide(NodeServices.layer),
    ),
  )

const makeClientRuntime = () => ManagedRuntime.make(PostgresClientLive(config).pipe(Layer.provide(NodeServices.layer)))

const makeEvidenceRuntime = () => ManagedRuntime.make(EvidenceStoreLive(config).pipe(Layer.provide(NodeServices.layer)))

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
        ${sql.json(JSON.stringify(result.evaluationVerdict.gates[0].actual))},
        ${sql.json(JSON.stringify(result.evaluationVerdict.gates[0].required))},
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
        ${stateHash}, ${stateHash}, ${fixture.contentHash}, 'EXACT', ${sql.json(JSON.stringify([]))},
        clock_timestamp() - (${fixture.databaseAgeMs} * interval '1 millisecond')
      )
    `
  })

const makeActivation = (
  previousGenerationHash: string,
  qualification: QualificationFixture,
  reconciliation: Pick<ReconciliationFixture, 'contentHash' | 'reconciliationId'>,
  overrides: Partial<Parameters<typeof makePaperAuthorityGeneration>[0]> = {},
) =>
  makePaperAuthorityGeneration({
    schemaVersion: 'bayn.paper-authority-generation.v1',
    maximum: Authority.Paper,
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

const proofBinding = (activation: PaperAuthorityGeneration) => ({
  schemaVersion: 'bayn.paper-authority-proof-binding.v1' as const,
  riskPolicyHash: activation.riskPolicyHash,
  proofPlanHash: activation.proofPlanHash,
})

const paperRuntimeConfig = (
  activation: PaperAuthorityGeneration,
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig => ({
  ...config,
  maximumAuthority: Authority.Paper,
  qualificationRunId: activation.qualificationRunId,
  build: {
    ...config.build,
    strategyBehaviorHash: activation.strategyBehaviorHash,
    strategyParameterHash: activation.strategyParameterHash,
  },
  alpaca: {
    accountId: activation.accountId,
    authorityGenerationHash: activation.generationHash,
    key: Redacted.make('unused'),
    secret: Redacted.make('unused'),
    proxyUrl: 'http://bayn-egress-proxy.invalid',
    retryAttempts: 0,
    reconciliationIntervalMs: 30_000,
  },
  ...overrides,
})

const prepareRuntimeConfig = (activation: PaperAuthorityGeneration): RuntimeConfig => {
  const runtimeConfig = paperRuntimeConfig(activation)
  const alpaca = runtimeConfig.alpaca
  if (alpaca === undefined) {
    throw new Error('PAPER PREPARE fixture requires an Alpaca binding')
  }
  return {
    ...runtimeConfig,
    maximumAuthority: Authority.Observe,
    alpaca: {
      ...alpaca,
      authorityGenerationHash: activation.previousGenerationHash,
    },
  }
}

const makeActivationRuntime = (
  control: JournalControl,
  activation: PaperAuthorityGeneration,
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

const fillEvent = (
  id: string,
  side: OrderSide,
  quantityMicros: string,
  priceMicros: string,
  eventOccurredAt = occurredAt,
  brokerTimestamp = sourceTimestamp(eventOccurredAt),
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
          const store = yield* PaperStore
          const sql = yield* PgClient.PgClient
          const [databaseBefore] = yield* sql<{ observed_at: Date }>`
            SELECT clock_timestamp() AS observed_at
          `
          const first = yield* store.ensureAuthorityGeneration({
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
          const [afterRotation] = yield* sql<{ rows: number; tuple_id: string; version: number }>`
            SELECT
              count(*) OVER ()::integer AS rows,
              xmin::text AS tuple_id,
              version::integer
            FROM authority_state
          `
          return {
            first,
            replay,
            rotated,
            databaseBefore: databaseBefore.observed_at,
            databaseAfter: databaseAfter.observed_at,
            beforeReplay,
            afterReplay,
            afterRotation,
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
      expect(result.afterRotation).toMatchObject({ rows: 1, version: 2 })
      expect(result.afterRotation.tuple_id).not.toBe(result.afterReplay.tuple_id)
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('serializes concurrent absent-row authority initialization', async () => {
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
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

  test('rotates monotonically while preserving an active kill exactly', async () => {
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
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
          const store = yield* PaperStore
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
          const store = yield* PaperStore
          const invalid = yield* Effect.flip(
            store.ensureAuthorityGeneration({
              generationHash: 'not-a-sha256',
              maximum: Authority.Observe,
            }),
          )
          const paper = yield* Effect.flip(
            store.ensureAuthorityGeneration({
              generationHash: hash('paper-authority-generation'),
              maximum: Authority.Paper,
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
          yield* store.activatePaperGeneration(proofBinding(activation))
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
            const store = yield* PaperStore
            const sql = yield* PgClient.PgClient
            yield* seedQualificationEvidence(qualifiedEvidence)
            yield* seedExactReconciliation(reconciliation)
            yield* store.ensureAuthorityGeneration({
              generationHash: initialGenerationHash,
              maximum: Authority.Observe,
            })
            const readAuthorityEvidence = sql<{ authority: unknown; history: unknown }>`
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
            const [before] = yield* readAuthorityEvidence
            const first = yield* store.preparePaperGeneration(proofBinding(expected))
            const second = yield* store.preparePaperGeneration(proofBinding(expected))
            const [after] = yield* readAuthorityEvidence
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
        Effect.flatMap(PaperStore, (store) => store.activatePaperGeneration(proofBinding(preparation.first))),
      )
      expect(activated).toMatchObject({
        generationHash: preparation.first.generationHash,
        maximum: Authority.Paper,
        effective: Authority.Paper,
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
          const store = yield* PaperStore
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
      throw new Error('PAPER PREPARE fixture requires an Alpaca binding')
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
          const store = yield* PaperStore
          const sql = yield* PgClient.PgClient
          const readAuthorityEvidence = sql<{ authority: unknown; history: unknown }>`
            SELECT
              (SELECT jsonb_agg(to_jsonb(authority)) FROM authority_state AS authority) AS authority,
              (
                SELECT jsonb_agg(to_jsonb(history) ORDER BY history.authority_version)
                FROM authority_generations AS history
              ) AS history
          `
          const [before] = yield* readAuthorityEvidence
          const failure = yield* Effect.flip(store.preparePaperGeneration(proofBinding(expected)))
          const [after] = yield* readAuthorityEvidence
          return { after, before, failure }
        }),
      )
      expect(result.failure).toMatchObject({
        operation: 'authority',
        failure: 'invariant',
        message: 'PAPER PREPARE current authority differs from the configured OBSERVE generation',
      })
      expect(result.after).toEqual(result.before)
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('rejects reconciliation drift between PREPARE and activation without authority writes', async () => {
    const initialGenerationHash = hash('prepare-reconciliation-drift-observe')
    const reconciliation = exactReconciliation('prepare-reconciliation-drift')
    const expected = makeActivation(initialGenerationHash, qualifiedEvidence, reconciliation)
    const prepareRuntime = makeStoreRuntime({ fail: false, planHashes: [] }, prepareRuntimeConfig(expected))
    const prepared = await (async () => {
      try {
        return await prepareRuntime.runPromise(
          Effect.gen(function* () {
            const store = yield* PaperStore
            yield* seedQualificationEvidence(qualifiedEvidence)
            yield* seedExactReconciliation(reconciliation)
            yield* store.ensureAuthorityGeneration({
              generationHash: initialGenerationHash,
              maximum: Authority.Observe,
            })
            const receipt = yield* store.preparePaperGeneration(proofBinding(expected))
            yield* seedExactReconciliation(exactReconciliation('post-prepare-reconciliation'))
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
          const store = yield* PaperStore
          const sql = yield* PgClient.PgClient
          const readAuthorityEvidence = sql<{ authority: unknown; history: unknown }>`
            SELECT
              (SELECT jsonb_agg(to_jsonb(authority)) FROM authority_state AS authority) AS authority,
              (
                SELECT jsonb_agg(to_jsonb(history) ORDER BY history.authority_version)
                FROM authority_generations AS history
              ) AS history
          `
          const [before] = yield* readAuthorityEvidence
          const failure = yield* Effect.flip(store.activatePaperGeneration(proofBinding(prepared)))
          const [after] = yield* readAuthorityEvidence
          return { after, before, failure }
        }),
      )
      expect(result.failure).toMatchObject({
        operation: 'authority',
        failure: 'invariant',
        message: 'derived PAPER generation differs from the configured generation',
      })
      expect(result.after).toEqual(result.before)
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
            const store = yield* PaperStore
            yield* seedQualificationEvidence(qualifiedEvidence)
            yield* seedExactReconciliation(reconciliation)
            yield* store.ensureAuthorityGeneration({
              generationHash: initialGenerationHash,
              maximum: Authority.Observe,
            })
            const receipt = yield* store.preparePaperGeneration(proofBinding(expected))
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
          const store = yield* PaperStore
          const sql = yield* PgClient.PgClient
          const readAuthorityEvidence = sql<{ authority: unknown; history: unknown }>`
            SELECT
              (SELECT jsonb_agg(to_jsonb(authority)) FROM authority_state AS authority) AS authority,
              (
                SELECT jsonb_agg(to_jsonb(history) ORDER BY history.authority_version)
                FROM authority_generations AS history
              ) AS history
          `
          const [before] = yield* readAuthorityEvidence
          const failure = yield* Effect.flip(store.activatePaperGeneration(proofBinding(prepared)))
          const [after] = yield* readAuthorityEvidence
          return { after, before, failure }
        }),
      )
      expect(result.failure).toMatchObject({
        operation: 'authority',
        failure: 'invariant',
        message: 'derived PAPER generation differs from the configured generation',
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
      { ...validConfig, maximumAuthority: Authority.Observe },
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
          accountId: 'wrong-configured-paper-account',
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
            const store = yield* PaperStore
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
            Effect.flatMap(PaperStore, (store) => Effect.flip(store.activatePaperGeneration(proofBinding(activation)))),
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
          Effect.flatMap(PaperStore, (store) =>
            Effect.flip(store.activatePaperGeneration(proofBinding(wrongBuildActivation))),
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
          Effect.flatMap(PaperStore, (store) => Effect.flip(store.activatePaperGeneration(proofBinding(activation)))),
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
        Effect.flatMap(PaperStore, (store) => store.activatePaperGeneration(proofBinding(activation))),
      )
      expect(activated).toMatchObject({
        generationHash: activation.generationHash,
        maximum: Authority.Paper,
        effective: Authority.Paper,
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
      message: 'derived PAPER generation differs from the configured generation',
    })
    expect(wrongStrategyFailure).toMatchObject({
      operation: 'authority',
      failure: 'invariant',
      message: 'PAPER generation differs from terminal qualification evidence or current strategy build',
    })
    expect(afterRejected).toEqual(before)
  }, 15_000)

  test('activates one exact QUALIFIED PAPER generation and replays it without writing', async () => {
    const initialGenerationHash = hash('paper-activation-observe-generation')
    const reconciliation = exactReconciliation('paper-activation')
    const activation = makeActivation(initialGenerationHash, qualifiedEvidence, reconciliation)
    const runtime = makeActivationRuntime({ fail: false, planHashes: [] }, activation)
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
          const sql = yield* PgClient.PgClient
          yield* seedQualificationEvidence(qualifiedEvidence)
          yield* seedExactReconciliation(reconciliation)
          const observe = yield* store.ensureAuthorityGeneration({
            generationHash: initialGenerationHash,
            maximum: Authority.Observe,
          })
          const activated = yield* store.activatePaperGeneration(proofBinding(activation))
          const [beforeReplay] = yield* sql<{
            authority_tuple: string
            history_count: number
            paper_tuple: string
          }>`
            SELECT
              authority.xmin::text AS authority_tuple,
              paper.xmin::text AS paper_tuple,
              (SELECT count(*)::integer FROM authority_generations) AS history_count
            FROM authority_state AS authority
            JOIN authority_generations AS paper
              ON paper.generation_hash = authority.generation_hash
          `
          yield* seedExactReconciliation(exactReconciliation('paper-replay-later-reconciliation'))
          const replay = yield* store.activatePaperGeneration(proofBinding(activation))
          const changedProof = yield* Effect.flip(
            store.activatePaperGeneration({
              ...proofBinding(activation),
              proofPlanHash: hash('paper-replay-changed-proof'),
            }),
          )
          const [afterReplay] = yield* sql<{
            authority_tuple: string
            history_count: number
            paper_tuple: string
          }>`
            SELECT
              authority.xmin::text AS authority_tuple,
              paper.xmin::text AS paper_tuple,
              (SELECT count(*)::integer FROM authority_generations) AS history_count
            FROM authority_state AS authority
            JOIN authority_generations AS paper
              ON paper.generation_hash = authority.generation_hash
          `
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
        maximum: Authority.Paper,
        effective: Authority.Paper,
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
          account_id: null,
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
          maximum: Authority.Paper,
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
      expect(result.activation.qualificationSourceRevision).not.toBe(result.activation.activationSourceRevision)
      expect(result.activation.qualificationImageRepository).not.toBe(result.activation.activationImageRepository)
      expect(result.activation.qualificationImageDigest).not.toBe(result.activation.activationImageDigest)
    } finally {
      await runtime.dispose()
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
          const store = yield* PaperStore
          yield* seedQualificationEvidence(qualifiedEvidence)
          yield* seedExactReconciliation(reconciliation)
          yield* store.ensureAuthorityGeneration({
            generationHash: initialGenerationHash,
            maximum: Authority.Observe,
          })
          yield* store.activatePaperGeneration(proofBinding(activation))
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
          accountId: 'changed-replay-account',
        },
      },
    )
    try {
      const result = await replayRuntime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
          const sql = yield* PgClient.PgClient
          const readAuthorityEvidence = sql<{ authority: unknown; history: unknown }>`
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
          const [before] = yield* readAuthorityEvidence
          const failure = yield* Effect.flip(store.activatePaperGeneration(proofBinding(activation)))
          const [after] = yield* readAuthorityEvidence
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
            const store = yield* PaperStore
            yield* seedQualificationEvidence(qualifiedEvidence)
            yield* store.ensureAuthorityGeneration({
              generationHash: initialGenerationHash,
              maximum: Authority.Observe,
            })
            const before = yield* readAuthorityEvidence
            yield* seedExactReconciliation(staleReconciliation)
            const failure = yield* Effect.flip(store.activatePaperGeneration(proofBinding(staleActivation)))
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
          const store = yield* PaperStore
          yield* seedExactReconciliation(futureReconciliation)
          const failure = yield* Effect.flip(store.activatePaperGeneration(proofBinding(futureActivation)))
          const after = yield* readAuthorityEvidence
          return { after, failure }
        }),
      )

      expect(staleResult.failure).toMatchObject({
        operation: 'authority',
        failure: 'invariant',
        message: 'PAPER generation requires the latest fresh exact account reconciliation',
      })
      expect(futureResult.failure).toMatchObject({
        operation: 'authority',
        failure: 'invariant',
        message: 'PAPER generation requires the latest fresh exact account reconciliation',
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
          const store = yield* PaperStore
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
              Effect.exit(store.activatePaperGeneration(proofBinding(paperActivation))),
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
          'PAPER generation requires the latest fresh exact account reconciliation',
        )
      }
      expect(result.after).toEqual(result.before)
    } finally {
      await blocker.dispose()
      await runtime.dispose()
    }
  }, 15_000)

  test('serializes concurrent PAPER activation into one history row and state transition', async () => {
    const initialGenerationHash = hash('concurrent-paper-observe-generation')
    const reconciliation = exactReconciliation('concurrent-paper-activation')
    const activation = makeActivation(initialGenerationHash, qualifiedEvidence, reconciliation)
    const runtime = makeActivationRuntime({ fail: false, planHashes: [] }, activation)
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
          yield* seedQualificationEvidence(qualifiedEvidence)
          yield* seedExactReconciliation(reconciliation)
          yield* store.ensureAuthorityGeneration({
            generationHash: initialGenerationHash,
            maximum: Authority.Observe,
          })
          const states = yield* Effect.all(
            Array.from({ length: 12 }, () => store.activatePaperGeneration(proofBinding(activation))),
            { concurrency: 'unbounded' },
          )
          const sql = yield* PgClient.PgClient
          const [stored] = yield* sql<{ history_count: number; paper_count: number; version: number }>`
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
          return { states, stored }
        }),
      )

      expect(result.states).toHaveLength(12)
      expect(new Set(result.states.map((state) => JSON.stringify(state))).size).toBe(1)
      expect(result.states[0]).toMatchObject({
        maximum: Authority.Paper,
        effective: Authority.Paper,
        version: 2,
      })
      expect(result.stored).toEqual({ history_count: 2, paper_count: 1, version: 2 })
    } finally {
      await runtime.dispose()
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
          const store = yield* PaperStore
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
          const activated = yield* store.activatePaperGeneration(proofBinding(activation))
          return { activated, before }
        }),
      )

      expect(result.activated).toMatchObject({
        maximum: Authority.Paper,
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
          const store = yield* PaperStore
          const sql = yield* PgClient.PgClient
          yield* seedQualificationEvidence(qualifiedEvidence)
          yield* seedExactReconciliation(reconciliation)
          yield* store.ensureAuthorityGeneration({
            generationHash: initialGenerationHash,
            maximum: Authority.Observe,
          })
          const [before] = yield* sql<{ authority: unknown; history: unknown }>`
            SELECT
              (SELECT jsonb_agg(to_jsonb(authority)) FROM authority_state AS authority) AS authority,
              (
                SELECT jsonb_agg(to_jsonb(history) ORDER BY history.authority_version)
                FROM authority_generations AS history
              ) AS history
          `
          const changedProof = yield* Effect.flip(
            store.activatePaperGeneration({
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
              'DISCREPANCY', ${sql.json(JSON.stringify([{ discrepancyId: hash('discrepancy') }]))},
              clock_timestamp()
            )
          `
          const stale = yield* Effect.flip(store.activatePaperGeneration(proofBinding(activation)))
          const [after] = yield* sql<{ authority: unknown; history: unknown }>`
            SELECT
              (SELECT jsonb_agg(to_jsonb(authority)) FROM authority_state AS authority) AS authority,
              (
                SELECT jsonb_agg(to_jsonb(history) ORDER BY history.authority_version)
                FROM authority_generations AS history
              ) AS history
          `
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
            const store = yield* PaperStore
            yield* seedQualificationEvidence(rejectedEvidence)
            yield* seedExactReconciliation(reconciliation)
            yield* store.ensureAuthorityGeneration({
              generationHash: initialGenerationHash,
              maximum: Authority.Observe,
            })
            return yield* Effect.flip(store.activatePaperGeneration(proofBinding(rejectedActivation)))
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
          const store = yield* PaperStore
          const sql = yield* PgClient.PgClient
          yield* sql`
            INSERT INTO intents (
              intent_id, schema_version, account_id, client_order_id, symbol, side,
              order_type, time_in_force, quantity_micros, notional_limit_micros,
              state, state_version, created_at, updated_at,
              strategy_name, cycle_id, decision_hash, policy_hash
            ) VALUES (
              ${hash('unresolved-intent')}, 'bayn.paper-intent.v2', ${accountId},
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
          const unresolved = yield* Effect.flip(store.activatePaperGeneration(proofBinding(qualifiedActivation)))
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
          const store = yield* PaperStore
          const returnObserveHash = hash('authority-generation-c')
          yield* seedQualificationEvidence(qualifiedEvidence)
          yield* seedExactReconciliation(reconciliation)
          yield* store.ensureAuthorityGeneration({
            generationHash: firstObserveHash,
            maximum: Authority.Observe,
          })
          yield* store.activatePaperGeneration(proofBinding(activation))
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
          const store = yield* PaperStore
          const baselineBefore = yield* store.hasAccountBaseline(accountId)
          const first = yield* store.ingest(accountEvent())
          const baselineAfter = yield* store.hasAccountBaseline(accountId)
          const replay = yield* store.ingest(accountEvent())
          const order = yield* store.ingest(orderEvent())
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
          return { baselineAfter, baselineBefore, first, replay, order, conflict, counts }
        }),
      )

      expect(result.first).toMatchObject({ sourceSequence: '0', deduplicated: false })
      expect(result.baselineBefore).toBe(false)
      expect(result.baselineAfter).toBe(true)
      expect(result.replay).toEqual({ ...result.first, deduplicated: true })
      expect(result.order).toMatchObject({ sourceSequence: '1', deduplicated: false })
      expect(Exit.isFailure(result.conflict)).toBe(true)
      if (Exit.isFailure(result.conflict)) expect(Cause.pretty(result.conflict.cause)).toContain('different content')
      expect(result.counts).toEqual({ events: 2, accounts: 1, orders: 1 })
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  test('treats cancel history as newer than submit history when broker timestamps tie', async () => {
    const runtime = makeStoreRuntime({ fail: false, planHashes: [] })
    const intentId = 'a'.repeat(64)
    const brokerOrderId = orderEvent().order.brokerOrderId
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
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
          const sql = yield* PgClient.PgClient
          yield* sql`
            INSERT INTO intents (
              intent_id, schema_version, account_id, client_order_id, symbol, side,
              order_type, time_in_force, quantity_micros, notional_limit_micros,
              state, state_version, created_at, updated_at,
              strategy_name, cycle_id, decision_hash, policy_hash
            ) VALUES (
              ${intentId}, 'bayn.paper-intent.v2', ${accountId}, ${orderEvent().order.clientOrderId},
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
                'SUBMIT', 'SUBMIT_STARTED', ${'4'.repeat(64)}, 1000, NULL, NULL, NULL, NULL, ${occurredAt}
              ),
              (
                ${'f'.repeat(64)}, 'bayn.paper-mutation-event.v1', ${'3'.repeat(64)}, ${intentId}, 2,
                'SUBMIT', 'SUBMIT_ACCEPTED', ${'4'.repeat(64)}, 1000, ${brokerOrderId}, 'submit-request',
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
            orders: [{ ...orderEvent().order, intentId }],
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
        authority: null,
        authorityObservedAt: null,
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
      sourceTimestamp('2026-07-21T19:58:00.000Z'),
      accountId,
      '2026-07-21T19:58:01.000Z',
    )
    const priorSell = fillEvent(
      'fill-prior-sell',
      OrderSide.Sell,
      '1000000',
      '70000000',
      '2026-07-21T19:59:00.000Z',
      sourceTimestamp('2026-07-21T19:59:00.000Z'),
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
      sourceTimestamp(occurredAt),
      otherAccountId,
    )
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
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
      const failed = await runtime.runPromiseExit(Effect.flatMap(PaperStore, (store) => store.account(buy)))
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
      const outOfOrder = await runtime.runPromiseExit(Effect.flatMap(PaperStore, (store) => store.account(sell)))
      expect(Exit.isFailure(outOfOrder)).toBe(true)
      if (Exit.isFailure(outOfOrder)) expect(Cause.pretty(outOfOrder.cause)).toContain('earlier fill')
      expect(control.planHashes).toHaveLength(3)

      const [receipt, replay, sale, otherAccountFill] = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PaperStore
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
          const store = yield* PaperStore
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
          const store = yield* PaperStore
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
          const store = yield* PaperStore
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
          const store = yield* PaperStore
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
              const store = yield* PaperStore
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
          const store = yield* PaperStore
          const sql = yield* PgClient.PgClient
          const activated = yield* store.activatePaperGeneration(proofBinding(activation))
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
          const mismatchObservedAt = new Date(activationTime + 1).toISOString()
          const ongoingObservedAt = new Date(activationTime + 2).toISOString()
          const resolvedObservedAt = new Date(activationTime + 3).toISOString()

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

          const rows = yield* sql<{ discrepancy_count: number; status: string }>`
            SELECT status, jsonb_array_length(discrepancies)::integer AS discrepancy_count
            FROM reconciliations
            ORDER BY reconciled_at
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
      expect(result.rows).toEqual([
        { status: ReconciliationStatus.Exact, discrepancy_count: 0 },
        { status: ReconciliationStatus.Discrepancy, discrepancy_count: 1 },
        { status: ReconciliationStatus.Discrepancy, discrepancy_count: 1 },
        { status: ReconciliationStatus.Exact, discrepancy_count: 0 },
      ])
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
