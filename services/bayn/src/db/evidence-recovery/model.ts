import type { Schema } from 'effect'

import type { ContractConstructionFailure, FinalizedSnapshotProvenance, RuntimeProvenance } from '../../contracts'
import {
  CashChangesArtifactSchema,
  DailyPerformanceSeriesArtifactSchema,
  DailyPositionMarksArtifactSchema,
  EquitySeriesArtifactSchema,
  EvaluationEventsSchema,
  EvaluationSummarySchema,
  InputManifestArtifactSchema,
  MarkedEquityReconciliationSchema,
  QualificationArtifactManifestSchema,
  ReconciliationResultSchema,
  RiskBalancedTrendSignalDecisionsArtifactSchema,
  SimulatedOrdersArtifactSchema,
} from '../../evidence-contracts'
import type { CanonicalJsonFailure } from '../../hash'
import type { LedgerValidationError } from '../../ledger-plan'
import type { SimulationReconciliationIssue } from '../../simulation-reconciliation'
import type { EconomicVerdict, EvaluationEvent, EvaluationSummary, Protocol, ReconciliationResult } from '../../types'

export const evidenceRecoveryContract = {
  strategyName: 'risk-balanced-trend',
  evaluationSchemaVersion: 'bayn.evaluation.v6',
  summarySchemaVersion: 'bayn.evaluation-summary.v5',
  inputManifestSchemaVersion: 'bayn.input-manifest.v3',
  signalDecisionsArtifactName: 'risk-balanced-trend-decisions',
  signalDecisionsSchemaVersion: 'bayn.risk-balanced-trend-decisions.v1',
  artifacts: [
    { name: 'buy-and-hold', schemaVersion: 'bayn.performance-metrics.v2' },
    { name: 'buy-and-hold-series', schemaVersion: 'bayn.daily-performance-series.v1' },
    { name: 'cash-changes', schemaVersion: 'bayn.cash-changes.v2' },
    { name: 'daily-position-marks', schemaVersion: 'bayn.daily-position-marks.v3' },
    { name: 'direct-volatility-timing', schemaVersion: 'bayn.performance-metrics.v2' },
    { name: 'direct-volatility-timing-series', schemaVersion: 'bayn.daily-performance-series.v1' },
    { name: 'double-cost-strategy', schemaVersion: 'bayn.performance-metrics.v2' },
    { name: 'double-cost-strategy-series', schemaVersion: 'bayn.daily-performance-series.v1' },
    { name: 'equity-series', schemaVersion: 'bayn.equity-series.v1' },
    { name: 'evaluation-summary', schemaVersion: 'bayn.evaluation-summary.v5' },
    { name: 'input-manifest', schemaVersion: 'bayn.input-manifest.v3' },
    { name: 'marked-equity-reconciliation', schemaVersion: 'bayn.marked-equity-reconciliation.v2' },
    { name: 'qualification-artifact-manifest', schemaVersion: 'bayn.qualification-artifact-manifest.v1' },
    { name: 'reconciliation', schemaVersion: 'bayn.reconciliation.v1' },
    { name: 'risk-balanced-trend-decisions', schemaVersion: 'bayn.risk-balanced-trend-decisions.v1' },
    { name: 'simulated-orders', schemaVersion: 'bayn.simulated-orders.v2' },
    { name: 'strategy', schemaVersion: 'bayn.performance-metrics.v2' },
  ],
} as const

// Ledger identity changes record metadata, not the plan cardinality recovered here.
export const cardinalityOnlyLedger = 1

export interface PersistenceReceipt {
  readonly runId: string
  readonly deduplicated: boolean
  readonly artifactCount: number
  readonly eventCount: number
  readonly gateCount: number
}

export interface StoredEvaluationEvidence {
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
    readonly artifactCount: number
    readonly eventCount: number
    readonly gateCount: number
  }
  readonly artifacts: readonly StoredArtifact[]
  readonly events: readonly StoredEvent[]
  readonly gates: readonly StoredGate[]
  readonly statuses: readonly StoredStatus[]
}

