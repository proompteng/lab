import { DateTime, HashSet, Option, pipe, Result } from 'effect'

import type { MarketCalendarObservation, MarketCalendarQuery, MarketCalendarSession } from '../../broker/alpaca'
import type { MarketDataInspection } from '../../market-data'
import { Pipeable } from '../../pipeable'
import {
  makeCycleDraft,
  makeCycleIdentity,
  makeCycleWindow,
  makeExecutionCalendarObservation,
  type CycleConstructionFailure,
} from '../construction'
import type { CycleDraft } from '../model'
import type { CycleCandidate } from './model'

const calendarRangeDays = 31
const publicationCatchUpRangeDays = 21
const millisecondsPerDay = 86_400_000

export type NonEmptyReadonlyArray<A> = readonly [A, ...A[]]
export type NonEmptyPublications = NonEmptyReadonlyArray<MarketDataInspection>

interface CyclePublicationDateInput {
  readonly signalSession: { readonly session_date: string }
}

export type IsoDateShiftCause =
  | { readonly _tag: 'IsoDateInputInvalid'; readonly date: string; readonly epochMillis: number }
  | { readonly _tag: 'IsoDateInputNotCanonical'; readonly date: string; readonly normalized: string }
  | { readonly _tag: 'IsoDateOffsetInvalid'; readonly date: string; readonly days: number }
  | {
      readonly _tag: 'IsoDateShiftEpochOutOfRange'
      readonly date: string
      readonly days: number
      readonly epochMillis: number
    }
  | {
      readonly _tag: 'IsoDateShiftResultOutOfRange'
      readonly date: string
      readonly days: number
      readonly shifted: string
    }

type IsoDateShiftFailure = {
  readonly _tag: 'IsoDateShiftOutOfRange'
  readonly date: string
  readonly days: number
  readonly cause: IsoDateShiftCause
}

export type CyclePublicationFailure =
  | {
      readonly _tag: 'CyclePublicationDateInvalid'
      readonly signalSessionDate: string
      readonly cause: IsoDateShiftCause
    }
  | { readonly _tag: 'CyclePublicationDuplicate'; readonly signalSessionDate: string }
  | {
      readonly _tag: 'CyclePublicationRangeOutOfRange'
      readonly signalSessionDate: string
      readonly offsetDays: number
      readonly cause: IsoDateShiftCause
    }

export type CycleCalendarQueryFailure = {
  readonly _tag: 'CycleCalendarQueryRangeOutOfRange'
  readonly signalSessionDate: string
  readonly offsetDays: number
  readonly cause: IsoDateShiftCause
}

const shiftIsoDate = (date: string, days: number): Result.Result<string, IsoDateShiftFailure> => {
  const failure = (cause: IsoDateShiftCause): Result.Result<never, IsoDateShiftFailure> =>
    Result.fail({ _tag: 'IsoDateShiftOutOfRange', date, days, cause })
  if (!Number.isSafeInteger(days)) return failure({ _tag: 'IsoDateOffsetInvalid', date, days })
  const inputEpochMillis = Date.parse(`${date}T00:00:00.000Z`)
  const inputDate = DateTime.make(inputEpochMillis)
  if (Option.isNone(inputDate)) {
    return failure({ _tag: 'IsoDateInputInvalid', date, epochMillis: inputEpochMillis })
  }
  const input = DateTime.formatIso(inputDate.value)
  if (input !== `${date}T00:00:00.000Z`) {
    return failure({ _tag: 'IsoDateInputNotCanonical', date, normalized: input })
  }
  const shiftedEpochMillis = inputEpochMillis + days * millisecondsPerDay
  const shiftedDateValue = DateTime.make(shiftedEpochMillis)
  if (Option.isNone(shiftedDateValue)) {
    return failure({ _tag: 'IsoDateShiftEpochOutOfRange', date, days, epochMillis: shiftedEpochMillis })
  }
  const shifted = DateTime.formatIso(shiftedDateValue.value)
  const shiftedDate = shifted.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(shiftedDate) && shifted === `${shiftedDate}T00:00:00.000Z`
    ? Result.succeed(shiftedDate)
    : failure({ _tag: 'IsoDateShiftResultOutOfRange', date, days, shifted })
}

export const marketCalendarQueryForSignal = (
  signalSessionDate: string,
): Result.Result<MarketCalendarQuery, CycleCalendarQueryFailure> =>
  Result.mapError(
    Result.map(shiftIsoDate(signalSessionDate, calendarRangeDays - 1), (end) => ({ start: signalSessionDate, end })),
    (failure) => ({
      _tag: 'CycleCalendarQueryRangeOutOfRange',
      signalSessionDate,
      offsetDays: calendarRangeDays - 1,
      cause: failure.cause,
    }),
  )

export const marketCalendarQueryForPublications = (
  publications: NonEmptyPublications,
): Result.Result<MarketCalendarQuery, CycleCalendarQueryFailure> =>
  marketCalendarQueryForSignal(
    publications.reduce((earliest, publication) =>
      publication.signalSession.session_date < earliest.signalSession.session_date ? publication : earliest,
    ).signalSession.session_date,
  )

