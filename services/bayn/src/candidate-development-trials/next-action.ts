import { Result } from 'effect'

import type {
  CandidateDevelopmentActiveTrial,
  CandidateDevelopmentNextAction,
  CandidateDevelopmentTrialState,
} from './model'
import { validateCandidateDevelopmentTrialState } from './validation'

const awaitReviewedCandidate = (state: CandidateDevelopmentTrialState): CandidateDevelopmentNextAction => {
  const lastClosedTrial = state.closedTrials.at(-1)
  const reason =
    lastClosedTrial?._tag === 'PRECOMMIT_INVALIDATED'
      ? 'PRECOMMIT_INVALIDATED'
      : lastClosedTrial?._tag === 'DEVELOPMENT_REJECTED'
        ? 'DEVELOPMENT_REJECTED'
        : 'NO_SUCCESSOR'
  return {
    _tag: 'AWAIT_REVIEWED_PRECOMMIT',
    candidateOrdinal: state.nextOrdinal,
    priorTrialCount: state.nextOrdinal - 1,
    reason,
  }
}

const actionForActiveTrial = (trial: CandidateDevelopmentActiveTrial): CandidateDevelopmentNextAction => {
  switch (trial._tag) {
    case 'DEVELOPMENT_PENDING':
      return {
        _tag: 'CONSUME_DEVELOPMENT_ATTEMPT',
        candidateOrdinal: trial.candidateOrdinal,
        preregistration: trial.preregistration,
      }
    case 'DEVELOPMENT_OUTCOME_PENDING':
      return {
        _tag: 'AWAIT_DEVELOPMENT_OUTCOME',
        candidateOrdinal: trial.candidateOrdinal,
        preregistration: trial.preregistration,
      }
    case 'QUALIFICATION_ELIGIBLE':
      return {
        _tag: 'CONSUME_QUALIFICATION_ATTEMPT',
        candidateOrdinal: trial.candidateOrdinal,
        preregistration: trial.preregistration,
      }
    case 'QUALIFICATION_ATTEMPTED':
      return {
        _tag: 'TERMINALIZE_QUALIFICATION',
        candidateOrdinal: trial.candidateOrdinal,
        preregistration: trial.preregistration,
      }
  }
}

export const deriveCandidateDevelopmentNextAction = (
  state: CandidateDevelopmentTrialState,
): CandidateDevelopmentNextAction => {
  const validation = validateCandidateDevelopmentTrialState(state)
  if (Result.isFailure(validation)) return { _tag: 'BLOCKED', issue: validation.failure }
  return state.activeTrial === null ? awaitReviewedCandidate(state) : actionForActiveTrial(state.activeTrial)
}

export const nextCandidateDevelopmentOrdinal = (state: CandidateDevelopmentTrialState): number => state.nextOrdinal