export interface RecoveredEvaluationEvidence {
  readonly evaluation: EvaluationSummary
  readonly reconciliation: ReconciliationResult
  readonly persistence: PersistenceReceipt
}

export interface StoredReceiptRow {
  readonly run_id: string
  readonly protocol_hash: string
  readonly snapshot_id: string
  readonly evaluation_schema_version: string
  readonly source_revision: string
  readonly image_repository: string
  readonly image_digest: string
  readonly strategy_name: string
  readonly initial_capital_micros: string
  readonly status: 'COMPLETE'
  readonly expected_artifact_count: number
  readonly expected_event_count: number
  readonly expected_gate_count: number
  readonly artifact_count: number
  readonly event_count: number
  readonly gate_count: number
}

export interface StoredProtocolRow {
  readonly protocol_hash: string
  readonly schema_version: string
  readonly strategy_name: string
  readonly behavior_hash: string
  readonly parameter_hash: string
  readonly parameters: Protocol
}

export interface StoredArtifactRow {
  readonly artifact_name: string
  readonly schema_version: string
  readonly content_hash: string
  readonly payload: unknown
}

export interface StoredEventRow {
  readonly ordinal: number
  readonly event_id: string
  readonly event_kind: EvaluationEvent['kind']
  readonly content_hash: string
  readonly payload: EvaluationEvent
}

export interface StoredGateRow {
  readonly ordinal: number
  readonly gate_name: string
  readonly passed: boolean
  readonly actual: EconomicVerdict['gates'][number]['actual']
  readonly required: EconomicVerdict['gates'][number]['required']
  readonly content_hash: string
}

export type StoredStatus =
  | {
      readonly status: 'WRITING'
      readonly detail: { readonly artifactCount: number; readonly eventCount: number; readonly gateCount: number }
    }
  | {
      readonly status: 'COMPLETE'
      readonly detail: { readonly reconciliationExact: true; readonly verdict: 'PASS' | 'FAIL_CLOSED' }
    }

export interface StoredEvidenceRows {
  readonly receipts: readonly StoredReceiptRow[]
  readonly protocol: StoredProtocolRow
  readonly artifacts: readonly StoredArtifactRow[]
  readonly events: readonly StoredEventRow[]
  readonly gates: readonly StoredGateRow[]
  readonly statuses: readonly StoredStatus[]
}

export interface StoredSnapshotRow {
  readonly snapshot_id: string
  readonly schema_version: 'bayn.finalized-snapshot.v3'
  readonly database_name: 'signal'
  readonly table_name: 'adjusted_daily_bars_v2'
  readonly dataset_version: 'signal.adjusted-daily-snapshot.v2'
  readonly source: 'alpaca'
  readonly source_feed: 'sip'
  readonly adjustment: 'all'
  readonly content_hash: string
  readonly row_count: number
  readonly first_session: string
  readonly last_session: string
  readonly manifest: FinalizedSnapshotProvenance
}

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
  readonly actual: EconomicVerdict['gates'][number]['actual']
  readonly required: EconomicVerdict['gates'][number]['required']
  readonly contentHash: string
}

export type ArtifactSetProblem =
  | {
      readonly _tag: 'DuplicateArtifact'
      readonly name: string
      readonly observedCount: number
      readonly expectedCount: 1
    }
  | { readonly _tag: 'MissingArtifact'; readonly name: string; readonly expectedSchemaVersion: string }
  | { readonly _tag: 'ExtraArtifact'; readonly name: string; readonly observedSchemaVersion: string }
  | {
      readonly _tag: 'WrongArtifactSchema'
      readonly name: string
      readonly observedSchemaVersion: string
      readonly expectedSchemaVersion: string
    }

