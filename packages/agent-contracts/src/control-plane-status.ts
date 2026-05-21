import { createHash } from 'node:crypto'

import type {
  AdmissionPassportStatus,
  ProjectionWatermarkStatus,
  RecoveryWarrantStatus,
  RuntimeKitStatus,
  RuntimeProofCellStatus,
} from './runtime-admission'
import type { ExecutionTrustStatus } from './execution-trust'

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

type Timestamp = string | Date

export type ControlPlaneHeartbeatWorkloadRole = 'web' | 'controllers' | 'other'

export type ControlPlaneHeartbeatStatus = ComponentStatus

export type ControlPlaneHeartbeatLeadership = 'leader' | 'follower' | 'not-applicable'

export type ControlPlaneHeartbeatRow = {
  namespace: string
  component: string
  workload_role: ControlPlaneHeartbeatWorkloadRole
  pod_name: string
  deployment_name: string
  enabled: boolean
  status: ControlPlaneHeartbeatStatus
  message: string
  leadership_state: ControlPlaneHeartbeatLeadership
  observed_at: Timestamp | null
  expires_at: Timestamp | null
}

export const isControlPlaneHeartbeatFresh = (
  row: { observed_at: Timestamp | null; expires_at: Timestamp | null },
  now: Date,
) => {
  const observed = row.observed_at ? new Date(row.observed_at) : null
  const expires = row.expires_at ? new Date(row.expires_at) : null
  if (!observed || !Number.isFinite(observed.getTime())) return false
  if (!expires || !Number.isFinite(expires.getTime())) return false
  return observed.getTime() <= now.getTime() && now.getTime() <= expires.getTime()
}

