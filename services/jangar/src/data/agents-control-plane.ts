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

export type AgentOption = {
  name: string
  provider: string | null
}

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

export type RuntimeKitClass = 'serving' | 'collaboration'

export type RuntimeKitDecision = 'healthy' | 'degraded' | 'blocked' | 'unknown'

export type RuntimeKitComponentKind = 'python_helper' | 'binary' | 'workspace_path' | 'config_file' | 'service_url'

export type RuntimeKitComponentStatus = {
  component_kind: RuntimeKitComponentKind
  component_ref: string
  required: boolean
  present: boolean
  digest: string | null
  reason_code: string | null
  evidence_ref: string | null
}

export type RuntimeKitStatus = {
  runtime_kit_id: string
  kit_class: RuntimeKitClass
  subject_ref: string
  image_ref: string
  workspace_contract_version: string
  component_digest: string
  decision: RuntimeKitDecision
  observed_at: string
  fresh_until: string
  producer_revision: string
  reason_codes: string[]
  components: RuntimeKitComponentStatus[]
}

export type AdmissionPassportConsumerClass = 'serving' | 'swarm_plan' | 'swarm_implement' | 'swarm_verify'

export type AdmissionPassportDecision = 'allow' | 'degrade' | 'hold' | 'block'

export type AdmissionPassportSubjectStatus = {
  subject_kind: 'authority' | 'runtime_kit'
  subject_ref: string
  required: boolean
  decision: AdmissionPassportDecision
  evidence_ref: string | null
}

export type AdmissionPassportStatus = {
  admission_passport_id: string
  consumer_class: AdmissionPassportConsumerClass
  authority_session_id: string
  recovery_case_set_digest: string
  runtime_kit_set_digest: string
  decision: AdmissionPassportDecision
  reason_codes: string[]
  required_subjects: AdmissionPassportSubjectStatus[]
  required_runtime_kits: string[]
  issued_at: string
  fresh_until: string
  producer_revision: string
}

export type RecoveryWarrantExecutionClass =
  | 'serving'
  | 'collaboration'
  | 'discover'
  | 'plan'
  | 'implement'
  | 'verify'
  | 'torghut_quant'

export type RecoveryWarrantStatusValue = 'draft' | 'active' | 'sealed' | 'superseded' | 'broken' | 'quarantined'

export type RuntimeProofKind =
  | 'image_digest'
  | 'runtime_kit'
  | 'helper_asset'
  | 'config_digest'
  | 'secret_binding'
  | 'network_identity'

export type RuntimeProofCellStatusValue = 'healthy' | 'degraded' | 'missing' | 'expired' | 'quarantined'

export type RuntimeProofCellStatus = {
  runtime_proof_cell_id: string
  recovery_warrant_id: string | null
  runtime_kit_id: string
  proof_kind: RuntimeProofKind
  proof_subject: string
  expected_ref: string | null
  observed_ref: string | null
  artifact_ref: string | null
  content_hash: string | null
  status: RuntimeProofCellStatusValue
  required: boolean
  reason_codes: string[]
  observed_at: string
  expires_at: string
}

export type ProjectionWatermarkStatusValue = 'fresh' | 'degraded' | 'expired' | 'quarantined'

export type ProjectionWatermarkConsumerKey =
  | 'jangar_ready'
  | 'control_plane_status'
  | 'deploy_verification'
  | 'torghut_dependency_quorum'
  | 'torghut_quant_health'
  | 'torghut_market_context'

export type ProjectionWatermarkStatus = {
  projection_watermark_id: string
  consumer_key: ProjectionWatermarkConsumerKey
  recovery_warrant_id: string
  projection_digest: string
  source_ref: string
  observed_at: string
  expires_at: string
  status: ProjectionWatermarkStatusValue
  reason_codes: string[]
}

