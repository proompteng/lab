import { createHash } from 'node:crypto'

import type {
  ActionSloBudgetActionClass,
  ControllerIngestionSettlement,
  DatabaseStatus,
  ExecutionTrustStatus,
  MaterialEvidenceRepairTicketClass,
  MaterialEvidenceSettlementDecision,
  MaterialEvidenceSettlementMode,
  MaterialEvidenceSettlementSpine,
  MaterialEvidenceToplineStatus,
  MaterialGateDigest,
  ProjectionWatermarkStatus,
  ReadyTruthArbiter,
  RepairBidAdmissionState,
  RolloutProofPassport,
  SourceServingContractVerdictExchange,
  StageCreditLedger,
  TerminalDebtCompactionLedger,
  TorghutConsumerEvidenceStatus,
  WorkflowsReliabilityStatus,
} from '~/server/control-plane-status-types'
import type { ControlPlaneRolloutHealth } from '~/server/control-plane-status-types'

export const MATERIAL_EVIDENCE_SETTLEMENT_DESIGN_ARTIFACT =
  'docs/agents/designs/206-jangar-material-evidence-settlement-spine-and-repair-dispatch-budget-2026-05-14.md'

export const MATERIAL_EVIDENCE_SETTLEMENT_TORGHUT_DESIGN_ARTIFACT =
  'docs/torghut/design-system/v6/212-torghut-revenue-repair-topline-contract-and-alpha-evidence-budget-2026-05-14.md'

const SCHEMA_VERSION = 'jangar.material-evidence-settlement-spine.v1' as const
const DEFAULT_TTL_SECONDS = 60
const ZERO_NOTIONAL_VALUES = new Set(['0', '0.0', '0.00', '0.0000'])
const READY_BUSINESS_STATES = new Set(['ready', 'revenue_ready', 'live_ready'])
const REPAIR_BUSINESS_STATES = new Set(['repair', 'repair_only', 'hold', 'blocked', 'degraded'])
const VALID_MODES = new Set<MaterialEvidenceSettlementMode>(['observe', 'shadow', 'enforce'])
const ROLLBACK_TARGET =
  'ignore material_evidence_settlement_spine consumers and keep ready truth, stage credit, controller-ingestion settlement, terminal debt, and Torghut max_notional=0 as authorities'

export type BuildMaterialEvidenceSettlementSpineInput = {
  now: Date
  namespace: string
  mode?: MaterialEvidenceSettlementMode
  servingReadiness: MaterialEvidenceSettlementSpine['serving_truth']['serving_readiness']
  executionTrust: ExecutionTrustStatus
  projectionWatermarks?: ProjectionWatermarkStatus[]
  readyTruthArbiter?: ReadyTruthArbiter | null
  stageCreditLedger?: StageCreditLedger | null
  controllerIngestionSettlement: ControllerIngestionSettlement
  sourceServingContractVerdictExchange: SourceServingContractVerdictExchange
  rolloutProofPassport?: RolloutProofPassport | null
  materialGateDigest: MaterialGateDigest
  database: DatabaseStatus
  rolloutHealth: ControlPlaneRolloutHealth
  workflows?: WorkflowsReliabilityStatus | null
  terminalDebtCompactionLedger?: TerminalDebtCompactionLedger | null
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
  repairBidAdmission: RepairBidAdmissionState
}

const hashJson = (value: unknown, length = 18) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const uniqueStrings = (values: Array<string | null | undefined>) => [...new Set(values.filter(Boolean) as string[])]

const normalizeReason = (value: string | null | undefined) =>
  value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_') ?? null

const parseTimestampMs = (value: string | null | undefined) => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

const isFresh = (value: string | null | undefined, now: Date) => {
  const parsed = parseTimestampMs(value)
  return Boolean(parsed && parsed > now.getTime())
}

const isZeroNotional = (value: string | null | undefined) => {
  if (!value) return false
  if (ZERO_NOTIONAL_VALUES.has(value)) return true
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed === 0
}

export const resolveMaterialEvidenceSettlementMode = (env: Record<string, string | undefined> = process.env) => {
  const mode = normalizeReason(env.JANGAR_MATERIAL_EVIDENCE_SETTLEMENT_MODE)
  return mode && VALID_MODES.has(mode as MaterialEvidenceSettlementMode)
    ? (mode as MaterialEvidenceSettlementMode)
    : 'observe'
}

