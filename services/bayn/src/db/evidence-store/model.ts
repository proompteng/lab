import { Context, Effect, Option, Schema } from 'effect'

import type { RuntimeProvenance } from '../../contracts'
import type { QualificationLock, QualificationResult } from '../../qualification'
import type { EvaluationResult, InputManifest, Protocol, ReconciliationResult } from '../../types'
import type { PersistenceReceipt, RecoveredEvaluationEvidence, StoredEvaluationEvidence } from '../evidence-recovery'
import type { DatabaseError } from './error-contract'

export interface PersistEvaluationInput {
  readonly provenance: RuntimeProvenance
  readonly parameters: Protocol
  readonly evaluation: EvaluationResult
  readonly reconciliation: ReconciliationResult
  readonly qualification?: {
    readonly lock: QualificationLock
    readonly result: QualificationResult
  }
}

export type QualificationRecord =
  | { readonly state: 'OPENED_INCOMPLETE'; readonly lock: QualificationLock }
  | { readonly state: 'TERMINAL'; readonly lock: QualificationLock; readonly result: QualificationResult }

export type QualificationOpen = { readonly state: 'ACQUIRED'; readonly lock: QualificationLock } | QualificationRecord

export interface OpenQualificationInput {
  readonly lock: QualificationLock
  readonly inputManifest: InputManifest
  readonly parameters: Protocol
  readonly provenance: RuntimeProvenance
}

export interface ArtifactItemPage {
  readonly runId: string
  readonly artifactName: string
  readonly schemaVersion: string
  readonly contentHash: string
  readonly itemCount: number
  readonly items: readonly { readonly ordinal: number; readonly payload: Schema.Json }[]
  readonly nextAfterOrdinal: number | null
}

export interface EvidenceStoreService {
  readonly check: Effect.Effect<void, DatabaseError>
  readonly persist: (input: PersistEvaluationInput) => Effect.Effect<PersistenceReceipt, DatabaseError>
  readonly read: (runId: string) => Effect.Effect<Option.Option<StoredEvaluationEvidence>, DatabaseError>
  readonly readArtifactItems: (input: {
    readonly runId: string
    readonly artifactName: string
    readonly afterOrdinal?: number
    readonly limit: number
  }) => Effect.Effect<Option.Option<ArtifactItemPage>, DatabaseError>
  readonly recover: (
    runId: string,
    provenance: RuntimeProvenance,
  ) => Effect.Effect<Option.Option<RecoveredEvaluationEvidence>, DatabaseError>
  readonly listPriorTrials: Effect.Effect<readonly string[], DatabaseError>
  readonly openQualification: (input: OpenQualificationInput) => Effect.Effect<QualificationOpen, DatabaseError>
  readonly readQualification: (
    candidateRunId: string,
  ) => Effect.Effect<Option.Option<QualificationRecord>, DatabaseError>
}

export class EvidenceStore extends Context.Service<EvidenceStore, EvidenceStoreService>()(
  '@proompteng/bayn/db/evidence-store/model/EvidenceStore',
) {}
