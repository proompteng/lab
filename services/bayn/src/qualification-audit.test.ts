import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { riskBalancedTrendBehaviorV4Hash } from './behavior'
import { makeStrategyProtocolHash } from './contracts'
import { makeEquitySeriesArtifact } from './evidence-contracts'
import { canonicalHashV1 } from './hash'
import { makeQualificationResult } from './qualification'
import {
  classifySignalTableAccess,
  validateSignalReplicaTopology,
  type AuditDatabaseSnapshot,
  type QualificationAuditInput,
  type QualificationAuditReport,
} from './audit/audit'
import { makeAuditFacts, usesTerminalReplaySemantics } from './audit/core'
import { auditQualification as auditQualificationResult } from './audit/run'
import { makeQualificationDossier as makeQualificationDossierResult, type QualificationDossier } from './audit/dossier'
import {
  analyzeQualification,
  defaultQualificationStatisticsPolicy,
  prepareQualificationSeries,
} from './qualification-statistics'
import { evaluateRiskBalancedTrend, parseMatchingManifest, summarizeEvaluation } from './risk-balanced-trend'
import { makeRiskBalancedTrendApplication, makeRiskBalancedTrendDefinition } from './strategy'
import { prepareRiskBalancedTrendQualificationLock } from './strategy/risk-balanced-trend/qualification'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'

const auditQualification = (input: QualificationAuditInput): QualificationAuditReport => {
  const result = auditQualificationResult(input)
  assert(Result.isSuccess(result), 'qualification audit fixture must produce a report')
  return result.success
}

const assertFailure = <A, E>(result: Result.Result<A, E>): E => {
  assert(Result.isFailure(result), 'fixture decision must fail')
  return result.failure
}

const makeQualificationDossier = (input: QualificationAuditInput): QualificationDossier => {
  const result = makeQualificationDossierResult(input)
  assert(Result.isSuccess(result), 'qualification dossier fixture must produce a dossier')
  return result.success
}

