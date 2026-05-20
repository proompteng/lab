type EnvSource = Record<string, string | undefined>

const DEFAULT_CACHE_CLUSTER_ID = 'default'
const DEFAULT_HEARTBEAT_TTL_SECONDS = 120
const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 15
const DEFAULT_EXECUTION_TRUST_SWARMS = ['jangar-control-plane', 'torghut-quant']
const DEFAULT_EXECUTION_TRUST_SUMMARY_LIMIT = 20
const DEFAULT_TORGHUT_STATUS_TIMEOUT_MS = 15000
const DEFAULT_STATUS_CACHE_TTL_MS = 0
const DEFAULT_STATUS_CACHE_MAX_ENTRIES = 32

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  const normalized = normalizeNonEmpty(value)?.toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(normalized)) return false
  return fallback
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

export type ControlPlaneCacheReadConfig = {
  enabled: boolean
  clusterId: string
}

export type ControlPlaneHeartbeatConfig = {
  clusterId: string
  ttlSeconds: number
  intervalSeconds: number
  podName: string
  deploymentName: string
  sourceNamespace: string
}

export type ControlPlaneStatusConfig = {
  executionTrustSwarms: string[]
  executionTrustSummaryLimit: number
  torghutStatusUrl: string | null
  torghutStatusTimeoutMs: number
  statusCacheTtlMs: number
  statusCacheMaxEntries: number
}

export type ControlPlaneCacheFreshnessConfig = {
  maxAgeSeconds: number
  allowStale: boolean
}

export const isRuntimeTestEnv = (env: EnvSource = process.env) =>
  env.NODE_ENV === 'test' || Boolean(env.VITEST) || Boolean(env.VITEST_POOL_ID) || Boolean(env.VITEST_WORKER_ID)

export const resolveControlPlaneCacheReadConfig = (env: EnvSource = process.env): ControlPlaneCacheReadConfig => ({
  enabled: parseBoolean(env.JANGAR_CONTROL_PLANE_CACHE_ENABLED, false),
  clusterId: normalizeNonEmpty(env.JANGAR_CONTROL_PLANE_CACHE_CLUSTER) ?? DEFAULT_CACHE_CLUSTER_ID,
})

export const resolveControlPlaneHeartbeatConfig = (env: EnvSource = process.env): ControlPlaneHeartbeatConfig => {
  const podName = normalizeNonEmpty(env.POD_NAME) ?? normalizeNonEmpty(env.HOSTNAME) ?? 'unknown'
  const deploymentName =
    normalizeNonEmpty(env.JANGAR_DEPLOYMENT_NAME) ??
    normalizeNonEmpty(env.DEPLOYMENT_NAME) ??
    normalizeNonEmpty(env.JANGAR_POD_PREFIX) ??
    podName

  return {
    clusterId: resolveControlPlaneCacheReadConfig(env).clusterId,
    ttlSeconds: parsePositiveInt(env.JANGAR_CONTROL_PLANE_HEARTBEAT_TTL_SECONDS, DEFAULT_HEARTBEAT_TTL_SECONDS, 1),
    intervalSeconds: parsePositiveInt(
      env.JANGAR_CONTROL_PLANE_HEARTBEAT_INTERVAL_SECONDS,
      DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
      1,
    ),
    podName,
    deploymentName,
    sourceNamespace: normalizeNonEmpty(env.JANGAR_POD_NAMESPACE) ?? normalizeNonEmpty(env.POD_NAMESPACE) ?? 'default',
  }
}

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

export const resolveControlPlaneCacheFreshnessConfig = (
  env: EnvSource = process.env,
): ControlPlaneCacheFreshnessConfig => ({
  maxAgeSeconds: parsePositiveInt(env.JANGAR_CONTROL_PLANE_CACHE_STALE_SECONDS, 120, 0),
  allowStale: parseBoolean(env.JANGAR_CONTROL_PLANE_CACHE_ALLOW_STALE, true),
})

export const validateControlPlaneConfig = (env: EnvSource = process.env) => {
  const status = resolveControlPlaneStatusConfig(env)
  if (status.torghutStatusUrl) {
    try {
      new URL(status.torghutStatusUrl)
    } catch {
      throw new Error(`JANGAR_TORGHUT_STATUS_URL is invalid: ${status.torghutStatusUrl}`)
    }
  }

  resolveControlPlaneHeartbeatConfig(env)
  resolveControlPlaneCacheFreshnessConfig(env)
}
