import { Data, DateTime, Result } from 'effect'

export const equityDataHours = Object.freeze({ feed: 'iex', openMinute: 8 * 60, closeMinute: 17 * 60 })
const timeZone = 'America/New_York'
const clockFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone,
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
})

export class EquityHoursError extends Data.TaggedError('EquityHoursError')<{
  readonly message: string
}> {}

export interface EquityProviderSession {
  readonly date: string
  readonly regularOpenAt: string
  readonly regularCloseAt: string
  readonly sessionOpenAt: string
  readonly sessionCloseAt: string
}

const wallMinute = (date: string, minute: number) =>
  DateTime.makeZoned(
    {
      year: Number(date.slice(0, 4)),
      month: Number(date.slice(5, 7)),
      day: Number(date.slice(8, 10)),
      hour: Math.floor(minute / 60),
      minute: minute % 60,
      second: 0,
      millisecond: 0,
    },
    { timeZone, adjustForTimeZone: true, disambiguation: 'reject' },
  )

export const equityDataSession = (provider: EquityProviderSession) =>
  Result.gen(function* () {
    const open = wallMinute(provider.date, equityDataHours.openMinute)
    const close = wallMinute(provider.date, equityDataHours.closeMinute)
    if (open._tag === 'None' || close._tag === 'None')
      return yield* Result.fail(new EquityHoursError({ message: 'Invalid equity session wall clock' }))
    if (
      provider.sessionOpenAt > provider.regularOpenAt ||
      provider.regularOpenAt >= provider.regularCloseAt ||
      provider.regularCloseAt > provider.sessionCloseAt ||
      ![provider.sessionOpenAt, provider.regularOpenAt, provider.regularCloseAt, provider.sessionCloseAt].every(
        (instant) => DateTime.formatIsoDate(DateTime.makeZonedUnsafe(instant, { timeZone })) === provider.date,
      )
    )
      return yield* Result.fail(new EquityHoursError({ message: 'Invalid broker equity session bounds' }))
    const openAt =
      provider.sessionOpenAt > DateTime.formatIso(open.value) ? provider.sessionOpenAt : DateTime.formatIso(open.value)
    const closeAt =
      provider.sessionCloseAt < DateTime.formatIso(close.value)
        ? provider.sessionCloseAt
        : DateTime.formatIso(close.value)
    if (openAt >= closeAt)
      return yield* Result.fail(new EquityHoursError({ message: 'No executable IEX data session' }))
    return { date: provider.date, openAt, closeAt }
  })

/** Computation segments preserve regular-session indicators while admitting actual pre/post-market inputs. */
export const equityFeatureSegmentStartMs = (instantMs: number): number => {
  const zoned = DateTime.makeZonedUnsafe(instantMs, { timeZone })
  const parts = DateTime.toParts(zoned)
  const minute = parts.hour * 60 + parts.minute
  const startMinute = minute < 9 * 60 + 30 ? 8 * 60 : minute < 16 * 60 ? 9 * 60 + 30 : 16 * 60
  return DateTime.toEpochMillis(
    DateTime.setParts(zoned, {
      hour: Math.floor(startMinute / 60),
      minute: startMinute % 60,
      second: 0,
      millisecond: 0,
    }),
  )
}

export const equityClockSession = (instant: string): 'pre' | 'regular' | 'post' | null => {
  // Keep Effect's parsing and zoned range checks, without decomposing an entire local date for every quote.
  const zoned = DateTime.makeZonedUnsafe(instant, { timeZone })
  const parts = clockFormatter.formatToParts(DateTime.toEpochMillis(zoned))
  const hour = Number(parts.find((part) => part.type === 'hour')?.value)
  const wallMinute = Number(parts.find((part) => part.type === 'minute')?.value)
  const validParts =
    Number.isInteger(hour) &&
    hour >= 0 &&
    hour < 24 &&
    Number.isInteger(wallMinute) &&
    wallMinute >= 0 &&
    wallMinute < 60
  const minute = validParts
    ? hour * 60 + wallMinute
    : (() => {
        const original = DateTime.toParts(zoned)
        return original.hour * 60 + original.minute
      })()
  return minute < equityDataHours.openMinute || minute >= equityDataHours.closeMinute
    ? null
    : minute < 9 * 60 + 30
      ? 'pre'
      : minute < 16 * 60
        ? 'regular'
        : 'post'
}