const fixture = (priorTrialRunIds: readonly string[] = []): QualificationAuditInput => {
  const snapshot = makeSnapshot(900)
  const protocol = fixtureProtocol
  const provenance = makeTestProvenance()
  const definition = makeRiskBalancedTrendDefinition(protocol)
  const evaluationResult = evaluateRiskBalancedTrend(snapshot.bars, snapshot.manifest, protocol, provenance, definition)
  assert(Result.isSuccess(evaluationResult), 'strategy evaluation fixture must succeed')
  const evaluation = evaluationResult.success
  const sessionDates = [...new Set(snapshot.bars.map((bar) => bar.sessionDate))].sort()
  const lockResult = parseMatchingManifest(snapshot.manifest, protocol).pipe(
    Result.flatMap((manifest) =>
      prepareRiskBalancedTrendQualificationLock(manifest, sessionDates, priorTrialRunIds, protocol, provenance),
    ),
  )
  assert(Result.isSuccess(lockResult), 'qualification lock fixture must succeed')
  const lock = lockResult.success
  const analysisResult = prepareQualificationSeries(evaluation).pipe(
    Result.flatMap((series) => analyzeQualification(series, defaultQualificationStatisticsPolicy, priorTrialRunIds)),
  )
  assert(Result.isSuccess(analysisResult), 'qualification analysis fixture must succeed')
  const analysis = analysisResult.success
  const resultDecision = makeQualificationResult(lock, evaluation.verdict, analysis)
  assert(Result.isSuccess(resultDecision), 'qualification result fixture must succeed')
  const result = resultDecision.success
  const reconciliation = { runId: evaluation.runId, accountCount: 14, transferCount: 900, exact: true as const }
  const evaluationSummary = summarizeEvaluation(evaluation)
  const base = [
    ['evaluation-summary', evaluationSummary.schemaVersion, evaluationSummary],
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
      'risk-balanced-trend-decisions',
      'bayn.risk-balanced-trend-decisions.v1',
      {
        schemaVersion: 'bayn.risk-balanced-trend-decisions.v1',
        items: evaluation.signalDecisions,
      },
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
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
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
      schemaVersion: protocol.schemaVersion,
      strategyName: 'risk-balanced-trend',
      behaviorHash: provenance.strategy.behaviorHash,
      parameterHash: provenance.strategy.parameterHash,
      parameters: protocol,
    },
    run: {
      runId: evaluation.runId,
      protocolHash: evaluation.protocolHash,
      snapshotId: snapshot.manifest.finalizedSnapshot.snapshotId,
      evaluationSchemaVersion: evaluation.schemaVersion,
      sourceRevision: provenance.sourceRevision,
      imageRepository: provenance.image.repository,
      imageDigest: provenance.image.digest,
      strategyName: 'risk-balanced-trend',
      initialCapitalMicros: evaluation.initialCapitalMicros,
      status: 'COMPLETE',
      artifactCount: artifacts.length,
      eventCount: events.length,
      gateCount: gates.length,
    },
    artifacts: [...artifacts].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
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
    protocol,
    application: makeRiskBalancedTrendApplication(protocol, definition),
    database,
    signalReplicas: ['replica-0', 'replica-1'],
    signalAccess: [
      {
        replica: 'replica-0',
        queryId: 'publisher',
        queryStartTime: '2026-07-20T11:59:58.000000Z',
        user: 'signal-publisher',
        kind: 'bars',
      },
      {
        replica: 'replica-0',
        queryId: 'manifest-inspect',
        queryStartTime: '2026-07-20T11:59:59.000000Z',
        user: 'bayn',
        kind: 'manifest',
      },
      {
        replica: 'replica-1',
        queryId: 'sessions-inspect',
        queryStartTime: '2026-07-20T11:59:59.100000Z',
        user: 'bayn',
        kind: 'sessions',
      },
      {
        replica: 'replica-1',
        queryId: 'manifest-load',
        queryStartTime: '2026-07-20T12:00:01.000000Z',
        user: 'bayn',
        kind: 'manifest',
      },
      {
        replica: 'replica-0',
        queryId: 'sessions-load',
        queryStartTime: '2026-07-20T12:00:01.050000Z',
        user: 'bayn',
        kind: 'sessions',
      },
      {
        replica: 'replica-1',
        queryId: 'bars',
        queryStartTime: '2026-07-20T12:00:01.100000Z',
        user: 'bayn',
        kind: 'bars',
      },
    ],
    signalPrincipals: { candidate: 'bayn', publishers: ['signal-publisher'] },
    repository: { sourceCommitExists: true, sourceCommitAncestorOfMain: true, preLockResultReferences: [] },
  }
}

const replaceArtifact = (
  input: QualificationAuditInput,
  name: string,
  mutate: (payload: Readonly<Record<string, unknown>>) => unknown,
): QualificationAuditInput => {
  const source = input.database.artifacts.find((artifact) => artifact.name === name)
  if (source === undefined || typeof source.payload !== 'object' || source.payload === null) {
    throw new Error(`fixture artifact ${name} is missing or malformed`)
  }
  const payload = mutate(structuredClone(source.payload) as Readonly<Record<string, unknown>>)
  return {
    ...input,
    database: {
      ...input.database,
      artifacts: input.database.artifacts.map((artifact) =>
        artifact.name === name ? { ...artifact, payload, contentHash: canonicalHashV1(payload) } : artifact,
      ),
    },
  }
}

const replaceFirstItem = (
  payload: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
): unknown => {
  if (!Array.isArray(payload.items) || typeof payload.items[0] !== 'object' || payload.items[0] === null) {
    throw new Error('fixture artifact has no object item')
  }
  return { ...payload, items: [{ ...payload.items[0], ...patch }, ...payload.items.slice(1)] }
}

