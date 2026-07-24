import { Result, Schema } from 'effect'

import { makeRuntimeProvenance } from '../contracts'
import { ReconciliationResultSchema } from '../evidence-contracts'
import { canonicalHashV1 } from '../hash'
import type { QualificationLock, QualificationResult } from '../qualification'
import { strictParseOptions as StrictParseOptions } from '../schemas'
import {
  reconcileMarkedEquity,
  renderSimulationReconciliationIssues,
  type MarkedEquityProof,
} from '../simulation-reconciliation'
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
  readonly kind: 'manifest' | 'sessions' | 'bars'
}

export interface SignalPrincipals {
  readonly candidate: string
  readonly publishers: readonly string[]
}

export const classifySignalTableAccess = (
  observedTables: readonly string[],
  signalTables: InputManifest['tables'],
): SignalAccessRecord['kind'] => {
  const tables = new Set(observedTables)
  if (tables.has(`signal.${signalTables.bars}`)) return 'bars'
  if (tables.has(`signal.${signalTables.sessions}`)) return 'sessions'
  if (tables.has(`signal.${signalTables.manifests}`)) return 'manifest'
  throw new Error('query log record does not access a Signal evidence table')
}

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
  markedEquity: MarkedEquityProof['reconciliation'],
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

const MICROS_STRING = '1000000'

const makeAuditCheck = (name: string, passed: boolean, evidence: string): AuditCheck => ({ name, passed, evidence })

const makePolicyDocuments = (lock: QualificationLock) =>
  (
    [
      ['benchmark', lock.policies.benchmark],
      ['execution', lock.policies.execution],
      ['thresholds', lock.policies.thresholds],
      ['uncertainty', lock.policies.uncertainty],
    ] as const
  ).map(([name, policy]) => ({ name, ...policy }))

type MarkedEquityAuditMaterial =
  | { readonly _tag: 'Available'; readonly proof: MarkedEquityProof }
  | { readonly _tag: 'Unavailable'; readonly evidence: string }

interface QualificationAuditFacts {
  readonly input: QualificationAuditInput
  readonly database: AuditDatabaseSnapshot
  readonly artifact: ReadonlyMap<string, StoredArtifact>
  readonly lock: QualificationLock
  readonly result: QualificationResult
  readonly reference: ReferenceEvaluation
  readonly trace: SimulationTrace
  readonly provenance: ReturnType<typeof makeRuntimeProvenance>
  readonly policyDocuments: ReturnType<typeof makePolicyDocuments>
  readonly sortedReplicas: readonly string[]
  readonly replicaSet: ReadonlySet<string>
  readonly sortedAccess: readonly SignalAccessRecord[]
  readonly publisherSet: ReadonlySet<string>
  readonly markedEquity: MarkedEquityAuditMaterial
}

const makeMarkedEquityAuditMaterial = (
  input: QualificationAuditInput,
  reference: ReferenceEvaluation,
  trace: SimulationTrace,
): MarkedEquityAuditMaterial => {
  const result = reconcileMarkedEquity({
    runId: reference.runId,
    initialCapitalMicros: input.protocol.initialCapitalMicros,
    evaluatorTotalFeesMicros: reference.strategy.metrics.totalFeesMicros,
    evaluatorEndingEquityMicros: reference.strategy.metrics.endingEquityMicros,
    events: reference.strategy.events,
    simulation: trace,
  })
  return Result.isSuccess(result)
    ? { _tag: 'Available', proof: result.success }
    : {
        _tag: 'Unavailable',
        evidence: `reconciliation unavailable: ${renderSimulationReconciliationIssues(result.failure)}`,
      }
}

