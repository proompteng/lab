import { loadTemporalConfig } from '@proompteng/temporal-bun-sdk'
import { sql } from 'kysely'

import { assessAgentRunIngestion, getAgentsControllerHealth } from '~/server/agents-controller'
import { getDb } from '~/server/db'
import { getRegisteredMigrationNames } from '~/server/kysely-migrations'
import { getLeaderElectionStatus } from '~/server/leader-election'
import { getOrchestrationControllerHealth } from '~/server/orchestration-controller'
import { getSupportingControllerHealth } from '~/server/supporting-primitives-controller'
import {
  getWatchReliabilitySummary,
  type ControlPlaneWatchReliabilitySummary,
} from '~/server/control-plane-watch-reliability'
import type { DatabaseMigrationConsistency, DependencyQuorumStatus } from '~/data/agents-control-plane'
import {
  createControlPlaneHeartbeatStore,
  isHeartbeatFresh,
  type ControlPlaneHeartbeatRow,
  type ControlPlaneHeartbeatStoreGetInput,
} from '~/server/control-plane-heartbeat-store'
import { asRecord, asString, readNested } from '~/server/primitives-http'
import { parseNamespaceScopeEnv } from '~/server/namespace-scope'
import { createKubernetesClient, type KubernetesClient } from '~/server/primitives-kube'
import { parseEnvStringList, parseOptionalNumber } from '~/server/agents-controller/env-config'
import type { WorkflowsReliabilityStatus } from '~/data/agents-control-plane'

const DEFAULT_TEMPORAL_HOST = 'temporal-frontend.temporal.svc.cluster.local'
const DEFAULT_TEMPORAL_PORT = 7233
const DEFAULT_TEMPORAL_ADDRESS = `${DEFAULT_TEMPORAL_HOST}:${DEFAULT_TEMPORAL_PORT}`
const DEFAULT_WORKFLOWS_WINDOW_MINUTES = 15
const DEFAULT_WORKFLOWS_SWARMS = ['jangar-control-plane']
const DEFAULT_WORKFLOWS_NAMESPACES = ['agents']
const DEFAULT_WORKFLOWS_WARNING_BACKOFF_THRESHOLD = 2
const DEFAULT_WORKFLOWS_DEGRADED_BACKOFF_THRESHOLD = 3
const DEFAULT_ROLLOUT_DEPLOYMENTS = ['agents', 'agents-controllers']
const MAX_TOP_FAILURE_REASONS = 5
const MAX_WORKFLOW_COLLECTION_ERROR_SAMPLE = 3
const MIN_WINDOW_MINUTES = 1
const MAX_WINDOW_MINUTES = 24 * 60

const WORKFLOW_JOB_RESOURCE = 'jobs.batch'
const WORKFLOW_SCHEDULE_LABEL_SELECTOR = 'schedules.proompteng.ai/schedule'
const SWARM_LABEL_SELECTOR = 'swarm.proompteng.ai/name'

const STATUS_MS_PER_MINUTE = 60 * 1000
const MIGRATION_TABLE_CANDIDATES = ['kysely_migration', 'kysely_migrations'] as const

type ControllerHealth = ReturnType<typeof getAgentsControllerHealth>

type WorkflowsReliabilityStatusInput = {
  now: Date
  namespace: string
  namespaces: string[]
  windowMinutes: number
  swarms: string[]
  kube: KubernetesClient
}

type HeartbeatAuthoritySource = {
  mode: 'heartbeat' | 'local' | 'rollout' | 'unknown'
  namespace: string
  source_deployment: string
  source_pod: string
  observed_at: string | null
  fresh: boolean
  message: string
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
  authority: HeartbeatAuthoritySource
}

export type RuntimeAdapterStatus = {
  name: string
  available: boolean
  status: 'healthy' | 'configured' | 'degraded' | 'disabled' | 'unknown'
  message: string
  endpoint: string
  authority: HeartbeatAuthoritySource
}

type DeploymentRolloutStatus = {
  name: string
  namespace: string
  status: 'healthy' | 'degraded' | 'unknown' | 'disabled'
  desired_replicas: number
  ready_replicas: number
  available_replicas: number
  updated_replicas: number
  unavailable_replicas: number
  message: string
}

type ControlPlaneRolloutHealth = {
  status: 'healthy' | 'degraded' | 'unknown'
  observed_deployments: number
  degraded_deployments: number
  deployments: DeploymentRolloutStatus[]
  message: string
}

