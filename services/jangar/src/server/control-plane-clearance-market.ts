import { createHash } from 'node:crypto'

import type {
  ActionSloBudgetActionClass,
  AdmissionPassportStatus,
  ClearanceMarketActionClearance,
  ClearanceMarketAuthoritySplit,
  ClearanceMarketDecision,
  ClearanceMarketFailureDebt,
  ClearanceMarketLedger,
  ClearanceMarketRepairLot,
  ClearanceMarketRolloutTruthSettlement,
  ClearanceMarketStageAdmission,
  ControlPlaneControllerWitnessQuorum,
  ExecutionTrustStatus,
  MaterialActionVerdictDecision,
  MaterialActionVerdictEpoch,
  RepairWarrantRecord,
  RepairWarrantRiskTier,
  SourceRolloutTruthExchange,
  StageClearancePacket,
  TorghutConsumerEvidenceStatus,
  WorkflowsReliabilityStatus,
} from '~/data/agents-control-plane'
import type {
  AgentRunIngestionStatus,
  ControlPlaneRolloutHealth,
  DatabaseStatus,
} from '~/server/control-plane-status-types'

export const CLEARANCE_MARKET_DESIGN_ARTIFACT =
  'docs/agents/designs/185-jangar-clearance-market-and-rollout-truth-settlement-2026-05-12.md'

const CLEARANCE_MARKET_SCHEMA_VERSION = 'jangar.clearance-market.v1' as const
const CLEARANCE_MARKET_PRODUCER_REVISION = '2026-05-12-clearance-market-shadow-v1'
const LEDGER_TTL_SECONDS = 120
const DEFAULT_ROLLBACK_TARGET = 'JANGAR_CLEARANCE_MARKET_ENABLED=false'

const GOVERNING_DESIGN_REFS = [
  CLEARANCE_MARKET_DESIGN_ARTIFACT,
  'docs/agents/designs/184-jangar-stage-clearance-packets-and-freeze-aware-launch-governor-2026-05-12.md',
  'docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md',
  'services/jangar/README.md',
]

const ACTION_CLASSES: ActionSloBudgetActionClass[] = [
  'serve_readonly',
  'dispatch_repair',
  'dispatch_normal',
  'deploy_widen',
  'merge_ready',
  'torghut_observe',
  'paper_canary',
  'live_micro_canary',
  'live_scale',
]

export const isClearanceMarketEnabled = (env: NodeJS.ProcessEnv = process.env) => {
  const normalized = env.JANGAR_CLEARANCE_MARKET_ENABLED?.trim().toLowerCase()
  return !(normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no')
}

export type ClearanceMarketInput = {
  now: Date
  namespace: string
  database: DatabaseStatus
  agentRunIngestion: AgentRunIngestionStatus
  rolloutHealth: ControlPlaneRolloutHealth
  workflows: WorkflowsReliabilityStatus
  executionTrust: ExecutionTrustStatus
  admissionPassports: AdmissionPassportStatus[]
  controllerWitness: ControlPlaneControllerWitnessQuorum
  sourceRolloutTruthExchange: SourceRolloutTruthExchange
  materialActionVerdictEpoch: MaterialActionVerdictEpoch
  stageClearancePackets: StageClearancePacket[]
  repairWarrants: RepairWarrantRecord[]
  repairScheduleDebt: {
    open_error_count: number
    superseded_error_count: number
    success_count: number
    running_count: number
    window_minutes: number
    firebreak_state: 'clear' | 'observe_only'
    collection_errors: string[]
  }
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
}

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const addSeconds = (value: Date, seconds: number) => new Date(value.getTime() + seconds * 1000)

const uniqueStrings = (values: Array<string | null | undefined>) => [
  ...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0))),
]

const normalizeReason = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')

const normalizeReasons = (values: Array<string | null | undefined>) => uniqueStrings(values).map(normalizeReason)

const decisionRank = (decision: ClearanceMarketDecision) => {
  if (decision === 'block') return 4
  if (decision === 'hold') return 3
  if (decision === 'repair_only') return 2
  return 1
}

