import { loadTemporalConfig } from '@proompteng/temporal-bun-sdk'
import { sql } from 'kysely'

import { getAgentsControllerHealth } from '~/server/agents-controller'
import { getDb, type Db } from '~/server/db'
import { getRegisteredMigrationNames } from '~/server/kysely-migrations'
import { getLeaderElectionStatus } from '~/server/leader-election'
import { getOrchestrationControllerHealth } from '~/server/orchestration-controller'
import { getSupportingControllerHealth } from '~/server/supporting-primitives-controller'
import {
  getWatchReliabilitySummary,
  type ControlPlaneWatchReliabilitySummary,
} from '~/server/control-plane-watch-reliability'
import { createKubernetesClient, type KubernetesClient } from '~/server/primitives-kube'
import type {
  ControlPlaneRolloutHealth,
  DeploymentRolloutStatus,
  RolloutFailureReason,
} from '~/data/agents-control-plane'

const DEFAULT_TEMPORAL_HOST = 'temporal-frontend.temporal.svc.cluster.local'
const DEFAULT_TEMPORAL_PORT = 7233
const DEFAULT_TEMPORAL_ADDRESS = `${DEFAULT_TEMPORAL_HOST}:${DEFAULT_TEMPORAL_PORT}`
const DEFAULT_WORKFLOW_MONITOR_WINDOW_MINUTES = 15
const DEFAULT_WORKFLOW_BACKOFF_DEGRADE_THRESHOLD = 2
const DEFAULT_WORKFLOW_MONITOR_SWARMS = 'jangar-control-plane,torghut-quant'
const DEFAULT_ROLLOUT_MONITOR_SWARMS = 'jangar-control-plane,torghut-quant'
const DEFAULT_ROLLOUT_WINDOW_MINUTES = 120
const WORKFLOW_WINDOW_REASON_LIMIT = 5
const ROLLOUT_WINDOW_REASON_LIMIT = 5
const DEFAULT_ROLLOUT_DEPLOYMENTS = 'agents'

type ControllerHealth = ReturnType<typeof getAgentsControllerHealth>

export type ControllerStatus = {
  name: string
  enabled: boolean
  started: boolean
  scope_namespaces: string[]
  crds_ready: boolean
  missing_crds: string[]
  last_checked_at: string
  status: 'healthy' | 'degraded' | 'disabled' | 'unknown'
  message: string
}

export type RuntimeAdapterStatus = {
  name: string
  available: boolean
  status: 'healthy' | 'configured' | 'degraded' | 'disabled' | 'unknown'
  message: string
  endpoint: string
}

export type DatabaseStatus = {
  configured: boolean
  connected: boolean
  status: 'healthy' | 'degraded' | 'disabled'
  message: string
  latency_ms: number
  migration_consistency: {
    status: 'healthy' | 'degraded' | 'unknown'
    migration_table: string | null
    registered_count: number
    applied_count: number
    unapplied_count: number
    unexpected_count: number
    latest_registered: string | null
    latest_applied: string | null
    missing_migrations: string[]
    unexpected_migrations: string[]
    message: string
  }
}

type DatabaseMigrationConsistency = DatabaseStatus['migration_consistency']

export type GrpcStatus = {
  enabled: boolean
  address: string
  status: 'healthy' | 'degraded' | 'disabled'
  message: string
}

export type WorkflowFailureReason = {
  reason: string
  count: number
}

export type WorkflowReliabilityStatus = {
  status: 'healthy' | 'degraded' | 'unknown'
  window_minutes: number
  active_job_runs: number
  recent_failed_jobs: number
  backoff_limit_exceeded_jobs: number
  top_failure_reasons: WorkflowFailureReason[]
  message: string
}

export type ControlPlaneRolloutStageReliability = {
  name: string
  namespace: string
  swarm: string
  stage: string
  phase: string
  last_run_at: string
  last_successful_run_at: string
  last_transition_at: string
  is_active: boolean
  is_stale: boolean
  failed_runs_last_window: number
  backoff_failures_last_window: number
  top_failure_reasons: RolloutFailureReason[]
  reasons: string[]
}

export type ControlPlaneRolloutReliability = {
  status: 'healthy' | 'degraded' | 'unknown'
  window_minutes: number
  observed_schedules: number
  inactive_schedules: number
  stale_schedules: number
  message: string
  stages: ControlPlaneRolloutStageReliability[]
}

export type NamespaceStatus = {
  namespace: string
  status: 'healthy' | 'degraded'
  degraded_components: string[]
}

export type ControlPlaneWatchReliability = {
  status: ControlPlaneWatchReliabilitySummary['status']
  window_minutes: number
  observed_streams: number
  total_events: number
  total_errors: number
  total_restarts: number
  streams: ControlPlaneWatchReliabilitySummary['streams']
}

export type ControlPlaneStatus = {
  service: string
  generated_at: string
  leader_election: {
    enabled: boolean
    required: boolean
    is_leader: boolean
    lease_name: string
    lease_namespace: string
    identity: string
    last_transition_at: string
    last_attempt_at: string
    last_success_at: string
    last_error: string
  }
  controllers: ControllerStatus[]
  runtime_adapters: RuntimeAdapterStatus[]
  workflows: WorkflowReliabilityStatus
  rollout: ControlPlaneRolloutReliability
  database: DatabaseStatus
  grpc: GrpcStatus
  watch_reliability: ControlPlaneWatchReliability
  rollout_health: ControlPlaneRolloutHealth
  namespaces: NamespaceStatus[]
}

