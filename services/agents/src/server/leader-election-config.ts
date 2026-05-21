import { normalizeEnvValue, parseBooleanEnv, parsePositiveIntEnv, readAgentsEnv, type EnvSource } from './runtime-env'

const DEFAULT_LEADER_ELECTION_LEASE_NAME = 'agents-controller-leader'
const DEFAULT_LEADER_ELECTION_ENABLED = true
const DEFAULT_LEADER_ELECTION_LEASE_DURATION_SECONDS = 30
const DEFAULT_LEADER_ELECTION_RENEW_DEADLINE_SECONDS = 20
const DEFAULT_LEADER_ELECTION_RETRY_PERIOD_SECONDS = 5

const isControllerWorkloadFlagEnabled = (value: string | undefined | null, defaultValue: boolean) =>
  parseBooleanEnv(value, defaultValue)

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
  let leaseDurationSeconds = parsePositiveIntEnv(
    readAgentsEnv(env, 'AGENTS_LEADER_ELECTION_LEASE_DURATION_SECONDS'),
    DEFAULT_LEADER_ELECTION_LEASE_DURATION_SECONDS,
  )
  let renewDeadlineSeconds = parsePositiveIntEnv(
    readAgentsEnv(env, 'AGENTS_LEADER_ELECTION_RENEW_DEADLINE_SECONDS'),
    DEFAULT_LEADER_ELECTION_RENEW_DEADLINE_SECONDS,
  )
  let retryPeriodSeconds = parsePositiveIntEnv(
    readAgentsEnv(env, 'AGENTS_LEADER_ELECTION_RETRY_PERIOD_SECONDS'),
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
    enabled: parseBooleanEnv(readAgentsEnv(env, 'AGENTS_LEADER_ELECTION_ENABLED'), DEFAULT_LEADER_ELECTION_ENABLED),
    required:
      !isRuntimeTestEnv(env) &&
      (isControllerWorkloadFlagEnabled(readAgentsEnv(env, 'AGENTS_CONTROLLER_ENABLED'), true) ||
        isControllerWorkloadFlagEnabled(readAgentsEnv(env, 'AGENTS_ORCHESTRATION_CONTROLLER_ENABLED'), true) ||
        isControllerWorkloadFlagEnabled(readAgentsEnv(env, 'AGENTS_SUPPORTING_CONTROLLER_ENABLED'), true) ||
        isControllerWorkloadFlagEnabled(readAgentsEnv(env, 'AGENTS_PRIMITIVES_RECONCILER'), true)),
    leaseName: readAgentsEnv(env, 'AGENTS_LEADER_ELECTION_LEASE_NAME') ?? DEFAULT_LEADER_ELECTION_LEASE_NAME,
    leaseNamespace: readAgentsEnv(env, 'AGENTS_LEADER_ELECTION_LEASE_NAMESPACE') ?? '',
    leaseDurationSeconds,
    renewDeadlineSeconds,
    retryPeriodSeconds,
    podNamespace: readAgentsEnv(env, 'AGENTS_POD_NAMESPACE') ?? normalizeEnvValue(env.POD_NAMESPACE) ?? 'default',
    podName: normalizeEnvValue(env.HOSTNAME) ?? 'unknown',
    podUid: readAgentsEnv(env, 'AGENTS_POD_UID'),
  }
}

export const __test__ = {
  parseBoolean: parseBooleanEnv,
  parsePositiveInt: parsePositiveIntEnv,
  readAgentsEnv,
}
