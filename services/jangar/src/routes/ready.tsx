import { createFileRoute } from '@tanstack/react-router'
import {
  type AgentsControllerHealthSnapshot,
  buildAgentsDependencySummary,
  getAgentsControlPlaneStatusSnapshot,
  isControllerHealthReady,
  getAgentsReadySnapshot,
  uniqueStrings,
} from '@proompteng/agent-contracts/agents-ready'
import { findAdmissionPassport } from '@proompteng/agent-contracts/runtime-admission'

import type {
  ControlPlaneControllerWitnessQuorum,
  ExecutionTrustStatus,
  SourceServingContractVerdictExchange,
  TorghutRevenueRepairQueueItem,
} from '~/server/control-plane-status-types'
import { resolveRuntimeServiceName } from '~/server/runtime-identity'
import { buildControllerIngestionSettlement } from '~/server/control-plane-controller-ingestion-settlement'
import {
  buildEvidencePressureLedger,
  isEvidencePressureLedgerEnabled,
  type EvidencePressureControllerReadiness,
} from '~/server/control-plane-evidence-pressure-ledger'
import { buildRepairBidAdmissionState } from '~/server/control-plane-repair-bid-admission'
import { getGithubReviewIngestPressureSummary } from '~/server/github-review-ingest'
import { getMemoryProviderHealth } from '~/server/memory-provider-health'
import { getMetricsSinkPressureSummary } from '~/server/metrics'
import { buildExecutionTrust } from '~/server/control-plane-execution-trust'
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
import { buildVerifyTrustForeclosureBoard } from '~/server/control-plane-verify-trust-foreclosure'
import { buildMaterialEvidenceSettlementSpine } from '~/server/control-plane-material-evidence-settlement'

const buildReadyControllerReadiness = (
  name: string,
  health: AgentsControllerHealthSnapshot,
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
  rollback_target: 'use /v1/control-plane/status for full source-serving rollout proof',
})

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
  const agentsReady = await getAgentsReadySnapshot()
  const leaderElection = agentsReady.leaderElection
  const agentsController = agentsReady.agentsController
  const orchestrationController = agentsReady.orchestrationController
  const supportingController = agentsReady.supportingController
  const namespaces = agentsReady.namespaces.length ? agentsReady.namespaces : ['agents']
  const primaryNamespace = namespaces[0] ?? 'agents'
  const agentsControlPlaneStatus = await getAgentsControlPlaneStatusSnapshot(primaryNamespace)
  const agentsStatus = agentsControlPlaneStatus.status
  const trust = await executionTrustStatus(namespaces)
  const torghutConsumerEvidence = await resolveTorghutConsumerEvidence(now)
  const repairBidAdmission = buildRepairBidAdmissionState({
    now,
    namespace: primaryNamespace,
    repository: process.env.CODEX_REPOSITORY ?? process.env.CODEX_REPO_SLUG,
    branch: process.env.CODEX_BRANCH,
    swarmName: process.env.SWARM_NAME,
    stage: process.env.SWARM_STAGE ?? process.env.CODEX_STAGE,
    torghutConsumerEvidence: torghutConsumerEvidence.status,
  })
  const businessEvidence = buildBusinessEvidence(torghutConsumerEvidence.status, repairBidAdmission)
  const memoryProvider = getMemoryProviderHealth()
  const runtimeAdmission = {
    runtimeKits: agentsStatus.runtime_kits,
    admissionPassports: agentsStatus.admission_passports,
    servingPassportId: agentsStatus.serving_passport_id,
    recoveryWarrants: agentsStatus.recovery_warrants,
    runtimeProofCells: agentsStatus.runtime_proof_cells,
    projectionWatermarks: agentsStatus.projection_watermarks,
  }
  const evidencePressureLedger = isEvidencePressureLedgerEnabled()
    ? buildEvidencePressureLedger({
        now,
        namespace: primaryNamespace,
        watchReliability: agentsStatus.watch_reliability,
        controllerWitness: agentsStatus.control_plane_controller_witness as ControlPlaneControllerWitnessQuorum,
        controllerReadiness: [
          buildReadyControllerReadiness('agents-controller', agentsController),
          buildReadyControllerReadiness('orchestration-controller', orchestrationController),
          buildReadyControllerReadiness('supporting-controller', supportingController),
        ],
        rolloutHealth: agentsStatus.rollout_health,
        database: agentsStatus.database,
        metricsSink: getMetricsSinkPressureSummary(),
        githubIngest: getGithubReviewIngestPressureSummary(),
        torghutConsumerEvidence: torghutConsumerEvidence.status,
      })
    : null
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
  const agentsControllerHealthy = agentsReady.agentRunIngestion.every((status) => status.status !== 'degraded')
  const servingPassportReady =
    servingPassport !== undefined && servingPassport.decision !== 'block' && servingPassport.decision !== 'hold'
  const memoryProviderReady = memoryProvider.status !== 'blocked'
  const agentsDependency = buildAgentsDependencySummary({
    agentsReady,
    agentsControlPlaneStatus,
    controllersOk,
    agentsControllerHealthy,
  })
  const ready = memoryProviderReady
  const status = ready && servingPassportReady && agentsDependency.status === 'healthy' ? 'ok' : 'degraded'
  const readyPathRolloutHealth = agentsStatus.rollout_health
  const readyPathSourceServingExchange = buildReadyPathSourceServingExchange(now, primaryNamespace)
  const readyPathAgentRunIngestion = agentsStatus.agentrun_ingestion
  const readyPathControllerWitness =
    agentsStatus.control_plane_controller_witness as ControlPlaneControllerWitnessQuorum
  const readyPathDatabase = agentsStatus.database
  const revenueRepairSettlementCustody = buildRevenueRepairSettlementCustody(
    {
      now,
      namespace: primaryNamespace,
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
      namespace: primaryNamespace,
      executionTrust: trust,
      sourceServingContractVerdictExchange: readyPathSourceServingExchange,
      torghutConsumerEvidence: torghutConsumerEvidence.status,
      revenueRepairSettlementCustody,
      rolloutHealth: readyPathRolloutHealth,
      controllerWitness: readyPathControllerWitness,
      database: readyPathDatabase,
      serviceHealth: ready ? status : 'down',
    },
    'observe',
  )
  const materialGateDigest = buildMaterialGateDigest({
    now,
    namespace: primaryNamespace,
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
        namespace: primaryNamespace,
        torghutConsumerEvidence: torghutConsumerEvidence.status,
        materialReentryClearinghouse: null,
        stageCreditLedger: null,
        evidencePressureLedger,
        mode: resolveRepairSlotEscrowMode(),
      })
    : null
  const controllerIngestionSettlement = buildControllerIngestionSettlement({
    now,
    namespace: primaryNamespace,
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
    namespace: primaryNamespace,
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
    agents_control_plane_status: {
      available: agentsControlPlaneStatus.available,
      http_status: agentsControlPlaneStatus.httpStatus,
      error: agentsControlPlaneStatus.error,
    },
    agents_dependency: agentsDependency,
    watch_reliability: agentsStatus.watch_reliability,
    agentrun_ingestion: readyPathAgentRunIngestion,
    control_plane_controller_witness: readyPathControllerWitness,
    database: readyPathDatabase,
    rollout_health: readyPathRolloutHealth,
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
