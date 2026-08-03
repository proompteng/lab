import type { Option } from 'effect'

import type { RuntimeConfig } from '../config'
import type { RuntimeProvenance } from '../contracts'
import type {
  EvidenceStoreService,
  QualificationRecord,
  RecoveredEvaluationEvidence,
  StoredEvaluationEvidence,
} from '../db/evidence-store'
import type { CanonicalJsonFailure } from '../hash'
import type { JournalService } from '../ledger'
import type { MarketDataInspection, MarketDataService } from '../market-data'
import type { QualificationConstructionFailure, QualificationLock, QualificationResult } from '../qualification'
import type { QualificationStatisticsFailure } from '../qualification-statistics'
import type { RiskBalancedTrendEvaluationIssue } from '../risk-balanced-trend'
import type { RuntimeEvidence } from '../runtime-state'
import type { RiskBalancedTrendStrategyPrepareLockFailure } from '../strategy/risk-balanced-trend'
import type { StrategyRuntime } from '../strategy'
import type { EvaluationResult, ReconciliationResult } from '../types'

export type TerminalQualificationRecord = Extract<QualificationRecord, { readonly state: 'TERMINAL' }>

export interface StartupDependencies {
  readonly marketData: MarketDataService
  readonly journal: JournalService
  readonly evidenceStore: EvidenceStoreService
}

export interface EvaluationWorkflow {
  readonly config: RuntimeConfig
  readonly strategy: StrategyRuntime
  readonly dependencies: StartupDependencies
}

export interface CandidateQualification {
  readonly inspection: MarketDataInspection
  readonly lock: QualificationLock
}

export type QualificationPath =
  | { readonly _tag: 'EvaluateAcquired' }
  | {
      readonly _tag: 'RecoverTerminal'
      readonly runId: string
      readonly result: QualificationResult
    }

export interface EvaluationEvidence {
  readonly evaluation: EvaluationResult
  readonly reconciliation: ReconciliationResult
  readonly qualification: QualificationResult
}

export interface PinnedQualificationFacts {
  readonly stored: Option.Option<StoredEvaluationEvidence>
  readonly qualification: Option.Option<QualificationRecord>
}

export interface PinnedQualificationDecision {
  readonly _tag: 'RecoverPinned'
  readonly executionProvenance: RuntimeProvenance
  readonly qualification: TerminalQualificationRecord
}

export type StartupCompletion =
  | {
      readonly _tag: 'PinnedRecovered'
      readonly evidence: RuntimeEvidence
    }
  | {
      readonly _tag: 'TerminalRecovered'
      readonly evidence: RuntimeEvidence
    }
  | {
      readonly _tag: 'Evaluated'
      readonly evidence: RuntimeEvidence
      readonly markedEquityDifferenceMicros: string
    }

export type StartupCanonicalizationContext =
  | { readonly target: 'stored-protocol-parameters'; readonly side: 'stored' }
  | { readonly target: 'qualification-lock'; readonly side: 'expected' | 'observed' }
  | { readonly target: 'pinned-lock'; readonly side: 'lock' | 'runtime' }
  | { readonly target: 'pinned-snapshot'; readonly side: 'lock' | 'configured' }
  | { readonly target: 'pinned-verdict' | 'terminal-verdict'; readonly side: 'qualification' | 'recovered' }
  | { readonly target: 'locked-manifest'; readonly side: 'inspection' | 'loaded' }

export type StartupCanonicalizationFailure = StartupCanonicalizationContext & { readonly cause: CanonicalJsonFailure }
export type StartupCanonicalizationInput = readonly [context: StartupCanonicalizationContext, value: unknown]

export type StartupQualificationFailure =
  | {
      readonly reason: 'evidence-missing'
      readonly phase: 'read-pinned' | 'recover-pinned' | 'recover-terminal'
      readonly runId: string
    }
  | {
      readonly reason: 'pinned-not-terminal'
      readonly runId: string
      readonly observedState: 'MISSING' | 'OPENED_INCOMPLETE'
    }
  | { readonly reason: 'opened-incomplete'; readonly lockId: string }

