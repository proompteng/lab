import { Result } from 'effect'

import type {
  CandidateDevelopmentNextPreregistration,
  CandidateDevelopmentTrialHistory,
  CandidateDevelopmentTrialState,
  CandidateDevelopmentTrialStateIssue,
} from './model'
import type { CandidateDevelopmentTrialLedgerState } from './ledger'
import { buildCandidateDevelopmentTrialState } from './lineage'
import { validateCandidateDevelopmentTrialState } from './validation'

export type QualificationDormancyDecision =
  | {
      readonly status: 'dormant'
      readonly reason: 'preregistration-missing'
      readonly candidateOrdinal: null
    }
  | {
      readonly status: 'dormant'
      readonly reason: 'precommit-invalid-unattempted' | 'development-rejected' | 'development-not-approved'
      readonly candidateOrdinal: number
    }
  | {
      readonly status: 'dormant'
      readonly reason: 'qualification-attempt-consumed'
      readonly candidateOrdinal: number
    }
  | {
      readonly status: 'ready'
      readonly reason: 'qualification-eligible'
      readonly candidateOrdinal: number
      readonly preregistrationSourceRevision: string
      readonly preregistrationBlobOid: string
    }

export interface QualificationDormancyIssue {
  readonly path: string
  readonly reason:
    | 'MALFORMED_HISTORY'
    | 'UNSUPPORTED_SCHEMA'
    | 'INVALID_ORDINAL_LINEAGE'
    | 'INVALID_PREREGISTRATION'
    | 'INVALID_INVALIDATION'
    | 'AMBIGUOUS_SUCCESSOR'
    | 'INVALID_STATE'
}

export type QualificationDormancyResult =
  | { readonly ok: true; readonly decision: QualificationDormancyDecision }
  | { readonly ok: false; readonly issue: QualificationDormancyIssue }

const mapStateIssue = (issue: CandidateDevelopmentTrialStateIssue): QualificationDormancyIssue => ({
  path: issue.path,
  reason:
    issue.reason === 'SCHEMA_VERSION_MISMATCH'
      ? 'UNSUPPORTED_SCHEMA'
      : issue.reason === 'ORDINAL_SEQUENCE_GAP' ||
          issue.reason === 'ORDINAL_OVERLAP' ||
          issue.reason === 'ORDINAL_REUSE' ||
          issue.reason === 'NEXT_ORDINAL_MISMATCH'
        ? 'INVALID_ORDINAL_LINEAGE'
        : issue.reason === 'INVALIDATION_NOT_IMMUTABLE' || issue.reason === 'INVALIDATION_BINDING_MISMATCH'
          ? 'INVALID_INVALIDATION'
          : issue.reason === 'SUCCESSOR_BINDING_MISMATCH' || issue.reason === 'SUCCESSOR_REQUIRED'
            ? 'AMBIGUOUS_SUCCESSOR'
            : issue.reason === 'MALFORMED_HISTORY'
              ? 'MALFORMED_HISTORY'
              : 'INVALID_STATE',
})

const decisionFromState = (state: CandidateDevelopmentTrialState): QualificationDormancyDecision => {
  const active = state.activeTrial
  if (active === null) {
    const lastClosed = state.closedTrials.at(-1)
    if (lastClosed?._tag === 'PRECOMMIT_INVALIDATED') {
      return {
        status: 'dormant',
        reason: 'precommit-invalid-unattempted',
        candidateOrdinal: lastClosed.candidateOrdinal,
      }
    }
    if (lastClosed?._tag === 'DEVELOPMENT_REJECTED') {
      return {
        status: 'dormant',
        reason: 'development-rejected',
        candidateOrdinal: lastClosed.candidateOrdinal,
      }
    }
    return { status: 'dormant', reason: 'preregistration-missing', candidateOrdinal: null }
  }
  switch (active._tag) {
    case 'DEVELOPMENT_PENDING':
    case 'DEVELOPMENT_OUTCOME_PENDING':
      return {
        status: 'dormant',
        reason: 'development-not-approved',
        candidateOrdinal: active.candidateOrdinal,
      }
    case 'QUALIFICATION_ELIGIBLE':
      return {
        status: 'ready',
        reason: 'qualification-eligible',
        candidateOrdinal: active.candidateOrdinal,
        preregistrationSourceRevision: active.preregistration.preregistration.sourceRevision,
        preregistrationBlobOid: active.preregistration.preregistration.blobOid,
      }
    case 'QUALIFICATION_ATTEMPTED':
      return {
        status: 'dormant',
        reason: 'qualification-attempt-consumed',
        candidateOrdinal: active.candidateOrdinal,
      }
  }
}

