import { asRecord } from '../primitives'

type EnvSource = Record<string, string | undefined>

const DEFAULT_AUTH_SECRET_KEY = 'auth.json'
const DEFAULT_AUTH_SECRET_MOUNT_PATH = '/root/.codex'
const DEFAULT_AGENTRUN_RESYNC_INTERVAL_SECONDS = 60
const DEFAULT_AGENTRUN_UNTOUCHED_WARN_AFTER_SECONDS = 120
const DEFAULT_AGENTRUN_IDEMPOTENCY_RETENTION_DAYS = 30
const DEFAULT_RUNNER_JOB_TTL_SECONDS = 600
const DEFAULT_RUNNER_LOG_RETENTION_SECONDS = 7 * 24 * 60 * 60
const DEFAULT_RUNTIME_DEBRIS_ORPHAN_POD_RETENTION_SECONDS = 24 * 60 * 60
const DEFAULT_RUNTIME_DEBRIS_MAX_DELETES_PER_NAMESPACE = 25

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

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.floor(parsed)
}

const parseCleanupMode = (value: string | undefined): RuntimeDebrisCleanupMode => {
  const normalized = normalizeNonEmpty(value)?.toLowerCase()
  if (normalized === 'audit' || normalized === 'delete') return normalized
  return 'disabled'
}

const parseJson = (value: string | undefined) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return null
  try {
    return JSON.parse(normalized) as unknown
  } catch {
    return null
  }
}

const readAgentsEnv = (env: EnvSource, name: string): string | undefined => {
  return env[name]
}

export type AgentsControllerBehaviorConfig = {
  enabled: boolean
  vcsProvidersEnabled: boolean
  agentRunImmutabilityEnforced: boolean
  debugLogs: boolean
  resyncIntervalSeconds: number
  untouchedWarnAfterSeconds: number
  agentRunIdempotencyEnabled: boolean
  agentRunIdempotencyRetentionDays: number
  agentRunRetentionSeconds: number | null
  artifactsMaxEntries: number
  artifactsStrict: boolean
}

export type RuntimeDebrisCleanupMode = 'disabled' | 'audit' | 'delete'

export type RuntimeDebrisCleanupConfig = {
  maxDeletesPerNamespace: number
  mode: RuntimeDebrisCleanupMode
  orphanPodRetentionSeconds: number
}

export type AgentsControllerAuthSecretConfig = {
  name: string
  key: string
  mountPath: string
} | null

export type AgentRunnerDefaultsConfig = {
  serviceAccount: string | null
  jobTtlSeconds: number
  logRetentionSeconds: number
  backoffLimit: number | null
  priorityClassName: string | null
  schedulerName: string | null
  nodeSelector: Record<string, unknown> | null
  tolerations: unknown[] | null
  topologySpreadConstraints: unknown[] | null
  affinity: Record<string, unknown> | null
  podSecurityContext: Record<string, unknown> | null
  imagePullSecrets: unknown[] | null
  resources: Record<string, unknown> | null
  defaultRunnerImage: string | null
}

export type ImplementationSourceWebhookConfig = {
  namespacesRaw: string | null
  queueSize: number | null
  retryBaseDelaySeconds: number | null
  retryMaxDelaySeconds: number | null
  retryMaxAttempts: number | null
}

export const isRuntimeTestEnv = (env: EnvSource = process.env) => env.NODE_ENV === 'test' || Boolean(env.VITEST)

