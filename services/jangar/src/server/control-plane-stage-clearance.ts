import { createHash } from 'node:crypto'

import type {
  ActionSloBudgetActionClass,
  ControlPlaneControllerWitnessQuorum,
  DependencyVerdictExchange,
  ExecutionTrustStage,
  ExecutionTrustStatus,
  ExecutionTrustSwarm,
  FailureDomainActionClass,
  FailureDomainLeaseSet,
  MaterialActionVerdict,
  MaterialActionVerdictEpoch,
  RouteStabilityEscrow,
  SourceRolloutTruthExchange,
  StageClearanceDecision,
  StageClearancePacket,
  StageClearanceStage,
  WorkflowsReliabilityStatus,
} from '~/data/agents-control-plane'
import { dependencyVerdictForActionSloClass } from '~/server/control-plane-dependency-verdict'
import type { TorghutConsumerEvidenceStatus } from '~/server/control-plane-torghut-consumer-evidence'

export const STAGE_CLEARANCE_DESIGN_ARTIFACT =
  'docs/agents/designs/184-jangar-stage-clearance-packets-and-freeze-aware-launch-governor-2026-05-12.md'

const STAGE_CLEARANCE_SCHEMA_VERSION = 'jangar.stage-clearance-packet.v1' as const
const PRODUCER_REVISION = '2026-05-12-stage-clearance-shadow-v1'
const DEFAULT_SWARM_NAME = 'jangar-control-plane'
const PACKET_TTL_SECONDS = 120

const GOVERNING_REQUIREMENT_REFS = [
  STAGE_CLEARANCE_DESIGN_ARTIFACT,
  'docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md',
  'docs/agents/designs/183-jangar-attested-action-custody-and-profit-window-admission-2026-05-08.md',
  'swarm-validation-contract:every-run-cites-governing-requirement',
]

const STAGE_CLEARANCE_PACKET_SPECS: Array<{
  stage: StageClearanceStage
  actionClass: ActionSloBudgetActionClass
}> = [
  { stage: 'serve', actionClass: 'serve_readonly' },
  { stage: 'discover', actionClass: 'dispatch_normal' },
  { stage: 'plan', actionClass: 'dispatch_normal' },
  { stage: 'implement', actionClass: 'dispatch_normal' },
  { stage: 'verify', actionClass: 'dispatch_normal' },
  { stage: 'repair', actionClass: 'dispatch_repair' },
  { stage: 'deployer', actionClass: 'deploy_widen' },
  { stage: 'verify', actionClass: 'merge_ready' },
  { stage: 'torghut', actionClass: 'torghut_observe' },
  { stage: 'torghut', actionClass: 'paper_canary' },
  { stage: 'torghut', actionClass: 'live_micro_canary' },
  { stage: 'torghut', actionClass: 'live_scale' },
]

type RuntimeStageName = Extract<StageClearanceStage, 'discover' | 'plan' | 'implement' | 'verify'>

export type StageClearanceInput = {
  now: Date
  namespace: string
  swarmName?: string
  workflows: WorkflowsReliabilityStatus
  executionTrust: ExecutionTrustStatus
  swarms: ExecutionTrustSwarm[]
  stages: ExecutionTrustStage[]
  controllerWitness: ControlPlaneControllerWitnessQuorum
  sourceRolloutTruthExchange: SourceRolloutTruthExchange
  routeStabilityEscrow: RouteStabilityEscrow
  materialActionVerdictEpoch: MaterialActionVerdictEpoch
  failureDomainLeases: FailureDomainLeaseSet
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
  dependencyVerdictExchange?: DependencyVerdictExchange
}

type PacketDebt = {
  reasonCodes: string[]
  requiredRepairActions: string[]
  providerCapacityActive: boolean
}

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const uniqueStrings = (values: Array<string | null | undefined>) => [
  ...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0))),
]

const normalizeReason = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')

const parseIso = (value: string | null | undefined) => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

const minIsoTimestamp = (values: Array<string | null | undefined>, fallback: string) => {
  const parsed = values
    .map(parseIso)
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right)
  return parsed.length > 0 ? new Date(parsed[0] ?? Date.parse(fallback)).toISOString() : fallback
}

const runtimeStageName = (stage: StageClearanceStage): RuntimeStageName | null => {
  if (stage === 'discover' || stage === 'plan' || stage === 'implement' || stage === 'verify') {
    return stage
  }
  return null
}

