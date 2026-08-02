import { Result } from 'effect'

import type {
  CandidateDevelopmentActiveTrial,
  CandidateDevelopmentClosedTrial,
  CandidateDevelopmentDevelopmentAttempted,
  CandidateDevelopmentDevelopmentOutcomePendingTrial,
  CandidateDevelopmentDevelopmentPendingTrial,
  CandidateDevelopmentDevelopmentRejectedTrial,
  CandidateDevelopmentQualificationAttemptedTrial,
  CandidateDevelopmentQualificationCompletedTrial,
  CandidateDevelopmentQualificationEligibleTrial,
  CandidateDevelopmentTrialState,
  CandidateDevelopmentTrialStateDecision,
  CandidateDevelopmentTrialStateIssue,
  CandidateDevelopmentTrialTransition,
} from './model'
import { cloneAndFreeze } from './lineage'
import {
  isRecord,
  stateIssue,
  validateCandidateDevelopmentTrialState,
  validateDevelopmentTerminalEvidence,
  validateInvalidation,
  validateNextPreregistration,
  validateQualificationTerminalEvidence,
} from './validation'

type ReviewCandidateTransition = Extract<CandidateDevelopmentTrialTransition, { readonly _tag: 'REVIEW_CANDIDATE' }>
type ConsumeDevelopmentTransition = Extract<
  CandidateDevelopmentTrialTransition,
  { readonly _tag: 'CONSUME_DEVELOPMENT_ATTEMPT' }
>
type DevelopmentOutcomeTransition = Extract<
  CandidateDevelopmentTrialTransition,
  { readonly _tag: 'REJECT_DEVELOPMENT' | 'APPROVE_FOR_QUALIFICATION' }
>
type TerminalizeQualificationTransition = Extract<
  CandidateDevelopmentTrialTransition,
  { readonly _tag: 'TERMINALIZE_QUALIFICATION' }
>
type InvalidatePrecommitTransition = Extract<
  CandidateDevelopmentTrialTransition,
  { readonly _tag: 'INVALIDATE_PRECOMMIT' }
>

const applied = (state: CandidateDevelopmentTrialState): CandidateDevelopmentTrialStateDecision => ({
  _tag: 'APPLIED',
  state: cloneAndFreeze(state),
})

const blocked = (issue: CandidateDevelopmentTrialStateIssue): CandidateDevelopmentTrialStateDecision => ({
  _tag: 'BLOCKED',
  issue,
})

const activeTrial = (
  state: CandidateDevelopmentTrialState,
): CandidateDevelopmentActiveTrial | CandidateDevelopmentTrialStateIssue =>
  state.activeTrial ?? stateIssue('state.activeTrial', 'SUCCESSOR_REQUIRED')

const isIssue = (
  value: CandidateDevelopmentActiveTrial | CandidateDevelopmentTrialStateIssue,
): value is CandidateDevelopmentTrialStateIssue => value._tag === 'CandidateDevelopmentTrialStateInvalid'

const nextState = (
  state: CandidateDevelopmentTrialState,
  update: Partial<CandidateDevelopmentTrialState>,
): CandidateDevelopmentTrialState => ({
  ...state,
  ...update,
})

const reviewCandidate = (
  state: CandidateDevelopmentTrialState,
  transition: ReviewCandidateTransition,
): CandidateDevelopmentTrialStateDecision => {
  if (state.activeTrial !== null) {
    return blocked(stateIssue('state.activeTrial', 'SUCCESSOR_ALREADY_PRESENT', state.activeTrial))
  }
  const preregistrationIssue = validateNextPreregistration(transition.preregistration, 'transition.preregistration')
  if (preregistrationIssue !== undefined) return blocked(preregistrationIssue)
  if (
    transition.preregistration.candidateOrdinal !== state.nextOrdinal ||
    transition.preregistration.priorTrialCount !== state.nextOrdinal - 1
  ) {
    return blocked(
      stateIssue('transition.preregistration', 'NEXT_ORDINAL_MISMATCH', transition.preregistration, {
        candidateOrdinal: state.nextOrdinal,
        priorTrialCount: state.nextOrdinal - 1,
      }),
    )
  }
  const reviewed: CandidateDevelopmentDevelopmentPendingTrial = {
    _tag: 'DEVELOPMENT_PENDING',
    candidateOrdinal: transition.preregistration.candidateOrdinal,
    priorTrialCount: transition.preregistration.priorTrialCount,
    preregistration: cloneAndFreeze(transition.preregistration),
    developmentAttempt: {
      _tag: 'DEVELOPMENT_UNATTEMPTED',
      attemptCount: 0,
    },
  }
  return applied(nextState(state, { activeTrial: reviewed }))
}

