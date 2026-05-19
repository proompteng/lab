import { createFileRoute } from '@tanstack/react-router'
import {
  buildAgentsRuntimeReadyResponse,
  isAgentRunIngestionReady,
  isControllerHealthReady,
  isStandbyLeaderElectionReady,
  uniqueStrings,
} from '@proompteng/agents/server/ready'

import type {
  ControlPlaneControllerWitnessQuorum,
  ExecutionTrustStatus,
  SourceServingContractVerdictExchange,
  TorghutRevenueRepairQueueItem,
} from '~/data/agents-control-plane'
import { isAgentsRuntimeService, resolveRuntimeServiceName } from '~/server/runtime-identity'
import { assessAgentRunIngestion, getAgentsControllerHealth } from '@proompteng/agents/server/agents-controller'
import { buildControllerIngestionSettlement } from '~/server/control-plane-controller-ingestion-settlement'
import { buildRuntimeAdmissionSnapshot, findAdmissionPassport } from '~/server/control-plane-runtime-admission'
import {
  buildEvidencePressureLedger,
  isEvidencePressureLedgerEnabled,
  type EvidencePressureControllerReadiness,
} from '~/server/control-plane-evidence-pressure-ledger'
import { buildRepairBidAdmissionState } from '~/server/control-plane-repair-bid-admission'
import { getGithubReviewIngestPressureSummary } from '~/server/github-review-ingest'
import { getLeaderElectionStatus } from '~/server/leader-election'
import { getMemoryProviderHealth } from '~/server/memory-provider-health'
import { getMetricsSinkPressureSummary } from '~/server/metrics'
import { getOrchestrationControllerHealth } from '@proompteng/agents/server/orchestration-controller'
import { getSupportingControllerHealth } from '~/server/supporting-primitives-controller'
import { buildExecutionTrust } from '~/server/control-plane-status'
import {
  resolveTorghutConsumerEvidence,
  type TorghutConsumerEvidenceStatus,
} from '~/server/control-plane-torghut-consumer-evidence'
import { buildMaterialGateDigest } from '~/server/control-plane-material-gate-digest'
import {
  buildRepairSlotEscrow,
  isRepairSlotEscrowEnabled,
  resolveRepairSlotEscrowMode,
} from '~/server/control-plane-repair-slot-escrow'
import { buildRevenueRepairSettlementCustody } from '~/server/control-plane-revenue-repair-settlement-custody'
import { buildAgentRunIngestionStatus } from '~/server/control-plane-serving-process-status'
import { buildVerifyTrustForeclosureBoard } from '~/server/control-plane-verify-trust-foreclosure'
import { buildMaterialEvidenceSettlementSpine } from '~/server/control-plane-material-evidence-settlement'
import type {
  AgentRunIngestionStatus,
  ControlPlaneRolloutHealth,
  DatabaseStatus,
} from '~/server/control-plane-status-types'
import { getWatchReliabilitySummary } from '~/server/control-plane-watch-reliability'

const buildReadyControllerReadiness = (
  name: string,
  health: ReturnType<typeof getAgentsControllerHealth>,
): EvidencePressureControllerReadiness => ({
  name,
  enabled: health.enabled,
  started: health.started,
  crdsReady: health.crdsReady ?? null,
  message:
    !health.enabled || (health.started && health.crdsReady !== false)
      ? `${name} ready`
      : health.crdsReady === false
        ? `${name} CRDs are not ready`
        : `${name} is not started`,
})

const EXECUTION_TRUST_STATUS_PRIORITY: Record<ExecutionTrustStatus['status'], number> = {
  healthy: 0,
  degraded: 1,
  unknown: 2,
  blocked: 3,
}

const summarizeExecutionTrustReason = (input: {
  status: ExecutionTrustStatus['status']
  namespaces: string[]
  reasons: string[]
}) => {
  const reasons = uniqueStrings(input.reasons)
  if (input.status === 'healthy') {
    return input.namespaces.length > 1
      ? `execution trust is healthy across ${input.namespaces.length} namespaces`
      : (reasons[0] ?? 'execution trust is healthy')
  }

  const statusLabel = input.status === 'blocked' ? 'blocked' : input.status === 'unknown' ? 'unknown' : 'degraded'
  const prefix =
    input.namespaces.length > 1
      ? `execution trust ${statusLabel} across ${input.namespaces.length} namespaces`
      : `execution trust ${statusLabel}`

  return reasons.length > 0 ? `${prefix}: ${reasons.join('; ')}` : prefix
}

