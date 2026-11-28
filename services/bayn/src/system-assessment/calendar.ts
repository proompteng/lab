import { Result, Schema } from 'effect'
import { SnapshotCalendarSchema } from '../market-data/streaming/manifest-schema'
import { marketHoursAreCanonical } from '../market-hours'
import { canonicalHashV1Result } from '../hash'
import { strictParseOptions } from '../schemas'
import { SystemAssessmentError } from './economics'

export const qualificationCalendar = (
  input: unknown,
  operatingHours: 'REGULAR_SESSION' | 'NATIVE' = 'REGULAR_SESSION',
) =>
  Result.gen(function* () {
    const observation = yield* Schema.decodeUnknownResult(SnapshotCalendarSchema, strictParseOptions)(input)
    if (
      observation.schemaVersion !== 'bayn.alpaca-market-calendar-observation.v2' ||
      !marketHoursAreCanonical(observation)
    )
      return yield* Result.fail(
        new SystemAssessmentError({ message: 'Qualification requires a canonical broker equity calendar' }),
      )
    let previous = ''
    for (const session of observation.providerSessions) {
      if (
        session.date <= previous ||
        session.date < observation.requestedRange.start ||
        session.date > observation.requestedRange.end
      )
        return yield* Result.fail(
          new SystemAssessmentError({
            message: 'Calendar response is duplicated, unordered or outside its complete requested range',
          }),
        )
      previous = session.date
    }
    return {
      sourceHash: yield* canonicalHashV1Result(observation),
      requestedRange: observation.requestedRange,
      sessions:
        operatingHours === 'NATIVE'
          ? observation.sessions.map(({ date, openAt, closeAt }) => ({ sessionDate: date, openAt, closeAt }))
          : observation.providerSessions.map(({ date, regularOpenAt, regularCloseAt }) => ({
              sessionDate: date,
              openAt: regularOpenAt,
              closeAt: regularCloseAt,
            })),
    }
  })

/** Alpha signals use regular provider hours inside the independently registered native envelope. */
export const registeredAlphaObservationSessions = (calendar: {
  readonly sourceHash: string
  readonly marketCalendar: unknown
  readonly sessions: readonly { readonly sessionDate: string; readonly openAt: string; readonly closeAt: string }[]
}) =>
  Result.gen(function* () {
    const native = yield* qualificationCalendar(calendar.marketCalendar, 'NATIVE')
    const regular = yield* qualificationCalendar(calendar.marketCalendar, 'REGULAR_SESSION')
    if (
      native.sourceHash !== calendar.sourceHash ||
      (yield* canonicalHashV1Result(native.sessions)) !== (yield* canonicalHashV1Result(calendar.sessions))
    )
      return yield* Result.fail(
        new SystemAssessmentError({ message: 'Alpha capture differs from the registered native calendar envelope' }),
      )
    const byDate = new Map(regular.sessions.map((session) => [session.sessionDate, session]))
    const sessions = []
    for (const session of native.sessions) {
      const bounds = byDate.get(session.sessionDate)
      if (bounds === undefined || bounds.openAt < session.openAt || bounds.closeAt > session.closeAt)
        return yield* Result.fail(
          new SystemAssessmentError({
            message: 'Registered native envelope does not contain its complete regular session',
          }),
        )
      sessions.push({ ...session, regularOpenAt: bounds.openAt, regularCloseAt: bounds.closeAt })
    }
    return sessions
  })