const consumeDevelopmentAttempt = (
  state: CandidateDevelopmentTrialState,
  transition: ConsumeDevelopmentTransition,
): CandidateDevelopmentTrialStateDecision => {
  if (typeof transition.metricBearing !== 'boolean') {
    return blocked(stateIssue('transition.metricBearing', 'MALFORMED_HISTORY', transition.metricBearing, 'boolean'))
  }
  const current = activeTrial(state)
  if (isIssue(current)) return blocked(current)
  if (current._tag !== 'DEVELOPMENT_PENDING') {
    return blocked(stateIssue('state.activeTrial.developmentAttempt', 'ATTEMPT_ALREADY_CONSUMED', current))
  }
  const attempted: CandidateDevelopmentDevelopmentOutcomePendingTrial = {
    _tag: 'DEVELOPMENT_OUTCOME_PENDING',
    candidateOrdinal: current.candidateOrdinal,
    priorTrialCount: current.priorTrialCount,
    preregistration: current.preregistration,
    developmentAttempt: {
      _tag: 'DEVELOPMENT_ATTEMPTED',
      attemptCount: 1,
      metricBearing: transition.metricBearing,
    },
  }
  return applied(nextState(state, { activeTrial: attempted }))
}

const validateOutcomeEvidence = (
  current: CandidateDevelopmentDevelopmentOutcomePendingTrial,
  evidence: unknown,
): CandidateDevelopmentTrialStateIssue | undefined => {
  const evidenceIssue = validateDevelopmentTerminalEvidence(evidence, 'transition.evidence')
  if (evidenceIssue !== undefined) return evidenceIssue
  if (
    isRecord(evidence) &&
    evidence.developmentMetricsObserved !== undefined &&
    evidence.developmentMetricsObserved !== current.developmentAttempt.metricBearing
  ) {
    return stateIssue(
      'transition.evidence.developmentMetricsObserved',
      'DEVELOPMENT_OUTCOME_MISMATCH',
      evidence.developmentMetricsObserved,
      current.developmentAttempt.metricBearing,
    )
  }
  return undefined
}

const developmentOutcome = (
  state: CandidateDevelopmentTrialState,
  transition: DevelopmentOutcomeTransition,
): CandidateDevelopmentTrialStateDecision => {
  const current = activeTrial(state)
  if (isIssue(current)) return blocked(current)
  if (current._tag === 'DEVELOPMENT_PENDING') {
    return blocked(stateIssue('state.activeTrial', 'DEVELOPMENT_OUTCOME_REQUIRED', current))
  }
  if (current._tag !== 'DEVELOPMENT_OUTCOME_PENDING') {
    return blocked(
      stateIssue('state.activeTrial', 'DEVELOPMENT_OUTCOME_MISMATCH', current, 'DEVELOPMENT_OUTCOME_PENDING'),
    )
  }
  const evidenceIssue = validateOutcomeEvidence(current, transition.evidence)
  if (evidenceIssue !== undefined) return blocked(evidenceIssue)
  const evidence = cloneAndFreeze(transition.evidence)
  if (transition._tag === 'REJECT_DEVELOPMENT') {
    const rejected: CandidateDevelopmentDevelopmentRejectedTrial = {
      _tag: 'DEVELOPMENT_REJECTED',
      candidateOrdinal: current.candidateOrdinal,
      priorTrialCount: current.priorTrialCount,
      preregistration: current.preregistration,
      developmentAttempt: current.developmentAttempt,
      developmentEvidence: evidence,
    }
    return applied(
      nextState(state, {
        closedTrials: [...state.closedTrials, rejected],
        activeTrial: null,
        nextOrdinal: current.candidateOrdinal + 1,
      }),
    )
  }
  const eligible: CandidateDevelopmentQualificationEligibleTrial = {
    _tag: 'QUALIFICATION_ELIGIBLE',
    candidateOrdinal: current.candidateOrdinal,
    priorTrialCount: current.priorTrialCount,
    preregistration: current.preregistration,
    developmentAttempt: current.developmentAttempt as CandidateDevelopmentDevelopmentAttempted & {
      readonly metricBearing: boolean
    },
    developmentEvidence: evidence,
    qualificationAttempt: {
      _tag: 'QUALIFICATION_UNATTEMPTED',
      attemptCount: 0,
    },
  }
  return applied(nextState(state, { activeTrial: eligible }))
}