const mergeExecutionTrustStatuses = (input: {
  now: Date
  namespaces: string[]
  trusts: ExecutionTrustStatus[]
}): ExecutionTrustStatus => {
  const mergedStatus = input.trusts.reduce<ExecutionTrustStatus['status']>((status, trust) => {
    return EXECUTION_TRUST_STATUS_PRIORITY[trust.status] > EXECUTION_TRUST_STATUS_PRIORITY[status]
      ? trust.status
      : status
  }, 'healthy')

  return {
    status: mergedStatus,
    reason: summarizeExecutionTrustReason({
      status: mergedStatus,
      namespaces: input.namespaces,
      reasons: input.trusts.map((trust) => trust.reason),
    }),
    last_evaluated_at: input.now.toISOString(),
    blocking_windows: input.trusts.flatMap((trust) => trust.blocking_windows),
    evidence_summary: uniqueStrings(input.trusts.flatMap((trust) => trust.evidence_summary)),
  }
}

const alphaReadinessQueueItem = (
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus,
): TorghutRevenueRepairQueueItem | null => {
  const blocker = torghutConsumerEvidence.alpha_readiness_strike_ledger?.selected_business_blocker
  if (!blocker) return null
  return {
    code: blocker.code,
    reason: blocker.reason,
    dimension: null,
    action: null,
    priority: null,
    expected_unblock_value: null,
    source: torghutConsumerEvidence.alpha_readiness_strike_ledger?.revenue_repair_digest_ref ?? null,
    value_gate: blocker.value_gate,
    required_output_receipt: blocker.required_output_receipt,
    required_receipts: torghutConsumerEvidence.alpha_readiness_strike_ledger?.required_after_receipts ?? [],
    max_notional: torghutConsumerEvidence.alpha_readiness_strike_ledger?.max_notional ?? null,
    capital_rule: torghutConsumerEvidence.alpha_readiness_strike_ledger?.strike_slots[0]?.capital_rule ?? null,
    observed_count: torghutConsumerEvidence.alpha_readiness_strike_ledger?.routeable_candidate_count_before ?? null,
  }
}

const deriveRevenueReady = (businessState: string | null, topRepairQueueItem: TorghutRevenueRepairQueueItem | null) => {
  if (!businessState) return null
  if (businessState === 'ready' || businessState === 'revenue_ready' || businessState === 'live_ready') return true
  if (businessState === 'repair_only' || businessState === 'repair' || businessState === 'hold') return false
  if (businessState === 'blocked' || businessState === 'degraded') return false
  return topRepairQueueItem ? false : null
}

const buildBusinessEvidence = (
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus,
  repairBidAdmission: ReturnType<typeof buildRepairBidAdmissionState>,
) => {
  const fallbackQueueItem = alphaReadinessQueueItem(torghutConsumerEvidence)
  const repairQueue =
    torghutConsumerEvidence.revenue_repair_queue && torghutConsumerEvidence.revenue_repair_queue.length > 0
      ? torghutConsumerEvidence.revenue_repair_queue
      : fallbackQueueItem
        ? [fallbackQueueItem]
        : []
  const topRepairQueueItem = repairQueue[0] ?? null
  const businessState =
    torghutConsumerEvidence.revenue_repair_business_state ??
    (topRepairQueueItem || torghutConsumerEvidence.max_notional === '0' ? 'repair_only' : null)
  const affectedValueGate =
    topRepairQueueItem?.value_gate ??
    torghutConsumerEvidence.executable_alpha_repair_receipts?.target_value_gate ??
    repairBidAdmission.dispatch_tickets.find((ticket) => ticket.launch_allowed)?.target_value_gate ??
    null

  return {
    business_state: businessState,
    revenue_ready:
      torghutConsumerEvidence.revenue_repair_ready ?? deriveRevenueReady(businessState, topRepairQueueItem),
    repair_queue: repairQueue,
    top_repair_queue_item: topRepairQueueItem,
    affected_value_gate: affectedValueGate,
  }
}

const readyPathFreshUntil = (now: Date) => new Date(now.getTime() + 60_000).toISOString()

const buildReadyPathRolloutHealth = (ready: boolean): ControlPlaneRolloutHealth => ({
  status: ready ? 'unknown' : 'degraded',
  observed_deployments: 0,
  degraded_deployments: ready ? 0 : 1,
  deployments: [],
  message: ready
    ? 'rollout proof unavailable on /ready hot path; use control-plane status for full proof'
    : 'serving readiness degraded on /ready hot path',
})

