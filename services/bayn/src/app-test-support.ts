import { expect } from 'bun:test'

import { Effect, Option, Redacted } from 'effect'

import type { RuntimeConfig } from './config'
import type { EvidenceStoreService, StoredEvaluationEvidence } from './db/evidence-store'
import type { JournalService } from './ledger'
import type { MarketDataService } from './market-data'
import { Authority } from './paper'
import { makeQualificationResult } from './qualification'
import { summarizeEvaluation } from './risk-balanced-trend'
import type { RuntimeState } from './runtime-state'
import { makeStrategy } from './strategy'
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
  maximumAuthority: Authority.Observe,
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
  })),
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
export const fixtureStrategy = makeStrategy(fixtureProtocol, provenance)
export const fixtureEvaluation = fixtureStrategy.evaluate(fixtureSnapshot.bars, fixtureSnapshot.manifest)
export const fixtureLock = fixtureStrategy.prepareLock(
  fixtureSnapshot.manifest,
  [...new Set(fixtureSnapshot.bars.map((bar) => bar.sessionDate))].sort(),
  [],
)
export const fixtureQualification = makeQualificationResult(
  fixtureLock,
  fixtureEvaluation.verdict,
  fixtureStrategy.analyze(fixtureEvaluation, []),
)
export const pinnedExecutionProvenance = {
  ...provenance,
  sourceRevision: 'e'.repeat(40),
  image: { repository: provenance.image.repository, digest: `sha256:${'f'.repeat(64)}` },
}
export const pinnedStrategy = makeStrategy(fixtureProtocol, pinnedExecutionProvenance)
export const pinnedEvaluation = pinnedStrategy.evaluate(fixtureSnapshot.bars, fixtureSnapshot.manifest)
export const pinnedLock = pinnedStrategy.prepareLock(
  fixtureSnapshot.manifest,
  [...new Set(fixtureSnapshot.bars.map((bar) => bar.sessionDate))].sort(),
  [],
)
export const pinnedQualification = makeQualificationResult(
  pinnedLock,
  pinnedEvaluation.verdict,
  pinnedStrategy.analyze(pinnedEvaluation, []),
)
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
      },
    },
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