export type DatabaseStatus = {
  configured: boolean
  connected: boolean
  status: 'healthy' | 'degraded' | 'disabled'
  message: string
  latency_ms: number
  migration_consistency: DatabaseMigrationConsistency
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

export type EmpiricalDependencyStatus = {
  status: 'healthy' | 'degraded' | 'disabled' | 'unknown'
  endpoint: string
  message: string
  authoritative: boolean
  calibration_status?: string
  authoritative_modes?: string[]
  eligible_models?: string[]
  eligible_jobs?: string[]
  stale_jobs?: string[]
}

export type EmpiricalServicesStatus = {
  forecast: EmpiricalDependencyStatus
  lean: EmpiricalDependencyStatus
  jobs: EmpiricalDependencyStatus
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

export type AgentRunIngestionStatus = {
  namespace: string
  status: 'healthy' | 'degraded' | 'unknown'
  message: string
  last_watch_event_at: string | null
  last_resync_at: string | null
  untouched_run_count: number
  oldest_untouched_age_seconds: number | null
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
  database: DatabaseStatus
  grpc: GrpcStatus
  watch_reliability: ControlPlaneWatchReliability
  agentrun_ingestion: AgentRunIngestionStatus
  workflows: WorkflowsReliabilityStatus
  dependency_quorum: DependencyQuorumStatus
  rollout_health: ControlPlaneRolloutHealth
  empirical_services: EmpiricalServicesStatus
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
  getHeartbeat?: (input: ControlPlaneHeartbeatStoreGetInput) => Promise<ControlPlaneHeartbeatRow | null>
  resolveTemporalAdapter?: () => Promise<RuntimeAdapterStatus>
  checkDatabase?: () => Promise<DatabaseStatus>
  getWatchReliabilitySummary?: () => ControlPlaneWatchReliabilitySummary
  getWorkflowsReliabilityStatus?: (input: WorkflowsReliabilityStatusInput) => Promise<WorkflowsReliabilityStatus>
  resolveEmpiricalServices?: () => Promise<EmpiricalServicesStatus>
}

const normalizeMessage = (value: unknown) => (value instanceof Error ? value.message : String(value))

type HeartbeatResolver = (input: ControlPlaneHeartbeatStoreGetInput) => Promise<ControlPlaneHeartbeatRow | null>

let sharedHeartbeatStore: ReturnType<typeof createControlPlaneHeartbeatStore> | null = null
let heartbeatStoreUnavailable = false

const resolveHeartbeatStore = () => {
  if (sharedHeartbeatStore) return sharedHeartbeatStore
  if (heartbeatStoreUnavailable) return null

  try {
    sharedHeartbeatStore = createControlPlaneHeartbeatStore()
    return sharedHeartbeatStore
  } catch (error) {
    heartbeatStoreUnavailable = true
    console.warn('[jangar] control-plane heartbeat store unavailable:', normalizeMessage(error))
    return null
  }
}

const buildAuthorityFromHeartbeat = (input: {
  component: string
  namespace: string
  row: ControlPlaneHeartbeatRow | null
  now: Date
  fallbackMode: HeartbeatAuthoritySource['mode']
  fallbackMessage: string
}): HeartbeatAuthoritySource => {
  if (!input.row) {
    return {
      mode: input.fallbackMode,
      namespace: input.namespace,
      source_deployment: '',
      source_pod: '',
      observed_at: null,
      fresh: false,
      message: input.fallbackMessage,
    }
  }

  const observedAt = input.row.observed_at ? new Date(input.row.observed_at).toISOString() : null
  const fresh = isHeartbeatFresh(input.row, input.now)
  const baseMessage = input.row.message?.trim() || ''

  return {
    mode: 'heartbeat',
    namespace: input.row.namespace,
    source_deployment: input.row.deployment_name,
    source_pod: input.row.pod_name,
    observed_at: observedAt,
    fresh,
    message: baseMessage.length > 0 ? baseMessage : `${input.component} heartbeat ${fresh ? 'is healthy' : 'stale'}`,
  }
}

const defaultGetHeartbeat: HeartbeatResolver = async (input) => {
  const store = resolveHeartbeatStore()
  if (!store) return null
  try {
    return await store.getHeartbeat(input)
  } catch (error) {
    console.warn('[jangar] failed to read control-plane heartbeat:', normalizeMessage(error))
    return null
  }
}

const asDependencyReason = (name: string, suffix: string) => `${name.replace(/-/g, '_')}_${suffix}`

const localAuthority = (namespace: string): HeartbeatAuthoritySource => ({
  mode: 'local',
  namespace,
  source_deployment: '',
  source_pod: '',
  observed_at: new Date().toISOString(),
  fresh: true,
  message: 'using local controller state',
})

const rolloutAuthority = (namespace: string, deploymentName: string, observedAt: string): HeartbeatAuthoritySource => ({
  mode: 'rollout',
  namespace,
  source_deployment: deploymentName,
  source_pod: '',
  observed_at: observedAt,
  fresh: true,
  message: `derived from healthy rollout for ${deploymentName}`,
})

const buildAgentRunIngestionStatus = (
  namespace: string,
  health: ReturnType<typeof getAgentsControllerHealth>,
): AgentRunIngestionStatus => {
  const assessment = assessAgentRunIngestion(namespace, health)

  return {
    namespace,
    status: assessment.status,
    message: assessment.message,
    last_watch_event_at: assessment.lastWatchEventAt,
    last_resync_at: assessment.lastResyncAt,
    untouched_run_count: assessment.untouchedRunCount,
    oldest_untouched_age_seconds: assessment.oldestUntouchedAgeSeconds,
  }
}

const buildMigrationConsistencyStatus = (input: {
  migrationTable: string | null
  status: DatabaseMigrationConsistency['status']
  registered: string[]
  applied: string[]
  message: string
}): DatabaseMigrationConsistency => {
  const registeredNames = uniqueStrings(input.registered)
  const appliedNames = uniqueStrings(input.applied)
  const registeredSet = new Set(registeredNames)
  const appliedSet = new Set(appliedNames)
  const missingMigrations = registeredNames.filter((name) => !appliedSet.has(name))
  const unexpectedMigrations = appliedNames.filter((name) => !registeredSet.has(name))

  return {
    status: input.status,
    migration_table: input.migrationTable,
    registered_count: registeredNames.length,
    applied_count: appliedNames.length,
    unapplied_count: missingMigrations.length,
    unexpected_count: unexpectedMigrations.length,
    latest_registered: registeredNames.at(-1) ?? null,
    latest_applied: appliedNames.at(-1) ?? null,
    missing_migrations: missingMigrations,
    unexpected_migrations: unexpectedMigrations,
    message: input.message,
  }
}

const getMigrationTable = async (db: NonNullable<ReturnType<typeof getDb>>): Promise<string | null> => {
  if (!db) return null
  for (const tableName of MIGRATION_TABLE_CANDIDATES) {
    try {
      await sql.raw(`SELECT 1 FROM "${tableName}" LIMIT 1`).execute(db)
      return tableName
    } catch {
      // continue
    }
  }
  return null
}

const getAppliedMigrations = async (
  db: NonNullable<ReturnType<typeof getDb>>,
  tableName: string,
): Promise<string[]> => {
  const rows = await sql.raw<{ name: string | null }>(`SELECT name FROM "${tableName}" ORDER BY name`).execute(db)
  return rows.rows.map((row) => asString(row.name)).filter((name): name is string => name !== '')
}

const getMigrationConsistency = async (
  db: NonNullable<ReturnType<typeof getDb>>,
): Promise<DatabaseMigrationConsistency> => {
  const registeredMigrations = getRegisteredMigrationNames()

  const migrationTable = await getMigrationTable(db)
  if (!migrationTable) {
    return buildMigrationConsistencyStatus({
      migrationTable: null,
      status: 'degraded',
      registered: registeredMigrations,
      applied: [],
      message: 'migration table not found (expected kysely_migration or kysely_migrations)',
    })
  }

  try {
    const appliedMigrations = await getAppliedMigrations(db, migrationTable)
    const details = buildMigrationConsistencyStatus({
      migrationTable,
      status: 'healthy',
      registered: registeredMigrations,
      applied: appliedMigrations,
      message: '',
    })
    if (details.unapplied_count > 0 || details.unexpected_count > 0) {
      return {
        ...details,
        status: 'degraded',
        message:
          `migration drift detected: ${details.unapplied_count} unapplied, ${details.unexpected_count} unexpected migration(s). ` +
          'Run migrations to align DB with code.',
      }
    }
    return details
  } catch (error) {
    return {
      ...buildMigrationConsistencyStatus({
        migrationTable,
        status: 'unknown',
        registered: registeredMigrations,
        applied: [],
        message: normalizeMessage(error),
      }),
      message: `failed to evaluate migration state: ${normalizeMessage(error)}`,
    }
  }
}

const buildMigrationUnavailableStatus = (): DatabaseMigrationConsistency =>
  buildMigrationConsistencyStatus({
    migrationTable: null,
    status: 'unknown',
    registered: getRegisteredMigrationNames(),
    applied: [],
    message: 'DATABASE_URL not set',
  })

const checkDatabase = async (): Promise<DatabaseStatus> => {
  const db = getDb()
  if (!db) {
    return {
      configured: false,
      connected: false,
      status: 'disabled',
      message: 'DATABASE_URL not set',
      latency_ms: 0,
      migration_consistency: buildMigrationUnavailableStatus(),
    }
  }

  const start = Date.now()
  try {
    await sql`select 1`.execute(db)
    const migrationConsistency = await getMigrationConsistency(db)
    return {
      configured: true,
      connected: true,
      status: migrationConsistency.status === 'healthy' ? 'healthy' : 'degraded',
      message: migrationConsistency.status === 'healthy' ? '' : migrationConsistency.message,
      latency_ms: Math.max(0, Date.now() - start),
      migration_consistency: migrationConsistency,
    }
  } catch (error) {
    const message = normalizeMessage(error)
    return {
      configured: true,
      connected: false,
      status: 'degraded',
      message,
      latency_ms: Math.max(0, Date.now() - start),
      migration_consistency: {
        ...buildMigrationUnavailableStatus(),
        status: 'unknown',
        message: `database ping failed: ${message}`,
      },
    }
  }
}

const buildControllerStatusFromHeartbeat = ({
  name,
  health,
  heartbeat,
  now,
}: {
  name: string
  health: ControllerHealth
  heartbeat: ControlPlaneHeartbeatRow | null
  now: Date
}): ControllerStatus => {
  const authority = buildAuthorityFromHeartbeat({
    component: name,
    namespace: (Array.isArray(health.namespaces) ? health.namespaces : [])[0] ?? 'agents',
    row: heartbeat,
    now,
    fallbackMode: 'unknown',
    fallbackMessage: `No authoritative heartbeat for ${name}`,
  })

  if (!heartbeat || !authority.fresh) {
    return {
      name,
      enabled: health.enabled,
      started: false,
      scope_namespaces: Array.isArray(health.namespaces) ? health.namespaces : [],
      crds_ready: false,
      missing_crds: health.missingCrds,
      last_checked_at: health.lastCheckedAt ?? '',
      status: 'unknown',
      message: authority.mode === 'heartbeat' ? 'heartbeat stale or missing' : authority.message,
      authority: {
        ...authority,
        message: authority.mode === 'heartbeat' ? 'heartbeat stale or missing' : authority.message,
      },
    }
  }

  const status =
    heartbeat.status === 'healthy' || heartbeat.status === 'degraded' || heartbeat.status === 'disabled'
      ? heartbeat.status
      : 'unknown'
  const rowMessage = heartbeat.message?.trim() || ''

  return {
    name,
    enabled: heartbeat.enabled,
    started: heartbeat.status !== 'disabled',
    scope_namespaces: Array.isArray(health.namespaces) ? health.namespaces : [],
    crds_ready: status === 'healthy',
    missing_crds: health.missingCrds,
    last_checked_at: heartbeat.observed_at
      ? new Date(heartbeat.observed_at).toISOString()
      : (health.lastCheckedAt ?? ''),
    status,
    message: rowMessage.length > 0 ? rowMessage : status === 'healthy' ? '' : authority.message,
    authority,
  }
}

const buildRuntimeAdapterStatusFromSource = ({
  name,
  source,
  healthyMessage,
  defaultMessage,
}: {
  name: string
  source: ControllerStatus
  healthyMessage: string
  defaultMessage: string
}): RuntimeAdapterStatus => {
  if (source.status === 'healthy') {
    return {
      name,
      available: true,
      status: 'configured',
      message: healthyMessage,
      endpoint: '',
      authority: source.authority,
    }
  }
  if (source.status === 'unknown') {
    return {
      name,
      available: false,
      status: 'unknown',
      message: source.message || defaultMessage,
      endpoint: '',
      authority: source.authority,
    }
  }
  if (source.status === 'disabled') {
    return {
      name,
      available: false,
      status: 'disabled',
      message: source.message || defaultMessage,
      endpoint: '',
      authority: source.authority,
    }
  }
  return {
    name,
    available: false,
    status: 'degraded',
    message: source.message || defaultMessage,
    endpoint: '',
    authority: source.authority,
  }
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
      authority: localAuthority('agents'),
    }
  } catch (error) {
    return {
      name: 'temporal',
      available: false,
      status: 'degraded',
      message: normalizeMessage(error),
      endpoint: DEFAULT_TEMPORAL_ADDRESS,
      authority: localAuthority('agents'),
    }
  }
}

