import { Result } from 'effect'

import type { IsoDate } from '../schemas'

export interface CandidateDevelopmentWalkForwardGeometry {
  readonly minimumTrainingSessions: number
  readonly testSessions: number
  readonly requiredFolds: number
}

export interface CandidateDevelopmentFoldBoundary {
  readonly ordinal: number
  readonly trainingStartIndex: number
  readonly trainingStart: IsoDate
  readonly trainingEndIndex: number
  readonly trainingEnd: IsoDate
  readonly trainingObservationCount: number
  readonly testStartIndex: number
  readonly testStart: IsoDate
  readonly testEndIndex: number
  readonly testEnd: IsoDate
  readonly testObservationCount: number
}

export interface CandidateDevelopmentGeometryPass {
  readonly status: 'PASS'
  readonly requiredObservations: number
  readonly availableObservations: number
  readonly availableFoldCount: number
  readonly requiredFoldCount: number
  readonly unusedEligibleObservations: number
  readonly selectedObservationStartIndex: number
  readonly selectedObservationStart: IsoDate
  readonly selectedObservationEndIndex: number
  readonly selectedObservationEnd: IsoDate
  readonly folds: readonly CandidateDevelopmentFoldBoundary[]
}

export interface CandidateDevelopmentGeometryFail {
  readonly status: 'FAIL'
  readonly reason: 'INSUFFICIENT_WALK_FORWARD_OBSERVATIONS'
  readonly requiredObservations: number
  readonly availableObservations: number
  readonly availableFoldCount: number
  readonly requiredFoldCount: number
  readonly observationDeficit: number
}

export type CandidateDevelopmentGeometryDecision = CandidateDevelopmentGeometryPass | CandidateDevelopmentGeometryFail

export type CandidateDevelopmentGeometryIssue =
  | {
      readonly _tag: 'CandidateDevelopmentGeometryIntegerInvalid'
      readonly field:
        | 'availableSessions'
        | 'firstExecutionIndex'
        | 'minimumTrainingSessions'
        | 'testSessions'
        | 'requiredFolds'
      readonly value: number
    }
  | {
      readonly _tag: 'CandidateDevelopmentGeometryPositiveIntegerRequired'
      readonly field: 'availableSessions' | 'minimumTrainingSessions' | 'testSessions' | 'requiredFolds'
      readonly value: number
    }
  | {
      readonly _tag: 'CandidateDevelopmentExecutionOutsideCalendar'
      readonly firstExecutionIndex: number
      readonly availableSessions: number
    }
  | {
      readonly _tag: 'CandidateDevelopmentGeometryOverflow'
      readonly operation: 'required-test-observations' | 'required-observations'
    }
  | {
      readonly _tag: 'CandidateDevelopmentFoldBoundaryMissing'
      readonly field: keyof CandidateDevelopmentFoldBoundary
      readonly index: number
    }

const positiveInteger = (
  field: Extract<
    CandidateDevelopmentGeometryIssue,
    { readonly _tag: 'CandidateDevelopmentGeometryPositiveIntegerRequired' }
  >['field'],
  value: number,
): Result.Result<number, CandidateDevelopmentGeometryIssue> =>
  !Number.isSafeInteger(value)
    ? Result.fail({ _tag: 'CandidateDevelopmentGeometryIntegerInvalid', field, value })
    : value <= 0
      ? Result.fail({ _tag: 'CandidateDevelopmentGeometryPositiveIntegerRequired', field, value })
      : Result.succeed(value)

const nonNegativeInteger = (
  field: 'firstExecutionIndex',
  value: number,
): Result.Result<number, CandidateDevelopmentGeometryIssue> =>
  !Number.isSafeInteger(value) || value < 0
    ? Result.fail({ _tag: 'CandidateDevelopmentGeometryIntegerInvalid', field, value })
    : Result.succeed(value)

export const requiredObservationsForWalkForward = (
  geometry: CandidateDevelopmentWalkForwardGeometry,
): Result.Result<number, CandidateDevelopmentGeometryIssue> =>
  Result.all({
    minimumTrainingSessions: positiveInteger('minimumTrainingSessions', geometry.minimumTrainingSessions),
    testSessions: positiveInteger('testSessions', geometry.testSessions),
    requiredFolds: positiveInteger('requiredFolds', geometry.requiredFolds),
  }).pipe(
    Result.flatMap(({ minimumTrainingSessions, requiredFolds, testSessions }) => {
      const requiredTestObservations = testSessions * requiredFolds
      if (!Number.isSafeInteger(requiredTestObservations)) {
        return Result.fail<CandidateDevelopmentGeometryIssue>({
          _tag: 'CandidateDevelopmentGeometryOverflow',
          operation: 'required-test-observations',
        })
      }

      const requiredObservations = minimumTrainingSessions + requiredTestObservations
      return Number.isSafeInteger(requiredObservations)
        ? Result.succeed(requiredObservations)
        : Result.fail<CandidateDevelopmentGeometryIssue>({
            _tag: 'CandidateDevelopmentGeometryOverflow',
            operation: 'required-observations',
          })
    }),
  )

