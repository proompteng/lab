import { Result } from 'effect'

import type { CanonicalHashFailure } from '../hash'
import type { IsoDate } from '../schemas'
import {
  bindCandidateDevelopmentAttempt,
  identifyCandidateDevelopmentProtocol,
  type CandidateDevelopmentAttemptIssue,
  type CandidateDevelopmentBootstrapTailCapacity,
  type CandidateDevelopmentProtocolIdentity,
} from './attempt'
import {
  firstEligibleExecutionAfterLookback,
  expectedCandidateDevelopmentRebalanceSchedule,
  validateFrozenDevelopmentCalendar,
  type CandidateDevelopmentCalendarIssue,
  type CandidateDevelopmentExecutionBoundary,
  type CandidateDevelopmentRebalanceBoundary,
} from './calendar'
import {
  computeEndAnchoredWalkForwardBoundaries,
  type CandidateDevelopmentGeometryFail,
  type CandidateDevelopmentGeometryIssue,
  type CandidateDevelopmentGeometryPass,
} from './geometry'
import {
  candidateDevelopmentComparisonSemantics,
  candidateDevelopmentDoubledCostContract,
  candidateDevelopmentStatisticsPolicy,
  candidateDevelopmentWalkForwardProtocol,
} from './protocol'

export interface CandidateDevelopmentPreflightInput {
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly expectedStrategyProtocolHash: string
  readonly officialSessions: readonly IsoDate[]
  readonly signalSessionDates: readonly IsoDate[]
  readonly featureLookbackSessions: number
}

export type CandidateDevelopmentPreflightIssue =
  | CandidateDevelopmentGeometryIssue
  | CandidateDevelopmentAttemptIssue
  | CandidateDevelopmentCalendarIssue
  | {
      readonly _tag: 'CandidateDevelopmentProtocolHashFailed'
      readonly cause: CanonicalHashFailure
    }
  | {
      readonly _tag: 'CandidateDevelopmentStrategyProtocolHashInvalid'
      readonly observed: string
    }

export interface CandidateDevelopmentPreflightPass extends CandidateDevelopmentGeometryPass {
  readonly schemaVersion: 'bayn.candidate-development-preflight.v4'
  readonly attempt: CandidateDevelopmentBootstrapTailCapacity
  readonly featureLookbackSessions: number
  readonly firstEligibleExecution: CandidateDevelopmentExecutionBoundary
  readonly protocolIdentity: CandidateDevelopmentProtocolIdentity
  readonly expectedStrategyProtocolHash: string
  readonly doubledCostContract: typeof candidateDevelopmentDoubledCostContract
  readonly statisticsPolicy: typeof candidateDevelopmentStatisticsPolicy
  readonly comparisonSemantics: typeof candidateDevelopmentComparisonSemantics
  readonly selectedObservationSessions: readonly IsoDate[]
  readonly expectedRebalanceSchedule: readonly CandidateDevelopmentRebalanceBoundary[]
}

export type CandidateDevelopmentPreflightDecision = CandidateDevelopmentPreflightPass | CandidateDevelopmentGeometryFail

const validStrategyProtocolHash = (value: string): boolean => /^[0-9a-f]{64}$/.test(value)

const buildPassingPreflight = (
  geometry: CandidateDevelopmentGeometryPass,
  attempt: CandidateDevelopmentBootstrapTailCapacity,
  firstEligibleExecution: CandidateDevelopmentExecutionBoundary,
  featureLookbackSessions: number,
  protocolIdentity: CandidateDevelopmentProtocolIdentity,
  expectedStrategyProtocolHash: string,
  officialSessions: readonly IsoDate[],
  signalSessionDates: readonly IsoDate[],
): CandidateDevelopmentPreflightPass => ({
  ...geometry,
  schemaVersion: 'bayn.candidate-development-preflight.v4',
  attempt,
  featureLookbackSessions,
  firstEligibleExecution,
  protocolIdentity,
  expectedStrategyProtocolHash,
  doubledCostContract: candidateDevelopmentDoubledCostContract,
  statisticsPolicy: candidateDevelopmentStatisticsPolicy,
  comparisonSemantics: candidateDevelopmentComparisonSemantics,
  selectedObservationSessions: officialSessions.slice(
    geometry.selectedObservationStartIndex,
    geometry.selectedObservationEndIndex + 1,
  ),
  expectedRebalanceSchedule: expectedCandidateDevelopmentRebalanceSchedule(
    officialSessions,
    signalSessionDates,
    geometry.selectedObservationStart,
    geometry.selectedObservationEnd,
  ),
})

export const preflightCandidateDevelopment = (
  input: CandidateDevelopmentPreflightInput,
): Result.Result<CandidateDevelopmentPreflightDecision, CandidateDevelopmentPreflightIssue> =>
  Result.all({
    attempt: bindCandidateDevelopmentAttempt(input.candidateOrdinal, input.priorTrialCount),
    expectedStrategyProtocolHash: validStrategyProtocolHash(input.expectedStrategyProtocolHash)
      ? Result.succeed(input.expectedStrategyProtocolHash)
      : Result.fail<CandidateDevelopmentPreflightIssue>({
          _tag: 'CandidateDevelopmentStrategyProtocolHashInvalid',
          observed: input.expectedStrategyProtocolHash,
        }),
  }).pipe(
    Result.flatMap(({ attempt, expectedStrategyProtocolHash }) =>
      validateFrozenDevelopmentCalendar(input.officialSessions).pipe(
        Result.flatMap(() =>
          firstEligibleExecutionAfterLookback(
            input.officialSessions,
            input.signalSessionDates,
            input.featureLookbackSessions,
          ),
        ),
        Result.map((firstEligibleExecution) => ({ attempt, expectedStrategyProtocolHash, firstEligibleExecution })),
      ),
    ),
    Result.flatMap(({ attempt, expectedStrategyProtocolHash, firstEligibleExecution }) =>
      Result.all({
        geometry: computeEndAnchoredWalkForwardBoundaries(
          input.officialSessions,
          firstEligibleExecution.executionIndex,
          candidateDevelopmentWalkForwardProtocol,
        ),
        protocolIdentity: identifyCandidateDevelopmentProtocol(
          attempt,
          input.featureLookbackSessions,
          expectedStrategyProtocolHash,
        ).pipe(
          Result.mapError((cause) => ({
            _tag: 'CandidateDevelopmentProtocolHashFailed' as const,
            cause,
          })),
        ),
      }).pipe(
        Result.map(
          ({ geometry, protocolIdentity }): CandidateDevelopmentPreflightDecision =>
            geometry.status === 'FAIL'
              ? geometry
              : buildPassingPreflight(
                  geometry,
                  attempt,
                  firstEligibleExecution,
                  input.featureLookbackSessions,
                  protocolIdentity,
                  expectedStrategyProtocolHash,
                  input.officialSessions,
                  input.signalSessionDates,
                ),
        ),
      ),
    ),
  )
