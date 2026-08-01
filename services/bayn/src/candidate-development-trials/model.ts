export interface CandidateDevelopmentNextPreregistration {
  readonly schemaVersion: 'bayn.candidate-development-next-preregistration.v1'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly strategyProtocolHash: string
  readonly strategyIdentityHash?: string
  readonly candidateDevelopmentProtocolHash?: string
  readonly calendarHash?: string
  readonly priorTrialsHash?: string
  readonly modulePath: string
  readonly moduleSha256: string
  readonly marketData: {
    readonly schemaVersion: 'bayn.candidate-development-market-data-source.v1'
    readonly snapshotId: string
    readonly finalizedSnapshotContentHash: string
    readonly inputManifestHash: string
    readonly boundedContentHash: string
  }
  readonly preregistration: {
    readonly sourceRevision: string
    readonly path: string
    readonly blobOid: string
  }
}

export interface CandidateDevelopmentQualificationEvidence {
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly terminalStatus: 'HOLD_REJECT'
  readonly sourceRevision: string
}

export interface CandidateDevelopmentQualificationPreregistration {
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly sourceRevision: string
  readonly path: string
  readonly blobOid: string
}

export interface CandidateDevelopmentPriorDevelopmentEvidence {
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly status: 'DEVELOPMENT_REJECTED'
  readonly evidenceContentHash: string
  readonly qualificationAttemptConsumed: false
}

export interface CandidateDevelopmentInvalidPrecommit {
  readonly schemaVersion: 'bayn.candidate-development-precommit-invalidation.v1'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly status: 'PRECOMMIT_INVALID'
  readonly attemptStatus: 'UNATTEMPTED'
  readonly metricBearingAttemptsConsumed: 0
  readonly qualificationAttemptConsumed: false
  readonly reviewedHeadRevision: string
  readonly mergedSourceRevision: string
  readonly preregistration: {
    readonly sourceRevision: string
    readonly path: string
    readonly blobOid: string
    readonly sha256: string
  }
  readonly sourceManifest: {
    readonly path: string
    readonly blobOid: string
    readonly sha256: string
  }
  readonly invalidatedModule: {
    readonly path: string
    readonly blobOid: string
    readonly sha256: string
    readonly lineCount: number
    readonly byteCount: number
    readonly findings: readonly [
      'TYPE_CHECK_DISABLED',
      'DOWNCOMPILED_BUNDLE',
      'EMBEDDED_OFFICIAL_SESSIONS',
      'EMBEDDED_MARKET_BARS',
      'RUNTIME_INPUT_IGNORED',
    ]
  }
  readonly naturalBuild: {
    readonly runId: string
    readonly imagePublished: true
    readonly imageDigest: `sha256:${string}`
    readonly deploymentAllowed: false
  }
  readonly release: {
    readonly runId: string
    readonly conclusion: 'CANCELLED'
    readonly promotionCompleted: false
    readonly rerunAllowed: false
  }
  readonly nextCandidatePreregistration: null
}

export interface CandidateDevelopmentLegacyPriorTrialsMaterial {
  readonly schemaVersion: 'bayn.candidate-development-prior-trials.v1'
  readonly qualificationCandidateOrdinals: readonly number[]
  readonly developmentCandidateOrdinals: readonly number[]
  readonly latestDevelopmentEvidence: CandidateDevelopmentPriorDevelopmentEvidence
  readonly latestReviewedPreregistration: CandidateDevelopmentNextPreregistration
}

export interface CandidateDevelopmentPriorTrialsMaterial {
  readonly schemaVersion: 'bayn.candidate-development-prior-trials.v2'
  readonly qualificationCandidateOrdinals: readonly number[]
  readonly latestQualificationEvidence: CandidateDevelopmentQualificationEvidence
  readonly latestQualificationPreregistration: CandidateDevelopmentQualificationPreregistration
  readonly developmentCandidateOrdinals: readonly number[]
  readonly latestDevelopmentEvidence: CandidateDevelopmentPriorDevelopmentEvidence
  readonly latestReviewedPreregistration: CandidateDevelopmentNextPreregistration
}

