import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { candidate20Preregistration, frozenCandidateDevelopmentTrialHistory } from './frozen-lineage'
import type { CandidateDevelopmentNextPreregistration, CandidateDevelopmentTrialHistory } from './model'
import { decideQualificationDormancy, qualificationDormancyDecisionFromState } from './qualification-dormancy'
import {
  buildCandidateDevelopmentTrialState,
  emptyCandidateDevelopmentTrialState,
  reduceCandidateDevelopmentTrialState,
} from './state-machine'
import { buildCandidateDevelopmentPreregistration } from './test-builders'

const history = (): CandidateDevelopmentTrialHistory => structuredClone(frozenCandidateDevelopmentTrialHistory)

const candidate21Preregistration = (): CandidateDevelopmentNextPreregistration => ({
  ...structuredClone(candidate20Preregistration),
  candidateOrdinal: 21,
  priorTrialCount: 20,
  modulePath: 'services/bayn/src/strategy/candidate-21.ts',
  preregistration: {
    sourceRevision: '1'.repeat(40),
    path: 'services/bayn/candidates/ordinal-21-preregistration.json',
    blobOid: '2'.repeat(40),
  },
})

const stateForReviewedCandidate21 = () => {
  const next = candidate21Preregistration()
  const value = {
    ...history(),
    latestReviewedCandidatePreregistration: next,
    nextCandidatePreregistration: next,
  }
  const state = buildCandidateDevelopmentTrialState(value)
  expect(Result.isSuccess(state)).toBe(true)
  if (Result.isFailure(state)) throw new Error('expected Candidate 21 history to validate')
  return state.success
}

describe('qualification dormancy decision', () => {
  test('keeps the immutable invalidated candidate dormant at ordinal 20', () => {
    expect(decideQualificationDormancy(history())).toEqual({
      ok: true,
      decision: {
        status: 'dormant',
        reason: 'precommit-invalid-unattempted',
        candidateOrdinal: 20,
      },
    })
  })

  test('does not make a reviewed successor qualification-ready merely because nextCandidatePreregistration exists', () => {
    expect(
      decideQualificationDormancy({
        ...history(),
        latestReviewedCandidatePreregistration: candidate21Preregistration(),
        nextCandidatePreregistration: candidate21Preregistration(),
      }),
    ).toEqual({
      ok: true,
      decision: {
        status: 'dormant',
        reason: 'development-not-approved',
        candidateOrdinal: 21,
      },
    })
  })

  test('reports ready only from the canonical qualification-eligible state', () => {
    const reviewed = stateForReviewedCandidate21()
    const attempted = reduceCandidateDevelopmentTrialState(reviewed, {
      _tag: 'CONSUME_DEVELOPMENT_ATTEMPT',
      metricBearing: true,
    })
    expect(attempted._tag).toBe('APPLIED')
    if (attempted._tag === 'BLOCKED') throw new Error('expected development attempt to apply')
    const eligible = reduceCandidateDevelopmentTrialState(attempted.state, {
      _tag: 'APPROVE_FOR_QUALIFICATION',
      evidence: {
        evidenceContentHash: 'development-evidence-21',
        evaluatedSourceRevision: 'development-source-21',
        developmentMetricsObserved: true,
      },
    })
    expect(eligible._tag).toBe('APPLIED')
    if (eligible._tag === 'BLOCKED') throw new Error('expected development approval to apply')
    expect(qualificationDormancyDecisionFromState(eligible.state)).toEqual({
      ok: true,
      decision: {
        status: 'ready',
        reason: 'qualification-eligible',
        candidateOrdinal: 21,
        preregistrationSourceRevision: '1'.repeat(40),
        preregistrationBlobOid: '2'.repeat(40),
      },
    })

    const qualificationAttempted = reduceCandidateDevelopmentTrialState(eligible.state, {
      _tag: 'CONSUME_QUALIFICATION_ATTEMPT',
    })
    expect(qualificationAttempted._tag).toBe('APPLIED')
    if (qualificationAttempted._tag === 'BLOCKED') throw new Error('expected qualification attempt to apply')
    expect(qualificationDormancyDecisionFromState(qualificationAttempted.state)).toEqual({
      ok: true,
      decision: {
        status: 'dormant',
        reason: 'qualification-attempt-consumed',
        candidateOrdinal: 21,
      },
    })
  })

  test('rejects a successor that reuses or skips the next ordinal', () => {
    for (const candidateOrdinal of [20, 22]) {
      const value = history()
      const next = { ...candidate21Preregistration(), candidateOrdinal, priorTrialCount: candidateOrdinal - 1 }
      expect(
        decideQualificationDormancy({
          ...value,
          latestReviewedCandidatePreregistration: next,
          nextCandidatePreregistration: next,
        }),
      ).toMatchObject({ ok: false, issue: { reason: 'AMBIGUOUS_SUCCESSOR' } })
    }
  })

  test('rejects malformed history before deciding whether qualification is dormant', () => {
    const value = history()
    expect(decideQualificationDormancy({ ...value, developmentCandidateOrdinals: [17, 19] })).toMatchObject({
      ok: false,
      issue: { reason: 'INVALID_ORDINAL_LINEAGE' },
    })
    expect(
      decideQualificationDormancy({
        ...value,
        latestInvalidPrecommit: { ...value.latestInvalidPrecommit, attemptStatus: 'ATTEMPTED' },
      }),
    ).toMatchObject({ ok: false, issue: { reason: 'INVALID_INVALIDATION' } })
  })

  test('reports a missing preregistration when no active candidate exists', () => {
    expect(qualificationDormancyDecisionFromState(emptyCandidateDevelopmentTrialState())).toEqual({
      ok: true,
      decision: { status: 'dormant', reason: 'preregistration-missing', candidateOrdinal: null },
    })
  })

  test('keeps the development fixture builder aligned with the canonical ordinal', () => {
    expect(buildCandidateDevelopmentPreregistration(21).priorTrialCount).toBe(20)
  })
})
