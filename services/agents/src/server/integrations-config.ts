import { normalizeEnvValue, parseBooleanEnv, parsePositiveIntEnv, readAgentsEnv, type EnvSource } from './runtime-env'

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
  const filterSubjects = parseFilterSubjects(readAgentsEnv(env, 'AGENTS_AGENT_COMMS_SUBJECTS') ?? undefined)
  return {
    disabled:
      env.NODE_ENV === 'test' ||
      Boolean(env.VITEST) ||
      readAgentsEnv(env, 'AGENTS_AGENT_COMMS_SUBSCRIBER_DISABLED') === 'true',
    natsUrl: normalizeEnvValue(env.NATS_URL) ?? DEFAULT_NATS_URL,
    natsUser: normalizeEnvValue(env.NATS_USER) ?? undefined,
    natsPassword: normalizeEnvValue(env.NATS_PASSWORD) ?? undefined,
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
  enabled: parseBooleanEnv(readAgentsEnv(env, 'AGENTS_FEATURE_FLAGS_ENABLED'), true),
  endpoint: normalizeEnvValue(readAgentsEnv(env, 'AGENTS_FEATURE_FLAGS_URL'))?.replace(/\/+$/, '') ?? null,
  timeoutMs: parsePositiveIntEnv(
    readAgentsEnv(env, 'AGENTS_FEATURE_FLAGS_TIMEOUT_MS'),
    DEFAULT_FEATURE_FLAGS_TIMEOUT_MS,
  ),
  namespaceKey:
    normalizeEnvValue(readAgentsEnv(env, 'AGENTS_FEATURE_FLAGS_NAMESPACE')) ?? DEFAULT_FEATURE_FLAGS_NAMESPACE,
  entityId: normalizeEnvValue(readAgentsEnv(env, 'AGENTS_FEATURE_FLAGS_ENTITY_ID')) ?? DEFAULT_FEATURE_FLAGS_ENTITY_ID,
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
