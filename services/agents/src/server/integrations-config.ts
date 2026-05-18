type EnvSource = Record<string, string | undefined>

const DEFAULT_NATS_URL = 'nats://nats.nats.svc.cluster.local:4222'
const DEFAULT_FEATURE_FLAGS_TIMEOUT_MS = 500
const DEFAULT_FEATURE_FLAGS_NAMESPACE = 'default'
const DEFAULT_FEATURE_FLAGS_ENTITY_ID = 'agents'
const DEFAULT_AGENT_COMMS_FILTER_SUBJECTS = [
  'workflow.>',
  'agents.workflow.>',
  'argo.workflow.>',
  'workflow_comms.agent_messages.>',
]

const TRUE_BOOLEAN_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled'])
const FALSE_BOOLEAN_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled'])

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const readAgentsEnv = (env: EnvSource, name: string) =>
  env[name] ?? (name.startsWith('AGENTS_') ? env[`JANGAR_${name.slice('AGENTS_'.length)}`] : undefined)

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  const normalized = normalizeNonEmpty(value)?.toLowerCase()
  if (!normalized) return fallback
  if (TRUE_BOOLEAN_VALUES.has(normalized)) return true
  if (FALSE_BOOLEAN_VALUES.has(normalized)) return false
  return fallback
}

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

const parseFilterSubjects = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((subject) => subject.trim())
    .filter((subject) => subject.length > 0)

export type AgentCommsSubscriberConfig = {
  disabled: boolean
  natsUrl: string
  natsUser?: string
  natsPassword?: string
  streamName: string
  consumerName: string
  pullBatchSize: number
  pullExpiresMs: number
  reconnectDelayMs: number
  maxAckPending: number
  ackWaitMs: number
  consumerDescription: string
  filterSubjects: string[]
}

export type FeatureFlagsClientConfig = {
  enabled: boolean
  endpoint: string | null
  timeoutMs: number
  namespaceKey: string
  entityId: string
}

export const resolveAgentCommsSubscriberConfig = (env: EnvSource = process.env): AgentCommsSubscriberConfig => {
  const filterSubjects = parseFilterSubjects(readAgentsEnv(env, 'AGENTS_AGENT_COMMS_SUBJECTS'))
  return {
    disabled:
      env.NODE_ENV === 'test' ||
      Boolean(env.VITEST) ||
      readAgentsEnv(env, 'AGENTS_AGENT_COMMS_SUBSCRIBER_DISABLED') === 'true',
    natsUrl: normalizeNonEmpty(env.NATS_URL) ?? DEFAULT_NATS_URL,
    natsUser: normalizeNonEmpty(env.NATS_USER) ?? undefined,
    natsPassword: normalizeNonEmpty(env.NATS_PASSWORD) ?? undefined,
    streamName: 'agent-comms',
    consumerName: 'agents-agent-comms',
    pullBatchSize: 250,
    pullExpiresMs: 1500,
    reconnectDelayMs: 2000,
    maxAckPending: 20000,
    ackWaitMs: 30000,
    consumerDescription: 'Agents communications dependency check',
    filterSubjects: filterSubjects.length > 0 ? filterSubjects : [...DEFAULT_AGENT_COMMS_FILTER_SUBJECTS],
  }
}

export const resolveFeatureFlagsClientConfig = (env: EnvSource = process.env): FeatureFlagsClientConfig => ({
  enabled: parseBoolean(readAgentsEnv(env, 'AGENTS_FEATURE_FLAGS_ENABLED'), true),
  endpoint: normalizeNonEmpty(readAgentsEnv(env, 'AGENTS_FEATURE_FLAGS_URL'))?.replace(/\/+$/, '') ?? null,
  timeoutMs: parsePositiveInt(readAgentsEnv(env, 'AGENTS_FEATURE_FLAGS_TIMEOUT_MS'), DEFAULT_FEATURE_FLAGS_TIMEOUT_MS),
  namespaceKey:
    normalizeNonEmpty(readAgentsEnv(env, 'AGENTS_FEATURE_FLAGS_NAMESPACE')) ?? DEFAULT_FEATURE_FLAGS_NAMESPACE,
  entityId: normalizeNonEmpty(readAgentsEnv(env, 'AGENTS_FEATURE_FLAGS_ENTITY_ID')) ?? DEFAULT_FEATURE_FLAGS_ENTITY_ID,
})

export const validateIntegrationsConfig = (env: EnvSource = process.env) => {
  const agentComms = resolveAgentCommsSubscriberConfig(env)
  if (!agentComms.disabled) {
    try {
      new URL(agentComms.natsUrl)
    } catch {
      throw new Error(`NATS_URL is invalid: ${agentComms.natsUrl}`)
    }
  }

  const featureFlags = resolveFeatureFlagsClientConfig(env)
  if (featureFlags.endpoint) {
    try {
      new URL(featureFlags.endpoint)
    } catch {
      throw new Error(`AGENTS_FEATURE_FLAGS_URL is invalid: ${featureFlags.endpoint}`)
    }
  }
}
