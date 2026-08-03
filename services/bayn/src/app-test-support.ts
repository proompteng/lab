import assert from 'node:assert/strict'

import { expect } from 'bun:test'

import { Effect, Option, pipe, Redacted, Result } from 'effect'

import type { RuntimeConfig } from './config'
import { deriveCycleOperationsStatus } from './cycle-observability'
import type { EvidenceStoreService, StoredEvaluationEvidence } from './db/evidence-store'
import type { JournalService } from './ledger'
import type { MarketDataService } from './market-data'
import { Authority } from './execution/contracts'
import { BrokerAccess, noCapitalAuthority } from './execution/authority'
import { makeQualificationResult } from './qualification'
import {
  analyzeQualification,
  defaultQualificationStatisticsPolicy,
  prepareQualificationSeries,
} from './qualification-statistics'
import { evaluateRiskBalancedTrend, parseMatchingManifest, summarizeEvaluation } from './risk-balanced-trend'
import type { RuntimeState } from './runtime-state'
import { makeRiskBalancedTrendApplication } from './strategy'
import { prepareRiskBalancedTrendQualificationLock } from './strategy/risk-balanced-trend/qualification'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'

export const provenance = makeTestProvenance()
export const historicalRunId = '9'.repeat(64)
export const historicalEvidence: StoredEvaluationEvidence = {
  protocol: {
    protocolHash: '8'.repeat(64),
    schemaVersion: fixtureProtocol.schemaVersion,
    strategyName: 'risk-balanced-trend',
    behaviorHash: provenance.strategy.behaviorHash,
    parameterHash: provenance.strategy.parameterHash,
    parameters: fixtureProtocol,
  },
  run: {
    runId: historicalRunId,
    protocolHash: '8'.repeat(64),
    snapshotId: '7'.repeat(64),
    evaluationSchemaVersion: 'bayn.evaluation.v6',
    sourceRevision: provenance.sourceRevision,
    imageRepository: provenance.image.repository,
    imageDigest: provenance.image.digest,
    strategyName: 'risk-balanced-trend',
    initialCapitalMicros: '1000000000000',
    artifactCount: 0,
    eventCount: 0,
    gateCount: 0,
  },
  artifacts: [],
  events: [],
  gates: [],
  statuses: [],
}

