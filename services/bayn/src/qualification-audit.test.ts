import { describe, expect, test } from 'bun:test'

import { makeEquitySeriesArtifact } from './evidence-contracts'
import { canonicalHashV1 } from './hash'
import { makeQualificationResult } from './qualification'
import { auditQualification, type AuditDatabaseSnapshot, type QualificationAuditInput } from './qualification-audit'
import { makeTsmomStrategy } from './strategy-service'
import { evaluateTsmom, summarizeEvaluation } from './strategy'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'

const fixture = (): QualificationAuditInput => {
  const snapshot = makeSnapshot(900)
  const provenance = makeTestProvenance()
  const strategy = makeTsmomStrategy(fixtureProtocol, provenance)
  const evaluation = evaluateTsmom(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance)
  const sessionDates = [...new Set(snapshot.bars.map((bar) => bar.sessionDate))].sort()
  const priorTrialRunIds: readonly string[] = []
  const lock = strategy.prepareLock(snapshot.manifest, sessionDates, priorTrialRunIds)
  const analysis = strategy.analyze(evaluation, priorTrialRunIds)
  const result = makeQualificationResult(lock, evaluation.verdict, analysis)
  const reconciliation = { runId: evaluation.runId, accountCount: 14, transferCount: 900, exact: true as const }
  const base = [
    ['evaluation-summary', 'bayn.evaluation-summary.v3', summarizeEvaluation(evaluation)],
    ['input-manifest', snapshot.manifest.schemaVersion, snapshot.manifest],
    ['strategy', 'bayn.performance-metrics.v2', evaluation.strategy],
    ['buy-and-hold', 'bayn.performance-metrics.v2', evaluation.buyAndHold],
    ['direct-volatility-timing', 'bayn.performance-metrics.v2', evaluation.directVolTiming],
    ['double-cost-strategy', 'bayn.performance-metrics.v2', evaluation.doubleCostStrategy],
    [
      'simulated-orders',
      'bayn.simulated-orders.v2',
      {
        schemaVersion: 'bayn.simulated-orders.v2',
        executionModel: evaluation.simulation.executionModel,
        costMultiplierMicros: evaluation.simulation.costMultiplierMicros,
        items: evaluation.simulation.orders,
      },
    ],
    [
      'cash-changes',
      'bayn.cash-changes.v2',
      { schemaVersion: 'bayn.cash-changes.v2', items: evaluation.simulation.cashChanges },
    ],
    [
      'daily-position-marks',
      'bayn.daily-position-marks.v3',
      { schemaVersion: 'bayn.daily-position-marks.v3', items: evaluation.simulation.dailyMarks },
    ],
    [
      'tsmom-signal-decisions',
      'bayn.tsmom-signal-decisions.v1',
      { schemaVersion: 'bayn.tsmom-signal-decisions.v1', items: evaluation.signalDecisions },
    ],
    [
      'buy-and-hold-series',
      'bayn.daily-performance-series.v1',
      {
        schemaVersion: 'bayn.daily-performance-series.v1',
        series: 'buy-and-hold',
        items: evaluation.benchmarkSeries.buyAndHold,
      },
    ],
    [
      'direct-volatility-timing-series',
      'bayn.daily-performance-series.v1',
      {
        schemaVersion: 'bayn.daily-performance-series.v1',
        series: 'direct-volatility-timing',
        items: evaluation.benchmarkSeries.directVolTiming,
      },
    ],
    [
      'double-cost-strategy-series',
      'bayn.daily-performance-series.v1',
      {
        schemaVersion: 'bayn.daily-performance-series.v1',
        series: 'double-cost-strategy',
        items: evaluation.benchmarkSeries.doubleCostStrategy,
      },
    ],
    ['equity-series', 'bayn.equity-series.v1', makeEquitySeriesArtifact(evaluation.equitySeries)],
    [
      'marked-equity-reconciliation',
      evaluation.markedEquityReconciliation.schemaVersion,
      evaluation.markedEquityReconciliation,
    ],
    ['reconciliation', 'bayn.reconciliation.v1', reconciliation],
  ].map(([name, schemaVersion, payload]) => ({
    name: name as string,
    schemaVersion: schemaVersion as string,
    payload,
    contentHash: canonicalHashV1(payload),
  }))
  const events = evaluation.events.map((event, ordinal) => ({
    ordinal,
    id: event.id,
    kind: event.kind,
    payload: event,
    contentHash: canonicalHashV1(event),
  }))
  const gates = evaluation.verdict.gates.map((gate, ordinal) => ({
    ordinal,
    name: gate.name,
    passed: gate.passed,
    actual: gate.actual,
    required: gate.required,
    contentHash: canonicalHashV1(gate),
  }))
  const artifactManifest = {
    schemaVersion: 'bayn.qualification-artifact-manifest.v1',
    identity: {
      runId: evaluation.runId,
      evaluationSchemaVersion: evaluation.schemaVersion,
      protocolHash: evaluation.protocolHash,
      sourceRevision: provenance.sourceRevision,
      image: provenance.image,
      snapshotId: snapshot.manifest.finalizedSnapshot.snapshotId,
      publicationId: snapshot.manifest.finalizedSnapshot.publicationId,
      inputManifestHash: snapshot.manifest.hash,
      bounds: snapshot.manifest.bounds,
      calendarVersion: snapshot.manifest.finalizedSnapshot.calendarVersion,
    },
    execution: {
      parameterSchemaVersion: provenance.strategy.parameterSchemaVersion,
      parameterHash: provenance.strategy.parameterHash,
      simulationSchemaVersion: evaluation.simulation.schemaVersion,
      executionModel: evaluation.simulation.executionModel,
      costMultiplierMicros: evaluation.simulation.costMultiplierMicros,
    },
    artifacts: [...base]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((value) => ({
        name: value.name,
        schemaVersion: value.schemaVersion,
        itemCount:
          typeof value.payload === 'object' &&
          value.payload !== null &&
          'items' in value.payload &&
          Array.isArray(value.payload.items)
            ? value.payload.items.length
            : 0,
        contentHash: value.contentHash,
      })),
    events: {
      count: events.length,
      contentHash: canonicalHashV1(
        events.map(({ ordinal, id, kind, contentHash }) => ({ ordinal, id, kind, contentHash })),
      ),
    },
    gates: {
      count: gates.length,
      contentHash: canonicalHashV1(
        gates.map(({ ordinal, name, passed, contentHash }) => ({ ordinal, name, passed, contentHash })),
      ),
    },
  }
  const artifacts = [
    ...base,
    {
      name: 'qualification-artifact-manifest',
      schemaVersion: artifactManifest.schemaVersion,
      payload: artifactManifest,
      contentHash: canonicalHashV1(artifactManifest),
    },
  ]
  const database: AuditDatabaseSnapshot = {
    transactionReadOnly: true,
    protocol: {
      protocolHash: evaluation.protocolHash,
      schemaVersion: fixtureProtocol.schemaVersion,
      strategyName: 'tsmom',
      behaviorHash: provenance.strategy.behaviorHash,
      parameterHash: provenance.strategy.parameterHash,
      parameters: fixtureProtocol,
    },
    run: {
      runId: evaluation.runId,
      protocolHash: evaluation.protocolHash,
      snapshotId: snapshot.manifest.finalizedSnapshot.snapshotId,
      evaluationSchemaVersion: evaluation.schemaVersion,
      sourceRevision: provenance.sourceRevision,
      imageRepository: provenance.image.repository,
      imageDigest: provenance.image.digest,
      strategyName: 'tsmom',
      initialCapitalMicros: evaluation.initialCapitalMicros,
      status: 'COMPLETE',
      artifactCount: artifacts.length,
      eventCount: events.length,
      gateCount: gates.length,
    },
    artifacts: [...artifacts].sort((left, right) => left.name.localeCompare(right.name)),
    events,
    gates,
    statuses: [
      {
        status: 'WRITING',
        detail: { artifactCount: artifacts.length, eventCount: events.length, gateCount: gates.length },
      },
      { status: 'COMPLETE', detail: { reconciliationExact: true, verdict: evaluation.verdict.status } },
    ],
    priorTrialRunIds,
    qualification: {
      lockCreatedAt: '2026-07-20T12:00:00.000000Z',
      resultCommittedAt: '2026-07-20T12:00:10.000000Z',
      storedLockId: lock.lockId,
      storedAnalysisHash: result.analysis.analysisHash,
      storedResultHash: result.resultHash,
      storedVerdict: result.verdict,
      lock,
      result,
    },
  }
  return {
    bars: snapshot.bars,
    manifest: snapshot.manifest,
    protocol: fixtureProtocol,
    database,
    signalAccess: [
      { queryId: 'manifest', queryStartTime: '2026-07-20T11:59:59.000000Z', user: 'bayn', kind: 'manifest' },
      { queryId: 'sessions', queryStartTime: '2026-07-20T12:00:01.000000Z', user: 'bayn', kind: 'sessions' },
      { queryId: 'bars', queryStartTime: '2026-07-20T12:00:01.100000Z', user: 'bayn', kind: 'bars' },
    ],
    repository: { sourceCommitExists: true, sourceCommitAncestorOfMain: true, preLockResultReferences: [] },
  }
}

