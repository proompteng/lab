import type { Schema } from 'effect'

import type { ContractConstructionFailure } from '../../contracts'
import type { CanonicalJsonFailure } from '../../hash'
import type { QualificationDecisionFailure } from './qualification'
import type { SimulationReconciliationIssue } from '../../simulation-reconciliation'
import type { EvaluationEvent, EvaluationResult, Protocol } from '../../types'
import type { PersistEvaluationInput } from './model'

export interface PersistenceArtifact {
  readonly name: string
  readonly schemaVersion: string
  readonly contentHash: string
  readonly payload: unknown
  readonly itemCount: number
}

export type PersistencePlan = Omit<PersistEvaluationInput, 'qualification'> & {
  readonly qualification: PersistEvaluationInput['qualification']
  readonly strategyName: string
  readonly protocolHash: string
  readonly snapshotId: string
  readonly artifacts: readonly PersistenceArtifact[]
  readonly events: readonly ({
    readonly ordinal: number
    readonly contentHash: string
    readonly payload: EvaluationEvent
  } & Pick<EvaluationEvent, 'id' | 'kind'>)[]
  readonly gates: readonly ({
    readonly ordinal: number
    readonly contentHash: string
  } & EvaluationResult['verdict']['gates'][number])[]
}

export const persistencePlanInvariantMessages = {
  'evaluation-schema-version': 'evaluation schema version does not match runtime provenance',
  'input-manifest-schema-version': 'input manifest schema version does not match the evidence contract',
  'parameter-hash': 'strategy parameters and provenance disagree on parameter hash',
  'execution-model': 'simulation execution model does not match strategy parameters',
  'cost-multiplier': 'candidate simulation must use the base execution-cost multiplier',
  'protocol-hash': 'evaluation and provenance disagree on protocol hash',
  'source-revision': 'evaluation code revision does not match runtime provenance',
  'accounting-reconciliation': 'reconciliation does not exactly match the evaluation run',
  'input-manifest-hash': 'input manifest hash does not match its content',
  'run-identity': 'run ID does not match runtime and input provenance',
  'marked-equity-proof': 'independent marked-equity proof diverges from the evaluation evidence',
  'signal-decisions': 'strategy signal decisions diverge from durable decision events',
  'daily-series': 'candidate and benchmark daily series are not exactly aligned',
  'events-empty': 'evaluation produced no durable events',
  'gates-empty': 'evaluation produced no economic gate outcomes',
  'qualification-result': 'qualification result diverges from the locked evaluation',
  'protocol-reference': 'stored protocol lock diverges from the evaluated protocol',
  'receipt-cardinality': 'stored run receipt is missing or duplicated',
  'receipt-identity': 'stored run identity diverged from the evaluated runtime',
  'receipt-artifact-count': 'stored artifact count is incomplete',
  'receipt-event-count': 'stored event count is incomplete',
  'receipt-gate-count': 'stored gate count is incomplete',
  'receipt-artifact-content': 'stored artifact content diverged',
  'receipt-event-content': 'stored event content diverged',
  'receipt-gate-content': 'stored gate content diverged',
  'receipt-status-history': 'stored status history diverged',
} as const

export type PersistencePlanInvariant = keyof typeof persistencePlanInvariantMessages
export type PersistencePath = readonly [string, ...(number | string)[]]
export type PersistenceCanonicalizationOperation =
  | 'artifact-manifest-events'
  | 'artifact-manifest-gates'
  | 'artifact-payload'
  | 'benchmark-series'
  | 'equity-series'
  | 'event-payload'
  | 'execution-model'
  | 'gate-payload'
  | 'input-manifest'
  | 'marked-equity-reconciliation'
  | 'parameters'
  | 'qualification-prior-trials'
  | 'qualification-verdict'
  | 'signal-target-weights'
  | 'protocol-parameters'
  | 'stored-artifact'
  | 'stored-event'
  | 'stored-gate'
  | 'stored-status'

export type PersistencePlanFailure =
  | {
      readonly _tag: 'PersistenceMismatch'
      readonly invariant: PersistencePlanInvariant
      readonly path: PersistencePath
      readonly observed: unknown
      readonly expected: unknown
    }
  | {
      readonly _tag: 'PersistenceCanonicalizationFailed'
      readonly operation: PersistenceCanonicalizationOperation
      readonly subject?: string
      readonly cause: CanonicalJsonFailure
    }
  | {
      readonly _tag: 'PersistenceContractConstructionFailed'
      readonly operation: 'run-identity' | 'strategy-protocol'
      readonly cause: ContractConstructionFailure
    }
  | {
      readonly _tag: 'PersistenceQualificationInvalid'
      readonly cause: QualificationDecisionFailure
    }
  | {
      readonly _tag: 'PersistenceQualificationResultInvalid'
      readonly cause: Schema.SchemaError
    }
  | {
      readonly _tag: 'SimulationReconciliationFailed'
      readonly issues: readonly SimulationReconciliationIssue[]
    }

export interface ValidatedPersistenceEvaluation {
  readonly protocolHash: string
  readonly snapshotId: string
}

export interface PersistenceEvidenceMaterial {
  readonly baseArtifacts: readonly PersistenceArtifact[]
  readonly events: PersistencePlan['events']
  readonly gates: PersistencePlan['gates']
}

export interface StoredProtocolReference {
  readonly protocol_hash: string
  readonly schema_version: string
  readonly strategy_name: string
  readonly behavior_hash: string
  readonly parameter_hash: string
  readonly parameters: Protocol
}

export interface StoredReceiptReference {
  readonly run_id: string
  readonly protocol_hash: string
  readonly snapshot_id: string
  readonly evaluation_schema_version: string
  readonly source_revision: string
  readonly image_repository: string
  readonly image_digest: string
  readonly strategy_name: string
  readonly initial_capital_micros: string
  readonly expected_artifact_count: number
  readonly expected_event_count: number
  readonly expected_gate_count: number
  readonly artifact_count: number
  readonly event_count: number
  readonly gate_count: number
}

export interface StoredArtifactReference {
  readonly artifact_name: string
  readonly schema_version: string
  readonly content_hash: string
  readonly payload: unknown
}

export interface StoredEventReference {
  readonly ordinal: number
  readonly event_id: string
  readonly event_kind: EvaluationEvent['kind']
  readonly content_hash: string
  readonly payload: EvaluationEvent
}

export interface StoredGateReference {
  readonly ordinal: number
  readonly gate_name: string
  readonly passed: boolean
  readonly actual: number | boolean | string
  readonly required: number | boolean | string
  readonly content_hash: string
}

export type StoredStatusReference =
  | {
      readonly status: 'WRITING'
      readonly detail: { readonly artifactCount: number; readonly eventCount: number; readonly gateCount: number }
    }
  | {
      readonly status: 'COMPLETE'
      readonly detail: { readonly reconciliationExact: true; readonly verdict: 'PASS' | 'FAIL_CLOSED' }
    }

export interface StoredPersistenceReferences {
  readonly receipts: readonly StoredReceiptReference[]
  readonly artifacts: readonly StoredArtifactReference[]
  readonly events: readonly StoredEventReference[]
  readonly gates: readonly StoredGateReference[]
  readonly statuses: readonly StoredStatusReference[]
}
