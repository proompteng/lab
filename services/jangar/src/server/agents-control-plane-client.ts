import type {
  AgentRunIngestionStatus,
  AgentsControlPlaneStatus,
} from '@proompteng/agent-contracts/control-plane-status'
import { fetchAgentsServiceJson } from '@proompteng/agent-contracts/agents-service-client'

export type AgentsControllerHealthSnapshot = {
  enabled: boolean
  started: boolean
  namespaces: string[] | null
  crdsReady: boolean | null
  missingCrds: string[]
  lastCheckedAt: string | null
  agentRunIngestion?: Array<{
    namespace: string
    lastWatchEventAt: string | null
    lastResyncAt: string | null
    untouchedRunCount: number
    oldestUntouchedAgeSeconds: number | null
  }>
}

export type AgentsLeaderElectionSnapshot = {
  required: boolean
  isLeader: boolean
  lastAttemptAt: string | null
  lastError: string | null
  [key: string]: unknown
}

export type AgentsReadyPayload = {
  schemaVersion?: string
  status?: 'ok' | 'degraded'
  service?: 'agents' | string
  httpReady?: boolean
  reason_codes?: string[]
  namespaces?: string[]
  agentrun_ingestion?: AgentRunIngestionStatus[]
  leaderElection?: AgentsLeaderElectionSnapshot
  agentsController?: AgentsControllerHealthSnapshot
  orchestrationController?: AgentsControllerHealthSnapshot
  supportingController?: AgentsControllerHealthSnapshot
}

export type AgentsReadySnapshot = {
  available: boolean
  httpStatus: number
  status: 'ok' | 'degraded'
  httpReady: boolean
  reasonCodes: string[]
  namespaces: string[]
  leaderElection: AgentsLeaderElectionSnapshot
  agentRunIngestion: AgentRunIngestionStatus[]
  agentsController: AgentsControllerHealthSnapshot
  orchestrationController: AgentsControllerHealthSnapshot
  supportingController: AgentsControllerHealthSnapshot
  raw: AgentsReadyPayload
  error: string | null
}

export type AgentsControlPlaneStatusSnapshot = {
  available: boolean
  httpStatus: number
  status: AgentsControlPlaneStatus
  raw: AgentsControlPlaneStatus | null
  error: string | null
}

export const uniqueStrings = (values: string[]) => [...new Set(values.filter((value) => value.length > 0))]

const fallbackController = (namespace = 'agents'): AgentsControllerHealthSnapshot => ({
  enabled: true,
  started: false,
  namespaces: [namespace],
  crdsReady: false,
  missingCrds: [],
  lastCheckedAt: null,
  agentRunIngestion: [],
})

const fallbackLeaderElection = (error: string | null): AgentsLeaderElectionSnapshot => ({
  required: true,
  isLeader: false,
  lastAttemptAt: null,
  lastError: error ?? 'Agents service readiness unavailable',
})

const fallbackGenericStatus = (namespace: string, error: string | null): AgentsControlPlaneStatus => {
  const generatedAt = new Date().toISOString()
  const message = error ?? 'Agents control-plane status unavailable'
  const authority = {
    mode: 'unknown' as const,
    namespace,
    source_deployment: '',
    source_pod: '',
    observed_at: generatedAt,
    fresh: false,
    message,
  }

  return {
    service: 'agents',
    generated_at: generatedAt,
    leader_election: {
      enabled: true,
      required: true,
      is_leader: false,
      lease_name: '',
      lease_namespace: namespace,
      identity: '',
      last_transition_at: '',
      last_attempt_at: '',
      last_success_at: '',
      last_error: message,
    },
    controllers: [
      {
        name: 'agents-controller',
        enabled: true,
        started: false,
        scope_namespaces: [namespace],
        crds_ready: false,
        missing_crds: [],
        last_checked_at: '',
        status: 'unknown',
        message,
        authority,
      },
    ],
    runtime_adapters: [],
    database: {
      configured: false,
      connected: false,
      status: 'unknown',
      message,
      latency_ms: 0,
      migration_consistency: {
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
      },
    },
    grpc: {
      enabled: false,
      address: '',
      status: 'degraded',
      message,
    },
    watch_reliability: {
      status: 'unknown',
      window_minutes: 0,
      observed_streams: 0,
      total_events: 0,
      total_errors: 0,
      total_restarts: 0,
      streams: [],
    },
    agentrun_ingestion: {
      namespace,
      status: 'unknown',
      message,
      last_watch_event_at: null,
      last_resync_at: null,
      untouched_run_count: 0,
      oldest_untouched_age_seconds: null,
    },
    control_plane_controller_witness: {
      mode: 'shadow',
      design_artifact:
        'docs/agents/designs/116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md',
      quorum_id: `controller-witness:${namespace}:agents-control-plane-status-unavailable`,
      generated_at: generatedAt,
      expires_at: generatedAt,
      namespace,
      decision: 'hold_material',
      reason_codes: ['agents_control_plane_status_unavailable'],
      message,
      witness_refs: [],
      deployment_available: false,
      watch_epoch_current: false,
      controller_self_report_current: false,
      witnesses: [],
      rollback_target: 'restore Agents control-plane status service',
    },
    runtime_kits: [],
    admission_passports: [],
    serving_passport_id: null,
    recovery_warrants: [],
    runtime_proof_cells: [],
    projection_watermarks: [],
    workflows: {
      active_job_runs: 0,
      recent_failed_jobs: 0,
      backoff_limit_exceeded_jobs: 0,
      window_minutes: 0,
      top_failure_reasons: [],
      data_confidence: 'unknown',
      collection_errors: 1,
      collected_namespaces: 0,
      target_namespaces: 1,
      message,
    },
    rollout_health: {
      status: 'unknown',
      observed_deployments: 0,
      degraded_deployments: 0,
      deployments: [],
      message,
    },
    namespaces: [{ namespace, status: 'degraded', degraded_components: ['agents_control_plane_status'] }],
  }
}

