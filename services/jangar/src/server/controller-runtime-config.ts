import { isAgentsRuntimeService } from './runtime-identity'

type EnvSource = Record<string, string | undefined>

type ControllerToggleConfig = {
  enabled: boolean
  namespaces: string[]
  enabledFlagKey: string
}

export type OrchestrationControllerConfig = ControllerToggleConfig
export type PrimitivesReconcilerConfig = ControllerToggleConfig
export type SupportingControllerConfig = ControllerToggleConfig

const DNS_LABEL_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

const readEnv = (env: EnvSource, name: string) => {
  if (name.startsWith('AGENTS_')) return env[name] ?? env[`JANGAR_${name.slice('AGENTS_'.length)}`]
  if (name.startsWith('JANGAR_')) return env[`AGENTS_${name.slice('JANGAR_'.length)}`] ?? env[name]
  return env[name]
}

const defaultFeatureFlagKey = (env: EnvSource, agentsKey: string, jangarKey: string) =>
  isAgentsRuntimeService(env) ? agentsKey : jangarKey

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
  parseBooleanEnv(readEnv(env, 'AGENTS_RBAC_CLUSTER_SCOPED'), false)

export const resolveOrchestrationControllerConfig = (env: EnvSource = process.env): OrchestrationControllerConfig => ({
  enabled: parseBooleanEnv(readEnv(env, 'AGENTS_ORCHESTRATION_CONTROLLER_ENABLED'), true),
  namespaces: parseNamespaces(
    readEnv(env, 'AGENTS_ORCHESTRATION_CONTROLLER_NAMESPACES'),
    ['agents'],
    'orchestration controller',
    isControllerClusterScoped(env),
  ),
  enabledFlagKey:
    readEnv(env, 'AGENTS_ORCHESTRATION_CONTROLLER_ENABLED_FLAG_KEY')?.trim() ||
    defaultFeatureFlagKey(env, 'agents.orchestration_controller.enabled', 'jangar.orchestration_controller.enabled'),
})

export const resolvePrimitivesReconcilerConfig = (env: EnvSource = process.env): PrimitivesReconcilerConfig => ({
  enabled: parseBooleanEnv(readEnv(env, 'AGENTS_PRIMITIVES_RECONCILER'), true),
  namespaces: parseNamespaces(
    readEnv(env, 'AGENTS_PRIMITIVES_NAMESPACES'),
    ['jangar'],
    'primitives reconciler',
    isControllerClusterScoped(env),
  ),
  enabledFlagKey:
    readEnv(env, 'AGENTS_PRIMITIVES_RECONCILER_FLAG_KEY')?.trim() ||
    defaultFeatureFlagKey(env, 'agents.primitives_reconciler.enabled', 'jangar.primitives_reconciler.enabled'),
})

export const resolveSupportingControllerConfig = (env: EnvSource = process.env): SupportingControllerConfig => ({
  enabled: parseBooleanEnv(readEnv(env, 'AGENTS_SUPPORTING_CONTROLLER_ENABLED'), true),
  namespaces: parseNamespaces(
    readEnv(env, 'AGENTS_SUPPORTING_CONTROLLER_NAMESPACES'),
    ['agents'],
    'supporting controller',
    isControllerClusterScoped(env),
  ),
  enabledFlagKey:
    readEnv(env, 'AGENTS_SUPPORTING_CONTROLLER_ENABLED_FLAG_KEY')?.trim() ||
    defaultFeatureFlagKey(env, 'agents.supporting_controller.enabled', 'jangar.supporting_controller.enabled'),
})

export const validateControllerRuntimeConfig = (env: EnvSource = process.env) => {
  resolveOrchestrationControllerConfig(env)
  resolvePrimitivesReconcilerConfig(env)
  resolveSupportingControllerConfig(env)
}

export const __private = {
  defaultFeatureFlagKey,
  parseBooleanEnv,
  parseNamespaces,
  readEnv,
}
