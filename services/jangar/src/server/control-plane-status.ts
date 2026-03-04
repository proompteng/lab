import { loadTemporalConfig } from '@proompteng/temporal-bun-sdk'
import { sql } from 'kysely'

import { getAgentsControllerHealth } from '~/server/agents-controller'
import { getDb, type Db } from '~/server/db'
import { getLeaderElectionStatus } from '~/server/leader-election'
import { getOrchestrationControllerHealth } from '~/server/orchestration-controller'
import { getSupportingControllerHealth } from '~/server/supporting-primitives-controller'
import {
  getWatchReliabilitySummary,
  type ControlPlaneWatchReliabilitySummary,
} from '~/server/control-plane-watch-reliability'
import { asRecord, asString, readNested } from '~/server/primitives-http'
import { parseNamespaceScopeEnv } from '~/server/namespace-scope'
import { createKubernetesClient, type KubernetesClient } from '~/server/primitives-kube'
import { parseEnvStringList, parseOptionalNumber } from '~/server/agents-controller/env-config'
import { getRegisteredMigrationNames } from '~/server/kysely-migrations'

const DEFAULT_TEMPORAL_HOST = 'temporal-frontend.temporal.svc.cluster.local'
const DEFAULT_TEMPORAL_PORT = 7233
const DEFAULT_TEMPORAL_ADDRESS = `${DEFAULT_TEMPORAL_HOST}:${DEFAULT_TEMPORAL_PORT}`
const DEFAULT_WORKFLOWS_WINDOW_MINUTES = 15
const DEFAULT_WORKFLOWS_SWARMS = ['jangar-control-plane']
const DEFAULT_WORKFLOWS_NAMESPACES = ['agents']
const DEFAULT_WORKFLOWS_WARNING_BACKOFF_THRESHOLD = 2
const DEFAULT_WORKFLOWS_DEGRADED_BACKOFF_THRESHOLD = 3
const MAX_TOP_FAILURE_REASONS = 5
const DEFAULT_ROLLOUT_MONITORS = ['jangar-control-plane']
const DEFAULT_ROLLOUT_MONITOR_WINDOW_MINUTES = 120
const MIN_WINDOW_MINUTES = 1
const MAX_WINDOW_MINUTES = 24 * 60
const KUBERNETES_QUERY_FAILURE_MESSAGE_PREFIX = 'kubernetes query failed'
const KUBERNETES_QUERY_FAILURE_ROLLOUT_SUFFIX = 'kubernetes query failed: rollout reliability failed'

const WORKFLOW_JOB_RESOURCE = 'jobs.batch'
const WORKFLOW_SCHEDULE_LABEL_SELECTOR = 'schedules.proompteng.ai/schedule'
const ROLLOUT_SCHEDULE_RESOURCE = 'schedules.schedules.proompteng.ai'
const ROLLOUT_CRONJOB_RESOURCE = 'cronjob'
const ROLLOUT_STAGE_LABEL = 'swarm.proompteng.ai/stage'
const ROLLOUT_SCHEDULE_LABEL = 'schedules.proompteng.ai/schedule'
const SWARM_LABEL_SELECTOR = 'swarm.proompteng.ai/name'

const STATUS_MS_PER_MINUTE = 60 * 1000

type ControllerHealth = ReturnType<typeof getAgentsControllerHealth>

type WorkflowsReliabilityStatusInput = {
  now: Date
  namespace: string
  namespaces: string[]
  windowMinutes: number
  swarms: string[]
  kube: KubernetesClient
}

type RolloutReliabilityStatusInput = {
  now: Date
  namespace: string
  swarms: string[]
  windowMinutes: number
  kube: KubernetesClient
}

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

