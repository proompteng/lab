import { createHash } from 'node:crypto'

import type {
  ActionSloBudget,
  ControlPlaneControllerWitnessQuorum,
  MaterialActionVerdict,
  MaterialActionVerdictDecision,
  MaterialActionVerdictEpoch,
  MaterialActionActivationReceipt,
  MaterialActionActivationReceiptCapitalStage,
  MaterialActionActivationReceiptDecision,
  NegativeEvidenceRouterStatus,
  RouteStabilityEscrow,
} from '~/server/control-plane-status-types'

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const uniqueStrings = (values: string[]) => [...new Set(values.filter((value) => value.trim().length > 0))]

const flattenNegativeEvidenceRefs = (router: NegativeEvidenceRouterStatus) =>
  uniqueStrings(router.negative_evidence_refs.flatMap((entry) => entry.evidence_refs)).sort()

const receiptDecisionFromBudget = (budget: ActionSloBudget): MaterialActionActivationReceiptDecision => {
  if (budget.decision === 'shadow_only') return 'observe_only'
  if (budget.decision === 'allow') return 'allow'
  if (budget.decision === 'observe_only') return 'observe_only'
  if (budget.decision === 'repair_only') return 'repair_only'
  if (budget.decision === 'block') return 'block'
  return 'hold'
}

const receiptDecisionFromVerdict = (
  decision: MaterialActionVerdictDecision,
): MaterialActionActivationReceiptDecision => {
  if (decision === 'allow') return 'allow'
  if (decision === 'repair_only') return 'repair_only'
  if (decision === 'block') return 'block'
  return 'hold'
}

const capitalStageForAction = (
  actionClass: ActionSloBudget['action_class'],
): MaterialActionActivationReceiptCapitalStage => {
  if (actionClass === 'torghut_observe') return 'observe'
  if (actionClass === 'paper_canary') return 'paper'
  if (actionClass === 'live_micro_canary') return 'live_micro'
  if (actionClass === 'live_scale') return 'live_scale'
  if (actionClass === 'deploy_widen' || actionClass === 'merge_ready') return 'shadow'
  return 'none'
}

const proofFreshnessRefs = (router: NegativeEvidenceRouterStatus) =>
  router.positive_evidence_refs
    .filter(
      (ref) =>
        ref.startsWith('runtime-kit:') ||
        ref.startsWith('watch_reliability:') ||
        ref.startsWith('database:') ||
        ref.startsWith('execution_trust:'),
    )
    .sort()

export const buildMaterialActionActivationReceipts = (input: {
  now: Date
  scope: string
  controllerWitness: ControlPlaneControllerWitnessQuorum
  router: NegativeEvidenceRouterStatus
  budgets: ActionSloBudget[]
  materialActionVerdictEpoch?: MaterialActionVerdictEpoch
  routeStabilityEscrow?: RouteStabilityEscrow
}): MaterialActionActivationReceipt[] =>
  input.budgets.map((budget) => {
    const verdict = input.materialActionVerdictEpoch?.final_verdicts.find(
      (entry: MaterialActionVerdict) => entry.action_class === budget.action_class,
    )
    const decision = verdict ? receiptDecisionFromVerdict(verdict.decision) : receiptDecisionFromBudget(budget)
    const receiptSource = {
      action_class: budget.action_class,
      budget_id: budget.budget_id,
      controller_quorum_id: input.controllerWitness.quorum_id,
      router_epoch_id: input.router.router_epoch_id,
      material_action_verdict_epoch_id: input.materialActionVerdictEpoch?.epoch_id ?? null,
      decision,
      scope: input.scope,
    }

    return {
      receipt_id: `receipt:${budget.action_class}:${hashJson(receiptSource)}`,
      generated_at: input.now.toISOString(),
      expires_at: budget.fresh_until,
      action_class: budget.action_class,
      scope: input.scope,
      controller_witness_refs: input.controllerWitness.witness_refs,
      route_stability_escrow_ref: input.routeStabilityEscrow?.escrow_id ?? null,
      transport_contract_refs: [
        input.router.router_epoch_id,
        input.controllerWitness.quorum_id,
        ...(input.materialActionVerdictEpoch ? [input.materialActionVerdictEpoch.epoch_id] : []),
        ...(input.routeStabilityEscrow ? [input.routeStabilityEscrow.escrow_id] : []),
        ...input.router.failure_domain_lease_refs,
      ],
      proof_freshness_refs: proofFreshnessRefs(input.router),
      positive_authority_refs: input.router.positive_evidence_refs,
      negative_authority_refs: uniqueStrings([
        ...flattenNegativeEvidenceRefs(input.router),
        ...(input.materialActionVerdictEpoch?.contradiction_refs ?? []),
      ]),
      capital_stage: capitalStageForAction(budget.action_class),
      decision,
      max_dispatches: verdict ? verdict.max_dispatches : budget.max_dispatches,
      max_runtime_seconds: verdict ? verdict.max_runtime_seconds : budget.max_runtime_seconds,
      max_notional: verdict ? verdict.max_notional : budget.max_notional,
      required_repairs: verdict ? verdict.required_repair_actions : budget.required_repairs,
      rollback_target: verdict?.rollback_target ?? budget.rollback_target ?? input.controllerWitness.rollback_target,
    }
  })