export type RecoveryWarrantStatus = {
  recovery_warrant_id: string
  recovery_epoch_id: string
  swarm_name: string
  execution_class: RecoveryWarrantExecutionClass
  admitted_revision: string
  admitted_image_digest: string | null
  runtime_kit_digest: string
  admission_passport_id: string | null
  required_proof_cell_ids: string[]
  active_backlog_seat_count: number
  projection_watermark_ids: string[]
  status: RecoveryWarrantStatusValue
  opened_at: string
  sealed_at: string | null
  superseded_at: string | null
  reason_codes: string[]
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

export type FailureDomainLeaseDomain =
  | 'database'
  | 'route'
  | 'rollout'
  | 'registry'
  | 'storage'
  | 'workflow_artifact'
  | 'nats'
  | 'source_schema'
  | 'torghut_dependency'
  | 'manual_override'

export type FailureDomainLeaseStatus = 'valid' | 'degraded' | 'expired' | 'unknown' | 'override'

export type FailureDomainActionClass =
  | 'serve_readonly'
  | 'dispatch_normal'
  | 'dispatch_repair'
  | 'deploy_widen'
  | 'merge_ready'
  | 'torghut_observe'
  | 'torghut_capital'

export type FailureDomainLeaseIssuer =
  | 'controller'
  | 'verifier_job'
  | 'deployer'
  | 'manual_operator'
  | 'status_projector'

export type FailureDomainLease = {
  lease_id: string
  domain: FailureDomainLeaseDomain
  scope: string
  status: FailureDomainLeaseStatus
  action_classes: FailureDomainActionClass[]
  observed_at: string
  expires_at: string
  evidence_refs: string[]
  reason_codes: string[]
  rollback_target: string | null
  issuer: FailureDomainLeaseIssuer
}

export type FailureDomainHoldbackDecision = {
  action_class: FailureDomainActionClass
  decision: 'allow' | 'hold' | 'unknown'
  lease_ids: string[]
  reason_codes: string[]
  message: string
}

export type FailureDomainLeaseSet = {
  mode: 'shadow' | 'enforced'
  design_artifact: string
  lease_set_digest: string
  generated_at: string
  leases: FailureDomainLease[]
  holdbacks: FailureDomainHoldbackDecision[]
}

export type ReconciledActionClockDecision = 'allow' | 'observe_only' | 'repair_only' | 'hold' | 'block'

export type ReconciledActionClockConflictClass =
  | 'none'
  | 'stale_negative'
  | 'contradictory_positive_negative'
  | 'missing_authority'
  | 'consumer_debt'

export type ReconciledActionClockConfidence = 'high' | 'medium' | 'low'

export type ReconciledActionClock = {
  clock_id: string
  namespace: string
  action_class: FailureDomainActionClass
  decision: ReconciledActionClockDecision
  conflict_class: ReconciledActionClockConflictClass
  confidence: ReconciledActionClockConfidence
  observed_at: string
  fresh_until: string
  positive_lease_ids: string[]
  negative_lease_ids: string[]
  blocking_reason_codes: string[]
  required_repair_actions: string[]
  rollback_target: string | null
  producer_revision: string
  evidence_refs: string[]
}

export type NegativeEvidenceKind =
  | 'current_runtime_negative'
  | 'retained_audit_negative'
  | 'data_freshness_negative'
  | 'source_schema_negative'
  | 'rollout_ambiguity_negative'

export type ActionSloBudgetActionClass =
  | 'serve_readonly'
  | 'dispatch_repair'
  | 'dispatch_normal'
  | 'deploy_widen'
  | 'merge_ready'
  | 'torghut_observe'
  | 'paper_canary'
  | 'live_micro_canary'
  | 'live_scale'

export type ActionSloBudgetDecision = 'allow' | 'observe_only' | 'repair_only' | 'shadow_only' | 'hold' | 'block'

export type NegativeEvidenceRef = {
  kind: NegativeEvidenceKind
  reason: string
  evidence_refs: string[]
}

export type NegativeEvidenceRouterStatus = {
  mode: 'observe' | 'enforced'
  design_artifact: string
  router_epoch_id: string
  generated_at: string
  evidence_window_minutes: number
  positive_evidence_refs: string[]
  negative_evidence_refs: NegativeEvidenceRef[]
  contradiction_refs: string[]
  source_schema_ref: string | null
  database_projection_ref: string | null
  gitops_convergence_ref: string | null
  failure_domain_lease_refs: string[]
  consumer_refs: string[]
}

export type ActionSloBudget = {
  budget_id: string
  router_epoch_id: string
  action_class: ActionSloBudgetActionClass
  consumer: 'jangar' | 'agents' | 'torghut' | 'torghut-sim' | 'deployer' | 'engineer'
  scope: string
  decision: ActionSloBudgetDecision
  max_dispatches: number | null
  max_runtime_seconds: number | null
  max_notional: number | null
  max_error_budget_spend: number | null
  fresh_until: string
  downgrade_reasons: string[]
  blocked_reasons: string[]
  required_repairs: string[]
  rollback_target: string | null
  evidence_refs: string[]
}

export type ControllerWitnessSurface =
  | 'serving_process'
  | 'controller_process'
  | 'kubernetes_deployment'
  | 'watch_epoch'
  | 'agentrun_ingestion'

export type ControllerWitnessDecision = 'allow' | 'allow_with_split' | 'repair_only' | 'hold_material' | 'block'

export type ControlPlaneControllerWitness = {
  witness_id: string
  generated_at: string
  expires_at: string
  namespace: string
  controller_surface: ControllerWitnessSurface
  deployment_ref: string | null
  pod_uid: string | null
  image_ref: string | null
  leader_identity: string | null
  controller_started: boolean | null
  deployment_available: boolean | null
  watch_epoch_id: string | null
  ingestion_epoch_id: string | null
  last_watch_event_at: string | null
  last_resync_at: string | null
  observed_run_count: number | null
  untouched_run_count: number | null
  decision: ControllerWitnessDecision
  reason_codes: string[]
}

export type ControlPlaneControllerWitnessQuorum = {
  mode: 'shadow' | 'enforced'
  design_artifact: string
  quorum_id: string
  generated_at: string
  expires_at: string
  namespace: string
  decision: ControllerWitnessDecision
  reason_codes: string[]
  message: string
  witness_refs: string[]
  deployment_available: boolean
  watch_epoch_current: boolean
  controller_self_report_current: boolean
  witnesses: ControlPlaneControllerWitness[]
  rollback_target: string | null
}

export type MaterialActionActivationReceiptCapitalStage =
  | 'none'
  | 'observe'
  | 'shadow'
  | 'paper'
  | 'live_micro'
  | 'live_scale'

export type MaterialActionActivationReceiptDecision = 'allow' | 'observe_only' | 'repair_only' | 'hold' | 'block'

export type MaterialActionActivationReceipt = {
  receipt_id: string
  generated_at: string
  expires_at: string
  action_class: ActionSloBudgetActionClass
  scope: string
  controller_witness_refs: string[]
  route_stability_escrow_ref: string | null
  transport_contract_refs: string[]
  proof_freshness_refs: string[]
  positive_authority_refs: string[]
  negative_authority_refs: string[]
  capital_stage: MaterialActionActivationReceiptCapitalStage
  decision: MaterialActionActivationReceiptDecision
  max_dispatches: number | null
  max_runtime_seconds: number | null
  max_notional: number | null
  required_repairs: string[]
  rollback_target: string | null
}

export type MaterialActionVerdictDecision = 'allow' | 'repair_only' | 'hold' | 'block' | 'contradicted' | 'unknown'

export type MaterialActionVerdictConfidence = 'high' | 'medium' | 'low' | 'unknown'

export type MaterialActionVerdict = {
  verdict_id: string
  epoch_id: string
  action_class: ActionSloBudgetActionClass
  decision: MaterialActionVerdictDecision
  decision_rank: number
  confidence: MaterialActionVerdictConfidence
  allowed_until: string
  max_dispatches: number | null
  max_runtime_seconds: number | null
  max_notional: number | null
  blocking_reason_codes: string[]
  downgrade_reason_codes: string[]
  required_repair_actions: string[]
  rollback_target: string | null
  evidence_refs: string[]
  contradiction_refs: string[]
}

export type MaterialActionVerdictEpoch = {
  mode: 'shadow' | 'warn' | 'enforce'
  design_artifact: string
  epoch_id: string
  generated_at: string
  expires_at: string
  namespace: string
  producer_revision: string
  dependency_quorum_ref: string
  negative_evidence_router_epoch_ref: string
  action_slo_budget_refs: string[]
  action_clock_refs: string[]
  rollout_health_ref: string
  controller_witness_ref: string
  watch_reliability_ref: string
  database_projection_ref: string
  empirical_services_ref: string
  torghut_capital_ref: string | null
  contradiction_refs: string[]
  final_verdicts: MaterialActionVerdict[]
}

export type SourceRolloutTruthSettlementState =
  | 'converged'
  | 'rollout_lagging_source'
  | 'heartbeat_projection_split'
  | 'proof_floor_repair_only'
  | 'consumer_evidence_missing'
  | 'unknown'

export type SourceRolloutTruthActionDecision = 'allow' | 'observe_only' | 'repair_only' | 'hold' | 'block'

export type SourceRolloutTruthImageRef = {
  image_id: string
  role: 'desired_runtime' | 'live_pod'
  name: string
  namespace: string | null
  image_ref: string | null
  image_digest: string | null
  evidence_ref: string
}

export type SourceRolloutTruthControllerHeartbeatRef = {
  heartbeat_ref: string
  status: 'fresh' | 'stale' | 'missing' | 'split'
  decision: ControllerWitnessDecision
  observed_at: string | null
  fresh_until: string
  message: string
  evidence_refs: string[]
}

export type SourceRolloutTruthRouteStatus = {
  route_status_ref: string
  status: 'healthy' | 'degraded' | 'unknown'
  reachable: boolean
  url: string | null
  status_code: number | null
  observed_at: string
  message: string
}

export type SourceRolloutTruthProofFloor = {
  proof_floor_ref: string
  state: 'closed' | 'repair_only' | 'missing' | 'unknown'
  capital_state: 'none' | 'zero_notional' | 'paper' | 'live' | 'unknown'
  fresh_until: string
  blockers: string[]
  evidence_refs: string[]
}

export type SourceRolloutTruthSettlementReceipt = {
  receipt_id: string
  action_class: ActionSloBudgetActionClass
  settlement_state: SourceRolloutTruthSettlementState
  source_head_sha: string | null
  gitops_revision: string | null
  desired_image_ref: string | null
  desired_image_digest: string | null
  live_image_ref: string | null
  live_image_digest: string | null
  controller_heartbeat_ref: string | null
  database_projection_ref: string
  watch_cache_ref: string
  route_status_ref: string
  torghut_proof_floor_ref: string | null
  fresh_until: string
  action_decision: SourceRolloutTruthActionDecision
  blocking_reasons: string[]
  rollback_target: string | null
}

export type SourceRolloutTruthDeployerSummary = {
  settlement_state: SourceRolloutTruthSettlementState
  freshest_blocking_reason: string | null
  rollback_target: string | null
  held_action_classes: ActionSloBudgetActionClass[]
  receipt_refs: string[]
}

export type SourceRolloutTruthExchange = {
  mode: 'shadow' | 'enforced'
  design_artifact: string
  exchange_id: string
  generated_at: string
  fresh_until: string
  namespace: string
  source_head_sha: string | null
  gitops_revision: string | null
  desired_images: SourceRolloutTruthImageRef[]
  live_images: SourceRolloutTruthImageRef[]
  controller_heartbeats: SourceRolloutTruthControllerHeartbeatRef[]
  route_statuses: SourceRolloutTruthRouteStatus[]
  database_projection_ref: string
  watch_cache_ref: string
  torghut_proof_floor: SourceRolloutTruthProofFloor
  receipts: SourceRolloutTruthSettlementReceipt[]
  deployer_summary: SourceRolloutTruthDeployerSummary
  rollback_target: string | null
}

export type RepairWarrantDimension =
  | 'execution_tca'
  | 'market_context'
  | 'quant_ingestion'
  | 'quant_materialization'
  | 'quant_latest_store'
  | 'alpha_readiness'
  | 'forecast_registry'
  | 'consumer_evidence'

export type RepairWarrantAdmissionState = 'admitted' | 'observe_only' | 'closed' | 'expired' | 'suppressed'

export type RepairWarrantRiskTier = 'low' | 'medium' | 'high' | 'critical'

export type RepairWarrantRecord = {
  warrant_id: string
  source_epoch_id: string
  source_budget_id: string | null
  repair_code: string
  repair_dimension: RepairWarrantDimension
  account_label: string
  torghut_revision: string | null
  action_class: ActionSloBudgetActionClass
  admission_state: RepairWarrantAdmissionState
  max_dispatches: number
  max_runtime_seconds: number
  max_notional: number
  expected_unblock_value: number
  risk_tier: RepairWarrantRiskTier
  fresh_until: string
  owner_lane: string
  validation_refs: string[]
  closure_requirements: string[]
  rollback_target: string
  reason_codes: string[]
  evidence_refs: string[]
}

export type RepairWarrantScheduleDebtAttemptResult = 'success' | 'error' | 'running' | 'unknown'

export type RepairWarrantScheduleDebtAttempt = {
  attempt_id: string
  lane: string
  source_ref: string | null
  image_ref: string | null
  objective_ref: string | null
  signature_complete: boolean
  result: RepairWarrantScheduleDebtAttemptResult
  observed_at: string
  job_ref: string
  supersedes_attempt_ids: string[]
  superseded_by_attempt_id: string | null
  reason_codes: string[]
}

export type RepairWarrantScheduleDebtLane = {
  lane: string
  firebreak_state: 'clear' | 'observe_only'
  open_error_count: number
  superseded_error_count: number
  success_count: number
  running_count: number
  attempts: RepairWarrantScheduleDebtAttempt[]
  reason_codes: string[]
}

export type RepairWarrantScheduleDebtWindow = {
  started_at: string
  expires_at: string
  window_minutes: number
  open_error_count: number
  superseded_error_count: number
  success_count: number
  running_count: number
  firebreak_state: 'clear' | 'observe_only'
  lanes: RepairWarrantScheduleDebtLane[]
  collection_errors: string[]
}

export type RepairWarrantSuppressedCandidate = {
  repair_code: string
  repair_dimension: RepairWarrantDimension
  account_label: string
  admission_state: 'observe_only' | 'expired' | 'suppressed'
  reason_codes: string[]
  evidence_refs: string[]
}

export type RepairWarrantExchange = {
  mode: 'observe' | 'admit-zero-notional' | 'gate-paper'
  design_artifact: string
  exchange_id: string
  generated_at: string
  fresh_until: string
  namespace: string
  status: 'healthy' | 'observe_only' | 'degraded' | 'blocked'
  source_epoch_id: string
  schedule_debt_window: RepairWarrantScheduleDebtWindow
  active_warrants: RepairWarrantRecord[]
  closed_warrants: RepairWarrantRecord[]
  expired_warrants: RepairWarrantRecord[]
  suppressed_candidates: RepairWarrantSuppressedCandidate[]
  rollback_target: string
}

export type RouteStabilityLiveRouteAttempt = {
  attempt_id: string
  attempted_at: string
  url: string | null
  result: 'success' | 'failure' | 'unknown'
  status_code: number | null
  latency_ms: number
  message: string
}

export type RouteStabilityWindow = {
  state: 'stable' | 'escrow_repair_only' | 'unstable' | 'unknown'
  started_at: string
  stable_after: string
  expires_at: string
  live_route_success_count: number
  required_success_count: number
  controller_authority_mode: 'heartbeat' | 'serving_process' | 'rollout' | 'unknown'
  allowed_action_classes: ActionSloBudgetActionClass[]
  held_action_classes: ActionSloBudgetActionClass[]
  blocked_action_classes: ActionSloBudgetActionClass[]
  reason_codes: string[]
}

export type RouteStabilityMaterialActionContract = {
  action_class: ActionSloBudgetActionClass
  route_requirement: 'live_required' | 'escrow_allowed' | 'none'
  controller_requirement: 'heartbeat_required' | 'rollout_ok_for_repair' | 'none'
  decision: MaterialActionActivationReceiptDecision
  max_dispatches: number | null
  max_runtime_seconds: number | null
  max_notional: number | null
  required_repairs: string[]
  snapshot_ref: string
  live_route_ref: string | null
  rollback_target: string | null
}

export type RouteStabilityEscrow = {
  mode: 'shadow' | 'enforced'
  design_artifact: string
  escrow_id: string
  namespace: string
  generated_at: string
  fresh_until: string
  status_snapshot_ref: string
  status_snapshot_hash: string
  status_producer_revision: string
  live_route_attempts: RouteStabilityLiveRouteAttempt[]
  last_live_route_success_at: string | null
  last_live_route_error: string | null
  route_stability_window: RouteStabilityWindow
  controller_witness_ref: string
  database_projection_ref: string
  watch_reliability_ref: string
  material_action_contracts: RouteStabilityMaterialActionContract[]
  rollback_target: string | null
}

export type TorghutConsumerEvidenceStatus = {
  status: 'disabled' | 'current' | 'stale' | 'missing' | 'unavailable' | 'route_missing' | 'schema_mismatch'
  endpoint: string
  receipt_id: string | null
  generated_at: string | null
  fresh_until: string | null
  candidate_id: string | null
  dataset_snapshot_ref: string | null
  max_notional: string | null
  route_canary_id?: string | null
  jangar_parity_escrow_ref?: string | null
  serving_revision?: string | null
  image_digest?: string | null
  route_repair_value?: number | null
  decision?: string | null
  capital_reentry_cohort_ledger_id?: string | null
  capital_reentry_aggregate_state?: string | null
  capital_reentry_cohort_ids?: string[]
  profit_repair_settlement_ledger_id?: string | null
  profit_repair_aggregate_state?: string | null
  profit_repair_lot_ids?: string[]
  reason_codes: string[]
  message: string
}

export type ActionCustodyDecision = 'allow' | 'repair_only' | 'hold' | 'block'

export type ActionCustodyAllowedScope =
  | 'none'
  | 'serve_readonly'
  | 'bounded_repair'
  | 'normal_dispatch'
  | 'deploy_widen'
  | 'merge_ready'
  | 'torghut_observe'
  | 'paper_canary'
  | 'live_micro_canary'
  | 'live_scale'

export type ActionCustodyReceipt = {
  schema_version: 'jangar.action-custody-receipt.v1'
  receipt_id: string
  generated_at: string
  fresh_until: string
  namespace: string
  swarm_name: string
  stage: 'serve' | 'dispatch' | 'deploy' | 'verify' | 'torghut'
  action_class: ActionSloBudgetActionClass
  decision: ActionCustodyDecision
  allowed_scope: ActionCustodyAllowedScope
  max_dispatches: number | null
  max_runtime_seconds: number | null
  max_notional: number | null
  controller_witness_ref: string
  source_rollout_truth_ref: string
  scheduler_route_ref: string | null
  retained_failure_debt_ref: string
  material_action_verdict_ref: string
  route_stability_contract_ref: string
  torghut_consumer_evidence_ref: string | null
  torghut_profit_window_ref: string | null
  blocking_debt_classes: string[]
  forbidden_shortcuts: string[]
  required_repair_actions: string[]
  validation_commands: string[]
  evidence_refs: string[]
  rollout_gate: 'observe_only' | 'required'
  rollback_gate: string
}

export type StageClearanceStage =
  | 'serve'
  | 'discover'
  | 'plan'
  | 'implement'
  | 'verify'
  | 'repair'
  | 'deployer'
  | 'torghut'

export type StageClearanceDecision = 'allow' | 'repair_only' | 'hold' | 'block'

export type StageClearancePacket = {
  schema_version: 'jangar.stage-clearance-packet.v1'
  packet_id: string
  generated_at: string
  fresh_until: string
  namespace: string
  swarm_name: string
  stage: StageClearanceStage
  action_class: ActionSloBudgetActionClass
  governing_requirement_refs: string[]
  source_rollout_truth_ref: string
  controller_witness_ref: string
  agentrun_ingestion_ref: string
  execution_trust_ref: string
  material_action_verdict_ref: string
  route_stability_ref: string
  torghut_consumer_evidence_ref: string | null
  failure_domain_leases: string[]
  provider_capacity_ref: string | null
  decision: StageClearanceDecision
  max_launches: number | null
  max_notional: number | null
  ttl_seconds: number
  reason_codes: string[]
  required_repair_action: string | null
  rollback_target: string
}

export type ReadyActionExchange = {
  mode: 'observe' | 'enforce'
  design_artifact: string
  exchange_id: string
  generated_at: string
  fresh_until: string
  namespace: string
  status: ActionCustodyDecision
  serving_receipt_id: string | null
  dispatch_receipt_ids: string[]
  deploy_receipt_ids: string[]
  torghut_receipt_ids: string[]
  receipt_refs: string[]
  allowed_action_classes: ActionSloBudgetActionClass[]
  repair_only_action_classes: ActionSloBudgetActionClass[]
  held_action_classes: ActionSloBudgetActionClass[]
  blocked_action_classes: ActionSloBudgetActionClass[]
  reason_codes: string[]
  rollback_target: string
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
  failure_domain_leases: FailureDomainLeaseSet
  reconciled_action_clocks: ReconciledActionClock[]
  negative_evidence_router: NegativeEvidenceRouterStatus
  action_slo_budgets: ActionSloBudget[]
  torghut_action_slo_budgets: ActionSloBudget[]
  control_plane_controller_witness: ControlPlaneControllerWitnessQuorum
  material_action_verdict_epoch: MaterialActionVerdictEpoch
  material_action_verdicts: MaterialActionVerdict[]
  material_action_activation_receipts: MaterialActionActivationReceipt[]
  action_custody_receipts: ActionCustodyReceipt[]
  stage_clearance_packets: StageClearancePacket[]
  ready_action_exchange: ReadyActionExchange
  repair_warrant_exchange: RepairWarrantExchange
  source_rollout_truth_exchange: SourceRolloutTruthExchange
  route_stability_escrow: RouteStabilityEscrow
  database: DatabaseStatus
  grpc: GrpcStatus
  watch_reliability: ControlPlaneWatchReliability
  agentrun_ingestion: AgentRunIngestionStatus
  runtime_kits: RuntimeKitStatus[]
  admission_passports: AdmissionPassportStatus[]
  serving_passport_id: string | null
  recovery_warrants: RecoveryWarrantStatus[]
  runtime_proof_cells: RuntimeProofCellStatus[]
  projection_watermarks: ProjectionWatermarkStatus[]
  rollout_health: ControlPlaneRolloutHealth
  empirical_services: EmpiricalServicesStatus
  torghut_consumer_evidence: TorghutConsumerEvidenceStatus
  execution_trust: ExecutionTrustStatus
  swarms: ExecutionTrustSwarm[]
  stages: ExecutionTrustStage[]
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

export const fetchAgentOptions = async (namespace: string) => {
  const result = await fetchPrimitiveList({ kind: 'Agent', namespace, limit: 200 })
  if (!result.ok) {
    return result
  }

  const items = result.items
    .map((item) => {
      const metadata = asRecord(item.metadata) ?? {}
      const spec = asRecord(item.spec) ?? {}
      const providerRef = asRecord(spec.providerRef) ?? {}
      const name = typeof metadata.name === 'string' ? metadata.name.trim() : ''
      if (!name) return null
      const provider = typeof providerRef.name === 'string' ? providerRef.name.trim() : null
      return { name, provider: provider || null } satisfies AgentOption
    })
    .filter((item): item is AgentOption => Boolean(item))
    .sort((left, right) => left.name.localeCompare(right.name))

  return {
    ok: true as const,
    items,
    namespace: result.namespace,
  }
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
