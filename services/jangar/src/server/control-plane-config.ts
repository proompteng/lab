type EnvSource = Record<string, string | undefined>

const DEFAULT_EXECUTION_TRUST_SWARMS = ['jangar-control-plane', 'torghut-quant']
const DEFAULT_EXECUTION_TRUST_SUMMARY_LIMIT = 20
const DEFAULT_TORGHUT_STATUS_TIMEOUT_MS = 15000
const DEFAULT_STATUS_CACHE_TTL_MS = 0
const DEFAULT_STATUS_CACHE_MAX_ENTRIES = 32

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const parsePositiveInt = (value: string | undefined, fallback: number, minimum = 1, maximum?: number) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed)) return fallback
  if (parsed < minimum) return fallback
  const bounded = Math.floor(parsed)
  return maximum === undefined ? bounded : Math.min(bounded, maximum)
}

const parseStringList = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)

const uniqueStrings = (values: string[]) => [...new Set(values)]

const normalizeUrl = (value: string | undefined) => {
  const normalized = normalizeNonEmpty(value)
  return normalized ? normalized.replace(/\/+$/, '') : null
}

export type ControlPlaneStatusConfig = {
  executionTrustSwarms: string[]
  executionTrustSummaryLimit: number
  torghutStatusUrl: string | null
  torghutStatusTimeoutMs: number
  statusCacheTtlMs: number
  statusCacheMaxEntries: number
}

export const isRuntimeTestEnv = (env: EnvSource = process.env) =>
  env.NODE_ENV === 'test' || Boolean(env.VITEST) || Boolean(env.VITEST_POOL_ID) || Boolean(env.VITEST_WORKER_ID)

export const resolveControlPlaneStatusConfig = (env: EnvSource = process.env): ControlPlaneStatusConfig => {
  const executionTrustSwarms = uniqueStrings(parseStringList(env.JANGAR_CONTROL_PLANE_EXECUTION_TRUST_SWARMS))

  return {
    executionTrustSwarms: executionTrustSwarms.length > 0 ? executionTrustSwarms : [...DEFAULT_EXECUTION_TRUST_SWARMS],
    executionTrustSummaryLimit: parsePositiveInt(
      env.JANGAR_CONTROL_PLANE_EXECUTION_TRUST_SUMMARY_LIMIT,
      DEFAULT_EXECUTION_TRUST_SUMMARY_LIMIT,
      1,
      100,
    ),
    torghutStatusUrl: normalizeUrl(env.JANGAR_TORGHUT_STATUS_URL),
    torghutStatusTimeoutMs: parsePositiveInt(
      env.JANGAR_TORGHUT_STATUS_TIMEOUT_MS,
      DEFAULT_TORGHUT_STATUS_TIMEOUT_MS,
      100,
      30_000,
    ),
    statusCacheTtlMs: parsePositiveInt(
      env.JANGAR_CONTROL_PLANE_STATUS_CACHE_TTL_MS,
      DEFAULT_STATUS_CACHE_TTL_MS,
      0,
      60_000,
    ),
    statusCacheMaxEntries: parsePositiveInt(
      env.JANGAR_CONTROL_PLANE_STATUS_CACHE_MAX_ENTRIES,
      DEFAULT_STATUS_CACHE_MAX_ENTRIES,
      1,
      256,
    ),
  }
}

export const validateControlPlaneConfig = (env: EnvSource = process.env) => {
  const status = resolveControlPlaneStatusConfig(env)
  if (status.torghutStatusUrl) {
    try {
      new URL(status.torghutStatusUrl)
    } catch {
      throw new Error(`JANGAR_TORGHUT_STATUS_URL is invalid: ${status.torghutStatusUrl}`)
    }
  }
}
