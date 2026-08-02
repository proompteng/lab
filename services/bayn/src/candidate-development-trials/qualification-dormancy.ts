import { Result } from 'effect'

import type {
  CandidateDevelopmentNextPreregistration,
  CandidateDevelopmentTrialHistory,
  CandidateDevelopmentTrialState,
  CandidateDevelopmentTrialStateIssue,
} from './model'
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
