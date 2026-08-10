import { Result, Schema } from 'effect'

import type { ContractConstructionFailure } from '../contracts'
import type { CanonicalHashFailure } from '../hash'
import type { QualificationLock, QualificationResult } from '../qualification'
import {
  ContractVersion,
  type DailyBar,
  type EconomicVerdict,
  type EvaluationEvent,
  type InputManifest,
  type Protocol,
} from '../types'
import type { ReferenceEvaluationFailure } from './reference'
import type { StrategyApplication } from '../strategy/core'
import { Pipeable } from '../pipeable'

export const auditContract = {
  name: 'risk-balanced-trend',
  evaluationSchemaVersion: ContractVersion.Evaluation,
  summarySchemaVersion: ContractVersion.EvaluationSummary,
  decisionArtifactName: 'risk-balanced-trend-decisions',
  decisionArtifactSchemaVersion: 'bayn.risk-balanced-trend-decisions.v1',
} as const

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

const classifySignalTableAccessDataFirst = (
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

export const classifySignalTableAccess = Pipeable.dual(2, classifySignalTableAccessDataFirst)

export interface RepositoryAudit {
  readonly sourceCommitExists: boolean
  readonly sourceCommitAncestorOfMain: boolean
  readonly preLockResultReferences: readonly string[]
}

export interface QualificationAuditInput {
  readonly bars: readonly DailyBar[]
  readonly manifest: InputManifest
  readonly protocol: Protocol
  /** The reviewed pure application that produced the qualification attempt. */
  readonly application: StrategyApplication<any, any, any>
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
      readonly requiredStrategyName: string
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
