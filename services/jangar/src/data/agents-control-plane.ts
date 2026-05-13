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

export type DependencyVerdictActionClass =
  | 'serve_readonly'
  | 'observe'
  | 'repair'
  | 'implement'
  | 'paper'
  | 'live'
  | 'deploy_widen'
  | 'merge_ready'

export type DependencyVerdictDecision = 'allow' | 'repair_only' | 'hold' | 'block'

export type DependencyVerdictAllowedScope =
  | 'none'
  | 'read_only'
  | 'observe_only'
  | 'zero_notional_repair'
  | 'normal_implementation'
  | 'paper_support'
  | 'live_support'
  | 'deploy_widen'
  | 'merge_ready'

export type DependencyVerdict = {
  schema_version: 'jangar.dependency-verdict.v1'
  verdict_id: string
  generated_at: string
  fresh_until: string
  repository: string
  branch: string
  namespace: string
  swarm_name: string
  stage: 'serve' | 'observe' | 'repair' | 'implement' | 'paper' | 'live' | 'deploy' | 'verify'
  action_class: DependencyVerdictActionClass
  decision: DependencyVerdictDecision
  allowed_scope: DependencyVerdictAllowedScope
  max_dispatches: number | null
  max_runtime_seconds: number | null
  max_notional: number | null
  execution_trust_ref: string
  source_rollout_ref: string
  argo_health_ref: string
  controller_watch_ref: string
  torghut_route_warrant_ref: string | null
  torghut_repair_packet_refs: string[]
  blocking_dependency_names: string[]
  blocking_reason_codes: string[]
  required_validation_commands: string[]
  evidence_refs: string[]
  rollback_gate: string
}

export type DependencyVerdictExchange = {
  mode: 'observe' | 'enforce'
  design_artifact: string
  exchange_id: string
  generated_at: string
  fresh_until: string
  namespace: string
  status: DependencyVerdictDecision
  torghut_route_warrant_ref: string | null
  verdict_refs: string[]
  allowed_action_classes: DependencyVerdictActionClass[]
  repair_only_action_classes: DependencyVerdictActionClass[]
  held_action_classes: DependencyVerdictActionClass[]
  blocked_action_classes: DependencyVerdictActionClass[]
  reason_codes: string[]
  verdicts: DependencyVerdict[]
  rollback_target: string
}

export type SourceServingContractActionClass =
  | 'serve_readonly'
  | 'dispatch_repair'
  | 'dispatch_normal'
  | 'deploy_widen'
  | 'merge_ready'
  | 'paper_support'
  | 'live_support'

export type SourceServingContractDecision = 'allow' | 'repair_only' | 'hold' | 'block'

export type SourceServingContractState =
  | 'converged'
  | 'source_ahead'
  | 'serving_ahead'
  | 'digest_unknown'
  | 'contract_missing'
  | 'unknown'

export type SourceServingContractVerdict = {
  schema_version: 'jangar.source-serving-contract-verdict.v1'
  verdict_id: string
  generated_at: string
  fresh_until: string
  repository: string
  source_sha: string | null
  source_ci_run_id: string | null
  source_ci_conclusion: string | null
  manifest_sha: string | null
  manifest_image_digest: string | null
  argo_sync_revision: string | null
  argo_health: ControlPlaneRolloutHealth['status']
  serving_revision: string | null
  serving_build_commit: string | null
  serving_image_digest: string | null
  required_contracts: string[]
  observed_contracts: string[]
  missing_contracts: string[]
  contract_schema_mismatches: string[]
  torghut_route_warrant_ref: string | null
  torghut_repair_bid_settlement_ref: string | null
  action_class: SourceServingContractActionClass
  decision: SourceServingContractDecision
  source_serving_state: SourceServingContractState
  max_notional: number | null
  value_gate_impacts: string[]
  required_repair_receipts: string[]
  blocking_reason_codes: string[]
  evidence_refs: string[]
  rollback_gate: string
}

export type SourceServingContractVerdictExchange = {
  mode: 'observe' | 'enforce'
  design_artifact: string
  exchange_id: string
  generated_at: string
  fresh_until: string
  namespace: string
  status: SourceServingContractDecision
  source_sha: string | null
  serving_build_commit: string | null
  manifest_image_digest: string | null
  serving_image_digest: string | null
  required_contracts: string[]
  observed_contracts: string[]
  missing_contracts: string[]
  verdict_refs: string[]
  allowed_action_classes: SourceServingContractActionClass[]
  repair_only_action_classes: SourceServingContractActionClass[]
  held_action_classes: SourceServingContractActionClass[]
  blocked_action_classes: SourceServingContractActionClass[]
  reason_codes: string[]
  verdicts: SourceServingContractVerdict[]
  rollback_target: string
}

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

