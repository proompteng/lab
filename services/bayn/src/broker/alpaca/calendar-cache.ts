import { Clock, Effect, Semaphore } from 'effect'

import { invalidRequest } from './failures'
import {
  BrokerRead,
  decodeMarketCalendarQuery,
  type BrokerReadShape,
  type MarketCalendarObservation,
  type MarketCalendarQuery,
  type ReadResult,
} from './model'

type CalendarRead = ReadResult<MarketCalendarObservation>
type RetainedCalendar = {
  readonly query: MarketCalendarQuery
  readonly checkedAt: number
  readonly expiresAt: number
  readonly result: CalendarRead
}

const millisecondsPerDay = 86_400_000

const nextCalendarBoundary = (calendar: MarketCalendarObservation, startedAt: number): number => {
  let boundary = (Math.floor(startedAt / millisecondsPerDay) + 1) * millisecondsPerDay
  const retainEarlier = (at: string) => {
    const instant = Date.parse(at)
    if (instant > startedAt) boundary = Math.min(boundary, instant)
  }
  for (const session of calendar.sessions) {
    retainEarlier(session.openAt)
    retainEarlier(session.closeAt)
  }
  for (const session of calendar.providerSessions) {
    retainEarlier(session.regularOpenAt)
    retainEarlier(session.regularCloseAt)
    retainEarlier(session.sessionOpenAt)
    retainEarlier(session.sessionCloseAt)
  }
  return boundary
}

/** One recovery pass owns this reader; it must never be retained by the broker session or across passes. */
export const makePassMarketCalendarRead = (fresh: BrokerReadShape['marketCalendar']) =>
  Effect.gen(function* () {
    const reads = yield* Semaphore.make(1)
    let retained: RetainedCalendar | undefined
    return (query: MarketCalendarQuery) =>
      Effect.fromResult(decodeMarketCalendarQuery(query)).pipe(
        Effect.mapError((cause) => invalidRequest('market-calendar', 'invalid Alpaca market calendar query', cause)),
        Effect.map((decoded) => ({ start: decoded.start, end: decoded.end })),
        Effect.flatMap((decoded) =>
          reads.withPermits(1)(
            Effect.gen(function* () {
              const startedAt = yield* Clock.currentTimeMillis
              if (
                retained !== undefined &&
                retained.query.start === decoded.start &&
                retained.query.end === decoded.end &&
                startedAt >= retained.checkedAt &&
                startedAt < retained.expiresAt
              ) {
                retained = { ...retained, checkedAt: startedAt }
                return structuredClone(retained.result)
              }

              // A failed or interrupted refresh cannot restore the previous observation.
              retained = undefined
              const result = yield* fresh(decoded)
              const completedAt = yield* Clock.currentTimeMillis
              const expiresAt = nextCalendarBoundary(result.value, startedAt)
              if (completedAt >= startedAt && completedAt < expiresAt)
                retained = { query: decoded, checkedAt: completedAt, expiresAt, result: structuredClone(result) }
              return result
            }),
          ),
        ),
      )
  })

/** Share the discovery read with decision preparation within the original bounded recovery pass only. */
export const withPassMarketCalendarRead = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const broker = yield* BrokerRead
    const marketCalendar = yield* makePassMarketCalendarRead(broker.marketCalendar)
    return yield* effect.pipe(Effect.provideService(BrokerRead, { ...broker, marketCalendar }))
  })
