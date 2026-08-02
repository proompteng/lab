import { Result } from 'effect'

import type {
  CandidateDevelopmentClosedTrial,
  CandidateDevelopmentDevelopmentAttempted,
  CandidateDevelopmentDevelopmentRejectedTrial,
  CandidateDevelopmentDevelopmentTerminalEvidence,
  CandidateDevelopmentInvalidPrecommit,
  CandidateDevelopmentNextPreregistration,
  CandidateDevelopmentPrecommitInvalidatedTrial,
  CandidateDevelopmentQualificationCompletedTrial,
  CandidateDevelopmentQualificationTerminalEvidence,
  CandidateDevelopmentTrialHistory,
  CandidateDevelopmentTrialState,
  CandidateDevelopmentTrialStateIssue,
} from './model'
import { frozenDevelopmentMetricObservations } from './frozen-lineage'
import { validateCandidateDevelopmentTrialHistory, validateCandidateDevelopmentTrialState } from './validation'

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export const cloneAndFreeze = <T>(value: T): T => {
  if (!isObject(value) && !Array.isArray(value)) return value
  const cloned = Array.isArray(value)
    ? value.map((item) => cloneAndFreeze(item))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneAndFreeze(item)]))
  return Object.freeze(cloned) as T
}

const developmentAttempt = (metricBearing: boolean | null): CandidateDevelopmentDevelopmentAttempted => ({
  _tag: 'DEVELOPMENT_ATTEMPTED',
  attemptCount: 1,
  metricBearing,
})

const latestDevelopmentEvidence = (
  history: CandidateDevelopmentTrialHistory,
  candidateOrdinal: number,
): CandidateDevelopmentDevelopmentTerminalEvidence | null => {
  if (candidateOrdinal !== history.latestDevelopmentEvidence.candidateOrdinal) return null
  return {
    evidenceContentHash: history.latestDevelopmentEvidence.evidenceContentHash,
    evaluatedSourceRevision: history.latestDevelopmentEvidence.evaluatedSourceRevision,
    ...(history.latestDevelopmentEvidence.failureStage === undefined
      ? {}
      : { failureStage: history.latestDevelopmentEvidence.failureStage }),
    ...(history.latestDevelopmentEvidence.developmentMetricsObserved === undefined
      ? {}
      : { developmentMetricsObserved: history.latestDevelopmentEvidence.developmentMetricsObserved }),
  }
}

const historicalDevelopmentMetric = (
  history: CandidateDevelopmentTrialHistory,
  candidateOrdinal: number,
): boolean | null =>
  candidateOrdinal === history.latestDevelopmentEvidence.candidateOrdinal
    ? (history.latestDevelopmentEvidence.developmentMetricsObserved ?? null)
    : (frozenDevelopmentMetricObservations[candidateOrdinal] ?? null)

const historicalQualificationEvidence = (
  history: CandidateDevelopmentTrialHistory,
  candidateOrdinal: number,
): CandidateDevelopmentQualificationTerminalEvidence | null =>
  candidateOrdinal === history.latestTerminalEvidence.candidateOrdinal
    ? {
        terminalStatus: history.latestTerminalEvidence.terminalStatus,
        sourceRevision: history.latestTerminalEvidence.sourceRevision,
      }
    : null

const developmentPreregistration = (
  history: CandidateDevelopmentTrialHistory,
  candidateOrdinal: number,
): CandidateDevelopmentNextPreregistration | null =>
  candidateOrdinal === history.latestReviewedCandidatePriorTrials.latestReviewedPreregistration.candidateOrdinal
    ? history.latestReviewedCandidatePriorTrials.latestReviewedPreregistration
    : null

const buildQualificationCompletedTrial = (
  history: CandidateDevelopmentTrialHistory,
  candidateOrdinal: number,
): CandidateDevelopmentQualificationCompletedTrial => ({
  _tag: 'QUALIFICATION_TERMINAL',
  candidateOrdinal,
  priorTrialCount: candidateOrdinal - 1,
  preregistration: null,
  developmentAttempt: developmentAttempt(null),
  developmentEvidence: null,
  qualificationAttempt: {
    _tag: 'QUALIFICATION_ATTEMPTED',
    attemptCount: 1,
  },
  terminalEvidence: historicalQualificationEvidence(history, candidateOrdinal),
})