/** The v2 history remains the wire-compatible facade consumed by Bayn. */
export interface CandidateDevelopmentTrialHistory {
  readonly schemaVersion: 'bayn.candidate-development-trial-history.v2'
  readonly completedCandidateOrdinals: readonly number[]
  readonly developmentCandidateOrdinals: readonly number[]
  readonly latestReviewedCandidateLegacyPriorTrials: CandidateDevelopmentLegacyPriorTrialsMaterial
  readonly latestReviewedCandidatePriorTrials: CandidateDevelopmentPriorTrialsMaterial
  readonly latestTerminalEvidence: CandidateDevelopmentQualificationEvidence
  readonly candidatePreregistration: CandidateDevelopmentQualificationPreregistration
  readonly latestReviewedCandidatePreregistration: CandidateDevelopmentNextPreregistration
  readonly latestDevelopmentEvidence: {
    readonly candidateOrdinal: number
    readonly priorTrialCount: number
    readonly status: 'DEVELOPMENT_REJECTED'
    readonly evidenceContentHash: string
    readonly evaluatedSourceRevision: string
    readonly reviewedSourceRevision?: string
    readonly mergedSourceRevision?: string
    readonly failureStage?: 'buildEvaluation-preflight' | 'development-evaluation'
    readonly developmentMetricsObserved?: boolean
    readonly qualificationAttemptConsumed: false
  }
  readonly latestInvalidPrecommit: CandidateDevelopmentInvalidPrecommit | null
  readonly nextCandidatePreregistration: CandidateDevelopmentNextPreregistration | null
}

export type CandidateDevelopmentAttemptConsumption =
  | {
      readonly _tag: 'UNATTEMPTED'
      readonly attemptCount: 0
      readonly metricBearingAttemptsConsumed: 0
      readonly qualificationAttemptConsumed: false
    }
  | {
      readonly _tag: 'DEVELOPMENT_ONLY_ATTEMPT'
      readonly attemptCount: 1
      readonly metricBearingAttemptsConsumed: 0 | 1
      readonly qualificationAttemptConsumed: false
    }
  | {
      readonly _tag: 'QUALIFICATION_ATTEMPT'
      readonly attemptCount: 1
      readonly metricBearingAttemptsConsumed: 1
      readonly qualificationAttemptConsumed: true
    }

export type CandidateDevelopmentSuccessorKind = 'DEVELOPMENT_ONLY' | 'QUALIFICATION'

export interface CandidateDevelopmentHistoricalQualificationTrial {
  readonly _tag: 'HISTORICAL_QUALIFICATION'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly terminalStatus: 'HOLD_REJECT'
  readonly sourceRevision: string | null
  readonly attempt: Extract<CandidateDevelopmentAttemptConsumption, { readonly _tag: 'QUALIFICATION_ATTEMPT' }>
}

export interface CandidateDevelopmentDevelopmentOnlyTrial {
  readonly _tag: 'DEVELOPMENT_ONLY'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly status: 'DEVELOPMENT_REJECTED'
  readonly evidenceContentHash: string | null
  readonly evaluatedSourceRevision: string | null
  readonly failureStage: 'buildEvaluation-preflight' | 'development-evaluation' | null
  readonly developmentMetricsObserved: boolean | null
  readonly attempt: Extract<CandidateDevelopmentAttemptConsumption, { readonly _tag: 'DEVELOPMENT_ONLY_ATTEMPT' }>
}

export interface CandidateDevelopmentCurrentSuccessor {
  readonly _tag: 'CURRENT_SUCCESSOR'
  readonly kind: CandidateDevelopmentSuccessorKind
  readonly preregistration: CandidateDevelopmentNextPreregistration
  readonly attempt: CandidateDevelopmentAttemptConsumption
}

export interface CandidateDevelopmentImmutableInvalidation {
  readonly _tag: 'IMMUTABLE_INVALIDATION'
  readonly invalidation: CandidateDevelopmentInvalidPrecommit
  readonly attempt: Extract<CandidateDevelopmentAttemptConsumption, { readonly _tag: 'UNATTEMPTED' }>
}

export interface CandidateDevelopmentTrialState {
  readonly schemaVersion: 'bayn.candidate-development-trial-state.v1'
  readonly historicalQualificationTrials: readonly CandidateDevelopmentHistoricalQualificationTrial[]
  readonly developmentOnlyTrials: readonly CandidateDevelopmentDevelopmentOnlyTrial[]
  readonly invalidatedPrecommits: readonly CandidateDevelopmentImmutableInvalidation[]
  readonly currentSuccessor: CandidateDevelopmentCurrentSuccessor | null
  readonly nextOrdinal: number
}

