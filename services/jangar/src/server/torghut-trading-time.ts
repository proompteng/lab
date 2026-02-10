const DEFAULT_TIMEZONE = 'America/New_York'

export type TradingDayInterval = {
  tz: string
  day: string
  startUtc: string
  endUtc: string
}

const isIsoDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)

const parseIntStrict = (value: string) => {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

const formatPartsInTimeZone = (timeZone: string, date: Date) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)

  const record: Record<string, string> = {}
  for (const part of parts) {
    if (part.type !== 'literal') record[part.type] = part.value
  }

  const year = record.year ? parseIntStrict(record.year) : null
  const month = record.month ? parseIntStrict(record.month) : null
  const day = record.day ? parseIntStrict(record.day) : null
  const hour = record.hour ? parseIntStrict(record.hour) : null
  const minute = record.minute ? parseIntStrict(record.minute) : null
  const second = record.second ? parseIntStrict(record.second) : null

  if (year === null || month === null || day === null || hour === null || minute === null || second === null) {
    return null
  }

  return { year, month, day, hour, minute, second }
}

const clampIsoDayParts = (day: string) => {
  if (!isIsoDay(day)) return null
  const [y, m, d] = day.split('-')
  const year = y ? parseIntStrict(y) : null
  const month = m ? parseIntStrict(m) : null
  const dayOfMonth = d ? parseIntStrict(d) : null
  if (year === null || month === null || dayOfMonth === null) return null
  if (month < 1 || month > 12) return null
  if (dayOfMonth < 1 || dayOfMonth > 31) return null
  return { year, month, day: dayOfMonth }
}

const addUtcDays = (day: { year: number; month: number; day: number }, deltaDays: number) => {
  const base = Date.UTC(day.year, day.month - 1, day.day, 0, 0, 0)
  const next = new Date(base + deltaDays * 24 * 60 * 60 * 1000)
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }
}

// Converts a wall-clock time in `timeZone` into a UTC instant, without relying on additional timezone libraries.
// This iteration-based approach handles DST transitions correctly for the simple "local midnight" case we need.
const zonedDateTimeToUtcIso = (params: {
  timeZone: string
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}) => {
  const targetUtcFromParts = Date.UTC(
    params.year,
    params.month - 1,
    params.day,
    params.hour,
    params.minute,
    params.second,
  )
  let guess = new Date(targetUtcFromParts)

  for (let i = 0; i < 6; i += 1) {
    const observed = formatPartsInTimeZone(params.timeZone, guess)
    if (!observed) break
    const observedUtcFromParts = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    )
    const diffMs = targetUtcFromParts - observedUtcFromParts
    if (diffMs === 0) return guess.toISOString()
    guess = new Date(guess.getTime() + diffMs)
  }

  // Fallback: best-effort guess, still deterministic.
  return guess.toISOString()
}

export const resolveTradingDayInterval = (
  url: URL,
): { ok: true; value: TradingDayInterval } | { ok: false; message: string } => {
  const tzRaw = url.searchParams.get('tz')?.trim()
  const tz = tzRaw && tzRaw.length > 0 ? tzRaw : DEFAULT_TIMEZONE
  if (tz !== DEFAULT_TIMEZONE) {
    return { ok: false, message: `tz must be ${DEFAULT_TIMEZONE}` }
  }

  const dayRaw = url.searchParams.get('day')?.trim()
  if (!dayRaw) return { ok: false, message: 'day is required (YYYY-MM-DD)' }
  const dayParts = clampIsoDayParts(dayRaw)
  if (!dayParts) return { ok: false, message: 'day must be YYYY-MM-DD' }

  const nextDay = addUtcDays(dayParts, 1)

  const startUtc = zonedDateTimeToUtcIso({ timeZone: tz, ...dayParts, hour: 0, minute: 0, second: 0 })
  const endUtc = zonedDateTimeToUtcIso({ timeZone: tz, ...nextDay, hour: 0, minute: 0, second: 0 })

  return {
    ok: true,
    value: {
      tz,
      day: dayRaw,
      startUtc,
      endUtc,
    },
  }
}