describe('qualification audit', () => {
  test('persists terminal replay semantics independently of a strategy close event', () => {
    const input = fixture()
    const database: AuditDatabaseSnapshot = {
      ...input.database,
      protocol: { ...input.database.protocol, behaviorHash: riskBalancedTrendBehaviorV4Hash },
      events: input.database.events.filter(
        ({ payload }) => !(payload.kind === 'decision' && payload.terminalClose === true),
      ),
    }
    const facts = makeAuditFacts({ ...input, database })
    const legacyFacts = makeAuditFacts({
      ...input,
      database: {
        ...database,
        protocol: { ...database.protocol, behaviorHash: 'e'.repeat(64) },
      },
    })

    expect(usesTerminalReplaySemantics(database)).toBe(true)
    expect(Result.isSuccess(facts)).toBe(true)
    expect(Result.isSuccess(legacyFacts)).toBe(true)
    if (Result.isFailure(facts)) return
    if (Result.isFailure(legacyFacts)) return
    expect(facts.success.reference.buyAndHold.metrics.endingEquityMicros).not.toBe(
      legacyFacts.success.reference.buyAndHold.metrics.endingEquityMicros,
    )
    expect(facts.success.reference.directVolTiming.metrics.endingEquityMicros).not.toBe(
      legacyFacts.success.reference.directVolTiming.metrics.endingEquityMicros,
    )
    expect(
      usesTerminalReplaySemantics({
        ...database,
        protocol: { ...database.protocol, behaviorHash: 'e'.repeat(64) },
        events: [],
      }),
    ).toBe(false)
  })

  test('passes only when independent replay, lineage, chronology, and immutable evidence agree', () => {
    const first = auditQualification(fixture())
    const second = auditQualification(fixture())

    expect(first.status).toBe('PASS')
    expect(first.checks.every((check) => check.passed)).toBe(true)
    expect(first.policies.declaredAt).toBe(first.contamination.lockCreatedAt)
    expect(first.policies.documents.map((policy) => policy.name)).toEqual([
      'benchmark',
      'execution',
      'thresholds',
      'uncertainty',
    ])
    expect(first.policies.policySetHash).toBe(canonicalHashV1(first.policies.documents))
    expect(second.auditHash).toBe(first.auditHash)
    expect(first.auditHash).toBe('8a362e971730ff6808f93658f1364650ffc3ddc445830714b1452113fac4b9f7')
  })

  test('passes for a later candidate when prior terminal result lineage is complete', () => {
    const priorRunId = '0'.repeat(64)
    const report = auditQualification(fixture([priorRunId]))

    expect(report.status).toBe('PASS')
    expect(report.checks.find((check) => check.name === 'locked-prior-trial-lineage')?.passed).toBe(true)
    expect(report.checks.find((check) => check.name === 'analysis-lineage')?.passed).toBe(true)
  })

  test('fails closed on stored evidence drift', () => {
    const input = fixture()
    const strategy = input.database.artifacts.find((artifact) => artifact.name === 'strategy')
    if (strategy === undefined) throw new Error('strategy fixture is missing')
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

  test('returns malformed artifact canonicalization through the typed audit failure channel', () => {
    const input = fixture()
    const database = {
      ...input.database,
      artifacts: input.database.artifacts.map((artifact) =>
        artifact.name === 'strategy' ? { ...artifact, payload: { invalid: 'value\ud800' } } : artifact,
      ),
    }
    const audited = () => auditQualificationResult({ ...input, database })

    expect(audited).not.toThrow()
    expect(assertFailure(audited())).toEqual({
      _tag: 'AuditCanonicalizationFailed',
      subject: { scope: 'artifact', name: 'strategy' },
      cause: {
        _tag: 'CanonicalJsonFailure',
        path: '$.invalid',
        reason: 'invalid-unicode-surrogate',
        actualType: 'string',
      },
    })
  })

  test('retains the exact event ordinal and introspection cause without defecting', () => {
    const input = fixture()
    const event = input.database.events[0]
    if (event === undefined) throw new Error('event fixture is missing')
    const cause = new Error('event keys unavailable')
    const payload = new Proxy(event.payload, {
      ownKeys: () => {
        throw cause
      },
    })
    const database = {
      ...input.database,
      events: [{ ...event, payload }, ...input.database.events.slice(1)],
    }
    const audited = () => auditQualificationResult({ ...input, database })

    expect(audited).not.toThrow()
    expect(assertFailure(audited())).toEqual({
      _tag: 'AuditCanonicalizationFailed',
      subject: { scope: 'event', name: event.kind, ordinal: 0 },
      cause: {
        _tag: 'CanonicalJsonFailure',
        path: '$',
        reason: 'introspection-failed',
        actualType: 'object',
        operation: 'own-keys',
        cause,
      },
    })
  })

  test('continues independent checks when public input cannot be reconciled', () => {
    const input = fixture()
    const protocol = { ...input.protocol, initialCapitalMicros: '+1000000000000' }
    const provenance = makeTestProvenance(protocol)
    const audited = () =>
      auditQualification({
        ...input,
        protocol,
        database: {
          ...input.database,
          protocol: {
            ...input.database.protocol,
            protocolHash: makeStrategyProtocolHash(provenance.strategy),
            behaviorHash: provenance.strategy.behaviorHash,
            parameterHash: provenance.strategy.parameterHash,
            parameters: protocol,
          },
        },
        repository: { ...input.repository, sourceCommitAncestorOfMain: false },
      })

    expect(audited).not.toThrow()
    const report = audited()
    expect(report.status).toBe('FAIL')
    expect(report.checks.find((check) => check.name === 'reference-equity-series')?.passed).toBe(false)
    expect(report.checks.find((check) => check.name === 'reference-marked-equity-reconciliation')?.passed).toBe(false)
    expect(report.checks.find((check) => check.name === 'qualification-artifact-manifest')?.passed).toBe(false)
    expect(report.checks.find((check) => check.name === 'source-revision-in-repository')?.passed).toBe(false)
    expect(report.checks.find((check) => check.name === 'reference-equity-series')?.evidence).toContain(
      'initialCapitalMicros',
    )
    expect(report.checks.at(-1)?.name).toBe('no-pre-lock-result-reference')
  })

  test('requires the source-pinned auditor for immutable protocol v2 evidence', () => {
    const input = fixture()
    const database = {
      ...input.database,
      protocol: {
        ...input.database.protocol,
        schemaVersion: 'bayn.risk-balanced-trend.protocol.v2',
      },
    }

    expect(assertFailure(auditQualificationResult({ ...input, database }))).toEqual({
      _tag: 'UnsupportedAuditProtocolVersion',
      storedSchemaVersion: 'bayn.risk-balanced-trend.protocol.v2',
      suppliedSchemaVersion: fixtureProtocol.schemaVersion,
      supportedSchemaVersions: ['bayn.risk-balanced-trend.protocol.v3', 'bayn.risk-balanced-trend.protocol.v4'],
    })
  })

  test('fails closed when candidate bars were read before the lock', () => {
    const input = fixture()
    const signalAccess = input.signalAccess.map((record) =>
      record.user === 'bayn' && record.kind === 'bars'
        ? { ...record, queryStartTime: '2026-07-20T11:59:58.000000Z' }
        : record,
    )
    const report = auditQualification({ ...input, signalAccess })

    expect(report.status).toBe('FAIL')
    expect(report.checks.find((check) => check.name === 'signal-lock-before-candidate-bars')?.passed).toBe(false)
  })

  test('classifies Signal access from table metadata with bars taking fail-closed precedence', () => {
    const tables = fixture().manifest.tables

    expect(Result.getOrThrow(classifySignalTableAccess([`signal.${tables.bars}`], tables))).toBe('bars')
    expect(
      Result.getOrThrow(classifySignalTableAccess([`signal.${tables.manifests}`, `signal.${tables.bars}`], tables)),
    ).toBe('bars')
    expect(Result.getOrThrow(classifySignalTableAccess([`signal.${tables.sessions}`], tables))).toBe('sessions')
    expect(Result.getOrThrow(classifySignalTableAccess([`signal.${tables.manifests}`], tables))).toBe('manifest')
    expect(assertFailure(classifySignalTableAccess(['system.query_log'], tables))).toEqual({
      _tag: 'SignalEvidenceTableNotAccessed',
      observedTables: ['system.query_log'],
      expectedTables: [`signal.${tables.bars}`, `signal.${tables.manifests}`, `signal.${tables.sessions}`].sort(),
    })
  })

  test('validates complete and internally consistent Signal replica topology', () => {
    const access = {
      replica: 'replica-0',
      queryId: 'query-0',
      queryStartTime: '2026-07-20T12:00:00.000000Z',
      user: 'bayn',
      kind: 'bars' as const,
    }
    const success = validateSignalReplicaTopology([
      { replica: 'replica-1', topology: ['replica-0', 'replica-1'], access: [] },
      { replica: 'replica-0', topology: ['replica-1', 'replica-0'], access: [access] },
    ])
    assert(Result.isSuccess(success))
    expect(success.success).toEqual({ replicas: ['replica-0', 'replica-1'], access: [access] })

    expect(
      assertFailure(
        validateSignalReplicaTopology([
          { replica: 'replica-0', topology: ['replica-0', 'replica-1'], access: [] },
          { replica: 'replica-0', topology: ['replica-0', 'replica-1'], access: [] },
        ]),
      )._tag,
    ).toBe('DuplicateSignalReplicaEndpoint')
    expect(
      assertFailure(validateSignalReplicaTopology([{ replica: 'replica-0', topology: ['replica-0'], access: [] }]))
        ._tag,
    ).toBe('InvalidSignalReplicaTopology')
    expect(
      assertFailure(
        validateSignalReplicaTopology([
          { replica: 'replica-0', topology: ['replica-0', 'replica-1'], access: [] },
          { replica: 'replica-1', topology: ['replica-0', 'replica-2'], access: [] },
        ]),
      )._tag,
    ).toBe('DivergentSignalReplicaTopology')
    expect(
      assertFailure(
        validateSignalReplicaTopology([{ replica: 'replica-0', topology: ['replica-0', 'replica-1'], access: [] }]),
      )._tag,
    ).toBe('IncompleteSignalReplicaCoverage')
    expect(
      assertFailure(
        validateSignalReplicaTopology([
          { replica: 'replica-0', topology: ['replica-0', 'replica-1'], access: [{ ...access, replica: 'replica-1' }] },
          { replica: 'replica-1', topology: ['replica-0', 'replica-1'], access: [] },
        ]),
      ),
    ).toEqual({
      _tag: 'SignalReplicaRecordMismatch',
      endpointReplica: 'replica-0',
      recordReplica: 'replica-1',
      queryId: 'query-0',
    })
  })

  test('returns closed failures for malformed reconciliation and unsupported artifacts', () => {
    const malformed = fixture()
    const malformedArtifacts = malformed.database.artifacts.map((artifact) =>
      artifact.name === 'reconciliation' ? { ...artifact, payload: null } : artifact,
    )
    expect(
      assertFailure(
        auditQualificationResult({
          ...malformed,
          database: { ...malformed.database, artifacts: malformedArtifacts },
        }),
      )._tag,
    ).toBe('ReconciliationArtifactInvalid')

    const unsupported = fixture()
    const unsupportedArtifact = {
      name: 'unsupported-artifact',
      schemaVersion: 'bayn.unsupported.v1',
      contentHash: canonicalHashV1({}),
      payload: {},
    }
    expect(
      assertFailure(
        auditQualificationResult({
          ...unsupported,
          database: {
            ...unsupported.database,
            run: { ...unsupported.database.run, artifactCount: unsupported.database.run.artifactCount + 1 },
            artifacts: [...unsupported.database.artifacts, unsupportedArtifact],
          },
        }),
      ),
    ).toEqual({
      _tag: 'UnsupportedQualificationArtifact',
      artifactName: 'unsupported-artifact',
      supportedArtifactNames: expect.arrayContaining(['reconciliation', 'strategy']),
    })
  })

  test.each([
    ['strategy', 'reference-strategy', (payload: Readonly<Record<string, unknown>>) => ({ ...payload, sharpe: 99 })],
    [
      'risk-balanced-trend-decisions',
      'reference-risk-balanced-trend-decisions',
      (payload: Readonly<Record<string, unknown>>) => replaceFirstItem(payload, { decisionId: '0'.repeat(64) }),
    ],
    [
      'daily-position-marks',
      'reference-daily-position-marks',
      (payload: Readonly<Record<string, unknown>>) => replaceFirstItem(payload, { equityMicros: '1' }),
    ],
    [
      'buy-and-hold-series',
      'reference-buy-and-hold-series',
      (payload: Readonly<Record<string, unknown>>) => replaceFirstItem(payload, { netReturn: 99 }),
    ],
    [
      'simulated-orders',
      'reference-simulated-orders',
      (payload: Readonly<Record<string, unknown>>) => replaceFirstItem(payload, { filledQuantityMicros: '1' }),
    ],
  ])('fails closed on internally rehashed %s drift', (artifactName, checkName, mutate) => {
    const report = auditQualification(replaceArtifact(fixture(), artifactName, mutate))

    expect(report.status).toBe('FAIL')
    expect(report.checks.find((check) => check.name === 'artifact-hashes')?.passed).toBe(true)
    expect(report.checks.find((check) => check.name === checkName)?.passed).toBe(false)
  })

  test('fails closed on a rehashed gate that diverges from the independent result', () => {
    const input = fixture()
    const gate = input.database.gates[0]
    const changed = { ...gate, passed: !gate.passed }
    const contentHash = canonicalHashV1({
      name: changed.name,
      passed: changed.passed,
      actual: changed.actual,
      required: changed.required,
    })
    const database = { ...input.database, gates: [{ ...changed, contentHash }, ...input.database.gates.slice(1)] }
    const report = auditQualification({ ...input, database })

    expect(report.status).toBe('FAIL')
    expect(report.checks.find((check) => check.name === 'gate-hashes-and-order')?.passed).toBe(true)
    expect(report.checks.find((check) => check.name === 'reference-gates')?.passed).toBe(false)
  })

  test.each([
    [
      'trial-lineage',
      () => {
        const input = fixture()
        return { ...input, database: { ...input.database, priorTrialRunIds: ['0'.repeat(64)] } }
      },
      'locked-prior-trial-lineage',
    ],
    [
      'repository',
      () => ({
        ...fixture(),
        repository: { sourceCommitExists: true, sourceCommitAncestorOfMain: false, preLockResultReferences: [] },
      }),
      'source-revision-in-repository',
    ],
    [
      'access-coverage',
      () => {
        const input = fixture()
        return { ...input, signalAccess: input.signalAccess.filter((record) => record.queryId !== 'bars') }
      },
      'signal-lock-before-candidate-bars',
    ],
    [
      'calendar-preflight',
      () => {
        const input = fixture()
        return {
          ...input,
          signalAccess: input.signalAccess.filter((record) => record.queryId !== 'sessions-inspect'),
        }
      },
      'signal-calendar-inspected-before-lock',
    ],
    ['replica-coverage', () => ({ ...fixture(), signalReplicas: ['replica-0'] }), 'signal-query-log-replica-coverage'],
    [
      'principal',
      () => {
        const input = fixture()
        return {
          ...input,
          signalAccess: [
            ...input.signalAccess,
            {
              replica: 'replica-0',
              queryId: 'unknown',
              queryStartTime: '2026-07-20T11:59:59.500000Z',
              user: 'notebook',
              kind: 'manifest' as const,
            },
          ],
        }
      },
      'signal-read-principals',
    ],
  ] satisfies readonly [string, () => QualificationAuditInput, string][])(
    'fails closed on a %s defect',
    (name, makeInput, checkName) => {
      const report = auditQualification(makeInput())
      expect(report.status, name).toBe('FAIL')
      expect(report.checks.find((check) => check.name === checkName)?.passed, name).toBe(false)
    },
  )
})

describe('qualification dossier', () => {
  test('binds the complete audited subject deterministically', () => {
    const first = makeQualificationDossier(fixture())
    const second = makeQualificationDossier(fixture())
    const { dossierHash, ...material } = first

    expect(first.schemaVersion).toBe('bayn.qualification-dossier.v2')
    expect(first.audit.schemaVersion).toBe('bayn.qualification-audit.v2')
    expect(first.audit.status).toBe('PASS')
    expect(first.audit.checks.every((check) => check.passed)).toBe(true)
    expect(first.subject.run.runId).toBe(first.qualification.result.runId)
    expect(first.subject.protocol.parameters).toEqual(fixtureProtocol)
    expect(first.subject.inputManifest.finalizedSnapshot.snapshotId).toBe(first.subject.run.snapshotId)
    expect(first.evidence.artifacts).toHaveLength(first.subject.run.artifactCount)
    expect(first.evidence.events.count).toBe(first.subject.run.eventCount)
    expect(first.evidence.gates.count).toBe(first.subject.run.gateCount)
    expect(first.qualification.priorTrialSetHash).toBe(canonicalHashV1(first.qualification.priorTrialRunIds))
    expect(first.authority).toEqual({
      maximum: 'observe',
      executable: false,
      paperMutation: false,
      brokerOrders: false,
      capitalPromotion: false,
    })
    expect(dossierHash).toBe(canonicalHashV1(material))
    expect(second.dossierHash).toBe(dossierHash)
  })

  test('refuses to publish a failed or mismatched audit', () => {
    const failed = fixture()
    expect(
      assertFailure(
        makeQualificationDossierResult({
          ...failed,
          repository: { ...failed.repository, sourceCommitAncestorOfMain: false },
        }),
      ),
    ).toEqual({
      _tag: 'QualificationDossierSubjectMismatch',
      check: 'audit-passed',
      actual: false,
      expected: true,
    })

    const mismatched = fixture()
    expect(
      assertFailure(
        makeQualificationDossierResult({
          ...mismatched,
          database: {
            ...mismatched.database,
            run: { ...mismatched.database.run, artifactCount: mismatched.database.run.artifactCount + 1 },
          },
        }),
      ),
    ).toEqual({
      _tag: 'QualificationDossierSubjectMismatch',
      check: 'audit-passed',
      actual: false,
      expected: true,
    })
  })

  test('propagates typed audit canonicalization failures without throwing', () => {
    const input = fixture()
    const database = {
      ...input.database,
      artifacts: input.database.artifacts.map((artifact) =>
        artifact.name === 'strategy' ? { ...artifact, payload: { invalid: Number.NaN } } : artifact,
      ),
    }
    const dossier = () => makeQualificationDossierResult({ ...input, database })

    expect(dossier).not.toThrow()
    expect(assertFailure(dossier())).toEqual({
      _tag: 'AuditCanonicalizationFailed',
      subject: { scope: 'artifact', name: 'strategy' },
      cause: {
        _tag: 'CanonicalJsonFailure',
        path: '$.invalid',
        reason: 'non-finite-number',
        actualType: 'number',
      },
    })
  })

  test('returns hostile dossier evidence inspection as data with the original cause', () => {
    const input = fixture()
    const strategy = input.database.artifacts.find((artifact) => artifact.name === 'strategy')
    if (strategy === undefined || typeof strategy.payload !== 'object' || strategy.payload === null) {
      throw new Error('strategy artifact fixture is missing')
    }
    const cause = new Error('items membership unavailable')
    const payload = new Proxy(strategy.payload, {
      has: () => {
        throw cause
      },
    })
    const database = {
      ...input.database,
      artifacts: input.database.artifacts.map((artifact) =>
        artifact.name === 'strategy' ? { ...artifact, payload } : artifact,
      ),
    }
    const dossier = () => makeQualificationDossierResult({ ...input, database })

    expect(dossier).not.toThrow()
    expect(assertFailure(dossier())).toEqual({
      _tag: 'QualificationDossierEvidenceInspectionFailed',
      artifactName: 'strategy',
      operation: 'item-count',
      cause,
    })
  })
})
