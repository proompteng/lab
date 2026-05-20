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

export type SupportingPrimitivesConfig = {
  swarmRequirementMaxDispatchPerReconcile: number
  swarmRequirementMaxActivePerSwarm: number
  swarmRequirementMaxPayloadBytes: number
  swarmRequirementMaxAttempts: number
  materialReentryRequirementSignals: boolean
  swarmRuntimeAdmissionEnforcement: boolean
  swarmRuntimeProofEnforcement: boolean
  stageClearanceEnforcement: 'disabled' | 'shadow' | 'hold'
  stageClearanceHoldStages: string[]
  evidencePressureLedgerMode: 'observe' | 'shadow' | 'hold' | 'enforce'
  runtimeAdmissionStatusUrl: string
  runtimeAdmissionStatusTimeoutMs: number
  swarmDefaultNatsUrl: string
  swarmDefaultNatsSubjectPrefix: string
  swarmDefaultNatsChannel: string
  podNamespace: string | null
}

export const resolveSupportingPrimitivesConfig = (env: EnvSource = process.env): SupportingPrimitivesConfig => ({
  swarmRequirementMaxDispatchPerReconcile: parsePositiveInt(env.JANGAR_SWARM_REQUIREMENT_MAX_DISPATCH_PER_RECONCILE, 5),
  swarmRequirementMaxActivePerSwarm: parsePositiveInt(env.JANGAR_SWARM_REQUIREMENT_MAX_ACTIVE_PER_SWARM, 10),
  swarmRequirementMaxPayloadBytes: parsePositiveInt(env.JANGAR_SWARM_REQUIREMENT_MAX_PAYLOAD_BYTES, 16_384),
  swarmRequirementMaxAttempts: parsePositiveInt(env.JANGAR_SWARM_REQUIREMENT_MAX_ATTEMPTS, 3),
  materialReentryRequirementSignals: parseBoolean(env.JANGAR_MATERIAL_REENTRY_REQUIREMENT_SIGNALS, false),
  swarmRuntimeAdmissionEnforcement: parseBoolean(env.JANGAR_SWARM_RUNTIME_ADMISSION_ENFORCEMENT, true),
  swarmRuntimeProofEnforcement: parseBoolean(env.JANGAR_SWARM_RUNTIME_PROOF_ENFORCEMENT, true),
  stageClearanceEnforcement: parseStageClearanceEnforcement(env.JANGAR_STAGE_CLEARANCE_ENFORCEMENT),
  stageClearanceHoldStages: parseStringList(env.JANGAR_STAGE_CLEARANCE_HOLD_STAGES),
  evidencePressureLedgerMode: parseEvidencePressureLedgerMode(env.JANGAR_EVIDENCE_PRESSURE_LEDGER_MODE),
  runtimeAdmissionStatusUrl:
    normalizeNonEmpty(env.JANGAR_RUNTIME_ADMISSION_STATUS_URL) ??
    'http://agents.agents.svc.cluster.local/v1/control-plane/status',
  runtimeAdmissionStatusTimeoutMs: parsePositiveInt(env.JANGAR_RUNTIME_ADMISSION_STATUS_TIMEOUT_MS, 15_000),
  swarmDefaultNatsUrl:
    normalizeNonEmpty(env.JANGAR_SWARM_NATS_URL) ??
    normalizeNonEmpty(env.NATS_URL) ??
    'nats://nats.nats.svc.cluster.local:4222',
  swarmDefaultNatsSubjectPrefix: normalizeNonEmpty(env.JANGAR_SWARM_NATS_SUBJECT_PREFIX) ?? 'agentrun',
  swarmDefaultNatsChannel: normalizeNonEmpty(env.JANGAR_SWARM_NATS_CHANNEL) ?? 'general',
  podNamespace: normalizeNonEmpty(env.JANGAR_POD_NAMESPACE),
})

export const validateSupportingPrimitivesConfig = (env: EnvSource = process.env) => {
  resolveSupportingPrimitivesConfig(env)
}
