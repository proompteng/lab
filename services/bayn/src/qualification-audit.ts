import { canonicalHashV1 } from './hash'
import {
  evaluateReferenceRiskBalancedTrend,
  evaluateReferenceTsmom,
  type ReferenceEvaluation,
} from './qualification-reference'
import { reconcileMarkedEquity } from './simulation-reconciliation'
import { makeRuntimeProvenance } from './contracts'
import {
  ContractVersion,
  type DailyBar,
  type InputManifest,
  type SimulationTrace,
  type StrategyProtocol,
} from './types'

export interface StoredArtifact {
  readonly name: string
  readonly schemaVersion: string
  readonly contentHash: string
  readonly payload: unknown
}

export interface StoredEvent {
  readonly ordinal: number
  readonly id: string
  readonly kind: string
  readonly contentHash: string
  readonly payload: unknown
}

export interface StoredGate {
  readonly ordinal: number
  readonly name: string
  readonly passed: boolean
  readonly actual: unknown
  readonly required: unknown
  readonly contentHash: string
}

export interface AuditDatabaseSnapshot {
  readonly transactionReadOnly: boolean
  readonly protocol: {
    readonly protocolHash: string
    readonly schemaVersion: string
    readonly strategyName: string
    readonly behaviorHash: string
    readonly parameterHash: string
    readonly parameters: unknown
  }
  readonly run: {
    readonly runId: string
    readonly protocolHash: string
    readonly snapshotId: string
    readonly evaluationSchemaVersion: string
    readonly sourceRevision: string
    readonly imageRepository: string
    readonly imageDigest: string
    readonly strategyName: string
    readonly initialCapitalMicros: string
    readonly status: string
    readonly artifactCount: number
    readonly eventCount: number
    readonly gateCount: number
  }
  readonly artifacts: readonly StoredArtifact[]
  readonly events: readonly StoredEvent[]
  readonly gates: readonly StoredGate[]
  readonly statuses: readonly { readonly status: string; readonly detail: unknown }[]
  readonly priorTrialRunIds: readonly string[]
  readonly qualification: {
    readonly lockCreatedAt: string
    readonly resultCommittedAt: string
    readonly storedLockId: string
    readonly storedAnalysisHash: string
    readonly storedResultHash: string
    readonly storedVerdict: string
    readonly lock: unknown
    readonly result: unknown
  }
}

export interface SignalAccessRecord {
  readonly queryId: string
  readonly queryStartTime: string
  readonly user: string
  readonly kind: 'manifest' | 'sessions' | 'bars'
}

export interface SignalPrincipals {
  readonly candidate: string
  readonly publishers: readonly string[]
}

export interface RepositoryAudit {
  readonly sourceCommitExists: boolean
  readonly sourceCommitAncestorOfMain: boolean
  readonly preLockResultReferences: readonly string[]
}

export interface QualificationAuditInput {
  readonly bars: readonly DailyBar[]
  readonly manifest: InputManifest
  readonly protocol: StrategyProtocol
  readonly database: AuditDatabaseSnapshot
  readonly signalAccess: readonly SignalAccessRecord[]
  readonly signalPrincipals: SignalPrincipals
  readonly repository: RepositoryAudit
}

export interface AuditCheck {
  readonly name: string
  readonly passed: boolean
  readonly evidence: string
}

export interface QualificationAuditReport {
  readonly schemaVersion: 'bayn.qualification-audit.v1'
  readonly runId: string
  readonly status: 'PASS' | 'FAIL'
  readonly reference: {
    readonly economicStatus: 'PASS' | 'FAIL_CLOSED'
    readonly observations: number
    readonly rebalanceCount: number
  }
  readonly evidence: {
    readonly artifactCount: number
    readonly eventCount: number
    readonly gateCount: number
    readonly lockId: string
    readonly resultHash: string
  }
  readonly policies: {
    readonly declaredAt: string
    readonly lockId: string
    readonly policySetHash: string
    readonly documents: readonly {
      readonly name: string
      readonly schemaVersion: string
      readonly contentHash: string
      readonly content: unknown
    }[]
  }
  readonly contamination: {
    readonly lockCreatedAt: string
    readonly resultCommittedAt: string
    readonly principals: SignalPrincipals
    readonly access: readonly SignalAccessRecord[]
  }
  readonly repository: RepositoryAudit & { readonly sourceRevision: string }
  readonly checks: readonly AuditCheck[]
  readonly auditHash: string
}