export type WorkflowsReliabilityStatus = {
  status: 'healthy' | 'degraded' | 'unknown'
  message: string
  active_job_runs: number
  recent_failed_jobs: number
  backoff_limit_exceeded_jobs: number
  window_minutes: number
  top_failure_reasons: string[]
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

export type GrpcStatus = {
  enabled: boolean
  address: string
  status: 'healthy' | 'degraded' | 'disabled'
  message: string
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

export type ControlPlaneRolloutStageReliability = {
  name: string
  namespace: string
  swarm: string
  stage: string
  phase: string
  last_run_at: string | null
  last_successful_run_at: string | null
  last_transition_at: string | null
  is_active: boolean
  is_stale: boolean
  reasons: string[]
}

export type ControlPlaneRolloutReliability = {
  status: 'healthy' | 'degraded' | 'unknown'
  message: string
  window_minutes: number
  observed_schedules: number
  inactive_schedules: number
  stale_schedules: number
  stages: ControlPlaneRolloutStageReliability[]
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
  rollout: ControlPlaneRolloutReliability
  database: DatabaseStatus
  grpc: GrpcStatus
  watch_reliability: ControlPlaneWatchReliability
  workflows: WorkflowsReliabilityStatus
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
  getWorkflowsReliabilityStatus?: (input: WorkflowsReliabilityStatusInput) => Promise<WorkflowsReliabilityStatus>
  getRolloutReliabilityStatus?: (input: RolloutReliabilityStatusInput) => Promise<ControlPlaneRolloutReliability>
}

const normalizeMessage = (value: unknown) => (value instanceof Error ? value.message : String(value))
const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const dedupeSorted = (items: string[]) => [...new Set(items)].sort()

const MIGRATION_TABLE_CANDIDATES = ['kysely_migration', 'kysely_migrations'] as const

const buildDatabaseMigrationConsistencyUnknown = (message: string) => ({
  status: 'unknown' as const,
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
  return dedupeSorted(response.rows.map((row) => normalizeText(row.name)).filter(Boolean) as string[])
}

const buildDatabaseMigrationConsistency = async (db: Db): Promise<DatabaseStatus['migration_consistency']> => {
  const registered = dedupeSorted(getRegisteredMigrationNames())
  const latestRegistered = registered.at(-1) ?? null

  const migrationTable = await checkMigrationTable(db)
  if (!migrationTable) {
    return {
      ...buildDatabaseMigrationConsistencyUnknown('kysely migration table not found'),
      status: 'degraded',
      registered_count: registered.length,
      latest_registered: latestRegistered,
    }
  }

  const applied = await readAppliedMigrations(db, migrationTable)
  const appliedSet = new Set(applied)
  const registeredSet = new Set(registered)

  const missingMigrations = registered.filter((migration) => !appliedSet.has(migration))
  const unexpectedMigrations = applied.filter((migration) => !registeredSet.has(migration))
  const status: DatabaseStatus['migration_consistency']['status'] =
    missingMigrations.length === 0 && unexpectedMigrations.length === 0 ? 'healthy' : 'degraded'

  const messageParts: string[] = []
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

const uniqueStrings = (values: string[]) => {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    unique.push(value)
  }
  return unique
}

const toSafeInt = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = parseOptionalNumber(value)
  if (parsed === undefined) return fallback
  const normalized = Math.max(min, Math.min(max, Math.floor(parsed)))
  return Number.isFinite(normalized) ? normalized : fallback
}

const resolveWorkflowWindowMinutes = () =>
  toSafeInt(
    process.env.JANGAR_WORKFLOWS_WINDOW_MINUTES ?? process.env.JANGAR_WORKFLOW_WINDOW_MINUTES,
    DEFAULT_WORKFLOWS_WINDOW_MINUTES,
    MIN_WINDOW_MINUTES,
    MAX_WINDOW_MINUTES,
  )

const resolveWorkflowThreshold = (raw: string | undefined, fallback: number, min: number) =>
  toSafeInt(raw, fallback, min, Number.MAX_SAFE_INTEGER)

const resolveWorkflowSwarms = () => {
  const configured = parseEnvStringList('JANGAR_WORKFLOWS_SWARMS')
  if (configured.length > 0) return uniqueStrings(configured)
  const legacy = parseEnvStringList('JANGAR_WORKFLOW_SWARMS')
  if (legacy.length > 0) return uniqueStrings(legacy)
  return [...DEFAULT_WORKFLOWS_SWARMS]
}

const resolveWorkflowNamespaces = (optionsNamespace: string) => {
  const fallback = uniqueStrings([optionsNamespace, ...DEFAULT_WORKFLOWS_NAMESPACES])
  try {
    const parsed = parseNamespaceScopeEnv('JANGAR_AGENTS_CONTROLLER_NAMESPACES', {
      fallback,
      label: 'workflow reliability status',
    })
    return uniqueStrings(parsed)
  } catch (error) {
    console.warn(`[jangar] failed to parse JANGAR_AGENTS_CONTROLLER_NAMESPACES: ${normalizeMessage(error)}`)
    return fallback
  }
}

const safeNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined

const buildEmptyWorkflowsReliabilityStatus = (
  windowMinutes: number,
  status: WorkflowsReliabilityStatus['status'],
  message: string,
): WorkflowsReliabilityStatus => ({
  status,
  message,
  active_job_runs: 0,
  recent_failed_jobs: 0,
  backoff_limit_exceeded_jobs: 0,
  window_minutes: windowMinutes,
  top_failure_reasons: [],
})
const parseIsoMs = (value: unknown): number | null => {
  const text = asString(value)
  if (!text) return null
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

const parseItems = (payload: unknown) => {
  const parsed = asRecord(payload)
  if (!parsed) return []
  const rawItems = parsed.items
  if (!Array.isArray(rawItems)) return []
  return rawItems.filter((item): item is Record<string, unknown> => {
    return item !== null && typeof item === 'object' && !Array.isArray(item)
  })
}

const resolveRolloutMonitors = () => {
  const monitors = parseEnvStringList('JANGAR_CONTROL_PLANE_ROLLOUT_MONITORS')
  if (monitors.length > 0) return uniqueStrings(monitors)
  const legacyMonitorSwarms = parseEnvStringList('JANGAR_CONTROL_PLANE_ROLLOUT_MONITOR_SWARMS')
  if (legacyMonitorSwarms.length > 0) return uniqueStrings(legacyMonitorSwarms)
  const legacyWorkflowsMonitors = parseEnvStringList('JANGAR_CONTROL_PLANE_WORKFLOW_SWARMS')
  if (legacyWorkflowsMonitors.length > 0) return uniqueStrings(legacyWorkflowsMonitors)
  return [...DEFAULT_ROLLOUT_MONITORS]
}

const resolveRolloutWindowMinutes = () =>
  toSafeInt(
    process.env.JANGAR_CONTROL_PLANE_ROLLOUT_MONITOR_WINDOW_MINUTES,
    DEFAULT_ROLLOUT_MONITOR_WINDOW_MINUTES,
    MIN_WINDOW_MINUTES,
    MAX_WINDOW_MINUTES,
  )

const buildEmptyRolloutReliabilityStatus = (
  windowMinutes: number,
  status: ControlPlaneRolloutReliability['status'],
  message: string,
): ControlPlaneRolloutReliability => ({
  status,
  message,
  window_minutes: windowMinutes,
  observed_schedules: 0,
  inactive_schedules: 0,
  stale_schedules: 0,
  stages: [],
})

const parseCronSuspended = (cron: Record<string, unknown> | null | undefined) => {
  const spec = asRecord(cron?.spec) ?? {}
  const suspended = spec.suspend
  if (typeof suspended === 'boolean') return suspended
  if (typeof suspended === 'string') {
    const normalized = suspended.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1') return true
    if (normalized === 'false' || normalized === '0') return false
  }
  return false
}

const buildRolloutStageReliability = (
  scheduleName: string,
  scheduleNamespace: string,
  nowMs: number,
  windowMinutes: number,
  schedule: Record<string, unknown>,
  cronResource: Record<string, unknown> | undefined,
) => {
  const status = asRecord(schedule.status) ?? {}
  const metadata = asRecord(schedule.metadata) ?? {}
  const labels = asRecord(metadata.labels) ?? {}
  const phase = asString(status.phase) || 'unknown'
  const stage = asString(labels[ROLLOUT_STAGE_LABEL]) || 'unknown'
  const swarm = asString(labels[SWARM_LABEL_SELECTOR]) || 'unknown'
  const lastRunAtMs = parseIsoMs(status.lastRunTime)
  const lastSuccessfulRunAtMs =
    parseIsoMs(status.lastSuccessfulRunTime) ??
    parseIsoMs(readNested(asRecord(cronResource?.status) ?? {}, ['lastSuccessfulTime'])) ??
    null
  const lastTransitionAtMs = Array.isArray(status.conditions)
    ? status.conditions
        .map((condition) => parseIsoMs(readNested(condition, ['lastTransitionTime'])))
        .filter((value): value is number => value !== null)
        .sort((left, right) => right - left)[0]
    : null

  const isCronPresent = cronResource !== undefined
  const isCronSuspended = parseCronSuspended(cronResource)
  const isActive = phase === 'Active' && isCronPresent && !isCronSuspended
  const isStale = lastRunAtMs === null ? true : nowMs - lastRunAtMs > windowMinutes * STATUS_MS_PER_MINUTE
  const reasons = dedupeSorted(resolveConditionReasons(schedule))

  if (!isActive) {
    if (!isCronPresent) reasons.push('missing cronjob')
    if (isCronSuspended) reasons.push('cronjob suspended')
    if (phase !== 'Active') reasons.push(`schedule phase is ${phase}`)
  }
  if (isStale) reasons.push('schedule execution is stale')
  const dedupedReasons = dedupeSorted(reasons)

  return {
    name: scheduleName,
    namespace: scheduleNamespace,
    swarm,
    stage,
    phase,
    last_run_at: lastRunAtMs === null ? null : new Date(lastRunAtMs).toISOString(),
    last_successful_run_at: lastSuccessfulRunAtMs === null ? null : new Date(lastSuccessfulRunAtMs).toISOString(),
    last_transition_at: lastTransitionAtMs === null ? null : new Date(lastTransitionAtMs).toISOString(),
    is_active: isActive,
    is_stale: isStale,
    reasons: dedupedReasons,
  }
}

const resolveConditionReasons = (resource: Record<string, unknown> | null | undefined) => {
  const status = asRecord(resource?.status) ?? {}
  const conditions = Array.isArray(status.conditions) ? status.conditions : []
  const seen = new Set<string>()
  for (const condition of conditions) {
    const conditionRecord = asRecord(condition)
    if (!conditionRecord) continue
    const reason = asString(conditionRecord.reason)
    if (!reason) continue
    seen.add(reason)
  }
  return [...seen]
}

const extractJobConditions = (job: Record<string, unknown>) => {
  const status = asRecord(job.status) ?? {}
  const conditions = status.conditions
  if (!Array.isArray(conditions)) return []
  return conditions.filter((condition): condition is Record<string, unknown> => {
    return condition !== null && typeof condition === 'object' && !Array.isArray(condition)
  })
}

const isBackoffLimitExceededCondition = (condition: Record<string, unknown>) =>
  asString(condition.reason) === 'BackoffLimitExceeded'

const resolveRolloutReliabilityStatus = async ({
  now,
  namespace,
  swarms,
  windowMinutes,
  kube,
}: RolloutReliabilityStatusInput): Promise<ControlPlaneRolloutReliability> => {
  const nowMs = now.getTime()
  const uniqueSwarms = uniqueStrings(swarms)
  const selector = uniqueSwarms.length > 0 ? `${SWARM_LABEL_SELECTOR} in (${Array.from(uniqueSwarms).join(',')})` : null

  const [schedulesPayload, cronPayload] = await Promise.all([
    kube.list(ROLLOUT_SCHEDULE_RESOURCE, namespace, selector ? `${selector}` : undefined),
    kube.list(ROLLOUT_CRONJOB_RESOURCE, namespace, selector ? `${selector}` : undefined),
  ])

  const scheduleItems = parseItems(schedulesPayload)
  const cronItems = parseItems(cronPayload)
  const cronBySchedule = new Map<string, Record<string, unknown>>()
  for (const cronItem of cronItems) {
    const scheduleName = asString(readNested(cronItem, ['metadata', 'labels', ROLLOUT_SCHEDULE_LABEL]))
    if (!scheduleName) continue
    cronBySchedule.set(scheduleName, cronItem)
  }

  const stages: ControlPlaneRolloutStageReliability[] = []
  let inactiveSchedules = 0
  let staleSchedules = 0

  for (const schedule of scheduleItems) {
    const metadata = asRecord(schedule.metadata) ?? {}
    const scheduleName = asString(metadata.name)
    if (!scheduleName) continue
    const scheduleNamespace = asString(metadata.namespace) ?? namespace
    const cronResource = cronBySchedule.get(scheduleName)
    const stage = buildRolloutStageReliability(
      scheduleName,
      scheduleNamespace,
      nowMs,
      windowMinutes,
      schedule,
      cronResource,
    )
    if (!stage.is_active) inactiveSchedules += 1
    if (stage.is_stale) staleSchedules += 1
    stages.push(stage)
  }

  stages.sort((left, right) => {
    const namespaceCompare = left.namespace.localeCompare(right.namespace)
    if (namespaceCompare !== 0) return namespaceCompare
    if (left.swarm !== right.swarm) return left.swarm.localeCompare(right.swarm)
    if (left.stage !== right.stage) return left.stage.localeCompare(right.stage)
    return left.name.localeCompare(right.name)
  })

  if (stages.length === 0) {
    return buildEmptyRolloutReliabilityStatus(windowMinutes, 'unknown', 'no matching rollout schedules found')
  }

  if (inactiveSchedules > 0 || staleSchedules > 0) {
    return {
      status: 'degraded',
      message: `${inactiveSchedules} inactive schedule(s), ${staleSchedules} stale schedule(s)`,
      window_minutes: windowMinutes,
      observed_schedules: stages.length,
      inactive_schedules: inactiveSchedules,
      stale_schedules: staleSchedules,
      stages,
    }
  }

  return {
    status: 'healthy',
    message: '',
    window_minutes: windowMinutes,
    observed_schedules: stages.length,
    inactive_schedules: 0,
    stale_schedules: 0,
    stages,
  }
}

const buildRolloutReliabilityStatus = async (input: RolloutReliabilityStatusInput) => {
  try {
    return await resolveRolloutReliabilityStatus(input)
  } catch (error) {
    console.warn(`[jangar] failed to collect rollout reliability status: ${normalizeMessage(error)}`)
    return buildEmptyRolloutReliabilityStatus(
      input.windowMinutes,
      'unknown',
      `${KUBERNETES_QUERY_FAILURE_ROLLOUT_SUFFIX} ${normalizeMessage(error)}`,
    )
  }
}

const resolveWorkflowsReliabilityStatus = async ({
  now,
  namespace,
  namespaces,
  windowMinutes,
  swarms,
  kube,
}: WorkflowsReliabilityStatusInput) => {
  const nowMs = now.getTime()
  const windowStartMs = nowMs - windowMinutes * STATUS_MS_PER_MINUTE
  let queryFailed = false

  let activeJobRuns = 0
  let recentFailedJobs = 0
  let backoffLimitExceededJobs = 0
  const reasonsMap = new Map<string, number>()

  const uniqueNamespaces = uniqueStrings(namespaces)
  const uniqueSwarms = uniqueStrings(swarms)
  const scopeSwarms = new Set(uniqueSwarms)

  const namespaceScope = uniqueNamespaces.length > 0 ? uniqueNamespaces : [namespace]
  const selectorSwarms =
    scopeSwarms.size > 0 ? `${SWARM_LABEL_SELECTOR} in (${Array.from(scopeSwarms).join(',')})` : null
  const labelSelector = selectorSwarms
    ? `${WORKFLOW_SCHEDULE_LABEL_SELECTOR},${selectorSwarms}`
    : WORKFLOW_SCHEDULE_LABEL_SELECTOR

  for (const currentNamespace of namespaceScope) {
    try {
      const jobsPayload = await kube.list(WORKFLOW_JOB_RESOURCE, currentNamespace, labelSelector)
      const jobs = parseItems(jobsPayload)

      for (const job of jobs) {
        const metadata = asRecord(job.metadata) ?? {}
        const labels = asRecord(metadata.labels) ?? {}
        const swarm = asString(labels[SWARM_LABEL_SELECTOR])
        if (!swarm || !scopeSwarms.has(swarm)) {
          continue
        }

        const status = asRecord(job.status) ?? {}
        const active = safeNumber(status.active)
        if (active !== undefined && active > 0) {
          activeJobRuns += 1
        }

        const failed = safeNumber(status.failed)
        const completionTimeMs = parseIsoMs(readNested(job, ['status', 'completionTime']))
        const creationTimeMs = parseIsoMs(readNested(job, ['metadata', 'creationTimestamp']))
        const referenceMs =
          completionTimeMs ??
          parseIsoMs(readNested(job, ['status', 'startTime'])) ??
          parseIsoMs(readNested(job, ['status', 'lastTransitionTime'])) ??
          creationTimeMs

        if (
          failed !== undefined &&
          failed > 0 &&
          referenceMs !== null &&
          referenceMs >= windowStartMs &&
          referenceMs <= nowMs
        ) {
          recentFailedJobs += 1
        }

        const conditionReasons = new Set<string>()
        let hasBackoffLimitExceeded = false

        for (const condition of extractJobConditions(job)) {
          const reason = asString(condition.reason)
          const transitionMs = parseIsoMs(readNested(condition, ['lastTransitionTime']))
          const eventMs = transitionMs ?? referenceMs
          if (!reason || eventMs === null || eventMs < windowStartMs || eventMs > nowMs) continue

          conditionReasons.add(reason)
          if (isBackoffLimitExceededCondition(condition)) {
            hasBackoffLimitExceeded = true
          }
        }

        if (
          conditionReasons.size > 0 &&
          failed !== undefined &&
          failed > 0 &&
          referenceMs !== null &&
          referenceMs >= windowStartMs &&
          referenceMs <= nowMs
        ) {
          for (const reason of conditionReasons) {
            const normalized = reason.trim()
            if (!normalized) continue
            reasonsMap.set(normalized, (reasonsMap.get(normalized) ?? 0) + 1)
          }
        }

        if (
          hasBackoffLimitExceeded &&
          failed !== undefined &&
          failed > 0 &&
          referenceMs !== null &&
          referenceMs >= windowStartMs &&
          referenceMs <= nowMs
        ) {
          backoffLimitExceededJobs += 1
        }
      }
    } catch (error) {
      queryFailed = true
      console.warn(
        `[jangar] failed to collect workflow reliability metrics for namespace ${currentNamespace}: ${normalizeMessage(error)}`,
      )
    }
  }

  const topFailureReasons = Array.from(reasonsMap.entries())
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1]
      return left[0].localeCompare(right[0])
    })
    .slice(0, MAX_TOP_FAILURE_REASONS)
    .map(([reason]) => reason)

  const status: WorkflowsReliabilityStatus['status'] = queryFailed ? 'unknown' : 'healthy'
  const message = queryFailed ? `${KUBERNETES_QUERY_FAILURE_MESSAGE_PREFIX} for one or more workflow namespaces` : ''

  // Keep payload bounded and deterministic.
  return {
    status,
    message,
    active_job_runs: activeJobRuns,
    recent_failed_jobs: recentFailedJobs,
    backoff_limit_exceeded_jobs: backoffLimitExceededJobs,
    window_minutes: windowMinutes,
    top_failure_reasons: topFailureReasons,
  }
}

