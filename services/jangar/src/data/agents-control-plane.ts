export type AgentPrimitiveKind =
  | 'Agent'
  | 'AgentRun'
  | 'AgentProvider'
  | 'ImplementationSpec'
  | 'ImplementationSource'
  | 'Memory'
  | 'Tool'
  | 'ToolRun'
  | 'ApprovalPolicy'
  | 'Budget'
  | 'Signal'
  | 'SignalDelivery'
  | 'Schedule'
  | 'Swarm'
  | 'Artifact'
  | 'Workspace'
  | 'SecretBinding'
  | 'Orchestration'
  | 'OrchestrationRun'

export type PrimitiveResource = {
  apiVersion: string | null
  kind: string | null
  metadata: Record<string, unknown>
  spec: Record<string, unknown>
  status: Record<string, unknown>
}

export type PrimitiveListResult =
  | { ok: true; items: PrimitiveResource[]; total: number; kind: AgentPrimitiveKind; namespace: string }
  | { ok: false; message: string; status?: number; raw?: unknown }

export type PrimitiveDetailResult =
  | { ok: true; resource: PrimitiveResource; kind: AgentPrimitiveKind; namespace: string }
  | { ok: false; message: string; status?: number; raw?: unknown }

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const normalizePrimitiveResource = (value: unknown): PrimitiveResource => {
  const record = asRecord(value)
  return {
    apiVersion: typeof record.apiVersion === 'string' ? record.apiVersion : null,
    kind: typeof record.kind === 'string' ? record.kind : null,
    metadata: asRecord(record.metadata),
    spec: asRecord(record.spec),
    status: asRecord(record.status),
  }
}

export type PrimitiveEventItem = {
  name: string | null
  namespace: string | null
  type: string | null
  reason: string | null
  action: string | null
  count: number | null
  message: string | null
  firstTimestamp: string | null
  lastTimestamp: string | null
  eventTime: string | null
  involvedObject: unknown
}

export type PrimitiveEventsResult =
  | {
      ok: true
      items: PrimitiveEventItem[]
      kind: AgentPrimitiveKind
      namespace: string
      name: string
    }
  | { ok: false; message: string; status?: number; raw?: unknown }

export type AgentRunLogContainer = {
  name: string
  type: 'main' | 'init'
}

export type AgentRunLogPod = {
  name: string
  phase: string | null
  containers: AgentRunLogContainer[]
}

export type AgentRunLogsResult =
  | {
      ok: true
      name: string
      namespace: string
      pods: AgentRunLogPod[]
      logs: string
      pod: string | null
      container: string | null
      tailLines: number | null
    }
  | { ok: false; message: string; status?: number; raw?: unknown }

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

export type HeartbeatAuthoritySource = {
  mode: 'heartbeat' | 'local' | 'rollout' | 'unknown'
  namespace: string
  source_deployment: string
  source_pod: string
  observed_at: string | null
  fresh: boolean
  message: string
}

export type WorkflowFailureReason = {
  reason: string
  count: number
}

export type WorkflowDataConfidence = 'high' | 'degraded' | 'unknown'

