import { Schema } from 'effect'

import { makeRuntimeProvenance } from '../contracts'
import { ReconciliationResultSchema } from '../evidence-contracts'
import { canonicalHashV1 } from '../hash'
import type { QualificationLock, QualificationResult } from '../qualification'
import { strictParseOptions as StrictParseOptions } from '../schemas'
import { reconcileMarkedEquity } from '../simulation-reconciliation'
import {
  ContractVersion,
  type DailyBar,
  type EconomicVerdict,
  type EvaluationEvent,
  type InputManifest,
  type Protocol,
  type SimulationTrace,
} from '../types'
import { evaluateReference, type ReferenceEvaluation } from './reference'

const decodeReconciliation = Schema.decodeUnknownSync(ReconciliationResultSchema, StrictParseOptions)
type GateScalar = EconomicVerdict['gates'][number]['actual']

export interface StoredArtifact {
  readonly name: string
  readonly schemaVersion: string
  readonly contentHash: string
  readonly payload: unknown
}

export interface StoredEvent {
  readonly ordinal: number
  readonly id: string
  readonly kind: EvaluationEvent['kind']
  readonly contentHash: string
  readonly payload: EvaluationEvent
}

export interface StoredGate {
  readonly ordinal: number
  readonly name: string
  readonly passed: boolean
  readonly actual: GateScalar
  readonly required: GateScalar
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
    readonly parameters: Protocol
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
    readonly status: 'COMPLETE'
    readonly artifactCount: number
    readonly eventCount: number
    readonly gateCount: number
  }
  readonly artifacts: readonly StoredArtifact[]
  readonly events: readonly StoredEvent[]
  readonly gates: readonly StoredGate[]
  readonly statuses: readonly (
    | {
        readonly status: 'WRITING'
        readonly detail: { readonly artifactCount: number; readonly eventCount: number; readonly gateCount: number }
      }
    | {
        readonly status: 'COMPLETE'
        readonly detail: { readonly reconciliationExact: true; readonly verdict: 'PASS' | 'FAIL_CLOSED' }
      }
  )[]
  readonly priorTrialRunIds: readonly string[]
  readonly qualification: {
    readonly lockCreatedAt: string
    readonly resultCommittedAt: string
    readonly storedLockId: string
    readonly storedAnalysisHash: string
    readonly storedResultHash: string
    readonly storedVerdict: QualificationResult['verdict']
    readonly lock: QualificationLock
    readonly result: QualificationResult
  }
}

export interface SignalAccessRecord {
  readonly replica: string
  readonly queryId: string
  readonly queryStartTime: string
  readonly user: string
  readonly kind: 'manifest' | 'sessions' | 'bars' | 'integrity'
}

export interface SignalIntegrityAuthority {
  readonly principal: string
  readonly queryIds: readonly string[]
}

export interface SignalPrincipals {
  readonly candidate: string
  readonly publishers: readonly string[]
  readonly integrity: SignalIntegrityAuthority
}

export const classifySignalAccess = (
  record: Omit<SignalAccessRecord, 'kind'> & { readonly kind: 'manifest' | 'sessions' | 'bars' },
  authority: SignalIntegrityAuthority,
): SignalAccessRecord =>
  record.user === authority.principal && authority.queryIds.includes(record.queryId)
    ? { ...record, kind: 'integrity' }
    : record

export interface RepositoryAudit {
  readonly sourceCommitExists: boolean
  readonly sourceCommitAncestorOfMain: boolean
  readonly preLockResultReferences: readonly string[]
}

export interface QualificationAuditInput {
  readonly bars: readonly DailyBar[]
  readonly manifest: InputManifest
  readonly protocol: Protocol
  readonly database: AuditDatabaseSnapshot
  readonly signalReplicas: readonly string[]
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
  readonly schemaVersion: 'bayn.qualification-audit.v2'
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
    readonly replicas: readonly string[]
    readonly principals: SignalPrincipals
    readonly access: readonly SignalAccessRecord[]
  }
  readonly repository: RepositoryAudit & { readonly sourceRevision: string }
  readonly checks: readonly AuditCheck[]
  readonly auditHash: string
}

