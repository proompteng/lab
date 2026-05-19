import { createHash } from 'node:crypto'

import type {
  ActionCustodyAllowedScope,
  ActionCustodyDecision,
  ActionCustodyReceipt,
  ActionSloBudgetActionClass,
  ControlPlaneControllerWitnessQuorum,
  MaterialActionVerdict,
  MaterialActionVerdictEpoch,
  ReadyActionExchange,
  RouteStabilityEscrow,
  RouteStabilityMaterialActionContract,
  SourceRolloutTruthExchange,
  WorkflowsReliabilityStatus,
} from '~/data/agents-control-plane'
import type { TorghutConsumerEvidenceStatus } from '~/server/control-plane-torghut-consumer-evidence'

export const ACTION_CUSTODY_DESIGN_ARTIFACT =
  'docs/agents/designs/183-jangar-attested-action-custody-and-profit-window-admission-2026-05-08.md'

const PRODUCER_REVISION = '2026-05-12-action-custody-observe-v1'
const RECEIPT_SCHEMA_VERSION = 'jangar.action-custody-receipt.v1' as const

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

const DECISION_RANK: Record<ActionCustodyDecision, number> = {
  allow: 0,
  repair_only: 1,
  hold: 2,
  block: 3,
}

type ActionCustodyInput = {
  now: Date
  namespace: string
  swarmName?: string
  workflows: WorkflowsReliabilityStatus
  controllerWitness: ControlPlaneControllerWitnessQuorum
  sourceRolloutTruthExchange: SourceRolloutTruthExchange
  routeStabilityEscrow: RouteStabilityEscrow
  materialActionVerdictEpoch: MaterialActionVerdictEpoch
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
}

export type ActionCustodyProjection = {
  actionCustodyReceipts: ActionCustodyReceipt[]
  readyActionExchange: ReadyActionExchange
}

type DecisionSignal = {
  source: 'material_action_verdict' | 'route_stability' | 'controller_witness' | 'retained_failure_debt' | 'torghut'
  decision: ActionCustodyDecision
  blockingDebtClasses: string[]
  requiredRepairActions: string[]
  evidenceRefs: string[]
  maxDispatches: number | null
  maxRuntimeSeconds: number | null
  maxNotional: number | null
}

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const uniqueStrings = (values: Array<string | null | undefined>) => [
  ...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0))),
]

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

const decisionRank = (decision: ActionCustodyDecision) => DECISION_RANK[decision]

const stricterDecision = (left: ActionCustodyDecision, right: ActionCustodyDecision): ActionCustodyDecision =>
  decisionRank(left) >= decisionRank(right) ? left : right

const tightestCap = (values: Array<number | null>) => {
  const numericValues = values.filter((value): value is number => value !== null)
  return numericValues.length > 0 ? Math.min(...numericValues) : null
}

const tightestCaps = (signals: DecisionSignal[]) => ({
  maxDispatches: tightestCap(signals.map((signal) => signal.maxDispatches)),
  maxRuntimeSeconds: tightestCap(signals.map((signal) => signal.maxRuntimeSeconds)),
  maxNotional: tightestCap(signals.map((signal) => signal.maxNotional)),
})

const actionStage = (actionClass: ActionSloBudgetActionClass): ActionCustodyReceipt['stage'] => {
  if (actionClass === 'serve_readonly') return 'serve'
  if (actionClass === 'deploy_widen') return 'deploy'
  if (actionClass === 'merge_ready') return 'verify'
  if (
    actionClass === 'torghut_observe' ||
    actionClass === 'paper_canary' ||
    actionClass === 'live_micro_canary' ||
    actionClass === 'live_scale'
  ) {
    return 'torghut'
  }
  return 'dispatch'
}

const allowedScope = (
  actionClass: ActionSloBudgetActionClass,
  decision: ActionCustodyDecision,
): ActionCustodyAllowedScope => {
  if (decision === 'hold' || decision === 'block') return 'none'
  if (decision === 'repair_only') return actionClass === 'dispatch_repair' ? 'bounded_repair' : 'none'
  if (actionClass === 'dispatch_repair') return 'bounded_repair'
  if (actionClass === 'dispatch_normal') return 'normal_dispatch'
  return actionClass
}

