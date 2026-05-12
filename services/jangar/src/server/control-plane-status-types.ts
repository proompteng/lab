import type { ControlPlaneWatchReliabilitySummary } from '~/server/control-plane-watch-reliability'
import type { TorghutConsumerEvidenceStatus } from '~/server/control-plane-torghut-consumer-evidence'
import type {
  ActionCustodyReceipt,
  ActionSloBudget,
  AdmissionPassportStatus,
  ControlPlaneControllerWitnessQuorum,
  DatabaseMigrationConsistency,
  DependencyQuorumStatus,
  ExecutionTrustStage,
  ExecutionTrustStatus,
  ExecutionTrustSwarm,
  FailureDomainLeaseSet,
  MaterialActionVerdict,
  MaterialActionVerdictEpoch,
  MaterialActionActivationReceipt,
  NegativeEvidenceRouterStatus,
  ProjectionWatermarkStatus,
  ReadyActionExchange,
  ReconciledActionClock,
  RecoveryWarrantStatus,
  RepairWarrantExchange,
  RouteStabilityEscrow,
  RuntimeProofCellStatus,
  RuntimeKitStatus,
  SourceRolloutTruthExchange,
  StageClearancePacket,
  WorkflowsReliabilityStatus,
} from '~/data/agents-control-plane'

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
  runtime_kits: RuntimeKitStatus[]
  admission_passports: AdmissionPassportStatus[]
  serving_passport_id: string | null
  recovery_warrants: RecoveryWarrantStatus[]
  runtime_proof_cells: RuntimeProofCellStatus[]
  projection_watermarks: ProjectionWatermarkStatus[]
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
  execution_trust: ExecutionTrustStatus
  swarms: ExecutionTrustSwarm[]
  stages: ExecutionTrustStage[]
  rollout_health: ControlPlaneRolloutHealth
  empirical_services: EmpiricalServicesStatus
  torghut_consumer_evidence: TorghutConsumerEvidenceStatus
  namespaces: NamespaceStatus[]
}
