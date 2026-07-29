import { Effect, pipe, Result } from 'effect'

import { canonicalHashV1Result, type CanonicalHashFailure } from './hash'
import { defaultQualificationStatisticsPolicy, type QualificationStatisticsPolicy } from './qualification-statistics'
import type { IsoDate } from './schemas'

export const candidateDevelopmentCalendarContract = {
  schemaVersion: 'bayn.candidate-development-calendar.v1',
  calendarVersion: 'alpaca-us-equity-calendar-v1',
  start: '2016-01-04',
  end: '2022-12-30',
  sessionCount: 1_762,
  sessionsHash: 'a6df7a68249842fa35814f282b3df63db19c52f6ea0697899979d3a8c970d9b1',
} as const

/**
 * Development model selection uses multiple chronological rolling origins with expanding training data, as described
 * by Tashman (2000, doi:10.1016/S0169-2070(00)00065-0). The 197-session test length is not a weakened terminal gate:
 * it is the largest equal test block that preserves 504 training sessions and five non-overlapping tests after a
 * 252-session causal lookback and next-session execution inside the frozen 1,762-session development calendar.
 * Latest-contiguous selection maximizes recency while deriving every boundary only from the frozen calendar and
 * preregistered geometry, never from realized returns.
 * Terminal qualification continues to use defaultQualificationStatisticsPolicy unchanged. Its paired complete-block
 * bootstrap also remains unchanged and samples only observed, non-wrapping rebalance blocks, following the dependent
 * block-resampling principle of Künsch (1989, doi:10.1214/aos/1176347265).
 */
export const candidateDevelopmentWalkForwardProtocol = {
  method: 'expanding-origin',
  foldSelection: 'latest-contiguous',
  minimumTrainingSessions: 504,
  testSessions: 197,
  requiredFolds: 5,
  maximumFeatureLookbackSessions: 252,
  executionLagSessions: 1,
} as const

export const candidateDevelopmentStatisticsPolicy = {
  ...defaultQualificationStatisticsPolicy,
  confidence: { ...defaultQualificationStatisticsPolicy.confidence },
  bootstrap: { ...defaultQualificationStatisticsPolicy.bootstrap },
  power: { ...defaultQualificationStatisticsPolicy.power },
  walkForward: {
    ...defaultQualificationStatisticsPolicy.walkForward,
    testSessions: candidateDevelopmentWalkForwardProtocol.testSessions,
    minimumFolds: candidateDevelopmentWalkForwardProtocol.requiredFolds,
  },
  cashReturn: { ...defaultQualificationStatisticsPolicy.cashReturn },
} as const satisfies QualificationStatisticsPolicy

export interface CandidateDevelopmentWalkForwardGeometry {
  readonly minimumTrainingSessions: number
  readonly testSessions: number
  readonly requiredFolds: number
}

