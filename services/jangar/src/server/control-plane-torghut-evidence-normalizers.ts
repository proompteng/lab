export const normalizeNonEmpty = (value: unknown) => {
  const normalized = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim()
  return normalized.length > 0 ? normalized : null
}

export const normalizeReason = (value: unknown) =>
  normalizeNonEmpty(value)
    ?.toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_') ?? null

export const uniqueStrings = (values: Array<string | null | undefined>) => [
  ...new Set(values.filter(Boolean) as string[]),
]

export const stringList = (value: unknown) =>
  Array.isArray(value) ? uniqueStrings(value.map((item) => normalizeReason(item))) : []

export const stringValues = (value: unknown) =>
  Array.isArray(value) ? uniqueStrings(value.map((item) => normalizeNonEmpty(item))) : []

export const parseTimestampMs = (value: string | null | undefined) => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

export const parseNumber = (value: string | null) => {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export const normalizeNumber = (value: unknown) => parseNumber(normalizeNonEmpty(value))

export const normalizeBoolean = (value: unknown) => {
  if (typeof value === 'boolean') return value
  const normalized = normalizeReason(value)
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false
  return false
}