const custodyDecisionFromVerdict = (verdict: MaterialActionVerdict | undefined): ActionCustodyDecision => {
  if (!verdict) return 'hold'
  if (verdict.decision === 'allow') return 'allow'
  if (verdict.decision === 'repair_only') return 'repair_only'
  if (verdict.decision === 'block' || verdict.decision === 'contradicted') return 'block'
  return 'hold'
}

const custodyDecisionFromRouteContract = (
  contract: RouteStabilityMaterialActionContract | undefined,
): ActionCustodyDecision => {
  if (!contract) return 'hold'
  if (contract.decision === 'allow' || contract.decision === 'observe_only') return 'allow'
  if (contract.decision === 'repair_only') return 'repair_only'
  if (contract.decision === 'block') return 'block'
  return 'hold'
}

const materialSignal = (verdict: MaterialActionVerdict | undefined, actionClass: ActionSloBudgetActionClass) => ({
  source: 'material_action_verdict' as const,
  decision: custodyDecisionFromVerdict(verdict),
  blockingDebtClasses: uniqueStrings([
    ...(verdict?.blocking_reason_codes ?? []),
    ...(verdict?.downgrade_reason_codes ?? []),
    ...(!verdict ? [`material_action_verdict_missing:${actionClass}`] : []),
  ]),
  requiredRepairActions: verdict?.required_repair_actions ?? ['restore material action verdict projection'],
  evidenceRefs: uniqueStrings([verdict?.verdict_id, ...(verdict?.evidence_refs ?? [])]),
  maxDispatches: verdict ? (verdict.max_dispatches ?? null) : 0,
  maxRuntimeSeconds: verdict ? (verdict.max_runtime_seconds ?? null) : 0,
  maxNotional: verdict ? (verdict.max_notional ?? null) : 0,
})

const routeSignal = (
  contract: RouteStabilityMaterialActionContract | undefined,
  escrow: RouteStabilityEscrow,
  actionClass: ActionSloBudgetActionClass,
) => ({
  source: 'route_stability' as const,
  decision: custodyDecisionFromRouteContract(contract),
  blockingDebtClasses: uniqueStrings([
    ...escrow.route_stability_window.reason_codes,
    ...(!contract ? [`route_stability_contract_missing:${actionClass}`] : []),
  ]),
  requiredRepairActions: contract?.required_repairs ?? ['restore route stability contract projection'],
  evidenceRefs: uniqueStrings([
    escrow.escrow_id,
    contract?.snapshot_ref,
    contract?.live_route_ref,
    escrow.controller_witness_ref,
  ]),
  maxDispatches: contract ? (contract.max_dispatches ?? null) : 0,
  maxRuntimeSeconds: contract ? (contract.max_runtime_seconds ?? null) : 0,
  maxNotional: contract ? (contract.max_notional ?? null) : 0,
})

const controllerDecision = (
  actionClass: ActionSloBudgetActionClass,
  witness: ControlPlaneControllerWitnessQuorum,
): ActionCustodyDecision | null => {
  if (actionClass === 'serve_readonly' || actionClass === 'torghut_observe') return null
  if (witness.decision === 'block') return 'block'
  if (witness.controller_self_report_current && witness.decision === 'allow') return null
  if (actionClass === 'dispatch_repair') return 'repair_only'
  if (actionClass === 'live_micro_canary' || actionClass === 'live_scale') return 'block'
  return 'hold'
}

const controllerSignal = (
  actionClass: ActionSloBudgetActionClass,
  witness: ControlPlaneControllerWitnessQuorum,
): DecisionSignal | null => {
  const decision = controllerDecision(actionClass, witness)
  if (!decision) return null
  const reasons = uniqueStrings([
    ...witness.reason_codes,
    ...(!witness.controller_self_report_current ? ['controller_self_report_not_current'] : []),
    ...(witness.decision !== 'allow' ? [`controller_witness_${witness.decision}`] : []),
  ])

  return {
    source: 'controller_witness',
    decision,
    blockingDebtClasses: decision === 'repair_only' ? [] : reasons,
    requiredRepairActions: ['publish a fresh controller-process witness'],
    evidenceRefs: uniqueStrings([witness.quorum_id, ...witness.witness_refs]),
    maxDispatches: decision === 'repair_only' ? 1 : 0,
    maxRuntimeSeconds: decision === 'repair_only' ? 20 * 60 : 0,
    maxNotional: 0,
  }
}

