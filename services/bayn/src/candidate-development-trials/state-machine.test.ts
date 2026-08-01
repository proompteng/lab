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
  if (Result.isFailure(result)) throw new Error('expected state-machine fixture to validate')
  return result.success
}

const stateFrom = (history: CandidateDevelopmentTrialHistory): CandidateDevelopmentTrialState =>
  successOf(buildCandidateDevelopmentTrialState(history))

describe('candidate development trial state machine', () => {
  test('normalizes the current history without changing the compatibility facade', () => {
    const state = stateFrom(frozenCandidateDevelopmentTrialHistory)

    expect(state.historicalQualificationTrials).toHaveLength(16)
    expect(state.developmentOnlyTrials.map((trial) => trial.candidateOrdinal)).toEqual([17, 18, 19])
    expect(state.invalidatedPrecommits).toHaveLength(1)
    expect(state.invalidatedPrecommits[0]?.invalidation).toEqual(candidate20PrecommitInvalidation)
    expect(state.invalidatedPrecommits[0] && Object.isFrozen(state.invalidatedPrecommits[0].invalidation)).toBe(true)
    expect(state.currentSuccessor).toBeNull()
    expect(state.nextOrdinal).toBe(21)
    expect(deriveCandidateDevelopmentNextAction(state)).toEqual({
      _tag: 'AWAIT_REVIEWED_PRECOMMIT',
      candidateOrdinal: 21,
      priorTrialCount: 20,
      reason: 'PRECOMMIT_INVALIDATED',
    })
    expect(validateCandidateDevelopmentTrialState(state)).toEqual(Result.succeed(undefined))
  })

  test('reviews, consumes, and terminalizes a development-only successor exactly once', () => {
    const state = stateFrom(buildCandidateDevelopmentTrialHistory())
    const successorPreregistration = buildCandidateDevelopmentPreregistration(4)
    const reviewed = reduceCandidateDevelopmentTrialState(state, {
      _tag: 'REVIEW_SUCCESSOR',
      preregistration: successorPreregistration,
    })
    expect(reviewed._tag).toBe('APPLIED')
    if (reviewed._tag === 'BLOCKED') throw new Error('expected successor review to apply')
    expect(deriveCandidateDevelopmentNextAction(reviewed.state)).toMatchObject({
      _tag: 'CONSUME_DEVELOPMENT_ATTEMPT',
      candidateOrdinal: 4,
    })

    const consumed = reduceCandidateDevelopmentTrialState(reviewed.state, {
      _tag: 'CONSUME_DEVELOPMENT_ATTEMPT',
      metricBearing: true,
    })
    expect(consumed._tag).toBe('APPLIED')
    if (consumed._tag === 'BLOCKED') throw new Error('expected development attempt to apply')
    expect(deriveCandidateDevelopmentNextAction(consumed.state)).toMatchObject({
      _tag: 'TERMINALIZE_DEVELOPMENT_ONLY',
      candidateOrdinal: 4,
    })

    const terminalized = reduceCandidateDevelopmentTrialState(consumed.state, {
      _tag: 'TERMINALIZE_DEVELOPMENT_ONLY',
      evidence: {
        evidenceContentHash: 'development-evidence-4',
        evaluatedSourceRevision: 'development-source-4',
        failureStage: 'development-evaluation',
        developmentMetricsObserved: true,
      },
    })
    expect(terminalized._tag).toBe('APPLIED')
    if (terminalized._tag === 'BLOCKED') throw new Error('expected development terminalization to apply')
    expect(terminalized.state.currentSuccessor).toBeNull()
    expect(terminalized.state.developmentOnlyTrials.map((trial) => trial.candidateOrdinal)).toEqual([3, 4])
    expect(terminalized.state.nextOrdinal).toBe(5)
    expect(validateCandidateDevelopmentTrialState(terminalized.state)).toEqual(Result.succeed(undefined))
  })

  test('consumes and terminalizes a qualification attempt independently from development trials', () => {
    const state = stateFrom(buildCandidateDevelopmentTrialHistory())
    const reviewed = reduceCandidateDevelopmentTrialState(state, {
      _tag: 'REVIEW_SUCCESSOR',
      kind: 'QUALIFICATION',
      preregistration: buildCandidateDevelopmentPreregistration(4),
    })
    expect(reviewed._tag).toBe('APPLIED')
    if (reviewed._tag === 'BLOCKED') throw new Error('expected qualification review to apply')
    expect(deriveCandidateDevelopmentNextAction(reviewed.state)).toMatchObject({
      _tag: 'CONSUME_QUALIFICATION_ATTEMPT',
      candidateOrdinal: 4,
    })
    const consumed = reduceCandidateDevelopmentTrialState(reviewed.state, { _tag: 'CONSUME_QUALIFICATION_ATTEMPT' })
    expect(consumed._tag).toBe('APPLIED')
    if (consumed._tag === 'BLOCKED') throw new Error('expected qualification attempt to apply')
    expect(deriveCandidateDevelopmentNextAction(consumed.state)).toMatchObject({
      _tag: 'TERMINALIZE_QUALIFICATION',
      candidateOrdinal: 4,
    })
    const terminalized = reduceCandidateDevelopmentTrialState(consumed.state, {
      _tag: 'TERMINALIZE_QUALIFICATION',
      evidence: { terminalStatus: 'HOLD_REJECT', sourceRevision: 'qualification-source-4' },
    })
    expect(terminalized._tag).toBe('APPLIED')
    if (terminalized._tag === 'BLOCKED') throw new Error('expected qualification terminalization to apply')
    expect(terminalized.state.historicalQualificationTrials.map((trial) => trial.candidateOrdinal)).toEqual([1, 2, 4])
    expect(terminalized.state.historicalQualificationTrials.at(-1)?.sourceRevision).toBe('qualification-source-4')
    expect(terminalized.state.developmentOnlyTrials.map((trial) => trial.candidateOrdinal)).toEqual([3])
    expect(terminalized.state.nextOrdinal).toBe(5)
    expect(validateCandidateDevelopmentTrialState(terminalized.state)).toEqual(Result.succeed(undefined))
  })

  test('keeps an invalidated precommit immutable and waits for a new reviewed successor', () => {
    const preregistration = buildCandidateDevelopmentPreregistration(4)
    const state = stateFrom(buildCandidateDevelopmentTrialHistory())
    const reviewed = reduceCandidateDevelopmentTrialState(state, {
      _tag: 'REVIEW_SUCCESSOR',
      preregistration,
    })
    if (reviewed._tag === 'BLOCKED') throw new Error('expected successor review to apply')
    const invalidated = reduceCandidateDevelopmentTrialState(reviewed.state, {
      _tag: 'INVALIDATE_PRECOMMIT',
      invalidation: buildCandidateDevelopmentInvalidPrecommit(preregistration),
    })
    expect(invalidated._tag).toBe('APPLIED')
    if (invalidated._tag === 'BLOCKED') throw new Error('expected invalidation to apply')
    expect(invalidated.state.currentSuccessor).toBeNull()
    expect(invalidated.state.invalidatedPrecommits).toHaveLength(1)
    expect(invalidated.state.nextOrdinal).toBe(5)
    expect(deriveCandidateDevelopmentNextAction(invalidated.state)).toMatchObject({
      _tag: 'AWAIT_REVIEWED_PRECOMMIT',
      candidateOrdinal: 5,
      reason: 'PRECOMMIT_INVALIDATED',
    })

    const replay = reduceCandidateDevelopmentTrialState(invalidated.state, {
      _tag: 'INVALIDATE_PRECOMMIT',
      invalidation: buildCandidateDevelopmentInvalidPrecommit(preregistration),
    })
    expect(replay).toMatchObject({ _tag: 'BLOCKED', issue: { reason: 'SUCCESSOR_REQUIRED' } })
    const oldOrdinal = reduceCandidateDevelopmentTrialState(invalidated.state, {
      _tag: 'REVIEW_SUCCESSOR',
      preregistration,
    })
    expect(oldOrdinal).toMatchObject({ _tag: 'BLOCKED', issue: { reason: 'NEXT_ORDINAL_MISMATCH' } })
  })

  test('blocks repeated attempts, wrong terminalization, and ambiguous histories', () => {
    const preregistration = buildCandidateDevelopmentPreregistration(4)
    const reviewed = reduceCandidateDevelopmentTrialState(stateFrom(buildCandidateDevelopmentTrialHistory()), {
      _tag: 'REVIEW_SUCCESSOR',
      preregistration,
    })
    if (reviewed._tag === 'BLOCKED') throw new Error('expected successor review to apply')
    const consumed = reduceCandidateDevelopmentTrialState(reviewed.state, {
      _tag: 'CONSUME_DEVELOPMENT_ATTEMPT',
      metricBearing: false,
    })
    if (consumed._tag === 'BLOCKED') throw new Error('expected development attempt to apply')
    expect(
      reduceCandidateDevelopmentTrialState(consumed.state, {
        _tag: 'TERMINALIZE_DEVELOPMENT_ONLY',
        evidence: { evidenceContentHash: 'contradictory-metrics', developmentMetricsObserved: true },
      }),
    ).toMatchObject({ _tag: 'BLOCKED', issue: { reason: 'TERMINAL_STATE_MISMATCH' } })
    expect(
      reduceCandidateDevelopmentTrialState(consumed.state, { _tag: 'CONSUME_QUALIFICATION_ATTEMPT' }),
    ).toMatchObject({ _tag: 'BLOCKED', issue: { reason: 'ATTEMPT_ALREADY_CONSUMED' } })
    expect(
      reduceCandidateDevelopmentTrialState(reviewed.state, {
        _tag: 'TERMINALIZE_QUALIFICATION',
        evidence: { terminalStatus: 'HOLD_REJECT', sourceRevision: 'wrong-kind' },
      }),
    ).toMatchObject({ _tag: 'BLOCKED', issue: { reason: 'ATTEMPT_KIND_MISMATCH' } })

    const invalidation = buildCandidateDevelopmentInvalidPrecommit(preregistration)
    const invalidHistory = buildCandidateDevelopmentTrialHistory({ latestInvalidPrecommit: invalidation })
    expect(validateCandidateDevelopmentTrialHistory(invalidHistory)).toEqual(Result.succeed(undefined))
    const mutations = [
      (history: Record<string, unknown>) => {
        const current = history.latestInvalidPrecommit as Record<string, unknown>
        current.metricBearingAttemptsConsumed = 1
      },
      (history: Record<string, unknown>) => {
        history.developmentCandidateOrdinals = [3, 4]
      },
      (history: Record<string, unknown>) => {
        const prior = history.latestReviewedCandidatePriorTrials as Record<string, unknown>
        prior.developmentCandidateOrdinals = [3, 5]
      },
      (history: Record<string, unknown>) => {
        history.nextCandidatePreregistration = {
          ...buildCandidateDevelopmentPreregistration(6),
        }
      },
      (history: Record<string, unknown>) => {
        history.completedCandidateOrdinals = [1, 1]
      },
      (history: Record<string, unknown>) => {
        const current = history.latestInvalidPrecommit as Record<string, unknown>
        const naturalBuild = current.naturalBuild as Record<string, unknown>
        naturalBuild.imageDigest = `legacy:${'a'.repeat(64)}`
      },
    ] as const
    for (const mutate of mutations) {
      const mutated = structuredClone(invalidHistory) as unknown as Record<string, unknown>
      mutate(mutated)
      expect(Result.isFailure(validateCandidateDevelopmentTrialHistory(mutated))).toBe(true)
    }

    const tamperedState = {
      ...stateFrom(invalidHistory),
      nextOrdinal: 99,
    }
    expect(deriveCandidateDevelopmentNextAction(tamperedState)).toMatchObject({
      _tag: 'BLOCKED',
      issue: { reason: 'NEXT_ORDINAL_MISMATCH' },
    })
  })

  test('fails closed on missing lineage and malformed normalized records', () => {
    const history = frozenCandidateDevelopmentTrialHistory as unknown as Record<string, unknown>
    const missingInvalidation = { ...history }
    delete missingInvalidation.latestInvalidPrecommit
    expect(Result.isFailure(validateCandidateDevelopmentTrialHistory(missingInvalidation))).toBe(true)

    const state = stateFrom(frozenCandidateDevelopmentTrialHistory)
    const malformedStates: readonly unknown[] = [
      { ...state, historicalQualificationTrials: [null] },
      { ...state, developmentOnlyTrials: [null] },
      { ...state, invalidatedPrecommits: [null] },
    ]
    for (const malformed of malformedStates) {
      expect(() => validateCandidateDevelopmentTrialState(malformed)).not.toThrow()
      expect(Result.isFailure(validateCandidateDevelopmentTrialState(malformed))).toBe(true)
      expect(deriveCandidateDevelopmentNextAction(malformed as CandidateDevelopmentTrialState)).toMatchObject({
        _tag: 'BLOCKED',
      })
    }
  })
})
