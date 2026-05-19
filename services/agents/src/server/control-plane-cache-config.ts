type EnvSource = Record<string, string | undefined>

const DEFAULT_CACHE_CLUSTER_ID = 'default'

export type ControlPlaneCacheReadConfig = {
  enabled: boolean
  clusterId: string
}

export type ControlPlaneCacheFreshnessConfig = {
  maxAgeSeconds: number
  allowStale: boolean
}

export const isRuntimeTestEnv = (env: EnvSource = process.env) =>
  env.NODE_ENV === 'test' || Boolean(env.VITEST) || Boolean(env.VITEST_POOL_ID) || Boolean(env.VITEST_WORKER_ID)

const readEnv = (env: EnvSource, agentsName: string, legacyJangarName: string) =>
  env[agentsName]?.trim() || env[legacyJangarName]?.trim() || undefined

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

const parsePositiveInt = (value: string | undefined, fallback: number, minimum = 1, maximum?: number) => {
  const normalized = value?.trim()
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed)) return fallback
  if (parsed < minimum) return fallback
  const bounded = Math.floor(parsed)
  return maximum === undefined ? bounded : Math.min(bounded, maximum)
}

export const resolveControlPlaneCacheReadConfig = (env: EnvSource = process.env): ControlPlaneCacheReadConfig => ({
  enabled: parseBoolean(
    readEnv(env, 'AGENTS_CONTROL_PLANE_CACHE_ENABLED', 'JANGAR_CONTROL_PLANE_CACHE_ENABLED'),
    false,
  ),
  clusterId:
    readEnv(env, 'AGENTS_CONTROL_PLANE_CACHE_CLUSTER', 'JANGAR_CONTROL_PLANE_CACHE_CLUSTER') ??
    DEFAULT_CACHE_CLUSTER_ID,
})

export const resolveControlPlaneCacheFreshnessConfig = (
  env: EnvSource = process.env,
): ControlPlaneCacheFreshnessConfig => ({
  maxAgeSeconds: parsePositiveInt(
    readEnv(env, 'AGENTS_CONTROL_PLANE_CACHE_STALE_SECONDS', 'JANGAR_CONTROL_PLANE_CACHE_STALE_SECONDS'),
    120,
    0,
  ),
  allowStale: parseBoolean(
    readEnv(env, 'AGENTS_CONTROL_PLANE_CACHE_ALLOW_STALE', 'JANGAR_CONTROL_PLANE_CACHE_ALLOW_STALE'),
    true,
  ),
})

export const __private = {
  parseBoolean,
  parsePositiveInt,
  readEnv,
}
