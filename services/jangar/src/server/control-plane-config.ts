type EnvSource = Record<string, string | undefined>

const DEFAULT_CACHE_CLUSTER_ID = 'default'
const DEFAULT_HEARTBEAT_TTL_SECONDS = 120
const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 15
const DEFAULT_LEADER_ELECTION_LEASE_NAME = 'jangar-controller-leader'
const DEFAULT_LEADER_ELECTION_ENABLED = true
const DEFAULT_LEADER_ELECTION_LEASE_DURATION_SECONDS = 30
const DEFAULT_LEADER_ELECTION_RENEW_DEADLINE_SECONDS = 20
const DEFAULT_LEADER_ELECTION_RETRY_PERIOD_SECONDS = 5
const DEFAULT_WATCH_WINDOW_MINUTES = 15
const DEFAULT_WATCH_STREAM_LIMIT = 20
const DEFAULT_WATCH_RESTART_DEGRADE_THRESHOLD = 2
const MAX_RECORDED_STREAMS = 200
const DEFAULT_WORKFLOWS_WINDOW_MINUTES = 15
const MIN_WINDOW_MINUTES = 1
const MAX_WINDOW_MINUTES = 24 * 60
const DEFAULT_EXECUTION_TRUST_SWARMS = ['jangar-control-plane', 'torghut-quant']
const DEFAULT_EXECUTION_TRUST_SUMMARY_LIMIT = 20
const DEFAULT_WORKFLOW_SWARMS = ['jangar-control-plane']
const DEFAULT_ROLLOUT_DEPLOYMENTS = ['agents', 'agents-controllers']
const DEFAULT_WATCH_RELIABILITY_BLOCK_ERRORS = 6
const DEFAULT_WATCH_RELIABILITY_BLOCK_RESTARTS = 3
const DEFAULT_WORKFLOWS_WARNING_BACKOFF_THRESHOLD = 2
const DEFAULT_WORKFLOWS_DEGRADED_BACKOFF_THRESHOLD = 3

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

const parsePositiveInt = (value: string | undefined, fallback: number, minimum = 1, maximum?: number) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed)) return fallback
  if (parsed < minimum) return fallback
  const bounded = Math.floor(parsed)
  return maximum === undefined ? bounded : Math.min(bounded, maximum)
}

const parseStringList = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)

const uniqueStrings = (values: string[]) => [...new Set(values)]

const isControllerWorkloadFlagEnabled = (value: string | undefined, defaultValue: boolean) => {
  const normalized = (value ?? (defaultValue ? '1' : '0')).trim().toLowerCase()
  return normalized !== '0' && normalized !== 'false'
}

const normalizeUrl = (value: string | undefined) => {
  const normalized = normalizeNonEmpty(value)
  return normalized ? normalized.replace(/\/+$/, '') : null
}

export type ControlPlaneCacheReadConfig = {
  enabled: boolean
  clusterId: string
}

export type ControlPlaneHeartbeatConfig = {
  clusterId: string
  ttlSeconds: number
  intervalSeconds: number
  podName: string
  deploymentName: string
  sourceNamespace: string
}

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

export type ControlPlaneWatchReliabilityConfig = {
  windowMinutes: number
  streamLimit: number
  restartDegradeThreshold: number
}

export type ControlPlaneStatusConfig = {
  executionTrustSwarms: string[]
  executionTrustSummaryLimit: number
  torghutStatusUrl: string | null
  workflowsWindowMinutes: number
  workflowsSwarms: string[]
  watchReliabilityBlockErrors: number
  watchReliabilityBlockRestarts: number
  rolloutDeployments: string[]
  workflowsWarningBackoffThreshold: number
  workflowsDegradedBackoffThreshold: number
}

export type ControlPlaneCacheFreshnessConfig = {
  maxAgeSeconds: number
  allowStale: boolean
}

export const isRuntimeTestEnv = (env: EnvSource = process.env) =>
  env.NODE_ENV === 'test' || Boolean(env.VITEST) || Boolean(env.VITEST_POOL_ID) || Boolean(env.VITEST_WORKER_ID)

export const resolveControlPlaneCacheReadConfig = (env: EnvSource = process.env): ControlPlaneCacheReadConfig => ({
  enabled: parseBoolean(env.JANGAR_CONTROL_PLANE_CACHE_ENABLED, false),
  clusterId: normalizeNonEmpty(env.JANGAR_CONTROL_PLANE_CACHE_CLUSTER) ?? DEFAULT_CACHE_CLUSTER_ID,
})