const retainedFailureSignal = (
  actionClass: ActionSloBudgetActionClass,
  workflows: WorkflowsReliabilityStatus,
): DecisionSignal | null => {
  if (workflows.recent_failed_jobs === 0 && workflows.backoff_limit_exceeded_jobs === 0) return null
  if (actionClass === 'serve_readonly' || actionClass === 'dispatch_repair' || actionClass === 'torghut_observe') {
    return null
  }

  const reasons = uniqueStrings([
    ...(workflows.recent_failed_jobs > 0 ? ['retained_recent_failed_jobs'] : []),
    ...(workflows.backoff_limit_exceeded_jobs > 0 ? ['retained_backoff_limit_exceeded_jobs'] : []),
    ...workflows.top_failure_reasons.map((entry) => `workflow_failure:${entry.reason}`),
  ])

  return {
    source: 'retained_failure_debt',
    decision: actionClass === 'live_micro_canary' || actionClass === 'live_scale' ? 'block' : 'hold',
    blockingDebtClasses: reasons,
    requiredRepairActions: ['retire retained workflow failure debt before material action'],
    evidenceRefs: [
      `workflows:${workflows.window_minutes}m:${workflows.recent_failed_jobs}:${workflows.backoff_limit_exceeded_jobs}`,
    ],
    maxDispatches: 0,
    maxRuntimeSeconds: 0,
    maxNotional: 0,
  }
}