const buildReadyPathSourceServingExchange = (now: Date, namespace: string): SourceServingContractVerdictExchange => ({
  mode: 'observe',
  design_artifact:
    'docs/agents/designs/200-jangar-revenue-repair-settlement-conveyor-and-stage-health-custody-2026-05-14.md',
  exchange_id: `source-serving-contract-verdict-exchange:${namespace}:ready-hot-path-unavailable`,
  generated_at: now.toISOString(),
  fresh_until: readyPathFreshUntil(now),
  namespace,
  status: 'hold',
  source_sha: null,
  serving_build_commit: null,
  manifest_image_digest: null,
  serving_image_digest: null,
  required_contracts: [],
  observed_contracts: [],
  missing_contracts: [],
  verdict_refs: [],
  allowed_action_classes: [],
  repair_only_action_classes: [],
  held_action_classes: ['dispatch_repair'],
  blocked_action_classes: [],
  reason_codes: ['source_serving_contract_unavailable_on_ready_hot_path'],
  verdicts: [],
  rollback_target: 'use /api/agents/control-plane/status for full source-serving rollout proof',
})

const buildReadyPathDatabaseStatus = (): DatabaseStatus => ({
  configured: false,
  connected: false,
  status: 'disabled',
  message: 'database proof unavailable on /ready hot path; use control-plane status for full proof',
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
    message: 'database migration proof unavailable on /ready hot path',
  },
})

const readyPathWitnessId = (namespace: string, surface: string) => `witness:${surface}:${namespace}:ready-hot-path`

const buildReadyPathControllerWitness = (input: {
  now: Date
  namespace: string
  agentsController: ReturnType<typeof getAgentsControllerHealth>
  agentRunIngestion: AgentRunIngestionStatus
  watchReliability: ReturnType<typeof getWatchReliabilitySummary>
}): ControlPlaneControllerWitnessQuorum => {
  const expiresAt = readyPathFreshUntil(input.now)
  const deploymentAvailable = input.agentsController.enabled && input.agentsController.started
  const watchEpochCurrent = input.watchReliability.status === 'healthy'
  const controllerSelfReportCurrent = deploymentAvailable && input.agentRunIngestion.status === 'healthy'
  const decision =
    input.agentRunIngestion.status === 'degraded'
      ? 'hold_material'
      : controllerSelfReportCurrent
        ? 'allow'
        : deploymentAvailable && watchEpochCurrent
          ? 'repair_only'
          : 'hold_material'
  const reasonCodes = uniqueStrings([
    ...(deploymentAvailable ? [] : ['controller_deployment_unavailable_on_ready_hot_path']),
    ...(watchEpochCurrent ? [] : ['watch_epoch_not_current_on_ready_hot_path']),
    ...(controllerSelfReportCurrent ? [] : ['controller_self_report_unavailable_on_ready_hot_path']),
    ...(input.agentRunIngestion.status === 'healthy' ? [] : [`agentrun_ingestion_${input.agentRunIngestion.status}`]),
  ])
  const witnessRefs = [
    readyPathWitnessId(input.namespace, 'serving_process'),
    readyPathWitnessId(input.namespace, 'watch_epoch'),
    readyPathWitnessId(input.namespace, 'agentrun_ingestion'),
  ]

  return {
    mode: 'shadow',
    design_artifact:
      'docs/agents/designs/116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md',
    quorum_id: `controller-witness:${input.namespace}:ready-hot-path`,
    generated_at: input.now.toISOString(),
    expires_at: expiresAt,
    namespace: input.namespace,
    decision,
    reason_codes: reasonCodes,
    message: controllerSelfReportCurrent
      ? 'ready hot path sees controller ingestion as current'
      : 'ready hot path cannot prove full controller ingestion; use control-plane status for full proof',
    witness_refs: witnessRefs,
    deployment_available: deploymentAvailable,
    watch_epoch_current: watchEpochCurrent,
    controller_self_report_current: controllerSelfReportCurrent,
    witnesses: [
      {
        witness_id: witnessRefs[0],
        generated_at: input.now.toISOString(),
        expires_at: expiresAt,
        namespace: input.namespace,
        controller_surface: 'serving_process',
        deployment_ref: null,
        pod_uid: null,
        image_ref: null,
        leader_identity: null,
        controller_started: input.agentsController.started,
        deployment_available: deploymentAvailable,
        watch_epoch_id: null,
        ingestion_epoch_id: null,
        last_watch_event_at: null,
        last_resync_at: null,
        observed_run_count: null,
        untouched_run_count: null,
        decision: deploymentAvailable ? 'allow' : 'repair_only',
        reason_codes: deploymentAvailable ? [] : ['controller_deployment_unavailable_on_ready_hot_path'],
      },
      {
        witness_id: witnessRefs[1],
        generated_at: input.now.toISOString(),
        expires_at: expiresAt,
        namespace: input.namespace,
        controller_surface: 'watch_epoch',
        deployment_ref: null,
        pod_uid: null,
        image_ref: null,
        leader_identity: null,
        controller_started: null,
        deployment_available: null,
        watch_epoch_id: `watch:${input.namespace}:ready-hot-path`,
        ingestion_epoch_id: null,
        last_watch_event_at: input.watchReliability.streams[0]?.last_seen_at ?? null,
        last_resync_at: null,
        observed_run_count: input.watchReliability.total_events,
        untouched_run_count: null,
        decision: watchEpochCurrent ? 'allow' : 'hold_material',
        reason_codes: watchEpochCurrent ? [] : ['watch_epoch_not_current_on_ready_hot_path'],
      },
      {
        witness_id: witnessRefs[2],
        generated_at: input.now.toISOString(),
        expires_at: expiresAt,
        namespace: input.namespace,
        controller_surface: 'agentrun_ingestion',
        deployment_ref: null,
        pod_uid: null,
        image_ref: null,
        leader_identity: null,
        controller_started: null,
        deployment_available: null,
        watch_epoch_id: null,
        ingestion_epoch_id: `ingestion:${input.namespace}:ready-hot-path`,
        last_watch_event_at: input.agentRunIngestion.last_watch_event_at,
        last_resync_at: input.agentRunIngestion.last_resync_at,
        observed_run_count: null,
        untouched_run_count: input.agentRunIngestion.untouched_run_count,
        decision: input.agentRunIngestion.status === 'healthy' ? 'allow' : 'hold_material',
        reason_codes:
          input.agentRunIngestion.status === 'healthy' ? [] : [`agentrun_ingestion_${input.agentRunIngestion.status}`],
      },
    ],
    rollback_target: 'use /api/agents/control-plane/status for full controller witness proof',
  }
}