const makeAuditFacts = (input: QualificationAuditInput): QualificationAuditFacts => {
  const database = input.database
  if (database.protocol.strategyName !== contract.name || database.run.strategyName !== contract.name) {
    throw new Error('stored qualification uses an unsupported strategy contract')
  }
  if (
    database.protocol.schemaVersion !== 'bayn.risk-balanced-trend.protocol.v3' ||
    input.protocol.schemaVersion !== 'bayn.risk-balanced-trend.protocol.v3'
  ) {
    throw new Error(
      'current auditor requires causal protocol v3; audit immutable v2 evidence with its source-pinned image',
    )
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
  const trace = reference.strategy.trace
  if (trace === null) throw new Error('reference evaluation omitted its candidate trace')
  const sortedReplicas = [...input.signalReplicas].sort()
  const sortedAccess = [...input.signalAccess].sort((left, right) => {
    if (left.queryStartTime !== right.queryStartTime) return left.queryStartTime < right.queryStartTime ? -1 : 1
    if (left.replica !== right.replica) return left.replica < right.replica ? -1 : 1
    return left.queryId < right.queryId ? -1 : left.queryId > right.queryId ? 1 : 0
  })
  return {
    input,
    database,
    artifact: new Map(database.artifacts.map((value) => [value.name, value])),
    lock: database.qualification.lock,
    result: database.qualification.result,
    reference,
    trace,
    provenance,
    policyDocuments: makePolicyDocuments(database.qualification.lock),
    sortedReplicas,
    replicaSet: new Set(sortedReplicas),
    sortedAccess,
    publisherSet: new Set(input.signalPrincipals.publishers),
    markedEquity: makeMarkedEquityAuditMaterial(input, reference, trace),
  }
}

const auditStoredEvidence = (facts: QualificationAuditFacts): readonly AuditCheck[] => {
  const { database, input, provenance, reference } = facts
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
    ['marked-equity-reconciliation', 'bayn.marked-equity-reconciliation.v2'],
    ['reconciliation', 'bayn.reconciliation.v1'],
    ['qualification-artifact-manifest', 'bayn.qualification-artifact-manifest.v1'],
  ])
  return [
    makeAuditCheck('postgres-transaction-read-only', database.transactionReadOnly, 'transaction_read_only=on'),
    makeAuditCheck(
      'protocol-content',
      same(input.protocol, database.protocol.parameters) &&
        canonicalHashV1(input.protocol) === database.protocol.parameterHash &&
        reference.protocolHash === database.protocol.protocolHash,
      `parameterHash=${database.protocol.parameterHash}`,
    ),
    makeAuditCheck(
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
    ),
    makeAuditCheck(
      'evidence-counts',
      database.artifacts.length === database.run.artifactCount &&
        database.events.length === database.run.eventCount &&
        database.gates.length === database.run.gateCount,
      `${database.artifacts.length}/${database.events.length}/${database.gates.length}`,
    ),
    makeAuditCheck(
      'artifact-hashes',
      database.artifacts.every((value) => canonicalHashV1(value.payload) === value.contentHash),
      `${database.artifacts.length} artifacts`,
    ),
    makeAuditCheck(
      'artifact-schema-versions',
      database.artifacts.length === expectedArtifactSchemas.size &&
        database.artifacts.every((value) => expectedArtifactSchemas.get(value.name) === value.schemaVersion),
      `${database.artifacts.length} versioned artifacts`,
    ),
    makeAuditCheck(
      'event-hashes-and-order',
      database.events.every(
        (value, index) =>
          value.ordinal === index &&
          value.id === value.payload.id &&
          value.kind === value.payload.kind &&
          canonicalHashV1(value.payload) === value.contentHash,
      ),
      `${database.events.length} events`,
    ),
    makeAuditCheck(
      'gate-hashes-and-order',
      database.gates.every(
        (value, index) =>
          value.ordinal === index &&
          canonicalHashV1({
            name: value.name,
            passed: value.passed,
            actual: value.actual,
            required: value.required,
          }) === value.contentHash,
      ),
      `${database.gates.length} gates`,
    ),
    makeAuditCheck(
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
    ),
  ]
}

const auditReferenceArtifacts = (facts: QualificationAuditFacts): readonly AuditCheck[] => {
  const { artifact, database, input, markedEquity, reference, trace } = facts
  const checks: AuditCheck[] = []
  const checkArtifact = (name: string, expected: unknown): void => {
    checks.push(
      makeAuditCheck(
        `reference-${name}`,
        same(artifact.get(name)?.payload, expected),
        `contentHash=${canonicalHashV1(expected)}`,
      ),
    )
  }
  if (markedEquity._tag === 'Unavailable') {
    checks.push(makeAuditCheck('reference-evaluation-summary', false, markedEquity.evidence))
  } else {
    checkArtifact('evaluation-summary', makeSummary(input, reference, trace, markedEquity.proof.reconciliation))
  }
  const expectedArtifacts = new Map<string, unknown>([
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
        items: trace.orders,
      },
    ],
    ['cash-changes', { schemaVersion: 'bayn.cash-changes.v2', items: trace.cashChanges }],
    ['daily-position-marks', { schemaVersion: 'bayn.daily-position-marks.v3', items: trace.dailyMarks }],
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
  ])
  for (const [name, expected] of expectedArtifacts) checkArtifact(name, expected)
  if (markedEquity._tag === 'Unavailable') {
    checks.push(
      makeAuditCheck('reference-equity-series', false, markedEquity.evidence),
      makeAuditCheck('reference-marked-equity-reconciliation', false, markedEquity.evidence),
    )
  } else {
    checkArtifact('equity-series', {
      schemaVersion: 'bayn.equity-series.v1',
      items: markedEquity.proof.equitySeries,
    })
    checkArtifact('marked-equity-reconciliation', markedEquity.proof.reconciliation)
  }
  checks.push(
    makeAuditCheck(
      'reference-events',
      same(
        database.events.map((value) => value.payload),
        reference.strategy.events,
      ),
      `contentHash=${canonicalHashV1(reference.strategy.events)}`,
    ),
    makeAuditCheck(
      'reference-gates',
      same(
        database.gates.map(({ name, passed, actual, required }) => ({ name, passed, actual, required })),
        reference.verdict.gates,
      ),
      `economicStatus=${reference.verdict.status}`,
    ),
  )
  return checks
}

