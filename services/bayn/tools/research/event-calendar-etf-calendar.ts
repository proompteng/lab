import { elapsedDays } from '../research-lib/calendar'

// Final days of the Fed's advance schedules, not a list inferred from rate changes.
// Sources for each year and the March 2020 cancellation are in the registered protocol.
export const scheduledStatements = [
  '2016-01-27',
  '2016-03-16',
  '2016-04-27',
  '2016-06-15',
  '2016-07-27',
  '2016-09-21',
  '2016-11-02',
  '2016-12-14',
  '2017-02-01',
  '2017-03-15',
  '2017-05-03',
  '2017-06-14',
  '2017-07-26',
  '2017-09-20',
  '2017-11-01',
  '2017-12-13',
  '2018-01-31',
  '2018-03-21',
  '2018-05-02',
  '2018-06-13',
  '2018-08-01',
  '2018-09-26',
  '2018-11-08',
  '2018-12-19',
  '2019-01-30',
  '2019-03-20',
  '2019-05-01',
  '2019-06-19',
  '2019-07-31',
  '2019-09-18',
  '2019-10-30',
  '2019-12-11',
  '2020-01-29',
  '2020-03-18',
  '2020-04-29',
  '2020-06-10',
  '2020-07-29',
  '2020-09-16',
  '2020-11-05',
  '2020-12-16',
  '2021-01-27',
  '2021-03-17',
  '2021-04-28',
  '2021-06-16',
  '2021-07-28',
  '2021-09-22',
  '2021-11-03',
  '2021-12-15',
  '2022-01-26',
  '2022-03-16',
  '2022-05-04',
  '2022-06-15',
  '2022-07-27',
  '2022-09-21',
  '2022-11-02',
  '2022-12-14',
  '2023-02-01',
  '2023-03-22',
  '2023-05-03',
  '2023-06-14',
  '2023-07-26',
  '2023-09-20',
  '2023-11-01',
  '2023-12-13',
  '2024-01-31',
  '2024-03-20',
  '2024-05-01',
  '2024-06-12',
  '2024-07-31',
  '2024-09-18',
  '2024-11-07',
  '2024-12-18',
  '2025-01-29',
  '2025-03-19',
  '2025-05-07',
  '2025-06-18',
  '2025-07-30',
  '2025-09-17',
  '2025-10-29',
  '2025-12-10',
  '2026-01-28',
  '2026-03-18',
  '2026-04-29',
  '2026-06-17',
  '2026-07-29',
  '2026-09-16',
  '2026-10-28',
  '2026-12-09',
] as const

export const cancelledStatement = { date: '2020-03-18', announcedAt: '2020-03-15T21:00:00Z' } as const
const fomc = new Set<string>(scheduledStatements.filter((date) => date !== cancelledStatement.date))
const goodFridays = [
  '2016-03-25',
  '2017-04-14',
  '2018-03-30',
  '2019-04-19',
  '2020-04-10',
  '2021-04-02',
  '2022-04-15',
  '2023-04-07',
  '2024-03-29',
  '2025-04-18',
  '2026-04-03',
]
// Both closings were announced before any entry whose month ordinal changes.
const mourningClosures = new Set(['2018-12-05', '2025-01-09'])
const dayMs = 86_400_000
const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const weekday = (ms: number) => new Date(ms).getUTCDay()
const civil = (year: number, month: number, day: number) => Date.UTC(year, month - 1, day)
const nth = (year: number, month: number, dayOfWeek: number, occurrence: number) => {
  const first = civil(year, month, 1)
  return first + (((dayOfWeek - weekday(first) + 7) % 7) + 7 * (occurrence - 1)) * dayMs
}
const observed = (date: number, observeSaturday = true) => {
  const day = weekday(date)
  if (day === 6) return observeSaturday ? [date - dayMs] : []
  return [date + (day === 0 ? dayMs : 0)]
}

const holidays = new Set([
  ...goodFridays,
  ...Array.from({ length: 13 }, (_, index) => {
    const year = 2015 + index
    const mayEnd = civil(year, 5, 31)
    return [
      ...observed(civil(year, 1, 1), false),
      nth(year, 1, 1, 3),
      nth(year, 2, 1, 3),
      mayEnd - ((weekday(mayEnd) + 6) % 7) * dayMs,
      ...(year >= 2022 ? observed(civil(year, 6, 19)) : []),
      ...observed(civil(year, 7, 4)),
      nth(year, 9, 1, 1),
      nth(year, 11, 4, 4),
      ...observed(civil(year, 12, 25)),
    ].map(dateOf)
  }).flat(),
])

type Events = { readonly turn: boolean; readonly fomc: boolean; readonly holiday: boolean }

// Pad both ends with known exchange schedules, not additional price bars. The
// November 25, 2026 decision must recognize Thanksgiving even at the tape cutoff.
const sessions: { readonly date: string }[] = []
for (let ms = civil(2015, 12, 1); ms < civil(2027, 2, 1); ms += dayMs) {
  const day = weekday(ms)
  const date = dateOf(ms)
  if (day !== 0 && day !== 6 && !holidays.has(date) && !mourningClosures.has(date)) sessions.push({ date })
}
const month = (date?: string) => date?.slice(0, 7)
const events = new Map(
  sessions.map(({ date }, i): [string, Events] => {
    const next = sessions[i + 1]?.date
    let holiday = false
    if (next !== undefined && elapsedDays(date, next) > 1) {
      for (let ms = Date.parse(date) + dayMs; ms < Date.parse(next); ms += dayMs) holiday ||= holidays.has(dateOf(ms))
    }
    return [
      date,
      {
        turn: month(sessions[i - 3]?.date) !== month(date) || month(sessions[i + 2]?.date) !== month(date),
        fomc: fomc.has(date),
        holiday,
      },
    ]
  }),
)

export const calendarEvents = (date: string) => {
  const row = events.get(date)
  if (row === undefined) throw new Error(`Not a registered exchange session: ${date}`)
  return row
}

export const expectedCalendar = (from: string, through: string) =>
  sessions.filter(({ date }) => date >= from && date <= through)
