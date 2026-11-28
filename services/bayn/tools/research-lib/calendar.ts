import { Result, Schema } from 'effect'

import { MarketCalendarQueryBase } from '../../src/broker/alpaca/model'
import { normalizeMarketCalendarResult } from '../../src/broker/alpaca/normalizers'
import { IsoDateSchema } from '../../src/schemas'

enum SessionClose {
  Early = '13:00',
  Regular = '16:00',
}

const CalendarRows = Schema.Array(
  Schema.Struct({ date: IsoDateSchema, open: Schema.Literal('09:30'), close: Schema.Enum(SessionClose) }),
)
const decodeCalendar = Schema.decodeUnknownSync(
  Schema.Struct({ query: MarketCalendarQueryBase, response: CalendarRows }),
)

export interface Session {
  readonly date: string
  readonly openMs: number
  readonly minutes: number
}

export const normalizeResearchCalendar = (input: unknown): readonly Session[] => {
  const { query, response } = decodeCalendar(input)
  const { providerSessions } = Result.getOrThrow(
    normalizeMarketCalendarResult(
      response.map((session) => ({
        ...session,
        session_open: '0930',
        session_close: session.close.replace(':', ''),
      })),
      query,
    ),
  )
  return providerSessions.map(({ date, regularOpenAt, regularCloseAt }) => {
    const openMs = Date.parse(regularOpenAt)
    const minutes = (Date.parse(regularCloseAt) - openMs) / 60_000
    if (minutes !== 390 && minutes !== 210) throw new Error(`Unexpected session hours: ${date}`)
    return { date, openMs, minutes }
  })
}

export const elapsedDays = (from: string, through: string) => (Date.parse(through) - Date.parse(from)) / 86_400_000

/** A normalized calendar cut must cover exactly the registered endpoints and session count. */
export const requireCalendarCoverage = (
  calendar: readonly Session[],
  from: string,
  through: string,
  sessions: number,
) => {
  if (calendar.length !== sessions || calendar[0]?.date !== from || calendar.at(-1)?.date !== through)
    throw new Error(`Expected ${sessions} sessions from ${from} through ${through}`)
  return calendar
}

/** Require the same chronological, unique session dates before pairing returns or bars by position. */
export const requireAlignedSessions = (
  calendar: readonly { readonly date: string }[],
  ...series: (typeof calendar)[]
) => {
  if (series.some((rows) => rows.length !== calendar.length)) throw new Error('Session count mismatch')
  let previous = ''
  for (let i = 0; i < calendar.length; i++) {
    const { date } = calendar[i]
    if (date <= previous) throw new Error(`Duplicate or out-of-order calendar session: ${date}`)
    if (series.some((rows) => rows[i].date !== date)) throw new Error(`Session alignment mismatch: ${date}`)
    previous = date
  }
}

/** Exact registered endpoints, returned as an inclusive start and exclusive end for Array.slice. */
export const foldBounds = (dates: readonly string[], from: string, through: string, sessions?: number) => {
  const first = dates.indexOf(from)
  const end = dates.indexOf(through) + 1
  if (first < 0 || end <= first || (sessions !== undefined && end - first !== sessions))
    throw new Error(`Frozen split mismatch: ${from} through ${through}`)
  return { first, end }
}

/** Inclusive date-range fold; unlike a frozen fold, its endpoints need not themselves be sessions. */
export const sliceFold = <T extends { readonly date: string }>(
  rows: readonly T[],
  { start, end }: { readonly start: string; readonly end: string },
) => rows.filter(({ date }) => date >= start && date <= end)