describe('qualification audit', () => {
  test('passes only when independent replay, lineage, chronology, and immutable evidence agree', () => {
    const first = auditQualification(fixture())
    const second = auditQualification(fixture())

    expect(first.status).toBe('PASS')
    expect(first.checks.every((check) => check.passed)).toBe(true)
    expect(second.auditHash).toBe(first.auditHash)
  })

  test('fails closed on stored evidence drift', () => {
    const input = fixture()
    const strategy = input.database.artifacts.find((artifact) => artifact.name === 'strategy')!
    const database = {
      ...input.database,
      artifacts: input.database.artifacts.map((artifact) =>
        artifact.name === 'strategy'
          ? { ...artifact, payload: { ...(strategy.payload as object), annualizedReturn: 99 } }
          : artifact,
      ),
    }
    const report = auditQualification({ ...input, database })

    expect(report.status).toBe('FAIL')
    expect(report.checks.find((check) => check.name === 'artifact-hashes')?.passed).toBe(false)
    expect(report.checks.find((check) => check.name === 'reference-strategy')?.passed).toBe(false)
  })

  test('fails closed when candidate data was read before the lock', () => {
    const input = fixture()
    const signalAccess = input.signalAccess.map((record) =>
      record.kind === 'bars' ? { ...record, queryStartTime: '2026-07-20T11:59:58.000000Z' } : record,
    )
    const report = auditQualification({ ...input, signalAccess })

    expect(report.status).toBe('FAIL')
    expect(report.checks.find((check) => check.name === 'signal-lock-before-candidate-data')?.passed).toBe(false)
  })
})