const numericNotional = (value: string | null | undefined) => {
  if (!value) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const torghutSignal = (
  actionClass: ActionSloBudgetActionClass,
  status: TorghutConsumerEvidenceStatus,
): DecisionSignal | null => {
  if (
    actionClass !== 'paper_canary' &&
    actionClass !== 'live_micro_canary' &&
    actionClass !== 'live_scale' &&
    actionClass !== 'torghut_observe'
  ) {
    return null
  }

  const evidenceRefs = uniqueStrings([
    status.receipt_id,
    status.capital_reentry_cohort_ledger_id,
    status.profit_repair_settlement_ledger_id,
    status.jangar_parity_escrow_ref,
    status.route_canary_id,
  ])
  const notional = numericNotional(status.max_notional)
  const repairOrHeld =
    status.status !== 'current' ||
    notional <= 0 ||
    status.decision === 'repair' ||
    status.decision === 'repair_only' ||
    status.reason_codes.length > 0 ||
    status.capital_reentry_aggregate_state === 'blocked' ||
    status.profit_repair_aggregate_state === 'blocked'

  if (actionClass === 'torghut_observe') {
    return {
      source: 'torghut',
      decision: status.status === 'unavailable' || status.status === 'route_missing' ? 'hold' : 'allow',
      blockingDebtClasses: status.status === 'current' ? [] : status.reason_codes,
      requiredRepairActions: [],
      evidenceRefs,
      maxDispatches: null,
      maxRuntimeSeconds: null,
      maxNotional: 0,
    }
  }

  if (!repairOrHeld) {
    return {
      source: 'torghut',
      decision: 'allow',
      blockingDebtClasses: [],
      requiredRepairActions: [],
      evidenceRefs,
      maxDispatches: actionClass === 'paper_canary' ? 1 : null,
      maxRuntimeSeconds: actionClass === 'paper_canary' ? 30 * 60 : null,
      maxNotional: notional,
    }
  }

  const reasons = uniqueStrings([
    ...(status.status !== 'current' ? [`torghut_consumer_evidence_${status.status}`] : []),
    ...(notional <= 0 ? ['torghut_max_notional_zero'] : []),
    ...(status.decision ? [`torghut_decision_${status.decision}`] : []),
    ...(status.capital_reentry_aggregate_state ? [`capital_reentry_${status.capital_reentry_aggregate_state}`] : []),
    ...(status.profit_repair_aggregate_state ? [`profit_repair_${status.profit_repair_aggregate_state}`] : []),
    ...status.reason_codes,
  ])

  return {
    source: 'torghut',
    decision: actionClass === 'paper_canary' ? 'hold' : 'block',
    blockingDebtClasses: reasons,
    requiredRepairActions: ['close Torghut profit-window and zero-notional repair debt before capital action'],
    evidenceRefs,
    maxDispatches: 0,
    maxRuntimeSeconds: 0,
    maxNotional: 0,
  }
}

const forbiddenShortcuts = (actionClass: ActionSloBudgetActionClass) =>
  uniqueStrings([
    'health_ok_cannot_upgrade_action_custody',
    ...(actionClass === 'deploy_widen' || actionClass === 'merge_ready'
      ? ['argo_synced_healthy_cannot_upgrade_without_controller_and_failure_debt_custody']
      : []),
    ...(actionClass === 'paper_canary' || actionClass === 'live_micro_canary' || actionClass === 'live_scale'
      ? ['current_consumer_evidence_cannot_upgrade_capital_when_max_notional_zero']
      : []),
    ...(actionClass === 'dispatch_normal' ? ['runtime_passport_cannot_upgrade_without_controller_custody'] : []),
  ])

const validationCommands = (actionClass: ActionSloBudgetActionClass) =>
  uniqueStrings([
    'curl -fsS http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents | jq .ready_action_exchange',
    ...(actionClass === 'deploy_widen' || actionClass === 'merge_ready'
      ? [
          'bun run packages/scripts/src/jangar/verify-deployment.ts --require-synced --expected-revision <sha> --expected-revision-mode ancestor',
        ]
      : []),
    ...(actionClass === 'paper_canary' || actionClass === 'live_micro_canary' || actionClass === 'live_scale'
      ? ['curl -fsS http://torghut.torghut.svc.cluster.local/readyz']
      : []),
  ])

const routeContractRef = (contract: RouteStabilityMaterialActionContract | undefined, actionClass: string) =>
  contract
    ? `route-stability-contract:${contract.action_class}:${hashJson({
        route_requirement: contract.route_requirement,
        controller_requirement: contract.controller_requirement,
        decision: contract.decision,
        snapshot_ref: contract.snapshot_ref,
        live_route_ref: contract.live_route_ref,
      })}`
    : `route-stability-contract:${actionClass}:missing`

const retainedFailureDebtRef = (workflows: WorkflowsReliabilityStatus) =>
  `retained-failure-debt:${hashJson({
    active_job_runs: workflows.active_job_runs,
    recent_failed_jobs: workflows.recent_failed_jobs,
    backoff_limit_exceeded_jobs: workflows.backoff_limit_exceeded_jobs,
    window_minutes: workflows.window_minutes,
    top_failure_reasons: workflows.top_failure_reasons,
    data_confidence: workflows.data_confidence,
  })}`

const buildReceipt = (input: {
  now: Date
  namespace: string
  swarmName: string
  workflows: WorkflowsReliabilityStatus
  controllerWitness: ControlPlaneControllerWitnessQuorum
  sourceRolloutTruthExchange: SourceRolloutTruthExchange
  routeStabilityEscrow: RouteStabilityEscrow
  materialActionVerdictEpoch: MaterialActionVerdictEpoch
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
  actionClass: ActionSloBudgetActionClass
  verdict: MaterialActionVerdict | undefined
  routeContract: RouteStabilityMaterialActionContract | undefined
}): ActionCustodyReceipt => {
  const material = materialSignal(input.verdict, input.actionClass)
  const route = routeSignal(input.routeContract, input.routeStabilityEscrow, input.actionClass)
  const controller = controllerSignal(input.actionClass, input.controllerWitness)
  const retainedFailure = retainedFailureSignal(input.actionClass, input.workflows)
  const torghut = torghutSignal(input.actionClass, input.torghutConsumerEvidence)
  const signals = [
    material,
    route,
    ...(controller ? [controller] : []),
    ...(retainedFailure ? [retainedFailure] : []),
    ...(torghut ? [torghut] : []),
  ]
  const caps = tightestCaps(signals)
  const decision = signals.reduce<ActionCustodyDecision>(
    (current, signal) => stricterDecision(current, signal.decision),
    'allow',
  )
  const fallbackFreshUntil = new Date(input.now.getTime() + 60_000).toISOString()
  const freshUntil = minIsoTimestamp(
    [
      input.materialActionVerdictEpoch.expires_at,
      input.routeStabilityEscrow.fresh_until,
      input.controllerWitness.expires_at,
      input.torghutConsumerEvidence.fresh_until,
      fallbackFreshUntil,
    ],
    fallbackFreshUntil,
  )
  const blockingDebtClasses = uniqueStrings(signals.flatMap((signal) => signal.blockingDebtClasses))
  const requiredRepairActions = uniqueStrings(signals.flatMap((signal) => signal.requiredRepairActions))
  const sourceReceipt = input.sourceRolloutTruthExchange.receipts.find(
    (receipt) => receipt.action_class === input.actionClass,
  )
  const routeRef = routeContractRef(input.routeContract, input.actionClass)
  const failureDebtRef = retainedFailureDebtRef(input.workflows)
  const torghutEvidenceRef =
    input.torghutConsumerEvidence.receipt_id ??
    (input.torghutConsumerEvidence.status === 'disabled'
      ? null
      : `torghut-consumer-evidence:${input.torghutConsumerEvidence.status}`)
  const torghutProfitWindowRef =
    input.torghutConsumerEvidence.profit_repair_settlement_ledger_id ??
    input.torghutConsumerEvidence.capital_reentry_cohort_ledger_id ??
    null
  const evidenceRefs = uniqueStrings([
    ACTION_CUSTODY_DESIGN_ARTIFACT,
    input.materialActionVerdictEpoch.epoch_id,
    input.controllerWitness.quorum_id,
    input.sourceRolloutTruthExchange.exchange_id,
    sourceReceipt?.receipt_id,
    input.routeStabilityEscrow.escrow_id,
    routeRef,
    failureDebtRef,
    torghutEvidenceRef,
    torghutProfitWindowRef,
    ...signals.flatMap((signal) => signal.evidenceRefs),
  ])
  const receiptId = `action-custody:${input.actionClass}:${hashJson({
    producer_revision: PRODUCER_REVISION,
    namespace: input.namespace,
    action_class: input.actionClass,
    decision,
    blocking_debt_classes: blockingDebtClasses,
    evidence_refs: evidenceRefs,
  })}`
  const scope = allowedScope(input.actionClass, decision)
  const carriesRunnableAuthority = decision !== 'hold' && decision !== 'block' && scope !== 'none'

  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    receipt_id: receiptId,
    generated_at: input.now.toISOString(),
    fresh_until: freshUntil,
    namespace: input.namespace,
    swarm_name: input.swarmName,
    stage: actionStage(input.actionClass),
    action_class: input.actionClass,
    decision,
    allowed_scope: scope,
    max_dispatches: carriesRunnableAuthority ? caps.maxDispatches : 0,
    max_runtime_seconds: carriesRunnableAuthority ? caps.maxRuntimeSeconds : 0,
    max_notional: decision === 'allow' ? caps.maxNotional : 0,
    controller_witness_ref: input.controllerWitness.quorum_id,
    source_rollout_truth_ref: input.sourceRolloutTruthExchange.exchange_id,
    scheduler_route_ref: input.routeStabilityEscrow.last_live_route_success_at
      ? (input.routeContract?.live_route_ref ?? null)
      : null,
    retained_failure_debt_ref: failureDebtRef,
    material_action_verdict_ref: input.verdict?.verdict_id ?? `material-action-verdict:${input.actionClass}:missing`,
    route_stability_contract_ref: routeRef,
    torghut_consumer_evidence_ref: torghutEvidenceRef,
    torghut_profit_window_ref: torghutProfitWindowRef,
    blocking_debt_classes: blockingDebtClasses,
    forbidden_shortcuts: forbiddenShortcuts(input.actionClass),
    required_repair_actions: requiredRepairActions,
    validation_commands: validationCommands(input.actionClass),
    evidence_refs: evidenceRefs,
    rollout_gate: 'observe_only',
    rollback_gate:
      'disable action custody enforcement and continue using material action verdicts, route stability escrow, and Torghut proof-floor gates',
  }
}