export const qualificationDormancyDecisionFromState = (
  state: CandidateDevelopmentTrialState,
): QualificationDormancyResult => {
  const validation = validateCandidateDevelopmentTrialState(state)
  return Result.isFailure(validation)
    ? { ok: false, issue: mapStateIssue(validation.failure) }
    : { ok: true, decision: decisionFromState(state) }
}

const invalidLedger = (path: string): QualificationDormancyResult => ({
  ok: false,
  issue: { path, reason: 'INVALID_STATE' },
})

/**
 * Qualification reads the append-only ledger, while the older history reducer remains available for immutable
 * archived evidence. Only a development approval entry can make the single active registration runnable.
 */
export const qualificationDormancyDecisionFromLedgerState = (
  state: CandidateDevelopmentTrialLedgerState,
): QualificationDormancyResult => {
  if (
    !Array.isArray(state.entries) ||
    !Array.isArray(state.completedCandidateOrdinals) ||
    !Array.isArray(state.developmentCandidateOrdinals)
  ) {
    return invalidLedger('ledger')
  }

  const active = state.activeCandidate
  if (active === null) {
    const last = state.entries.at(-1)
    if (state.latestInvalidPrecommit !== null) {
      return {
        ok: true,
        decision: {
          status: 'dormant',
          reason: 'precommit-invalid-unattempted',
          candidateOrdinal: state.latestInvalidPrecommit.candidateOrdinal,
        },
      }
    }
    if (last?._tag === 'DEVELOPMENT_REJECTED') {
      return {
        ok: true,
        decision: { status: 'dormant', reason: 'development-rejected', candidateOrdinal: last.candidateOrdinal },
      }
    }
    return { ok: true, decision: { status: 'dormant', reason: 'preregistration-missing', candidateOrdinal: null } }
  }

  const candidateOrdinal = active.preregistration.candidateOrdinal
  const candidateEntries = state.entries.filter((entry) => entry.candidateOrdinal === candidateOrdinal)
  if (candidateOrdinal !== active.preregistration.priorTrialCount + 1) {
    return invalidLedger('activeCandidate.preregistration.candidateOrdinal')
  }
  const approvals = candidateEntries.filter((entry) => entry._tag === 'DEVELOPMENT_APPROVED')
  if (approvals.length > 1) return invalidLedger('entries.DEVELOPMENT_APPROVED')
  const approval = approvals[0]
  if (
    approval !== undefined &&
    (approval.priorTrialCount !== active.preregistration.priorTrialCount ||
      approval.sourceRevision !== active.preregistration.preregistration.sourceRevision)
  ) {
    return invalidLedger('entries.DEVELOPMENT_APPROVED.binding')
  }
  if (candidateEntries.some((entry) => entry._tag === 'QUALIFICATION_TERMINAL')) {
    return {
      ok: true,
      decision: { status: 'dormant', reason: 'qualification-attempt-consumed', candidateOrdinal },
    }
  }
  if (candidateEntries.some((entry) => entry._tag === 'DEVELOPMENT_REJECTED')) {
    return {
      ok: true,
      decision: { status: 'dormant', reason: 'development-rejected', candidateOrdinal },
    }
  }
  if (approval === undefined) {
    return { ok: true, decision: { status: 'dormant', reason: 'development-not-approved', candidateOrdinal } }
  }
  return {
    ok: true,
    decision: {
      status: 'ready',
      reason: 'qualification-eligible',
      candidateOrdinal,
      preregistrationSourceRevision: active.preregistration.preregistration.sourceRevision,
      preregistrationBlobOid: active.preregistration.preregistration.blobOid,
    },
  }
}

export const decideQualificationDormancy = (value: unknown): QualificationDormancyResult => {
  const state = buildCandidateDevelopmentTrialState(value as CandidateDevelopmentTrialHistory)
  return Result.isFailure(state)
    ? { ok: false, issue: mapStateIssue(state.failure) }
    : qualificationDormancyDecisionFromState(state.success)
}

export const qualificationDormancyDecisionFromHistory = (
  history: CandidateDevelopmentTrialHistory,
): QualificationDormancyResult => decideQualificationDormancy(history)

export type { CandidateDevelopmentNextPreregistration }
