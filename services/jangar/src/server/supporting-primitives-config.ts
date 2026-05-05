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

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  const normalized = normalizeNonEmpty(value)?.toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

export type SupportingPrimitivesConfig = {
  swarmRequirementMaxDispatchPerReconcile: number
  swarmRequirementMaxPayloadBytes: number
  swarmRequirementMaxAttempts: number
  swarmRuntimeAdmissionEnforcement: boolean
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
  swarmRuntimeAdmissionEnforcement: parseBoolean(env.JANGAR_SWARM_RUNTIME_ADMISSION_ENFORCEMENT, true),
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