const resolveServiceStatus = async (input: {
  readyUrl?: string
  detailUrl?: string
  detailMethod?: 'GET' | 'POST'
  detailBody?: Record<string, unknown>
  type: 'forecast' | 'lean' | 'jobs'
}): Promise<EmpiricalDependencyStatus> => {
  if (!input.readyUrl) {
    return {
      status: 'disabled',
      endpoint: '',
      message: `${input.type} service not configured`,
      authoritative: false,
    }
  }

  const requestJson = async (
    url: string,
    init?: { method?: 'GET' | 'POST'; body?: Record<string, unknown> },
  ): Promise<Record<string, unknown> | null> => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2000)
    try {
      const response = await fetch(url, {
        method: init?.method ?? 'GET',
        headers: init?.body
          ? { 'content-type': 'application/json', accept: 'application/json' }
          : { accept: 'application/json' },
        body: init?.body ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      })
      const payload = (await response.json().catch(() => null)) as unknown
      if (!response.ok || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return null
      }
      return payload as Record<string, unknown>
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
    }
  }

  const readyPayload = await requestJson(input.readyUrl)
  if (!readyPayload) {
    return {
      status: 'degraded',
      endpoint: input.readyUrl,
      message: `${input.type} readiness failed`,
      authoritative: false,
    }
  }

  const detailPayload = input.detailUrl
    ? await requestJson(input.detailUrl, {
        method: input.detailMethod,
        body: input.detailBody,
      })
    : null

  if (input.type === 'forecast') {
    const models = Array.isArray(detailPayload?.models) ? detailPayload.models : []
    const eligibleModels = models
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
      .filter((item) => item.promotion_authority_eligible === true)
      .map((item) => (typeof item.model_family === 'string' ? item.model_family : ''))
      .filter((item) => item.length > 0)
    return {
      status: 'healthy',
      endpoint: input.readyUrl,
      message: 'forecast service ready',
      authoritative: eligibleModels.length > 0,
      calibration_status: typeof detailPayload?.status === 'string' ? detailPayload.status : 'unknown',
      eligible_models: eligibleModels,
    }
  }

  if (input.type === 'jobs') {
    const jobs =
      detailPayload && typeof detailPayload.jobs === 'object' && detailPayload.jobs !== null
        ? (detailPayload.jobs as Record<string, unknown>)
        : {}
    const eligibleJobs = Object.entries(jobs)
      .filter(([, value]) => !!value && typeof value === 'object' && !Array.isArray(value))
      .filter(([, value]) => (value as Record<string, unknown>).promotion_authority_eligible === true)
      .map(([key]) => key)
    const staleJobs = Object.entries(jobs)
      .filter(([, value]) => !!value && typeof value === 'object' && !Array.isArray(value))
      .filter(([, value]) => (value as Record<string, unknown>).stale === true)
      .map(([key]) => key)
    return {
      status:
        typeof detailPayload?.status === 'string'
          ? (detailPayload.status as EmpiricalDependencyStatus['status'])
          : 'degraded',
      endpoint: input.readyUrl,
      message: staleJobs.length > 0 ? `stale empirical jobs: ${staleJobs.join(', ')}` : 'empirical jobs fresh',
      authoritative: detailPayload?.authority === 'empirical',
      eligible_jobs: eligibleJobs,
      stale_jobs: staleJobs,
    }
  }

  const authority =
    detailPayload && typeof detailPayload.authority === 'object' && detailPayload.authority !== null
      ? (detailPayload.authority as Record<string, unknown>)
      : {}
  const authoritativeModes = Array.isArray(authority.authoritative_modes)
    ? authority.authoritative_modes.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : []
  return {
    status: 'healthy',
    endpoint: input.readyUrl,
    message: 'LEAN runner ready',
    authoritative: authoritativeModes.length > 0,
    authoritative_modes: authoritativeModes,
  }
}

