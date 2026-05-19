type EnvSource = Record<string, string | undefined>

const DEFAULT_LEADER_ELECTION_LEASE_NAME = 'agents-controller-leader'
const DEFAULT_LEADER_ELECTION_ENABLED = true
const DEFAULT_LEADER_ELECTION_LEASE_DURATION_SECONDS = 30
const DEFAULT_LEADER_ELECTION_RENEW_DEADLINE_SECONDS = 20
const DEFAULT_LEADER_ELECTION_RETRY_PERIOD_SECONDS = 5

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const readAgentsEnv = (env: EnvSource, agentsName: string, legacyJangarName?: string) =>
  normalizeNonEmpty(env[agentsName]) ?? (legacyJangarName ? normalizeNonEmpty(env[legacyJangarName]) : null)

const parseBoolean = (value: string | undefined | null, fallback: boolean) => {
  const normalized = normalizeNonEmpty(value)?.toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

const parsePositiveInt = (value: string | undefined | null, fallback: number, minimum = 1) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback
  return Math.floor(parsed)
}

const isControllerWorkloadFlagEnabled = (value: string | undefined | null, defaultValue: boolean) =>
  parseBoolean(value, defaultValue)

export type LeaderElectionSettings = {
  enabled: boolean
  required: boolean
  leaseName: string
  leaseNamespace: string
  leaseDurationSeconds: number
  renewDeadlineSeconds: number
  retryPeriodSeconds: number
  podNamespace: string
  podName: string
  podUid: string | null
}

export const isRuntimeTestEnv = (env: EnvSource = process.env) =>
  env.NODE_ENV === 'test' || Boolean(env.VITEST) || Boolean(env.VITEST_POOL_ID) || Boolean(env.VITEST_WORKER_ID)

export const resolveLeaderElectionSettings = (env: EnvSource = process.env): LeaderElectionSettings => {
  let leaseDurationSeconds = parsePositiveInt(
    readAgentsEnv(
      env,
      'AGENTS_LEADER_ELECTION_LEASE_DURATION_SECONDS',
      'JANGAR_LEADER_ELECTION_LEASE_DURATION_SECONDS',
    ),
    DEFAULT_LEADER_ELECTION_LEASE_DURATION_SECONDS,
  )
  let renewDeadlineSeconds = parsePositiveInt(
    readAgentsEnv(
      env,
      'AGENTS_LEADER_ELECTION_RENEW_DEADLINE_SECONDS',
      'JANGAR_LEADER_ELECTION_RENEW_DEADLINE_SECONDS',
    ),
    DEFAULT_LEADER_ELECTION_RENEW_DEADLINE_SECONDS,
  )
  let retryPeriodSeconds = parsePositiveInt(
    readAgentsEnv(env, 'AGENTS_LEADER_ELECTION_RETRY_PERIOD_SECONDS', 'JANGAR_LEADER_ELECTION_RETRY_PERIOD_SECONDS'),
    DEFAULT_LEADER_ELECTION_RETRY_PERIOD_SECONDS,
  )

  if (!(retryPeriodSeconds < renewDeadlineSeconds)) {
    renewDeadlineSeconds = DEFAULT_LEADER_ELECTION_RENEW_DEADLINE_SECONDS
    retryPeriodSeconds = DEFAULT_LEADER_ELECTION_RETRY_PERIOD_SECONDS
  }
  if (!(renewDeadlineSeconds < leaseDurationSeconds)) {
    leaseDurationSeconds = DEFAULT_LEADER_ELECTION_LEASE_DURATION_SECONDS
    renewDeadlineSeconds = DEFAULT_LEADER_ELECTION_RENEW_DEADLINE_SECONDS
    retryPeriodSeconds = DEFAULT_LEADER_ELECTION_RETRY_PERIOD_SECONDS
  }

  return {
    enabled: parseBoolean(
      readAgentsEnv(env, 'AGENTS_LEADER_ELECTION_ENABLED', 'JANGAR_LEADER_ELECTION_ENABLED'),
      DEFAULT_LEADER_ELECTION_ENABLED,
    ),
    required:
      !isRuntimeTestEnv(env) &&
      (isControllerWorkloadFlagEnabled(
        readAgentsEnv(env, 'AGENTS_AGENTS_CONTROLLER_ENABLED', 'JANGAR_AGENTS_CONTROLLER_ENABLED'),
        true,
      ) ||
        isControllerWorkloadFlagEnabled(
          readAgentsEnv(env, 'AGENTS_ORCHESTRATION_CONTROLLER_ENABLED', 'JANGAR_ORCHESTRATION_CONTROLLER_ENABLED'),
          true,
        ) ||
        isControllerWorkloadFlagEnabled(
          readAgentsEnv(env, 'AGENTS_SUPPORTING_CONTROLLER_ENABLED', 'JANGAR_SUPPORTING_CONTROLLER_ENABLED'),
          true,
        ) ||
        isControllerWorkloadFlagEnabled(
          readAgentsEnv(env, 'AGENTS_PRIMITIVES_RECONCILER', 'JANGAR_PRIMITIVES_RECONCILER'),
          true,
        )),
    leaseName:
      readAgentsEnv(env, 'AGENTS_LEADER_ELECTION_LEASE_NAME', 'JANGAR_LEADER_ELECTION_LEASE_NAME') ??
      DEFAULT_LEADER_ELECTION_LEASE_NAME,
    leaseNamespace:
      readAgentsEnv(env, 'AGENTS_LEADER_ELECTION_LEASE_NAMESPACE', 'JANGAR_LEADER_ELECTION_LEASE_NAMESPACE') ?? '',
    leaseDurationSeconds,
    renewDeadlineSeconds,
    retryPeriodSeconds,
    podNamespace:
      readAgentsEnv(env, 'AGENTS_POD_NAMESPACE', 'JANGAR_POD_NAMESPACE') ??
      normalizeNonEmpty(env.POD_NAMESPACE) ??
      'default',
    podName: normalizeNonEmpty(env.HOSTNAME) ?? 'unknown',
    podUid: readAgentsEnv(env, 'AGENTS_POD_UID', 'JANGAR_POD_UID'),
  }
}

export const __test__ = {
  parseBoolean,
  parsePositiveInt,
  readAgentsEnv,
}