export const config: RuntimeConfig = {
  host: '127.0.0.1',
  port: 0,
  execution: {
    brokerIdentity: undefined,
    brokerAccess: BrokerAccess.ReadOnly,
    capitalAuthority: noCapitalAuthority,
  },
  build: {
    sourceRevision: provenance.sourceRevision,
    imageRepository: provenance.image.repository,
    imageDigest: provenance.image.digest,
    strategyBehaviorHash: provenance.strategy.behaviorHash,
    strategyParameterHash: provenance.strategy.parameterHash,
    verification: 'embedded',
  },
  healthIntervalMs: 100,
  operationTimeoutMs: 250,
  cycleStallThresholdMs: 300_000,
  reconciliationStaleThresholdMs: 120_000,
  unknownMutationThresholdMs: 300_000,
  clickhouse: {
    url: 'http://clickhouse.test:8123',
    username: 'bayn',
    password: Redacted.make('secret'),
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
  postgres: {
    url: Redacted.make('postgresql://bayn:secret@postgres.test:5432/bayn'),
    tls: false,
    caPath: '/tmp/test-postgres-ca.crt',
  },
  tigerBeetle: { clusterId: 2001n, replicaAddresses: ['3000'], ledger: 7001 },
}

export const successfulJournal: JournalService = {
  post: () => Effect.void,
  verifyAccount: () => Effect.succeed(true),
  check: Effect.void,
  checkRun: () => Effect.void,
  journalAndReconcile: (evaluation) =>
    Effect.succeed({
      runId: evaluation.runId,
      accountCount: evaluation.inputManifest.symbols.length + 5,
      transferCount: evaluation.events.length,
      exact: true,
    }),
}

export const marketDataService = (
  load: MarketDataService['load'],
  inspectedSnapshot = makeSnapshot(),
): MarketDataService => ({
  check: Effect.sync(() => inspectedSnapshot.manifest.finalizedSnapshot),
  inspect: Effect.sync(() => ({
    manifest: inspectedSnapshot.manifest,
    sessionDates: [...new Set(inspectedSnapshot.bars.map((bar) => bar.sessionDate))].sort(),
    signalSession: {
      calendar_version: inspectedSnapshot.manifest.finalizedSnapshot.calendarVersion,
      session_date: inspectedSnapshot.manifest.lastSession,
      close_time: '16:00',
      timezone: 'America/New_York',
    },
  })),
  inspectCyclePublications: Effect.die(
    new Error('startup test market data must not inspect cycle publication candidates'),
  ),
  inspectPublication: () => Effect.die(new Error('startup test market data must not inspect cycle publications')),
  inspectSnapshotPublication: () =>
    Effect.die(new Error('startup test market data must not inspect bound cycle publications')),
  loadSnapshotPublication: () => load,
  load,
})

export const successfulEvidenceStore: EvidenceStoreService = {
  check: Effect.void,
  read: (runId) => Effect.succeed(runId === historicalRunId ? Option.some(historicalEvidence) : Option.none()),
  readArtifactItems: () => Effect.succeed(Option.none()),
  recover: () => Effect.succeed(Option.none()),
  listPriorTrials: Effect.succeed([]),
  openQualification: ({ lock }) => Effect.succeed({ state: 'ACQUIRED', lock }),
  readQualification: () => Effect.succeed(Option.none()),
  persist: ({ evaluation }) =>
    Effect.succeed({
      runId: evaluation.runId,
      deduplicated: false,
      artifactCount: 17,
      eventCount: evaluation.events.length,
      gateCount: evaluation.verdict.gates.length,
    }),
}

export const fixtureSnapshot = makeSnapshot()
const fixtureApplication = makeRiskBalancedTrendApplication(fixtureProtocol)
export const fixtureRuntime = {
  application: fixtureApplication,
  definition: fixtureApplication.definition,
  provenance,
} as const
const fixtureEvaluationResult = evaluateRiskBalancedTrend(
  fixtureSnapshot.bars,
  fixtureSnapshot.manifest,
  fixtureProtocol,
  provenance,
  fixtureRuntime.definition,
)
assert(
  Result.isSuccess(fixtureEvaluationResult),
  `fixture strategy evaluation must succeed: ${JSON.stringify(fixtureEvaluationResult)}`,
)
export const fixtureEvaluation = fixtureEvaluationResult.success
const fixtureLockResult = pipe(
  parseMatchingManifest(fixtureSnapshot.manifest, fixtureProtocol),
  Result.flatMap((manifest) =>
    prepareRiskBalancedTrendQualificationLock(
      manifest,
      [...new Set(fixtureSnapshot.bars.map((bar) => bar.sessionDate))].sort(),
      [],
      fixtureProtocol,
      provenance,
    ),
  ),
)
assert(Result.isSuccess(fixtureLockResult), 'fixture qualification lock must succeed')
export const fixtureLock = fixtureLockResult.success
const fixtureAnalysisResult = pipe(
  prepareQualificationSeries(fixtureEvaluation),
  Result.flatMap((series) => analyzeQualification(series, defaultQualificationStatisticsPolicy, [])),
)
assert(Result.isSuccess(fixtureAnalysisResult), 'fixture qualification analysis must succeed')
const fixtureQualificationResult = makeQualificationResult(
  fixtureLock,
  fixtureEvaluation.verdict,
  fixtureAnalysisResult.success,
)
assert(Result.isSuccess(fixtureQualificationResult), 'fixture qualification result must succeed')
export const fixtureQualification = fixtureQualificationResult.success
export const pinnedExecutionProvenance = {
  ...provenance,
  sourceRevision: 'e'.repeat(40),
  image: { repository: provenance.image.repository, digest: `sha256:${'f'.repeat(64)}` },
}
const pinnedApplication = makeRiskBalancedTrendApplication(fixtureProtocol)
export const pinnedRuntime = {
  application: pinnedApplication,
  definition: pinnedApplication.definition,
  provenance: pinnedExecutionProvenance,
} as const
const pinnedEvaluationResult = evaluateRiskBalancedTrend(
  fixtureSnapshot.bars,
  fixtureSnapshot.manifest,
  fixtureProtocol,
  pinnedExecutionProvenance,
  pinnedRuntime.definition,
)
assert(Result.isSuccess(pinnedEvaluationResult), 'pinned strategy evaluation must succeed')
export const pinnedEvaluation = pinnedEvaluationResult.success
const pinnedLockResult = pipe(
  parseMatchingManifest(fixtureSnapshot.manifest, fixtureProtocol),
  Result.flatMap((manifest) =>
    prepareRiskBalancedTrendQualificationLock(
      manifest,
      [...new Set(fixtureSnapshot.bars.map((bar) => bar.sessionDate))].sort(),
      [],
      fixtureProtocol,
      pinnedExecutionProvenance,
    ),
  ),
)
assert(Result.isSuccess(pinnedLockResult), 'pinned qualification lock must succeed')
export const pinnedLock = pinnedLockResult.success
const pinnedAnalysisResult = pipe(
  prepareQualificationSeries(pinnedEvaluation),
  Result.flatMap((series) => analyzeQualification(series, defaultQualificationStatisticsPolicy, [])),
)
assert(Result.isSuccess(pinnedAnalysisResult), 'pinned qualification analysis must succeed')
const pinnedQualificationResult = makeQualificationResult(
  pinnedLock,
  pinnedEvaluation.verdict,
  pinnedAnalysisResult.success,
)
assert(Result.isSuccess(pinnedQualificationResult), 'pinned qualification result must succeed')
export const pinnedQualification = pinnedQualificationResult.success
export const pinnedStoredEvidence: StoredEvaluationEvidence = {
  protocol: {
    protocolHash: pinnedEvaluation.protocolHash,
    schemaVersion: fixtureProtocol.schemaVersion,
    strategyName: pinnedExecutionProvenance.strategy.name,
    behaviorHash: pinnedExecutionProvenance.strategy.behaviorHash,
    parameterHash: pinnedExecutionProvenance.strategy.parameterHash,
    parameters: fixtureProtocol,
  },
  run: {
    runId: pinnedEvaluation.runId,
    protocolHash: pinnedEvaluation.protocolHash,
    snapshotId: fixtureSnapshot.manifest.finalizedSnapshot.snapshotId,
    evaluationSchemaVersion: 'bayn.evaluation.v6',
    sourceRevision: pinnedExecutionProvenance.sourceRevision,
    imageRepository: pinnedExecutionProvenance.image.repository,
    imageDigest: pinnedExecutionProvenance.image.digest,
    strategyName: pinnedExecutionProvenance.strategy.name,
    initialCapitalMicros: pinnedEvaluation.initialCapitalMicros,
    artifactCount: 17,
    eventCount: pinnedEvaluation.events.length,
    gateCount: pinnedEvaluation.verdict.gates.length,
  },
  artifacts: [],
  events: [],
  gates: [],
  statuses: [],
}
export const pinnedRuntimeConfig: RuntimeConfig = {
  ...config,
  qualificationRunId: pinnedEvaluation.runId,
  clickhouse: {
    ...config.clickhouse,
    snapshotId: fixtureSnapshot.manifest.finalizedSnapshot.snapshotId,
    publicationAsOf: fixtureSnapshot.manifest.finalizedSnapshot.asOfSession,
    calendarVersion: fixtureSnapshot.manifest.finalizedSnapshot.calendarVersion,
    bounds: fixtureSnapshot.manifest.bounds,
  },
}

export const pinnedStore = (): EvidenceStoreService => ({
  ...successfulEvidenceStore,
  read: (runId) => Effect.succeed(runId === pinnedEvaluation.runId ? Option.some(pinnedStoredEvidence) : Option.none()),
  readQualification: (runId) =>
    Effect.succeed(
      runId === pinnedEvaluation.runId
        ? Option.some({ state: 'TERMINAL', lock: pinnedLock, result: pinnedQualification })
        : Option.none(),
    ),
  recover: (runId, recoveredProvenance) =>
    Effect.sync(() => {
      expect(runId).toBe(pinnedEvaluation.runId)
      expect(recoveredProvenance).toEqual(pinnedExecutionProvenance)
      return Option.some({
        evaluation: summarizeEvaluation(pinnedEvaluation),
        reconciliation: {
          runId: pinnedEvaluation.runId,
          accountCount: 13,
          transferCount: pinnedEvaluation.events.length,
          exact: true,
        },
        persistence: {
          runId: pinnedEvaluation.runId,
          deduplicated: true,
          artifactCount: 17,
          eventCount: pinnedEvaluation.events.length,
          gateCount: pinnedEvaluation.verdict.gates.length,
        },
      })
    }),
})

export const fetchJson = async (port: number, path: string, method = 'GET') => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method })
  return {
    status: response.status,
    allow: response.headers.get('allow'),
    body: (await response.json()) as Record<string, unknown>,
  }
}