export const resolveControlPlaneHeartbeatConfig = (env: EnvSource = process.env): ControlPlaneHeartbeatConfig => {
  const podName = normalizeNonEmpty(env.POD_NAME) ?? normalizeNonEmpty(env.HOSTNAME) ?? 'unknown'
  const deploymentName =
    normalizeNonEmpty(env.JANGAR_DEPLOYMENT_NAME) ??
    normalizeNonEmpty(env.DEPLOYMENT_NAME) ??
    normalizeNonEmpty(env.JANGAR_POD_PREFIX) ??
    podName

  return {
    clusterId: resolveControlPlaneCacheReadConfig(env).clusterId,
    ttlSeconds: parsePositiveInt(env.JANGAR_CONTROL_PLANE_HEARTBEAT_TTL_SECONDS, DEFAULT_HEARTBEAT_TTL_SECONDS, 1),
    intervalSeconds: parsePositiveInt(
      env.JANGAR_CONTROL_PLANE_HEARTBEAT_INTERVAL_SECONDS,
      DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
      1,
    ),
    podName,
    deploymentName,
    sourceNamespace: normalizeNonEmpty(env.JANGAR_POD_NAMESPACE) ?? normalizeNonEmpty(env.POD_NAMESPACE) ?? 'default',
  }
}

export const resolveLeaderElectionSettings = (env: EnvSource = process.env): LeaderElectionSettings => {
  let leaseDurationSeconds = parsePositiveInt(
    env.JANGAR_LEADER_ELECTION_LEASE_DURATION_SECONDS,
    DEFAULT_LEADER_ELECTION_LEASE_DURATION_SECONDS,
    1,
  )
  let renewDeadlineSeconds = parsePositiveInt(
    env.JANGAR_LEADER_ELECTION_RENEW_DEADLINE_SECONDS,
    DEFAULT_LEADER_ELECTION_RENEW_DEADLINE_SECONDS,
    1,
  )
  let retryPeriodSeconds = parsePositiveInt(
    env.JANGAR_LEADER_ELECTION_RETRY_PERIOD_SECONDS,
    DEFAULT_LEADER_ELECTION_RETRY_PERIOD_SECONDS,
    1,
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
    enabled: parseBoolean(env.JANGAR_LEADER_ELECTION_ENABLED, DEFAULT_LEADER_ELECTION_ENABLED),
    required:
      !isRuntimeTestEnv(env) &&
      (isControllerWorkloadFlagEnabled(env.JANGAR_AGENTS_CONTROLLER_ENABLED, true) ||
        isControllerWorkloadFlagEnabled(env.JANGAR_ORCHESTRATION_CONTROLLER_ENABLED, true) ||
        isControllerWorkloadFlagEnabled(env.JANGAR_SUPPORTING_CONTROLLER_ENABLED, true) ||
        isControllerWorkloadFlagEnabled(env.JANGAR_PRIMITIVES_RECONCILER, true)),
    leaseName: normalizeNonEmpty(env.JANGAR_LEADER_ELECTION_LEASE_NAME) ?? DEFAULT_LEADER_ELECTION_LEASE_NAME,
    leaseNamespace: normalizeNonEmpty(env.JANGAR_LEADER_ELECTION_LEASE_NAMESPACE) ?? '',
    leaseDurationSeconds,
    renewDeadlineSeconds,
    retryPeriodSeconds,
    podNamespace: normalizeNonEmpty(env.JANGAR_POD_NAMESPACE) ?? normalizeNonEmpty(env.POD_NAMESPACE) ?? 'default',
    podName: normalizeNonEmpty(env.HOSTNAME) ?? 'unknown',
    podUid: normalizeNonEmpty(env.JANGAR_POD_UID),
  }
}

export const resolveControlPlaneWatchReliabilityConfig = (
  env: EnvSource = process.env,
): ControlPlaneWatchReliabilityConfig => ({
  windowMinutes: parsePositiveInt(
    env.JANGAR_CONTROL_PLANE_WATCH_HEALTH_WINDOW_MINUTES,
    DEFAULT_WATCH_WINDOW_MINUTES,
    1,
    MAX_WINDOW_MINUTES,
  ),
  streamLimit: parsePositiveInt(
    env.JANGAR_CONTROL_PLANE_WATCH_HEALTH_STREAM_LIMIT,
    DEFAULT_WATCH_STREAM_LIMIT,
    1,
    MAX_RECORDED_STREAMS,
  ),
  restartDegradeThreshold: parsePositiveInt(
    env.JANGAR_CONTROL_PLANE_WATCH_HEALTH_RESTART_DEGRADE_THRESHOLD,
    DEFAULT_WATCH_RESTART_DEGRADE_THRESHOLD,
    1,
  ),
})