const freshUntilFor = (input: BuildMaterialEvidenceSettlementSpineInput) => {
  const futureTimes = [
    input.torghutConsumerEvidence.fresh_until,
    input.readyTruthArbiter?.fresh_until,
    input.controllerIngestionSettlement.fresh_until,
    input.sourceServingContractVerdictExchange.fresh_until,
    input.rolloutProofPassport?.fresh_until,
    input.materialGateDigest.fresh_until,
    input.terminalDebtCompactionLedger?.fresh_until,
  ]
    .map((value) => parseTimestampMs(value))
    .filter((value): value is number => Boolean(value && value > input.now.getTime()))

  if (futureTimes.length > 0) return new Date(Math.min(...futureTimes)).toISOString()
  return new Date(input.now.getTime() + DEFAULT_TTL_SECONDS * 1000).toISOString()
}

const derivedBusinessState = (input: BuildMaterialEvidenceSettlementSpineInput) =>
  input.torghutConsumerEvidence.revenue_repair_business_state ??
  (input.torghutConsumerEvidence.revenue_repair_queue?.length ? 'repair_only' : null)

const derivedRevenueReady = (businessState: string | null, hasTopRepair: boolean) => {
  if (!businessState) return null
  if (READY_BUSINESS_STATES.has(businessState)) return true
  if (REPAIR_BUSINESS_STATES.has(businessState)) return false
  return hasTopRepair ? false : null
}

const routeableCandidateCount = (evidence: TorghutConsumerEvidenceStatus) =>
  evidence.accepted_routeable_candidate_count ??
  evidence.routeable_exchange_routeable_candidate_count ??
  evidence.repair_bid_settlement_routeable_candidate_count ??
  evidence.alpha_readiness_settlement_conveyor?.routeable_candidate_count_after ??
  evidence.alpha_readiness_settlement_conveyor?.routeable_candidate_count_before ??
  evidence.executable_alpha_repair_receipts?.routeable_candidate_count_before ??
  null

const dispatchRepairDecision = (digest: MaterialGateDigest) =>
  digest.action_class_decisions.find((decision) => decision.action_class === 'dispatch_repair') ?? null

const projectedWatermarks = (watermarks: ProjectionWatermarkStatus[] | undefined) =>
  Object.fromEntries(watermarks?.map((watermark) => [watermark.consumer_key, watermark.status]) ?? [])

const revenueRepairToplineStatus = (
  input: BuildMaterialEvidenceSettlementSpineInput,
): MaterialEvidenceToplineStatus => {
  if (input.torghutConsumerEvidence.status === 'stale') return 'stale'
  if (input.torghutConsumerEvidence.status === 'schema_mismatch') return 'schema_mismatch'
  if (input.torghutConsumerEvidence.status === 'missing') return 'missing'
  if (input.torghutConsumerEvidence.revenue_repair_queue?.[0]) return 'queue_head_inferred'
  if (
    input.torghutConsumerEvidence.status === 'unavailable' ||
    input.torghutConsumerEvidence.status === 'route_missing'
  ) {
    return 'unavailable'
  }
  if (
    input.torghutConsumerEvidence.revenue_repair_business_state ||
    input.torghutConsumerEvidence.revenue_repair_ready !== undefined
  ) {
    return 'summary_only'
  }
  return 'missing'
}

const transportReasons = (
  input: BuildMaterialEvidenceSettlementSpineInput,
  toplineStatus: MaterialEvidenceToplineStatus,
  businessState: string | null,
) =>
  uniqueStrings([
    input.torghutConsumerEvidence.status === 'current'
      ? null
      : `torghut_consumer_evidence_${input.torghutConsumerEvidence.status}`,
    input.torghutConsumerEvidence.status === 'current' && !isFresh(input.torghutConsumerEvidence.fresh_until, input.now)
      ? 'torghut_consumer_evidence_stale'
      : null,
    toplineStatus === 'queue_head_inferred' ? 'topline_inferred_from_queue_head' : null,
    toplineStatus === 'summary_only' && businessState && REPAIR_BUSINESS_STATES.has(businessState)
      ? 'revenue_repair_top_item_missing'
      : null,
    toplineStatus === 'missing' ? 'revenue_repair_topline_missing' : null,
    toplineStatus === 'stale' ? 'revenue_repair_topline_stale' : null,
    toplineStatus === 'unavailable' ? 'revenue_repair_transport_unavailable' : null,
    toplineStatus === 'schema_mismatch' ? 'revenue_repair_topline_schema_mismatch' : null,
    ...input.torghutConsumerEvidence.reason_codes,
  ]).map((reason) => normalizeReason(reason) ?? reason)