const executionTrustStatus = async (namespaces: string[]) => {
  const now = new Date()
  const resolvedNamespaces = uniqueStrings(namespaces.length > 0 ? namespaces : ['agents'])
  const trusts = await Promise.all(
    resolvedNamespaces.map(async (namespace): Promise<ExecutionTrustStatus> => {
      try {
        return (
          await buildExecutionTrust({
            namespace,
            now,
            swarms: [],
          })
        ).executionTrust
      } catch {
        return {
          status: 'unknown',
          reason: `execution trust check failed for namespace ${namespace}`,
          last_evaluated_at: now.toISOString(),
          blocking_windows: [],
          evidence_summary: [],
        }
      }
    }),
  )

  return mergeExecutionTrustStatuses({
    now,
    namespaces: resolvedNamespaces,
    trusts,
  })
}

export const Route = createFileRoute('/ready')({
  server: {
    handlers: {
      GET: () => getReadyHandler(),
    },
  },
})

export const getReadyHandler = async () => {
  const now = new Date()
  const leaderElection = getLeaderElectionStatus()
  const agentsController = getAgentsControllerHealth()
  const orchestrationController = getOrchestrationControllerHealth()
  const supportingController = getSupportingControllerHealth()
  if (isAgentsRuntimeService()) {
    return buildAgentsRuntimeReadyResponse({
      leaderElection,
      agentsController,
      orchestrationController,
      supportingController,
      assessAgentRunIngestion,
    })
  }
  const namespaces = agentsController.namespaces?.length ? agentsController.namespaces : ['agents']
  const trust = await executionTrustStatus(namespaces)
  const torghutConsumerEvidence = await resolveTorghutConsumerEvidence(now)
  const repairBidAdmission = buildRepairBidAdmissionState({
    now,
    namespace: namespaces[0] ?? 'agents',
    repository: process.env.CODEX_REPOSITORY ?? process.env.CODEX_REPO_SLUG,
    branch: process.env.CODEX_BRANCH,
    swarmName: process.env.SWARM_NAME,
    stage: process.env.SWARM_STAGE ?? process.env.CODEX_STAGE,
    torghutConsumerEvidence: torghutConsumerEvidence.status,
  })
  const businessEvidence = buildBusinessEvidence(torghutConsumerEvidence.status, repairBidAdmission)
  const memoryProvider = getMemoryProviderHealth()
  const runtimeAdmission = buildRuntimeAdmissionSnapshot({
    now,
    executionTrust: trust,
  })
  const evidencePressureLedger = isEvidencePressureLedgerEnabled()
    ? buildEvidencePressureLedger({
        now,
        namespace: namespaces[0] ?? 'agents',
        watchReliability: getWatchReliabilitySummary(),
        controllerReadiness: [
          buildReadyControllerReadiness('agents-controller', agentsController),
          buildReadyControllerReadiness('orchestration-controller', orchestrationController),
          buildReadyControllerReadiness('supporting-controller', supportingController),
        ],
        metricsSink: getMetricsSinkPressureSummary(),
        githubIngest: getGithubReviewIngestPressureSummary(),
        torghutConsumerEvidence: torghutConsumerEvidence.status,
      })
    : null
  const watchReliability = getWatchReliabilitySummary()
  const servingPassport = findAdmissionPassport({
    admissionPassports: runtimeAdmission.admissionPassports,
    consumerClass: 'serving',
  })
  const recoveryWarrants = runtimeAdmission.recoveryWarrants ?? []
  const runtimeProofCells = runtimeAdmission.runtimeProofCells ?? []
  const projectionWatermarks = runtimeAdmission.projectionWatermarks ?? []
  const servingRecoveryWarrant =
    recoveryWarrants.find((warrant) => warrant.execution_class === 'serving' && warrant.status !== 'superseded') ?? null
  const servingRuntimeProofCells = servingRecoveryWarrant
    ? runtimeProofCells.filter((cell) =>
        servingRecoveryWarrant.required_proof_cell_ids.includes(cell.runtime_proof_cell_id),
      )
    : []
  const servingRuntimeProofCellsHealthy =
    servingRecoveryWarrant !== null &&
    servingRuntimeProofCells.every((cell) => !cell.required || cell.status === 'healthy')

  const controllersOk =
    isControllerHealthReady(agentsController) &&
    isControllerHealthReady(orchestrationController) &&
    isControllerHealthReady(supportingController)
  const leaderRequired = leaderElection.required
  const activeControllerReplica = !leaderRequired || leaderElection.isLeader
  const leaderElectionReady = activeControllerReplica || isStandbyLeaderElectionReady(leaderElection)
  const agentsControllerHealthy = activeControllerReplica
    ? isAgentRunIngestionReady(agentsController, assessAgentRunIngestion)
    : leaderElectionReady
  const servingPassportReady =
    servingPassport !== undefined && servingPassport.decision !== 'block' && servingPassport.decision !== 'hold'
  const memoryProviderReady = memoryProvider.status !== 'blocked'
  const ready = controllersOk && leaderElectionReady && memoryProviderReady
  const status = ready && agentsControllerHealthy && servingPassportReady ? 'ok' : 'degraded'
  const readyPathRolloutHealth = buildReadyPathRolloutHealth(ready)
  const readyPathSourceServingExchange = buildReadyPathSourceServingExchange(now, namespaces[0] ?? 'agents')
  const readyPathAgentRunIngestion = buildAgentRunIngestionStatus(namespaces[0] ?? 'agents', agentsController)
  const readyPathControllerWitness = buildReadyPathControllerWitness({
    now,
    namespace: namespaces[0] ?? 'agents',
    agentsController,
    agentRunIngestion: readyPathAgentRunIngestion,
    watchReliability,
  })
  const readyPathDatabase = buildReadyPathDatabaseStatus()
  const revenueRepairSettlementCustody = buildRevenueRepairSettlementCustody(
    {
      now,
      namespace: namespaces[0] ?? 'agents',
      rolloutHealth: readyPathRolloutHealth,
      sourceServingContractVerdictExchange: readyPathSourceServingExchange,
      stageCreditLedger: null,
      torghutConsumerEvidence: torghutConsumerEvidence.status,
    },
    'observe',
  )
  const verifyTrustForeclosureBoard = buildVerifyTrustForeclosureBoard(
    {
      now,
      namespace: namespaces[0] ?? 'agents',
      executionTrust: trust,
      sourceServingContractVerdictExchange: readyPathSourceServingExchange,
      torghutConsumerEvidence: torghutConsumerEvidence.status,
      revenueRepairSettlementCustody,
      rolloutHealth: readyPathRolloutHealth,
      serviceHealth: ready ? status : 'down',
    },
    'observe',
  )
  const materialGateDigest = buildMaterialGateDigest({
    now,
    namespace: namespaces[0] ?? 'agents',
    servingReadiness: ready ? status : 'down',
    businessState: businessEvidence.business_state,
    revenueReady: businessEvidence.revenue_ready,
    affectedValueGate: businessEvidence.affected_value_gate,
    torghutConsumerEvidence: torghutConsumerEvidence.status,
    repairBidAdmission,
    fullStatusAvailable: false,
    producerRevision: servingPassport?.producer_revision ?? runtimeAdmission.runtimeKits[0]?.producer_revision ?? null,
    databaseWitnessRef: torghutConsumerEvidence.status.receipt_id,
  })
  const repairSlotEscrow = isRepairSlotEscrowEnabled()
    ? buildRepairSlotEscrow({
        now,
        namespace: namespaces[0] ?? 'agents',
        torghutConsumerEvidence: torghutConsumerEvidence.status,
        materialReentryClearinghouse: null,
        stageCreditLedger: null,
        evidencePressureLedger,
        mode: resolveRepairSlotEscrowMode(),
      })
    : null
  const controllerIngestionSettlement = buildControllerIngestionSettlement({
    now,
    namespace: namespaces[0] ?? 'agents',
    servingReadiness: ready ? status : 'down',
    controllerWitness: readyPathControllerWitness,
    agentRunIngestion: readyPathAgentRunIngestion,
    executionTrust: trust,
    database: readyPathDatabase,
    rolloutHealth: readyPathRolloutHealth,
    sourceServingContractVerdictExchange: readyPathSourceServingExchange,
    verifyTrustForeclosureBoard,
    repairSlotEscrow,
    torghutConsumerEvidence: torghutConsumerEvidence.status,
  })
  const materialEvidenceSettlementSpine = buildMaterialEvidenceSettlementSpine({
    now,
    namespace: namespaces[0] ?? 'agents',
    servingReadiness: ready ? status : 'down',
    executionTrust: trust,
    projectionWatermarks,
    readyTruthArbiter: null,
    stageCreditLedger: null,
    controllerIngestionSettlement,
    sourceServingContractVerdictExchange: readyPathSourceServingExchange,
    rolloutProofPassport: null,
    materialGateDigest,
    database: readyPathDatabase,
    rolloutHealth: readyPathRolloutHealth,
    workflows: null,
    terminalDebtCompactionLedger: null,
    torghutConsumerEvidence: torghutConsumerEvidence.status,
    repairBidAdmission,
  })

  const body = JSON.stringify({
    status,
    service: resolveRuntimeServiceName(),
    leaderElection,
    agentsController,
    orchestrationController,
    supportingController,
    execution_trust: trust,
    ...businessEvidence,
    torghut_consumer_evidence: torghutConsumerEvidence.status,
    repair_bid_admission: repairBidAdmission,
    revenue_repair_settlement_custody: revenueRepairSettlementCustody,
    controller_ingestion_settlement: controllerIngestionSettlement,
    verify_trust_foreclosure_board: verifyTrustForeclosureBoard,
    material_gate_digest: materialGateDigest,
    material_evidence_settlement_spine: materialEvidenceSettlementSpine,
    repair_slot_escrow: repairSlotEscrow,
    evidence_pressure_ledger: evidencePressureLedger,
    memory_provider: memoryProvider,
    runtime_kits: runtimeAdmission.runtimeKits,
    admission_passports: runtimeAdmission.admissionPassports,
    serving_passport_id: runtimeAdmission.servingPassportId,
    recovery_warrants: recoveryWarrants,
    runtime_proof_cells: runtimeProofCells,
    projection_watermarks: projectionWatermarks,
    serving_recovery_warrant_id: servingRecoveryWarrant?.recovery_warrant_id ?? null,
    serving_runtime_proof_cells_healthy: servingRuntimeProofCellsHealthy,
  })

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body).toString(),
  }

  return new Response(body, {
    status: ready ? 200 : 503,
    headers,
  })
}
