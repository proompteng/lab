import { Schema } from 'effect'

import {
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  SourceRevisionSchema,
  StrictNonEmptyStringSchema,
} from '../schemas'

const CandidateDevelopmentNextPreregistrationFields = {
  schemaVersion: Schema.Literal('bayn.candidate-development-next-preregistration.v1'),
  candidateOrdinal: PositiveIntegerSchema,
  priorTrialCount: NonNegativeIntegerSchema,
  strategyProtocolHash: Sha256Schema,
  strategyIdentityHash: Schema.optionalKey(Sha256Schema),
  candidateDevelopmentProtocolHash: Schema.optionalKey(Sha256Schema),
  calendarHash: Schema.optionalKey(Sha256Schema),
  priorTrialsHash: Schema.optionalKey(Sha256Schema),
  modulePath: StrictNonEmptyStringSchema,
  moduleSha256: Sha256Schema,
  marketData: Schema.Struct({
    schemaVersion: Schema.Literal('bayn.candidate-development-market-data-source.v1'),
    snapshotId: Sha256Schema,
    finalizedSnapshotContentHash: Sha256Schema,
    inputManifestHash: Sha256Schema,
    boundedContentHash: Sha256Schema,
  }),
} as const

export const CandidateDevelopmentNextPreregistrationDocumentSchema = Schema.Struct(
  CandidateDevelopmentNextPreregistrationFields,
)

export const CandidateDevelopmentNextPreregistrationSchema = Schema.Struct({
  ...CandidateDevelopmentNextPreregistrationFields,
  preregistration: Schema.Struct({
    sourceRevision: SourceRevisionSchema,
    path: StrictNonEmptyStringSchema,
    blobOid: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  }),
})

export type CandidateDevelopmentNextPreregistration = typeof CandidateDevelopmentNextPreregistrationSchema.Type

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

/** The v2 history is a wire-compatible input facade; the trial state below is authoritative. */
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

/**
 * Retained only for existing type-only consumers of the old normalized facade. The lifecycle no longer uses a
 * successor kind or this attempt union as an authority.
 */
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
      readonly metricBearingAttemptsConsumed: 0 | 1 | null
      readonly qualificationAttemptConsumed: false
    }
  | {
      readonly _tag: 'QUALIFICATION_ATTEMPT'
      readonly attemptCount: 1
      readonly metricBearingAttemptsConsumed: 1
      readonly qualificationAttemptConsumed: true
    }

/** @deprecated The canonical lifecycle has no mutually exclusive successor kinds. */
export type CandidateDevelopmentSuccessorKind = 'DEVELOPMENT_ONLY' | 'QUALIFICATION'

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

export interface CandidateDevelopmentDevelopmentUnattempted {
  readonly _tag: 'DEVELOPMENT_UNATTEMPTED'
  readonly attemptCount: 0
}

export interface CandidateDevelopmentDevelopmentAttempted {
  readonly _tag: 'DEVELOPMENT_ATTEMPTED'
  readonly attemptCount: 1
  /** Historical records may not retain this observation; active attempts must. */
  readonly metricBearing: boolean | null
}

export type CandidateDevelopmentDevelopmentAttempt =
  | CandidateDevelopmentDevelopmentUnattempted
  | CandidateDevelopmentDevelopmentAttempted

export interface CandidateDevelopmentQualificationUnavailable {
  readonly _tag: 'QUALIFICATION_UNAVAILABLE'
  readonly attemptCount: 0
}

export interface CandidateDevelopmentQualificationUnattempted {
  readonly _tag: 'QUALIFICATION_UNATTEMPTED'
  readonly attemptCount: 0
}

export interface CandidateDevelopmentQualificationAttempted {
  readonly _tag: 'QUALIFICATION_ATTEMPTED'
  readonly attemptCount: 1
}