export type RecoveryCanonicalizationOperation =
  | 'artifact-manifest-expected'
  | 'artifact-manifest-observed'
  | 'evaluation-bounds'
  | 'evaluation-input-symbols'
  | 'evaluation-marked-equity'
  | 'evaluation-metric'
  | 'gate-outcome'
  | 'marked-equity-proof'
  | 'protocol-execution-model'
  | 'protocol-parameters'
  | 'recovered-equity-series'
  | 'runtime-protocol-hash'
  | 'signal-target-weights'
  | 'snapshot-manifest'
  | 'stored-artifact-payload'
  | 'stored-event-payload'
  | 'stored-gate-payload'
  | 'stored-protocol-parameters'
  | 'stored-writing-status'

export type RecoveryMismatchStage =
  | 'components'
  | 'contract'
  | 'manifest'
  | 'protocol'
  | 'reconciliation'
  | 'runtime'
  | 'snapshot'
  | 'status'
  | 'stored-graph'

export type RecoveryPath = readonly [string, ...(number | string)[]]

export type EvidenceRecoveryIssue =
  | {
      readonly _tag: 'RecoveryMismatch'
      readonly stage: RecoveryMismatchStage
      readonly path: RecoveryPath
      readonly observed: unknown
      readonly expected: unknown
    }
  | { readonly _tag: 'ArtifactSetFailure'; readonly problem: ArtifactSetProblem }
  | {
      readonly _tag: 'DecodeFailure'
      readonly artifactName: string
      readonly schemaVersion: string
      readonly cause: Schema.SchemaError
    }
  | {
      readonly _tag: 'CanonicalizationFailure'
      readonly operation: RecoveryCanonicalizationOperation
      readonly subject?: string
      readonly cause: CanonicalJsonFailure
    }
  | {
      readonly _tag: 'SimulationFailure'
      readonly issues: readonly SimulationReconciliationIssue[]
    }
  | {
      readonly _tag: 'ComputationFailure'
      readonly operation: 'build-ledger-plan'
      readonly cause: LedgerValidationError
    }
  | {
      readonly _tag: 'ContractConstructionFailure'
      readonly operation: 'runtime-protocol-hash'
      readonly cause: ContractConstructionFailure
    }

export interface ValidatedStoredGraph {
  readonly receipt: StoredReceiptRow
  readonly rows: StoredEvidenceRows
}

export type ArtifactIndex = ReadonlyMap<string, StoredArtifact>

export interface InitialDecodedArtifacts {
  readonly evaluation: typeof EvaluationSummarySchema.Type
  readonly reconciliation: typeof ReconciliationResultSchema.Type
  readonly markedEquity: typeof MarkedEquityReconciliationSchema.Type
  readonly equitySeries: typeof EquitySeriesArtifactSchema.Type
  readonly events: typeof EvaluationEventsSchema.Type
  readonly orders: typeof SimulatedOrdersArtifactSchema.Type
  readonly signalDecisions: typeof RiskBalancedTrendSignalDecisionsArtifactSchema.Type
  readonly buyAndHoldSeries: typeof DailyPerformanceSeriesArtifactSchema.Type
  readonly directVolatilitySeries: typeof DailyPerformanceSeriesArtifactSchema.Type
  readonly doubleCostSeries: typeof DailyPerformanceSeriesArtifactSchema.Type
  readonly artifactManifest: typeof QualificationArtifactManifestSchema.Type
}

export interface RemainingDecodedArtifacts {
  readonly cashChanges: typeof CashChangesArtifactSchema.Type
  readonly dailyMarks: typeof DailyPositionMarksArtifactSchema.Type
  readonly inputManifest: typeof InputManifestArtifactSchema.Type
}

export interface PreparedEvidenceRecovery {
  readonly runId: string
  readonly provenance: RuntimeProvenance
  readonly stored: StoredEvaluationEvidence
  readonly artifacts: ArtifactIndex
  readonly decoded: InitialDecodedArtifacts & RemainingDecodedArtifacts
}