export const resolveAgentsControllerBehaviorConfig = (
  env: EnvSource = process.env,
): AgentsControllerBehaviorConfig => ({
  enabled: !isRuntimeTestEnv(env) && parseBoolean(readAgentsEnv(env, 'AGENTS_CONTROLLER_ENABLED'), true),
  vcsProvidersEnabled: parseBoolean(readAgentsEnv(env, 'AGENTS_CONTROLLER_VCS_PROVIDERS_ENABLED'), true),
  agentRunImmutabilityEnforced: parseBoolean(readAgentsEnv(env, 'AGENTS_AGENTRUN_IMMUTABILITY_ENFORCED'), true),
  debugLogs: parseBoolean(readAgentsEnv(env, 'AGENTS_CONTROLLER_DEBUG_LOGS'), false),
  resyncIntervalSeconds: Math.max(
    1,
    parsePositiveInt(
      readAgentsEnv(env, 'AGENTS_CONTROLLER_RESYNC_INTERVAL_SECONDS'),
      DEFAULT_AGENTRUN_RESYNC_INTERVAL_SECONDS,
    ),
  ),
  untouchedWarnAfterSeconds: Math.max(
    1,
    parsePositiveInt(
      readAgentsEnv(env, 'AGENTS_CONTROLLER_UNTOUCHED_WARN_AFTER_SECONDS'),
      DEFAULT_AGENTRUN_UNTOUCHED_WARN_AFTER_SECONDS,
    ),
  ),
  agentRunIdempotencyEnabled: parseBoolean(readAgentsEnv(env, 'AGENTS_AGENTRUN_IDEMPOTENCY_ENABLED'), true),
  agentRunIdempotencyRetentionDays: Math.max(
    1,
    parsePositiveInt(
      readAgentsEnv(env, 'AGENTS_AGENTRUN_IDEMPOTENCY_RETENTION_DAYS'),
      DEFAULT_AGENTRUN_IDEMPOTENCY_RETENTION_DAYS,
    ),
  ),
  agentRunRetentionSeconds: normalizeNonEmpty(readAgentsEnv(env, 'AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS'))
    ? parsePositiveInt(readAgentsEnv(env, 'AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS'), 0)
    : null,
  artifactsMaxEntries: Math.min(
    50,
    Math.max(0, parsePositiveInt(readAgentsEnv(env, 'AGENTS_AGENTRUN_ARTIFACTS_MAX'), 50)),
  ),
  artifactsStrict: parseBoolean(readAgentsEnv(env, 'AGENTS_AGENTRUN_ARTIFACTS_STRICT'), false),
})

export const resolveAgentsControllerAuthSecretConfig = (
  env: EnvSource = process.env,
): AgentsControllerAuthSecretConfig => {
  const name = normalizeNonEmpty(readAgentsEnv(env, 'AGENTS_CONTROLLER_AUTH_SECRET_NAME'))
  if (!name) return null
  return {
    name,
    key: normalizeNonEmpty(readAgentsEnv(env, 'AGENTS_CONTROLLER_AUTH_SECRET_KEY')) ?? DEFAULT_AUTH_SECRET_KEY,
    mountPath:
      normalizeNonEmpty(readAgentsEnv(env, 'AGENTS_CONTROLLER_AUTH_SECRET_MOUNT_PATH')) ??
      DEFAULT_AUTH_SECRET_MOUNT_PATH,
  }
}

export const resolveRuntimeDebrisCleanupConfig = (env: EnvSource = process.env): RuntimeDebrisCleanupConfig => ({
  maxDeletesPerNamespace: Math.max(
    0,
    parsePositiveInt(
      readAgentsEnv(env, 'AGENTS_CONTROLLER_RUNTIME_DEBRIS_MAX_DELETES_PER_NAMESPACE'),
      DEFAULT_RUNTIME_DEBRIS_MAX_DELETES_PER_NAMESPACE,
    ),
  ),
  mode: parseCleanupMode(readAgentsEnv(env, 'AGENTS_CONTROLLER_RUNTIME_DEBRIS_CLEANUP_MODE')),
  orphanPodRetentionSeconds: Math.max(
    0,
    parsePositiveInt(
      readAgentsEnv(env, 'AGENTS_CONTROLLER_ORPHAN_POD_RETENTION_SECONDS'),
      DEFAULT_RUNTIME_DEBRIS_ORPHAN_POD_RETENTION_SECONDS,
    ),
  ),
})