const businessReasons = (input: BuildMaterialEvidenceSettlementSpineInput, businessState: string | null) => {
  const topRepair = input.torghutConsumerEvidence.revenue_repair_queue?.[0] ?? null
  const revenueReady =
    input.torghutConsumerEvidence.revenue_repair_ready ?? derivedRevenueReady(businessState, Boolean(topRepair))
  const maxNotional = topRepair?.max_notional ?? input.torghutConsumerEvidence.max_notional
  return uniqueStrings([
    businessState ? null : 'business_state_missing',
    businessState && REPAIR_BUSINESS_STATES.has(businessState) ? `business_state_${businessState}` : null,
    revenueReady === false ? 'revenue_ready_false' : null,
    topRepair || !businessState || !REPAIR_BUSINESS_STATES.has(businessState)
      ? null
      : 'revenue_repair_top_item_missing',
    topRepair?.value_gate && topRepair.value_gate !== 'routeable_candidate_count'
      ? `top_repair_value_gate_${topRepair.value_gate}`
      : null,
    maxNotional && !isZeroNotional(maxNotional) ? 'capital_notional_nonzero' : null,
  ]).map((reason) => normalizeReason(reason) ?? reason)
}

const materialReasons = (input: BuildMaterialEvidenceSettlementSpineInput) => {
  const repairDecision = dispatchRepairDecision(input.materialGateDigest)
  return uniqueStrings([
    input.readyTruthArbiter && input.readyTruthArbiter.material_readiness !== 'allow'
      ? `ready_truth_${input.readyTruthArbiter.material_readiness}`
      : null,
    input.materialGateDigest.material_readiness !== 'allow'
      ? `material_gate_${input.materialGateDigest.material_readiness}`
      : null,
    input.controllerIngestionSettlement.decision !== 'allow'
      ? `controller_ingestion_${input.controllerIngestionSettlement.decision}`
      : null,
    input.sourceServingContractVerdictExchange.status !== 'allow'
      ? `source_serving_${input.sourceServingContractVerdictExchange.status}`
      : null,
    repairDecision && repairDecision.decision !== 'allow' ? `dispatch_repair_${repairDecision.decision}` : null,
    ...input.materialGateDigest.reason_codes,
    ...input.controllerIngestionSettlement.reason_codes,
  ]).map((reason) => normalizeReason(reason) ?? reason)
}

const platformReasons = (input: BuildMaterialEvidenceSettlementSpineInput) =>
  uniqueStrings([
    input.servingReadiness === 'ok' ? null : `serving_readiness_${input.servingReadiness}`,
    input.executionTrust.status === 'healthy' ? null : `execution_trust_${input.executionTrust.status}`,
    input.database.status === 'healthy' ? null : `database_${input.database.status}`,
    input.database.migration_consistency.status === 'healthy'
      ? null
      : `migration_consistency_${input.database.migration_consistency.status}`,
    input.rolloutHealth.status === 'healthy' ? null : `rollout_health_${input.rolloutHealth.status}`,
  ]).map((reason) => normalizeReason(reason) ?? reason)

const failureDebtReasons = (input: BuildMaterialEvidenceSettlementSpineInput) =>
  uniqueStrings([
    input.workflows && input.workflows.active_job_runs > 0 ? 'workflow_active_runs_present' : null,
    input.workflows && input.workflows.recent_failed_jobs > 0 ? 'workflow_recent_failures_present' : null,
    input.workflows && input.workflows.backoff_limit_exceeded_jobs > 0 ? 'workflow_backoff_limit_exceeded' : null,
    input.workflows && input.workflows.data_confidence !== 'high'
      ? `workflow_data_confidence_${input.workflows.data_confidence}`
      : null,
    input.terminalDebtCompactionLedger && input.terminalDebtCompactionLedger.active_debt_summary.count > 0
      ? 'terminal_active_debt_present'
      : null,
  ]).map((reason) => normalizeReason(reason) ?? reason)

