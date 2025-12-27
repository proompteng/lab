import { normalizeTorghutSymbol } from '~/server/torghut-symbols'

type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string }

const SYMBOL_PATTERN = /^[A-Z0-9._:-]{1,32}$/

export const TA_DEFAULT_LIMIT = 1000
export const TA_MAX_LIMIT = 5000
export const TA_MAX_RANGE_MS = 1000 * 60 * 60 * 24 * 7

export type TaRangeQuery = {
  symbol: string
  from: string
  to: string
  limit: number
}

const parseSymbol = (value: string | null) => {
  const raw = value?.trim() ?? ''
  if (!raw) return null
  const normalized = normalizeTorghutSymbol(raw)
  if (!SYMBOL_PATTERN.test(normalized)) {
    throw new Error('symbol must be uppercase letters, numbers, or . _ : -')
  }
  return normalized
}

const parseDateInput = (value: string | null, field: string) => {
  const raw = value?.trim() ?? ''
  if (!raw) return null

  let date: Date
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw)
    if (!Number.isFinite(numeric)) {
      throw new Error(`${field} must be a valid timestamp`)
    }
    const millis = raw.length <= 10 ? numeric * 1000 : numeric
    date = new Date(millis)
  } else {
    date = new Date(raw)
  }

  if (Number.isNaN(date.getTime())) {
    throw new Error(`${field} must be a valid timestamp`)
  }

  return date
}

const parseLimit = (value: string | null, fallback: number) => {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    throw new Error('limit must be a number')
  }
  if (parsed <= 0 || parsed > TA_MAX_LIMIT) {
    throw new Error(`limit must be between 1 and ${TA_MAX_LIMIT}`)
  }
  return parsed
}

export const parseTaRangeParams = (url: URL): ValidationResult<TaRangeQuery> => {
  try {
    const symbol = parseSymbol(url.searchParams.get('symbol'))
    if (!symbol) return { ok: false, message: 'symbol is required' }

    const fromDate = parseDateInput(url.searchParams.get('from'), 'from')
    if (!fromDate) return { ok: false, message: 'from is required' }

    const toDate = parseDateInput(url.searchParams.get('to'), 'to')
    if (!toDate) return { ok: false, message: 'to is required' }

    const fromMs = fromDate.getTime()
    const toMs = toDate.getTime()
    if (toMs < fromMs) return { ok: false, message: 'to must be after from' }

    const rangeMs = toMs - fromMs
    if (rangeMs > TA_MAX_RANGE_MS) {
      const maxDays = Math.floor(TA_MAX_RANGE_MS / (1000 * 60 * 60 * 24))
      return { ok: false, message: `range must be ${maxDays} days or less` }
    }

    const limit = parseLimit(url.searchParams.get('limit'), TA_DEFAULT_LIMIT)

    return {
      ok: true,
      value: {
        symbol,
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        limit,
      },
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Invalid query parameters',
    }
  }
}

export const parseTaLatestParams = (url: URL): ValidationResult<{ symbol: string }> => {
  try {
    const symbol = parseSymbol(url.searchParams.get('symbol'))
    if (!symbol) return { ok: false, message: 'symbol is required' }
    return { ok: true, value: { symbol } }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Invalid query parameters',
    }
  }
}
