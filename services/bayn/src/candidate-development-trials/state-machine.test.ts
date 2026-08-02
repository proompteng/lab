import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import {
  candidate20PrecommitInvalidation,
  frozenCandidateDevelopmentTrialHistory,
} from '../candidate-development-trial-history'
import {
  buildCandidateDevelopmentInvalidPrecommit,
  buildCandidateDevelopmentPreregistration,
  buildCandidateDevelopmentTrialHistory,
} from './test-builders'
import {
  buildCandidateDevelopmentTrialState,
  deriveCandidateDevelopmentNextAction,
  reduceCandidateDevelopmentTrialState,
  validateCandidateDevelopmentTrialHistory,
  validateCandidateDevelopmentTrialState,
  type CandidateDevelopmentTrialHistory,
  type CandidateDevelopmentTrialState,
} from './state-machine'

const successOf = <A, E>(result: Result.Result<A, E>): A => {
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isFailure(result)) throw new Error('expected lifecycle fixture to validate')
  return result.success
}

const stateFrom = (history: CandidateDevelopmentTrialHistory): CandidateDevelopmentTrialState =>
  successOf(buildCandidateDevelopmentTrialState(history))

const appliedState = <T extends { readonly _tag: string; readonly state?: CandidateDevelopmentTrialState }>(
  result: T,
) => {
  expect(result._tag).toBe('APPLIED')
  if (result._tag !== 'APPLIED' || result.state === undefined) throw new Error('expected lifecycle transition to apply')
  return result.state
}

const developmentEvidence = (candidateOrdinal: number, developmentMetricsObserved = true) => ({
  evidenceContentHash: `development-evidence-${candidateOrdinal}`,
  evaluatedSourceRevision: `development-source-${candidateOrdinal}`,
  failureStage: 'development-evaluation' as const,
  developmentMetricsObserved,
})

const qualificationEvidence = (candidateOrdinal: number) => ({
  terminalStatus: 'HOLD_REJECT' as const,
  sourceRevision: `qualification-source-${candidateOrdinal}`,
})