export type DatabaseMigrationConsistency = {
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

export type DatabaseStatus = {
  configured: boolean
  connected: boolean
  status: 'healthy' | 'degraded' | 'disabled'
  message: string
  latency_ms: number
  migration_consistency: DatabaseMigrationConsistency
}

export type WorkflowsReliabilityStatus = {
  active_job_runs: number
  recent_failed_jobs: number
  backoff_limit_exceeded_jobs: number
  window_minutes: number
  top_failure_reasons: WorkflowFailureReason[]
  data_confidence: WorkflowDataConfidence
  collection_errors: number
  collected_namespaces: number
  target_namespaces: number
  message: string
}

export type ExecutionTrustStatus = {
  status: 'healthy' | 'degraded' | 'blocked' | 'unknown'
  reason: string
  last_evaluated_at: string
  blocking_windows: Array<{
    type: 'swarms' | 'stages' | 'dependencies'
    scope: string
    name?: string
    reason: string
    class: 'degraded' | 'blocked' | 'unknown'
  }>
  evidence_summary: string[]
}

export type ExecutionTrustSwarm = {
  name: string
  namespace: string
  phase: string
  ready: boolean
  updated_at: string | null
  observed_generation: number | null
  freeze: {
    reason: string | null
    until: string | null
  } | null
  requirements_pending: number
  requirements_pending_class: 'healthy' | 'degraded' | 'blocked' | 'unknown'
  last_discover_at: string | null
  last_plan_at: string | null
  last_implement_at: string | null
  last_verify_at: string | null
}

export type ExecutionTrustStage = {
  swarm: string
  namespace: string
  stage: 'discover' | 'plan' | 'implement' | 'verify'
  phase: string
  last_run_at: string | null
  next_expected_at: string | null
  configured_every_ms: number | null
  age_ms: number | null
  stale_after_ms: number | null
  stale: boolean
  recent_failed_jobs: number
  recent_backoff_limit_exceeded_jobs: number
  last_failure_reason: string | null
  data_confidence: 'high' | 'degraded' | 'unknown'
}

export type DependencyQuorumDecision = 'allow' | 'delay' | 'block' | 'unknown'

export type DependencyQuorumSegmentStatus = 'healthy' | 'degraded' | 'blocked'

export type DependencyQuorumSegmentScope = 'global' | 'capital_family' | 'hypothesis_scoped' | 'single_capability'

export type DependencyQuorumSegmentName =
  | 'control_runtime'
  | 'dependency_quorum'
  | 'freshness_authority'
  | 'evidence_authority'
  | 'market_data_context'
  | 'watch_stream'

export type DependencyQuorumConfidence = 'high' | 'medium' | 'low'

export type DependencyQuorumSegment = {
  segment: DependencyQuorumSegmentName
  status: DependencyQuorumSegmentStatus
  scope: DependencyQuorumSegmentScope
  confidence: DependencyQuorumConfidence
  reasons: string[]
  as_of: string
}

export type DependencyQuorumStatus = {
  decision: DependencyQuorumDecision
  reasons: string[]
  message: string
  segments?: DependencyQuorumSegment[]
  degradation_scope?: DependencyQuorumSegmentScope
}

export type DeploymentRolloutStatus = {
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

export type ControlPlaneRolloutHealth = {
  status: 'healthy' | 'degraded' | 'unknown'
  observed_deployments: number
  degraded_deployments: number
  deployments: DeploymentRolloutStatus[]
  message: string
}

export type ControlPlaneWatchReliabilityStream = {
  resource: string
  namespace: string
  events: number
  errors: number
  restarts: number
  last_seen_at: string
}

export type ControlPlaneWatchReliability = {
  status: 'healthy' | 'degraded' | 'unknown'
  window_minutes: number
  observed_streams: number
  total_events: number
  total_errors: number
  total_restarts: number
  streams: ControlPlaneWatchReliabilityStream[]
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
  /**
   * Keep this field in sync with generated CRD annotations for CEL checks.
   */
  workflows: WorkflowsReliabilityStatus
  dependency_quorum: DependencyQuorumStatus
  database: DatabaseStatus
  grpc: GrpcStatus
  watch_reliability: ControlPlaneWatchReliability
  agentrun_ingestion: AgentRunIngestionStatus
  rollout_health: ControlPlaneRolloutHealth
  empirical_services: EmpiricalServicesStatus
  execution_trust?: ExecutionTrustStatus
  swarms?: ExecutionTrustSwarm[]
  stages?: ExecutionTrustStage[]
  namespaces: NamespaceStatus[]
}

export type ControlPlaneStatusResult =
  | { ok: true; status: ControlPlaneStatus }
  | { ok: false; message: string; status?: number; raw?: unknown }

const extractErrorMessage = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  if (typeof record.error === 'string') return record.error
  if (typeof record.message === 'string') return record.message
  if (typeof record.detail === 'string') return record.detail
  return null
}

const parseResponse = async (response: Response) => {
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    return {
      ok: false as const,
      message: extractErrorMessage(payload) ?? response.statusText,
      status: response.status,
      raw: payload,
    }
  }
  return payload
}