export const resolveControlPlaneStatusConfig = (env: EnvSource = process.env): ControlPlaneStatusConfig => {
  const executionTrustSwarms = uniqueStrings(parseStringList(env.JANGAR_CONTROL_PLANE_EXECUTION_TRUST_SWARMS))
  const workflowsSwarms = uniqueStrings(parseStringList(env.JANGAR_WORKFLOWS_SWARMS))
  const legacyWorkflowSwarms = uniqueStrings(parseStringList(env.JANGAR_WORKFLOW_SWARMS))
  const rolloutDeployments = uniqueStrings(parseStringList(env.JANGAR_CONTROL_PLANE_ROLLOUT_DEPLOYMENTS))

  const workflowsWarningBackoffThreshold = parsePositiveInt(
    env.JANGAR_WORKFLOWS_WARNING_BACKOFF_THRESHOLD,
    DEFAULT_WORKFLOWS_WARNING_BACKOFF_THRESHOLD,
    1,
  )

  return {
    executionTrustSwarms: executionTrustSwarms.length > 0 ? executionTrustSwarms : [...DEFAULT_EXECUTION_TRUST_SWARMS],
    executionTrustSummaryLimit: parsePositiveInt(
      env.JANGAR_CONTROL_PLANE_EXECUTION_TRUST_SUMMARY_LIMIT,
      DEFAULT_EXECUTION_TRUST_SUMMARY_LIMIT,
      1,
      100,
    ),
    torghutStatusUrl: normalizeUrl(env.JANGAR_TORGHUT_STATUS_URL),
    workflowsWindowMinutes: parsePositiveInt(
      env.JANGAR_WORKFLOWS_WINDOW_MINUTES ?? env.JANGAR_WORKFLOW_WINDOW_MINUTES,
      DEFAULT_WORKFLOWS_WINDOW_MINUTES,
      MIN_WINDOW_MINUTES,
      MAX_WINDOW_MINUTES,
    ),
    workflowsSwarms:
      workflowsSwarms.length > 0
        ? workflowsSwarms
        : legacyWorkflowSwarms.length > 0
          ? legacyWorkflowSwarms
          : [...DEFAULT_WORKFLOW_SWARMS],
    watchReliabilityBlockErrors: parsePositiveInt(
      env.JANGAR_CONTROL_PLANE_WATCH_RELIABILITY_BLOCK_ERRORS,
      DEFAULT_WATCH_RELIABILITY_BLOCK_ERRORS,
      1,
    ),
    watchReliabilityBlockRestarts: parsePositiveInt(
      env.JANGAR_CONTROL_PLANE_WATCH_RELIABILITY_BLOCK_RESTARTS,
      DEFAULT_WATCH_RELIABILITY_BLOCK_RESTARTS,
      1,
    ),
    rolloutDeployments: rolloutDeployments.length > 0 ? rolloutDeployments : [...DEFAULT_ROLLOUT_DEPLOYMENTS],
    workflowsWarningBackoffThreshold,
    workflowsDegradedBackoffThreshold: parsePositiveInt(
      env.JANGAR_WORKFLOWS_DEGRADED_BACKOFF_THRESHOLD,
      DEFAULT_WORKFLOWS_DEGRADED_BACKOFF_THRESHOLD,
      workflowsWarningBackoffThreshold,
    ),
  }
}

export const resolveControlPlaneCacheFreshnessConfig = (
  env: EnvSource = process.env,
): ControlPlaneCacheFreshnessConfig => ({
  maxAgeSeconds: parsePositiveInt(env.JANGAR_CONTROL_PLANE_CACHE_STALE_SECONDS, 120, 0),
  allowStale: parseBoolean(env.JANGAR_CONTROL_PLANE_CACHE_ALLOW_STALE, true),
})

export const validateControlPlaneConfig = (env: EnvSource = process.env) => {
  const leaderElection = resolveLeaderElectionSettings(env)
  if (!leaderElection.leaseName.trim()) {
    throw new Error('JANGAR_LEADER_ELECTION_LEASE_NAME must not be empty')
  }

  const status = resolveControlPlaneStatusConfig(env)
  if (status.torghutStatusUrl) {
    try {
      new URL(status.torghutStatusUrl)
    } catch {
      throw new Error(`JANGAR_TORGHUT_STATUS_URL is invalid: ${status.torghutStatusUrl}`)
    }
  }

  resolveControlPlaneHeartbeatConfig(env)
  resolveControlPlaneWatchReliabilityConfig(env)
  resolveControlPlaneCacheFreshnessConfig(env)
}
