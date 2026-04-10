type EnvSource = Record<string, string | undefined>

type ControllerToggleConfig = {
  enabled: boolean
  namespaces: string[]
  enabledFlagKey: string
}

export type ControlPlaneCacheConfig = {
  enabled: boolean
  namespaces: string[]
  clusterId: string
}

export type OrchestrationControllerConfig = ControllerToggleConfig
export type PrimitivesReconcilerConfig = ControllerToggleConfig
export type SupportingControllerConfig = ControllerToggleConfig

const DNS_LABEL_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

const parseBooleanEnv = (value: string | undefined, fallback: boolean) => {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

const parseNamespaces = (raw: string | undefined, fallback: string[], label: string, clusterScoped: boolean) => {
  const values =
    raw && raw.trim()
      ? raw
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      : fallback

  const unique = [...new Set(values)]
  if (unique.length === 0) {
    throw new Error(`[jangar] ${label} namespaces cannot be empty`)
  }
  if (unique.includes('*') && !clusterScoped) {
    throw new Error(`[jangar] ${label} namespaces '*' require JANGAR_RBAC_CLUSTER_SCOPED=true`)
  }
  for (const namespace of unique) {
    if (namespace === '*') continue
    if (!DNS_LABEL_REGEX.test(namespace)) {
      throw new Error(`[jangar] ${label} namespace '${namespace}' must be a valid DNS label`)
    }
  }
  return unique
}

export const isControllerClusterScoped = (env: EnvSource = process.env) =>
  parseBooleanEnv(env.JANGAR_RBAC_CLUSTER_SCOPED, false)

export const resolveControlPlaneCacheConfig = (env: EnvSource = process.env): ControlPlaneCacheConfig => ({
  enabled: parseBooleanEnv(env.JANGAR_CONTROL_PLANE_CACHE_ENABLED, false),
  namespaces: parseNamespaces(
    env.JANGAR_CONTROL_PLANE_CACHE_NAMESPACES ?? env.JANGAR_PRIMITIVES_NAMESPACES,
    ['agents'],
    'control plane cache',
    isControllerClusterScoped(env),
  ),
  clusterId: env.JANGAR_CONTROL_PLANE_CACHE_CLUSTER?.trim() || 'default',
})

export const resolveOrchestrationControllerConfig = (env: EnvSource = process.env): OrchestrationControllerConfig => ({
  enabled: parseBooleanEnv(env.JANGAR_ORCHESTRATION_CONTROLLER_ENABLED, true),
  namespaces: parseNamespaces(
    env.JANGAR_ORCHESTRATION_CONTROLLER_NAMESPACES,
    ['agents'],
    'orchestration controller',
    isControllerClusterScoped(env),
  ),
  enabledFlagKey:
    env.JANGAR_ORCHESTRATION_CONTROLLER_ENABLED_FLAG_KEY?.trim() || 'jangar.orchestration_controller.enabled',
})

export const resolvePrimitivesReconcilerConfig = (env: EnvSource = process.env): PrimitivesReconcilerConfig => ({
  enabled: parseBooleanEnv(env.JANGAR_PRIMITIVES_RECONCILER, true),
  namespaces: parseNamespaces(
    env.JANGAR_PRIMITIVES_NAMESPACES,
    ['jangar'],
    'primitives reconciler',
    isControllerClusterScoped(env),
  ),
  enabledFlagKey: env.JANGAR_PRIMITIVES_RECONCILER_FLAG_KEY?.trim() || 'jangar.primitives_reconciler.enabled',
})

export const resolveSupportingControllerConfig = (env: EnvSource = process.env): SupportingControllerConfig => ({
  enabled: parseBooleanEnv(env.JANGAR_SUPPORTING_CONTROLLER_ENABLED, true),
  namespaces: parseNamespaces(
    env.JANGAR_SUPPORTING_CONTROLLER_NAMESPACES,
    ['agents'],
    'supporting controller',
    isControllerClusterScoped(env),
  ),
  enabledFlagKey: env.JANGAR_SUPPORTING_CONTROLLER_ENABLED_FLAG_KEY?.trim() || 'jangar.supporting_controller.enabled',
})

export const validateControllerRuntimeConfig = (env: EnvSource = process.env) => {
  resolveControlPlaneCacheConfig(env)
  resolveOrchestrationControllerConfig(env)
  resolvePrimitivesReconcilerConfig(env)
  resolveSupportingControllerConfig(env)
}

export const __private = {
  parseBooleanEnv,
  parseNamespaces,
}