describe('candidate development lifecycle', () => {
  test('normalizes the frozen lineage into one authority and preserves Candidate 20', () => {
    const state = stateFrom(frozenCandidateDevelopmentTrialHistory)

    expect(state.closedTrials.map((trial) => trial.candidateOrdinal)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    )
    expect(state.closedTrials.map((trial) => trial._tag)).toEqual([
      ...Array.from({ length: 16 }, () => 'QUALIFICATION_TERMINAL' as const),
      'DEVELOPMENT_REJECTED',
      'DEVELOPMENT_REJECTED',
      'DEVELOPMENT_REJECTED',
      'PRECOMMIT_INVALIDATED',
    ])
    expect(state.activeTrial).toBeNull()
    expect(state.nextOrdinal).toBe(21)
    const lastClosed = state.closedTrials.at(-1)
    expect(lastClosed).toMatchObject({
      _tag: 'PRECOMMIT_INVALIDATED',
      candidateOrdinal: 20,
    })
    if (lastClosed === undefined || lastClosed._tag !== 'PRECOMMIT_INVALIDATED') {
      throw new Error('expected Candidate 20 invalidation to be the final closed trial')
    }
    expect(lastClosed.invalidation).toEqual(candidate20PrecommitInvalidation)
    expect(Object.isFrozen(lastClosed)).toBe(true)
    expect(Object.isFrozen(lastClosed.invalidation)).toBe(true)
    expect(deriveCandidateDevelopmentNextAction(state)).toEqual({
      _tag: 'AWAIT_REVIEWED_PRECOMMIT',
      candidateOrdinal: 21,
      priorTrialCount: 20,
      reason: 'PRECOMMIT_INVALIDATED',
    })
    expect(validateCandidateDevelopmentTrialState(state)).toEqual(Result.succeed(undefined))
  })

  test('requires exactly one development attempt before qualification can be eligible', () => {
    const initial = stateFrom(buildCandidateDevelopmentTrialHistory())
    const reviewed = appliedState(
      reduceCandidateDevelopmentTrialState(initial, {
        _tag: 'REVIEW_CANDIDATE',
        preregistration: buildCandidateDevelopmentPreregistration(4),
      }),
    )

    expect(reduceCandidateDevelopmentTrialState(reviewed, { _tag: 'CONSUME_QUALIFICATION_ATTEMPT' })).toMatchObject({
      _tag: 'BLOCKED',
      issue: { reason: 'QUALIFICATION_NOT_ELIGIBLE' },
    })

    const developmentAttempted = appliedState(
      reduceCandidateDevelopmentTrialState(reviewed, {
        _tag: 'CONSUME_DEVELOPMENT_ATTEMPT',
        metricBearing: true,
      }),
    )
    expect(deriveCandidateDevelopmentNextAction(developmentAttempted)).toMatchObject({
      _tag: 'AWAIT_DEVELOPMENT_OUTCOME',
      candidateOrdinal: 4,
    })
    expect(
      reduceCandidateDevelopmentTrialState(developmentAttempted, { _tag: 'CONSUME_QUALIFICATION_ATTEMPT' }),
    ).toMatchObject({ _tag: 'BLOCKED', issue: { reason: 'QUALIFICATION_NOT_ELIGIBLE' } })

    const eligible = appliedState(
      reduceCandidateDevelopmentTrialState(developmentAttempted, {
        _tag: 'APPROVE_FOR_QUALIFICATION',
        evidence: developmentEvidence(4),
      }),
    )
    expect(eligible.activeTrial?._tag).toBe('QUALIFICATION_ELIGIBLE')
    expect(deriveCandidateDevelopmentNextAction(eligible)).toMatchObject({
      _tag: 'CONSUME_QUALIFICATION_ATTEMPT',
      candidateOrdinal: 4,
    })
  })

  test('rejects a development attempt without creating a qualification opportunity', () => {
    const reviewed = appliedState(
      reduceCandidateDevelopmentTrialState(stateFrom(buildCandidateDevelopmentTrialHistory()), {
        _tag: 'REVIEW_CANDIDATE',
        preregistration: buildCandidateDevelopmentPreregistration(4),
      }),
    )
    const attempted = appliedState(
      reduceCandidateDevelopmentTrialState(reviewed, {
        _tag: 'CONSUME_DEVELOPMENT_ATTEMPT',
        metricBearing: false,
      }),
    )
    const rejected = appliedState(
      reduceCandidateDevelopmentTrialState(attempted, {
        _tag: 'REJECT_DEVELOPMENT',
        evidence: developmentEvidence(4, false),
      }),
    )

    expect(rejected.activeTrial).toBeNull()
    expect(rejected.closedTrials.at(-1)).toMatchObject({ _tag: 'DEVELOPMENT_REJECTED', candidateOrdinal: 4 })
    expect(rejected.nextOrdinal).toBe(5)
    expect(deriveCandidateDevelopmentNextAction(rejected)).toMatchObject({
      _tag: 'AWAIT_REVIEWED_PRECOMMIT',
      candidateOrdinal: 5,
      reason: 'DEVELOPMENT_REJECTED',
    })
    expect(reduceCandidateDevelopmentTrialState(rejected, { _tag: 'CONSUME_QUALIFICATION_ATTEMPT' })).toMatchObject({
      _tag: 'BLOCKED',
      issue: { reason: 'SUCCESSOR_REQUIRED' },
    })
    expect(
      reduceCandidateDevelopmentTrialState(rejected, {
        _tag: 'REVIEW_CANDIDATE',
        preregistration: buildCandidateDevelopmentPreregistration(4),
      }),
    ).toMatchObject({ _tag: 'BLOCKED', issue: { reason: 'NEXT_ORDINAL_MISMATCH' } })
  })

  test('permits exactly one qualification after development approval and then advances the ordinal', () => {
    const reviewed = appliedState(
      reduceCandidateDevelopmentTrialState(stateFrom(buildCandidateDevelopmentTrialHistory()), {
        _tag: 'REVIEW_CANDIDATE',
        preregistration: buildCandidateDevelopmentPreregistration(4),
      }),
    )
    const attempted = appliedState(
      reduceCandidateDevelopmentTrialState(reviewed, {
        _tag: 'CONSUME_DEVELOPMENT_ATTEMPT',
        metricBearing: true,
      }),
    )
    const eligible = appliedState(
      reduceCandidateDevelopmentTrialState(attempted, {
        _tag: 'APPROVE_FOR_QUALIFICATION',
        evidence: developmentEvidence(4),
      }),
    )
    const qualificationAttempted = appliedState(
      reduceCandidateDevelopmentTrialState(eligible, { _tag: 'CONSUME_QUALIFICATION_ATTEMPT' }),
    )
    expect(
      reduceCandidateDevelopmentTrialState(qualificationAttempted, { _tag: 'CONSUME_QUALIFICATION_ATTEMPT' }),
    ).toMatchObject({ _tag: 'BLOCKED', issue: { reason: 'ATTEMPT_ALREADY_CONSUMED' } })

    const terminal = appliedState(
      reduceCandidateDevelopmentTrialState(qualificationAttempted, {
        _tag: 'TERMINALIZE_QUALIFICATION',
        evidence: qualificationEvidence(4),
      }),
    )
    expect(terminal.activeTrial).toBeNull()
    expect(terminal.closedTrials.at(-1)).toMatchObject({
      _tag: 'QUALIFICATION_TERMINAL',
      candidateOrdinal: 4,
      qualificationAttempt: { _tag: 'QUALIFICATION_ATTEMPTED', attemptCount: 1 },
    })
    expect(terminal.nextOrdinal).toBe(5)
    expect(validateCandidateDevelopmentTrialState(terminal)).toEqual(Result.succeed(undefined))
    expect(
      reduceCandidateDevelopmentTrialState(terminal, {
        _tag: 'TERMINALIZE_QUALIFICATION',
        evidence: qualificationEvidence(4),
      }),
    ).toMatchObject({ _tag: 'BLOCKED', issue: { reason: 'SUCCESSOR_REQUIRED' } })
  })

  test('keeps an invalidated precommit immutable and prevents ordinal reuse', () => {
    const preregistration = buildCandidateDevelopmentPreregistration(4)
    const reviewed = appliedState(
      reduceCandidateDevelopmentTrialState(stateFrom(buildCandidateDevelopmentTrialHistory()), {
        _tag: 'REVIEW_CANDIDATE',
        preregistration,
      }),
    )
    const invalidated = appliedState(
      reduceCandidateDevelopmentTrialState(reviewed, {
        _tag: 'INVALIDATE_PRECOMMIT',
        invalidation: buildCandidateDevelopmentInvalidPrecommit(preregistration),
      }),
    )
    expect(invalidated.activeTrial).toBeNull()
    expect(invalidated.closedTrials.at(-1)).toMatchObject({
      _tag: 'PRECOMMIT_INVALIDATED',
      candidateOrdinal: 4,
      invalidation: { attemptStatus: 'UNATTEMPTED', qualificationAttemptConsumed: false },
    })
    expect(invalidated.nextOrdinal).toBe(5)
    expect(
      reduceCandidateDevelopmentTrialState(invalidated, {
        _tag: 'INVALIDATE_PRECOMMIT',
        invalidation: buildCandidateDevelopmentInvalidPrecommit(preregistration),
      }),
    ).toMatchObject({ _tag: 'BLOCKED', issue: { reason: 'SUCCESSOR_REQUIRED' } })
    expect(
      reduceCandidateDevelopmentTrialState(invalidated, {
        _tag: 'REVIEW_CANDIDATE',
        preregistration,
      }),
    ).toMatchObject({ _tag: 'BLOCKED', issue: { reason: 'NEXT_ORDINAL_MISMATCH' } })
  })

  test('fails closed on malformed lifecycle state and history', () => {
    const state = stateFrom(buildCandidateDevelopmentTrialHistory())
    const malformedStates: readonly unknown[] = [
      { ...state, closedTrials: [null] },
      { ...state, activeTrial: { _tag: 'DEVELOPMENT_PENDING' } },
      { ...state, nextOrdinal: 99 },
    ]
    for (const malformed of malformedStates) {
      expect(() => validateCandidateDevelopmentTrialState(malformed)).not.toThrow()
      expect(Result.isFailure(validateCandidateDevelopmentTrialState(malformed))).toBe(true)
      expect(deriveCandidateDevelopmentNextAction(malformed as CandidateDevelopmentTrialState)).toMatchObject({
        _tag: 'BLOCKED',
      })
    }

    const invalidHistory = structuredClone(frozenCandidateDevelopmentTrialHistory) as unknown as Record<string, unknown>
    invalidHistory.developmentCandidateOrdinals = [17, 19]
    expect(Result.isFailure(validateCandidateDevelopmentTrialHistory(invalidHistory))).toBe(true)
  })
})