const normalizeStatus = (value: unknown): 'ok' | 'degraded' => (value === 'ok' ? 'ok' : 'degraded')

const normalizeController = (
  value: AgentsControllerHealthSnapshot | undefined,
  namespace: string,
): AgentsControllerHealthSnapshot => {
  if (!value || typeof value !== 'object') return fallbackController(namespace)
  return {
    enabled: Boolean(value.enabled),
    started: Boolean(value.started),
    namespaces: Array.isArray(value.namespaces) ? value.namespaces.filter((item) => typeof item === 'string') : null,
    crdsReady:
      typeof value.crdsReady === 'boolean' || value.crdsReady === null || value.crdsReady === undefined
        ? (value.crdsReady ?? null)
        : false,
    missingCrds: Array.isArray(value.missingCrds) ? value.missingCrds.filter((item) => typeof item === 'string') : [],
    lastCheckedAt: typeof value.lastCheckedAt === 'string' ? value.lastCheckedAt : null,
    agentRunIngestion: Array.isArray(value.agentRunIngestion) ? value.agentRunIngestion : [],
  }
}

const normalizeLeaderElection = (
  value: AgentsLeaderElectionSnapshot | undefined,
  error: string | null,
): AgentsLeaderElectionSnapshot => {
  if (!value || typeof value !== 'object') return fallbackLeaderElection(error)
  return {
    ...value,
    required: Boolean(value.required),
    isLeader: Boolean(value.isLeader),
    lastAttemptAt: typeof value.lastAttemptAt === 'string' ? value.lastAttemptAt : null,
    lastError: typeof value.lastError === 'string' ? value.lastError : null,
  }
}

const normalizeAgentRunIngestionStatus = (
  value: AgentRunIngestionStatus | undefined,
  namespace: string,
): AgentRunIngestionStatus => {
  if (!value || typeof value !== 'object') {
    return {
      namespace,
      status: 'unknown',
      message: 'Agents service did not report AgentRun ingestion status',
      last_watch_event_at: null,
      last_resync_at: null,
      untouched_run_count: 0,
      oldest_untouched_age_seconds: null,
    }
  }

  const status =
    value.status === 'healthy' || value.status === 'degraded' || value.status === 'unknown' ? value.status : 'unknown'
  return {
    namespace: typeof value.namespace === 'string' && value.namespace.length > 0 ? value.namespace : namespace,
    status,
    message: typeof value.message === 'string' ? value.message : 'Agents service reported AgentRun ingestion status',
    last_watch_event_at: typeof value.last_watch_event_at === 'string' ? value.last_watch_event_at : null,
    last_resync_at: typeof value.last_resync_at === 'string' ? value.last_resync_at : null,
    untouched_run_count: Number.isFinite(value.untouched_run_count) ? Math.max(0, value.untouched_run_count) : 0,
    oldest_untouched_age_seconds:
      value.oldest_untouched_age_seconds === null || Number.isFinite(value.oldest_untouched_age_seconds)
        ? value.oldest_untouched_age_seconds
        : null,
  }
}

const normalizeAgentRunIngestionStatuses = (
  values: AgentRunIngestionStatus[] | undefined,
  namespaces: string[],
): AgentRunIngestionStatus[] => {
  const payloadValues = Array.isArray(values) ? values : []
  if (payloadValues.length === 0) {
    return namespaces.map((namespace) => normalizeAgentRunIngestionStatus(undefined, namespace))
  }
  return payloadValues.map((value, index) => normalizeAgentRunIngestionStatus(value, namespaces[index] ?? 'agents'))
}