const resolveEmpiricalServices = async (): Promise<EmpiricalServicesStatus> => ({
  forecast: await resolveServiceStatus({
    readyUrl: process.env.JANGAR_TORGHUT_FORECAST_READY_URL,
    detailUrl: process.env.JANGAR_TORGHUT_FORECAST_CALIBRATION_URL,
    detailMethod: 'POST',
    detailBody: {},
    type: 'forecast',
  }),
  lean: await resolveServiceStatus({
    readyUrl: process.env.JANGAR_TORGHUT_LEAN_READY_URL,
    detailUrl: process.env.JANGAR_TORGHUT_LEAN_OBSERVABILITY_URL,
    detailMethod: 'GET',
    type: 'lean',
  }),
  jobs: await resolveServiceStatus({
    readyUrl: process.env.JANGAR_TORGHUT_EMPIRICAL_JOBS_URL,
    detailUrl: process.env.JANGAR_TORGHUT_EMPIRICAL_JOBS_URL,
    detailMethod: 'GET',
    type: 'jobs',
  }),
})

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

const readRolloutDeploymentNames = () => {
  const configured = parseEnvStringList('JANGAR_CONTROL_PLANE_ROLLOUT_DEPLOYMENTS')
  if (configured.length > 0) return uniqueStrings(configured)
  return [...DEFAULT_ROLLOUT_DEPLOYMENTS]
}

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const readDeploymentCondition = (deployment: Record<string, unknown>, conditionType: string) => {
  const status = asRecord(deployment.status)
  const conditions = status ? asArray(status.conditions) : []
  for (const item of conditions) {
    const parsedCondition = asRecord(item)
    if (parsedCondition && asString(parsedCondition.type) === conditionType) {
      return parsedCondition
    }
  }
  return null
}

const safeDeploymentNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value))
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
  }
  return 0
}

const buildDeploymentRolloutEntry = (
  deployment: Record<string, unknown>,
  namespace: string,
): DeploymentRolloutStatus => {
  const metadata = asRecord(deployment.metadata)
  const status = asRecord(deployment.status)
  const spec = asRecord(deployment.spec)
  if (!metadata || !status || !spec) {
    return {
      name: asString(deployment.name) ?? '',
      namespace,
      status: 'unknown',
      desired_replicas: 0,
      ready_replicas: 0,
      available_replicas: 0,
      updated_replicas: 0,
      unavailable_replicas: 0,
      message: 'invalid deployment status payload',
    }
  }

  const name = asString(metadata.name) ?? ''
  const desiredReplicas = safeDeploymentNumber(spec.replicas)
  const readyReplicas = safeDeploymentNumber(status.readyReplicas)
  const availableReplicas = safeDeploymentNumber(status.availableReplicas)
  const updatedReplicas = safeDeploymentNumber(status.updatedReplicas)
  const unavailableReplicas = safeDeploymentNumber(status.unavailableReplicas)

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
  const availableConditionHealthy = (asString(availableCondition?.status) ?? '').toLowerCase() === 'true'
  const progressingConditionHealthy = (asString(progressingCondition?.status) ?? '').toLowerCase() === 'true'
  const isReplicaMismatch =
    readyReplicas < desiredReplicas ||
    availableReplicas < desiredReplicas ||
    updatedReplicas < desiredReplicas ||
    unavailableReplicas > 0

  const reasons: string[] = []
  if (!availableConditionHealthy) {
    reasons.push('available condition is false')
  }
  if (!progressingConditionHealthy) {
    reasons.push('progressing condition is not true')
  }
  if (isReplicaMismatch) {
    reasons.push(
      `replicas are behind: ready=${readyReplicas}, available=${availableReplicas}, updated=${updatedReplicas}, desired=${desiredReplicas}`,
    )
  }

  const isHealthy = reasons.length === 0
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
    message: reasons.join('; '),
  }
}

const unknownRolloutHealth = (): ControlPlaneRolloutHealth => ({
  status: 'unknown',
  observed_deployments: 0,
  degraded_deployments: 0,
  deployments: [],
  message: 'rollout health unavailable (kubernetes query failed)',
})

const findRolloutDeployment = (rolloutHealth: ControlPlaneRolloutHealth, namespace: string, name: string) =>
  rolloutHealth.deployments.find((deployment) => deployment.namespace === namespace && deployment.name === name) ?? null

const isAvailableSplitTopologyRollout = (
  deployment: DeploymentRolloutStatus | null,
): deployment is DeploymentRolloutStatus =>
  deployment != null &&
  (deployment.status === 'healthy' ||
    (deployment.status === 'degraded' && deployment.ready_replicas > 0 && deployment.available_replicas > 0))

const hasMaterialRolloutDegradation = (rolloutHealth: ControlPlaneRolloutHealth) =>
  rolloutHealth.deployments.some((deployment) => {
    if (deployment.status !== 'degraded') return false

    const desiredReplicas = Math.max(deployment.desired_replicas, 1)
    return deployment.ready_replicas < desiredReplicas || deployment.available_replicas < desiredReplicas
  })