export const availableObservationsAfterFirstExecution = (
  availableSessions: number,
  firstExecutionIndex: number,
): Result.Result<number, CandidateDevelopmentGeometryIssue> =>
  Result.all({
    availableSessions: positiveInteger('availableSessions', availableSessions),
    firstExecutionIndex: nonNegativeInteger('firstExecutionIndex', firstExecutionIndex),
  }).pipe(
    Result.flatMap(({ availableSessions: sessions, firstExecutionIndex: executionIndex }) =>
      executionIndex < sessions
        ? Result.succeed(sessions - executionIndex)
        : Result.fail<CandidateDevelopmentGeometryIssue>({
            _tag: 'CandidateDevelopmentExecutionOutsideCalendar',
            firstExecutionIndex: executionIndex,
            availableSessions: sessions,
          }),
    ),
  )

const requiredSession = (
  sessions: readonly IsoDate[],
  field: keyof CandidateDevelopmentFoldBoundary,
  index: number,
): Result.Result<IsoDate, CandidateDevelopmentGeometryIssue> => {
  const session = sessions.at(index)
  return session === undefined
    ? Result.fail({ _tag: 'CandidateDevelopmentFoldBoundaryMissing', field, index })
    : Result.succeed(session)
}

const buildFoldBoundary = (
  sessions: readonly IsoDate[],
  selectedObservationStartIndex: number,
  geometry: CandidateDevelopmentWalkForwardGeometry,
  ordinal: number,
): Result.Result<CandidateDevelopmentFoldBoundary, CandidateDevelopmentGeometryIssue> => {
  const trainingStartIndex = selectedObservationStartIndex
  const testStartIndex =
    selectedObservationStartIndex + geometry.minimumTrainingSessions + ordinal * geometry.testSessions
  const trainingEndIndex = testStartIndex - 1
  const testEndIndex = testStartIndex + geometry.testSessions - 1

  return Result.all({
    trainingStart: requiredSession(sessions, 'trainingStart', trainingStartIndex),
    trainingEnd: requiredSession(sessions, 'trainingEnd', trainingEndIndex),
    testStart: requiredSession(sessions, 'testStart', testStartIndex),
    testEnd: requiredSession(sessions, 'testEnd', testEndIndex),
  }).pipe(
    Result.map(({ testEnd, testStart, trainingEnd, trainingStart }) => ({
      ordinal,
      trainingStartIndex,
      trainingStart,
      trainingEndIndex,
      trainingEnd,
      trainingObservationCount: trainingEndIndex - trainingStartIndex + 1,
      testStartIndex,
      testStart,
      testEndIndex,
      testEnd,
      testObservationCount: geometry.testSessions,
    })),
  )
}

export const computeEndAnchoredWalkForwardBoundaries = (
  sessions: readonly IsoDate[],
  firstExecutionIndex: number,
  geometry: CandidateDevelopmentWalkForwardGeometry,
): Result.Result<CandidateDevelopmentGeometryDecision, CandidateDevelopmentGeometryIssue> =>
  Result.all({
    requiredObservations: requiredObservationsForWalkForward(geometry),
    availableObservations: availableObservationsAfterFirstExecution(sessions.length, firstExecutionIndex),
  }).pipe(
    Result.flatMap(
      ({
        availableObservations,
        requiredObservations,
      }): Result.Result<CandidateDevelopmentGeometryDecision, CandidateDevelopmentGeometryIssue> => {
        const availableFoldCount = Math.max(
          0,
          Math.floor((availableObservations - geometry.minimumTrainingSessions) / geometry.testSessions),
        )
        if (availableObservations < requiredObservations) {
          return Result.succeed({
            status: 'FAIL' as const,
            reason: 'INSUFFICIENT_WALK_FORWARD_OBSERVATIONS' as const,
            requiredObservations,
            availableObservations,
            availableFoldCount,
            requiredFoldCount: geometry.requiredFolds,
            observationDeficit: requiredObservations - availableObservations,
          })
        }

        const selectedObservationStartIndex = sessions.length - requiredObservations
        const selectedObservationEndIndex = sessions.length - 1
        return Result.all({
          selectedObservationStart: requiredSession(sessions, 'trainingStart', selectedObservationStartIndex),
          selectedObservationEnd: requiredSession(sessions, 'testEnd', selectedObservationEndIndex),
          folds: Result.all(
            Array.from({ length: geometry.requiredFolds }, (_, ordinal) =>
              buildFoldBoundary(sessions, selectedObservationStartIndex, geometry, ordinal),
            ),
          ),
        }).pipe(
          Result.map(({ folds, selectedObservationEnd, selectedObservationStart }) => ({
            status: 'PASS' as const,
            requiredObservations,
            availableObservations,
            availableFoldCount,
            requiredFoldCount: geometry.requiredFolds,
            unusedEligibleObservations: selectedObservationStartIndex - firstExecutionIndex,
            selectedObservationStartIndex,
            selectedObservationStart,
            selectedObservationEndIndex,
            selectedObservationEnd,
            folds,
          })),
        )
      },
    ),
  )