export type CandidateDevelopmentQualificationAttempt =
  | CandidateDevelopmentQualificationUnavailable
  | CandidateDevelopmentQualificationUnattempted
  | CandidateDevelopmentQualificationAttempted

export interface CandidateDevelopmentDevelopmentPendingTrial {
  readonly _tag: 'DEVELOPMENT_PENDING'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly preregistration: CandidateDevelopmentNextPreregistration
  readonly developmentAttempt: CandidateDevelopmentDevelopmentUnattempted
}

export interface CandidateDevelopmentDevelopmentOutcomePendingTrial {
  readonly _tag: 'DEVELOPMENT_OUTCOME_PENDING'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly preregistration: CandidateDevelopmentNextPreregistration
  readonly developmentAttempt: CandidateDevelopmentDevelopmentAttempted
}

export interface CandidateDevelopmentQualificationEligibleTrial {
  readonly _tag: 'QUALIFICATION_ELIGIBLE'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly preregistration: CandidateDevelopmentNextPreregistration
  readonly developmentAttempt: CandidateDevelopmentDevelopmentAttempted & { readonly metricBearing: boolean }
  readonly developmentEvidence: CandidateDevelopmentDevelopmentTerminalEvidence
  readonly qualificationAttempt: CandidateDevelopmentQualificationUnattempted
}

export interface CandidateDevelopmentQualificationAttemptedTrial {
  readonly _tag: 'QUALIFICATION_ATTEMPTED'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly preregistration: CandidateDevelopmentNextPreregistration
  readonly developmentAttempt: CandidateDevelopmentDevelopmentAttempted & { readonly metricBearing: boolean }
  readonly developmentEvidence: CandidateDevelopmentDevelopmentTerminalEvidence
  readonly qualificationAttempt: CandidateDevelopmentQualificationAttempted
}

export type CandidateDevelopmentActiveTrial =
  | CandidateDevelopmentDevelopmentPendingTrial
  | CandidateDevelopmentDevelopmentOutcomePendingTrial
  | CandidateDevelopmentQualificationEligibleTrial
  | CandidateDevelopmentQualificationAttemptedTrial

export interface CandidateDevelopmentPrecommitInvalidatedTrial {
  readonly _tag: 'PRECOMMIT_INVALIDATED'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly invalidation: CandidateDevelopmentInvalidPrecommit
}

export interface CandidateDevelopmentDevelopmentRejectedTrial {
  readonly _tag: 'DEVELOPMENT_REJECTED'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly preregistration: CandidateDevelopmentNextPreregistration | null
  readonly developmentAttempt: CandidateDevelopmentDevelopmentAttempted
  readonly developmentEvidence: CandidateDevelopmentDevelopmentTerminalEvidence | null
}

export interface CandidateDevelopmentQualificationCompletedTrial {
  readonly _tag: 'QUALIFICATION_TERMINAL'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly preregistration: CandidateDevelopmentNextPreregistration | null
  readonly developmentAttempt: CandidateDevelopmentDevelopmentAttempted
  readonly developmentEvidence: CandidateDevelopmentDevelopmentTerminalEvidence | null
  readonly qualificationAttempt: CandidateDevelopmentQualificationAttempted
  readonly terminalEvidence: CandidateDevelopmentQualificationTerminalEvidence | null
}

export type CandidateDevelopmentClosedTrial =
  | CandidateDevelopmentPrecommitInvalidatedTrial
  | CandidateDevelopmentDevelopmentRejectedTrial
  | CandidateDevelopmentQualificationCompletedTrial

export type CandidateDevelopmentLifecycle = CandidateDevelopmentClosedTrial | CandidateDevelopmentActiveTrial

export interface CandidateDevelopmentTrialState {
  readonly schemaVersion: 'bayn.candidate-development-trial-state.v1'
  readonly closedTrials: readonly CandidateDevelopmentClosedTrial[]
  readonly activeTrial: CandidateDevelopmentActiveTrial | null
  readonly nextOrdinal: number
}

