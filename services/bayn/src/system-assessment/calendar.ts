import { Result, Schema } from 'effect'
import { SnapshotCalendarSchema } from '../market-data/streaming/manifest-schema'
import { marketHoursAreCanonical } from '../market-hours'
import { canonicalHashV1Result } from '../hash'
import { strictParseOptions } from '../schemas'
import { SystemAssessmentError } from './economics'

export const qualificationCalendar = (input: unknown) =>
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
      sessions: observation.providerSessions.map((session) => ({
        sessionDate: session.date,
        openAt: session.regularOpenAt,
        closeAt: session.regularCloseAt,
      })),
    }
  })