export type StartupBindingMismatch =
  | {
      readonly binding: 'qualification-lock'
      readonly expected: QualificationLock
      readonly observed: QualificationLock
    }
  | {
      readonly binding: 'pinned-run'
      readonly expectedRunId: string
      readonly storedRunId: string
      readonly qualificationRunId: string
    }
  | {
      readonly binding: 'pinned-lock'
      readonly expected: {
        readonly candidateRunId: string
        readonly protocolHash: string
        readonly sourceRevision: string
        readonly image: RuntimeProvenance['image']
      }
      readonly observed: {
        readonly candidateRunId: string
        readonly protocolHash: string
        readonly sourceRevision: string
        readonly image: RuntimeProvenance['image']
      }
    }
  | {
      readonly binding: 'pinned-snapshot'
      readonly expected: {
        readonly snapshotId: string
        readonly lastSession: string
        readonly calendarVersion: string
        readonly bounds: RuntimeConfig['clickhouse']['bounds']
      }
      readonly observed: {
        readonly snapshotId: string
        readonly lastSession: string
        readonly calendarVersion: string
        readonly bounds: QualificationLock['data']['bounds']
      }
    }
  | {
      readonly binding: 'recovery'
      readonly phase: 'pinned' | 'terminal'
      readonly expectedRunId: string
      readonly recoveredRunIds: {
        readonly evaluation: string
        readonly reconciliation: string
        readonly persistence: string
      }
      readonly expectedVerdict: QualificationResult['evaluationVerdict']
      readonly recoveredVerdict: RecoveredEvaluationEvidence['evaluation']['verdict']
    }
  | {
      readonly binding: 'terminal-run'
      readonly terminalRunId: string
      readonly qualificationRunId: string
    }
  | {
      readonly binding: 'locked-manifest'
      readonly inspectedManifestHash: string
      readonly loadedManifestHash: string
    }
  | {
      readonly binding: 'evaluation-run'
      readonly lockedRunId: string
      readonly evaluationRunId: string
    }

export type StartupDecisionFailure =
  | {
      readonly _tag: 'StoredProvenanceInvalid'
      readonly identity: {
        readonly runId: string
        readonly strategyName: string
        readonly schemaVersion: string
      }
      readonly issue:
        | { readonly reason: 'unsupported-contract' }
        | { readonly reason: 'malformed'; readonly cause: unknown }
        | {
            readonly reason: 'protocol-mismatch'
            readonly stored: {
              readonly parameterHash: string
              readonly protocolHash: string
              readonly runProtocolHash: string
            }
            readonly computed: { readonly parameterHash: string; readonly protocolHash: string }
          }
    }
  | {
      readonly _tag: 'CanonicalizationFailed'
      readonly details: StartupCanonicalizationFailure
    }
  | {
      readonly _tag: 'QualificationStateInvalid'
      readonly details: StartupQualificationFailure
    }
  | {
      readonly _tag: 'BindingMismatch'
      readonly details: StartupBindingMismatch
    }
  | {
      readonly _tag: 'StrategyOperationFailed'
      readonly operation: 'evaluate'
      readonly strategyName: string
      readonly cause: readonly RiskBalancedTrendEvaluationIssue[]
    }
  | {
      readonly _tag: 'StrategyOperationFailed'
      readonly operation: 'prepare-lock'
      readonly strategyName: string
      readonly cause: RiskBalancedTrendStrategyPrepareLockFailure
    }
  | {
      readonly _tag: 'StrategyOperationFailed'
      readonly operation: 'analyze'
      readonly strategyName: string
      readonly cause: QualificationStatisticsFailure
    }
  | {
      readonly _tag: 'StrategyOperationFailed'
      readonly operation: 'qualify'
      readonly strategyName: string
      readonly cause: QualificationConstructionFailure
    }
