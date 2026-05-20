export type ComponentStatus = 'healthy' | 'degraded' | 'disabled' | 'unknown'

export type HeartbeatAuthoritySource = {
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
  status: ComponentStatus
  message: string
  authority: HeartbeatAuthoritySource
}

export type RuntimeAdapterStatus = {
  name: string
  available: boolean
  status: ComponentStatus | 'configured'
  message: string
  endpoint: string
  authority: HeartbeatAuthoritySource
}

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
  status: 'healthy' | 'degraded' | 'disabled' | 'unknown'
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

export type ControlPlaneWatchReliabilityStream = {
  resource: string
  namespace: string
  events: number
  errors: number
  restarts: number
  last_seen_at: string
  error_reasons?: Record<string, number>
  restart_reasons?: Record<string, number>
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

export type WorkflowFailureReason = {
  reason: string
  count: number
}

export type WorkflowDataConfidence = 'high' | 'degraded' | 'unknown'

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

export type NamespaceStatus = {
  namespace: string
  status: 'healthy' | 'degraded'
  degraded_components: string[]
}

export type AgentsControlPlaneStatus = {
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
  runtime_kits: unknown[]
  admission_passports: unknown[]
  serving_passport_id: string | null
  recovery_warrants: unknown[]
  runtime_proof_cells: unknown[]
  projection_watermarks: unknown[]
  workflows: WorkflowsReliabilityStatus
  rollout_health: ControlPlaneRolloutHealth
  namespaces: NamespaceStatus[]
}