export const readyState = (): RuntimeState => {
  const evaluation = fixtureEvaluation
  return {
    status: 'READY',
    evidence: {
      startupMode: 'evaluated',
      provenance,
      evaluation: summarizeEvaluation(evaluation),
      reconciliation: {
        runId: evaluation.runId,
        accountCount: 13,
        transferCount: evaluation.events.length,
        exact: true,
      },
      persistence: {
        runId: evaluation.runId,
        deduplicated: false,
        artifactCount: 17,
        eventCount: evaluation.events.length,
        gateCount: evaluation.verdict.gates.length,
      },
      qualification: fixtureQualification,
    },
    health: {
      sequence: 1,
      checkedAt: '2026-07-20T00:00:00.000Z',
      dependencies: {
        postgresql: { status: 'AVAILABLE', checkedAt: '2026-07-20T00:00:00.000Z', error: null },
        signal: { status: 'AVAILABLE', checkedAt: '2026-07-20T00:00:00.000Z', error: null },
        tigerBeetle: { status: 'AVAILABLE', checkedAt: '2026-07-20T00:00:00.000Z', error: null },
        evidence: { status: 'AVAILABLE', checkedAt: '2026-07-20T00:00:00.000Z', error: null },
        cycle: { status: 'AVAILABLE', checkedAt: '2026-07-20T00:00:00.000Z', error: null },
        cycleRunner: { status: 'AVAILABLE', checkedAt: '2026-07-20T00:00:00.000Z', error: null },
      },
    },
    cycle: deriveCycleOperationsStatus(
      {
        current: null,
        last: null,
        unfinishedCycleCount: 0,
        authority: null,
        reconciliation: null,
        mutations: { eventCount: 0, unresolvedCount: 0, oldestUnresolvedAt: null, latestOccurredAt: null },
      },
      Date.parse('2026-07-20T00:00:00.000Z'),
      Authority.Observe,
      config,
    ),
    autonomousCycleLoop: {
      configured: false,
      startedAt: null,
      lastPass: null,
    },
    broker: null,
    error: null,
  }
}

export const recoveringStore = (state: RuntimeState): EvidenceStoreService => {
  const evidence = state.evidence
  if (evidence === null) throw new Error('test state must contain evidence')
  return {
    ...successfulEvidenceStore,
    recover: () =>
      Effect.succeed(
        Option.some({
          evaluation: evidence.evaluation,
          reconciliation: evidence.reconciliation,
          persistence: { ...evidence.persistence, deduplicated: true },
        }),
      ),
    readQualification: () =>
      Effect.succeed(Option.some({ state: 'TERMINAL', lock: fixtureLock, result: evidence.qualification })),
    persist: () => Effect.die(new Error('health probes must not persist')),
  }
}
