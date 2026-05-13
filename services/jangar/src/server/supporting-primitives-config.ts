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

const parseStageClearanceEnforcement = (
  value: string | undefined,
): SupportingPrimitivesConfig['stageClearanceEnforcement'] => {
  const normalized = normalizeNonEmpty(value)?.toLowerCase()
  if (normalized === 'disabled' || normalized === 'off' || normalized === 'false') return 'disabled'
  if (normalized === 'hold' || normalized === 'enforce' || normalized === 'enforced') return 'hold'
  return 'shadow'
}

const parseEvidencePressureLedgerMode = (
  value: string | undefined,
): SupportingPrimitivesConfig['evidencePressureLedgerMode'] => {
  const normalized = normalizeNonEmpty(value)?.toLowerCase()
  if (normalized === 'observe' || normalized === 'shadow' || normalized === 'hold' || normalized === 'enforce') {
    return normalized
  }
  return 'observe'
}

const parseStringList = (value: string | undefined) =>
  (normalizeNonEmpty(value) ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

const parseJsonRecord = (value: string | undefined) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return null
  try {
    const parsed = JSON.parse(normalized) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

export type SupportingPrimitivesConfig = {
  swarmRequirementMaxDispatchPerReconcile: number
  swarmRequirementMaxPayloadBytes: number
  swarmRequirementMaxAttempts: number
  swarmRuntimeAdmissionEnforcement: boolean
  swarmRuntimeProofEnforcement: boolean
  stageClearanceEnforcement: 'disabled' | 'shadow' | 'hold'
  stageClearanceHoldStages: string[]
  evidencePressureLedgerMode: 'observe' | 'shadow' | 'hold' | 'enforce'
  scheduleRunnerAdmissionCheck: boolean
  scheduleRunnerAdmissionStatusUrl: string
  scheduleRunnerAdmissionStatusTimeoutMs: number
  swarmDefaultNatsUrl: string
  swarmDefaultNatsSubjectPrefix: string
  swarmDefaultNatsChannel: string
  defaultWorkloadImage: string | null
  scheduleRunnerImage: string
  scheduleRunnerNodeSelector: Record<string, unknown> | null
  podNamespace: string | null
  scheduleServiceAccount: string | null
  serviceAccountName: string | null
}

export const resolveSupportingPrimitivesConfig = (env: EnvSource = process.env): SupportingPrimitivesConfig => ({
  swarmRequirementMaxDispatchPerReconcile: parsePositiveInt(env.JANGAR_SWARM_REQUIREMENT_MAX_DISPATCH_PER_RECONCILE, 5),
  swarmRequirementMaxPayloadBytes: parsePositiveInt(env.JANGAR_SWARM_REQUIREMENT_MAX_PAYLOAD_BYTES, 16_384),
  swarmRequirementMaxAttempts: parsePositiveInt(env.JANGAR_SWARM_REQUIREMENT_MAX_ATTEMPTS, 3),
  swarmRuntimeAdmissionEnforcement: parseBoolean(env.JANGAR_SWARM_RUNTIME_ADMISSION_ENFORCEMENT, true),
  swarmRuntimeProofEnforcement: parseBoolean(env.JANGAR_SWARM_RUNTIME_PROOF_ENFORCEMENT, true),
  stageClearanceEnforcement: parseStageClearanceEnforcement(env.JANGAR_STAGE_CLEARANCE_ENFORCEMENT),
  stageClearanceHoldStages: parseStringList(env.JANGAR_STAGE_CLEARANCE_HOLD_STAGES),
  evidencePressureLedgerMode: parseEvidencePressureLedgerMode(env.JANGAR_EVIDENCE_PRESSURE_LEDGER_MODE),
  scheduleRunnerAdmissionCheck: parseBoolean(env.JANGAR_SCHEDULE_RUNNER_ADMISSION_CHECK, true),
  scheduleRunnerAdmissionStatusUrl:
    normalizeNonEmpty(env.JANGAR_SCHEDULE_RUNNER_ADMISSION_STATUS_URL) ??
    'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status',
  scheduleRunnerAdmissionStatusTimeoutMs: parsePositiveInt(
    env.JANGAR_SCHEDULE_RUNNER_ADMISSION_STATUS_TIMEOUT_MS,
    5_000,
  ),
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
  scheduleRunnerNodeSelector:
    parseJsonRecord(env.JANGAR_SCHEDULE_RUNNER_NODE_SELECTOR) ?? parseJsonRecord(env.JANGAR_AGENT_RUNNER_NODE_SELECTOR),
  podNamespace: normalizeNonEmpty(env.JANGAR_POD_NAMESPACE),
  scheduleServiceAccount: normalizeNonEmpty(env.JANGAR_SCHEDULE_SERVICE_ACCOUNT),
  serviceAccountName: normalizeNonEmpty(env.JANGAR_SERVICE_ACCOUNT_NAME),
})

export const validateSupportingPrimitivesConfig = (env: EnvSource = process.env) => {
  resolveSupportingPrimitivesConfig(env)
}
