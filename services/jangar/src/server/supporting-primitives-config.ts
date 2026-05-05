type EnvSource = Record<string, string | undefined>

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

export type SupportingPrimitivesConfig = {
  swarmRequirementMaxDispatchPerReconcile: number
  swarmRequirementMaxPayloadBytes: number
  swarmRequirementMaxAttempts: number
  swarmDefaultNatsUrl: string
  swarmDefaultNatsSubjectPrefix: string
  swarmDefaultNatsChannel: string
  defaultWorkloadImage: string | null
  scheduleRunnerImage: string
  podNamespace: string | null
  scheduleServiceAccount: string | null
  serviceAccountName: string | null
}

export const resolveSupportingPrimitivesConfig = (env: EnvSource = process.env): SupportingPrimitivesConfig => ({
  swarmRequirementMaxDispatchPerReconcile: parsePositiveInt(env.JANGAR_SWARM_REQUIREMENT_MAX_DISPATCH_PER_RECONCILE, 5),
  swarmRequirementMaxPayloadBytes: parsePositiveInt(env.JANGAR_SWARM_REQUIREMENT_MAX_PAYLOAD_BYTES, 16_384),
  swarmRequirementMaxAttempts: parsePositiveInt(env.JANGAR_SWARM_REQUIREMENT_MAX_ATTEMPTS, 3),
  swarmDefaultNatsUrl:
    normalizeNonEmpty(env.JANGAR_SWARM_NATS_URL) ??
    normalizeNonEmpty(env.NATS_URL) ??
    'nats://nats.nats.svc.cluster.local:4222',
  swarmDefaultNatsSubjectPrefix: normalizeNonEmpty(env.JANGAR_SWARM_NATS_SUBJECT_PREFIX) ?? 'workflow',
  swarmDefaultNatsChannel: normalizeNonEmpty(env.JANGAR_SWARM_NATS_CHANNEL) ?? 'general',
  defaultWorkloadImage:
    normalizeNonEmpty(env.JANGAR_AGENT_RUNNER_IMAGE) ?? normalizeNonEmpty(env.JANGAR_AGENT_IMAGE) ?? null,
  scheduleRunnerImage:
    normalizeNonEmpty(env.JANGAR_SCHEDULE_RUNNER_IMAGE) ??
    normalizeNonEmpty(env.JANGAR_IMAGE) ??
    'ghcr.io/proompteng/jangar:latest',
  podNamespace: normalizeNonEmpty(env.JANGAR_POD_NAMESPACE),
  scheduleServiceAccount: normalizeNonEmpty(env.JANGAR_SCHEDULE_SERVICE_ACCOUNT),
  serviceAccountName: normalizeNonEmpty(env.JANGAR_SERVICE_ACCOUNT_NAME),
})

export const validateSupportingPrimitivesConfig = (env: EnvSource = process.env) => {
  resolveSupportingPrimitivesConfig(env)
}