const maybeUseSplitTopologyControllerRollout = ({
  namespace,
  now,
  controller,
  health,
  rolloutHealth,
}: {
  namespace: string
  now: Date
  controller: ControllerStatus
  health: ControllerHealth
  rolloutHealth: ControlPlaneRolloutHealth
}): ControllerStatus => {
  if (health.enabled) return controller
  if (controller.status !== 'disabled' && controller.status !== 'unknown') return controller

  const controllersRollout = findRolloutDeployment(rolloutHealth, namespace, 'agents-controllers')
  if (!isAvailableSplitTopologyRollout(controllersRollout)) return controller

  return {
    ...controller,
    enabled: true,
    started: true,
    scope_namespaces: controller.scope_namespaces.length > 0 ? controller.scope_namespaces : [namespace],
    crds_ready: true,
    missing_crds: [],
    last_checked_at: now.toISOString(),
    status: 'healthy',
    message: `derived from available ${controllersRollout.name} rollout`,
    authority: rolloutAuthority(namespace, controllersRollout.name, now.toISOString()),
  }
}

const maybeUseSplitTopologyRuntimeRollout = ({
  namespace,
  now,
  adapter,
  health,
  rolloutHealth,
}: {
  namespace: string
  now: Date
  adapter: RuntimeAdapterStatus
  health: ControllerHealth
  rolloutHealth: ControlPlaneRolloutHealth
}): RuntimeAdapterStatus => {
  if (health.enabled) return adapter
  if (adapter.name !== 'workflow' && adapter.name !== 'job') return adapter
  if (adapter.status !== 'disabled' && adapter.status !== 'unknown') return adapter

  const controllersRollout = findRolloutDeployment(rolloutHealth, namespace, 'agents-controllers')
  if (!isAvailableSplitTopologyRollout(controllersRollout)) return adapter

  return {
    ...adapter,
    available: true,
    status: 'configured',
    message:
      adapter.name === 'workflow'
        ? `workflow runtime derived from available ${controllersRollout.name} rollout`
        : `job runtime derived from available ${controllersRollout.name} rollout`,
    authority: rolloutAuthority(namespace, controllersRollout.name, now.toISOString()),
  }
}

const buildRolloutHealth = async ({
  namespace,
  kube,
}: {
  namespace: string
  kube: KubernetesClient
}): Promise<ControlPlaneRolloutHealth> => {
  const names = readRolloutDeploymentNames()
  const response = await kube.list('deployments', namespace)
  const items = parseItems(response)
  const byName = new Map<string, Record<string, unknown>>()
  for (const item of items) {
    const metadata = asRecord(item.metadata) ?? {}
    const itemName = asString(metadata.name)
    if (itemName) {
      byName.set(itemName, item)
    }
  }

  const deployments: DeploymentRolloutStatus[] = names.map((name) => {
    const deployment = byName.get(name)
    if (!deployment) {
      return {
        name,
        namespace,
        status: 'degraded',
        desired_replicas: 0,
        ready_replicas: 0,
        available_replicas: 0,
        updated_replicas: 0,
        unavailable_replicas: 0,
        message: `deployment ${name} not found in namespace ${namespace}`,
      }
    }
    return buildDeploymentRolloutEntry(deployment, namespace)
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

const safeNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined

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

  let activeJobRuns = 0
  let recentFailedJobs = 0
  let backoffLimitExceededJobs = 0
  const reasonsMap = new Map<string, number>()
  let collectionErrors = 0
  let collectedNamespaces = 0
  const collectionErrorMessages: string[] = []

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
      collectedNamespaces += 1

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
      collectionErrors += 1
      const errorMessage = normalizeMessage(error)
      collectionErrorMessages.push(`${currentNamespace}: ${errorMessage}`)
      console.warn(
        `[jangar] failed to collect workflow reliability metrics for namespace ${currentNamespace}: ${errorMessage}`,
      )
    }
  }

  const topFailureReasons = Array.from(reasonsMap.entries())
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1]
      return left[0].localeCompare(right[0])
    })
    .slice(0, MAX_TOP_FAILURE_REASONS)
    .map(([reason, count]) => ({ reason, count }))

  const targetNamespaces = namespaceScope.length
  const dataConfidence: WorkflowsReliabilityStatus['data_confidence'] =
    collectionErrors === 0 ? 'high' : collectedNamespaces === 0 ? 'unknown' : 'degraded'
  const collectionMessage =
    dataConfidence === 'high'
      ? ''
      : [
          dataConfidence === 'unknown'
            ? `workflow reliability unavailable (${collectionErrors}/${targetNamespaces} namespace queries failed)`
            : `workflow reliability partially unavailable (${collectionErrors}/${targetNamespaces} namespace queries failed)`,
          collectionErrorMessages.length > 0
            ? `sample errors: ${collectionErrorMessages.slice(0, MAX_WORKFLOW_COLLECTION_ERROR_SAMPLE).join(' | ')}`
            : '',
        ]
          .filter((value) => value.length > 0)
          .join('; ')

  // Keep payload bounded and deterministic.
  return {
    active_job_runs: activeJobRuns,
    recent_failed_jobs: recentFailedJobs,
    backoff_limit_exceeded_jobs: backoffLimitExceededJobs,
    window_minutes: windowMinutes,
    top_failure_reasons: topFailureReasons,
    data_confidence: dataConfidence,
    collection_errors: collectionErrors,
    collected_namespaces: collectedNamespaces,
    target_namespaces: targetNamespaces,
    message: collectionMessage,
  }
}