type JsonObject = Readonly<Record<string, unknown>>

const object = (value: unknown, name: string): JsonObject => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as JsonObject
}

const array = (value: unknown, name: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value
}

const string = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`)
  return value
}

const without = (value: JsonObject, key: string): JsonObject =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))

const same = (left: unknown, right: unknown): boolean => canonicalHashV1(left) === canonicalHashV1(right)

const itemCount = (payload: unknown): number => {
  if (typeof payload !== 'object' || payload === null || !('items' in payload)) return 0
  return Array.isArray(payload.items) ? payload.items.length : 0
}

const expectedResultReason = (gateName: string): string =>
  `EVALUATION_${gateName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')}_FAILED`

interface AuditStrategyProfile {
  readonly name: 'tsmom' | 'risk-balanced-trend'
  readonly evaluationSchemaVersion: 'bayn.evaluation.v4' | 'bayn.evaluation.v5'
  readonly summarySchemaVersion: 'bayn.evaluation-summary.v3' | 'bayn.evaluation-summary.v4'
  readonly decisionArtifactName: 'tsmom-signal-decisions' | 'risk-balanced-trend-signal-decisions'
  readonly decisionArtifactSchemaVersion:
    | 'bayn.tsmom-signal-decisions.v1'
    | 'bayn.risk-balanced-trend-signal-decisions.v1'
}

const auditStrategyProfile = (protocol: StrategyProtocol): AuditStrategyProfile =>
  protocol.schemaVersion === 'bayn.tsmom.protocol.v2'
    ? {
        name: 'tsmom',
        evaluationSchemaVersion: ContractVersion.Evaluation,
        summarySchemaVersion: ContractVersion.EvaluationSummary,
        decisionArtifactName: 'tsmom-signal-decisions',
        decisionArtifactSchemaVersion: 'bayn.tsmom-signal-decisions.v1',
      }
    : {
        name: 'risk-balanced-trend',
        evaluationSchemaVersion: ContractVersion.RiskBalancedTrendEvaluation,
        summarySchemaVersion: ContractVersion.RiskBalancedTrendEvaluationSummary,
        decisionArtifactName: 'risk-balanced-trend-signal-decisions',
        decisionArtifactSchemaVersion: 'bayn.risk-balanced-trend-signal-decisions.v1',
      }

const evaluateReference = (
  input: QualificationAuditInput,
  provenance: ReturnType<typeof makeRuntimeProvenance>,
): ReferenceEvaluation =>
  input.protocol.schemaVersion === 'bayn.tsmom.protocol.v2'
    ? evaluateReferenceTsmom(input.bars, input.manifest, input.protocol, provenance)
    : evaluateReferenceRiskBalancedTrend(input.bars, input.manifest, input.protocol, provenance)

const makeSummary = (
  input: QualificationAuditInput,
  reference: ReferenceEvaluation,
  trace: SimulationTrace,
  markedEquity: ReturnType<typeof reconcileMarkedEquity>['reconciliation'],
) => {
  const profile = auditStrategyProfile(input.protocol)
  return {
    schemaVersion: profile.summarySchemaVersion,
    runId: reference.runId,
    evaluationSchemaVersion: profile.evaluationSchemaVersion,
    codeRevision: input.database.run.sourceRevision,
    protocolHash: reference.protocolHash,
    initialCapitalMicros: input.protocol.initialCapitalMicros,
    input: {
      snapshotId: input.manifest.finalizedSnapshot.snapshotId,
      publicationId: input.manifest.finalizedSnapshot.publicationId,
      manifestHash: input.manifest.hash,
      bounds: input.manifest.bounds,
      rowCount: input.manifest.rowCount,
      sessionCount: input.manifest.sessionCount,
      symbols: input.manifest.symbols.map((coverage) => coverage.symbol),
    },
    strategy: reference.strategy.metrics,
    buyAndHold: reference.buyAndHold.metrics,
    directVolTiming: reference.directVolTiming.metrics,
    doubleCostStrategy: reference.doubleCostStrategy.metrics,
    verdict: reference.verdict,
    eventCount: reference.strategy.events.length,
    signalDecisionCount: reference.strategy.decisions.length,
    orderCount: trace.orders.length,
    cashChangeCount: trace.cashChanges.length,
    dailyMarkCount: trace.dailyMarks.length,
    benchmarkSeriesCounts: {
      buyAndHold: reference.buyAndHold.daily.length,
      directVolTiming: reference.directVolTiming.daily.length,
      doubleCostStrategy: reference.doubleCostStrategy.daily.length,
    },
    markedEquityReconciliation: markedEquity,
  }
}

export const auditQualification = (input: QualificationAuditInput): QualificationAuditReport => {
  const checks: AuditCheck[] = []
  const check = (name: string, passed: boolean, evidence: string): void => {
    checks.push({ name, passed, evidence })
  }
  const database = input.database
  const artifact = new Map(database.artifacts.map((value) => [value.name, value]))
  const lock = object(database.qualification.lock, 'qualification lock')
  const result = object(database.qualification.result, 'qualification result')
  const lockId = string(lock.lockId, 'qualification lock ID')
  const resultHash = string(result.resultHash, 'qualification result hash')
  const profile = auditStrategyProfile(input.protocol)
  const provenance = makeRuntimeProvenance({
    sourceRevision: database.run.sourceRevision,
    image: { repository: database.run.imageRepository, digest: database.run.imageDigest },
    strategy: {
      name: database.protocol.strategyName,
      behaviorHash: database.protocol.behaviorHash,
      parameterHash: database.protocol.parameterHash,
      parameterSchemaVersion: database.protocol.schemaVersion,
    },
  })
  const reference = evaluateReference(input, provenance)
  if (reference.strategy.trace === null) throw new Error('reference evaluation omitted its candidate trace')
  const markedEquity = reconcileMarkedEquity({
    runId: reference.runId,
    initialCapitalMicros: input.protocol.initialCapitalMicros,
    evaluatorTotalFeesMicros: reference.strategy.metrics.totalFeesMicros,
    evaluatorEndingEquityMicros: reference.strategy.metrics.endingEquityMicros,
    events: reference.strategy.events,
    simulation: reference.strategy.trace,
  })

  check('postgres-transaction-read-only', database.transactionReadOnly, 'transaction_read_only=on')
  check(
    'protocol-content',
    same(input.protocol, database.protocol.parameters) &&
      canonicalHashV1(input.protocol) === database.protocol.parameterHash &&
      reference.protocolHash === database.protocol.protocolHash,
    `parameterHash=${database.protocol.parameterHash}`,
  )
  check(
    'run-identity',
    reference.runId === database.run.runId &&
      reference.protocolHash === database.run.protocolHash &&
      input.manifest.finalizedSnapshot.snapshotId === database.run.snapshotId &&
      database.protocol.strategyName === profile.name &&
      database.run.strategyName === profile.name &&
      database.run.evaluationSchemaVersion === profile.evaluationSchemaVersion &&
      database.run.initialCapitalMicros === input.protocol.initialCapitalMicros &&
      database.run.status === 'COMPLETE',
    `runId=${database.run.runId}`,
  )
  check(
    'evidence-counts',
    database.artifacts.length === database.run.artifactCount &&
      database.events.length === database.run.eventCount &&
      database.gates.length === database.run.gateCount,
    `${database.artifacts.length}/${database.events.length}/${database.gates.length}`,
  )
  check(
    'artifact-hashes',
    database.artifacts.every((value) => canonicalHashV1(value.payload) === value.contentHash),
    `${database.artifacts.length} artifacts`,
  )
  const expectedArtifactSchemas = new Map<string, string>([
    ['evaluation-summary', profile.summarySchemaVersion],
    ['input-manifest', input.manifest.schemaVersion],
    ['strategy', 'bayn.performance-metrics.v2'],
    ['buy-and-hold', 'bayn.performance-metrics.v2'],
    ['direct-volatility-timing', 'bayn.performance-metrics.v2'],
    ['double-cost-strategy', 'bayn.performance-metrics.v2'],
    ['simulated-orders', 'bayn.simulated-orders.v2'],
    ['cash-changes', 'bayn.cash-changes.v2'],
    ['daily-position-marks', 'bayn.daily-position-marks.v3'],
    [profile.decisionArtifactName, profile.decisionArtifactSchemaVersion],
    ['buy-and-hold-series', 'bayn.daily-performance-series.v1'],
    ['direct-volatility-timing-series', 'bayn.daily-performance-series.v1'],
    ['double-cost-strategy-series', 'bayn.daily-performance-series.v1'],
    ['equity-series', 'bayn.equity-series.v1'],
    ['marked-equity-reconciliation', markedEquity.reconciliation.schemaVersion],
    ['reconciliation', 'bayn.reconciliation.v1'],
    ['qualification-artifact-manifest', 'bayn.qualification-artifact-manifest.v1'],
  ])
  check(
    'artifact-schema-versions',
    database.artifacts.length === expectedArtifactSchemas.size &&
      database.artifacts.every((value) => expectedArtifactSchemas.get(value.name) === value.schemaVersion),
    `${database.artifacts.length} versioned artifacts`,
  )
  check(
    'event-hashes-and-order',
    database.events.every((value, index) => {
      const payload = object(value.payload, `event ${index}`)
      return (
        value.ordinal === index &&
        value.id === payload.id &&
        value.kind === payload.kind &&
        canonicalHashV1(payload) === value.contentHash
      )
    }),
    `${database.events.length} events`,
  )
  check(
    'gate-hashes-and-order',
    database.gates.every(
      (value, index) =>
        value.ordinal === index &&
        canonicalHashV1({ name: value.name, passed: value.passed, actual: value.actual, required: value.required }) ===
          value.contentHash,
    ),
    `${database.gates.length} gates`,
  )
  check(
    'status-history',
    database.statuses.length === 2 &&
      database.statuses[0].status === 'WRITING' &&
      database.statuses[1].status === 'COMPLETE' &&
      same(database.statuses[0].detail, {
        artifactCount: database.run.artifactCount,
        eventCount: database.run.eventCount,
        gateCount: database.run.gateCount,
      }) &&
      same(database.statuses[1].detail, { reconciliationExact: true, verdict: reference.verdict.status }),
    database.statuses.map((status) => status.status).join(' -> '),
  )

  const expectedArtifacts = new Map<string, unknown>([
    ['evaluation-summary', makeSummary(input, reference, reference.strategy.trace, markedEquity.reconciliation)],
    ['input-manifest', input.manifest],
    ['strategy', reference.strategy.metrics],
    ['buy-and-hold', reference.buyAndHold.metrics],
    ['direct-volatility-timing', reference.directVolTiming.metrics],
    ['double-cost-strategy', reference.doubleCostStrategy.metrics],
    [
      'simulated-orders',
      {
        schemaVersion: 'bayn.simulated-orders.v2',
        executionModel: input.protocol.executionModel,
        costMultiplierMicros: MICROS_STRING,
        items: reference.strategy.trace.orders,
      },
    ],
    ['cash-changes', { schemaVersion: 'bayn.cash-changes.v2', items: reference.strategy.trace.cashChanges }],
    [
      'daily-position-marks',
      { schemaVersion: 'bayn.daily-position-marks.v3', items: reference.strategy.trace.dailyMarks },
    ],
    [
      profile.decisionArtifactName,
      { schemaVersion: profile.decisionArtifactSchemaVersion, items: reference.strategy.decisions },
    ],
    [
      'buy-and-hold-series',
      {
        schemaVersion: 'bayn.daily-performance-series.v1',
        series: 'buy-and-hold',
        items: reference.buyAndHold.daily,
      },
    ],
    [
      'direct-volatility-timing-series',
      {
        schemaVersion: 'bayn.daily-performance-series.v1',
        series: 'direct-volatility-timing',
        items: reference.directVolTiming.daily,
      },
    ],
    [
      'double-cost-strategy-series',
      {
        schemaVersion: 'bayn.daily-performance-series.v1',
        series: 'double-cost-strategy',
        items: reference.doubleCostStrategy.daily,
      },
    ],
    ['equity-series', { schemaVersion: 'bayn.equity-series.v1', items: markedEquity.equitySeries }],
    ['marked-equity-reconciliation', markedEquity.reconciliation],
  ])
  for (const [name, expected] of expectedArtifacts) {
    check(`reference-${name}`, same(artifact.get(name)?.payload, expected), `contentHash=${canonicalHashV1(expected)}`)
  }
  check(
    'reference-events',
    same(
      database.events.map((value) => value.payload),
      reference.strategy.events,
    ),
    `contentHash=${canonicalHashV1(reference.strategy.events)}`,
  )
  check(
    'reference-gates',
    same(
      database.gates.map(({ name, passed, actual, required }) => ({ name, passed, actual, required })),
      reference.verdict.gates,
    ),
    `economicStatus=${reference.verdict.status}`,
  )

  const reconciliation = object(artifact.get('reconciliation')?.payload, 'TigerBeetle reconciliation artifact')
  check(
    'accounting-reconciliation-identity',
    reconciliation.runId === database.run.runId && reconciliation.exact === true,
    `runId=${String(reconciliation.runId)} exact=${String(reconciliation.exact)}`,
  )
  const baseArtifacts = database.artifacts.filter((value) => value.name !== 'qualification-artifact-manifest')
  const qualificationManifest = {
    schemaVersion: 'bayn.qualification-artifact-manifest.v1',
    identity: {
      runId: database.run.runId,
      evaluationSchemaVersion: database.run.evaluationSchemaVersion,
      protocolHash: database.run.protocolHash,
      sourceRevision: database.run.sourceRevision,
      image: { repository: database.run.imageRepository, digest: database.run.imageDigest },
      snapshotId: database.run.snapshotId,
      publicationId: input.manifest.finalizedSnapshot.publicationId,
      inputManifestHash: input.manifest.hash,
      bounds: input.manifest.bounds,
      calendarVersion: input.manifest.finalizedSnapshot.calendarVersion,
    },
    execution: {
      parameterSchemaVersion: database.protocol.schemaVersion,
      parameterHash: database.protocol.parameterHash,
      simulationSchemaVersion: 'bayn.simulation-trace.v3',
      executionModel: input.protocol.executionModel,
      costMultiplierMicros: MICROS_STRING,
    },
    artifacts: [...baseArtifacts]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((value) => ({
        name: value.name,
        schemaVersion: value.schemaVersion,
        itemCount: itemCount(value.payload),
        contentHash: value.contentHash,
      })),
    events: {
      count: database.events.length,
      contentHash: canonicalHashV1(
        database.events.map(({ ordinal, id, kind, contentHash }) => ({ ordinal, id, kind, contentHash })),
      ),
    },
    gates: {
      count: database.gates.length,
      contentHash: canonicalHashV1(
        database.gates.map(({ ordinal, name, passed, contentHash }) => ({ ordinal, name, passed, contentHash })),
      ),
    },
  }
  check(
    'qualification-artifact-manifest',
    same(artifact.get('qualification-artifact-manifest')?.payload, qualificationManifest),
    `contentHash=${canonicalHashV1(qualificationManifest)}`,
  )

  check('lock-hash', canonicalHashV1(without(lock, 'lockId')) === lockId, `lockId=${lockId}`)
  check(
    'qualification-row-binding',
    database.qualification.storedLockId === lockId &&
      database.qualification.storedAnalysisHash ===
        string(object(result.analysis, 'qualification analysis').analysisHash, 'analysis hash') &&
      database.qualification.storedResultHash === resultHash &&
      database.qualification.storedVerdict === result.verdict,
    `storedResultHash=${database.qualification.storedResultHash}`,
  )
  const lockData = object(lock.data, 'qualification lock data')
  const lockPolicies = object(lock.policies, 'qualification lock policies')
  const policyDocuments = Object.entries(lockPolicies)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      const policy = object(value, `qualification policy ${name}`)
      return {
        name,
        schemaVersion: string(policy.schemaVersion, `qualification policy ${name} schema version`),
        contentHash: string(policy.contentHash, `qualification policy ${name} content hash`),
        content: policy.content,
      }
    })
  check(
    'lock-candidate-binding',
    lock.candidateRunId === database.run.runId &&
      lock.protocolHash === database.run.protocolHash &&
      lock.sourceRevision === database.run.sourceRevision &&
      same(lock.image, { repository: database.run.imageRepository, digest: database.run.imageDigest }) &&
      same(lock.universe, input.protocol.universe),
    `candidateRunId=${String(lock.candidateRunId)}`,
  )
  check(
    'lock-data-binding',
    lockData.snapshotId === input.manifest.finalizedSnapshot.snapshotId &&
      lockData.publicationId === input.manifest.finalizedSnapshot.publicationId &&
      lockData.contentHash === input.manifest.finalizedSnapshot.contentHash &&
      lockData.sessionsContentHash === input.manifest.finalizedSnapshot.sessionsContentHash &&
      lockData.selectedSessionCount === reference.strategy.metrics.observations &&
      lockData.selectedRebalanceCount === reference.strategy.decisions.length &&
      same(lockData.bounds, input.manifest.bounds),
    `snapshotId=${String(lockData.snapshotId)}`,
  )
  check(
    'lock-policy-hashes',
    same(
      policyDocuments.map((policy) => policy.name),
      ['benchmark', 'execution', 'thresholds', 'uncertainty'],
    ) && policyDocuments.every((policy) => policy.contentHash === canonicalHashV1(policy.content)),
    `${policyDocuments.length} policies policySetHash=${canonicalHashV1(policyDocuments)}`,
  )
  check(
    'locked-prior-trial-lineage',
    same(lock.priorTrialRunIds, [...database.priorTrialRunIds].sort()),
    `${database.priorTrialRunIds.length} prior trials`,
  )

  const analysis = object(result.analysis, 'qualification analysis')
  const analysisHash = string(analysis.analysisHash, 'qualification analysis hash')
  check(
    'analysis-hash',
    canonicalHashV1(without(analysis, 'analysisHash')) === analysisHash,
    `analysisHash=${analysisHash}`,
  )
  check('result-hash', canonicalHashV1(without(result, 'resultHash')) === resultHash, `resultHash=${resultHash}`)
  const economicPass = reference.verdict.gates.every((gate) => gate.passed)
  const analysisPass = analysis.status === 'PASS'
  const expectedQualification = economicPass && analysisPass ? 'QUALIFIED' : 'REJECTED'
  const expectedEconomicReasons = reference.verdict.gates
    .filter((gate) => !gate.passed)
    .map((gate) => expectedResultReason(gate.name))
  const reasonCodes = array(result.reasonCodes, 'qualification reason codes').map((value) =>
    string(value, 'reason code'),
  )
  const analysisReasonCodes = array(analysis.reasonCodes, 'qualification analysis reason codes').map((value) =>
    string(value, 'analysis reason code'),
  )
  const expectedReasonCodes = [...new Set([...expectedEconomicReasons, ...analysisReasonCodes])].sort()
  check(
    'analysis-lineage',
    analysis.runId === database.run.runId &&
      same(analysis.priorTrialRunIds, lock.priorTrialRunIds) &&
      analysis.candidateOrdinal === database.priorTrialRunIds.length + 1,
    `candidateOrdinal=${String(analysis.candidateOrdinal)}`,
  )
  check(
    'terminal-result-binding',
    result.lockId === lockId &&
      result.runId === database.run.runId &&
      result.verdict === expectedQualification &&
      same(result.evaluationVerdict, reference.verdict) &&
      same(reasonCodes, expectedReasonCodes),
    `verdict=${String(result.verdict)} reasons=${reasonCodes.join(',')}`,
  )

  const sortedAccess = [...input.signalAccess].sort((left, right) =>
    left.queryStartTime === right.queryStartTime
      ? left.queryId.localeCompare(right.queryId)
      : left.queryStartTime.localeCompare(right.queryStartTime),
  )
  const candidateAccess = sortedAccess.filter((value) => value.user === input.signalPrincipals.candidate)
  const candidateReads = candidateAccess.filter((value) => value.kind === 'sessions' || value.kind === 'bars')
  const manifestReads = candidateAccess.filter((value) => value.kind === 'manifest')
  const preLockCandidateReads = candidateReads.filter(
    (value) => value.queryStartTime < database.qualification.lockCreatedAt,
  )
  check(
    'signal-lock-before-candidate-data',
    preLockCandidateReads.length === 0 &&
      candidateReads.length === 2 &&
      candidateReads.every(
        (value) =>
          value.queryStartTime >= database.qualification.lockCreatedAt &&
          value.queryStartTime <= database.qualification.resultCommittedAt,
      ),
    `lock=${database.qualification.lockCreatedAt} candidateReads=${candidateReads
      .map((value) => `${value.kind}@${value.queryStartTime}`)
      .join(',')}`,
  )
  check(
    'signal-manifest-inspected-before-lock',
    manifestReads.some((value) => value.queryStartTime < database.qualification.lockCreatedAt),
    `${manifestReads.length} manifest reads`,
  )
  check(
    'signal-read-principals',
    input.signalPrincipals.candidate.length > 0 &&
      input.signalPrincipals.publishers.length > 0 &&
      new Set([input.signalPrincipals.candidate, ...input.signalPrincipals.publishers]).size ===
        input.signalPrincipals.publishers.length + 1 &&
      sortedAccess.every(
        (value) =>
          value.user === input.signalPrincipals.candidate || input.signalPrincipals.publishers.includes(value.user),
      ),
    [...new Set(sortedAccess.map((value) => value.user))].join(','),
  )
  check(
    'source-revision-in-repository',
    input.repository.sourceCommitExists && input.repository.sourceCommitAncestorOfMain,
    `sourceRevision=${database.run.sourceRevision}`,
  )
  check(
    'no-pre-lock-result-reference',
    input.repository.preLockResultReferences.length === 0,
    input.repository.preLockResultReferences.join(',') || 'none',
  )

  const material = {
    schemaVersion: 'bayn.qualification-audit.v1' as const,
    runId: database.run.runId,
    status: checks.every((value) => value.passed) ? ('PASS' as const) : ('FAIL' as const),
    reference: {
      economicStatus: reference.verdict.status,
      observations: reference.strategy.metrics.observations,
      rebalanceCount: reference.strategy.decisions.length,
    },
    evidence: {
      artifactCount: database.artifacts.length,
      eventCount: database.events.length,
      gateCount: database.gates.length,
      lockId,
      resultHash,
    },
    policies: {
      declaredAt: database.qualification.lockCreatedAt,
      lockId,
      policySetHash: canonicalHashV1(policyDocuments),
      documents: policyDocuments,
    },
    contamination: {
      lockCreatedAt: database.qualification.lockCreatedAt,
      resultCommittedAt: database.qualification.resultCommittedAt,
      principals: input.signalPrincipals,
      access: sortedAccess,
    },
    repository: { ...input.repository, sourceRevision: database.run.sourceRevision },
    checks,
  }
  return { ...material, auditHash: canonicalHashV1(material) }
}

const MICROS_STRING = '1000000'