export type TorghutRepairBidSettlementStatus = 'current' | 'stale' | 'missing' | 'schema_mismatch' | 'malformed'

export type TorghutRepairBidSettlementLot = {
  lot_id: string
  lot_class: string
  target_value_gate: string
  priority: number | null
  expected_gate_delta: string | null
  raw_reason_codes: string[]
  root_cause_hypothesis: string | null
  required_input_refs: string[]
  required_output_receipt: string | null
  required_output_receipt_count: number | null
  validation_commands: string[]
  dedupe_key: string | null
  ttl_seconds: number | null
  max_runtime_seconds: number | null
  max_parallelism: number | null
  max_notional: string | null
  state: string | null
  dispatchable: boolean
  hold_reason_codes: string[]
  source_bid_ids: string[]
}

export type RepairBidAdmissionDecision = 'allow' | 'repair_only' | 'hold' | 'block'

export type RepairBidAdmissionReceipt = {
  schema_version: 'jangar.repair-bid-admission-receipt.v1'
  receipt_id: string
  generated_at: string
  fresh_until: string
  repository: string
  branch: string
  swarm_name: string
  stage: string
  action_class: ActionSloBudgetActionClass
  decision: RepairBidAdmissionDecision
  torghut_settlement_ledger_ref: string | null
  torghut_compacted_lot_refs: string[]
  active_dedupe_keys: string[]
  admitted_lot_ids: string[]
  held_lot_ids: string[]
  denied_reason_codes: string[]
  max_parallelism: number
  max_runtime_seconds: number
  max_notional: number
  validation_commands: string[]
  rollback_gate: string
}

export type RepairLotDispatchTicket = {
  schema_version: 'jangar.repair-lot-dispatch-ticket.v1'
  ticket_id: string
  admission_receipt_id: string
  torghut_lot_id: string
  lot_class: string
  target_value_gate: string
  dedupe_key: string
  required_output_receipt: string
  launch_allowed: boolean
  launch_reason: string
  stop_conditions: string[]
  max_runtime_seconds: number
  max_notional: number
  expected_gate_delta: string | null
  rollback_target: string
}