const buildDependencyQuorum = (input: {
  controllers: ControllerStatus[]
  runtimeAdapters: RuntimeAdapterStatus[]
  database: DatabaseStatus
  watchReliability: ControlPlaneWatchReliabilitySummary
  workflows: WorkflowsReliabilityStatus
  rolloutHealth: ControlPlaneRolloutHealth
  empiricalServices: EmpiricalServicesStatus
  warningBackoffThreshold: number
  degradedBackoffThreshold: number
}): DependencyQuorumStatus => {
  const blockReasons: string[] = []
  const delayReasons: string[] = []
  const workflowTopReasons = input.workflows.top_failure_reasons
    .map((item) => item.reason)
    .filter((reason) => reason.length > 0)

  for (const controller of input.controllers) {
    if (controller.status === 'healthy') continue

    if (controller.status === 'unknown') {
      blockReasons.push(asDependencyReason(controller.name, 'status_unknown'))
      continue
    }

    if (controller.name === 'agents-controller') {
      blockReasons.push('agents_controller_unavailable')
      continue
    }
    delayReasons.push(`${controller.name.replace(/-/g, '_')}_degraded`)
  }

  const workflowAdapter = input.runtimeAdapters.find((adapter) => adapter.name === 'workflow')
  if (!workflowAdapter) {
    blockReasons.push('workflow_runtime_unavailable')
  } else if (workflowAdapter.status === 'unknown') {
    blockReasons.push('workflow_runtime_status_unknown')
  } else if (workflowAdapter.available === false || workflowAdapter.status === 'degraded') {
    blockReasons.push('workflow_runtime_unavailable')
  }

  if (input.database.status !== 'healthy') {
    blockReasons.push('control_plane_database_unhealthy')
  }

  if (input.workflows.data_confidence === 'unknown') {
    blockReasons.push('workflows_data_unknown')
  } else if (input.workflows.data_confidence === 'degraded') {
    delayReasons.push('workflows_data_degraded')
  }

  if (input.workflows.backoff_limit_exceeded_jobs >= input.degradedBackoffThreshold) {
    blockReasons.push('workflow_backoff_limit_exceeded')
  } else if (input.workflows.backoff_limit_exceeded_jobs >= input.warningBackoffThreshold) {
    delayReasons.push('workflow_backoff_warning')
  }

  if (input.watchReliability.status === 'degraded') {
    delayReasons.push('watch_reliability_degraded')
  }

  if (hasMaterialRolloutDegradation(input.rolloutHealth)) {
    delayReasons.push('rollout_health_degraded')
  }

  // Forecast/LEAN/empirical jobs remain observable via empirical_services and degraded_components,
  // but they are not hard admission dependencies for live trading control-plane readiness.

  const reasons = uniqueStrings(blockReasons.length > 0 ? blockReasons : delayReasons)
  const decision: DependencyQuorumStatus['decision'] =
    blockReasons.length > 0 ? 'block' : delayReasons.length > 0 ? 'delay' : 'allow'
  const message =
    decision === 'allow'
      ? 'Control-plane admission dependencies are healthy.'
      : [
          decision === 'block'
            ? 'Control-plane dependency quorum is blocked.'
            : 'Control-plane dependency quorum is degraded; delay capital promotion.',
          workflowTopReasons.length > 0 ? `recent workflow reasons: ${workflowTopReasons.join(', ')}` : '',
          input.workflows.message.length > 0 ? input.workflows.message : '',
        ]
          .filter((value) => value.length > 0)
          .join(' ')

  return {
    decision,
    reasons,
    message,
  }
}