const exchangeStatus = (receipts: ActionCustodyReceipt[]): ActionCustodyDecision =>
  receipts.reduce<ActionCustodyDecision>((current, receipt) => stricterDecision(current, receipt.decision), 'allow')

const buildReadyActionExchange = (input: {
  now: Date
  namespace: string
  freshUntil: string
  receipts: ActionCustodyReceipt[]
}): ReadyActionExchange => {
  const receipts = input.receipts
  const receiptRefs = receipts.map((receipt) => receipt.receipt_id)
  const status = exchangeStatus(receipts)
  const exchangeId = `ready-action-exchange:${hashJson({
    producer_revision: PRODUCER_REVISION,
    namespace: input.namespace,
    status,
    receipt_refs: receiptRefs,
  })}`

  return {
    mode: 'observe',
    design_artifact: ACTION_CUSTODY_DESIGN_ARTIFACT,
    exchange_id: exchangeId,
    generated_at: input.now.toISOString(),
    fresh_until: input.freshUntil,
    namespace: input.namespace,
    status,
    serving_receipt_id: receipts.find((receipt) => receipt.action_class === 'serve_readonly')?.receipt_id ?? null,
    dispatch_receipt_ids: receipts
      .filter((receipt) => receipt.stage === 'dispatch')
      .map((receipt) => receipt.receipt_id),
    deploy_receipt_ids: receipts
      .filter((receipt) => receipt.stage === 'deploy' || receipt.stage === 'verify')
      .map((receipt) => receipt.receipt_id),
    torghut_receipt_ids: receipts.filter((receipt) => receipt.stage === 'torghut').map((receipt) => receipt.receipt_id),
    receipt_refs: receiptRefs,
    allowed_action_classes: receipts
      .filter((receipt) => receipt.decision === 'allow')
      .map((receipt) => receipt.action_class),
    repair_only_action_classes: receipts
      .filter((receipt) => receipt.decision === 'repair_only')
      .map((receipt) => receipt.action_class),
    held_action_classes: receipts
      .filter((receipt) => receipt.decision === 'hold')
      .map((receipt) => receipt.action_class),
    blocked_action_classes: receipts
      .filter((receipt) => receipt.decision === 'block')
      .map((receipt) => receipt.action_class),
    reason_codes: uniqueStrings(receipts.flatMap((receipt) => receipt.blocking_debt_classes)),
    rollback_target:
      'ignore ready_action_exchange consumers and continue using existing material-action verdicts and runtime gates',
  }
}

