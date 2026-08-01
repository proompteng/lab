import { Result } from 'effect'

import type {
  CandidateDevelopmentAttemptConsumption,
  CandidateDevelopmentCurrentSuccessor,
  CandidateDevelopmentDevelopmentOnlyTrial,
  CandidateDevelopmentHistoricalQualificationTrial,
  CandidateDevelopmentImmutableInvalidation,
  CandidateDevelopmentTrialState,
  CandidateDevelopmentTrialStateIssue,
  CandidateDevelopmentTrialTransition,
  CandidateDevelopmentTrialTransitionDecision,
} from './model'
import { cloneAndFreeze } from './lineage'
import {
  isRecord,
  stateIssue,
  validateCandidateDevelopmentTrialState,
  validateInvalidation,
  validateNextPreregistration,
} from './validation'

type ReviewSuccessorTransition = Extract<CandidateDevelopmentTrialTransition, { readonly _tag: 'REVIEW_SUCCESSOR' }>
type InvalidatePrecommitTransition = Extract<
  CandidateDevelopmentTrialTransition,
  { readonly _tag: 'INVALIDATE_PRECOMMIT' }
>
type TerminalizeDevelopmentTransition = Extract<
  CandidateDevelopmentTrialTransition,
  { readonly _tag: 'TERMINALIZE_DEVELOPMENT_ONLY' }
>
type TerminalizeQualificationTransition = Extract<
  CandidateDevelopmentTrialTransition,
  { readonly _tag: 'TERMINALIZE_QUALIFICATION' }
>

const unattempted: Extract<CandidateDevelopmentAttemptConsumption, { readonly _tag: 'UNATTEMPTED' }> = Object.freeze({
  _tag: 'UNATTEMPTED',
  attemptCount: 0,
  metricBearingAttemptsConsumed: 0,
  qualificationAttemptConsumed: false,
})

const applied = (state: CandidateDevelopmentTrialState): CandidateDevelopmentTrialTransitionDecision => ({
  _tag: 'APPLIED',
  state,
})

const blocked = (issue: CandidateDevelopmentTrialStateIssue): CandidateDevelopmentTrialTransitionDecision => ({
  _tag: 'BLOCKED',
  issue,
})

const isIssue = (
  value: CandidateDevelopmentCurrentSuccessor | CandidateDevelopmentTrialStateIssue,
): value is CandidateDevelopmentTrialStateIssue => value._tag === 'CandidateDevelopmentTrialStateInvalid'

const requireSuccessor = (
  state: CandidateDevelopmentTrialState,
): CandidateDevelopmentCurrentSuccessor | CandidateDevelopmentTrialStateIssue =>
  state.currentSuccessor ?? stateIssue('state.currentSuccessor', 'SUCCESSOR_REQUIRED')

const requireUnattemptedSuccessor = (
  state: CandidateDevelopmentTrialState,
): CandidateDevelopmentCurrentSuccessor | CandidateDevelopmentTrialStateIssue => {
  const successor = requireSuccessor(state)
  if (isIssue(successor)) return successor
  return successor.attempt._tag === 'UNATTEMPTED'
    ? successor
    : stateIssue('state.currentSuccessor.attempt', 'ATTEMPT_ALREADY_CONSUMED', successor.attempt)
}

const reviewSuccessor = (
  state: CandidateDevelopmentTrialState,
  preregistration: ReviewSuccessorTransition['preregistration'],
): CandidateDevelopmentTrialTransitionDecision => {
  if (state.currentSuccessor !== null) {
    return blocked(stateIssue('state.currentSuccessor', 'SUCCESSOR_ALREADY_PRESENT', state.currentSuccessor))
  }
  const preregistrationIssue = validateNextPreregistration(preregistration, 'transition.preregistration')
  if (preregistrationIssue !== undefined) return blocked(preregistrationIssue)
  if (
    preregistration.candidateOrdinal !== state.nextOrdinal ||
    preregistration.priorTrialCount !== state.nextOrdinal - 1
  ) {
    return blocked(
      stateIssue('transition.preregistration', 'NEXT_ORDINAL_MISMATCH', preregistration, {
        candidateOrdinal: state.nextOrdinal,
        priorTrialCount: state.nextOrdinal - 1,
      }),
    )
  }
  const successor: CandidateDevelopmentCurrentSuccessor = {
    _tag: 'CURRENT_SUCCESSOR',
    preregistration: cloneAndFreeze(preregistration),
    attempt: unattempted,
  }
  return applied({ ...state, currentSuccessor: cloneAndFreeze(successor) })
}

const consumeAttempt = (
  state: CandidateDevelopmentTrialState,
  attempt: Exclude<CandidateDevelopmentAttemptConsumption, { readonly _tag: 'UNATTEMPTED' }>,
): CandidateDevelopmentTrialTransitionDecision => {
  const successor = requireUnattemptedSuccessor(state)
  if (isIssue(successor)) return blocked(successor)
  return applied({
    ...state,
    currentSuccessor: cloneAndFreeze({ ...successor, attempt }),
  })
}

const matchesInvalidationBinding = (
  successor: CandidateDevelopmentCurrentSuccessor,
  invalidation: InvalidatePrecommitTransition['invalidation'],
): boolean =>
  invalidation.candidateOrdinal === successor.preregistration.candidateOrdinal &&
  invalidation.priorTrialCount === successor.preregistration.priorTrialCount &&
  invalidation.invalidatedModule.path === successor.preregistration.modulePath &&
  invalidation.invalidatedModule.sha256 === successor.preregistration.moduleSha256 &&
  invalidation.preregistration.sourceRevision === successor.preregistration.preregistration.sourceRevision &&
  invalidation.preregistration.path === successor.preregistration.preregistration.path &&
  invalidation.preregistration.blobOid === successor.preregistration.preregistration.blobOid