const controllerRepairTicket = (
  settlement: ControllerIngestionSettlement,
): {
  ticketClass: MaterialEvidenceRepairTicketClass
  selectedTicketRef: string | null
  validationCommands: string[]
  reasonCodes: string[]
} | null => {
  if (settlement.decision !== 'repair_only' || settlement.selected_repair_ticket.ticket_class === 'none') return null
  return {
    ticketClass: settlement.selected_repair_ticket.ticket_class,
    selectedTicketRef: settlement.settlement_id,
    validationCommands: settlement.selected_repair_ticket.validation_commands,
    reasonCodes: settlement.selected_repair_ticket.reason_codes,
  }
}

const alphaRepairTicket = (input: BuildMaterialEvidenceSettlementSpineInput) => {
  const topRepair = input.torghutConsumerEvidence.revenue_repair_queue?.[0] ?? null
  const dispatchDecision = dispatchRepairDecision(input.materialGateDigest)
  if (!topRepair || dispatchDecision?.decision !== 'allow') return null
  const valueGate = topRepair.value_gate ?? input.materialGateDigest.alpha_closure_carry.selected_value_gate
  const maxNotional = topRepair.max_notional ?? input.materialGateDigest.alpha_closure_carry.max_notional
  if (valueGate !== 'routeable_candidate_count' || !isZeroNotional(maxNotional)) return null

  const ticket =
    input.repairBidAdmission.dispatch_tickets.find(
      (candidate) => candidate.target_value_gate === 'routeable_candidate_count' && candidate.max_notional === 0,
    ) ?? null

  return {
    ticketClass: 'alpha_readiness' as const,
    selectedTicketRef: ticket?.ticket_id ?? topRepair.code ?? dispatchDecision.action_class,
    validationCommands: uniqueStrings([
      ...dispatchDecision.validation_refs,
      "curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq '{business_state,revenue_ready,repair_queue}'",
    ]),
    reasonCodes: uniqueStrings([topRepair.reason, topRepair.value_gate, ...(dispatchDecision.reason_codes ?? [])]),
  }
}

const selectRepairBudget = (input: BuildMaterialEvidenceSettlementSpineInput) =>
  controllerRepairTicket(input.controllerIngestionSettlement) ?? alphaRepairTicket(input)

const settlementDecision = (
  input: BuildMaterialEvidenceSettlementSpineInput,
  reasonCodes: string[],
  selectedRepair: ReturnType<typeof selectRepairBudget>,
): MaterialEvidenceSettlementDecision => {
  if (
    reasonCodes.includes('capital_notional_nonzero') ||
    input.executionTrust.status === 'blocked' ||
    input.materialGateDigest.material_readiness === 'block'
  ) {
    return 'block'
  }
  if (selectedRepair) return 'repair_only'
  if (
    input.readyTruthArbiter?.material_readiness === 'allow' &&
    input.materialGateDigest.material_readiness === 'allow' &&
    input.controllerIngestionSettlement.decision === 'allow' &&
    input.sourceServingContractVerdictExchange.status === 'allow' &&
    input.torghutConsumerEvidence.status === 'current'
  ) {
    const businessState = derivedBusinessState(input)
    const revenueReady =
      input.torghutConsumerEvidence.revenue_repair_ready ??
      derivedRevenueReady(businessState, Boolean(input.torghutConsumerEvidence.revenue_repair_queue?.[0]))
    if (businessState && READY_BUSINESS_STATES.has(businessState) && revenueReady !== false) return 'allow'
  }
  return 'hold'
}

const evidenceRefs = (input: BuildMaterialEvidenceSettlementSpineInput) =>
  uniqueStrings([
    input.readyTruthArbiter?.verdict_id,
    input.controllerIngestionSettlement.settlement_id,
    input.sourceServingContractVerdictExchange.exchange_id,
    input.rolloutProofPassport?.passport_id,
    input.materialGateDigest.digest_id,
    input.stageCreditLedger?.ledger_id,
    input.terminalDebtCompactionLedger?.ledger_id,
    input.torghutConsumerEvidence.receipt_id,
    input.torghutConsumerEvidence.repair_bid_settlement_ledger_id,
    input.torghutConsumerEvidence.alpha_readiness_settlement_conveyor?.conveyor_id,
    input.torghutConsumerEvidence.alpha_repair_closure_board?.board_id,
    input.torghutConsumerEvidence.no_delta_repair_reentry_auction?.auction_id,
  ])