const isCapitalAction = (actionClass: ActionSloBudgetActionClass) =>
  actionClass === 'paper_canary' || actionClass === 'live_micro_canary' || actionClass === 'live_scale'

const failureDomainActionClassForPacket = (actionClass: ActionSloBudgetActionClass): FailureDomainActionClass =>
  isCapitalAction(actionClass) ? 'torghut_capital' : (actionClass as FailureDomainActionClass)

const numericNotional = (value: string | null | undefined) => {
  if (!value) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const decisionFromVerdict = (verdict: MaterialActionVerdict | undefined): StageClearanceDecision => {
  if (!verdict) return 'hold'
  if (verdict.decision === 'allow') return 'allow'
  if (verdict.decision === 'repair_only') return 'repair_only'
  if (verdict.decision === 'block' || verdict.decision === 'contradicted') return 'block'
  return 'hold'
}

const materialReasonCodes = (verdict: MaterialActionVerdict | undefined, actionClass: ActionSloBudgetActionClass) =>
  uniqueStrings([
    ...(!verdict ? [`material_action_verdict_missing:${actionClass}`] : []),
    ...(verdict?.blocking_reason_codes ?? []),
    ...(verdict?.downgrade_reason_codes ?? []),
  ]).map(normalizeReason)

const requiredRepairForReason = (reason: string) => {
  if (reason.includes('swarm_freeze') || reason.includes('stage_')) return 'clear stage freshness debt'
  if (reason.includes('controller') || reason.includes('agentrun_ingestion')) {
    return 'publish fresh AgentRun ingestion and controller witness'
  }
  if (reason.includes('provider_capacity')) return 'reduce provider capacity debt before launch'
  if (reason.includes('workflow') || reason.includes('backoff')) return 'retire workflow failure debt'
  if (reason.includes('market_context')) return 'refresh Torghut market-context evidence'
  if (reason.includes('quant')) return 'repair Torghut quant pipeline evidence'
  if (reason.includes('empirical')) return 'refresh Torghut empirical proof'
  if (reason.includes('source_rollout')) return 'settle source rollout truth'
  if (reason.includes('route')) return 'restore route stability evidence'
  if (reason.includes('torghut')) return 'close Torghut zero-notional repair blockers'
  return `repair ${reason}`
}

const stageDebtForPacket = (input: StageClearanceInput, packetStage: StageClearanceStage): PacketDebt => {
  const swarmName = input.swarmName ?? DEFAULT_SWARM_NAME
  const stage = runtimeStageName(packetStage)
  const matchingSwarm = input.swarms.find((swarm) => swarm.name === swarmName && swarm.namespace === input.namespace)
  const freezeUntilMs = parseIso(matchingSwarm?.freeze?.until)
  const freezeActive = freezeUntilMs !== null && freezeUntilMs > input.now.getTime()
  const stageRows =
    stage === null
      ? input.stages.filter((row) => row.swarm === swarmName && row.namespace === input.namespace)
      : input.stages.filter(
          (row) => row.swarm === swarmName && row.namespace === input.namespace && row.stage === stage,
        )
  const reasonCodes = uniqueStrings([
    ...(input.executionTrust.status !== 'healthy' ? [`execution_trust_${input.executionTrust.status}`] : []),
    ...(freezeActive ? ['swarm_freeze_active'] : []),
    ...(freezeActive && matchingSwarm?.freeze?.reason ? [`swarm_freeze_${matchingSwarm.freeze.reason}`] : []),
    ...stageRows.flatMap((row) => [
      ...(row.stale ? [`stage_${row.stage}_stale`] : []),
      ...(row.phase.toLowerCase() === 'frozen' ? [`stage_${row.stage}_frozen`] : []),
      ...(row.recent_failed_jobs > 0 ? [`stage_${row.stage}_recent_failed_jobs`] : []),
      ...(row.recent_backoff_limit_exceeded_jobs > 0 ? [`stage_${row.stage}_backoff_limit_exceeded`] : []),
      ...(row.data_confidence !== 'high' ? [`stage_${row.stage}_data_${row.data_confidence}`] : []),
      ...(row.last_failure_reason ? [`stage_${row.stage}_${row.last_failure_reason}`] : []),
    ]),
  ]).map(normalizeReason)

  return {
    reasonCodes,
    requiredRepairActions: uniqueStrings(reasonCodes.map(requiredRepairForReason)),
    providerCapacityActive: false,
  }
}

const controllerDebtForPacket = (
  actionClass: ActionSloBudgetActionClass,
  witness: ControlPlaneControllerWitnessQuorum,
): PacketDebt => {
  if (actionClass === 'serve_readonly' || actionClass === 'torghut_observe') {
    return { reasonCodes: [], requiredRepairActions: [], providerCapacityActive: false }
  }

  const reasonCodes = uniqueStrings([
    ...witness.reason_codes,
    ...(witness.decision !== 'allow' ? [`controller_witness_${witness.decision}`] : []),
    ...(!witness.controller_self_report_current ? ['agentrun_ingestion_not_current'] : []),
  ]).map(normalizeReason)

  return {
    reasonCodes,
    requiredRepairActions: uniqueStrings(reasonCodes.map(requiredRepairForReason)),
    providerCapacityActive: false,
  }
}

const workflowDebtForPacket = (
  actionClass: ActionSloBudgetActionClass,
  workflows: WorkflowsReliabilityStatus,
): PacketDebt => {
  if (actionClass === 'serve_readonly' || actionClass === 'torghut_observe') {
    return { reasonCodes: [], requiredRepairActions: [], providerCapacityActive: false }
  }

  const providerCapacityActive = workflows.top_failure_reasons.some((entry) =>
    normalizeReason(entry.reason).includes('providercapacityexhausted'),
  )
  const reasonCodes = uniqueStrings([
    ...(workflows.data_confidence !== 'high' ? [`workflow_data_${workflows.data_confidence}`] : []),
    ...(workflows.recent_failed_jobs > 0 ? ['workflow_recent_failed_jobs'] : []),
    ...(workflows.backoff_limit_exceeded_jobs > 0 ? ['workflow_backoff_limit_exceeded_jobs'] : []),
    ...(providerCapacityActive ? ['provider_capacity_debt_active'] : []),
    ...workflows.top_failure_reasons.map((entry) => `workflow_failure_${entry.reason}`),
  ]).map(normalizeReason)

  return {
    reasonCodes,
    requiredRepairActions: uniqueStrings(reasonCodes.map(requiredRepairForReason)),
    providerCapacityActive,
  }
}

const routeDebtForPacket = (
  actionClass: ActionSloBudgetActionClass,
  routeStabilityEscrow: RouteStabilityEscrow,
): PacketDebt => {
  if (actionClass === 'torghut_observe') {
    return { reasonCodes: [], requiredRepairActions: [], providerCapacityActive: false }
  }

  const contract = routeStabilityEscrow.material_action_contracts.find((entry) => entry.action_class === actionClass)
  const decision = contract?.decision
  const reasonCodes = uniqueStrings([
    ...routeStabilityEscrow.route_stability_window.reason_codes,
    ...(!contract ? [`route_stability_contract_missing:${actionClass}`] : []),
    ...(decision === 'hold' || decision === 'block' || decision === 'repair_only'
      ? [`route_stability_${decision}`]
      : []),
  ]).map(normalizeReason)

  return {
    reasonCodes,
    requiredRepairActions: uniqueStrings([
      ...(contract?.required_repairs ?? []),
      ...reasonCodes.map(requiredRepairForReason),
    ]),
    providerCapacityActive: false,
  }
}

const sourceRolloutDebtForPacket = (
  actionClass: ActionSloBudgetActionClass,
  sourceRolloutTruthExchange: SourceRolloutTruthExchange,
): PacketDebt => {
  const receipt = sourceRolloutTruthExchange.receipts.find((entry) => entry.action_class === actionClass)
  const reasonCodes = uniqueStrings([
    ...(!receipt ? [`source_rollout_truth_receipt_missing:${actionClass}`] : []),
    ...(receipt && receipt.action_decision !== 'allow' ? [`source_rollout_truth_${receipt.action_decision}`] : []),
    ...(receipt?.blocking_reasons ?? []),
  ]).map(normalizeReason)

  return {
    reasonCodes,
    requiredRepairActions: uniqueStrings(reasonCodes.map(requiredRepairForReason)),
    providerCapacityActive: false,
  }
}

const torghutDebtForPacket = (
  actionClass: ActionSloBudgetActionClass,
  status: TorghutConsumerEvidenceStatus,
): PacketDebt => {
  if (!isCapitalAction(actionClass) && actionClass !== 'torghut_observe' && actionClass !== 'dispatch_repair') {
    return { reasonCodes: [], requiredRepairActions: [], providerCapacityActive: false }
  }

  const notional = numericNotional(status.max_notional)
  const reasonCodes = uniqueStrings([
    ...(status.status !== 'current' && status.status !== 'disabled'
      ? [`torghut_consumer_evidence_${status.status}`]
      : []),
    ...status.reason_codes,
    ...(isCapitalAction(actionClass) && notional <= 0 ? ['torghut_max_notional_zero'] : []),
    ...(status.decision === 'repair' || status.decision === 'repair_only'
      ? [`torghut_decision_${status.decision}`]
      : []),
    ...(status.capital_reentry_aggregate_state && status.capital_reentry_aggregate_state !== 'allow'
      ? [`capital_reentry_${status.capital_reentry_aggregate_state}`]
      : []),
    ...(status.profit_repair_aggregate_state && status.profit_repair_aggregate_state !== 'allow'
      ? [`profit_repair_${status.profit_repair_aggregate_state}`]
      : []),
  ]).map(normalizeReason)

  return {
    reasonCodes,
    requiredRepairActions: uniqueStrings(reasonCodes.map(requiredRepairForReason)),
    providerCapacityActive: false,
  }
}

const failureDomainLeaseRefs = (
  actionClass: ActionSloBudgetActionClass,
  failureDomainLeases: FailureDomainLeaseSet,
) => {
  const normalizedAction = failureDomainActionClassForPacket(actionClass)
  const blockingLeaseIds = failureDomainLeases.leases
    .filter((lease) => lease.status !== 'valid' && lease.action_classes.includes(normalizedAction))
    .map((lease) => lease.lease_id)
  const holdback = failureDomainLeases.holdbacks.find(
    (entry) => entry.action_class === normalizedAction && entry.decision !== 'allow',
  )
  let holdbackLeaseIds: string[] = []
  if (holdback && holdback.lease_ids.length > 0) {
    holdbackLeaseIds = holdback.lease_ids
  } else if (holdback) {
    holdbackLeaseIds = [failureDomainLeases.lease_set_digest]
  }

  return uniqueStrings([...blockingLeaseIds, ...holdbackLeaseIds])
}

const failureDomainDebtForPacket = (
  actionClass: ActionSloBudgetActionClass,
  failureDomainLeases: FailureDomainLeaseSet,
): PacketDebt => {
  const normalizedAction = failureDomainActionClassForPacket(actionClass)
  const refs = failureDomainLeaseRefs(actionClass, failureDomainLeases)
  const blockingLeases = failureDomainLeases.leases.filter((lease) => refs.includes(lease.lease_id))
  const holdback = failureDomainLeases.holdbacks.find(
    (entry) => entry.action_class === normalizedAction && entry.decision !== 'allow',
  )
  let holdbackReasonCodes: string[] = []
  if (holdback && holdback.reason_codes.length > 0) {
    holdbackReasonCodes = holdback.reason_codes
  } else if (holdback) {
    holdbackReasonCodes = [`failure_domain_${holdback.decision}:${normalizedAction}`]
  }
  const reasonCodes = uniqueStrings([
    ...blockingLeases.flatMap((lease) => lease.reason_codes),
    ...holdbackReasonCodes,
  ]).map(normalizeReason)

  return {
    reasonCodes,
    requiredRepairActions: uniqueStrings(reasonCodes.map(requiredRepairForReason)),
    providerCapacityActive: false,
  }
}

const providerCapacityRef = (workflows: WorkflowsReliabilityStatus, providerCapacityActive: boolean) => {
  if (!providerCapacityActive) return null
  return `provider-capacity:${hashJson({
    window_minutes: workflows.window_minutes,
    top_failure_reasons: workflows.top_failure_reasons,
  })}`
}

const agentRunIngestionRef = (witness: ControlPlaneControllerWitnessQuorum) => {
  const ingestionWitness = witness.witnesses.find((entry) => entry.controller_surface === 'agentrun_ingestion')
  return ingestionWitness?.witness_id ?? `agentrun-ingestion:${witness.quorum_id}`
}

const executionTrustRef = (input: StageClearanceInput) =>
  `execution-trust:${hashJson({
    status: input.executionTrust.status,
    reason: input.executionTrust.reason,
    blocking_windows: input.executionTrust.blocking_windows,
    swarms: input.swarms,
    stages: input.stages,
  })}`

const torghutEvidenceRef = (status: TorghutConsumerEvidenceStatus) => {
  if (status.receipt_id) return status.receipt_id
  if (status.status === 'disabled') return null
  return `torghut-consumer-evidence:${status.status}`
}

const dependencyVerdictForPacket = (input: StageClearanceInput, actionClass: ActionSloBudgetActionClass) => {
  const dependencyAction = dependencyVerdictForActionSloClass(actionClass)
  if (!dependencyAction) return null
  return input.dependencyVerdictExchange?.verdicts.find((verdict) => verdict.action_class === dependencyAction) ?? null
}

const packetDecision = (input: {
  actionClass: ActionSloBudgetActionClass
  materialDecision: StageClearanceDecision
  reasonCodes: string[]
  controllerWitness: ControlPlaneControllerWitnessQuorum
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
}): StageClearanceDecision => {
  const { actionClass, materialDecision, reasonCodes } = input
  const controllerBlocked = input.controllerWitness.decision === 'block'
  const torghutUnavailable =
    input.torghutConsumerEvidence.status === 'unavailable' || input.torghutConsumerEvidence.status === 'route_missing'

  if (materialDecision === 'block' || controllerBlocked) return 'block'

  if (actionClass === 'serve_readonly') {
    return materialDecision === 'allow' || materialDecision === 'repair_only' ? 'allow' : 'hold'
  }

  if (actionClass === 'torghut_observe') {
    return torghutUnavailable ? 'hold' : 'allow'
  }

  if (actionClass === 'dispatch_repair') {
    if (materialDecision === 'allow' && reasonCodes.length === 0) return 'allow'
    return 'repair_only'
  }

  if (actionClass === 'live_micro_canary' || actionClass === 'live_scale') {
    return materialDecision === 'allow' && reasonCodes.length === 0 ? 'allow' : 'block'
  }

  if (actionClass === 'paper_canary') {
    return materialDecision === 'allow' && reasonCodes.length === 0 ? 'allow' : 'hold'
  }

  if (materialDecision !== 'allow' || reasonCodes.length > 0) return 'hold'
  return 'allow'
}

const maxLaunchesForDecision = (
  actionClass: ActionSloBudgetActionClass,
  decision: StageClearanceDecision,
): number | null => {
  if (actionClass === 'serve_readonly' || actionClass === 'torghut_observe') return null
  if (decision === 'hold' || decision === 'block') return 0
  return 1
}

const maxNotionalForDecision = (
  actionClass: ActionSloBudgetActionClass,
  decision: StageClearanceDecision,
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus,
) => {
  if (decision !== 'allow' || !isCapitalAction(actionClass)) return 0
  return numericNotional(torghutConsumerEvidence.max_notional)
}

const buildPacket = (
  input: StageClearanceInput,
  spec: (typeof STAGE_CLEARANCE_PACKET_SPECS)[number],
): StageClearancePacket => {
  const swarmName = input.swarmName ?? DEFAULT_SWARM_NAME
  const materialVerdict = input.materialActionVerdictEpoch.final_verdicts.find(
    (entry) => entry.action_class === spec.actionClass,
  )
  const materialDecision = decisionFromVerdict(materialVerdict)
  const debts = [
    stageDebtForPacket(input, spec.stage),
    controllerDebtForPacket(spec.actionClass, input.controllerWitness),
    workflowDebtForPacket(spec.actionClass, input.workflows),
    routeDebtForPacket(spec.actionClass, input.routeStabilityEscrow),
    sourceRolloutDebtForPacket(spec.actionClass, input.sourceRolloutTruthExchange),
    torghutDebtForPacket(spec.actionClass, input.torghutConsumerEvidence),
    failureDomainDebtForPacket(spec.actionClass, input.failureDomainLeases),
  ]
  const reasonCodes = uniqueStrings([
    ...materialReasonCodes(materialVerdict, spec.actionClass),
    ...debts.flatMap((debt) => debt.reasonCodes),
  ])
  const decision = packetDecision({
    actionClass: spec.actionClass,
    materialDecision,
    reasonCodes,
    controllerWitness: input.controllerWitness,
    torghutConsumerEvidence: input.torghutConsumerEvidence,
  })
  const requiredRepairActions = uniqueStrings([
    ...(materialVerdict?.required_repair_actions ?? []),
    ...debts.flatMap((debt) => debt.requiredRepairActions),
    ...reasonCodes.map(requiredRepairForReason),
  ])
  const fallbackFreshUntil = new Date(input.now.getTime() + PACKET_TTL_SECONDS * 1000).toISOString()
  const sourceReceipt = input.sourceRolloutTruthExchange.receipts.find(
    (entry) => entry.action_class === spec.actionClass,
  )
  const routeContract = input.routeStabilityEscrow.material_action_contracts.find(
    (entry) => entry.action_class === spec.actionClass,
  )
  const failureLeaseRefs = failureDomainLeaseRefs(spec.actionClass, input.failureDomainLeases)
  const providerActive = debts.some((debt) => debt.providerCapacityActive)
  const providerRef = providerCapacityRef(input.workflows, providerActive)
  const freshUntil = minIsoTimestamp(
    [
      input.materialActionVerdictEpoch.expires_at,
      input.controllerWitness.expires_at,
      input.sourceRolloutTruthExchange.fresh_until,
      sourceReceipt?.fresh_until,
      input.routeStabilityEscrow.fresh_until,
      input.torghutConsumerEvidence.fresh_until,
      fallbackFreshUntil,
    ],
    fallbackFreshUntil,
  )
  const torghutRef = torghutEvidenceRef(input.torghutConsumerEvidence)
  const dependencyVerdict = dependencyVerdictForPacket(input, spec.actionClass)
  const packetId = `stage-clearance:${spec.stage}:${spec.actionClass}:${hashJson({
    producer_revision: PRODUCER_REVISION,
    namespace: input.namespace,
    swarm_name: swarmName,
    stage: spec.stage,
    action_class: spec.actionClass,
    decision,
    reason_codes: reasonCodes,
    material_action_verdict_ref: materialVerdict?.verdict_id,
    execution_trust_ref: executionTrustRef(input),
  })}`

  return {
    schema_version: STAGE_CLEARANCE_SCHEMA_VERSION,
    packet_id: packetId,
    generated_at: input.now.toISOString(),
    fresh_until: freshUntil,
    namespace: input.namespace,
    swarm_name: swarmName,
    stage: spec.stage,
    action_class: spec.actionClass,
    governing_requirement_refs: GOVERNING_REQUIREMENT_REFS,
    source_rollout_truth_ref: input.sourceRolloutTruthExchange.exchange_id,
    controller_witness_ref: input.controllerWitness.quorum_id,
    agentrun_ingestion_ref: agentRunIngestionRef(input.controllerWitness),
    execution_trust_ref: executionTrustRef(input),
    material_action_verdict_ref: materialVerdict?.verdict_id ?? `material-action-verdict:${spec.actionClass}:missing`,
    route_stability_ref: routeContract
      ? `route-stability-contract:${routeContract.action_class}:${hashJson(routeContract)}`
      : input.routeStabilityEscrow.escrow_id,
    torghut_consumer_evidence_ref: torghutRef,
    dependency_verdict_ref: dependencyVerdict?.verdict_id ?? null,
    dependency_verdict_decision: dependencyVerdict?.decision ?? null,
    failure_domain_leases: failureLeaseRefs,
    provider_capacity_ref: providerRef,
    decision,
    max_launches: maxLaunchesForDecision(spec.actionClass, decision),
    max_notional: maxNotionalForDecision(spec.actionClass, decision, input.torghutConsumerEvidence),
    ttl_seconds: PACKET_TTL_SECONDS,
    reason_codes: reasonCodes,
    required_repair_action: decision === 'allow' ? null : (requiredRepairActions[0] ?? 'inspect stage clearance debt'),
    rollback_target:
      'set JANGAR_STAGE_CLEARANCE_ENFORCEMENT=shadow and fall back to material action verdicts plus runtime admission passports',
  }
}

export const buildStageClearancePackets = (input: StageClearanceInput): StageClearancePacket[] =>
  STAGE_CLEARANCE_PACKET_SPECS.map((spec) => buildPacket(input, spec))
