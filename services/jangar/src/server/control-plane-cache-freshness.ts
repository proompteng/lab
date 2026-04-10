import { resolveControlPlaneCacheFreshnessConfig, type ControlPlaneCacheFreshnessConfig } from './control-plane-config'

type TimestampValue = string | Date | null | undefined

export type CacheFreshnessState = {
  isFresh: boolean
  isStale: boolean
  stale: boolean
  maxAgeSeconds: number
  asOf: string | null
  checkedAt: string
  ageSeconds: number | null
}

const parseTimestamp = (value: TimestampValue) => {
  if (!value) return null
  if (value instanceof Date && Number.isFinite(value.getTime())) return value
  if (value instanceof Date) return null
  const normalized = new Date(value)
  if (Number.isNaN(normalized.getTime())) return null
  return normalized
}

export const resolveCacheFreshnessConfig = (): ControlPlaneCacheFreshnessConfig =>
  resolveControlPlaneCacheFreshnessConfig(process.env)

export const buildCacheFreshnessState = (
  lastSeenAt: TimestampValue,
  checkedAt = new Date(),
  config: ControlPlaneCacheFreshnessConfig = resolveCacheFreshnessConfig(),
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
