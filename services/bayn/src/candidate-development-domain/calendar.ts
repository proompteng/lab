import { Result } from 'effect'

import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'
import type { IsoDate } from '../schemas'
import { candidateDevelopmentCalendarContract, candidateDevelopmentWalkForwardProtocol } from './protocol'

export interface CandidateDevelopmentExecutionBoundary {
  readonly signalIndex: number
  readonly signalDate: IsoDate
  readonly executionIndex: number
  readonly executionDate: IsoDate
}

export interface CandidateDevelopmentRebalanceBoundary {
  readonly signalDate: IsoDate
  readonly executionDate: IsoDate
}

export type CandidateDevelopmentCalendarIssue =
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

const validIsoDate = (value: string): value is IsoDate => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const firstSequenceMismatch = <A>(
  expected: readonly A[],
  observed: readonly A[],
  same: (left: A | undefined, right: A | undefined) => boolean,
): { readonly index: number; readonly expected: A | undefined; readonly observed: A | undefined } | undefined => {
  const index = Array.from({ length: Math.max(expected.length, observed.length) }, (_, value) => value).find(
    (value) => !same(expected.at(value), observed.at(value)),
  )
  return index === undefined ? undefined : { index, expected: expected.at(index), observed: observed.at(index) }
}

export const officialMonthEndSignalDates = (sessions: readonly IsoDate[]): readonly IsoDate[] =>
  sessions.filter((session, index) => {
    const next = sessions.at(index + 1)
    return next !== undefined && session.slice(0, 7) !== next.slice(0, 7)
  })

export const expectedCandidateDevelopmentRebalanceSchedule = (
  sessions: readonly IsoDate[],
  signalSessionDates: readonly IsoDate[],
  selectedObservationStart: IsoDate,
  selectedObservationEnd: IsoDate,
): readonly CandidateDevelopmentRebalanceBoundary[] => {
  const sessionIndices = new Map(sessions.map((session, index) => [session, index] as const))
  return signalSessionDates.flatMap((signalDate) => {
    const signalIndex = sessionIndices.get(signalDate)
    if (signalIndex === undefined) return []
    const executionDate = sessions.at(signalIndex + candidateDevelopmentWalkForwardProtocol.executionLagSessions)
    return executionDate !== undefined &&
      executionDate >= selectedObservationStart &&
      executionDate <= selectedObservationEnd
      ? [{ signalDate, executionDate }]
      : []
  })
}

export const firstEligibleExecutionAfterLookback = (
  sessions: readonly IsoDate[],
  signalSessionDates: readonly IsoDate[],
  featureLookbackSessions: number,
): Result.Result<CandidateDevelopmentExecutionBoundary, CandidateDevelopmentCalendarIssue> => {
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
  const scheduleIssue = signalSessionDates.entries().find(([index, signalDate]) => {
    const previous = index === 0 ? undefined : signalSessionDates[index - 1]
    if (previous !== undefined && previous >= signalDate) {
      return true
    }
    return sessionIndices.get(signalDate) === undefined
  })
  if (scheduleIssue !== undefined) {
    const [index, signalDate] = scheduleIssue
    const previous = index === 0 ? undefined : signalSessionDates[index - 1]
    return previous !== undefined && previous >= signalDate
      ? Result.fail({
          _tag: 'CandidateDevelopmentSignalScheduleNotStrictlyOrdered',
          index,
          previous,
          current: signalDate,
        })
      : Result.fail({ _tag: 'CandidateDevelopmentSignalOutsideCalendar', signalDate })
  }

  const expectedSignalSessionDates = officialMonthEndSignalDates(sessions)
  const scheduleMismatch = firstSequenceMismatch(
    expectedSignalSessionDates,
    signalSessionDates,
    (left, right) => left === right,
  )
  if (scheduleMismatch !== undefined) {
    return Result.fail({
      _tag: 'CandidateDevelopmentSignalScheduleMismatch',
      ...scheduleMismatch,
      expectedCount: expectedSignalSessionDates.length,
      observedCount: signalSessionDates.length,
    })
  }

  const eligible = signalSessionDates
    .map((signalDate) => {
      const signalIndex = sessionIndices.get(signalDate)
      if (signalIndex === undefined) return undefined
      const executionIndex = signalIndex + candidateDevelopmentWalkForwardProtocol.executionLagSessions
      const executionDate = sessions.at(executionIndex)
      return signalIndex >= featureLookbackSessions && executionDate !== undefined
        ? { signalIndex, signalDate, executionIndex, executionDate }
        : undefined
    })
    .find((boundary) => boundary !== undefined)

  return eligible === undefined
    ? Result.fail({ _tag: 'CandidateDevelopmentEligibleExecutionMissing', featureLookbackSessions })
    : Result.succeed(eligible)
}

export const validateFrozenDevelopmentCalendar = (
  sessions: readonly IsoDate[],
): Result.Result<void, CandidateDevelopmentCalendarIssue> => {
  const invalidDate = sessions.findIndex((session) => !validIsoDate(session))
  if (invalidDate !== -1) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCalendarDateInvalid',
      index: invalidDate,
      value: sessions[invalidDate],
    })
  }

  const unordered = sessions.findIndex((session, index) => index > 0 && sessions[index - 1] >= session)
  if (unordered !== -1) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCalendarNotStrictlyOrdered',
      index: unordered,
      previous: sessions[unordered - 1],
      current: sessions[unordered],
    })
  }

  const exactFields = [
    ['sessionCount', candidateDevelopmentCalendarContract.sessionCount, sessions.length],
    ['start', candidateDevelopmentCalendarContract.start, sessions.at(0) ?? ''],
    ['end', candidateDevelopmentCalendarContract.end, sessions.at(-1) ?? ''],
  ] as const
  const mismatch = exactFields.find(([, expected, observed]) => expected !== observed)
  if (mismatch !== undefined) {
    const [field, expected, observed] = mismatch
    return Result.fail({ _tag: 'CandidateDevelopmentCalendarMismatch', field, expected, observed })
  }

  return canonicalHashV1Result({ schemaVersion: candidateDevelopmentCalendarContract.schemaVersion, sessions }).pipe(
    Result.mapError((cause) => ({ _tag: 'CandidateDevelopmentCalendarHashFailed' as const, cause })),
    Result.flatMap((observed) =>
      observed === candidateDevelopmentCalendarContract.sessionsHash
        ? Result.succeed(undefined)
        : Result.fail({
            _tag: 'CandidateDevelopmentCalendarMismatch' as const,
            field: 'sessionsHash' as const,
            expected: candidateDevelopmentCalendarContract.sessionsHash,
            observed,
          }),
    ),
  )
}
