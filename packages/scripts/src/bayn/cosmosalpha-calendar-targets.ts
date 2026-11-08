export type SplitName = 'train' | 'validation' | 'test'
export type TargetSplit = { name: SplitName; startDate: string; endDate: string }
export type CalendarLayout = {
  calendar: readonly string[]
  splits: readonly TargetSplit[]
  windows: readonly { name: SplitName; first: number; last: number }[]
}
type Endpoint = { index: number; sessions: number }
export type CalendarTarget =
  | { status: 'outside-split'; split: null; endpoint: null; value: null }
  | { status: 'invalid-current-close' | 'cutoff'; split: SplitName; endpoint: null; value: null }
  | { status: 'invalid-endpoint-close'; split: SplitName; endpoint: Endpoint; value: null }
  | { status: 'ok'; split: SplitName; endpoint: Endpoint; value: number }

export const requireDate = (value: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)
    throw new Error(`Invalid calendar date ${value}`)
  return value
}

export const compileCalendar = (calendar: readonly string[], splits: readonly TargetSplit[]): CalendarLayout => {
  const firstDate = calendar[0]
  const lastDate = calendar.at(-1)
  if (!firstDate || !lastDate || splits.length === 0) throw new Error('Calendar and splits must be nonempty')
  let previousDate = ''
  for (const date of calendar) {
    requireDate(date)
    if (date <= previousDate) throw new Error('Calendar must be strictly increasing and unique')
    previousDate = date
  }
  const names = new Set<SplitName>()
  let previousEnd = ''
  const windows = splits.map((split) => {
    requireDate(split.startDate)
    requireDate(split.endDate)
    if (names.has(split.name)) throw new Error('Split names must be unique')
    names.add(split.name)
    if (split.startDate <= previousEnd || split.endDate < split.startDate)
      throw new Error('Splits must be ordered and nonoverlapping')
    if (split.startDate < firstDate || split.endDate > lastDate) throw new Error('Split exceeds the source calendar')
    previousEnd = split.endDate
    const first = calendar.findIndex((date) => date >= split.startDate)
    const last = calendar.findLastIndex((date) => date <= split.endDate)
    if (first < 0 || first > last) throw new Error('Split has no trading sessions')
    return { name: split.name, first, last }
  })
  return { calendar, splits, windows }
}

export const calendarTargets = (layout: CalendarLayout, closes: Float64Array): CalendarTarget[] => {
  if (closes.length !== layout.calendar.length) throw new Error('Prices must cover the complete calendar')
  const targets: CalendarTarget[] = Array.from({ length: closes.length }, () => ({
    status: 'outside-split',
    split: null,
    endpoint: null,
    value: null,
  }))
  for (const window of layout.windows) {
    let nextFinite: number | null = null
    for (let index = window.last; index >= window.first; index -= 1) {
      const current = closes[index]
      if (!Number.isFinite(current) || current <= 0)
        targets[index] = { status: 'invalid-current-close', split: window.name, endpoint: null, value: null }
      else if (nextFinite === null)
        targets[index] = { status: 'cutoff', split: window.name, endpoint: null, value: null }
      else {
        const endpoint = { index: nextFinite, sessions: nextFinite - index }
        const next = closes[nextFinite]
        if (next <= 0) targets[index] = { status: 'invalid-endpoint-close', split: window.name, endpoint, value: null }
        else {
          const raw = next / current - 1
          if (!Number.isFinite(raw)) throw new Error('Forward return is nonfinite')
          const value = endpoint.sessions > 1 ? Math.max(-0.1, Math.min(0.1, raw)) : raw
          targets[index] = { status: 'ok', split: window.name, endpoint, value }
        }
      }
      if (Number.isFinite(current)) nextFinite = index
    }
  }
  return targets
}