const buildDevelopmentRejectedTrial = (
  history: CandidateDevelopmentTrialHistory,
  candidateOrdinal: number,
): CandidateDevelopmentDevelopmentRejectedTrial => ({
  _tag: 'DEVELOPMENT_REJECTED',
  candidateOrdinal,
  priorTrialCount: candidateOrdinal - 1,
  preregistration: developmentPreregistration(history, candidateOrdinal),
  developmentAttempt: developmentAttempt(historicalDevelopmentMetric(history, candidateOrdinal)),
  developmentEvidence: latestDevelopmentEvidence(history, candidateOrdinal),
})

const buildInvalidatedTrial = (
  invalidation: CandidateDevelopmentInvalidPrecommit,
): CandidateDevelopmentPrecommitInvalidatedTrial => ({
  _tag: 'PRECOMMIT_INVALIDATED',
  candidateOrdinal: invalidation.candidateOrdinal,
  priorTrialCount: invalidation.priorTrialCount,
  invalidation: cloneAndFreeze(invalidation),
})

const closedTrialsFromHistory = (
  history: CandidateDevelopmentTrialHistory,
): readonly CandidateDevelopmentClosedTrial[] => {
  const invalidation = history.latestInvalidPrecommit
  const invalidatedOrdinal = invalidation?.candidateOrdinal
  const ordinals = [
    ...history.completedCandidateOrdinals,
    ...history.developmentCandidateOrdinals,
    ...(invalidatedOrdinal === undefined ? [] : [invalidatedOrdinal]),
  ].sort((left, right) => left - right)
  return ordinals.map((candidateOrdinal) => {
    if (candidateOrdinal === invalidatedOrdinal && invalidation !== null && invalidation !== undefined) {
      return buildInvalidatedTrial(invalidation)
    }
    if (history.developmentCandidateOrdinals.includes(candidateOrdinal)) {
      return buildDevelopmentRejectedTrial(history, candidateOrdinal)
    }
    return buildQualificationCompletedTrial(history, candidateOrdinal)
  })
}

const activeTrialFromHistory = (history: CandidateDevelopmentTrialHistory) =>
  history.nextCandidatePreregistration === null
    ? null
    : {
        _tag: 'DEVELOPMENT_PENDING' as const,
        candidateOrdinal: history.nextCandidatePreregistration.candidateOrdinal,
        priorTrialCount: history.nextCandidatePreregistration.priorTrialCount,
        preregistration: cloneAndFreeze(history.nextCandidatePreregistration),
        developmentAttempt: {
          _tag: 'DEVELOPMENT_UNATTEMPTED' as const,
          attemptCount: 0 as const,
        },
      }

const nextOrdinalFromClosedTrials = (closedTrials: readonly CandidateDevelopmentClosedTrial[]): number => {
  const highestClosed = closedTrials.at(-1)?.candidateOrdinal ?? 0
  return highestClosed + 1
}

export const buildCandidateDevelopmentTrialState = (
  history: CandidateDevelopmentTrialHistory,
): Result.Result<CandidateDevelopmentTrialState, CandidateDevelopmentTrialStateIssue> => {
  const historyValidation = validateCandidateDevelopmentTrialHistory(history)
  if (Result.isFailure(historyValidation)) return Result.fail(historyValidation.failure)
  const closedTrials = closedTrialsFromHistory(history)
  const activeTrial = activeTrialFromHistory(history)
  const state: CandidateDevelopmentTrialState = {
    schemaVersion: 'bayn.candidate-development-trial-state.v1',
    closedTrials: cloneAndFreeze(closedTrials),
    activeTrial: cloneAndFreeze(activeTrial),
    nextOrdinal: activeTrial?.candidateOrdinal ?? nextOrdinalFromClosedTrials(closedTrials),
  }
  const stateValidation = validateCandidateDevelopmentTrialState(state)
  return Result.isFailure(stateValidation) ? Result.fail(stateValidation.failure) : Result.succeed(state)
}

export const candidateDevelopmentTrialStateFromHistory = buildCandidateDevelopmentTrialState

export const emptyCandidateDevelopmentTrialState = (): CandidateDevelopmentTrialState => ({
  schemaVersion: 'bayn.candidate-development-trial-state.v1',
  closedTrials: [],
  activeTrial: null,
  nextOrdinal: 1,
})