export type ControllerStatus = {
  name: string
  enabled: boolean
  started: boolean
  scope_namespaces: string[]
  crds_ready: boolean
  missing_crds: string[]
  forbidden_crds?: string[]
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

export const AGENTS_CONTROLLER_WITNESS_DESIGN_ARTIFACT = 'docs/agents/designs/agents-controller-witness-quorum.md'

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

export const CONTROL_PLANE_CONTROLLER_INGESTION_SETTLEMENT_DESIGN_ARTIFACT =
  'docs/agents/designs/agents-controller-ingestion-settlement.md'

const CONTROLLER_INGESTION_SETTLEMENT_SCHEMA_VERSION = 'agents.controller-ingestion-settlement.v1' as const
const CONTROLLER_INGESTION_SETTLEMENT_TTL_SECONDS = 60
const MATERIAL_SOURCE_SERVING_ACTION_CLASSES = [
  'dispatch_repair',
  'dispatch_normal',
  'deploy_widen',
  'merge_ready',
] as const

export type ControlPlaneServingReadiness = 'ok' | 'degraded' | 'down'

export type ControlPlaneControllerIngestionSettlementMode = 'observe' | 'shadow' | 'hold' | 'enforce'

export type ControlPlaneControllerIngestionSettlementDecision = 'allow' | 'repair_only' | 'hold' | 'block'

export type ControlPlaneControllerIngestionSettlementTicketClass = 'controller_ingestion' | 'platform_rollout' | 'none'

export type ControlPlaneSourceServingStatus = 'allow' | 'repair_only' | 'hold' | 'block' | 'unknown'

export type ControlPlaneSourceServingSnapshot = {
  verdict_ref: string | null
  status: ControlPlaneSourceServingStatus
  fresh_until: string | null
  source_head_sha: string | null
  serving_build_commit: string | null
  manifest_image_digest: string | null
  serving_image_digest: string | null
  allowed_action_classes: string[]
  repair_only_action_classes: string[]
  held_action_classes: string[]
  blocked_action_classes: string[]
  reason_codes: string[]
  evidence_refs: string[]
  rollback_target: string | null
}

export type ControlPlaneControllerIngestionSettlement = {
  schema_version: typeof CONTROLLER_INGESTION_SETTLEMENT_SCHEMA_VERSION
  mode: ControlPlaneControllerIngestionSettlementMode
  settlement_id: string
  generated_at: string
  fresh_until: string
  namespace: string
  governing_design_refs: string[]
  decision: ControlPlaneControllerIngestionSettlementDecision
  serving_readiness: ControlPlaneServingReadiness
  controller_witness_ref: string | null
  controller_witness_decision: ControllerWitnessDecision | null
  deployment_available: boolean
  watch_epoch_current: boolean
  controller_self_report_current: boolean
  agentrun_ingestion_current: boolean
  execution_trust_status: ExecutionTrustStatus['status']
  database_status: DatabaseStatus['status']
  rollout_health_status: ControlPlaneRolloutHealth['status']
  source_serving_verdict_ref: string | null
  source_serving_material_status: ControlPlaneSourceServingStatus | null
  source_head_sha: string | null
  serving_build_commit: string | null
  manifest_image_digest: string | null
  serving_image_digest: string | null
  selected_repair_ticket: {
    ticket_class: ControlPlaneControllerIngestionSettlementTicketClass
    max_parallelism: number
    validation_commands: string[]
    reason_codes: string[]
  }
  controller_reason_codes: string[]
  source_serving_reason_codes: string[]
  platform_reason_codes: string[]
  reason_codes: string[]
  evidence_refs: string[]
  rollback_target: string
}

export type BuildControlPlaneControllerIngestionSettlementInput = {
  now: Date
  namespace: string
  mode?: ControlPlaneControllerIngestionSettlementMode
  servingReadiness: ControlPlaneServingReadiness
  controllerWitness: ControlPlaneControllerWitnessQuorum
  agentRunIngestion: AgentRunIngestionStatus
  executionTrust: ExecutionTrustStatus
  database: DatabaseStatus
  rolloutHealth: ControlPlaneRolloutHealth
  sourceServing?: ControlPlaneSourceServingSnapshot | null
}

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const addSeconds = (value: Date, seconds: number) => new Date(value.getTime() + seconds * 1000)

const parseTimestampMs = (value: string | null | undefined) => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

const isFresh = (value: string | null | undefined, now: Date) => {
  const parsed = parseTimestampMs(value)
  return Boolean(parsed && parsed > now.getTime())
}

const normalizeReason = (value: string | null | undefined) =>
  value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_') ?? null

const uniqueStrings = (values: Array<string | null | undefined>) => [...new Set(values.filter(Boolean) as string[])]

const sourceServingMaterialStatus = (
  sourceServing: ControlPlaneSourceServingSnapshot,
): ControlPlaneSourceServingStatus => {
  if (
    MATERIAL_SOURCE_SERVING_ACTION_CLASSES.some((actionClass) =>
      sourceServing.blocked_action_classes.includes(actionClass),
    )
  ) {
    return 'block'
  }
  if (
    MATERIAL_SOURCE_SERVING_ACTION_CLASSES.some((actionClass) =>
      sourceServing.held_action_classes.includes(actionClass),
    )
  ) {
    return 'hold'
  }
  if (
    MATERIAL_SOURCE_SERVING_ACTION_CLASSES.some((actionClass) =>
      sourceServing.repair_only_action_classes.includes(actionClass),
    )
  ) {
    return 'repair_only'
  }
  return 'allow'
}

const settlementFreshUntil = (input: BuildControlPlaneControllerIngestionSettlementInput) => {
  const fallback = addSeconds(input.now, CONTROLLER_INGESTION_SETTLEMENT_TTL_SECONDS).toISOString()
  const timestamps = [input.controllerWitness.expires_at, input.sourceServing?.fresh_until]
    .map((value) => parseTimestampMs(value))
    .filter((value): value is number => value !== null && value > input.now.getTime())
  return timestamps.length > 0 ? new Date(Math.min(...timestamps)).toISOString() : fallback
}

const controllerReasonCodes = (input: BuildControlPlaneControllerIngestionSettlementInput) =>
  uniqueStrings([
    isFresh(input.controllerWitness.expires_at, input.now) ? null : 'controller_witness_stale',
    input.controllerWitness.deployment_available ? null : 'controller_deployment_unavailable',
    input.controllerWitness.watch_epoch_current ? null : 'watch_epoch_not_current',
    input.controllerWitness.controller_self_report_current ? null : 'controller_self_report_not_current',
    input.agentRunIngestion.status === 'healthy' ? null : `agentrun_ingestion_${input.agentRunIngestion.status}`,
    ...input.controllerWitness.reason_codes,
  ]).map((reason) => normalizeReason(reason) ?? reason)

const sourceServingReasonCodes = (input: BuildControlPlaneControllerIngestionSettlementInput) => {
  const sourceServing = input.sourceServing
  if (!sourceServing) return []
  const materialStatus = sourceServingMaterialStatus(sourceServing)
  return uniqueStrings([
    isFresh(sourceServing.fresh_until, input.now) ? null : 'source_serving_verdict_stale',
    materialStatus === 'allow' ? null : `source_serving_${materialStatus}`,
    ...sourceServing.reason_codes,
  ]).map((reason) => normalizeReason(reason) ?? reason)
}

const platformReasonCodes = (input: BuildControlPlaneControllerIngestionSettlementInput) =>
  uniqueStrings([
    input.servingReadiness === 'ok' ? null : `serving_readiness_${input.servingReadiness}`,
    input.rolloutHealth.status === 'healthy' ? null : `rollout_health_${input.rolloutHealth.status}`,
    input.database.status === 'healthy' ? null : `database_${input.database.status}`,
    input.executionTrust.status === 'healthy' ? null : `execution_trust_${input.executionTrust.status}`,
  ]).map((reason) => normalizeReason(reason) ?? reason)

const hasBlockingControllerIngestionContradiction = (
  input: BuildControlPlaneControllerIngestionSettlementInput,
  sourceReasons: string[],
) =>
  input.controllerWitness.decision === 'block' ||
  input.executionTrust.status === 'blocked' ||
  sourceReasons.includes('source_serving_block')

const controllerIngestionDecision = (input: {
  hasBlocker: boolean
  controllerReasons: string[]
  sourceReasons: string[]
  platformReasons: string[]
}): ControlPlaneControllerIngestionSettlementDecision => {
  if (input.hasBlocker) return 'block'
  if (input.controllerReasons.length === 0 && input.sourceReasons.length === 0 && input.platformReasons.length === 0) {
    return 'allow'
  }
  if (input.controllerReasons.length > 0 && input.sourceReasons.length === 0 && input.platformReasons.length === 0) {
    return 'repair_only'
  }
  return 'hold'
}

const controllerIngestionTicketClass = (input: {
  decision: ControlPlaneControllerIngestionSettlementDecision
  controllerReasons: string[]
  sourceReasons: string[]
  platformReasons: string[]
}): ControlPlaneControllerIngestionSettlementTicketClass => {
  if (input.decision !== 'repair_only') return 'none'
  if (input.controllerReasons.length > 0 && input.sourceReasons.length === 0 && input.platformReasons.length === 0) {
    return 'controller_ingestion'
  }
  return 'platform_rollout'
}

export const buildControlPlaneControllerIngestionSettlement = (
  input: BuildControlPlaneControllerIngestionSettlementInput,
): ControlPlaneControllerIngestionSettlement => {
  const sourceServing = input.sourceServing ?? null
  const sourceStatus = sourceServing ? sourceServingMaterialStatus(sourceServing) : null
  const controllerReasons = controllerReasonCodes(input)
  const sourceReasons = sourceServingReasonCodes(input)
  const platformReasons = platformReasonCodes(input)
  const reasonCodes = uniqueStrings([...controllerReasons, ...sourceReasons, ...platformReasons])
  const decision = controllerIngestionDecision({
    hasBlocker: hasBlockingControllerIngestionContradiction(input, sourceReasons),
    controllerReasons,
    sourceReasons,
    platformReasons,
  })
  const ticketClass = controllerIngestionTicketClass({
    decision,
    controllerReasons,
    sourceReasons,
    platformReasons,
  })
  const evidenceRefs = uniqueStrings([
    input.controllerWitness.quorum_id,
    ...input.controllerWitness.witness_refs,
    sourceServing?.verdict_ref,
    ...(sourceServing?.evidence_refs ?? []),
  ])
  const settlementId = `controller-ingestion-settlement:${input.namespace}:${hashJson({
    schema_version: CONTROLLER_INGESTION_SETTLEMENT_SCHEMA_VERSION,
    decision,
    controller_reason_codes: controllerReasons,
    source_serving_reason_codes: sourceReasons,
    platform_reason_codes: platformReasons,
    controller_witness_ref: input.controllerWitness.quorum_id,
    source_serving_ref: sourceServing?.verdict_ref ?? null,
  })}`

  return {
    schema_version: CONTROLLER_INGESTION_SETTLEMENT_SCHEMA_VERSION,
    mode: input.mode ?? 'observe',
    settlement_id: settlementId,
    generated_at: input.now.toISOString(),
    fresh_until: settlementFreshUntil(input),
    namespace: input.namespace,
    governing_design_refs: [
      CONTROL_PLANE_CONTROLLER_INGESTION_SETTLEMENT_DESIGN_ARTIFACT,
      'swarm-validation-contract:every-run-cites-governing-requirement',
    ],
    decision,
    serving_readiness: input.servingReadiness,
    controller_witness_ref: input.controllerWitness.quorum_id,
    controller_witness_decision: input.controllerWitness.decision,
    deployment_available: input.controllerWitness.deployment_available,
    watch_epoch_current: input.controllerWitness.watch_epoch_current,
    controller_self_report_current: input.controllerWitness.controller_self_report_current,
    agentrun_ingestion_current: input.agentRunIngestion.status === 'healthy',
    execution_trust_status: input.executionTrust.status,
    database_status: input.database.status,
    rollout_health_status: input.rolloutHealth.status,
    source_serving_verdict_ref: sourceServing?.verdict_ref ?? null,
    source_serving_material_status: sourceStatus,
    source_head_sha: sourceServing?.source_head_sha ?? null,
    serving_build_commit: sourceServing?.serving_build_commit ?? null,
    manifest_image_digest: sourceServing?.manifest_image_digest ?? null,
    serving_image_digest: sourceServing?.serving_image_digest ?? null,
    selected_repair_ticket: {
      ticket_class: ticketClass,
      max_parallelism: ticketClass === 'none' ? 0 : 1,
      validation_commands:
        ticketClass === 'controller_ingestion'
          ? [
              `curl -fsS 'http://agents.agents.svc.cluster.local/v1/control-plane/status?namespace=${input.namespace}' | jq '.controller_ingestion_settlement'`,
              `kubectl get deployments -n ${input.namespace} agents-controllers`,
            ]
          : [],
      reason_codes: ticketClass === 'controller_ingestion' ? controllerReasons : [],
    },
    controller_reason_codes: controllerReasons,
    source_serving_reason_codes: sourceReasons,
    platform_reason_codes: platformReasons,
    reason_codes: reasonCodes,
    evidence_refs: evidenceRefs,
    rollback_target:
      sourceServing?.rollback_target ??
      input.controllerWitness.rollback_target ??
      'restore Agents controller ingestion and serving status evidence',
  }
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
  control_plane_controller_witness: ControlPlaneControllerWitnessQuorum
  controller_ingestion_settlement: ControlPlaneControllerIngestionSettlement
  runtime_kits: RuntimeKitStatus[]
  admission_passports: AdmissionPassportStatus[]
  serving_passport_id: string | null
  recovery_warrants: RecoveryWarrantStatus[]
  runtime_proof_cells: RuntimeProofCellStatus[]
  projection_watermarks: ProjectionWatermarkStatus[]
  workflows: WorkflowsReliabilityStatus
  rollout_health: ControlPlaneRolloutHealth
  namespaces: NamespaceStatus[]
}