export type ControlPlaneStatusOptions = {
  namespace: string
  service?: string
  grpc: GrpcStatus
}

export type ControlPlaneStatusDeps = {
  now?: () => Date
  getAgentsControllerHealth?: () => ControllerHealth
  getSupportingControllerHealth?: () => ControllerHealth
  getOrchestrationControllerHealth?: () => ControllerHealth
  resolveTemporalAdapter?: () => Promise<RuntimeAdapterStatus>
  checkDatabase?: () => Promise<DatabaseStatus>
  getWatchReliabilitySummary?: () => ControlPlaneWatchReliabilitySummary
  kube?: Pick<KubernetesClient, 'list'>
}

const normalizeMessage = (value: unknown) => (value instanceof Error ? value.message : String(value))
const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const asRecord = (value: unknown): Record<string, unknown> => {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
const asString = (value: unknown): string | null => {
  const normalized = normalizeText(value)
  return normalized.length > 0 ? normalized : null
}
const dedupeSorted = (items: string[]) => [...new Set(items)].sort()
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const asNumber = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return fallback
}

const clampPositiveNumber = (value: number, fallback: number) => {
  const parsed = Math.floor(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const parseTimestampMs = (value: unknown): number | null => {
  const raw = asString(value)
  if (!raw) return null
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? null : parsed
}

const maxTimestampMs = (left: number | null, right: number | null) => {
  if (left === null) return right
  if (right === null) return left
  return Math.max(left, right)
}

const pickLatestValueByTimestamp = (
  current: { timestampMs: number | null; value: string },
  candidate: { timestampMs: number | null; value: string },
) => {
  if (candidate.timestampMs === null) return current.value
  if (current.timestampMs === null) return candidate.value
  return candidate.timestampMs >= current.timestampMs ? candidate.value : current.value
}

const readRolloutMonitorSwarms = () => {
  const raw =
    process.env.JANGAR_CONTROL_PLANE_ROLLOUT_MONITORS?.trim() ||
    process.env.JANGAR_CONTROL_PLANE_ROLLOUT_MONITOR_SWARMS?.trim() ||
    process.env.JANGAR_CONTROL_PLANE_WORKFLOW_SWARMS?.trim() ||
    DEFAULT_ROLLOUT_MONITOR_SWARMS
  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
  return names.length > 0 ? names : DEFAULT_ROLLOUT_MONITOR_SWARMS.split(',')
}

const readRolloutWindowMinutes = () => {
  const raw = process.env.JANGAR_CONTROL_PLANE_ROLLOUT_MONITOR_WINDOW_MINUTES
  if (!raw) return DEFAULT_ROLLOUT_WINDOW_MINUTES
  const parsed = asNumber(raw.trim(), DEFAULT_ROLLOUT_WINDOW_MINUTES)
  return clampPositiveNumber(parsed, DEFAULT_ROLLOUT_WINDOW_MINUTES)
}

const readWorkflowMonitorSwarms = () => {
  const raw = process.env.JANGAR_CONTROL_PLANE_WORKFLOW_SWARMS?.trim()
  const fallback = DEFAULT_WORKFLOW_MONITOR_SWARMS
  const resolved = raw && raw.length > 0 ? raw : fallback
  const names = resolved
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
  return names.length > 0 ? names : fallback.split(',')
}

const readWorkflowWindowMinutes = () => {
  const raw = process.env.JANGAR_CONTROL_PLANE_WORKFLOW_WINDOW_MINUTES
  if (!raw) return DEFAULT_WORKFLOW_MONITOR_WINDOW_MINUTES
  const parsed = asNumber(raw.trim(), DEFAULT_WORKFLOW_MONITOR_WINDOW_MINUTES)
  return clampPositiveNumber(parsed, DEFAULT_WORKFLOW_MONITOR_WINDOW_MINUTES)
}

const readBackoffDegradeThreshold = () => {
  const raw = process.env.JANGAR_CONTROL_PLANE_WORKFLOW_BACKOFF_DEGRADE_THRESHOLD
  if (!raw) return DEFAULT_WORKFLOW_BACKOFF_DEGRADE_THRESHOLD
  const parsed = asNumber(raw.trim(), DEFAULT_WORKFLOW_BACKOFF_DEGRADE_THRESHOLD)
  return clampPositiveNumber(parsed, DEFAULT_WORKFLOW_BACKOFF_DEGRADE_THRESHOLD)
}

const readRolloutDeploymentNames = () => {
  const raw = process.env.JANGAR_CONTROL_PLANE_ROLLOUT_DEPLOYMENTS?.trim()
  const fallback = DEFAULT_ROLLOUT_DEPLOYMENTS
  const names = (raw && raw.length > 0 ? raw : fallback)
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
  return names.length > 0 ? names : fallback.split(',')
}

const toLowerStatusText = (value: unknown) => {
  const raw = asString(value)
  return raw?.toLowerCase() ?? ''
}

const readDeploymentCondition = (deployment: Record<string, unknown>, conditionType: string) => {
  const status = asRecord(deployment.status)
  const conditions = asArray(status.conditions).map(asRecord)
  return conditions.find((condition) => asString(condition.type) === conditionType)
}

const buildDeploymentRolloutEntry = (
  deployment: Record<string, unknown>,
  namespace: string,
): DeploymentRolloutStatus => {
  const metadata = asRecord(deployment.metadata)
  const status = asRecord(deployment.status)
  const spec = asRecord(deployment.spec)

  const name = asString(metadata.name) ?? ''
  const desiredReplicas = asNumber(spec.replicas, 0)
  const readyReplicas = asNumber(status.readyReplicas, 0)
  const availableReplicas = asNumber(status.availableReplicas, 0)
  const updatedReplicas = asNumber(status.updatedReplicas, 0)
  const unavailableReplicas = asNumber(status.unavailableReplicas, 0)
  const observedGeneration = asNumber(status.observedGeneration, 0)
  const generation = asNumber(metadata.generation, 0)

  if (desiredReplicas === 0) {
    return {
      name,
      namespace,
      status: 'disabled',
      desired_replicas: desiredReplicas,
      ready_replicas: readyReplicas,
      available_replicas: availableReplicas,
      updated_replicas: updatedReplicas,
      unavailable_replicas: unavailableReplicas,
      message: 'scaled to zero replicas',
    }
  }

  const availableCondition = readDeploymentCondition(deployment, 'Available')
  const progressingCondition = readDeploymentCondition(deployment, 'Progressing')
  const available = toLowerStatusText(availableCondition?.status)
  const progressing = toLowerStatusText(progressingCondition?.status)

  const isReplicaMismatch =
    readyReplicas < desiredReplicas || availableReplicas < desiredReplicas || updatedReplicas < desiredReplicas
  const isUnavailable = unavailableReplicas > 0
  const isUnavailableCondition = available === 'false'
  const isProgressing = progressing === 'true'
  const isObservedGenerationStale = generation > 0 && observedGeneration > 0 && observedGeneration < generation

  const messageParts = [] as string[]
  if (isReplicaMismatch) {
    messageParts.push(
      `replicas are behind: ready=${readyReplicas}, available=${availableReplicas}, updated=${updatedReplicas}, desired=${desiredReplicas}`,
    )
  }
  if (isUnavailable) {
    messageParts.push(`unavailable replicas: ${unavailableReplicas}`)
  }
  if (isUnavailableCondition) {
    messageParts.push('available condition is false')
  }
  if (!isProgressing && progressingCondition) {
    messageParts.push('progressing condition is not true')
  }
  if (isObservedGenerationStale) {
    messageParts.push(`observedGeneration behind: observed=${observedGeneration}, generation=${generation}`)
  }

  const isHealthy = messageParts.length === 0
  if (isHealthy) {
    return {
      name,
      namespace,
      status: 'healthy',
      desired_replicas: desiredReplicas,
      ready_replicas: readyReplicas,
      available_replicas: availableReplicas,
      updated_replicas: updatedReplicas,
      unavailable_replicas: unavailableReplicas,
      message: 'deployment rollout healthy',
    }
  }

  return {
    name,
    namespace,
    status: 'degraded',
    desired_replicas: desiredReplicas,
    ready_replicas: readyReplicas,
    available_replicas: availableReplicas,
    updated_replicas: updatedReplicas,
    unavailable_replicas: unavailableReplicas,
    message: messageParts.join('; '),
  }
}

const buildRolloutHealth = async (deps: {
  kube: Pick<KubernetesClient, 'list'>
  namespace: string
}): Promise<ControlPlaneRolloutHealth> => {
  const names = readRolloutDeploymentNames()
  const response = await deps.kube.list('deployments', deps.namespace)
  const record = asRecord(response)
  const items = asArray(record.items).map(asRecord)

  const byName = new Map<string, Record<string, unknown>>()
  for (const item of items) {
    const name = asString(asRecord(item.metadata).name)
    if (name) {
      byName.set(name, item)
    }
  }

  const deployments: DeploymentRolloutStatus[] = names.map((name) => {
    const deployment = byName.get(name)
    if (!deployment) {
      return {
        name,
        namespace: deps.namespace,
        status: 'degraded',
        desired_replicas: 0,
        ready_replicas: 0,
        available_replicas: 0,
        updated_replicas: 0,
        unavailable_replicas: 0,
        message: `deployment not found in namespace ${deps.namespace}`,
      }
    }
    return buildDeploymentRolloutEntry(deployment, deps.namespace)
  })

  const degradedDeployments = deployments.filter((deployment) => deployment.status === 'degraded').length
  const isDegraded = degradedDeployments > 0

  return {
    status: isDegraded ? 'degraded' : 'healthy',
    observed_deployments: deployments.length,
    degraded_deployments: degradedDeployments,
    deployments,
    message: isDegraded
      ? `${degradedDeployments} configured deployment(s) degraded in rollout`
      : `${deployments.length} configured deployment(s) healthy`,
  }
}

const unknownRolloutHealth = (): ControlPlaneRolloutHealth => ({
  status: 'unknown',
  observed_deployments: 0,
  degraded_deployments: 0,
  deployments: [],
  message: 'rollout health unavailable (kubernetes query failed)',
})
const isWorkflowJobName = (name: string, swarms: string[]) =>
  swarms.some((swarm) => name === swarm || name.startsWith(`${swarm}-`))

const toTopFailureReasons = (entries: Map<string, number>) =>
  [...entries.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, WORKFLOW_WINDOW_REASON_LIMIT)
    .map(([reason, count]) => ({ reason, count }))

const toTopRolloutFailureReasons = (entries: Map<string, number>) =>
  [...entries.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, ROLLOUT_WINDOW_REASON_LIMIT)
    .map(([reason, count]) => ({ reason, count }))

type RolloutScheduleJobStats = {
  failedRuns: number
  backoffFailures: number
  failureReasons: Map<string, number>
}

const createRolloutScheduleJobStats = (): RolloutScheduleJobStats => ({
  failedRuns: 0,
  backoffFailures: 0,
  failureReasons: new Map(),
})

const resolveScheduleFromJobName = (jobName: string, scheduleNames: string[]) => {
  const isStepJob = /-step-\d+-attempt-/.test(jobName)
  if (!isStepJob) {
    return null
  }

  const strippedAttempt = jobName.replace(/-attempt-[^/]+$/, '')
  const scheduleCandidate = strippedAttempt.replace(/-step-\d+$/, '')
  for (const scheduleName of scheduleNames) {
    if (scheduleCandidate === scheduleName || scheduleCandidate.startsWith(`${scheduleName}-`)) {
      return scheduleName
    }
  }
  return null
}

const MIGRATION_TABLE_CANDIDATES = ['kysely_migration', 'kysely_migrations'] as const

const buildDatabaseMigrationConsistencyUnknown = (message: string): DatabaseMigrationConsistency => ({
  status: 'unknown',
  migration_table: null,
  registered_count: 0,
  applied_count: 0,
  unapplied_count: 0,
  unexpected_count: 0,
  latest_registered: null,
  latest_applied: null,
  missing_migrations: [],
  unexpected_migrations: [],
  message,
})

const checkMigrationTable = async (db: Db): Promise<string | null> => {
  const checkExists = async (table: (typeof MIGRATION_TABLE_CANDIDATES)[number]) => {
    const response = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ${table}
      ) AS exists
    `.execute(db)
    const row = response.rows[0]
    return row?.exists === true ? table : null
  }

  for (const table of MIGRATION_TABLE_CANDIDATES) {
    const migrationTable = await checkExists(table)
    if (migrationTable) {
      return migrationTable
    }
  }

  return null
}

const readAppliedMigrations = async (db: Db, migrationTable: string) => {
  const response = await sql<{
    name: string | null
  }>`SELECT name FROM ${sql.ref(migrationTable)} ORDER BY name`.execute(db)
  return dedupeSorted(response.rows.map((row) => asString(row.name)).filter(Boolean) as string[])
}

const buildDatabaseMigrationConsistency = async (db: Db): Promise<DatabaseMigrationConsistency> => {
  const registered = dedupeSorted(getRegisteredMigrationNames())
  const latestRegistered = registered.at(-1) ?? null

  const migrationTable = await checkMigrationTable(db)
  if (!migrationTable) {
    return {
      ...buildDatabaseMigrationConsistencyUnknown('kysely migration table not found'),
      status: 'degraded' as const,
      registered_count: registered.length,
      latest_registered: latestRegistered,
    }
  }

  const applied = await readAppliedMigrations(db, migrationTable)
  const appliedSet = new Set(applied)
  const registeredSet = new Set(registered)

  const missingMigrations = registered.filter((migration) => !appliedSet.has(migration))
  const unexpectedMigrations = applied.filter((migration) => !registeredSet.has(migration))
  const status: DatabaseMigrationConsistency['status'] =
    missingMigrations.length === 0 && unexpectedMigrations.length === 0 ? 'healthy' : 'degraded'

  const messageParts = []
  if (status === 'healthy') {
    messageParts.push('migration registry and database are synchronized')
  } else {
    if (missingMigrations.length > 0) {
      messageParts.push(`${missingMigrations.length} registered migrations not applied`)
    }
    if (unexpectedMigrations.length > 0) {
      messageParts.push(`${unexpectedMigrations.length} migrations applied but unregistered`)
    }
  }
  const latestApplied = applied.at(-1) ?? null

  return {
    status,
    migration_table: migrationTable,
    registered_count: registered.length,
    applied_count: applied.length,
    unapplied_count: missingMigrations.length,
    unexpected_count: unexpectedMigrations.length,
    latest_registered: latestRegistered,
    latest_applied: latestApplied,
    missing_migrations: missingMigrations,
    unexpected_migrations: unexpectedMigrations,
    message: messageParts.join('; '),
  }
}

const buildWorkflowReliability = async (deps: {
  now: Date
  kube: Pick<KubernetesClient, 'list'>
  options: ControlPlaneStatusOptions
}): Promise<WorkflowReliabilityStatus> => {
  const swarms = readWorkflowMonitorSwarms()
  const windowMinutes = readWorkflowWindowMinutes()
  const threshold = readBackoffDegradeThreshold()
  const nowMs = deps.now.getTime()
  const windowStartMs = nowMs - windowMinutes * 60_000

  const response = await deps.kube.list('jobs', deps.options.namespace)
  const record = asRecord(response)
  const items = asArray(record.items).map(asRecord)

  let activeJobRuns = 0
  let recentFailedJobs = 0
  let backoffLimitExceededJobs = 0
  const failureReasons = new Map<string, number>()

  for (const item of items) {
    const metadata = asRecord(item.metadata)
    const jobName = asString(metadata.name) ?? ''
    if (!isWorkflowJobName(jobName, swarms)) continue

    const createdAtMs = parseTimestampMs(metadata.creationTimestamp)
    if (createdAtMs === null || createdAtMs < windowStartMs) {
      continue
    }

    const status = asRecord(item.status)
    const conditions = asArray(status.conditions).map(asRecord)
    const failedCondition = conditions.find((condition) => asString(condition.type) === 'Failed')
    const failed = asNumber(status.failed, 0) > 0
    const active = asNumber(status.active, 0)
    if (active > 0) {
      activeJobRuns += active
    }
    if (!failed) {
      continue
    }

    const failedAtMs = failedCondition ? parseTimestampMs(failedCondition.lastTransitionTime) : null
    if (failedAtMs !== null && failedAtMs < windowStartMs) {
      continue
    }

    recentFailedJobs += 1
    const reason = asString(failedCondition?.reason) ?? 'Failed'
    failureReasons.set(reason, (failureReasons.get(reason) ?? 0) + 1)
    if (reason === 'BackoffLimitExceeded') {
      backoffLimitExceededJobs += 1
    }
  }

  const isDegraded = backoffLimitExceededJobs >= threshold
  const message = isDegraded
    ? `workflow reliability degraded: ${backoffLimitExceededJobs} backoff failures in last ${windowMinutes}m`
    : `workflow reliability healthy: ${recentFailedJobs} failed jobs and ${activeJobRuns} active jobs in last ${windowMinutes}m`

  return {
    status: isDegraded ? 'degraded' : 'healthy',
    window_minutes: windowMinutes,
    active_job_runs: activeJobRuns,
    recent_failed_jobs: recentFailedJobs,
    backoff_limit_exceeded_jobs: backoffLimitExceededJobs,
    top_failure_reasons: toTopFailureReasons(failureReasons),
    message,
  }
}

const unknownWorkflowReliability = (windowMinutes: number): WorkflowReliabilityStatus => ({
  status: 'unknown',
  window_minutes: windowMinutes,
  active_job_runs: 0,
  recent_failed_jobs: 0,
  backoff_limit_exceeded_jobs: 0,
  top_failure_reasons: [],
  message: 'workflow reliability unavailable (kubernetes query failed)',
})

const unknownRolloutReliability = (windowMinutes: number): ControlPlaneRolloutReliability => ({
  status: 'unknown',
  window_minutes: windowMinutes,
  observed_schedules: 0,
  inactive_schedules: 0,
  stale_schedules: 0,
  message: 'rollout reliability unavailable (kubernetes query failed)',
  stages: [],
})

const buildRolloutReliability = async (deps: {
  now: Date
  kube: Pick<KubernetesClient, 'list'>
  options: ControlPlaneStatusOptions
}): Promise<ControlPlaneRolloutReliability> => {
  const swarms = readRolloutMonitorSwarms()
  const windowMinutes = readRolloutWindowMinutes()
  const nowMs = deps.now.getTime()
  const windowStartMs = nowMs - windowMinutes * 60_000

  const schedulesResponse = await deps.kube.list('schedules.schedules.proompteng.ai', deps.options.namespace)
  const cronResponse = await deps.kube.list('cronjob', deps.options.namespace)
  const jobsResponse = await deps.kube.list('jobs', deps.options.namespace)

  const scheduleItems = asArray(asRecord(schedulesResponse).items).map(asRecord)
  const cronItems = asArray(asRecord(cronResponse).items).map(asRecord)
  const jobItems = asArray(asRecord(jobsResponse).items).map(asRecord)

  const cronHealthBySchedule = new Map<
    string,
    {
      lastScheduleMs: number | null
      lastSuccessMs: number | null
      lastScheduleTime: string
      lastSuccessfulTime: string
      transitionTime: string
    }
  >()

  for (const cron of cronItems) {
    const metadata = asRecord(cron.metadata)
    const labels = asRecord(metadata.labels)
    const scheduleName = asString(labels['schedules.proompteng.ai/schedule'])
    if (!scheduleName) continue

    const status = asRecord(cron.status)
    const statusLastScheduleTime = asString(status.lastScheduleTime) ?? ''
    const statusLastSuccessfulTime = asString(status.lastSuccessfulTime) ?? ''
    const transitionTime = asString(parseTransitionTime(cron)) ?? ''
    const record = {
      lastScheduleMs: parseTimestampMs(status.lastScheduleTime),
      lastSuccessMs: parseTimestampMs(status.lastSuccessfulTime),
      lastScheduleTime: statusLastScheduleTime,
      lastSuccessfulTime: statusLastSuccessfulTime,
      transitionTime,
    }
    const current = cronHealthBySchedule.get(scheduleName)
    if (!current) {
      cronHealthBySchedule.set(scheduleName, record)
      continue
    }

    cronHealthBySchedule.set(scheduleName, {
      lastScheduleMs: maxTimestampMs(current.lastScheduleMs, record.lastScheduleMs),
      lastSuccessMs: maxTimestampMs(current.lastSuccessMs, record.lastSuccessMs),
      lastScheduleTime: pickLatestValueByTimestamp(
        { timestampMs: current.lastScheduleMs, value: current.lastScheduleTime },
        { timestampMs: record.lastScheduleMs, value: record.lastScheduleTime },
      ),
      lastSuccessfulTime: pickLatestValueByTimestamp(
        { timestampMs: current.lastSuccessMs, value: current.lastSuccessfulTime },
        { timestampMs: record.lastSuccessMs, value: record.lastSuccessfulTime },
      ),
      transitionTime: pickLatestValueByTimestamp(
        { timestampMs: current.lastScheduleMs, value: current.transitionTime },
        { timestampMs: record.lastScheduleMs, value: record.transitionTime },
      ),
    })
  }

  const scheduleNames = scheduleItems
    .map((schedule) => asString(asRecord(schedule.metadata).name))
    .filter(Boolean) as string[]
  const scheduleStatsByName = new Map<string, RolloutScheduleJobStats>()

  for (const job of jobItems) {
    const metadata = asRecord(job.metadata)
    const jobName = asString(metadata.name) ?? ''
    if (!jobName) continue

    const createdAtMs = parseTimestampMs(metadata.creationTimestamp)
    if (createdAtMs === null || createdAtMs < windowStartMs) {
      continue
    }

    const scheduleName = resolveScheduleFromJobName(jobName, scheduleNames)
    if (!scheduleName) {
      continue
    }

    const status = asRecord(job.status)
    if (asNumber(status.failed, 0) <= 0) {
      continue
    }

    const conditions = asArray(status.conditions).map(asRecord)
    const failedCondition = conditions.find((condition) => asString(condition.type) === 'Failed')
    const reason = asString(failedCondition?.reason) ?? 'Failed'

    const stats = scheduleStatsByName.get(scheduleName) ?? createRolloutScheduleJobStats()
    stats.failedRuns += 1
    if (reason === 'BackoffLimitExceeded') {
      stats.backoffFailures += 1
    }
    stats.failureReasons.set(reason, (stats.failureReasons.get(reason) ?? 0) + 1)
    scheduleStatsByName.set(scheduleName, stats)
  }

  const stages = scheduleItems
    .map((schedule) => {
      const metadata = asRecord(schedule.metadata)
      const labels = asRecord(metadata.labels)
      const status = asRecord(schedule.status)
      const conditions = asArray(status.conditions).map(asRecord)

      const swarmName = asString(labels['swarm.proompteng.ai/name']) ?? 'unknown'
      if (!swarms.includes(swarmName)) return null

      const name = asString(metadata.name) ?? ''
      const namespace = asString(metadata.namespace) ?? deps.options.namespace
      const stage = asString(labels['swarm.proompteng.ai/stage']) ?? ''
      const phase = asString(status.phase) ?? 'Unknown'
      const lastRunAt = asString(status.lastRunTime) ?? ''
      const lastRunMs = parseTimestampMs(lastRunAt)

      const cronHealth = cronHealthBySchedule.get(name)
      const cronLastRunMs = cronHealth?.lastScheduleMs ?? null
      const cronLastSuccessMs = cronHealth?.lastSuccessMs ?? null
      const recentScheduleRun =
        (lastRunMs !== null && lastRunMs >= windowStartMs) || (cronLastRunMs !== null && cronLastRunMs >= windowStartMs)
      const recentSuccessfulRun = cronLastSuccessMs !== null && cronLastSuccessMs >= windowStartMs

      const isActive = phase === 'Active'
      const isStale = !recentScheduleRun || !recentSuccessfulRun
      const reasons: string[] = []
      if (!isActive) {
        reasons.push(`phase:${phase}`)
      }
      if (isStale) {
        reasons.push(`no successful run in last ${windowMinutes}m`)
      }
      const jobStats = scheduleStatsByName.get(name)
      const failedRuns = jobStats?.failedRuns ?? 0
      const backoffFailures = jobStats?.backoffFailures ?? 0
      if (failedRuns > 0) {
        reasons.push(`${failedRuns} failed runs in last ${windowMinutes}m`)
      }
      if (backoffFailures > 0) {
        reasons.push(`${backoffFailures} backoff failures in last ${windowMinutes}m`)
      }

      const transitionTime = conditions.find((condition) => asString(condition.type) === 'Ready')?.lastTransitionTime
      const lastTransitionAt = asString(transitionTime)
      const stageObj: ControlPlaneRolloutStageReliability = {
        name,
        namespace,
        swarm: swarmName,
        stage,
        phase,
        last_run_at: asString(lastRunAt) || asString(cronHealth?.lastScheduleTime) || '',
        last_successful_run_at: asString(cronHealth?.lastSuccessfulTime) || '',
        last_transition_at: asString(lastTransitionAt) || asString(cronHealth?.transitionTime) || '',
        is_active: isActive,
        is_stale: isStale,
        failed_runs_last_window: failedRuns,
        backoff_failures_last_window: backoffFailures,
        top_failure_reasons: jobStats ? toTopRolloutFailureReasons(jobStats.failureReasons) : [],
        reasons,
      }
      return stageObj
    })
    .filter((stage): stage is ControlPlaneRolloutStageReliability => stage !== null)

  const inactiveSchedules = stages.filter((stage) => !stage.is_active).length
  const staleSchedules = stages.filter((stage) => stage.is_stale).length
  const observedSchedules = stages.length

  const isDegraded = stages.length === 0 || inactiveSchedules > 0 || staleSchedules > 0
  const message = isDegraded
    ? `rollout reliability degraded: ${observedSchedules} stages observed, ${inactiveSchedules} inactive, ${staleSchedules} stale`
    : `rollout reliability healthy: ${stages.length} stages observed`

  return {
    status: isDegraded ? 'degraded' : 'healthy',
    window_minutes: windowMinutes,
    observed_schedules: observedSchedules,
    inactive_schedules: inactiveSchedules,
    stale_schedules: staleSchedules,
    message,
    stages,
  }
}

const parseTransitionTime = (record: Record<string, unknown>) => {
  const status = asRecord(record.status)
  const conditions = asArray(status.conditions).map(asRecord)
  const readyCondition = conditions.find((condition) => asString(condition.type) === 'Ready')
  return readyCondition?.lastTransitionTime
}

const buildControllerStatus = (name: string, health: ControllerHealth): ControllerStatus => {
  const scopeNamespaces = Array.isArray(health.namespaces) ? health.namespaces : []
  if (!health.enabled) {
    return {
      name,
      enabled: false,
      started: health.started,
      scope_namespaces: scopeNamespaces,
      crds_ready: false,
      missing_crds: health.missingCrds,
      last_checked_at: health.lastCheckedAt ?? '',
      status: 'disabled',
      message: 'controller disabled',
    }
  }
  if (!health.started) {
    return {
      name,
      enabled: true,
      started: false,
      scope_namespaces: scopeNamespaces,
      crds_ready: false,
      missing_crds: health.missingCrds,
      last_checked_at: health.lastCheckedAt ?? '',
      status: 'degraded',
      message: 'controller not started',
    }
  }
  if (health.crdsReady === false) {
    return {
      name,
      enabled: true,
      started: true,
      scope_namespaces: scopeNamespaces,
      crds_ready: false,
      missing_crds: health.missingCrds,
      last_checked_at: health.lastCheckedAt ?? '',
      status: 'degraded',
      message: `missing CRDs: ${health.missingCrds.join(', ') || 'unknown'}`,
    }
  }
  if (health.crdsReady === null) {
    return {
      name,
      enabled: true,
      started: true,
      scope_namespaces: scopeNamespaces,
      crds_ready: false,
      missing_crds: health.missingCrds,
      last_checked_at: health.lastCheckedAt ?? '',
      status: 'unknown',
      message: 'CRD status not yet checked',
    }
  }
  return {
    name,
    enabled: true,
    started: true,
    scope_namespaces: scopeNamespaces,
    crds_ready: true,
    missing_crds: health.missingCrds,
    last_checked_at: health.lastCheckedAt ?? '',
    status: 'healthy',
    message: '',
  }
}

const resolveAdapterFromController = (controllerStatus: string, controllerMessage: string, healthyMessage = '') => {
  if (controllerStatus === 'healthy') {
    return { available: true, status: 'healthy', message: healthyMessage }
  }
  if (controllerStatus === 'unknown') {
    return { available: false, status: 'unknown', message: controllerMessage || 'controller status unknown' }
  }
  if (controllerStatus === 'disabled') {
    return { available: false, status: 'disabled', message: controllerMessage || 'controller disabled' }
  }
  return { available: false, status: 'degraded', message: controllerMessage || 'controller unhealthy' }
}

const resolveTemporalAdapter = async (): Promise<RuntimeAdapterStatus> => {
  try {
    const config = await loadTemporalConfig({
      defaults: {
        host: DEFAULT_TEMPORAL_HOST,
        port: DEFAULT_TEMPORAL_PORT,
        address: DEFAULT_TEMPORAL_ADDRESS,
      },
    })
    return {
      name: 'temporal',
      available: true,
      status: 'configured',
      message: 'temporal configuration resolved',
      endpoint: config.address ?? DEFAULT_TEMPORAL_ADDRESS,
    }
  } catch (error) {
    return {
      name: 'temporal',
      available: false,
      status: 'degraded',
      message: normalizeMessage(error),
      endpoint: DEFAULT_TEMPORAL_ADDRESS,
    }
  }
}

const checkDatabase = async (): Promise<DatabaseStatus> => {
  const db = getDb()
  if (!db) {
    return {
      configured: false,
      connected: false,
      status: 'disabled',
      message: 'DATABASE_URL not set',
      latency_ms: 0,
      migration_consistency: buildDatabaseMigrationConsistencyUnknown('DATABASE_URL not set'),
    }
  }

  const start = Date.now()
  try {
    await sql`select 1`.execute(db)
    const migration_consistency = await buildDatabaseMigrationConsistency(db)

    return {
      configured: true,
      connected: true,
      status: migration_consistency.status === 'healthy' ? 'healthy' : 'degraded',
      message: migration_consistency.message,
      latency_ms: Math.max(0, Date.now() - start),
      migration_consistency,
    }
  } catch (error) {
    return {
      configured: true,
      connected: false,
      status: 'degraded',
      message: normalizeMessage(error),
      latency_ms: Math.max(0, Date.now() - start),
      migration_consistency: {
        ...buildDatabaseMigrationConsistencyUnknown(normalizeMessage(error)),
        registered_count: getRegisteredMigrationNames().length,
      },
    }
  }
}

export const buildControlPlaneStatus = async (
  options: ControlPlaneStatusOptions,
  deps: ControlPlaneStatusDeps = {},
): Promise<ControlPlaneStatus> => {
  const agentsHealth = (deps.getAgentsControllerHealth ?? getAgentsControllerHealth)()
  const supportingHealth = (deps.getSupportingControllerHealth ?? getSupportingControllerHealth)()
  const orchestrationHealth = (deps.getOrchestrationControllerHealth ?? getOrchestrationControllerHealth)()

  const agentsController = buildControllerStatus('agents-controller', agentsHealth)
  const supportingController = buildControllerStatus('supporting-controller', supportingHealth)
  const orchestrationController = buildControllerStatus('orchestration-controller', orchestrationHealth)
  const controllers = [agentsController, supportingController, orchestrationController]

  const workflowAdapter = resolveAdapterFromController(
    agentsController.status,
    agentsController.message,
    'native workflow runtime via Kubernetes Jobs',
  )
  const jobAdapter = resolveAdapterFromController(
    agentsController.status,
    agentsController.message,
    'job runtime via Kubernetes Jobs',
  )

  const runtimeAdapters: RuntimeAdapterStatus[] = [
    {
      name: 'workflow',
      available: workflowAdapter.available,
      status: workflowAdapter.status as RuntimeAdapterStatus['status'],
      message: workflowAdapter.message,
      endpoint: '',
    },
    {
      name: 'job',
      available: jobAdapter.available,
      status: jobAdapter.status as RuntimeAdapterStatus['status'],
      message: jobAdapter.message,
      endpoint: '',
    },
    await (deps.resolveTemporalAdapter ?? resolveTemporalAdapter)(),
    {
      name: 'custom',
      available: true,
      status: 'unknown',
      message: 'custom runtime configured per AgentRun',
      endpoint: '',
    },
  ]

  const now = (deps.now ?? (() => new Date()))()
  const kube = deps.kube ?? createKubernetesClient()
  const rolloutWindowMinutes = readRolloutWindowMinutes()
  let workflows: WorkflowReliabilityStatus
  try {
    workflows = await buildWorkflowReliability({ now, kube, options })
  } catch {
    workflows = unknownWorkflowReliability(readWorkflowWindowMinutes())
  }
  let rollout: ControlPlaneRolloutReliability
  try {
    rollout = await buildRolloutReliability({ now, kube, options })
  } catch {
    rollout = unknownRolloutReliability(rolloutWindowMinutes)
  }

  const database = await (deps.checkDatabase ?? checkDatabase)()
  const grpcStatus = options.grpc
  const watchReliability = (deps.getWatchReliabilitySummary ?? getWatchReliabilitySummary)()
  let rolloutHealth: ControlPlaneRolloutHealth
  try {
    rolloutHealth = await buildRolloutHealth({ kube, namespace: options.namespace })
  } catch {
    rolloutHealth = unknownRolloutHealth()
  }

  const degradedComponents = [
    ...controllers
      .filter((controller) => controller.status === 'degraded' || controller.status === 'disabled')
      .map((controller) => controller.name),
    ...runtimeAdapters.filter((adapter) => adapter.status === 'degraded').map((adapter) => `runtime:${adapter.name}`),
    ...(workflows.status === 'degraded' ? ['workflows'] : []),
    ...(rollout.status === 'degraded' ? ['rollout'] : []),
    ...(database.status === 'healthy' ? [] : ['database']),
    ...(grpcStatus.enabled && grpcStatus.status !== 'healthy' ? ['grpc'] : []),
    ...(watchReliability.status === 'degraded' ? ['watch_reliability'] : []),
    ...(rolloutHealth.status === 'degraded' ? ['rollout_health'] : []),
  ]

  const leaderElection = getLeaderElectionStatus()

  return {
    service: options.service ?? 'jangar',
    generated_at: now.toISOString(),
    leader_election: {
      enabled: leaderElection.enabled,
      required: leaderElection.required,
      is_leader: leaderElection.isLeader,
      lease_name: leaderElection.leaseName,
      lease_namespace: leaderElection.leaseNamespace,
      identity: leaderElection.identity,
      last_transition_at: leaderElection.lastTransitionAt ?? '',
      last_attempt_at: leaderElection.lastAttemptAt ?? '',
      last_success_at: leaderElection.lastSuccessAt ?? '',
      last_error: leaderElection.lastError ?? '',
    },
    controllers,
    runtime_adapters: runtimeAdapters,
    workflows,
    rollout,
    database,
    grpc: grpcStatus,
    watch_reliability: {
      status: watchReliability.status,
      window_minutes: watchReliability.window_minutes,
      observed_streams: watchReliability.observed_streams,
      total_events: watchReliability.total_events,
      total_errors: watchReliability.total_errors,
      total_restarts: watchReliability.total_restarts,
      streams: watchReliability.streams,
    },
    rollout_health: rolloutHealth,
    namespaces: [
      {
        namespace: options.namespace,
        status: degradedComponents.length === 0 ? 'healthy' : 'degraded',
        degraded_components: degradedComponents,
      },
    ],
  }
}
