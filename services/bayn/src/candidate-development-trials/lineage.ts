import { Result } from 'effect'

import type {
  CandidateDevelopmentAttemptConsumption,
  CandidateDevelopmentDevelopmentOnlyTrial,
  CandidateDevelopmentHistoricalQualificationTrial,
  CandidateDevelopmentImmutableInvalidation,
  CandidateDevelopmentTrialHistory,
  CandidateDevelopmentTrialState,
  CandidateDevelopmentTrialStateIssue,
} from './model'
import { frozenDevelopmentMetricObservations } from './frozen-lineage'
import { validateCandidateDevelopmentTrialHistory } from './validation'

const unattempted: Extract<CandidateDevelopmentAttemptConsumption, { readonly _tag: 'UNATTEMPTED' }> = Object.freeze({
  _tag: 'UNATTEMPTED',
  attemptCount: 0,
  metricBearingAttemptsConsumed: 0,
  qualificationAttemptConsumed: false,
})

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export const cloneAndFreeze = <T>(value: T): T => {
  if (!isObject(value) && !Array.isArray(value)) return value
  const cloned = Array.isArray(value)
    ? value.map((item) => cloneAndFreeze(item))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneAndFreeze(item)]))
  return Object.freeze(cloned) as T
}

const normalizedDevelopmentTrial = (
  ordinal: number,
  latest: CandidateDevelopmentTrialHistory['latestDevelopmentEvidence'],
): CandidateDevelopmentDevelopmentOnlyTrial => {
  const developmentMetricsObserved =
    ordinal === latest.candidateOrdinal
      ? (latest.developmentMetricsObserved ?? null)
      : (frozenDevelopmentMetricObservations[ordinal] ?? null)
  return {
    _tag: 'DEVELOPMENT_ONLY',
    candidateOrdinal: ordinal,
    priorTrialCount: ordinal - 1,
    status: 'DEVELOPMENT_REJECTED',
    evidenceContentHash: ordinal === latest.candidateOrdinal ? latest.evidenceContentHash : null,
    evaluatedSourceRevision: ordinal === latest.candidateOrdinal ? latest.evaluatedSourceRevision : null,
    failureStage: ordinal === latest.candidateOrdinal ? (latest.failureStage ?? null) : null,
    developmentMetricsObserved,
    attempt: {
      _tag: 'DEVELOPMENT_ONLY_ATTEMPT',
      attemptCount: 1,
      metricBearingAttemptsConsumed: developmentMetricsObserved === null ? null : developmentMetricsObserved ? 1 : 0,
      qualificationAttemptConsumed: false,
    },
  }
}

const historicalQualificationTrial = (
  candidateOrdinal: number,
  sourceRevision: string | null,
): CandidateDevelopmentHistoricalQualificationTrial => ({
  _tag: 'HISTORICAL_QUALIFICATION',
  candidateOrdinal,
  priorTrialCount: candidateOrdinal - 1,
  terminalStatus: 'HOLD_REJECT',
  sourceRevision,
  attempt: {
    _tag: 'QUALIFICATION_ATTEMPT',
    attemptCount: 1,
    metricBearingAttemptsConsumed: 1,
    qualificationAttemptConsumed: true,
  },
})

const invalidatedPrecommit = (
  invalidation: CandidateDevelopmentTrialHistory['latestInvalidPrecommit'],
): readonly CandidateDevelopmentImmutableInvalidation[] =>
  invalidation === null
    ? []
    : [
        {
          _tag: 'IMMUTABLE_INVALIDATION' as const,
          invalidation: cloneAndFreeze(invalidation),
          attempt: unattempted,
        },
      ]

const currentSuccessor = (preregistration: CandidateDevelopmentTrialHistory['nextCandidatePreregistration']) =>
  preregistration === null
    ? null
    : {
        _tag: 'CURRENT_SUCCESSOR' as const,
        kind: 'DEVELOPMENT_ONLY' as const,
        preregistration: cloneAndFreeze(preregistration),
        attempt: unattempted,
      }

const nextOrdinal = (
  history: CandidateDevelopmentTrialHistory,
  successor: ReturnType<typeof currentSuccessor>,
): number =>
  successor === null
    ? Math.max(
        history.completedCandidateOrdinals.at(-1) ?? 0,
        history.developmentCandidateOrdinals.at(-1) ?? 0,
        history.latestInvalidPrecommit?.candidateOrdinal ?? 0,
      ) + 1
    : successor.preregistration.candidateOrdinal

export const buildCandidateDevelopmentTrialState = (
  history: CandidateDevelopmentTrialHistory,
): Result.Result<CandidateDevelopmentTrialState, CandidateDevelopmentTrialStateIssue> => {
  const validated = validateCandidateDevelopmentTrialHistory(history)
  if (Result.isFailure(validated)) return Result.fail(validated.failure)
  const successor = currentSuccessor(history.nextCandidatePreregistration)
  const latestQualificationOrdinal = history.completedCandidateOrdinals.at(-1)
  const state: CandidateDevelopmentTrialState = {
    schemaVersion: 'bayn.candidate-development-trial-state.v1',
    historicalQualificationTrials: cloneAndFreeze(
      history.completedCandidateOrdinals.map((candidateOrdinal) =>
        historicalQualificationTrial(
          candidateOrdinal,
          candidateOrdinal === latestQualificationOrdinal ? history.latestTerminalEvidence.sourceRevision : null,
        ),
      ),
    ),
    developmentOnlyTrials: cloneAndFreeze(
      history.developmentCandidateOrdinals.map((candidateOrdinal) =>
        normalizedDevelopmentTrial(candidateOrdinal, history.latestDevelopmentEvidence),
      ),
    ),
    invalidatedPrecommits: cloneAndFreeze(invalidatedPrecommit(history.latestInvalidPrecommit)),
    currentSuccessor: cloneAndFreeze(successor),
    nextOrdinal: nextOrdinal(history, successor),
  }
  return Result.succeed(state)
}

export const candidateDevelopmentTrialStateFromHistory = buildCandidateDevelopmentTrialState

export const emptyCandidateDevelopmentTrialState = (): CandidateDevelopmentTrialState => ({
  schemaVersion: 'bayn.candidate-development-trial-state.v1',
  historicalQualificationTrials: [],
  developmentOnlyTrials: [],
  invalidatedPrecommits: [],
  currentSuccessor: null,
  nextOrdinal: 1,
})
