import { parseBooleanEnv, parsePositiveIntEnv, readAgentsEnv, type EnvSource } from './runtime-env'

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

export const resolveControlPlaneCacheReadConfig = (env: EnvSource = process.env): ControlPlaneCacheReadConfig => ({
  enabled: parseBooleanEnv(readAgentsEnv(env, 'AGENTS_CONTROL_PLANE_CACHE_ENABLED'), false),
  clusterId: readAgentsEnv(env, 'AGENTS_CONTROL_PLANE_CACHE_CLUSTER') ?? DEFAULT_CACHE_CLUSTER_ID,
})

export const resolveControlPlaneCacheFreshnessConfig = (
  env: EnvSource = process.env,
): ControlPlaneCacheFreshnessConfig => ({
  maxAgeSeconds: parsePositiveIntEnv(readAgentsEnv(env, 'AGENTS_CONTROL_PLANE_CACHE_STALE_SECONDS'), 120, {
    minimum: 0,
  }),
  allowStale: parseBooleanEnv(readAgentsEnv(env, 'AGENTS_CONTROL_PLANE_CACHE_ALLOW_STALE'), false),
})

export const __private = {
  parseBoolean: parseBooleanEnv,
  parsePositiveInt: parsePositiveIntEnv,
  readEnv: readAgentsEnv,
}