export const fetchPrimitiveList = async (params: {
  kind: AgentPrimitiveKind
  namespace: string
  labelSelector?: string
  phase?: string
  runtime?: string
  limit?: number
  signal?: AbortSignal
}): Promise<PrimitiveListResult> => {
  const searchParams = new URLSearchParams({
    kind: params.kind,
    namespace: params.namespace,
  })
  if (params.phase) {
    searchParams.set('phase', params.phase)
  }
  if (params.runtime) {
    searchParams.set('runtime', params.runtime)
  }
  if (params.labelSelector) {
    searchParams.set('labelSelector', params.labelSelector)
  }
  if (params.limit) {
    searchParams.set('limit', params.limit.toString())
  }

  const response = await fetch(`/api/agents/control-plane/resources?${searchParams.toString()}`, {
    signal: params.signal,
  })

  const payload = await parseResponse(response)
  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: 'Invalid response payload', status: response.status }
  }
  if ('ok' in payload && payload.ok === false) {
    return {
      ok: false,
      message: extractErrorMessage(payload) ?? 'Request failed',
      status: response.status,
      raw: payload,
    }
  }

  const record = payload as Record<string, unknown>
  const items = Array.isArray(record.items) ? (record.items as PrimitiveResource[]) : []
  const total = typeof record.total === 'number' ? record.total : items.length
  const namespace = typeof record.namespace === 'string' ? record.namespace : params.namespace
  return { ok: true, items, total, kind: params.kind, namespace }
}

export const fetchPrimitiveDetail = async (params: {
  kind: AgentPrimitiveKind
  name: string
  namespace: string
  signal?: AbortSignal
}): Promise<PrimitiveDetailResult> => {
  const searchParams = new URLSearchParams({
    kind: params.kind,
    name: params.name,
    namespace: params.namespace,
  })
  const response = await fetch(`/api/agents/control-plane/resource?${searchParams.toString()}`, {
    signal: params.signal,
  })
  const payload = await parseResponse(response)
  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: 'Invalid response payload', status: response.status }
  }
  if ('ok' in payload && payload.ok === false) {
    return {
      ok: false,
      message: extractErrorMessage(payload) ?? 'Request failed',
      status: response.status,
      raw: payload,
    }
  }
  const record = payload as Record<string, unknown>
  const resource = normalizePrimitiveResource(record.resource)
  const namespace = typeof record.namespace === 'string' ? record.namespace : params.namespace
  return { ok: true, resource, kind: params.kind, namespace }
}

export const deletePrimitiveResource = async (params: {
  kind: AgentPrimitiveKind
  name: string
  namespace: string
}): Promise<PrimitiveDetailResult> => {
  const searchParams = new URLSearchParams({
    kind: params.kind,
    name: params.name,
    namespace: params.namespace,
  })
  const response = await fetch(`/api/agents/control-plane/resource?${searchParams.toString()}`, {
    method: 'DELETE',
  })
  const payload = await parseResponse(response)
  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: 'Invalid response payload', status: response.status }
  }
  if ('ok' in payload && payload.ok === false) {
    return {
      ok: false,
      message: extractErrorMessage(payload) ?? 'Request failed',
      status: response.status,
      raw: payload,
    }
  }
  const record = payload as Record<string, unknown>
  const resource = normalizePrimitiveResource(record.resource)
  const namespace = typeof record.namespace === 'string' ? record.namespace : params.namespace
  return { ok: true, resource, kind: params.kind, namespace }
}

