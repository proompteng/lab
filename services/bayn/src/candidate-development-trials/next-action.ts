import { Result } from 'effect'

import type {
  CandidateDevelopmentCurrentSuccessor,
  CandidateDevelopmentNextAction,
  CandidateDevelopmentTrialState,
} from './model'
import { validateCandidateDevelopmentTrialState } from './validation'

const immediatelyPrecedingOrdinalWasInvalidated = (state: CandidateDevelopmentTrialState): boolean =>
  state.invalidatedPrecommits.some(({ invalidation }) => invalidation.candidateOrdinal === state.nextOrdinal - 1)

const awaitReviewedPrecommit = (state: CandidateDevelopmentTrialState): CandidateDevelopmentNextAction => ({
  _tag: 'AWAIT_REVIEWED_PRECOMMIT',
  candidateOrdinal: state.nextOrdinal,
  priorTrialCount: state.nextOrdinal - 1,
  reason: immediatelyPrecedingOrdinalWasInvalidated(state) ? 'PRECOMMIT_INVALIDATED' : 'NO_SUCCESSOR',
})

const actionForSuccessor = (successor: CandidateDevelopmentCurrentSuccessor): CandidateDevelopmentNextAction => {
  const { candidateOrdinal } = successor.preregistration
  switch (successor.attempt._tag) {
    case 'UNATTEMPTED':
      return successor.kind === 'QUALIFICATION'
        ? {
            _tag: 'CONSUME_QUALIFICATION_ATTEMPT',
            candidateOrdinal,
            preregistration: successor.preregistration,
          }
        : {
            _tag: 'CONSUME_DEVELOPMENT_ATTEMPT',
            candidateOrdinal,
            preregistration: successor.preregistration,
          }
    case 'DEVELOPMENT_ONLY_ATTEMPT':
      return {
        _tag: 'TERMINALIZE_DEVELOPMENT_ONLY',
        candidateOrdinal,
        preregistration: successor.preregistration,
      }
    case 'QUALIFICATION_ATTEMPT':
      return {
        _tag: 'TERMINALIZE_QUALIFICATION',
        candidateOrdinal,
        preregistration: successor.preregistration,
      }
  }
}

export const deriveCandidateDevelopmentNextAction = (
  state: CandidateDevelopmentTrialState,
): CandidateDevelopmentNextAction => {
  const validation = validateCandidateDevelopmentTrialState(state)
  if (Result.isFailure(validation)) return { _tag: 'BLOCKED', issue: validation.failure }
  return state.currentSuccessor === null ? awaitReviewedPrecommit(state) : actionForSuccessor(state.currentSuccessor)
}

export const nextCandidateDevelopmentOrdinal = (state: CandidateDevelopmentTrialState): number => state.nextOrdinal