/** @deprecated Existing type-only exports now point at the canonical lifecycle records. */
export type CandidateDevelopmentHistoricalQualificationTrial = CandidateDevelopmentQualificationCompletedTrial
/** @deprecated Existing type-only exports now point at the canonical lifecycle records. */
export type CandidateDevelopmentDevelopmentOnlyTrial = CandidateDevelopmentDevelopmentRejectedTrial
/** @deprecated Existing type-only exports now point at the canonical lifecycle records. */
export type CandidateDevelopmentImmutableInvalidation = CandidateDevelopmentPrecommitInvalidatedTrial
/** @deprecated Existing type-only exports now point at the canonical active lifecycle. */
export type CandidateDevelopmentCurrentSuccessor = CandidateDevelopmentActiveTrial

export type CandidateDevelopmentTrialTransition =
  | {
      readonly _tag: 'REVIEW_CANDIDATE'
      readonly preregistration: CandidateDevelopmentNextPreregistration
    }
  | {
      readonly _tag: 'CONSUME_DEVELOPMENT_ATTEMPT'
      readonly metricBearing: boolean
    }
  | {
      readonly _tag: 'REJECT_DEVELOPMENT'
      readonly evidence: CandidateDevelopmentDevelopmentTerminalEvidence
    }
  | {
      readonly _tag: 'APPROVE_FOR_QUALIFICATION'
      readonly evidence: CandidateDevelopmentDevelopmentTerminalEvidence
    }
  | { readonly _tag: 'CONSUME_QUALIFICATION_ATTEMPT' }
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
  | 'ORDINAL_REUSE'
  | 'LATEST_EVIDENCE_MISMATCH'
  | 'INVALIDATION_NOT_IMMUTABLE'
  | 'INVALIDATION_BINDING_MISMATCH'
  | 'SUCCESSOR_BINDING_MISMATCH'
  | 'SUCCESSOR_REQUIRED'
  | 'SUCCESSOR_ALREADY_PRESENT'
  | 'ATTEMPT_ALREADY_CONSUMED'
  | 'ATTEMPT_KIND_MISMATCH'
  | 'QUALIFICATION_NOT_ELIGIBLE'
  | 'DEVELOPMENT_OUTCOME_REQUIRED'
  | 'DEVELOPMENT_OUTCOME_MISMATCH'
  | 'TERMINAL_STATE_MISMATCH'
  | 'NEXT_ORDINAL_MISMATCH'

export interface CandidateDevelopmentTrialStateIssue {
  readonly _tag: 'CandidateDevelopmentTrialStateInvalid'
  readonly reason: CandidateDevelopmentTrialStateIssueReason
  readonly path: string
  readonly expected?: unknown
  readonly observed?: unknown
}

export type CandidateDevelopmentTrialStateDecision =
  | { readonly _tag: 'APPLIED'; readonly state: CandidateDevelopmentTrialState }
  | { readonly _tag: 'BLOCKED'; readonly issue: CandidateDevelopmentTrialStateIssue }

/** @deprecated Existing type-only exports retain the previous decision name. */
export type CandidateDevelopmentTrialTransitionDecision = CandidateDevelopmentTrialStateDecision

export type CandidateDevelopmentNextAction =
  | {
      readonly _tag: 'AWAIT_REVIEWED_PRECOMMIT'
      readonly candidateOrdinal: number
      readonly priorTrialCount: number
      readonly reason: 'NO_SUCCESSOR' | 'PRECOMMIT_INVALIDATED' | 'DEVELOPMENT_REJECTED'
    }
  | {
      readonly _tag: 'CONSUME_DEVELOPMENT_ATTEMPT'
      readonly candidateOrdinal: number
      readonly preregistration: CandidateDevelopmentNextPreregistration
    }
  | {
      readonly _tag: 'AWAIT_DEVELOPMENT_OUTCOME'
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