export type RepairBidAdmissionState = {
  schema_version: 'jangar.repair-bid-admission-state.v1'
  mode: 'observe' | 'enforce'
  design_artifact: string
  generated_at: string
  fresh_until: string
  status: RepairBidAdmissionDecision
  torghut_settlement_ledger_ref: string | null
  receipts: RepairBidAdmissionReceipt[]
  dispatch_tickets: RepairLotDispatchTicket[]
  admitted_lot_ids: string[]
  held_lot_ids: string[]
  active_dedupe_keys: string[]
  reason_codes: string[]
  rollback_target: string
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
  build_commit?: string | null
  build_version?: string | null
  serving_image_digest?: string | null
  observed_contracts?: string[]
  contract_schema_mismatches?: string[]
  route_repair_value?: number | null
  decision?: string | null
  capital_reentry_cohort_ledger_id?: string | null
  capital_reentry_aggregate_state?: string | null
  capital_reentry_cohort_ids?: string[]
  profit_repair_settlement_ledger_id?: string | null
  profit_repair_aggregate_state?: string | null
  profit_repair_lot_ids?: string[]
  routeability_repair_acceptance_ledger_id?: string | null
  routeability_aggregate_state?: string | null
  routeability_lot_ids?: string[]
  accepted_routeable_candidate_count?: number | null
  profit_freshness_frontier_id?: string | null
  profit_freshness_state?: string | null
  profit_freshness_repair_lot_ids?: string[]
  profit_freshness_selected_repair_ids?: string[]
  evidence_clock_arbiter_id?: string | null
  evidence_clock_state?: string | null
  evidence_clock_split_clock_names?: string[]
  evidence_clock_blocking_reason_codes?: string[]
  evidence_clock_custody_status?: string | null
  evidence_clock_custody_ref?: string | null
  routeable_profit_candidate_exchange_id?: string | null
  routeable_exchange_routeable_candidate_count?: number | null
  routeable_exchange_zero_notional_repair_lot_ids?: string[]
  routeable_exchange_rejected_candidate_count?: number | null
  route_warrant_id?: string | null
  route_warrant_state?: string | null
  route_warrant_fresh_until?: string | null
  route_warrant_repair_packet_ids?: string[]
  route_warrant_repair_target_value_gates?: string[]
  route_warrant_blocking_dependency_names?: string[]
  route_warrant_blocking_reason_codes?: string[]
  route_warrant_zero_notional_or_stale_evidence_rate?: number | null
  route_warrant_fill_tca_or_slippage_quality?: string | null
  route_warrant_capital_gate_safety?: string | null
  route_warrant_post_cost_daily_net_pnl_state?: string | null
  repair_bid_settlement_ledger_id?: string | null
  repair_bid_settlement_status?: TorghutRepairBidSettlementStatus
  repair_bid_settlement_generated_at?: string | null
  repair_bid_settlement_fresh_until?: string | null
  repair_bid_settlement_capital_decision?: string | null
  repair_bid_settlement_max_notional?: string | null
  repair_bid_settlement_routeable_candidate_count?: number | null
  repair_bid_settlement_selected_lot_ids?: string[]
  repair_bid_settlement_dispatchable_lot_ids?: string[]
  repair_bid_settlement_held_lot_ids?: string[]
  repair_bid_settlement_active_dedupe_keys?: string[]
  repair_bid_settlement_compacted_lots?: TorghutRepairBidSettlementLot[]
  repair_bid_settlement_reason_codes?: string[]
  freshness_carry_ledger_id?: string | null
  freshness_carry_state?: string | null
  freshness_carry_pressure_ref_ids?: string[]
  freshness_carry_dispatchable_pressure_ref_ids?: string[]
  freshness_carry_required_output_receipts?: string[]
  freshness_carry_target_value_gates?: string[]
  freshness_carry_reason_codes?: string[]
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
  dependency_verdict_ref?: string | null
  dependency_verdict_decision?: DependencyVerdictDecision | null
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

export type ConsumerEvidenceLeaseDecision = 'allow' | 'allow_grace' | 'repair_only' | 'hold' | 'block' | 'unknown'

export type ConsumerEvidenceLeaseConfidence = 'high' | 'medium' | 'low' | 'unknown'

export type ConsumerEvidenceLeaseContradiction = {
  contradiction_id: string
  action_class: ActionSloBudgetActionClass
  message: string
  reason_codes: string[]
  evidence_refs: string[]
}

export type ConsumerEvidenceActionLease = {
  lease_id: string
  action_class: ActionSloBudgetActionClass
  decision: ConsumerEvidenceLeaseDecision
  confidence: ConsumerEvidenceLeaseConfidence
  fresh_until: string
  grace_until: string
  max_dispatches: number | null
  max_runtime_seconds: number | null
  max_notional: number | null
  required_repairs: string[]
  reason_codes: string[]
  evidence_refs: string[]
  rollback_target: string | null
}

export type ConsumerEvidenceLeaseSet = {
  schema_version: 'jangar.consumer-evidence-lease-set.v1'
  mode: 'shadow'
  design_artifact: string
  lease_set_id: string
  generated_at: string
  expires_at: string
  producer_revision: string
  consumer: 'torghut'
  namespace: string
  source_status_ref: string
  database_ref: string
  rollout_ref: string
  watch_ref: string
  controller_witness_ref: string
  empirical_services_ref: string
  action_leases: ConsumerEvidenceActionLease[]
  contradictions: ConsumerEvidenceLeaseContradiction[]
  rollback_target: string
}

export type ClearanceMarketDecision = 'allow' | 'repair_only' | 'hold' | 'block'

export type ClearanceMarketAuthoritySplit = {
  split_id: string
  domain: 'rollout' | 'controller' | 'runtime_admission' | 'torghut' | 'database' | 'workflow'
  primary_ref: string
  secondary_ref: string | null
  decision: ClearanceMarketDecision
  reason_codes: string[]
  message: string
  evidence_refs: string[]
}

export type ClearanceMarketFailureDebt = {
  debt_id: string
  window: '15m' | '6h' | '7d'
  state: 'clear' | 'active' | 'retained_audit' | 'projection_limited' | 'unknown'
  failed_count: number | null
  backoff_count: number | null
  running_count: number | null
  data_confidence: 'high' | 'medium' | 'low' | 'degraded' | 'unknown'
  reason_codes: string[]
  evidence_refs: string[]
}

export type ClearanceMarketRolloutTruthSettlement = {
  settlement_id: string
  source_head_sha: string | null
  gitops_revision: string | null
  desired_image_refs: string[]
  live_image_refs: string[]
  deployment_availability: Array<{
    name: string
    namespace: string
    status: DeploymentRolloutStatus['status']
    desired_replicas: number
    available_replicas: number
  }>
  route_health: SourceRolloutTruthRouteStatus[]
  database_projection: {
    mode: 'status_projection' | 'route_database_projection' | 'unavailable'
    status: DatabaseStatus['status']
    evidence_ref: string
  }
  downstream_evidence_refs: string[]
  pr_to_rollout_latency_seconds: number | null
  decision: ClearanceMarketDecision
  blockers: string[]
}

export type ClearanceMarketActionClearance = {
  clearance_id: string
  action_class: ActionSloBudgetActionClass
  decision: ClearanceMarketDecision
  max_dispatches: number | null
  max_runtime_seconds: number | null
  max_notional: number | null
  reason_codes: string[]
  required_repair_actions: string[]
  governing_design_refs: string[]
  evidence_refs: string[]
  rollback_target: string | null
}

export type ClearanceMarketRepairLot = {
  lot_id: string
  warrant_id: string | null
  value_gate: 'failed_agentrun_rate' | 'pr_to_rollout_latency' | 'ready_status_truth' | 'manual_intervention_count'
  failure_mode: string
  action_class: ActionSloBudgetActionClass
  decision: ClearanceMarketDecision
  score: number
  expected_unblock_value: number
  max_dispatches: number
  max_runtime_seconds: number
  max_notional: number
  reason_codes: string[]
  evidence_refs: string[]
  rollback_target: string
}

export type ClearanceMarketStageAdmission = {
  admission_id: string
  stage: StageClearanceStage
  action_class: ActionSloBudgetActionClass
  decision: ClearanceMarketDecision
  packet_ref: string | null
  selected_repair_lot_ref: string | null
  reason_codes: string[]
  evidence_refs: string[]
}

export type ClearanceMarketLedger = {
  schema_version: 'jangar.clearance-market.v1'
  ledger_id: string
  namespace: string
  generated_at: string
  fresh_until: string
  governing_design_refs: string[]
  observed_revision: {
    source_head_sha: string | null
    gitops_revision: string | null
  }
  evidence_mode: 'shadow'
  authority_splits: ClearanceMarketAuthoritySplit[]
  retained_failure_debt: ClearanceMarketFailureDebt[]
  rollout_truth_settlement: ClearanceMarketRolloutTruthSettlement
  action_clearance: ClearanceMarketActionClearance[]
  repair_lots: ClearanceMarketRepairLot[]
  stage_admission: ClearanceMarketStageAdmission[]
  handoff_contract: {
    value_gates: string[]
    rollback_target: string
    status: ClearanceMarketDecision
  }
}

export type StageCreditEvidenceMode = 'observe' | 'shadow' | 'hold' | 'enforce'

export type StageCreditDecision = ClearanceMarketDecision

export type StageCreditAccount = {
  account_id: string
  stage: StageClearanceStage
  action_class: ActionSloBudgetActionClass
  opening_credit: number
  base_credit: number
  evidence_freshness_bonus: number
  torghut_repair_value_credit: number
  rollout_truth_deposit: number
  failure_debt_tax: number
  controller_witness_tax: number
  source_rollout_tax: number
  capital_safety_tax: number
  available_credit: number
  minimum_spend: number
  max_concurrent_runs: number
  max_runtime_seconds: number | null
  max_notional: number
  decision: StageCreditDecision
  reason_codes: string[]
  required_repair_actions: string[]
  evidence_refs: string[]
  selected_repair_lot_ref: string | null
  rollback_target: string
}

export type RunnerSlotFuture = {
  future_id: string
  account_id: string
  stage: StageClearanceStage
  action_class: ActionSloBudgetActionClass
  reserved_credit: number
  expires_at: string
  max_dispatches: number
  max_runtime_seconds: number | null
  max_notional: number
  spend_reason: string
  required_receipts: string[]
  settlement_state: 'open' | 'refunded' | 'burned' | 'converted' | 'expired'
  settlement_ref: string | null
}

export type StageCreditLedger = {
  schema_version: 'jangar.stage-credit-ledger.v1'
  ledger_id: string
  namespace: string
  generated_at: string
  fresh_until: string
  governing_design_refs: string[]
  observed_revision: {
    source_head_sha: string | null
    gitops_revision: string | null
  }
  evidence_mode: StageCreditEvidenceMode
  credit_epoch_id: string
  stage_accounts: StageCreditAccount[]
  runner_slot_futures: RunnerSlotFuture[]
  retained_failure_debt_refs: string[]
  settlement_policy: {
    mode: 'read_model_only'
    refund_condition: string
    burn_condition: string
    conversion_condition: string
    rollback_target: string
  }
  handoff_contract: {
    value_gates: string[]
    status: StageCreditDecision
    next_implementation_milestone: string
    rollback_target: string
  }
}

export type ReadyTruthArbiterMode = 'observe' | 'shadow' | 'hold' | 'enforce'

export type ReadyTruthServingReadiness = 'ok' | 'degraded' | 'down'

export type ReadyTruthMaterialReadiness = 'allow' | 'repair_only' | 'hold' | 'block'

export type ReadyTruthActionDecision = ReadyTruthMaterialReadiness

export type ReadyTruthGateReceipt = {
  receipt_id: string
  action_class: ActionSloBudgetActionClass
  decision: ReadyTruthActionDecision
  required_evidence_refs: string[]
  reason_codes: string[]
}

export type ReadyTruthArbiter = {
  schema_version: 'jangar.ready-truth-arbiter.v1'
  mode: ReadyTruthArbiterMode
  verdict_id: string
  generated_at: string
  fresh_until: string
  namespace: string
  governing_design_refs: string[]
  serving_readiness: ReadyTruthServingReadiness
  material_readiness: ReadyTruthMaterialReadiness
  argo_revision: string | null
  argo_health: ControlPlaneRolloutHealth['status']
  workload_rollout_ref: string
  controller_witness_ref: string
  runtime_adapter_refs: string[]
  stage_credit_ledger_ref: string | null
  source_serving_verdict_ref: string | null
  torghut_repair_receipt_ref: string | null
  retained_failure_debt_refs: string[]
  ready_status_truth_reasons: string[]
  allowed_action_classes: ActionSloBudgetActionClass[]
  repair_only_action_classes: ActionSloBudgetActionClass[]
  held_action_classes: ActionSloBudgetActionClass[]
  blocked_action_classes: ActionSloBudgetActionClass[]
  merge_gate_receipt: ReadyTruthGateReceipt
  deployer_receipt: ReadyTruthGateReceipt
  rollback_target: string
}

export type AuthorityProvenanceSettlementMode = 'observe' | 'shadow' | 'hold' | 'enforce'

export type AuthorityProvenanceSettlementState =
  | 'settled'
  | 'settled_with_split'
  | 'repairable_split'
  | 'hold'
  | 'block'

export type AuthorityProvenanceWinningAuthority =
  | 'serving_process'
  | 'controller_heartbeat'
  | 'kubernetes_rollout'
  | 'database_projection'
  | 'gitops_revision'
  | 'torghut_receipt'
  | 'none'

export type AuthorityProvenanceSurfaceName =
  | 'controller_process'
  | 'agentrun_ingestion'
  | 'watch_epoch'
  | 'source_gitops'
  | 'serving_image'
  | 'database_schema'
  | 'workflow_runtime'
  | 'stage_clearance'
  | 'torghut_capital'

export type AuthorityProvenanceSurfaceStatus =
  | 'current'
  | 'split'
  | 'missing'
  | 'degraded'
  | 'held'
  | 'blocked'
  | 'unknown'

export type AuthorityProvenanceActionDecisionValue = 'allow' | 'repair_only' | 'hold' | 'block'

export type AuthorityProvenanceSurface = {
  surface: AuthorityProvenanceSurfaceName
  authority: AuthorityProvenanceWinningAuthority
  status: AuthorityProvenanceSurfaceStatus
  settlement_state: AuthorityProvenanceSettlementState
  observed_at: string
  fresh_until: string
  evidence_refs: string[]
  reason_codes: string[]
  message: string
}

export type AuthorityProvenanceActionDecision = {
  action_class: ActionSloBudgetActionClass
  decision: AuthorityProvenanceActionDecisionValue
  reason_codes: string[]
  evidence_refs: string[]
  max_dispatches: number | null
  max_runtime_seconds: number | null
  max_notional: number
  rollback_target: string
}

export type AuthorityProvenanceReentryWindow = {
  window_id: string
  stage: StageClearanceStage
  action_class: ActionSloBudgetActionClass
  max_dispatches: number
  max_runtime_seconds: number | null
  max_notional: number
  required_receipts: string[]
  expires_at: string
}

export type AuthorityProvenanceSettlement = {
  schema_version: 'jangar.authority-provenance-settlement.v1'
  settlement_id: string
  namespace: string
  generated_at: string
  fresh_until: string
  governing_design_refs: string[]
  evidence_mode: AuthorityProvenanceSettlementMode
  surfaces: AuthorityProvenanceSurface[]
  winning_authority: AuthorityProvenanceWinningAuthority
  settlement_state: AuthorityProvenanceSettlementState
  action_class_decisions: AuthorityProvenanceActionDecision[]
  reentry_windows: AuthorityProvenanceReentryWindow[]
  rollback_target: string
  handoff_summary: string
}

export type EvidencePressureLedgerMode = 'observe' | 'shadow' | 'hold' | 'enforce'

export type EvidencePressureSourceClass =
  | 'kubernetes_watch'
  | 'controller_replica'
  | 'metrics_sink'
  | 'github_ingest'
  | 'db_access'
  | 'torghut_freshness'

export type EvidencePressureSeverity = 'info' | 'warning' | 'hold' | 'block'

export type EvidencePressureWatchBackoffState = 'calm' | 'pressured' | 'brownout' | 'blind'

export type EvidencePressureDecision = 'allow' | 'repair_only' | 'hold' | 'block'

export type EvidencePressureSource = {
  source_id: string
  source_class: EvidencePressureSourceClass
  severity: EvidencePressureSeverity
  observed_at: string
  expires_at: string
  evidence_ref: string
  message: string
  retryable: boolean
  terminal: boolean
  suggested_backoff_seconds: number
  value_gates: string[]
  reason_codes: string[]
}

export type EvidencePressureWatchBackoffPolicy = {
  state: EvidencePressureWatchBackoffState
  max_new_list_requests_per_minute: number
  max_new_agent_runs_per_stage: number
  jitter_seconds: number
  retry_after_seconds: number
  stop_retry_reason_codes: string[]
  open_repair_reason_codes: string[]
}

export type EvidencePressureActionBudget = {
  action_class: ActionSloBudgetActionClass
  decision: EvidencePressureDecision
  pressure_tax: number
  max_dispatches: number | null
  max_runtime_seconds: number | null
  max_notional: number
  required_repair_receipts: string[]
  reason_codes: string[]
  rollback_target: string
}

export type EvidencePressureLedger = {
  schema_version: 'jangar.evidence-pressure-ledger.v1'
  ledger_id: string
  namespace: string
  generated_at: string
  fresh_until: string
  governing_design_refs: string[]
  observed_revision: {
    source_head_sha: string | null
    gitops_revision: string | null
  }
  evidence_mode: EvidencePressureLedgerMode
  pressure_sources: EvidencePressureSource[]
  watch_backoff_policy: EvidencePressureWatchBackoffPolicy
  action_pressure_budget: EvidencePressureActionBudget[]
  scheduler_handoff: {
    status: EvidencePressureDecision
    ledger_ref: string
    held_action_classes: ActionSloBudgetActionClass[]
    repair_action_classes: ActionSloBudgetActionClass[]
    reason_codes: string[]
  }
  deployer_handoff: {
    status: EvidencePressureDecision
    ledger_ref: string
    held_action_classes: ActionSloBudgetActionClass[]
    reason_codes: string[]
  }
  rollback_target: string
}

export type TerminalDebtCompactionMode = 'observe' | 'shadow' | 'hold' | 'enforce'

export type TerminalDebtCohortClass =
  | 'agentrun'
  | 'job'
  | 'pod'
  | 'workflow_step'
  | 'torghut_repair_lot'
  | 'source_ingest'
  | 'metrics_sink'

export type TerminalDebtCohortState =
  | 'active'
  | 'pending_settlement'
  | 'settled'
  | 'retained_audit'
  | 'suppressed_duplicate'

export type TerminalDebtGateEffect = 'allow' | 'hold' | 'block' | 'audit_only'

export type TerminalDebtDecision = 'allow' | 'repair_only' | 'hold' | 'block'

export type TerminalDebtSourceWindow = {
  source_class: TerminalDebtCohortClass
  window_minutes: number
  observed_count: number
  active_debt_count: number
  retained_audit_count: number
  collection_error: string | null
  evidence_refs: string[]
}

export type TerminalDebtSummaryByClass = {
  class: TerminalDebtCohortClass
  count: number
}

export type TerminalDebtSummary = {
  count: number
  by_class: TerminalDebtSummaryByClass[]
  reason_codes: string[]
  representative_refs: string[]
  value_gates: string[]
}

export type TerminalDebtCohort = {
  cohort_id: string
  class: TerminalDebtCohortClass
  stage: StageClearanceStage | 'unknown'
  action_class: ActionSloBudgetActionClass | 'unknown'
  state: TerminalDebtCohortState
  first_seen_at: string
  last_seen_at: string
  expires_active_at: string
  retained_until: string
  count: number
  reason_codes: string[]
  representative_refs: string[]
  compacted_artifact_ref: string
  active_gate_effect: TerminalDebtGateEffect
  value_gates: string[]
}

export type RepairOutcomeEscrow = {
  escrow_id: string
  dispatch_ticket_id: string | null
  repair_lot_id: string | null
  expected_output_receipt: string | null
  expected_reason_code_delta: string[]
  launched_agentrun_ref: string | null
  terminal_state: 'pending' | 'succeeded' | 'failed' | 'timed_out' | 'superseded'
  outcome: 'pending' | 'retired_reason_codes' | 'no_delta' | 'degraded' | 'invalid_receipt'
  retired_reason_codes: string[]
  preserved_reason_codes: string[]
  next_action: 'release_credit' | 'burn_credit' | 'roll_forward' | 'hold'
}

export type TerminalDebtSchedulerContract = {
  status: TerminalDebtDecision
  mode: TerminalDebtCompactionMode
  ledger_ref: string
  active_debt_count: number
  retained_audit_count: number
  would_hold_action_classes: ActionSloBudgetActionClass[]
  reason_codes: string[]
}

export type TerminalDebtDeployerContract = {
  status: TerminalDebtDecision
  ledger_ref: string
  active_debt_count: number
  retained_audit_count: number
  merge_ready_action: TerminalDebtDecision
  deploy_widen_action: TerminalDebtDecision
  reason_codes: string[]
  evidence_refs: string[]
}

export type TerminalDebtRollbackContract = {
  mode_target: string
  disable_target: string
  safe_without_database_migration: boolean
  notes: string[]
}

export type TerminalDebtCompactionLedger = {
  schema_version: 'jangar.terminal-debt-compaction-ledger.v1'
  ledger_id: string
  namespace: string
  generated_at: string
  fresh_until: string
  governing_design_refs: string[]
  evidence_mode: TerminalDebtCompactionMode
  source_windows: TerminalDebtSourceWindow[]
  active_debt_summary: TerminalDebtSummary
  retained_audit_summary: TerminalDebtSummary
  cohorts: TerminalDebtCohort[]
  repair_outcome_escrows: RepairOutcomeEscrow[]
  scheduler_contract: TerminalDebtSchedulerContract
  deployer_contract: TerminalDebtDeployerContract
  rollback_contract: TerminalDebtRollbackContract
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
  dependency_verdict_exchange: DependencyVerdictExchange
  source_serving_contract_verdict_exchange: SourceServingContractVerdictExchange
  control_plane_controller_witness: ControlPlaneControllerWitnessQuorum
  material_action_verdict_epoch: MaterialActionVerdictEpoch
  material_action_verdicts: MaterialActionVerdict[]
  material_action_activation_receipts: MaterialActionActivationReceipt[]
  action_custody_receipts: ActionCustodyReceipt[]
  stage_clearance_packets: StageClearancePacket[]
  stage_credit_ledger: StageCreditLedger | null
  ready_truth_arbiter: ReadyTruthArbiter
  authority_provenance_settlement: AuthorityProvenanceSettlement
  evidence_pressure_ledger: EvidencePressureLedger | null
  terminal_debt_compaction_ledger: TerminalDebtCompactionLedger | null
  ready_action_exchange: ReadyActionExchange
  repair_bid_admission: RepairBidAdmissionState
  repair_warrant_exchange: RepairWarrantExchange
  consumer_evidence_leases: ConsumerEvidenceLeaseSet
  clearance_market_ledger: ClearanceMarketLedger | null
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
