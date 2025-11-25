const minute = 60 * 1000
const hour = 60 * minute
const day = 24 * hour

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

export const formatRelativeTime = (iso: string) => {
  const target = new Date(iso).getTime()
  const now = Date.now()
  const diff = target - now

  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [day, 'day'],
    [hour, 'hour'],
    [minute, 'minute'],
  ]

  for (const [size, unit] of units) {
    const value = Math.round(diff / size)
    if (Math.abs(value) >= 1) {
      return rtf.format(value, unit)
    }
  }

  return 'just now'
}

export const formatShortDate = (iso: string) => {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

export const formatClock = (iso: string) => {
  return new Intl.DateTimeFormat('en', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}