export const buildActionCustodyProjection = (input: ActionCustodyInput): ActionCustodyProjection => {
  const verdictByAction = new Map(
    input.materialActionVerdictEpoch.final_verdicts.map((verdict) => [verdict.action_class, verdict]),
  )
  const routeContractByAction = new Map(
    input.routeStabilityEscrow.material_action_contracts.map((contract) => [contract.action_class, contract]),
  )
  const swarmName = input.swarmName ?? 'jangar-control-plane'
  const actionCustodyReceipts = ACTION_CLASSES.map((actionClass) =>
    buildReceipt({
      now: input.now,
      namespace: input.namespace,
      swarmName,
      workflows: input.workflows,
      controllerWitness: input.controllerWitness,
      sourceRolloutTruthExchange: input.sourceRolloutTruthExchange,
      routeStabilityEscrow: input.routeStabilityEscrow,
      materialActionVerdictEpoch: input.materialActionVerdictEpoch,
      torghutConsumerEvidence: input.torghutConsumerEvidence,
      actionClass,
      verdict: verdictByAction.get(actionClass),
      routeContract: routeContractByAction.get(actionClass),
    }),
  )
  const freshUntil = minIsoTimestamp(
    actionCustodyReceipts.map((receipt) => receipt.fresh_until),
    new Date(input.now.getTime() + 60_000).toISOString(),
  )
  const readyActionExchange = buildReadyActionExchange({
    now: input.now,
    namespace: input.namespace,
    freshUntil,
    receipts: actionCustodyReceipts,
  })

  return {
    actionCustodyReceipts,
    readyActionExchange,
  }
}