const strictestDecision = (decisions: ClearanceMarketDecision[]): ClearanceMarketDecision => {
  let strictest: ClearanceMarketDecision = 'allow'
  for (const decision of decisions) {
    if (decisionRank(decision) > decisionRank(strictest)) {
      strictest = decision
    }
  }
  return strictest
}

const materialDecision = (decision: MaterialActionVerdictDecision | undefined): ClearanceMarketDecision => {
  if (decision === 'allow') return 'allow'
  if (decision === 'repair_only') return 'repair_only'
  if (decision === 'block' || decision === 'contradicted') return 'block'
  return 'hold'
}

const numericNotional = (value: string | null | undefined) => {
  if (!value) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const deploymentRef = (name: string, namespace: string) => `deployment:${namespace}/${name}`

const runtimePassportRef = (passport: AdmissionPassportStatus) =>
  `admission-passport:${passport.consumer_class}:${passport.admission_passport_id}`

const freshnessRef = (input: ClearanceMarketInput) =>
  `execution-trust:${input.executionTrust.status}:${hashJson(input.executionTrust.blocking_windows, 8)}`

const databaseProjectionMode = (database: DatabaseStatus) => {
  if (!database.connected) return 'unavailable' as const
  if (database.status === 'healthy') return 'status_projection' as const
  return 'route_database_projection' as const
}

const valueGateForRepair = (warrant: Pick<RepairWarrantRecord, 'repair_dimension' | 'repair_code'>) => {
  if (warrant.repair_dimension === 'market_context' || warrant.repair_dimension.startsWith('quant_')) {
    return 'failed_agentrun_rate' as const
  }
  if (warrant.repair_code.includes('rollout')) return 'pr_to_rollout_latency' as const
  if (warrant.repair_dimension === 'consumer_evidence') return 'ready_status_truth' as const
  return 'manual_intervention_count' as const
}

const riskPenalty = (riskTier: RepairWarrantRiskTier) => {
  if (riskTier === 'critical') return 40
  if (riskTier === 'high') return 25
  if (riskTier === 'medium') return 10
  return 0
}

const buildRepairLots = (input: ClearanceMarketInput): ClearanceMarketRepairLot[] =>
  input.repairWarrants
    .map((warrant) => {
      const score = Math.max(0, warrant.expected_unblock_value * 10 + 20 - riskPenalty(warrant.risk_tier))
      return {
        lot_id: `clearance-repair-lot:${hashJson([warrant.warrant_id, warrant.repair_code], 12)}`,
        warrant_id: warrant.warrant_id,
        value_gate: valueGateForRepair(warrant),
        failure_mode: warrant.repair_dimension,
        action_class: warrant.action_class,
        decision: warrant.admission_state === 'admitted' ? 'repair_only' : 'hold',
        score,
        expected_unblock_value: warrant.expected_unblock_value,
        max_dispatches: warrant.max_dispatches,
        max_runtime_seconds: warrant.max_runtime_seconds,
        max_notional: warrant.max_notional,
        reason_codes: normalizeReasons(warrant.reason_codes),
        evidence_refs: uniqueStrings([warrant.warrant_id, ...warrant.evidence_refs]),
        rollback_target: warrant.rollback_target,
      } satisfies ClearanceMarketRepairLot
    })
    .sort((left, right) => right.score - left.score || left.lot_id.localeCompare(right.lot_id))

const buildRolloutTruthSettlement = (input: ClearanceMarketInput): ClearanceMarketRolloutTruthSettlement => {
  const degradedDeployments = input.rolloutHealth.deployments.filter((deployment) => deployment.status !== 'healthy')
  const sourceSummary = input.sourceRolloutTruthExchange.deployer_summary
  const blockers = normalizeReasons([
    ...sourceSummary.held_action_classes.map((actionClass) => `source_rollout_truth_holds:${actionClass}`),
    ...degradedDeployments.map((deployment) => `deployment_${deployment.name}_${deployment.status}`),
    ...(input.database.status !== 'healthy' ? [`database_${input.database.status}`] : []),
    ...input.torghutConsumerEvidence.reason_codes,
  ])
  const decision = blockers.length > 0 ? 'hold' : 'allow'

  return {
    settlement_id: `clearance-rollout-settlement:${hashJson([
      input.sourceRolloutTruthExchange.exchange_id,
      input.rolloutHealth.deployments,
      blockers,
    ])}`,
    source_head_sha: input.sourceRolloutTruthExchange.source_head_sha,
    gitops_revision: input.sourceRolloutTruthExchange.gitops_revision,
    desired_image_refs: input.sourceRolloutTruthExchange.desired_images.map((image) => image.evidence_ref),
    live_image_refs: input.sourceRolloutTruthExchange.live_images.map((image) => image.evidence_ref),
    deployment_availability: input.rolloutHealth.deployments.map((deployment) => ({
      name: deployment.name,
      namespace: deployment.namespace,
      status: deployment.status,
      desired_replicas: deployment.desired_replicas,
      available_replicas: deployment.available_replicas,
    })),
    route_health: input.sourceRolloutTruthExchange.route_statuses,
    database_projection: {
      mode: databaseProjectionMode(input.database),
      status: input.database.status,
      evidence_ref: input.sourceRolloutTruthExchange.database_projection_ref,
    },
    downstream_evidence_refs: uniqueStrings([
      input.sourceRolloutTruthExchange.torghut_proof_floor.proof_floor_ref,
      input.torghutConsumerEvidence.receipt_id,
      input.torghutConsumerEvidence.profit_repair_settlement_ledger_id,
      input.torghutConsumerEvidence.routeability_repair_acceptance_ledger_id,
    ]),
    pr_to_rollout_latency_seconds: null,
    decision,
    blockers,
  }
}

const buildAuthoritySplits = (
  input: ClearanceMarketInput,
  rolloutTruth: ClearanceMarketRolloutTruthSettlement,
): ClearanceMarketAuthoritySplit[] => {
  const splits: ClearanceMarketAuthoritySplit[] = []
  const agentsApi = input.rolloutHealth.deployments.find((deployment) => deployment.name === 'agents')
  const agentsControllers = input.rolloutHealth.deployments.find(
    (deployment) => deployment.name === 'agents-controllers',
  )
  if (agentsApi && agentsControllers && agentsApi.status !== 'healthy' && agentsControllers.status === 'healthy') {
    splits.push({
      split_id: `clearance-split:${hashJson(['agents-api-rollout', agentsApi, agentsControllers], 12)}`,
      domain: 'rollout',
      primary_ref: deploymentRef(agentsApi.name, agentsApi.namespace),
      secondary_ref: deploymentRef(agentsControllers.name, agentsControllers.namespace),
      decision: 'hold',
      reason_codes: [`agents_api_${agentsApi.status}`, 'agents_controllers_available'],
      message: 'agents API rollout is not healthy while agents-controllers is available',
      evidence_refs: [rolloutTruth.settlement_id],
    })
  }

  if (input.controllerWitness.controller_self_report_current && input.agentRunIngestion.status !== 'healthy') {
    splits.push({
      split_id: `clearance-split:${hashJson(['agentrun-ingestion', input.agentRunIngestion], 12)}`,
      domain: 'controller',
      primary_ref: input.controllerWitness.quorum_id,
      secondary_ref: `agentrun-ingestion:${input.namespace}:${input.agentRunIngestion.status}`,
      decision: 'hold',
      reason_codes: [`agentrun_ingestion_${input.agentRunIngestion.status}`],
      message: input.agentRunIngestion.message,
      evidence_refs: [input.controllerWitness.quorum_id],
    })
  }

  const allowedLaunchPassports = input.admissionPassports.filter(
    (passport) => passport.decision === 'allow' && passport.consumer_class.startsWith('swarm_'),
  )
  if (input.executionTrust.status !== 'healthy' && allowedLaunchPassports.length > 0) {
    splits.push({
      split_id: `clearance-split:${hashJson(['runtime-passports', input.executionTrust, allowedLaunchPassports], 12)}`,
      domain: 'runtime_admission',
      primary_ref: freshnessRef(input),
      secondary_ref: allowedLaunchPassports.map(runtimePassportRef).join(','),
      decision: 'hold',
      reason_codes: [`execution_trust_${input.executionTrust.status}`, 'runtime_passport_allow_split'],
      message: 'launch-capable runtime passports are allowed while execution trust is not healthy',
      evidence_refs: allowedLaunchPassports.map(runtimePassportRef),
    })
  }

  const torghutNotional = numericNotional(input.torghutConsumerEvidence.max_notional)
  const torghutRepairOnly =
    torghutNotional <= 0 &&
    (input.torghutConsumerEvidence.decision === 'repair' ||
      input.torghutConsumerEvidence.reason_codes.length > 0 ||
      input.torghutConsumerEvidence.status === 'stale')
  if (torghutRepairOnly) {
    splits.push({
      split_id: `clearance-split:${hashJson(['torghut-zero-notional', input.torghutConsumerEvidence], 12)}`,
      domain: 'torghut',
      primary_ref: input.torghutConsumerEvidence.receipt_id ?? 'torghut-consumer-evidence:missing',
      secondary_ref: input.torghutConsumerEvidence.profit_freshness_frontier_id ?? null,
      decision: 'repair_only',
      reason_codes: normalizeReasons([
        'torghut_zero_notional_repair_only',
        ...input.torghutConsumerEvidence.reason_codes,
      ]),
      message: input.torghutConsumerEvidence.message,
      evidence_refs: uniqueStrings([
        input.torghutConsumerEvidence.receipt_id,
        input.torghutConsumerEvidence.profit_freshness_frontier_id,
      ]),
    })
  }

  const staleQuantReasons = input.torghutConsumerEvidence.reason_codes.filter((reason) => {
    const normalized = normalizeReason(reason)
    return normalized.includes('quant') || normalized.includes('ingestion') || normalized.includes('materialization')
  })
  if (staleQuantReasons.length > 0) {
    splits.push({
      split_id: `clearance-split:${hashJson(['torghut-quant', staleQuantReasons], 12)}`,
      domain: 'torghut',
      primary_ref: input.torghutConsumerEvidence.receipt_id ?? 'torghut-consumer-evidence:missing',
      secondary_ref: input.torghutConsumerEvidence.dataset_snapshot_ref,
      decision: 'hold',
      reason_codes: normalizeReasons(staleQuantReasons),
      message: 'Torghut quant ingestion or materialization evidence is stale',
      evidence_refs: uniqueStrings([
        input.torghutConsumerEvidence.receipt_id,
        input.torghutConsumerEvidence.dataset_snapshot_ref,
      ]),
    })
  }

  return splits
}

const buildFailureDebt = (input: ClearanceMarketInput): ClearanceMarketFailureDebt[] => {
  const activeFailed = input.workflows.recent_failed_jobs
  const activeBackoff = input.workflows.backoff_limit_exceeded_jobs
  const repairDebt = input.repairScheduleDebt
  const sixHourFailures = repairDebt.open_error_count + repairDebt.superseded_error_count
  let sixHourState: ClearanceMarketFailureDebt['state'] = 'clear'
  if (repairDebt.collection_errors.length > 0) {
    sixHourState = 'projection_limited'
  } else if (sixHourFailures > 0 || repairDebt.running_count > 0) {
    sixHourState = 'active'
  }

  return [
    {
      debt_id: `clearance-failure-debt:15m:${hashJson(input.workflows, 8)}`,
      window: '15m',
      state: activeFailed > 0 || activeBackoff > 0 ? 'active' : 'clear',
      failed_count: activeFailed,
      backoff_count: activeBackoff,
      running_count: input.workflows.active_job_runs,
      data_confidence: input.workflows.data_confidence,
      reason_codes: normalizeReasons([
        ...(activeFailed > 0 ? ['workflow_recent_failed_jobs'] : []),
        ...(activeBackoff > 0 ? ['workflow_backoff_limit_exceeded_jobs'] : []),
        ...(input.workflows.collection_errors > 0 ? ['workflow_collection_errors'] : []),
      ]),
      evidence_refs: [`workflows:${input.namespace}:${input.workflows.window_minutes}m`],
    },
    {
      debt_id: `clearance-failure-debt:6h:${hashJson(repairDebt, 8)}`,
      window: '6h',
      state: sixHourState,
      failed_count: sixHourFailures,
      backoff_count: repairDebt.open_error_count,
      running_count: repairDebt.running_count,
      data_confidence: repairDebt.collection_errors.length > 0 ? 'low' : 'medium',
      reason_codes: normalizeReasons([
        ...(repairDebt.firebreak_state !== 'clear' ? [`schedule_debt_${repairDebt.firebreak_state}`] : []),
        ...repairDebt.collection_errors,
      ]),
      evidence_refs: [`repair-schedule-debt:${repairDebt.window_minutes}m`],
    },
    {
      debt_id: `clearance-failure-debt:7d:${hashJson([input.namespace, CLEARANCE_MARKET_PRODUCER_REVISION], 8)}`,
      window: '7d',
      state: 'projection_limited',
      failed_count: null,
      backoff_count: null,
      running_count: null,
      data_confidence: 'low',
      reason_codes: ['retained_failure_7d_projection_not_collected'],
      evidence_refs: ['agents_control_plane.resources_current:retained:7d'],
    },
  ]
}

const extraActionReasons = (input: ClearanceMarketInput, actionClass: ActionSloBudgetActionClass) => {
  const reasons: string[] = []
  if (
    input.executionTrust.status !== 'healthy' &&
    (actionClass === 'dispatch_normal' || actionClass === 'merge_ready')
  ) {
    reasons.push(`execution_trust_${input.executionTrust.status}`)
  }
  if (input.rolloutHealth.status !== 'healthy' && (actionClass === 'deploy_widen' || actionClass === 'merge_ready')) {
    reasons.push(`rollout_${input.rolloutHealth.status}`)
  }
  if (
    (actionClass === 'dispatch_normal' || actionClass === 'paper_canary') &&
    input.torghutConsumerEvidence.reason_codes.some((reason) => normalizeReason(reason).includes('quant'))
  ) {
    reasons.push('torghut_quant_evidence_stale')
  }
  return reasons
}

const selectedRepairLotForAction = (
  repairLots: ClearanceMarketRepairLot[],
  actionClass: ActionSloBudgetActionClass,
): ClearanceMarketRepairLot | undefined =>
  repairLots.find((lot) => lot.action_class === actionClass && lot.decision === 'repair_only') ??
  repairLots.find((lot) => lot.decision === 'repair_only')

const buildActionClearance = (
  input: ClearanceMarketInput,
  repairLots: ClearanceMarketRepairLot[],
  rolloutTruth: ClearanceMarketRolloutTruthSettlement,
): ClearanceMarketActionClearance[] =>
  ACTION_CLASSES.map((actionClass) => {
    const verdict = input.materialActionVerdictEpoch.final_verdicts.find((item) => item.action_class === actionClass)
    const selectedRepairLot = selectedRepairLotForAction(repairLots, actionClass)
    const reasons = normalizeReasons([
      ...(!verdict ? [`material_action_verdict_missing:${actionClass}`] : []),
      ...(verdict?.blocking_reason_codes ?? []),
      ...(verdict?.downgrade_reason_codes ?? []),
      ...extraActionReasons(input, actionClass),
    ])
    let decision = materialDecision(verdict?.decision)
    if (
      actionClass === 'dispatch_repair' &&
      selectedRepairLot &&
      numericNotional(input.torghutConsumerEvidence.max_notional) <= 0
    ) {
      decision = 'repair_only'
    }
    if (actionClass === 'dispatch_normal' && input.executionTrust.status !== 'healthy') {
      decision = strictestDecision([decision, 'hold'])
    }
    if (
      actionClass === 'merge_ready' &&
      (input.executionTrust.status !== 'healthy' || rolloutTruth.decision !== 'allow')
    ) {
      decision = strictestDecision([decision, 'hold'])
    }
    if (actionClass === 'deploy_widen' && rolloutTruth.decision !== 'allow') {
      decision = strictestDecision([decision, 'hold'])
    }

    return {
      clearance_id: `clearance-action:${actionClass}:${hashJson([verdict?.verdict_id, reasons, decision], 10)}`,
      action_class: actionClass,
      decision,
      max_dispatches: verdict?.max_dispatches ?? null,
      max_runtime_seconds: verdict?.max_runtime_seconds ?? null,
      max_notional: verdict?.max_notional ?? null,
      reason_codes: reasons,
      required_repair_actions: uniqueStrings([
        ...(verdict?.required_repair_actions ?? []),
        ...(selectedRepairLot ? [`execute repair lot ${selectedRepairLot.lot_id}`] : []),
      ]),
      governing_design_refs: GOVERNING_DESIGN_REFS,
      evidence_refs: uniqueStrings([
        input.materialActionVerdictEpoch.epoch_id,
        verdict?.verdict_id,
        input.sourceRolloutTruthExchange.exchange_id,
        input.controllerWitness.quorum_id,
        rolloutTruth.settlement_id,
        selectedRepairLot?.lot_id,
      ]),
      rollback_target: verdict?.rollback_target ?? DEFAULT_ROLLBACK_TARGET,
    }
  })

const buildStageAdmission = (
  input: ClearanceMarketInput,
  actionClearance: ClearanceMarketActionClearance[],
  repairLots: ClearanceMarketRepairLot[],
): ClearanceMarketStageAdmission[] =>
  input.stageClearancePackets.map((packet) => {
    const matchingAction = actionClearance.find((action) => action.action_class === packet.action_class)
    const selectedLot = selectedRepairLotForAction(repairLots, packet.action_class)
    const decision = strictestDecision([packet.decision, matchingAction?.decision ?? 'hold'])
    return {
      admission_id: `clearance-stage:${packet.stage}:${packet.action_class}:${hashJson([packet.packet_id, decision], 10)}`,
      stage: packet.stage,
      action_class: packet.action_class,
      decision,
      packet_ref: packet.packet_id,
      selected_repair_lot_ref: selectedLot?.lot_id ?? null,
      reason_codes: normalizeReasons([...(packet.reason_codes ?? []), ...(matchingAction?.reason_codes ?? [])]),
      evidence_refs: uniqueStrings([packet.packet_id, ...(matchingAction?.evidence_refs ?? [])]),
    }
  })

const buildHandoffStatus = (actionClearance: ClearanceMarketActionClearance[]): ClearanceMarketDecision =>
  strictestDecision(
    actionClearance
      .filter((action) => action.action_class === 'deploy_widen' || action.action_class === 'merge_ready')
      .map((action) => action.decision),
  )

export const buildClearanceMarketLedger = (input: ClearanceMarketInput): ClearanceMarketLedger => {
  const freshUntil = addSeconds(input.now, LEDGER_TTL_SECONDS).toISOString()
  const repairLots = buildRepairLots(input)
  const rolloutTruth = buildRolloutTruthSettlement(input)
  const authoritySplits = buildAuthoritySplits(input, rolloutTruth)
  const retainedFailureDebt = buildFailureDebt(input)
  const actionClearance = buildActionClearance(input, repairLots, rolloutTruth)
  const stageAdmission = buildStageAdmission(input, actionClearance, repairLots)
  const handoffStatus = buildHandoffStatus(actionClearance)
  const ledgerDigest = hashJson({
    authoritySplits,
    retainedFailureDebt,
    rolloutTruth,
    actionClearance,
    stageAdmission,
  })

  return {
    schema_version: CLEARANCE_MARKET_SCHEMA_VERSION,
    ledger_id: `clearance-market:${input.namespace}:${ledgerDigest}`,
    namespace: input.namespace,
    generated_at: input.now.toISOString(),
    fresh_until: freshUntil,
    governing_design_refs: GOVERNING_DESIGN_REFS,
    observed_revision: {
      source_head_sha: input.sourceRolloutTruthExchange.source_head_sha,
      gitops_revision: input.sourceRolloutTruthExchange.gitops_revision,
    },
    evidence_mode: 'shadow',
    authority_splits: authoritySplits,
    retained_failure_debt: retainedFailureDebt,
    rollout_truth_settlement: rolloutTruth,
    action_clearance: actionClearance,
    repair_lots: repairLots,
    stage_admission: stageAdmission,
    handoff_contract: {
      value_gates: [
        'ready_status_truth',
        'failed_agentrun_rate',
        'pr_to_rollout_latency',
        'manual_intervention_count',
        'handoff_evidence_quality',
      ],
      rollback_target: DEFAULT_ROLLBACK_TARGET,
      status: handoffStatus,
    },
  }
}