const auditArtifactManifest = (facts: QualificationAuditFacts): readonly AuditCheck[] => {
  const { artifact, database, input, markedEquity, reference, trace } = facts
  const reconciliation = decodeReconciliation(artifact.get('reconciliation')?.payload)
  const checks = [
    makeAuditCheck(
      'accounting-reconciliation-identity',
      reconciliation.runId === database.run.runId && reconciliation.exact === true,
      `runId=${reconciliation.runId} exact=${reconciliation.exact}`,
    ),
  ]
  if (markedEquity._tag === 'Unavailable') {
    checks.push(makeAuditCheck('qualification-artifact-manifest', false, markedEquity.evidence))
    return checks
  }
  const artifactItemCounts = new Map<string, number>([
    ['evaluation-summary', 0],
    ['input-manifest', 0],
    ['strategy', 0],
    ['buy-and-hold', 0],
    ['direct-volatility-timing', 0],
    ['double-cost-strategy', 0],
    ['simulated-orders', trace.orders.length],
    ['cash-changes', trace.cashChanges.length],
    ['daily-position-marks', trace.dailyMarks.length],
    [contract.decisionArtifactName, reference.strategy.decisions.length],
    ['buy-and-hold-series', reference.buyAndHold.daily.length],
    ['direct-volatility-timing-series', reference.directVolTiming.daily.length],
    ['double-cost-strategy-series', reference.doubleCostStrategy.daily.length],
    ['equity-series', markedEquity.proof.equitySeries.length],
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
  checks.push(
    makeAuditCheck(
      'qualification-artifact-manifest',
      same(artifact.get('qualification-artifact-manifest')?.payload, qualificationManifest),
      `contentHash=${canonicalHashV1(qualificationManifest)}`,
    ),
  )
  return checks
}

const auditQualificationBindings = (facts: QualificationAuditFacts): readonly AuditCheck[] => {
  const { database, input, lock, policyDocuments, reference, result } = facts
  const { lockId, ...lockMaterial } = lock
  const { resultHash, ...resultMaterial } = result
  const analysis = result.analysis
  const { analysisHash, ...analysisMaterial } = analysis
  const lockData = lock.data
  const lockContractBinding =
    lock.schemaVersion === 'bayn.qualification-lock.v3' &&
    lock.universeId === input.protocol.universeId &&
    lock.universeSymbolHash === input.protocol.universeSymbolHash &&
    lockData.inputManifestHash === input.manifest.hash
  const economicPass = reference.verdict.gates.every((gate) => gate.passed)
  const analysisPass = analysis.status === 'PASS'
  const expectedQualification = economicPass && analysisPass ? 'QUALIFIED' : 'REJECTED'
  const expectedEconomicReasons = reference.verdict.gates
    .filter((gate) => !gate.passed)
    .map((gate) => expectedResultReason(gate.name))
  const expectedReasonCodes = [...new Set([...expectedEconomicReasons, ...analysis.reasonCodes])].sort()
  return [
    makeAuditCheck('lock-hash', canonicalHashV1(lockMaterial) === lockId, `lockId=${lockId}`),
    makeAuditCheck(
      'qualification-row-binding',
      database.qualification.storedLockId === lockId &&
        database.qualification.storedAnalysisHash === analysis.analysisHash &&
        database.qualification.storedResultHash === resultHash &&
        database.qualification.storedVerdict === result.verdict,
      `storedResultHash=${database.qualification.storedResultHash}`,
    ),
    makeAuditCheck(
      'lock-candidate-binding',
      lock.candidateRunId === database.run.runId &&
        lock.protocolHash === database.run.protocolHash &&
        lock.sourceRevision === database.run.sourceRevision &&
        same(lock.image, { repository: database.run.imageRepository, digest: database.run.imageDigest }) &&
        lockContractBinding &&
        same(lock.universe, input.protocol.universe),
      `candidateRunId=${String(lock.candidateRunId)}`,
    ),
    makeAuditCheck(
      'lock-data-binding',
      lockData.snapshotId === input.manifest.finalizedSnapshot.snapshotId &&
        lockData.publicationId === input.manifest.finalizedSnapshot.publicationId &&
        lockData.contentHash === input.manifest.finalizedSnapshot.contentHash &&
        lockData.sessionsContentHash === input.manifest.finalizedSnapshot.sessionsContentHash &&
        lockData.selectedSessionCount === reference.strategy.metrics.observations &&
        lockData.selectedRebalanceCount === reference.strategy.decisions.length &&
        same(lockData.bounds, input.manifest.bounds),
      `snapshotId=${String(lockData.snapshotId)}`,
    ),
    makeAuditCheck(
      'lock-policy-hashes',
      same(
        policyDocuments.map((policy) => policy.name),
        ['benchmark', 'execution', 'thresholds', 'uncertainty'],
      ) && policyDocuments.every((policy) => policy.contentHash === canonicalHashV1(policy.content)),
      `${policyDocuments.length} policies policySetHash=${canonicalHashV1(policyDocuments)}`,
    ),
    makeAuditCheck(
      'locked-prior-trial-lineage',
      same(lock.priorTrialRunIds, [...database.priorTrialRunIds].sort()),
      `${database.priorTrialRunIds.length} prior trials`,
    ),
    makeAuditCheck('analysis-hash', canonicalHashV1(analysisMaterial) === analysisHash, `analysisHash=${analysisHash}`),
    makeAuditCheck('result-hash', canonicalHashV1(resultMaterial) === resultHash, `resultHash=${resultHash}`),
    makeAuditCheck(
      'analysis-lineage',
      analysis.runId === database.run.runId &&
        same(analysis.priorTrialRunIds, lock.priorTrialRunIds) &&
        analysis.candidateOrdinal === database.priorTrialRunIds.length + 1,
      `candidateOrdinal=${String(analysis.candidateOrdinal)}`,
    ),
    makeAuditCheck(
      'terminal-result-binding',
      result.lockId === lockId &&
        result.runId === database.run.runId &&
        result.verdict === expectedQualification &&
        same(result.evaluationVerdict, reference.verdict) &&
        same(result.reasonCodes, expectedReasonCodes),
      `verdict=${String(result.verdict)} reasons=${result.reasonCodes.join(',')}`,
    ),
  ]
}

const auditSignalAndRepository = (facts: QualificationAuditFacts): readonly AuditCheck[] => {
  const { database, input, publisherSet, replicaSet, sortedAccess, sortedReplicas } = facts
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
  return [
    makeAuditCheck(
      'signal-query-log-replica-coverage',
      sortedReplicas.length >= 2 &&
        replicaSet.size === sortedReplicas.length &&
        sortedAccess.every((value) => replicaSet.has(value.replica)),
      `${sortedReplicas.length} replicas=${sortedReplicas.join(',')}`,
    ),
    makeAuditCheck(
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
    ),
    makeAuditCheck(
      'signal-calendar-inspected-before-lock',
      preLockSessionReads.length >= 1 && lockedSessionReads.length >= 1,
      `preLock=${preLockSessionReads.length} locked=${lockedSessionReads.length}`,
    ),
    makeAuditCheck(
      'signal-manifest-inspected-before-lock',
      preLockManifestReads.length >= 1 && lockedManifestReads.length >= 1,
      `preLock=${preLockManifestReads.length} locked=${lockedManifestReads.length}`,
    ),
    makeAuditCheck(
      'signal-read-principals',
      input.signalPrincipals.candidate.length > 0 &&
        publisherSet.size === input.signalPrincipals.publishers.length &&
        input.signalPrincipals.publishers.length > 0 &&
        !publisherSet.has(input.signalPrincipals.candidate) &&
        sortedAccess.every((value) => value.user === input.signalPrincipals.candidate || publisherSet.has(value.user)),
      [...new Set(sortedAccess.map((value) => value.user))].join(','),
    ),
    makeAuditCheck(
      'source-revision-in-repository',
      input.repository.sourceCommitExists && input.repository.sourceCommitAncestorOfMain,
      `sourceRevision=${database.run.sourceRevision}`,
    ),
    makeAuditCheck(
      'no-pre-lock-result-reference',
      input.repository.preLockResultReferences.length === 0,
      input.repository.preLockResultReferences.join(',') || 'none',
    ),
  ]
}

const makeAuditReport = (facts: QualificationAuditFacts, checks: readonly AuditCheck[]): QualificationAuditReport => {
  const { database, input, lock, policyDocuments, reference, result, sortedAccess, sortedReplicas } = facts
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
      lockId: lock.lockId,
      resultHash: result.resultHash,
    },
    policies: {
      declaredAt: database.qualification.lockCreatedAt,
      lockId: lock.lockId,
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

export const auditQualification = (input: QualificationAuditInput): QualificationAuditReport => {
  const facts = makeAuditFacts(input)
  const checks = [
    ...auditStoredEvidence(facts),
    ...auditReferenceArtifacts(facts),
    ...auditArtifactManifest(facts),
    ...auditQualificationBindings(facts),
    ...auditSignalAndRepository(facts),
  ]
  return makeAuditReport(facts, checks)
}