export interface CandidateDevelopmentDevelopmentTerminalEvidence {
  readonly evidenceContentHash: string
  readonly evaluatedSourceRevision?: string
  readonly failureStage?: 'buildEvaluation-preflight' | 'development-evaluation'
  readonly developmentMetricsObserved?: boolean
}

export interface CandidateDevelopmentQualificationTerminalEvidence {
  readonly terminalStatus: 'HOLD_REJECT'
  readonly sourceRevision: string
}

export type CandidateDevelopmentTrialTransition =
  | {
      readonly _tag: 'REVIEW_SUCCESSOR'
      readonly preregistration: CandidateDevelopmentNextPreregistration
      readonly kind?: CandidateDevelopmentSuccessorKind
    }
  | {
      readonly _tag: 'CONSUME_DEVELOPMENT_ATTEMPT'
      readonly metricBearing: boolean
    }
  | { readonly _tag: 'CONSUME_QUALIFICATION_ATTEMPT' }
  | {
      readonly _tag: 'TERMINALIZE_DEVELOPMENT_ONLY'
      readonly evidence: CandidateDevelopmentDevelopmentTerminalEvidence
    }
  | {
      readonly _tag: 'TERMINALIZE_QUALIFICATION'
      readonly evidence: CandidateDevelopmentQualificationTerminalEvidence
    }
  | {
      readonly _tag: 'INVALIDATE_PRECOMMIT'
      readonly invalidation: CandidateDevelopmentInvalidPrecommit
    }

export type CandidateDevelopmentTrialStateIssueReason =
  | 'MALFORMED_HISTORY'
  | 'SCHEMA_VERSION_MISMATCH'
  | 'ORDINAL_NOT_POSITIVE'
  | 'PRIOR_TRIAL_COUNT_MISMATCH'
  | 'ORDINAL_SEQUENCE_GAP'
  | 'ORDINAL_OVERLAP'
  | 'LATEST_EVIDENCE_MISMATCH'
  | 'INVALIDATION_NOT_IMMUTABLE'
  | 'INVALIDATION_BINDING_MISMATCH'
  | 'SUCCESSOR_BINDING_MISMATCH'
  | 'SUCCESSOR_REQUIRED'
  | 'SUCCESSOR_ALREADY_PRESENT'
  | 'ATTEMPT_ALREADY_CONSUMED'
  | 'ATTEMPT_KIND_MISMATCH'
  | 'TERMINAL_STATE_MISMATCH'
  | 'NEXT_ORDINAL_MISMATCH'

export interface CandidateDevelopmentTrialStateIssue {
  readonly _tag: 'CandidateDevelopmentTrialStateInvalid'
  readonly reason: CandidateDevelopmentTrialStateIssueReason
  readonly path: string
  readonly expected?: unknown
  readonly observed?: unknown
}

export type CandidateDevelopmentTrialTransitionDecision =
  | { readonly _tag: 'APPLIED'; readonly state: CandidateDevelopmentTrialState }
  | { readonly _tag: 'BLOCKED'; readonly issue: CandidateDevelopmentTrialStateIssue }

export type CandidateDevelopmentNextAction =
  | {
      readonly _tag: 'AWAIT_REVIEWED_PRECOMMIT'
      readonly candidateOrdinal: number
      readonly priorTrialCount: number
      readonly reason: 'NO_SUCCESSOR' | 'PRECOMMIT_INVALIDATED'
    }
  | {
      readonly _tag: 'CONSUME_DEVELOPMENT_ATTEMPT'
      readonly candidateOrdinal: number
      readonly preregistration: CandidateDevelopmentNextPreregistration
    }
  | {
      readonly _tag: 'TERMINALIZE_DEVELOPMENT_ONLY'
      readonly candidateOrdinal: number
      readonly preregistration: CandidateDevelopmentNextPreregistration
    }
  | {
      readonly _tag: 'CONSUME_QUALIFICATION_ATTEMPT'
      readonly candidateOrdinal: number
      readonly preregistration: CandidateDevelopmentNextPreregistration
    }
  | {
      readonly _tag: 'TERMINALIZE_QUALIFICATION'
      readonly candidateOrdinal: number
      readonly preregistration: CandidateDevelopmentNextPreregistration
    }
  | { readonly _tag: 'BLOCKED'; readonly issue: CandidateDevelopmentTrialStateIssue }