export const fetchPrimitiveEvents = async (params: {
  kind: AgentPrimitiveKind
  name: string
  namespace: string
  uid?: string | null
  limit?: number
  signal?: AbortSignal
}): Promise<PrimitiveEventsResult> => {
  const searchParams = new URLSearchParams({
    kind: params.kind,
    name: params.name,
    namespace: params.namespace,
  })
  if (params.uid) {
    searchParams.set('uid', params.uid)
  }
  if (params.limit) {
    searchParams.set('limit', params.limit.toString())
  }

  const response = await fetch(`/api/agents/control-plane/events?${searchParams.toString()}`, {
    signal: params.signal,
  })
  const payload = await parseResponse(response)
  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: 'Invalid response payload', status: response.status }
  }
  if ('ok' in payload && payload.ok === false) {
    return {
      ok: false,
      message: extractErrorMessage(payload) ?? 'Request failed',
      status: response.status,
      raw: payload,
    }
  }
  const record = payload as Record<string, unknown>
  const items = Array.isArray(record.items) ? (record.items as PrimitiveEventItem[]) : []
  const namespace = typeof record.namespace === 'string' ? record.namespace : params.namespace
  const name = typeof record.name === 'string' ? record.name : params.name
  return { ok: true, items, kind: params.kind, namespace, name }
}

export const fetchAgentRunLogs = async (params: {
  name: string
  namespace: string
  pod?: string | null
  container?: string | null
  tailLines?: number | null
  signal?: AbortSignal
}): Promise<AgentRunLogsResult> => {
  const searchParams = new URLSearchParams({
    name: params.name,
    namespace: params.namespace,
  })
  if (params.pod) {
    searchParams.set('pod', params.pod)
  }
  if (params.container) {
    searchParams.set('container', params.container)
  }
  if (params.tailLines && Number.isFinite(params.tailLines)) {
    searchParams.set('tailLines', Math.max(1, Math.floor(params.tailLines)).toString())
  }

  const response = await fetch(`/api/agents/control-plane/logs?${searchParams.toString()}`, {
    signal: params.signal,
  })
  const payload = await parseResponse(response)
  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: 'Invalid response payload', status: response.status }
  }
  if ('ok' in payload && payload.ok === false) {
    return {
      ok: false,
      message: extractErrorMessage(payload) ?? 'Request failed',
      status: response.status,
      raw: payload,
    }
  }

  const record = payload as Record<string, unknown>
  const pods = Array.isArray(record.pods) ? (record.pods as AgentRunLogPod[]) : []
  const logs = typeof record.logs === 'string' ? record.logs : ''
  const pod = typeof record.pod === 'string' ? record.pod : null
  const container = typeof record.container === 'string' ? record.container : null
  const tailLines = typeof record.tailLines === 'number' ? record.tailLines : null
  return {
    ok: true,
    name: typeof record.name === 'string' ? record.name : params.name,
    namespace: typeof record.namespace === 'string' ? record.namespace : params.namespace,
    pods,
    logs,
    pod,
    container,
    tailLines,
  }
}

export const fetchControlPlaneStatus = async (params: {
  namespace: string
  signal?: AbortSignal
}): Promise<ControlPlaneStatusResult> => {
  const searchParams = new URLSearchParams({ namespace: params.namespace })
  const response = await fetch(`/api/agents/control-plane/status?${searchParams.toString()}`, {
    signal: params.signal,
  })

  const payload = await parseResponse(response)
  if (!payload || typeof payload !== 'object') {
    return { ok: false, message: 'Invalid response payload', status: response.status }
  }
  if ('ok' in payload && payload.ok === false) {
    return {
      ok: false,
      message: extractErrorMessage(payload) ?? 'Request failed',
      status: response.status,
      raw: payload,
    }
  }

  return { ok: true, status: payload as ControlPlaneStatus }
}
