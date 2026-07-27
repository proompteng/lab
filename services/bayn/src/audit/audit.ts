import { Result, Schema } from 'effect'

import { makeRuntimeProvenanceResult, type ContractConstructionFailure, type RuntimeProvenance } from '../contracts'
import { ReconciliationResultSchema } from '../evidence-contracts'
import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'
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
import { evaluateReference, type ReferenceEvaluation, type ReferenceEvaluationFailure } from './reference'

const decodeReconciliation = Schema.decodeUnknownResult(ReconciliationResultSchema, StrictParseOptions)
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

export type SignalTableClassificationFailure = {
  readonly _tag: 'SignalEvidenceTableNotAccessed'
  readonly observedTables: readonly string[]
  readonly expectedTables: readonly string[]
}

export const classifySignalTableAccess = (
  observedTables: readonly string[],
  signalTables: InputManifest['tables'],
): Result.Result<SignalAccessRecord['kind'], SignalTableClassificationFailure> => {
  const tables = new Set(observedTables)
  if (tables.has(`signal.${signalTables.bars}`)) return Result.succeed('bars')
  if (tables.has(`signal.${signalTables.sessions}`)) return Result.succeed('sessions')
  if (tables.has(`signal.${signalTables.manifests}`)) return Result.succeed('manifest')
  return Result.fail({
    _tag: 'SignalEvidenceTableNotAccessed',
    observedTables: [...observedTables].sort(),
    expectedTables: [
      `signal.${signalTables.bars}`,
      `signal.${signalTables.sessions}`,
      `signal.${signalTables.manifests}`,
    ].sort(),
  })
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

export interface SignalReplicaAuditSource {
  readonly replica: string
  readonly topology: readonly string[]
  readonly access: readonly SignalAccessRecord[]
}

export type SignalReplicaTopologyFailure =
  | {
      readonly _tag: 'DuplicateSignalReplicaEndpoint'
      readonly observedReplicas: readonly string[]
    }
  | {
      readonly _tag: 'InvalidSignalReplicaTopology'
      readonly topology: readonly string[]
      readonly minimumReplicaCount: 2
    }
  | {
      readonly _tag: 'DivergentSignalReplicaTopology'
      readonly replica: string
      readonly expectedTopology: readonly string[]
      readonly actualTopology: readonly string[]
    }
  | {
      readonly _tag: 'IncompleteSignalReplicaCoverage'
      readonly observedReplicas: readonly string[]
      readonly expectedTopology: readonly string[]
    }
  | {
      readonly _tag: 'SignalReplicaRecordMismatch'
      readonly endpointReplica: string
      readonly recordReplica: string
      readonly queryId: string
    }

export const validateSignalReplicaTopology = (
  sources: readonly SignalReplicaAuditSource[],
): Result.Result<
  { readonly replicas: readonly string[]; readonly access: readonly SignalAccessRecord[] },
  SignalReplicaTopologyFailure
> => {
  const observedReplicas = sources.map((source) => source.replica).sort()
  if (new Set(observedReplicas).size !== observedReplicas.length) {
    return Result.fail({ _tag: 'DuplicateSignalReplicaEndpoint', observedReplicas })
  }
  const expectedTopology = [...(sources[0]?.topology ?? [])].sort()
  if (expectedTopology.length < 2 || new Set(expectedTopology).size !== expectedTopology.length) {
    return Result.fail({ _tag: 'InvalidSignalReplicaTopology', topology: expectedTopology, minimumReplicaCount: 2 })
  }
  for (const source of sources) {
    const actualTopology = [...source.topology].sort()
    if (actualTopology.join('\0') !== expectedTopology.join('\0')) {
      return Result.fail({
        _tag: 'DivergentSignalReplicaTopology',
        replica: source.replica,
        expectedTopology,
        actualTopology,
      })
    }
  }
  if (observedReplicas.join('\0') !== expectedTopology.join('\0')) {
    return Result.fail({ _tag: 'IncompleteSignalReplicaCoverage', observedReplicas, expectedTopology })
  }
  for (const source of sources) {
    const mismatched = source.access.find((record) => record.replica !== source.replica)
    if (mismatched !== undefined) {
      return Result.fail({
        _tag: 'SignalReplicaRecordMismatch',
        endpointReplica: source.replica,
        recordReplica: mismatched.replica,
        queryId: mismatched.queryId,
      })
    }
  }
  return Result.succeed({ replicas: observedReplicas, access: sources.flatMap((source) => source.access) })
}

export type QualificationAuditFailure =
  | ReferenceEvaluationFailure
  | ContractConstructionFailure
  | {
      readonly _tag: 'AuditCanonicalizationFailed'
      readonly subject: AuditCanonicalizationSubject
      readonly cause: CanonicalHashFailure
    }
  | {
      readonly _tag: 'UnsupportedAuditStrategyContract'
      readonly protocolStrategyName: string
      readonly runStrategyName: string
      readonly requiredStrategyName: typeof contract.name
    }
  | {
      readonly _tag: 'UnsupportedAuditProtocolVersion'
      readonly storedSchemaVersion: string
      readonly suppliedSchemaVersion: string
      readonly supportedSchemaVersions: readonly [
        'bayn.risk-balanced-trend.protocol.v3',
        'bayn.risk-balanced-trend.protocol.v4',
      ]
    }
  | {
      readonly _tag: 'ReferenceCandidateTraceMissing'
      readonly runId: string
    }
  | {
      readonly _tag: 'ReconciliationArtifactInvalid'
      readonly artifactName: 'reconciliation'
      readonly cause: Schema.SchemaError
    }
  | {
      readonly _tag: 'UnsupportedQualificationArtifact'
      readonly artifactName: string
      readonly supportedArtifactNames: readonly string[]
    }

export interface AuditCanonicalizationSubject {
  readonly scope:
    | 'analysis'
    | 'artifact'
    | 'audit'
    | 'event'
    | 'gate'
    | 'lineage'
    | 'lock'
    | 'policy'
    | 'protocol'
    | 'qualification-manifest'
    | 'reference'
    | 'result'
    | 'status'
  readonly name?: string
  readonly ordinal?: number
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

const hashAuditMaterial = (
  subject: AuditCanonicalizationSubject,
  value: unknown,
): Result.Result<string, QualificationAuditFailure> =>
  Result.mapError(
    canonicalHashV1Result(value),
    (cause): QualificationAuditFailure => ({ _tag: 'AuditCanonicalizationFailed', subject, cause }),
  )

const same = (
  subject: AuditCanonicalizationSubject,
  left: unknown,
  right: unknown,
): Result.Result<boolean, QualificationAuditFailure> =>
  Result.gen(function* () {
    const leftHash = yield* hashAuditMaterial(subject, left)
    const rightHash = yield* hashAuditMaterial(subject, right)
    return leftHash === rightHash
  })

const hashMatches = (
  subject: AuditCanonicalizationSubject,
  value: unknown,
  expectedHash: string,
): Result.Result<boolean, QualificationAuditFailure> =>
  Result.map(hashAuditMaterial(subject, value), (actualHash) => actualHash === expectedHash)

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
  readonly provenance: RuntimeProvenance
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

const makeAuditFacts = (
  input: QualificationAuditInput,
): Result.Result<QualificationAuditFacts, QualificationAuditFailure> => {
  const database = input.database
  if (database.protocol.strategyName !== contract.name || database.run.strategyName !== contract.name) {
    return Result.fail({
      _tag: 'UnsupportedAuditStrategyContract',
      protocolStrategyName: database.protocol.strategyName,
      runStrategyName: database.run.strategyName,
      requiredStrategyName: contract.name,
    })
  }
  const supportedSchemaVersions = [
    'bayn.risk-balanced-trend.protocol.v3',
    'bayn.risk-balanced-trend.protocol.v4',
  ] as const
  if (
    database.protocol.schemaVersion !== input.protocol.schemaVersion ||
    !supportedSchemaVersions.some((schemaVersion) => schemaVersion === database.protocol.schemaVersion)
  ) {
    return Result.fail({
      _tag: 'UnsupportedAuditProtocolVersion',
      storedSchemaVersion: database.protocol.schemaVersion,
      suppliedSchemaVersion: input.protocol.schemaVersion,
      supportedSchemaVersions,
    })
  }
  const provenanceResult = makeRuntimeProvenanceResult({
    sourceRevision: database.run.sourceRevision,
    image: { repository: database.run.imageRepository, digest: database.run.imageDigest },
    strategy: {
      name: database.protocol.strategyName,
      behaviorHash: database.protocol.behaviorHash,
      parameterHash: database.protocol.parameterHash,
      parameterSchemaVersion: database.protocol.schemaVersion,
    },
  })
  if (Result.isFailure(provenanceResult)) return Result.fail(provenanceResult.failure)
  const provenance = provenanceResult.success
  const referenceResult = evaluateReference(input.bars, input.manifest, input.protocol, provenance)
  if (Result.isFailure(referenceResult)) return Result.fail(referenceResult.failure)
  const reference = referenceResult.success
  const trace = reference.strategy.trace
  if (trace === null) return Result.fail({ _tag: 'ReferenceCandidateTraceMissing', runId: reference.runId })
  const sortedReplicas = [...input.signalReplicas].sort()
  const sortedAccess = [...input.signalAccess].sort((left, right) => {
    if (left.queryStartTime !== right.queryStartTime) return left.queryStartTime < right.queryStartTime ? -1 : 1
    if (left.replica !== right.replica) return left.replica < right.replica ? -1 : 1
    return left.queryId < right.queryId ? -1 : left.queryId > right.queryId ? 1 : 0
  })
  return Result.succeed({
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
  })
}

const auditStoredEvidence = (
  facts: QualificationAuditFacts,
): Result.Result<readonly AuditCheck[], QualificationAuditFailure> =>
  Result.gen(function* () {
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
    const protocolContentMatches = yield* same(
      { scope: 'protocol', name: 'parameters' },
      input.protocol,
      database.protocol.parameters,
    )
    const protocolHashMatches = yield* hashMatches(
      { scope: 'protocol', name: 'parameter-hash' },
      input.protocol,
      database.protocol.parameterHash,
    )
    const artifactHashes = yield* Result.all(
      database.artifacts.map((value) =>
        hashMatches({ scope: 'artifact', name: value.name }, value.payload, value.contentHash),
      ),
    )
    const eventHashes = yield* Result.all(
      database.events.map((value) =>
        hashMatches({ scope: 'event', name: value.kind, ordinal: value.ordinal }, value.payload, value.contentHash),
      ),
    )
    const gateHashes = yield* Result.all(
      database.gates.map((value) =>
        hashMatches(
          { scope: 'gate', name: value.name, ordinal: value.ordinal },
          { name: value.name, passed: value.passed, actual: value.actual, required: value.required },
          value.contentHash,
        ),
      ),
    )
    const [writingStatus, completeStatus] = database.statuses
    let statusHistoryMatches = false
    if (
      database.statuses.length === 2 &&
      writingStatus?.status === 'WRITING' &&
      completeStatus?.status === 'COMPLETE'
    ) {
      const writingDetailMatches = yield* same({ scope: 'status', name: 'WRITING' }, writingStatus.detail, {
        artifactCount: database.run.artifactCount,
        eventCount: database.run.eventCount,
        gateCount: database.run.gateCount,
      })
      const completeDetailMatches = yield* same({ scope: 'status', name: 'COMPLETE' }, completeStatus.detail, {
        reconciliationExact: true,
        verdict: reference.verdict.status,
      })
      statusHistoryMatches = writingDetailMatches && completeDetailMatches
    }
    return [
      makeAuditCheck('postgres-transaction-read-only', database.transactionReadOnly, 'transaction_read_only=on'),
      makeAuditCheck(
        'protocol-content',
        protocolContentMatches && protocolHashMatches && reference.protocolHash === database.protocol.protocolHash,
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
      makeAuditCheck('artifact-hashes', artifactHashes.every(Boolean), `${database.artifacts.length} artifacts`),
      makeAuditCheck(
        'artifact-schema-versions',
        database.artifacts.length === expectedArtifactSchemas.size &&
          database.artifacts.every((value) => expectedArtifactSchemas.get(value.name) === value.schemaVersion),
        `${database.artifacts.length} versioned artifacts`,
      ),
      makeAuditCheck(
        'event-hashes-and-order',
        eventHashes.every(Boolean) &&
          database.events.every(
            (value, index) =>
              value.ordinal === index && value.id === value.payload.id && value.kind === value.payload.kind,
          ),
        `${database.events.length} events`,
      ),
      makeAuditCheck(
        'gate-hashes-and-order',
        gateHashes.every(Boolean) && database.gates.every((value, index) => value.ordinal === index),
        `${database.gates.length} gates`,
      ),
      makeAuditCheck(
        'status-history',
        statusHistoryMatches,
        database.statuses.map((status) => status.status).join(' -> '),
      ),
    ]
  })

const auditReferenceArtifacts = (
  facts: QualificationAuditFacts,
): Result.Result<readonly AuditCheck[], QualificationAuditFailure> =>
  Result.gen(function* () {
    const { artifact, database, input, markedEquity, reference, trace } = facts
    const checks: AuditCheck[] = []
    const checkArtifact = (name: string, expected: unknown): Result.Result<void, QualificationAuditFailure> =>
      Result.gen(function* () {
        const expectedHash = yield* hashAuditMaterial({ scope: 'reference', name }, expected)
        const stored = artifact.get(name)
        if (stored === undefined) {
          checks.push(makeAuditCheck(`reference-${name}`, false, `missing; expected contentHash=${expectedHash}`))
          return
        }
        const matches = yield* same({ scope: 'reference', name }, stored.payload, expected)
        checks.push(makeAuditCheck(`reference-${name}`, matches, `contentHash=${expectedHash}`))
      })
    if (markedEquity._tag === 'Unavailable') {
      checks.push(makeAuditCheck('reference-evaluation-summary', false, markedEquity.evidence))
    } else {
      yield* checkArtifact(
        'evaluation-summary',
        makeSummary(input, reference, trace, markedEquity.proof.reconciliation),
      )
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
    for (const [name, expected] of expectedArtifacts) yield* checkArtifact(name, expected)
    if (markedEquity._tag === 'Unavailable') {
      checks.push(
        makeAuditCheck('reference-equity-series', false, markedEquity.evidence),
        makeAuditCheck('reference-marked-equity-reconciliation', false, markedEquity.evidence),
      )
    } else {
      yield* checkArtifact('equity-series', {
        schemaVersion: 'bayn.equity-series.v1',
        items: markedEquity.proof.equitySeries,
      })
      yield* checkArtifact('marked-equity-reconciliation', markedEquity.proof.reconciliation)
    }
    const referenceEventsHash = yield* hashAuditMaterial(
      { scope: 'reference', name: 'events' },
      reference.strategy.events,
    )
    const referenceEventsMatch = yield* same(
      { scope: 'reference', name: 'events' },
      database.events.map((value) => value.payload),
      reference.strategy.events,
    )
    const referenceGatesMatch = yield* same(
      { scope: 'reference', name: 'gates' },
      database.gates.map(({ name, passed, actual, required }) => ({ name, passed, actual, required })),
      reference.verdict.gates,
    )
    checks.push(
      makeAuditCheck('reference-events', referenceEventsMatch, `contentHash=${referenceEventsHash}`),
      makeAuditCheck('reference-gates', referenceGatesMatch, `economicStatus=${reference.verdict.status}`),
    )
    return checks
  })

const auditArtifactManifest = (
  facts: QualificationAuditFacts,
): Result.Result<readonly AuditCheck[], QualificationAuditFailure> =>
  Result.gen(function* () {
    const { artifact, database, input, markedEquity, reference, trace } = facts
    const reconciliationResult = decodeReconciliation(artifact.get('reconciliation')?.payload)
    if (Result.isFailure(reconciliationResult)) {
      return yield* Result.fail({
        _tag: 'ReconciliationArtifactInvalid',
        artifactName: 'reconciliation',
        cause: reconciliationResult.failure,
      } satisfies QualificationAuditFailure)
    }
    const reconciliation = reconciliationResult.success
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
    const baseArtifacts = database.artifacts.filter((value) => value.name !== 'qualification-artifact-manifest')
    const supportedArtifactNames = [...artifactItemCounts.keys()].sort()
    const manifestArtifacts: {
      readonly name: string
      readonly schemaVersion: string
      readonly itemCount: number
      readonly contentHash: string
    }[] = []
    for (const value of [...baseArtifacts].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      const itemCount = artifactItemCounts.get(value.name)
      if (itemCount === undefined) {
        return yield* Result.fail({
          _tag: 'UnsupportedQualificationArtifact',
          artifactName: value.name,
          supportedArtifactNames,
        } satisfies QualificationAuditFailure)
      }
      manifestArtifacts.push({
        name: value.name,
        schemaVersion: value.schemaVersion,
        itemCount,
        contentHash: value.contentHash,
      })
    }
    const eventsContentHash = yield* hashAuditMaterial(
      { scope: 'qualification-manifest', name: 'events' },
      database.events.map(({ ordinal, id, kind, contentHash }) => ({ ordinal, id, kind, contentHash })),
    )
    const gatesContentHash = yield* hashAuditMaterial(
      { scope: 'qualification-manifest', name: 'gates' },
      database.gates.map(({ ordinal, name, passed, contentHash }) => ({ ordinal, name, passed, contentHash })),
    )
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
      artifacts: manifestArtifacts,
      events: { count: database.events.length, contentHash: eventsContentHash },
      gates: { count: database.gates.length, contentHash: gatesContentHash },
    }
    const qualificationManifestHash = yield* hashAuditMaterial(
      { scope: 'qualification-manifest', name: 'document' },
      qualificationManifest,
    )
    const storedQualificationManifest = artifact.get('qualification-artifact-manifest')
    const qualificationManifestMatches =
      storedQualificationManifest === undefined
        ? false
        : yield* same(
            { scope: 'qualification-manifest', name: 'stored-document' },
            storedQualificationManifest.payload,
            qualificationManifest,
          )
    checks.push(
      makeAuditCheck(
        'qualification-artifact-manifest',
        qualificationManifestMatches,
        `contentHash=${qualificationManifestHash}`,
      ),
    )
    return checks
  })

const auditQualificationBindings = (
  facts: QualificationAuditFacts,
): Result.Result<readonly AuditCheck[], QualificationAuditFailure> =>
  Result.gen(function* () {
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
    const lockHashMatches = yield* hashMatches({ scope: 'lock', name: 'document' }, lockMaterial, lockId)
    const lockImageMatches = yield* same({ scope: 'lock', name: 'image' }, lock.image, {
      repository: database.run.imageRepository,
      digest: database.run.imageDigest,
    })
    const lockUniverseMatches = yield* same({ scope: 'lock', name: 'universe' }, lock.universe, input.protocol.universe)
    const lockBoundsMatch = yield* same({ scope: 'lock', name: 'bounds' }, lockData.bounds, input.manifest.bounds)
    const policyNamesMatch = yield* same(
      { scope: 'policy', name: 'names' },
      policyDocuments.map((policy) => policy.name),
      ['benchmark', 'execution', 'thresholds', 'uncertainty'],
    )
    const policyHashes = yield* Result.all(
      policyDocuments.map((policy) =>
        hashMatches({ scope: 'policy', name: policy.name }, policy.content, policy.contentHash),
      ),
    )
    const policySetHash = yield* hashAuditMaterial({ scope: 'policy', name: 'set' }, policyDocuments)
    const priorLineageMatches = yield* same(
      { scope: 'lineage', name: 'prior-trials' },
      lock.priorTrialRunIds,
      [...database.priorTrialRunIds].sort(),
    )
    const analysisHashMatches = yield* hashMatches(
      { scope: 'analysis', name: 'document' },
      analysisMaterial,
      analysisHash,
    )
    const resultHashMatches = yield* hashMatches({ scope: 'result', name: 'document' }, resultMaterial, resultHash)
    const analysisLineageMatches = yield* same(
      { scope: 'analysis', name: 'prior-trials' },
      analysis.priorTrialRunIds,
      lock.priorTrialRunIds,
    )
    const evaluationVerdictMatches = yield* same(
      { scope: 'result', name: 'evaluation-verdict' },
      result.evaluationVerdict,
      reference.verdict,
    )
    const reasonCodesMatch = yield* same(
      { scope: 'result', name: 'reason-codes' },
      result.reasonCodes,
      expectedReasonCodes,
    )
    return [
      makeAuditCheck('lock-hash', lockHashMatches, `lockId=${lockId}`),
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
          lockImageMatches &&
          lockContractBinding &&
          lockUniverseMatches,
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
          lockBoundsMatch,
        `snapshotId=${String(lockData.snapshotId)}`,
      ),
      makeAuditCheck(
        'lock-policy-hashes',
        policyNamesMatch && policyHashes.every(Boolean),
        `${policyDocuments.length} policies policySetHash=${policySetHash}`,
      ),
      makeAuditCheck(
        'locked-prior-trial-lineage',
        priorLineageMatches,
        `${database.priorTrialRunIds.length} prior trials`,
      ),
      makeAuditCheck('analysis-hash', analysisHashMatches, `analysisHash=${analysisHash}`),
      makeAuditCheck('result-hash', resultHashMatches, `resultHash=${resultHash}`),
      makeAuditCheck(
        'analysis-lineage',
        analysis.runId === database.run.runId &&
          analysisLineageMatches &&
          analysis.candidateOrdinal === database.priorTrialRunIds.length + 1,
        `candidateOrdinal=${String(analysis.candidateOrdinal)}`,
      ),
      makeAuditCheck(
        'terminal-result-binding',
        result.lockId === lockId &&
          result.runId === database.run.runId &&
          result.verdict === expectedQualification &&
          evaluationVerdictMatches &&
          reasonCodesMatch,
        `verdict=${String(result.verdict)} reasons=${result.reasonCodes.join(',')}`,
      ),
    ]
  })

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

const makeAuditReport = (
  facts: QualificationAuditFacts,
  checks: readonly AuditCheck[],
): Result.Result<QualificationAuditReport, QualificationAuditFailure> =>
  Result.gen(function* () {
    const { database, input, lock, policyDocuments, reference, result, sortedAccess, sortedReplicas } = facts
    const policySetHash = yield* hashAuditMaterial({ scope: 'policy', name: 'report-set' }, policyDocuments)
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
        policySetHash,
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
    const auditHash = yield* hashAuditMaterial({ scope: 'audit', name: 'report' }, material)
    return { ...material, auditHash }
  })

export const auditQualification = (
  input: QualificationAuditInput,
): Result.Result<QualificationAuditReport, QualificationAuditFailure> =>
  Result.gen(function* () {
    const facts = yield* makeAuditFacts(input)
    const artifactManifestChecks = yield* auditArtifactManifest(facts)
    const storedEvidenceChecks = yield* auditStoredEvidence(facts)
    const referenceArtifactChecks = yield* auditReferenceArtifacts(facts)
    const qualificationBindingChecks = yield* auditQualificationBindings(facts)
    const checks = [
      ...storedEvidenceChecks,
      ...referenceArtifactChecks,
      ...artifactManifestChecks,
      ...qualificationBindingChecks,
      ...auditSignalAndRepository(facts),
    ]
    return yield* makeAuditReport(facts, checks)
  })