export const buildControlPlaneStatus = async (
  options: ControlPlaneStatusOptions,
  deps: ControlPlaneStatusDeps = {},
): Promise<ControlPlaneStatus> => {
  const now = (deps.now ?? (() => new Date()))()
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

  const database = await (deps.checkDatabase ?? checkDatabase)()
  const grpcStatus = options.grpc
  const watchReliability = (deps.getWatchReliabilitySummary ?? getWatchReliabilitySummary)()
  const warningBackoffThreshold = resolveWorkflowThreshold(
    process.env.JANGAR_WORKFLOWS_WARNING_BACKOFF_THRESHOLD,
    DEFAULT_WORKFLOWS_WARNING_BACKOFF_THRESHOLD,
    1,
  )
  const degradedBackoffThreshold = resolveWorkflowThreshold(
    process.env.JANGAR_WORKFLOWS_DEGRADED_BACKOFF_THRESHOLD,
    DEFAULT_WORKFLOWS_DEGRADED_BACKOFF_THRESHOLD,
    warningBackoffThreshold,
  )
  const windowMinutes = resolveWorkflowWindowMinutes()
  const rolloutWindowMinutes = resolveRolloutWindowMinutes()
  let workflows = buildEmptyWorkflowsReliabilityStatus(windowMinutes, 'healthy', '')
  try {
    workflows = await (deps.getWorkflowsReliabilityStatus ?? resolveWorkflowsReliabilityStatus)({
      now,
      namespace: options.namespace,
      namespaces: resolveWorkflowNamespaces(options.namespace),
      windowMinutes,
      swarms: resolveWorkflowSwarms(),
      kube: createKubernetesClient(),
    })
  } catch (error) {
    workflows = buildEmptyWorkflowsReliabilityStatus(
      windowMinutes,
      'unknown',
      `${KUBERNETES_QUERY_FAILURE_MESSAGE_PREFIX}: ${normalizeMessage(error)}`,
    )
    console.warn(`[jangar] failed to collect workflow reliability status: ${normalizeMessage(error)}`)
  }

  let rollout: ControlPlaneRolloutReliability = buildEmptyRolloutReliabilityStatus(
    rolloutWindowMinutes,
    'unknown',
    'kubernetes client unavailable',
  )
  try {
    rollout = await (deps.getRolloutReliabilityStatus ?? buildRolloutReliabilityStatus)({
      now,
      namespace: options.namespace,
      swarms: resolveRolloutMonitors(),
      windowMinutes: rolloutWindowMinutes,
      kube: createKubernetesClient(),
    })
  } catch (error) {
    rollout = buildEmptyRolloutReliabilityStatus(
      rolloutWindowMinutes,
      'unknown',
      `${KUBERNETES_QUERY_FAILURE_ROLLOUT_SUFFIX}: ${normalizeMessage(error)}`,
    )
    console.warn(`[jangar] failed to collect rollout reliability status: ${normalizeMessage(error)}`)
  }

  const isWorkflowsWarning =
    workflows.status !== 'unknown' && workflows.backoff_limit_exceeded_jobs >= warningBackoffThreshold
  const isWorkflowsDegraded =
    workflows.status !== 'unknown' && workflows.backoff_limit_exceeded_jobs >= degradedBackoffThreshold
  if (workflows.status === 'healthy' && (isWorkflowsWarning || isWorkflowsDegraded)) {
    workflows = {
      ...workflows,
      status: 'degraded',
      message:
        `${workflows.message ? `${workflows.message}; ` : ''}` +
        `workflow reliability degraded: ${workflows.backoff_limit_exceeded_jobs} backoff-limited jobs in last ${windowMinutes}m`,
    }
  }

  const leaderElection = getLeaderElectionStatus()

  const degradedComponents = [
    ...controllers
      .filter((controller) => controller.status === 'degraded' || controller.status === 'disabled')
      .map((controller) => controller.name),
    ...runtimeAdapters.filter((adapter) => adapter.status === 'degraded').map((adapter) => `runtime:${adapter.name}`),
    ...(database.status === 'healthy' ? [] : ['database']),
    ...(grpcStatus.enabled && grpcStatus.status !== 'healthy' ? ['grpc'] : []),
    ...(watchReliability.status === 'degraded' ? ['watch_reliability'] : []),
    ...(rollout.status === 'degraded' ? ['rollout'] : []),
    ...(isWorkflowsWarning || isWorkflowsDegraded ? ['workflows'] : []),
    ...(isWorkflowsDegraded ? ['runtime:workflows'] : []),
  ]

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
    database,
    grpc: grpcStatus,
    rollout,
    watch_reliability: {
      status: watchReliability.status,
      window_minutes: watchReliability.window_minutes,
      observed_streams: watchReliability.observed_streams,
      total_events: watchReliability.total_events,
      total_errors: watchReliability.total_errors,
      total_restarts: watchReliability.total_restarts,
      streams: watchReliability.streams,
    },
    workflows,
    namespaces: [
      {
        namespace: options.namespace,
        status: degradedComponents.length === 0 ? 'healthy' : 'degraded',
        degraded_components: degradedComponents,
      },
    ],
  }
}