export const isControllerHealthReady = (health: Pick<AgentsControllerHealthSnapshot, 'enabled' | 'crdsReady'>) =>
  !health.enabled || health.crdsReady !== false

export const buildAgentsReadySnapshot = (input: {
  payload: AgentsReadyPayload | null
  httpStatus: number
  error?: string | null
}): AgentsReadySnapshot => {
  const payload = input.payload ?? {}
  const error = input.error ?? null
  const status = normalizeStatus(payload.status)
  const agentsController = normalizeController(payload.agentsController, 'agents')
  const namespaces = uniqueStrings(
    payload.namespaces?.length
      ? payload.namespaces
      : agentsController.namespaces?.length
        ? agentsController.namespaces
        : ['agents'],
  )
  const primaryNamespace = namespaces[0] ?? 'agents'
  const leaderElection = normalizeLeaderElection(payload.leaderElection, error)
  const orchestrationController = normalizeController(payload.orchestrationController, primaryNamespace)
  const supportingController = normalizeController(payload.supportingController, primaryNamespace)
  const agentRunIngestion = normalizeAgentRunIngestionStatuses(payload.agentrun_ingestion, namespaces)
  const raw: AgentsReadyPayload = {
    schemaVersion: payload.schemaVersion ?? 'agents.proompteng.ai/ready/v1',
    status,
    service: payload.service ?? 'agents',
    httpReady: payload.httpReady ?? false,
    reason_codes: Array.isArray(payload.reason_codes) ? payload.reason_codes : [],
    namespaces,
    agentrun_ingestion: agentRunIngestion,
    leaderElection,
    agentsController,
    orchestrationController,
    supportingController,
  }

  return {
    available: input.payload !== null,
    httpStatus: input.httpStatus,
    status,
    httpReady: raw.httpReady ?? false,
    reasonCodes: raw.reason_codes ?? [],
    namespaces,
    leaderElection,
    agentRunIngestion,
    agentsController,
    orchestrationController,
    supportingController,
    raw,
    error,
  }
}

export const getAgentsReadySnapshot = async (): Promise<AgentsReadySnapshot> => {
  const result = await fetchAgentsServiceJson<AgentsReadyPayload>('/ready')
  return buildAgentsReadySnapshot({
    payload: result.body,
    httpStatus: result.status,
    error: result.ok ? null : result.error,
  })
}

export const getAgentsControlPlaneStatusSnapshot = async (
  namespace = 'agents',
): Promise<AgentsControlPlaneStatusSnapshot> => {
  const result = await fetchAgentsServiceJson<AgentsControlPlaneStatus>(
    `/api/agents/control-plane/status?namespace=${encodeURIComponent(namespace)}`,
  )
  const error = result.ok ? null : (result.error ?? `Agents service returned HTTP ${result.status}`)
  const fallback = fallbackGenericStatus(namespace, error)
  const status = result.body ?? fallback
  return {
    available: result.ok && result.body !== null,
    httpStatus: result.status,
    status,
    raw: result.body,
    error,
  }
}

export type AgentsControllerHealthSnapshotDeps = {
  getAgentsReadySnapshot?: () => Promise<AgentsReadySnapshot>
  getAgentsControllerHealth?: () => AgentsControllerHealthSnapshot
  getSupportingControllerHealth?: () => AgentsControllerHealthSnapshot
  getOrchestrationControllerHealth?: () => AgentsControllerHealthSnapshot
}

export const resolveAgentsControllerHealthSnapshots = async (deps: AgentsControllerHealthSnapshotDeps = {}) => {
  let snapshot: AgentsReadySnapshot | null = null
  const resolveSnapshot = async (): Promise<AgentsReadySnapshot> => {
    snapshot ??= await (deps.getAgentsReadySnapshot ?? getAgentsReadySnapshot)()
    return snapshot
  }
  const readySnapshot = await resolveSnapshot()

  return {
    reasonCodes: readySnapshot.reasonCodes,
    agentsHealth: deps.getAgentsControllerHealth ? deps.getAgentsControllerHealth() : readySnapshot.agentsController,
    supportingHealth: deps.getSupportingControllerHealth
      ? deps.getSupportingControllerHealth()
      : readySnapshot.supportingController,
    orchestrationHealth: deps.getOrchestrationControllerHealth
      ? deps.getOrchestrationControllerHealth()
      : readySnapshot.orchestrationController,
  }
}