export const buildControlPlaneStatus = async (
  options: ControlPlaneStatusOptions,
  deps: ControlPlaneStatusDeps = {},
): Promise<ControlPlaneStatus> => {
  const now = (deps.now ?? (() => new Date()))()
  const heartbeatResolver = deps.getHeartbeat ?? defaultGetHeartbeat
  const agentsHealth = (deps.getAgentsControllerHealth ?? getAgentsControllerHealth)()
  const supportingHealth = (deps.getSupportingControllerHealth ?? getSupportingControllerHealth)()
  const orchestrationHealth = (deps.getOrchestrationControllerHealth ?? getOrchestrationControllerHealth)()

  const [agentsHeartbeat, supportingHeartbeat, orchestrationHeartbeat, workflowRuntimeHeartbeat] = await Promise.all([
    heartbeatResolver({ namespace: options.namespace, component: 'agents-controller', workloadRole: 'controllers' }),
    heartbeatResolver({
      namespace: options.namespace,
      component: 'supporting-controller',
      workloadRole: 'controllers',
    }),
    heartbeatResolver({
      namespace: options.namespace,
      component: 'orchestration-controller',
      workloadRole: 'controllers',
    }),
    heartbeatResolver({ namespace: options.namespace, component: 'workflow-runtime', workloadRole: 'controllers' }),
  ])

  const agentsController = buildControllerStatusFromHeartbeat({
    name: 'agents-controller',
    health: agentsHealth,
    heartbeat: agentsHeartbeat,
    now,
  })
  const supportingController = buildControllerStatusFromHeartbeat({
    name: 'supporting-controller',
    health: supportingHealth,
    heartbeat: supportingHeartbeat,
    now,
  })
  const orchestrationController = buildControllerStatusFromHeartbeat({
    name: 'orchestration-controller',
    health: orchestrationHealth,
    heartbeat: orchestrationHeartbeat,
    now,
  })
  const controllers = [agentsController, supportingController, orchestrationController]

  const workflowRuntimeController = buildControllerStatusFromHeartbeat({
    name: 'workflow-runtime',
    health: agentsHealth,
    heartbeat: workflowRuntimeHeartbeat,
    now,
  })
  const workflowAdapter = buildRuntimeAdapterStatusFromSource({
    name: 'workflow',
    source: workflowRuntimeController,
    healthyMessage: 'native workflow runtime via Kubernetes Jobs',
    defaultMessage: 'workflow runtime unavailable',
  })
  const jobAdapter = buildRuntimeAdapterStatusFromSource({
    name: 'job',
    source: workflowRuntimeController,
    healthyMessage: 'job runtime via Kubernetes Jobs',
    defaultMessage: 'job runtime unavailable',
  })

  const runtimeAdapters: RuntimeAdapterStatus[] = [
    workflowAdapter,
    jobAdapter,
    await (deps.resolveTemporalAdapter ?? resolveTemporalAdapter)(),
    {
      name: 'custom',
      available: true,
      status: 'unknown',
      message: 'custom runtime configured per AgentRun',
      endpoint: '',
      authority: localAuthority('agents'),
    },
  ]

  const database = await (deps.checkDatabase ?? checkDatabase)()
  const grpcStatus = options.grpc
  const watchReliability = (deps.getWatchReliabilitySummary ?? getWatchReliabilitySummary)()
  let rolloutHealth: ControlPlaneRolloutHealth
  try {
    rolloutHealth = await buildRolloutHealth({ namespace: options.namespace, kube: createKubernetesClient() })
  } catch {
    rolloutHealth = unknownRolloutHealth()
  }
  const effectiveControllers = [
    maybeUseSplitTopologyControllerRollout({
      namespace: options.namespace,
      now,
      controller: agentsController,
      health: agentsHealth,
      rolloutHealth,
    }),
    maybeUseSplitTopologyControllerRollout({
      namespace: options.namespace,
      now,
      controller: supportingController,
      health: supportingHealth,
      rolloutHealth,
    }),
    maybeUseSplitTopologyControllerRollout({
      namespace: options.namespace,
      now,
      controller: orchestrationController,
      health: orchestrationHealth,
      rolloutHealth,
    }),
  ]
  const effectiveRuntimeAdapters = runtimeAdapters.map((adapter) =>
    maybeUseSplitTopologyRuntimeRollout({
      namespace: options.namespace,
      now,
      adapter,
      health: agentsHealth,
      rolloutHealth,
    }),
  )
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

  const workflows = await (deps.getWorkflowsReliabilityStatus ?? resolveWorkflowsReliabilityStatus)({
    now,
    namespace: options.namespace,
    namespaces: resolveWorkflowNamespaces(options.namespace),
    windowMinutes: resolveWorkflowWindowMinutes(),
    swarms: resolveWorkflowSwarms(),
    kube: createKubernetesClient(),
  })
  const empiricalServices = await (deps.resolveEmpiricalServices ?? resolveEmpiricalServices)()

  const isWorkflowsDataUnknown = workflows.data_confidence === 'unknown'
  const isWorkflowsDataDegraded = workflows.data_confidence === 'degraded'
  const isWorkflowsDataUnavailable = isWorkflowsDataUnknown || isWorkflowsDataDegraded
  const isWorkflowsWarning = workflows.backoff_limit_exceeded_jobs >= warningBackoffThreshold
  const isWorkflowsDegraded = workflows.backoff_limit_exceeded_jobs >= degradedBackoffThreshold
  const agentRunIngestion = buildAgentRunIngestionStatus(options.namespace, agentsHealth)
  const dependencyQuorum = buildDependencyQuorum({
    controllers: effectiveControllers,
    runtimeAdapters: effectiveRuntimeAdapters,
    database,
    watchReliability,
    workflows,
    rolloutHealth,
    empiricalServices,
    warningBackoffThreshold,
    degradedBackoffThreshold,
  })

  const leaderElection = getLeaderElectionStatus()

  const degradedComponents = [
    ...effectiveControllers
      .filter(
        (controller) =>
          controller.status === 'degraded' || controller.status === 'disabled' || controller.status === 'unknown',
      )
      .map((controller) => controller.name),
    ...effectiveRuntimeAdapters
      .filter((adapter) => adapter.name !== 'custom' && (adapter.status === 'degraded' || adapter.status === 'unknown'))
      .map((adapter) => `runtime:${adapter.name}`),
    ...(database.status === 'healthy' ? [] : ['database']),
    ...(grpcStatus.enabled && grpcStatus.status !== 'healthy' ? ['grpc'] : []),
    ...(watchReliability.status === 'degraded' ? ['watch_reliability'] : []),
    ...(agentRunIngestion.status === 'degraded' ? ['agentrun_ingestion'] : []),
    ...(isWorkflowsDataUnavailable || isWorkflowsWarning || isWorkflowsDegraded ? ['workflows'] : []),
    ...(isWorkflowsDataUnknown || isWorkflowsDegraded ? ['runtime:workflows'] : []),
    ...(rolloutHealth.status === 'degraded' ? ['rollout_health'] : []),
    ...(empiricalServices.forecast.status === 'degraded' ? ['empirical:forecast'] : []),
    ...(empiricalServices.lean.status === 'degraded' ? ['empirical:lean'] : []),
    ...(empiricalServices.jobs.status === 'degraded' ? ['empirical:jobs'] : []),
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
    controllers: effectiveControllers,
    runtime_adapters: effectiveRuntimeAdapters,
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
    agentrun_ingestion: agentRunIngestion,
    rollout_health: rolloutHealth,
    workflows,
    dependency_quorum: dependencyQuorum,
    empirical_services: empiricalServices,
    namespaces: [
      {
        namespace: options.namespace,
        status: degradedComponents.length === 0 ? 'healthy' : 'degraded',
        degraded_components: degradedComponents,
      },
    ],
  }
}