export const resolveAgentRunnerDefaultsConfig = (env: EnvSource = process.env): AgentRunnerDefaultsConfig => {
  const nodeSelector = asRecord(parseJson(readAgentsEnv(env, 'AGENTS_AGENT_RUNNER_NODE_SELECTOR')))
  const affinity = asRecord(parseJson(readAgentsEnv(env, 'AGENTS_AGENT_RUNNER_AFFINITY')))
  const podSecurityContext = asRecord(parseJson(readAgentsEnv(env, 'AGENTS_AGENT_RUNNER_POD_SECURITY_CONTEXT')))
  const tolerations = parseJson(readAgentsEnv(env, 'AGENTS_AGENT_RUNNER_TOLERATIONS'))
  const topologySpreadConstraints = parseJson(readAgentsEnv(env, 'AGENTS_AGENT_RUNNER_TOPOLOGY_SPREAD_CONSTRAINTS'))
  const imagePullSecrets = parseJson(readAgentsEnv(env, 'AGENTS_AGENT_RUNNER_IMAGE_PULL_SECRETS'))
  const resources = asRecord(parseJson(readAgentsEnv(env, 'AGENTS_AGENT_RUNNER_RESOURCES')))

  return {
    serviceAccount: normalizeNonEmpty(readAgentsEnv(env, 'AGENTS_AGENT_RUNNER_SERVICE_ACCOUNT')),
    jobTtlSeconds: Math.max(
      30,
      parsePositiveInt(readAgentsEnv(env, 'AGENTS_AGENT_RUNNER_JOB_TTL_SECONDS'), DEFAULT_RUNNER_JOB_TTL_SECONDS),
    ),
    logRetentionSeconds: parsePositiveInt(
      readAgentsEnv(env, 'AGENTS_AGENT_RUNNER_LOG_RETENTION_SECONDS'),
      DEFAULT_RUNNER_LOG_RETENTION_SECONDS,
    ),
    backoffLimit: normalizeNonEmpty(readAgentsEnv(env, 'AGENTS_AGENT_RUNNER_BACKOFF_LIMIT'))
      ? parsePositiveInt(readAgentsEnv(env, 'AGENTS_AGENT_RUNNER_BACKOFF_LIMIT'), 0)
      : null,
    priorityClassName: normalizeNonEmpty(readAgentsEnv(env, 'AGENTS_AGENT_RUNNER_PRIORITY_CLASS')),
    schedulerName: normalizeNonEmpty(readAgentsEnv(env, 'AGENTS_AGENT_RUNNER_SCHEDULER_NAME')),
    nodeSelector,
    tolerations: Array.isArray(tolerations) ? tolerations : null,
    topologySpreadConstraints: Array.isArray(topologySpreadConstraints) ? topologySpreadConstraints : null,
    affinity,
    podSecurityContext,
    imagePullSecrets: Array.isArray(imagePullSecrets) ? imagePullSecrets : null,
    resources,
    defaultRunnerImage: normalizeNonEmpty(readAgentsEnv(env, 'AGENTS_AGENT_RUNNER_IMAGE')) ?? null,
  }
}

export const resolveImplementationSourceWebhookConfig = (
  env: EnvSource = process.env,
): ImplementationSourceWebhookConfig => ({
  namespacesRaw: normalizeNonEmpty(readAgentsEnv(env, 'AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_NAMESPACES')),
  queueSize: normalizeNonEmpty(readAgentsEnv(env, 'AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_QUEUE_SIZE'))
    ? Math.max(1, parsePositiveInt(readAgentsEnv(env, 'AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_QUEUE_SIZE'), 0))
    : null,
  retryBaseDelaySeconds: normalizeNonEmpty(
    readAgentsEnv(env, 'AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_RETRY_BASE_DELAY_SECONDS'),
  )
    ? Math.max(
        0,
        parsePositiveInt(readAgentsEnv(env, 'AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_RETRY_BASE_DELAY_SECONDS'), 0),
      )
    : null,
  retryMaxDelaySeconds: normalizeNonEmpty(
    readAgentsEnv(env, 'AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_RETRY_MAX_DELAY_SECONDS'),
  )
    ? Math.max(
        0,
        parsePositiveInt(readAgentsEnv(env, 'AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_RETRY_MAX_DELAY_SECONDS'), 0),
      )
    : null,
  retryMaxAttempts: normalizeNonEmpty(readAgentsEnv(env, 'AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_RETRY_MAX_ATTEMPTS'))
    ? Math.max(1, parsePositiveInt(readAgentsEnv(env, 'AGENTS_IMPLEMENTATION_SOURCE_WEBHOOK_RETRY_MAX_ATTEMPTS'), 1))
    : null,
})

export const validateAgentsControllerRuntimeConfig = (env: EnvSource = process.env) => {
  resolveAgentsControllerBehaviorConfig(env)
  resolveAgentsControllerAuthSecretConfig(env)
  resolveAgentRunnerDefaultsConfig(env)
  resolveImplementationSourceWebhookConfig(env)
}
