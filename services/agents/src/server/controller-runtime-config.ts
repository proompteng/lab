import { readAgentsEnv, type EnvSource } from './runtime-env'

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
    throw new Error(`[agents] ${label} namespaces cannot be empty`)
  }
  if (unique.includes('*') && !clusterScoped) {
    throw new Error(`[agents] ${label} namespaces '*' require AGENTS_RBAC_CLUSTER_SCOPED=true`)
  }
  for (const namespace of unique) {
    if (namespace === '*') continue
    if (!DNS_LABEL_REGEX.test(namespace)) {
      throw new Error(`[agents] ${label} namespace '${namespace}' must be a valid DNS label`)
    }
  }
  return unique
}

export const isControllerClusterScoped = (env: EnvSource = process.env) =>
  parseBooleanEnv(readAgentsEnv(env, 'AGENTS_RBAC_CLUSTER_SCOPED') ?? undefined, false)

export const isSwarmPrimitiveEnabled = (env: EnvSource = process.env) =>
  parseBooleanEnv(env.AGENTS_SWARM_PRIMITIVE_ENABLED, false)

export const resolveControlPlaneCacheConfig = (env: EnvSource = process.env): ControlPlaneCacheConfig => ({
  enabled: parseBooleanEnv(readAgentsEnv(env, 'AGENTS_CONTROL_PLANE_CACHE_ENABLED') ?? undefined, false),
  namespaces: parseNamespaces(
    readAgentsEnv(env, 'AGENTS_CONTROL_PLANE_CACHE_NAMESPACES') ??
      readAgentsEnv(env, 'AGENTS_PRIMITIVES_NAMESPACES') ??
      undefined,
    ['agents'],
    'control plane cache',
    isControllerClusterScoped(env),
  ),
  clusterId: readAgentsEnv(env, 'AGENTS_CONTROL_PLANE_CACHE_CLUSTER') || 'default',
})

export const resolveOrchestrationControllerConfig = (env: EnvSource = process.env): OrchestrationControllerConfig => ({
  enabled: parseBooleanEnv(readAgentsEnv(env, 'AGENTS_ORCHESTRATION_CONTROLLER_ENABLED') ?? undefined, true),
  namespaces: parseNamespaces(
    readAgentsEnv(env, 'AGENTS_ORCHESTRATION_CONTROLLER_NAMESPACES') ?? undefined,
    ['agents'],
    'orchestration controller',
    isControllerClusterScoped(env),
  ),
  enabledFlagKey:
    readAgentsEnv(env, 'AGENTS_ORCHESTRATION_CONTROLLER_ENABLED_FLAG_KEY') || 'agents.orchestration_controller.enabled',
})

export const resolvePrimitivesReconcilerConfig = (env: EnvSource = process.env): PrimitivesReconcilerConfig => ({
  enabled: parseBooleanEnv(readAgentsEnv(env, 'AGENTS_PRIMITIVES_RECONCILER') ?? undefined, true),
  namespaces: parseNamespaces(
    readAgentsEnv(env, 'AGENTS_PRIMITIVES_NAMESPACES') ?? undefined,
    ['agents'],
    'primitives reconciler',
    isControllerClusterScoped(env),
  ),
  enabledFlagKey: readAgentsEnv(env, 'AGENTS_PRIMITIVES_RECONCILER_FLAG_KEY') || 'agents.primitives_reconciler.enabled',
})

export const resolveSupportingControllerConfig = (env: EnvSource = process.env): SupportingControllerConfig => ({
  enabled: parseBooleanEnv(readAgentsEnv(env, 'AGENTS_SUPPORTING_CONTROLLER_ENABLED') ?? undefined, true),
  namespaces: parseNamespaces(
    readAgentsEnv(env, 'AGENTS_SUPPORTING_CONTROLLER_NAMESPACES') ?? undefined,
    ['agents'],
    'supporting controller',
    isControllerClusterScoped(env),
  ),
  enabledFlagKey:
    readAgentsEnv(env, 'AGENTS_SUPPORTING_CONTROLLER_ENABLED_FLAG_KEY') || 'agents.supporting_controller.enabled',
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
  readEnv: readAgentsEnv,
}