export const boundedCyclePublications = <Publication extends CyclePublicationDateInput>(
  publications: NonEmptyReadonlyArray<Publication>,
): Result.Result<NonEmptyReadonlyArray<Publication>, CyclePublicationFailure> => {
  const validated = Result.all(
    publications.map((publication): Result.Result<Publication, CyclePublicationFailure> => {
      const signalSessionDate = publication.signalSession.session_date
      return pipe(
        shiftIsoDate(signalSessionDate, 0),
        Result.mapError(
          (failure): CyclePublicationFailure => ({
            _tag: 'CyclePublicationDateInvalid',
            signalSessionDate,
            cause: failure.cause,
          }),
        ),
        Result.map(() => publication),
      )
    }),
  )
  return pipe(
    validated,
    Result.flatMap((validated) =>
      validated.reduce<Result.Result<HashSet.HashSet<string>, CyclePublicationFailure>>(
        (seen, publication) =>
          pipe(
            seen,
            Result.flatMap((sessionDates) => {
              const signalSessionDate = publication.signalSession.session_date
              return HashSet.has(sessionDates, signalSessionDate)
                ? Result.fail({
                    _tag: 'CyclePublicationDuplicate',
                    signalSessionDate,
                  } satisfies CyclePublicationFailure)
                : Result.succeed(HashSet.add(sessionDates, signalSessionDate))
            }),
          ),
        Result.succeed(HashSet.empty()),
      ),
    ),
    Result.flatMap(() => {
      const latestPublication = publications.reduce((latest, publication) =>
        publication.signalSession.session_date > latest.signalSession.session_date ? publication : latest,
      )
      const latest = latestPublication.signalSession.session_date
      const offsetDays = -(publicationCatchUpRangeDays - 1)
      return pipe(
        shiftIsoDate(latest, offsetDays),
        Result.map(
          (earliest): NonEmptyReadonlyArray<Publication> => [
            latestPublication,
            ...publications
              .filter((publication) => {
                const sessionDate = publication.signalSession.session_date
                return sessionDate !== latest && sessionDate >= earliest
              })
              .toSorted((left, right) =>
                right.signalSession.session_date.localeCompare(left.signalSession.session_date),
              ),
          ],
        ),
        Result.mapError(
          (failure): CyclePublicationFailure => ({
            _tag: 'CyclePublicationRangeOutOfRange',
            signalSessionDate: latest,
            offsetDays,
            cause: failure.cause,
          }),
        ),
      )
    }),
  )
}

const selectNextExecutionSessionDataFirst = (
  signalSessionDate: string,
  observation: MarketCalendarObservation,
): MarketCalendarSession | undefined =>
  observation.sessions.reduce<MarketCalendarSession | undefined>(
    (selected, session) =>
      session.date > signalSessionDate && (selected === undefined || session.date < selected.date) ? session : selected,
    undefined,
  )

export const selectNextExecutionSession = Pipeable.dual(2, selectNextExecutionSessionDataFirst)

const isMonthEndCycleDueDataFirst = (signalSessionDate: string, executionSessionDate: string): boolean =>
  signalSessionDate.slice(0, 7) !== executionSessionDate.slice(0, 7)

export const isMonthEndCycleDue = Pipeable.dual(2, isMonthEndCycleDueDataFirst)

const makeDueCycleDraftDataFirst = (
  candidate: CycleCandidate,
  observation: MarketCalendarObservation,
  executionSession: MarketCalendarSession,
): Result.Result<CycleDraft | undefined, CycleConstructionFailure> =>
  candidate.cadence !== 'PAPER_BOOTSTRAP' &&
  !isMonthEndCycleDue(candidate.signalSession.session_date, executionSession.date)
    ? Result.succeed(undefined)
    : Result.gen(function* () {
        const executionCalendar = yield* makeExecutionCalendarObservation({
          schemaVersion: observation.schemaVersion,
          source: observation.source,
          ...executionSession,
        })
        const identity = yield* makeCycleIdentity({
          schemaVersion: 'bayn.autonomous-cycle-identity.v1',
          strategyName: 'risk-balanced-trend',
          qualificationRunId: candidate.qualificationRunId,
          strategyProtocolHash: candidate.strategyProtocolHash,
          accountId: candidate.accountId,
          signalSessionDate: candidate.signalSession.session_date,
          signalCalendarVersion: candidate.signalSession.calendar_version,
          executionSessionDate: executionCalendar.executionSessionDate,
          executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
          executionCalendarSource: executionCalendar.executionCalendarSource,
          executionCalendarHash: executionCalendar.executionCalendarHash,
          executionPolicy: candidate.executionPolicy,
        })
        const window = yield* makeCycleWindow(candidate.signalSession, executionCalendar, candidate.executionPolicy)
        return yield* makeCycleDraft(identity, window)
      })

export const makeDueCycleDraft = Pipeable.dual(3, makeDueCycleDraftDataFirst)