export interface CandidateDevelopmentExecutionBoundary {
  readonly signalIndex: number
  readonly signalDate: IsoDate
  readonly executionIndex: number
  readonly executionDate: IsoDate
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

export type CandidateDevelopmentPreflightIssue =
  | CandidateDevelopmentGeometryIssue
  | {
      readonly _tag: 'CandidateDevelopmentCalendarDateInvalid'
      readonly index: number
      readonly value: string
    }
  | {
      readonly _tag: 'CandidateDevelopmentCalendarNotStrictlyOrdered'
      readonly index: number
      readonly previous: IsoDate
      readonly current: IsoDate
    }
  | {
      readonly _tag: 'CandidateDevelopmentCalendarMismatch'
      readonly field: 'sessionCount' | 'start' | 'end' | 'sessionsHash'
      readonly expected: number | string
      readonly observed: number | string
    }
  | {
      readonly _tag: 'CandidateDevelopmentCalendarHashFailed'
      readonly cause: CanonicalHashFailure
    }
  | {
      readonly _tag: 'CandidateDevelopmentLookbackInvalid'
      readonly featureLookbackSessions: number
      readonly maximumFeatureLookbackSessions: number
    }
  | {
      readonly _tag: 'CandidateDevelopmentSignalScheduleEmpty'
    }
  | {
      readonly _tag: 'CandidateDevelopmentSignalScheduleNotStrictlyOrdered'
      readonly index: number
      readonly previous: IsoDate
      readonly current: IsoDate
    }
  | {
      readonly _tag: 'CandidateDevelopmentSignalOutsideCalendar'
      readonly signalDate: IsoDate
    }
  | {
      readonly _tag: 'CandidateDevelopmentSignalScheduleMismatch'
      readonly index: number
      readonly expected: IsoDate | undefined
      readonly observed: IsoDate | undefined
      readonly expectedCount: number
      readonly observedCount: number
    }
  | {
      readonly _tag: 'CandidateDevelopmentEligibleExecutionMissing'
      readonly featureLookbackSessions: number
    }

export interface CandidateDevelopmentPreflightPass extends CandidateDevelopmentGeometryPass {
  readonly schemaVersion: 'bayn.candidate-development-preflight.v1'
  readonly featureLookbackSessions: number
  readonly firstEligibleExecution: CandidateDevelopmentExecutionBoundary
  readonly statisticsPolicy: typeof candidateDevelopmentStatisticsPolicy
}

export type CandidateDevelopmentPreflightDecision = CandidateDevelopmentPreflightPass | CandidateDevelopmentGeometryFail

export type CandidateDevelopmentRunFailure =
  | {
      readonly _tag: 'CandidateDevelopmentPreflightInvalid'
      readonly cause: CandidateDevelopmentPreflightIssue
    }
  | {
      readonly _tag: 'CandidateDevelopmentPreflightFailed'
      readonly preflight: CandidateDevelopmentGeometryFail
    }

export interface CandidateDevelopmentPreflightInput {
  readonly officialSessions: readonly IsoDate[]
  readonly signalSessionDates: readonly IsoDate[]
  readonly featureLookbackSessions: number
}

export interface CandidateDevelopmentEffects<Registration, Data, Report, Error, Requirements> {
  readonly preregisterCandidate: (
    preflight: CandidateDevelopmentPreflightPass,
  ) => Effect.Effect<Registration, Error, Requirements>
  readonly loadDevelopmentData: (
    registration: Registration,
    preflight: CandidateDevelopmentPreflightPass,
  ) => Effect.Effect<Data, Error, Requirements>
  readonly evaluateDevelopment: (
    data: Data,
    preflight: CandidateDevelopmentPreflightPass,
  ) => Effect.Effect<Report, Error, Requirements>
}

const validIsoDate = (value: string): value is IsoDate => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
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
  pipe(
    Result.all({
      minimumTrainingSessions: positiveInteger('minimumTrainingSessions', geometry.minimumTrainingSessions),
      testSessions: positiveInteger('testSessions', geometry.testSessions),
      requiredFolds: positiveInteger('requiredFolds', geometry.requiredFolds),
    }),
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
  pipe(
    Result.all({
      availableSessions: positiveInteger('availableSessions', availableSessions),
      firstExecutionIndex: nonNegativeInteger('firstExecutionIndex', firstExecutionIndex),
    }),
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
  return pipe(
    Result.all({
      trainingStart: requiredSession(sessions, 'trainingStart', trainingStartIndex),
      trainingEnd: requiredSession(sessions, 'trainingEnd', trainingEndIndex),
      testStart: requiredSession(sessions, 'testStart', testStartIndex),
      testEnd: requiredSession(sessions, 'testEnd', testEndIndex),
    }),
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
  pipe(
    Result.all({
      requiredObservations: requiredObservationsForWalkForward(geometry),
      availableObservations: availableObservationsAfterFirstExecution(sessions.length, firstExecutionIndex),
    }),
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
        return pipe(
          Result.all({
            selectedObservationStart: requiredSession(sessions, 'trainingStart', selectedObservationStartIndex),
            selectedObservationEnd: requiredSession(sessions, 'testEnd', selectedObservationEndIndex),
            folds: Result.all(
              Array.from({ length: geometry.requiredFolds }, (_, ordinal) =>
                buildFoldBoundary(sessions, selectedObservationStartIndex, geometry, ordinal),
              ),
            ),
          }),
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

export const officialMonthEndSignalDates = (sessions: readonly IsoDate[]): readonly IsoDate[] =>
  sessions.filter((session, index) => {
    const next = sessions.at(index + 1)
    return next !== undefined && session.slice(0, 7) !== next.slice(0, 7)
  })

export const firstEligibleExecutionAfterLookback = (
  sessions: readonly IsoDate[],
  signalSessionDates: readonly IsoDate[],
  featureLookbackSessions: number,
): Result.Result<CandidateDevelopmentExecutionBoundary, CandidateDevelopmentPreflightIssue> => {
  if (
    !Number.isSafeInteger(featureLookbackSessions) ||
    featureLookbackSessions < 0 ||
    featureLookbackSessions > candidateDevelopmentWalkForwardProtocol.maximumFeatureLookbackSessions
  ) {
    return Result.fail({
      _tag: 'CandidateDevelopmentLookbackInvalid',
      featureLookbackSessions,
      maximumFeatureLookbackSessions: candidateDevelopmentWalkForwardProtocol.maximumFeatureLookbackSessions,
    })
  }
  if (signalSessionDates.length === 0) {
    return Result.fail({ _tag: 'CandidateDevelopmentSignalScheduleEmpty' })
  }

  const sessionIndices = new Map(sessions.map((session, index) => [session, index] as const))
  for (let index = 0; index < signalSessionDates.length; index += 1) {
    const signalDate = signalSessionDates[index]
    const previous = index === 0 ? undefined : signalSessionDates[index - 1]
    if (previous !== undefined && previous >= signalDate) {
      return Result.fail({
        _tag: 'CandidateDevelopmentSignalScheduleNotStrictlyOrdered',
        index,
        previous,
        current: signalDate,
      })
    }
    const signalIndex = sessionIndices.get(signalDate)
    if (signalIndex === undefined) {
      return Result.fail({ _tag: 'CandidateDevelopmentSignalOutsideCalendar', signalDate })
    }
  }

  const expectedSignalSessionDates = officialMonthEndSignalDates(sessions)
  const scheduleLength = Math.max(expectedSignalSessionDates.length, signalSessionDates.length)
  for (let index = 0; index < scheduleLength; index += 1) {
    const expected = expectedSignalSessionDates.at(index)
    const observed = signalSessionDates.at(index)
    if (expected !== observed) {
      return Result.fail({
        _tag: 'CandidateDevelopmentSignalScheduleMismatch',
        index,
        expected,
        observed,
        expectedCount: expectedSignalSessionDates.length,
        observedCount: signalSessionDates.length,
      })
    }
  }

  for (const signalDate of signalSessionDates) {
    const signalIndex = sessionIndices.get(signalDate)
    if (signalIndex === undefined) {
      return Result.fail({ _tag: 'CandidateDevelopmentSignalOutsideCalendar', signalDate })
    }
    const executionDate = sessions.at(signalIndex + candidateDevelopmentWalkForwardProtocol.executionLagSessions)
    if (signalIndex >= featureLookbackSessions && executionDate !== undefined) {
      return Result.succeed({
        signalIndex,
        signalDate,
        executionIndex: signalIndex + candidateDevelopmentWalkForwardProtocol.executionLagSessions,
        executionDate,
      })
    }
  }

  return Result.fail({ _tag: 'CandidateDevelopmentEligibleExecutionMissing', featureLookbackSessions })
}

const validateFrozenDevelopmentCalendar = (
  sessions: readonly IsoDate[],
): Result.Result<void, CandidateDevelopmentPreflightIssue> => {
  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index]
    if (!validIsoDate(session)) {
      return Result.fail({ _tag: 'CandidateDevelopmentCalendarDateInvalid', index, value: session })
    }
    const previous = index === 0 ? undefined : sessions[index - 1]
    if (previous !== undefined && previous >= session) {
      return Result.fail({
        _tag: 'CandidateDevelopmentCalendarNotStrictlyOrdered',
        index,
        previous,
        current: session,
      })
    }
  }

  const exactFields = [
    ['sessionCount', candidateDevelopmentCalendarContract.sessionCount, sessions.length],
    ['start', candidateDevelopmentCalendarContract.start, sessions.at(0) ?? ''],
    ['end', candidateDevelopmentCalendarContract.end, sessions.at(-1) ?? ''],
  ] as const
  for (const [field, expected, observed] of exactFields) {
    if (observed !== expected) {
      return Result.fail({ _tag: 'CandidateDevelopmentCalendarMismatch', field, expected, observed })
    }
  }

  return pipe(
    canonicalHashV1Result({
      schemaVersion: candidateDevelopmentCalendarContract.schemaVersion,
      sessions,
    }),
    Result.mapError(
      (cause): CandidateDevelopmentPreflightIssue => ({
        _tag: 'CandidateDevelopmentCalendarHashFailed',
        cause,
      }),
    ),
    Result.flatMap((observed) =>
      observed === candidateDevelopmentCalendarContract.sessionsHash
        ? Result.succeed(undefined)
        : Result.fail<CandidateDevelopmentPreflightIssue>({
            _tag: 'CandidateDevelopmentCalendarMismatch',
            field: 'sessionsHash',
            expected: candidateDevelopmentCalendarContract.sessionsHash,
            observed,
          }),
    ),
  )
}

export const preflightCandidateDevelopment = (
  input: CandidateDevelopmentPreflightInput,
): Result.Result<CandidateDevelopmentPreflightDecision, CandidateDevelopmentPreflightIssue> =>
  pipe(
    validateFrozenDevelopmentCalendar(input.officialSessions),
    Result.flatMap(() =>
      firstEligibleExecutionAfterLookback(
        input.officialSessions,
        input.signalSessionDates,
        input.featureLookbackSessions,
      ),
    ),
    Result.flatMap((firstEligibleExecution) =>
      pipe(
        computeEndAnchoredWalkForwardBoundaries(
          input.officialSessions,
          firstEligibleExecution.executionIndex,
          candidateDevelopmentWalkForwardProtocol,
        ),
        Result.map(
          (geometry): CandidateDevelopmentPreflightDecision =>
            geometry.status === 'FAIL'
              ? geometry
              : {
                  ...geometry,
                  schemaVersion: 'bayn.candidate-development-preflight.v1',
                  featureLookbackSessions: input.featureLookbackSessions,
                  firstEligibleExecution,
                  statisticsPolicy: candidateDevelopmentStatisticsPolicy,
                },
        ),
      ),
    ),
  )

export const runCandidateDevelopment = <Registration, Data, Report, Error, Requirements>(
  input: CandidateDevelopmentPreflightInput,
  effects: CandidateDevelopmentEffects<Registration, Data, Report, Error, Requirements>,
): Effect.Effect<Report, CandidateDevelopmentRunFailure | Error, Requirements> =>
  Effect.fromResult(preflightCandidateDevelopment(input)).pipe(
    Effect.mapError(
      (cause): CandidateDevelopmentRunFailure => ({ _tag: 'CandidateDevelopmentPreflightInvalid', cause }),
    ),
    Effect.flatMap(
      (preflight): Effect.Effect<Report, CandidateDevelopmentRunFailure | Error, Requirements> =>
        preflight.status === 'FAIL'
          ? Effect.fail<CandidateDevelopmentRunFailure>({
              _tag: 'CandidateDevelopmentPreflightFailed',
              preflight,
            })
          : effects.preregisterCandidate(preflight).pipe(
              Effect.flatMap((registration) => effects.loadDevelopmentData(registration, preflight)),
              Effect.flatMap((data) => effects.evaluateDevelopment(data, preflight)),
            ),
    ),
  )
