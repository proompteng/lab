const CACHE_STALE_SECONDS_DEFAULT = 120
const CACHE_BOOL_TRUE = new Set(['1', 'true', 'yes', 'on', 'enabled'])

type TimestampValue = string | Date | null | undefined

export type CacheFreshnessConfig = {
  maxAgeSeconds: number
  allowStale: boolean
}

export type CacheFreshnessState = {
  isFresh: boolean
  isStale: boolean
  stale: boolean
  maxAgeSeconds: number
  asOf: string | null
  checkedAt: string
  ageSeconds: number | null
}

const parseBoolean = (value: string | undefined) => {
  if (!value) return null
  return CACHE_BOOL_TRUE.has(value.trim().toLowerCase())
}

const parsePositiveSeconds = (value: string | undefined, fallback: number) => {
  if (!value) return fallback
  const parsed = Number.parseInt(value.trim(), 10)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return parsed
}

const parseTimestamp = (value: TimestampValue) => {
  if (!value) return null
  if (value instanceof Date && Number.isFinite(value.getTime())) return value
  if (value instanceof Date) return null
  const normalized = new Date(value)
  if (Number.isNaN(normalized.getTime())) return null
  return normalized
}

export const resolveCacheFreshnessConfig = (): CacheFreshnessConfig => ({
  maxAgeSeconds: parsePositiveSeconds(
    process.env.JANGAR_CONTROL_PLANE_CACHE_STALE_SECONDS,
    CACHE_STALE_SECONDS_DEFAULT,
  ),
  allowStale: parseBoolean(process.env.JANGAR_CONTROL_PLANE_CACHE_ALLOW_STALE) ?? true,
})

export const buildCacheFreshnessState = (
  lastSeenAt: TimestampValue,
  checkedAt = new Date(),
  config: CacheFreshnessConfig = resolveCacheFreshnessConfig(),
): CacheFreshnessState => {
  const parsed = parseTimestamp(lastSeenAt)
  const maxAgeMs = config.maxAgeSeconds * 1000
  const checkedIso = checkedAt.toISOString()
  if (!parsed) {
    return {
      isFresh: false,
      isStale: true,
      stale: true,
      maxAgeSeconds: config.maxAgeSeconds,
      asOf: null,
      checkedAt: checkedIso,
      ageSeconds: null,
    }
  }

  const ageMs = checkedAt.getTime() - parsed.getTime()
  const ageSeconds = ageMs > 0 ? Math.floor(ageMs / 1000) : 0

  const isFresh = ageMs >= 0 && ageMs <= maxAgeMs
  return {
    isFresh,
    isStale: !isFresh,
    stale: !isFresh,
    maxAgeSeconds: config.maxAgeSeconds,
    asOf: parsed.toISOString(),
    checkedAt: checkedIso,
    ageSeconds,
  }
}

export const cacheStateToResponse = (state: CacheFreshnessState) => ({
  source: 'control-plane-cache',
  age_seconds: state.ageSeconds,
  max_age_seconds: state.maxAgeSeconds,
  as_of: state.asOf,
  checked_at: state.checkedAt,
  stale: state.stale,
  fresh: state.isFresh,
})