export const buildMaterialEvidenceSettlementSpine = (
  input: BuildMaterialEvidenceSettlementSpineInput,
): MaterialEvidenceSettlementSpine => {
  const businessState = derivedBusinessState(input)
  const topRepair = input.torghutConsumerEvidence.revenue_repair_queue?.[0] ?? null
  const revenueReady =
    input.torghutConsumerEvidence.revenue_repair_ready ?? derivedRevenueReady(businessState, Boolean(topRepair))
  const maxNotional =
    topRepair?.max_notional ??
    input.materialGateDigest.alpha_closure_carry.max_notional ??
    input.torghutConsumerEvidence.max_notional
  const toplineStatus = revenueRepairToplineStatus(input)
  const transportReasonCodes = transportReasons(input, toplineStatus, businessState)
  const failureReasonCodes = failureDebtReasons(input)
  const reasonCodes = uniqueStrings([
    ...transportReasonCodes,
    ...businessReasons(input, businessState),
    ...materialReasons(input),
    ...platformReasons(input),
    ...failureReasonCodes,
  ])
  const selectedRepair = selectRepairBudget(input)
  const decision = settlementDecision(input, reasonCodes, selectedRepair)
  const validationCommands = uniqueStrings([
    `curl -fsS 'http://agents.agents.svc.cluster.local/v1/control-plane/status?namespace=${input.namespace}' | jq '.material_evidence_settlement_spine'`,
    `curl -fsS ${input.torghutConsumerEvidence.endpoint || 'http://torghut.torghut.svc.cluster.local/trading/consumer-evidence'} | jq '{business_state,revenue_repair_queue,route_proven_profit_receipt}'`,
    ...input.materialGateDigest.action_class_decisions.flatMap((action) => action.validation_refs),
    ...(selectedRepair?.validationCommands ?? []),
  ])
  const repairBudgetReasonCodes =
    selectedRepair?.reasonCodes ??
    uniqueStrings([
      input.materialGateDigest.material_readiness !== 'allow'
        ? `material_gate_${input.materialGateDigest.material_readiness}`
        : null,
      dispatchRepairDecision(input.materialGateDigest)?.decision !== 'allow'
        ? `dispatch_repair_${dispatchRepairDecision(input.materialGateDigest)?.decision ?? 'missing'}`
        : null,
      ...transportReasonCodes,
    ])
  const settlementId = `material-evidence-settlement:${input.namespace}:${hashJson({
    decision,
    reason_codes: reasonCodes,
    consumer_ref: input.torghutConsumerEvidence.receipt_id,
    material_gate_ref: input.materialGateDigest.digest_id,
    controller_ingestion_ref: input.controllerIngestionSettlement.settlement_id,
    selected_ticket_ref: selectedRepair?.selectedTicketRef ?? null,
  })}`

  return {
    schema_version: SCHEMA_VERSION,
    settlement_id: settlementId,
    mode: input.mode ?? resolveMaterialEvidenceSettlementMode(),
    namespace: input.namespace,
    generated_at: input.now.toISOString(),
    fresh_until: freshUntilFor(input),
    governing_design_refs: [
      MATERIAL_EVIDENCE_SETTLEMENT_DESIGN_ARTIFACT,
      MATERIAL_EVIDENCE_SETTLEMENT_TORGHUT_DESIGN_ARTIFACT,
      'swarm-validation-contract:every-run-cites-governing-requirement',
    ],
    decision,
    serving_truth: {
      serving_readiness: input.servingReadiness,
      execution_trust_status: input.executionTrust.status,
      rollout_health: input.rolloutHealth.status,
      projection_watermark_statuses: projectedWatermarks(input.projectionWatermarks),
    },
    material_truth: {
      ready_truth_ref: input.readyTruthArbiter?.verdict_id ?? null,
      ready_truth_decision: input.readyTruthArbiter?.material_readiness ?? null,
      material_gate_ref: input.materialGateDigest.digest_id,
      material_gate_decision: input.materialGateDigest.material_readiness,
      controller_ingestion_settlement_ref: input.controllerIngestionSettlement.settlement_id,
      controller_ingestion_decision: input.controllerIngestionSettlement.decision,
      source_serving_verdict_ref: input.sourceServingContractVerdictExchange.exchange_id,
      source_serving_status: input.sourceServingContractVerdictExchange.status,
      stage_credit_ledger_ref: input.stageCreditLedger?.ledger_id ?? null,
      rollout_proof_passport_ref: input.rolloutProofPassport?.passport_id ?? null,
      dispatch_repair_decision: dispatchRepairDecision(input.materialGateDigest)?.decision ?? null,
    },
    transport_truth: {
      consumer_evidence_status: input.torghutConsumerEvidence.status,
      consumer_evidence_ref: input.torghutConsumerEvidence.receipt_id,
      consumer_evidence_endpoint: input.torghutConsumerEvidence.endpoint,
      revenue_repair_topline_status: toplineStatus,
      revenue_repair_topline_source: topRepair
        ? 'revenue_repair_queue_head'
        : input.torghutConsumerEvidence.revenue_repair_business_state
          ? 'torghut_consumer_evidence'
          : 'unavailable',
      revenue_repair_transport_reason_codes: transportReasonCodes,
    },
    business_truth: {
      business_state: businessState,
      revenue_ready: revenueReady,
      top_repair_queue_item: topRepair,
      selected_value_gate:
        topRepair?.value_gate ??
        input.materialGateDigest.alpha_closure_carry.selected_value_gate ??
        input.torghutConsumerEvidence.executable_alpha_repair_receipts?.target_value_gate ??
        null,
      required_output_receipt:
        topRepair?.required_output_receipt ??
        input.torghutConsumerEvidence.executable_alpha_repair_receipts?.selected_receipt
          ?.required_output_receipts?.[0] ??
        null,
      routeable_candidate_count: routeableCandidateCount(input.torghutConsumerEvidence),
      max_notional: maxNotional ?? null,
      capital_rule: topRepair?.capital_rule ?? input.materialGateDigest.alpha_closure_carry.capital_rule ?? null,
    },
    database_truth: {
      jangar_database_status: input.database.status,
      migration_consistency_status: input.database.migration_consistency.status,
      direct_sql_access: input.database.status === 'healthy' ? 'not_required_for_runtime' : 'unknown',
      torghut_schema_witness_ref: input.torghutConsumerEvidence.dataset_snapshot_ref,
    },
    failure_debt_truth: {
      active_job_runs: input.workflows?.active_job_runs ?? null,
      recent_failed_jobs: input.workflows?.recent_failed_jobs ?? null,
      backoff_limit_exceeded_jobs: input.workflows?.backoff_limit_exceeded_jobs ?? null,
      workflow_data_confidence: input.workflows?.data_confidence ?? null,
      terminal_active_debt_count: input.terminalDebtCompactionLedger?.active_debt_summary.count ?? null,
      terminal_retained_audit_count: input.terminalDebtCompactionLedger?.retained_audit_summary.count ?? null,
      reason_codes: failureReasonCodes,
    },
    repair_dispatch_budget: {
      action_class:
        selectedRepair && decision !== 'block' ? ('dispatch_repair' satisfies ActionSloBudgetActionClass) : null,
      ticket_class: selectedRepair?.ticketClass ?? 'none',
      selected_ticket_ref: selectedRepair?.selectedTicketRef ?? null,
      decision: decision === 'block' ? 'block' : selectedRepair ? 'repair_only' : 'hold',
      max_parallelism: selectedRepair && decision !== 'block' ? 1 : 0,
      max_runtime_seconds: selectedRepair && decision !== 'block' ? 1200 : null,
      max_notional: '0',
      validation_commands: selectedRepair && decision !== 'block' ? selectedRepair.validationCommands : [],
      reason_codes:
        decision === 'block' ? uniqueStrings(['material_settlement_block', ...reasonCodes]) : repairBudgetReasonCodes,
    },
    reason_codes: reasonCodes,
    evidence_refs: evidenceRefs(input),
    validation_commands: validationCommands,
    rollback_target: input.materialGateDigest.rollback_target || ROLLBACK_TARGET,
  }
}