const same = (left: unknown, right: unknown): boolean => canonicalHashV1(left) === canonicalHashV1(right)

const expectedResultReason = (gateName: string): string =>
  `EVALUATION_${gateName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')}_FAILED`

const contract = {
  name: 'risk-balanced-trend',
  evaluationSchemaVersion: ContractVersion.Evaluation,
  summarySchemaVersion: ContractVersion.EvaluationSummary,
  decisionArtifactName: 'risk-balanced-trend-decisions',
  decisionArtifactSchemaVersion: 'bayn.risk-balanced-trend-decisions.v1',
} as const

const makeSummary = (
  input: QualificationAuditInput,
  reference: ReferenceEvaluation,
  trace: SimulationTrace,
  markedEquity: ReturnType<typeof reconcileMarkedEquity>['reconciliation'],
) => {
  return {
    schemaVersion: contract.summarySchemaVersion,
    runId: reference.runId,
    evaluationSchemaVersion: contract.evaluationSchemaVersion,
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
  const lock = database.qualification.lock
  const { lockId, ...lockMaterial } = lock
  const result = database.qualification.result
  const { resultHash, ...resultMaterial } = result
  const analysis = result.analysis
  const { analysisHash, ...analysisMaterial } = analysis
  if (
    database.protocol.strategyName !== contract.name ||
    database.run.strategyName !== contract.name ||
    database.protocol.schemaVersion !== 'bayn.risk-balanced-trend.protocol.v2'
  ) {
    throw new Error('stored qualification uses an unsupported strategy contract')
  }
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
  const reference = evaluateReference(input.bars, input.manifest, input.protocol, provenance)
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
      database.protocol.strategyName === contract.name &&
      database.run.strategyName === contract.name &&
      database.run.evaluationSchemaVersion === contract.evaluationSchemaVersion &&
      provenance.contractVersions.evaluation === contract.evaluationSchemaVersion &&
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
    ['evaluation-summary', contract.summarySchemaVersion],
    ['input-manifest', input.manifest.schemaVersion],
    ['strategy', 'bayn.performance-metrics.v2'],
    ['buy-and-hold', 'bayn.performance-metrics.v2'],
    ['direct-volatility-timing', 'bayn.performance-metrics.v2'],
    ['double-cost-strategy', 'bayn.performance-metrics.v2'],
    ['simulated-orders', 'bayn.simulated-orders.v2'],
    ['cash-changes', 'bayn.cash-changes.v2'],
    ['daily-position-marks', 'bayn.daily-position-marks.v3'],
    [contract.decisionArtifactName, contract.decisionArtifactSchemaVersion],
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
    database.events.every(
      (value, index) =>
        value.ordinal === index &&
        value.id === value.payload.id &&
        value.kind === value.payload.kind &&
        canonicalHashV1(value.payload) === value.contentHash,
    ),
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
      contract.decisionArtifactName,
      { schemaVersion: contract.decisionArtifactSchemaVersion, items: reference.strategy.decisions },
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

  const reconciliation = decodeReconciliation(artifact.get('reconciliation')?.payload)
  check(
    'accounting-reconciliation-identity',
    reconciliation.runId === database.run.runId && reconciliation.exact === true,
    `runId=${reconciliation.runId} exact=${reconciliation.exact}`,
  )
  const artifactItemCounts = new Map<string, number>([
    ['evaluation-summary', 0],
    ['input-manifest', 0],
    ['strategy', 0],
    ['buy-and-hold', 0],
    ['direct-volatility-timing', 0],
    ['double-cost-strategy', 0],
    ['simulated-orders', reference.strategy.trace.orders.length],
    ['cash-changes', reference.strategy.trace.cashChanges.length],
    ['daily-position-marks', reference.strategy.trace.dailyMarks.length],
    [contract.decisionArtifactName, reference.strategy.decisions.length],
    ['buy-and-hold-series', reference.buyAndHold.daily.length],
    ['direct-volatility-timing-series', reference.directVolTiming.daily.length],
    ['double-cost-strategy-series', reference.doubleCostStrategy.daily.length],
    ['equity-series', markedEquity.equitySeries.length],
    ['marked-equity-reconciliation', 0],
    ['reconciliation', 0],
  ])
  const artifactItemCount = (name: string): number => {
    const count = artifactItemCounts.get(name)
    if (count === undefined) throw new Error(`unsupported qualification artifact: ${name}`)
    return count
  }
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
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      .map((value) => ({
        name: value.name,
        schemaVersion: value.schemaVersion,
        itemCount: artifactItemCount(value.name),
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

  check('lock-hash', canonicalHashV1(lockMaterial) === lockId, `lockId=${lockId}`)
  check(
    'qualification-row-binding',
    database.qualification.storedLockId === lockId &&
      database.qualification.storedAnalysisHash === result.analysis.analysisHash &&
      database.qualification.storedResultHash === resultHash &&
      database.qualification.storedVerdict === result.verdict,
    `storedResultHash=${database.qualification.storedResultHash}`,
  )
  const lockData = lock.data
  const lockContractBinding =
    lock.schemaVersion === 'bayn.qualification-lock.v3' &&
    lock.universeId === input.protocol.universeId &&
    lock.universeSymbolHash === input.protocol.universeSymbolHash &&
    lockData.inputManifestHash === input.manifest.hash
  const policyDocuments = (
    [
      ['benchmark', lock.policies.benchmark],
      ['execution', lock.policies.execution],
      ['thresholds', lock.policies.thresholds],
      ['uncertainty', lock.policies.uncertainty],
    ] as const
  ).map(([name, policy]) => ({ name, ...policy }))
  check(
    'lock-candidate-binding',
    lock.candidateRunId === database.run.runId &&
      lock.protocolHash === database.run.protocolHash &&
      lock.sourceRevision === database.run.sourceRevision &&
      same(lock.image, { repository: database.run.imageRepository, digest: database.run.imageDigest }) &&
      lockContractBinding &&
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

  check('analysis-hash', canonicalHashV1(analysisMaterial) === analysisHash, `analysisHash=${analysisHash}`)
  check('result-hash', canonicalHashV1(resultMaterial) === resultHash, `resultHash=${resultHash}`)
  const economicPass = reference.verdict.gates.every((gate) => gate.passed)
  const analysisPass = analysis.status === 'PASS'
  const expectedQualification = economicPass && analysisPass ? 'QUALIFIED' : 'REJECTED'
  const expectedEconomicReasons = reference.verdict.gates
    .filter((gate) => !gate.passed)
    .map((gate) => expectedResultReason(gate.name))
  const reasonCodes = result.reasonCodes
  const analysisReasonCodes = analysis.reasonCodes
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

  const sortedReplicas = [...input.signalReplicas].sort()
  const sortedAccess = [...input.signalAccess].sort((left, right) => {
    if (left.queryStartTime !== right.queryStartTime) return left.queryStartTime < right.queryStartTime ? -1 : 1
    if (left.replica !== right.replica) return left.replica < right.replica ? -1 : 1
    return left.queryId < right.queryId ? -1 : left.queryId > right.queryId ? 1 : 0
  })
  const candidateAccess = sortedAccess.filter((value) => value.user === input.signalPrincipals.candidate)
  const candidateBarReads = candidateAccess.filter((value) => value.kind === 'bars')
  const candidateSessionReads = candidateAccess.filter((value) => value.kind === 'sessions')
  const manifestReads = candidateAccess.filter((value) => value.kind === 'manifest')
  const preLockBarReads = candidateBarReads.filter(
    (value) => value.queryStartTime < database.qualification.lockCreatedAt,
  )
  const preLockSessionReads = candidateSessionReads.filter(
    (value) => value.queryStartTime < database.qualification.lockCreatedAt,
  )
  const preLockManifestReads = manifestReads.filter(
    (value) => value.queryStartTime < database.qualification.lockCreatedAt,
  )
  const lockedSessionReads = candidateSessionReads.filter(
    (value) =>
      value.queryStartTime >= database.qualification.lockCreatedAt &&
      value.queryStartTime <= database.qualification.resultCommittedAt,
  )
  const lockedManifestReads = manifestReads.filter(
    (value) =>
      value.queryStartTime >= database.qualification.lockCreatedAt &&
      value.queryStartTime <= database.qualification.resultCommittedAt,
  )
  const configuredIntegrityIds = [...input.signalPrincipals.integrity.queryIds].sort()
  const observedIntegrity = sortedAccess.filter((value) => value.kind === 'integrity')
  const observedIntegrityIds = [...new Set(observedIntegrity.map((value) => value.queryId))].sort()
  check(
    'signal-query-log-replica-coverage',
    sortedReplicas.length >= 2 &&
      new Set(sortedReplicas).size === sortedReplicas.length &&
      sortedAccess.every((value) => sortedReplicas.includes(value.replica)),
    `${sortedReplicas.length} replicas=${sortedReplicas.join(',')}`,
  )
  check(
    'signal-lock-before-candidate-bars',
    preLockBarReads.length === 0 &&
      candidateBarReads.length === 1 &&
      candidateBarReads.every(
        (value) =>
          value.queryStartTime >= database.qualification.lockCreatedAt &&
          value.queryStartTime <= database.qualification.resultCommittedAt,
      ),
    `lock=${database.qualification.lockCreatedAt} barReads=${candidateBarReads
      .map((value) => `${value.replica}@${value.queryStartTime}`)
      .join(',')}`,
  )
  check(
    'signal-calendar-inspected-before-lock',
    preLockSessionReads.length >= 1 && lockedSessionReads.length >= 1,
    `preLock=${preLockSessionReads.length} locked=${lockedSessionReads.length}`,
  )
  check(
    'signal-manifest-inspected-before-lock',
    preLockManifestReads.length >= 1 && lockedManifestReads.length >= 1,
    `preLock=${preLockManifestReads.length} locked=${lockedManifestReads.length}`,
  )
  check(
    'signal-integrity-query-allowlist',
    input.signalPrincipals.integrity.principal.length > 0 &&
      new Set(configuredIntegrityIds).size === configuredIntegrityIds.length &&
      same(observedIntegrityIds, configuredIntegrityIds) &&
      observedIntegrity.every(
        (value) =>
          value.user === input.signalPrincipals.integrity.principal && configuredIntegrityIds.includes(value.queryId),
      ),
    `principal=${input.signalPrincipals.integrity.principal} queryIds=${configuredIntegrityIds.join(',')}`,
  )
  check(
    'signal-read-principals',
    input.signalPrincipals.candidate.length > 0 &&
      input.signalPrincipals.publishers.length > 0 &&
      new Set([
        input.signalPrincipals.candidate,
        ...input.signalPrincipals.publishers,
        input.signalPrincipals.integrity.principal,
      ]).size ===
        input.signalPrincipals.publishers.length + 2 &&
      sortedAccess.every((value) =>
        value.kind === 'integrity'
          ? value.user === input.signalPrincipals.integrity.principal && configuredIntegrityIds.includes(value.queryId)
          : value.user === input.signalPrincipals.candidate || input.signalPrincipals.publishers.includes(value.user),
      ),
    `principals=${[...new Set(sortedAccess.map((value) => value.user))].join(',')} integrity=${sortedAccess
      .filter((value) => value.kind === 'integrity')
      .map((value) => value.queryId)
      .join(',')}`,
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
    schemaVersion: 'bayn.qualification-audit.v2' as const,
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
      replicas: sortedReplicas,
      principals: input.signalPrincipals,
      access: sortedAccess,
    },
    repository: { ...input.repository, sourceRevision: database.run.sourceRevision },
    checks,
  }
  return { ...material, auditHash: canonicalHashV1(material) }
}

const MICROS_STRING = '1000000'
