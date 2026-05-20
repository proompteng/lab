import type {
  AgentsControlPlaneStatus as GenericAgentsControlPlaneStatus,
  ControlPlaneRolloutHealth,
  NamespaceStatus,
  WorkflowsReliabilityStatus,
} from '@proompteng/agent-contracts/control-plane-status'
import type { TorghutConsumerEvidenceStatus } from '~/server/control-plane-torghut-consumer-evidence'
import type {
  ActionCustodyReceipt,
  ActionSloBudget,
  AdmissionPassportStatus,
  AuthorityProvenanceSettlement,
  ClearanceMarketLedger,
  ConsumerEvidenceLeaseSet,
  ControllerIngestionSettlement,
  ControlPlaneControllerWitnessQuorum,
  DependencyVerdictExchange,
  DependencyQuorumStatus,
  EvidencePressureLedger,
  ExecutionTrustStage,
  ExecutionTrustStatus,
  ExecutionTrustSwarm,
  FailureDomainLeaseSet,
  MaterialActionVerdict,
  MaterialActionVerdictEpoch,
  MaterialActionActivationReceipt,
  MaterialEvidenceSettlementSpine,
  MaterialGateDigest,
  MaterialReentryClearinghouse,
  NegativeEvidenceRouterStatus,
  ProjectionWatermarkStatus,
  ProjectionForeclosureNotary,
  ReadyActionExchange,
  ReconciledActionClock,
  RepairSlotEscrow,
  RecoveryWarrantStatus,
  RevenueRepairSettlementCustody,
  ReadyTruthArbiter,
  RepairBidAdmissionState,
  RepairWarrantExchange,
  RouteStabilityEscrow,
  RolloutProofPassport,
  RunnerCapacityFuture,
  RuntimeProofCellStatus,
  RuntimeKitStatus,
  SourceServingContractVerdictExchange,
  SourceRolloutTruthExchange,
  StageClearancePacket,
  StageCreditLedger,
  StageLaunchTicket,
  TerminalDebtCompactionLedger,
  VerifyTrustForeclosureBoard,
} from '~/data/agents-control-plane'

export type {
  AgentRunIngestionStatus,
  ControlPlaneRolloutHealth,
  ControlPlaneWatchReliability,
  ControllerStatus,
  DatabaseStatus,
  DeploymentRolloutStatus,
  GrpcStatus,
  HeartbeatAuthoritySource,
  NamespaceStatus,
  RuntimeAdapterStatus,
  WorkflowsReliabilityStatus,
} from '@proompteng/agent-contracts/control-plane-status'

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

export type ControlPlaneStatus = GenericAgentsControlPlaneStatus & {
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
  dependency_verdict_exchange: DependencyVerdictExchange
  source_serving_contract_verdict_exchange: SourceServingContractVerdictExchange
  control_plane_controller_witness: ControlPlaneControllerWitnessQuorum
  controller_ingestion_settlement: ControllerIngestionSettlement
  material_action_verdict_epoch: MaterialActionVerdictEpoch
  material_action_verdicts: MaterialActionVerdict[]
  material_action_activation_receipts: MaterialActionActivationReceipt[]
  action_custody_receipts: ActionCustodyReceipt[]
  stage_clearance_packets: StageClearancePacket[]
  projection_foreclosure_notary: ProjectionForeclosureNotary | null
  stage_credit_ledger: StageCreditLedger | null
  ready_truth_arbiter: ReadyTruthArbiter
  revenue_repair_settlement_custody: RevenueRepairSettlementCustody
  verify_trust_foreclosure_board: VerifyTrustForeclosureBoard
  rollout_proof_passport: RolloutProofPassport
  runner_capacity_futures: RunnerCapacityFuture[]
  stage_launch_tickets: StageLaunchTicket[]
  authority_provenance_settlement: AuthorityProvenanceSettlement
  evidence_pressure_ledger: EvidencePressureLedger | null
  terminal_debt_compaction_ledger: TerminalDebtCompactionLedger | null
  ready_action_exchange: ReadyActionExchange
  repair_bid_admission: RepairBidAdmissionState
  material_gate_digest: MaterialGateDigest
  material_evidence_settlement_spine: MaterialEvidenceSettlementSpine
  material_reentry_clearinghouse: MaterialReentryClearinghouse
  repair_slot_escrow: RepairSlotEscrow | null
  repair_warrant_exchange: RepairWarrantExchange
  consumer_evidence_leases: ConsumerEvidenceLeaseSet
  clearance_market_ledger: ClearanceMarketLedger | null
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