const invalidateSuccessor = (
  state: CandidateDevelopmentTrialState,
  invalidation: InvalidatePrecommitTransition['invalidation'],
): CandidateDevelopmentTrialTransitionDecision => {
  const successor = requireUnattemptedSuccessor(state)
  if (isIssue(successor)) return blocked(successor)
  const invalidationIssue = validateInvalidation(invalidation, 'transition.invalidation')
  if (invalidationIssue !== undefined) return blocked(invalidationIssue)
  if (!matchesInvalidationBinding(successor, invalidation)) {
    return blocked(
      stateIssue('transition.invalidation', 'INVALIDATION_BINDING_MISMATCH', invalidation, successor.preregistration),
    )
  }
  const invalidated: CandidateDevelopmentImmutableInvalidation = {
    _tag: 'IMMUTABLE_INVALIDATION',
    invalidation: cloneAndFreeze(invalidation),
    attempt: unattempted,
  }
  return applied({
    ...state,
    invalidatedPrecommits: [...state.invalidatedPrecommits, cloneAndFreeze(invalidated)],
    currentSuccessor: null,
    nextOrdinal: invalidation.candidateOrdinal + 1,
  })
}

const terminalizeDevelopmentOnly = (
  state: CandidateDevelopmentTrialState,
  evidence: TerminalizeDevelopmentTransition['evidence'],
): CandidateDevelopmentTrialTransitionDecision => {
  const successor = requireSuccessor(state)
  if (isIssue(successor)) return blocked(successor)
  if (successor.attempt._tag !== 'DEVELOPMENT_ONLY_ATTEMPT') {
    return blocked(
      stateIssue(
        'state.currentSuccessor.attempt',
        'ATTEMPT_KIND_MISMATCH',
        successor.attempt,
        'DEVELOPMENT_ONLY_ATTEMPT',
      ),
    )
  }
  const trial: CandidateDevelopmentDevelopmentOnlyTrial = {
    _tag: 'DEVELOPMENT_ONLY',
    candidateOrdinal: successor.preregistration.candidateOrdinal,
    priorTrialCount: successor.preregistration.priorTrialCount,
    status: 'DEVELOPMENT_REJECTED',
    evidenceContentHash: evidence.evidenceContentHash,
    evaluatedSourceRevision: evidence.evaluatedSourceRevision ?? null,
    failureStage: evidence.failureStage ?? null,
    developmentMetricsObserved: evidence.developmentMetricsObserved ?? null,
    attempt: successor.attempt,
  }
  return applied({
    ...state,
    developmentOnlyTrials: [...state.developmentOnlyTrials, cloneAndFreeze(trial)],
    currentSuccessor: null,
    nextOrdinal: successor.preregistration.candidateOrdinal + 1,
  })
}

const terminalizeQualification = (
  state: CandidateDevelopmentTrialState,
  evidence: TerminalizeQualificationTransition['evidence'],
): CandidateDevelopmentTrialTransitionDecision => {
  const successor = requireSuccessor(state)
  if (isIssue(successor)) return blocked(successor)
  if (successor.attempt._tag !== 'QUALIFICATION_ATTEMPT') {
    return blocked(
      stateIssue('state.currentSuccessor.attempt', 'ATTEMPT_KIND_MISMATCH', successor.attempt, 'QUALIFICATION_ATTEMPT'),
    )
  }
  const trial: CandidateDevelopmentHistoricalQualificationTrial = {
    _tag: 'HISTORICAL_QUALIFICATION',
    candidateOrdinal: successor.preregistration.candidateOrdinal,
    priorTrialCount: successor.preregistration.priorTrialCount,
    terminalStatus: evidence.terminalStatus,
    attempt: successor.attempt,
  }
  return applied({
    ...state,
    historicalQualificationTrials: [...state.historicalQualificationTrials, cloneAndFreeze(trial)],
    currentSuccessor: null,
    nextOrdinal: successor.preregistration.candidateOrdinal + 1,
  })
}

export const reduceCandidateDevelopmentTrialState = (
  state: CandidateDevelopmentTrialState,
  transition: CandidateDevelopmentTrialTransition,
): CandidateDevelopmentTrialTransitionDecision => {
  const stateValidation = validateCandidateDevelopmentTrialState(state)
  if (Result.isFailure(stateValidation)) return blocked(stateValidation.failure)
  if (!isRecord(transition)) return blocked(stateIssue('transition', 'MALFORMED_HISTORY', transition))
  switch (transition._tag) {
    case 'REVIEW_SUCCESSOR':
      return reviewSuccessor(state, transition.preregistration)
    case 'INVALIDATE_PRECOMMIT':
      return invalidateSuccessor(state, transition.invalidation)
    case 'CONSUME_DEVELOPMENT_ATTEMPT':
      return consumeAttempt(state, {
        _tag: 'DEVELOPMENT_ONLY_ATTEMPT',
        attemptCount: 1,
        metricBearingAttemptsConsumed: transition.metricBearing ? 1 : 0,
        qualificationAttemptConsumed: false,
      })
    case 'CONSUME_QUALIFICATION_ATTEMPT':
      return consumeAttempt(state, {
        _tag: 'QUALIFICATION_ATTEMPT',
        attemptCount: 1,
        metricBearingAttemptsConsumed: 1,
        qualificationAttemptConsumed: true,
      })
    case 'TERMINALIZE_DEVELOPMENT_ONLY':
      return terminalizeDevelopmentOnly(state, transition.evidence)
    case 'TERMINALIZE_QUALIFICATION':
      return terminalizeQualification(state, transition.evidence)
    default:
      return blocked(stateIssue('transition', 'MALFORMED_HISTORY', transition))
  }
}