const invalidatePrecommit = (
  state: CandidateDevelopmentTrialState,
  transition: InvalidatePrecommitTransition,
): CandidateDevelopmentTrialStateDecision => {
  const current = activeTrial(state)
  if (isIssue(current)) return blocked(current)
  if (current._tag !== 'DEVELOPMENT_PENDING') {
    return blocked(stateIssue('state.activeTrial.developmentAttempt', 'ATTEMPT_ALREADY_CONSUMED', current))
  }
  const invalidationIssue = validateInvalidation(transition.invalidation, 'transition.invalidation')
  if (invalidationIssue !== undefined) return blocked(invalidationIssue)
  const invalidation = transition.invalidation
  if (
    invalidation.candidateOrdinal !== current.candidateOrdinal ||
    invalidation.priorTrialCount !== current.priorTrialCount ||
    invalidation.invalidatedModule.path !== current.preregistration.modulePath ||
    invalidation.invalidatedModule.sha256 !== current.preregistration.moduleSha256 ||
    invalidation.preregistration.sourceRevision !== current.preregistration.preregistration.sourceRevision ||
    invalidation.preregistration.path !== current.preregistration.preregistration.path ||
    invalidation.preregistration.blobOid !== current.preregistration.preregistration.blobOid
  ) {
    return blocked(
      stateIssue('transition.invalidation', 'INVALIDATION_BINDING_MISMATCH', invalidation, current.preregistration),
    )
  }
  const invalidated: CandidateDevelopmentClosedTrial = {
    _tag: 'PRECOMMIT_INVALIDATED',
    candidateOrdinal: invalidation.candidateOrdinal,
    priorTrialCount: invalidation.priorTrialCount,
    invalidation: cloneAndFreeze(invalidation),
  }
  return applied(
    nextState(state, {
      closedTrials: [...state.closedTrials, invalidated],
      activeTrial: null,
      nextOrdinal: invalidation.candidateOrdinal + 1,
    }),
  )
}

const consumeQualificationAttempt = (state: CandidateDevelopmentTrialState): CandidateDevelopmentTrialStateDecision => {
  const current = activeTrial(state)
  if (isIssue(current)) return blocked(current)
  if (current._tag !== 'QUALIFICATION_ELIGIBLE') {
    if (current._tag === 'QUALIFICATION_ATTEMPTED') {
      return blocked(stateIssue('state.activeTrial.qualificationAttempt', 'ATTEMPT_ALREADY_CONSUMED', current))
    }
    return blocked(stateIssue('state.activeTrial', 'QUALIFICATION_NOT_ELIGIBLE', current))
  }
  const attempted: CandidateDevelopmentQualificationAttemptedTrial = {
    _tag: 'QUALIFICATION_ATTEMPTED',
    candidateOrdinal: current.candidateOrdinal,
    priorTrialCount: current.priorTrialCount,
    preregistration: current.preregistration,
    developmentAttempt: current.developmentAttempt,
    developmentEvidence: current.developmentEvidence,
    qualificationAttempt: {
      _tag: 'QUALIFICATION_ATTEMPTED',
      attemptCount: 1,
    },
  }
  return applied(nextState(state, { activeTrial: attempted }))
}

const terminalizeQualification = (
  state: CandidateDevelopmentTrialState,
  transition: TerminalizeQualificationTransition,
): CandidateDevelopmentTrialStateDecision => {
  const current = activeTrial(state)
  if (isIssue(current)) return blocked(current)
  if (current._tag !== 'QUALIFICATION_ATTEMPTED') {
    return blocked(
      stateIssue('state.activeTrial.qualificationAttempt', 'ATTEMPT_KIND_MISMATCH', current, 'QUALIFICATION_ATTEMPTED'),
    )
  }
  const evidenceIssue = validateQualificationTerminalEvidence(transition.evidence, 'transition.evidence')
  if (evidenceIssue !== undefined) return blocked(evidenceIssue)
  const terminal: CandidateDevelopmentQualificationCompletedTrial = {
    _tag: 'QUALIFICATION_TERMINAL',
    candidateOrdinal: current.candidateOrdinal,
    priorTrialCount: current.priorTrialCount,
    preregistration: current.preregistration,
    developmentAttempt: current.developmentAttempt,
    developmentEvidence: current.developmentEvidence,
    qualificationAttempt: current.qualificationAttempt,
    terminalEvidence: cloneAndFreeze(transition.evidence),
  }
  return applied(
    nextState(state, {
      closedTrials: [...state.closedTrials, terminal],
      activeTrial: null,
      nextOrdinal: current.candidateOrdinal + 1,
    }),
  )
}

export const reduceCandidateDevelopmentTrialState = (
  state: CandidateDevelopmentTrialState,
  transition: CandidateDevelopmentTrialTransition,
): CandidateDevelopmentTrialStateDecision => {
  const stateValidation = validateCandidateDevelopmentTrialState(state)
  if (Result.isFailure(stateValidation)) return blocked(stateValidation.failure)
  if (!isRecord(transition)) return blocked(stateIssue('transition', 'MALFORMED_HISTORY', transition))
  switch (transition._tag) {
    case 'REVIEW_CANDIDATE':
      return reviewCandidate(state, transition)
    case 'CONSUME_DEVELOPMENT_ATTEMPT':
      return consumeDevelopmentAttempt(state, transition)
    case 'REJECT_DEVELOPMENT':
    case 'APPROVE_FOR_QUALIFICATION':
      return developmentOutcome(state, transition)
    case 'INVALIDATE_PRECOMMIT':
      return invalidatePrecommit(state, transition)
    case 'CONSUME_QUALIFICATION_ATTEMPT':
      return consumeQualificationAttempt(state)
    case 'TERMINALIZE_QUALIFICATION':
      return terminalizeQualification(state, transition)
    default:
      return blocked(stateIssue('transition', 'MALFORMED_HISTORY', transition))
  }
}
