import { createHash } from 'node:crypto'

import type {
  ActionSloBudget,
  ActionSloBudgetActionClass,
  ActionSloBudgetDecision,
  ControlPlaneControllerWitnessQuorum,
  DependencyQuorumDecision,
  DependencyQuorumStatus,
  EmpiricalServicesStatus,
  MaterialActionVerdict,
  MaterialActionVerdictConfidence,
  MaterialActionVerdictDecision,
  MaterialActionVerdictEpoch,
  NegativeEvidenceRouterStatus,
  ReconciledActionClock,
  ReconciledActionClockDecision,
  RepairWarrantExchange,
  SourceRolloutTruthExchange,
} from '~/server/control-plane-status-types'
import { REPAIR_WARRANT_EXCHANGE_DESIGN_ARTIFACT } from '~/server/control-plane-repair-warrant-exchange'
import {
  SOURCE_ROLLOUT_TRUTH_EXCHANGE_DESIGN_ARTIFACT,
  sourceRolloutTruthVerdictDecision,
} from '~/server/control-plane-source-rollout-truth-exchange'
import type {
  ControlPlaneRolloutHealth,
  ControlPlaneWatchReliability,
  DatabaseStatus,
} from '~/server/control-plane-status-types'

export const MATERIAL_ACTION_VERDICT_DESIGN_ARTIFACT =
  'docs/agents/designs/120-jangar-material-action-verdict-arbiter-and-clock-budget-parity-2026-05-06.md'

const PRODUCER_REVISION = '2026-05-06-material-action-verdict-shadow-v1'
const DEFAULT_FRESHNESS_MS = 60_000

const DECISION_RANK: Record<MaterialActionVerdictDecision, number> = {
  allow: 0,
  unknown: 1,
  repair_only: 2,
  hold: 3,
  contradicted: 4,
  block: 5,
}

type DecisionSignal = {
  source:
    | 'dependency_quorum'
    | 'action_slo_budget'
    | 'action_clock'
    | 'source_rollout_truth_exchange'
    | 'repair_warrant_exchange'
  decision: MaterialActionVerdictDecision
  evidenceRefs: string[]
  blockingReasons: string[]
  downgradeReasons: string[]
  requiredRepairs: string[]
  rollbackTarget: string | null
  allowedUntil: string | null
  maxDispatches: number | null
  maxRuntimeSeconds: number | null
  maxNotional: number | null
  confidence: MaterialActionVerdictConfidence
}

export type MaterialActionVerdictInput = {
  now: Date
  namespace: string
  dependencyQuorum: DependencyQuorumStatus
  negativeEvidenceRouter: NegativeEvidenceRouterStatus
  actionSloBudgets: ActionSloBudget[]
  reconciledActionClocks: ReconciledActionClock[]
  rolloutHealth: ControlPlaneRolloutHealth
  controllerWitness: ControlPlaneControllerWitnessQuorum
  database: DatabaseStatus
  watchReliability: ControlPlaneWatchReliability
  empiricalServices: EmpiricalServicesStatus
  sourceRolloutTruthExchange?: SourceRolloutTruthExchange
  repairWarrantExchange?: RepairWarrantExchange
}

const uniqueStrings = (values: string[]) => [...new Set(values.filter((value) => value.trim().length > 0))]

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const defaultAllowedUntil = (now: Date) => new Date(now.getTime() + DEFAULT_FRESHNESS_MS).toISOString()

const decisionRank = (decision: MaterialActionVerdictDecision) => DECISION_RANK[decision]

const clockActionForBudget = (actionClass: ActionSloBudgetActionClass): ReconciledActionClock['action_class'] => {
  if (actionClass === 'paper_canary' || actionClass === 'live_micro_canary' || actionClass === 'live_scale') {
    return 'torghut_capital'
  }
  return actionClass
}

const verdictDecisionFromBudget = (decision: ActionSloBudgetDecision): MaterialActionVerdictDecision => {
  if (decision === 'allow') return 'allow'
  if (decision === 'block') return 'block'
  if (decision === 'hold') return 'hold'
  return 'repair_only'
}

const verdictDecisionFromClock = (decision: ReconciledActionClockDecision): MaterialActionVerdictDecision => {
  if (decision === 'allow') return 'allow'
  if (decision === 'block') return 'block'
  if (decision === 'hold') return 'hold'
  return 'repair_only'
}

const dependencyQuorumDecisionForAction = (
  decision: DependencyQuorumDecision,
  actionClass: ActionSloBudgetActionClass,
): MaterialActionVerdictDecision | null => {
  if (actionClass === 'serve_readonly' || actionClass === 'dispatch_repair' || actionClass === 'torghut_observe') {
    return null
  }

  if (decision === 'block') {
    return actionClass === 'live_micro_canary' || actionClass === 'live_scale' ? 'block' : 'hold'
  }

  if (decision === 'delay') {
    if (actionClass === 'dispatch_normal') return 'repair_only'
    return actionClass === 'live_micro_canary' || actionClass === 'live_scale' ? 'block' : 'hold'
  }

  if (decision === 'unknown') {
    return 'unknown'
  }

  return null
}

const repairActionForReason = (reason: string) => {
  if (reason.includes('dependency_quorum')) return 'restore dependency quorum before material action'
  if (reason.includes('empirical')) return 'refresh Torghut empirical proof'
  if (reason.includes('quant')) return 'resolve or supersede quant evidence debt'
  if (reason.includes('market_context')) return 'refresh Torghut market-context evidence'
  if (reason.includes('controller')) return 'publish a fresh controller-process witness'
  if (reason.includes('watch')) return 'restore control-plane watch reliability'
  if (reason.includes('schema')) return 'align source and applied schema projections'
  return `repair ${reason}`
}

const confidenceFromClock = (clock: ReconciledActionClock | undefined): MaterialActionVerdictConfidence => {
  if (!clock) return 'unknown'
  if (clock.confidence === 'high' || clock.confidence === 'medium' || clock.confidence === 'low') {
    return clock.confidence
  }
  return 'unknown'
}

const worstConfidence = (values: MaterialActionVerdictConfidence[]): MaterialActionVerdictConfidence => {
  const rank: Record<MaterialActionVerdictConfidence, number> = {
    high: 0,
    medium: 1,
    low: 2,
    unknown: 3,
  }
  return values.reduce<MaterialActionVerdictConfidence>(
    (current, value) => (rank[value] > rank[current] ? value : current),
    'high',
  )
}

const minIsoTimestamp = (values: string[], fallback: string) => {
  const valid = values
    .map((value) => Date.parse(value))
    .filter((value) => !Number.isNaN(value))
    .sort((left, right) => left - right)
  return valid.length > 0 ? new Date(valid[0] ?? Date.parse(fallback)).toISOString() : fallback
}

const dependencySignal = (input: {
  now: Date
  actionClass: ActionSloBudgetActionClass
  dependencyQuorum: DependencyQuorumStatus
}): DecisionSignal | null => {
  const decision = dependencyQuorumDecisionForAction(input.dependencyQuorum.decision, input.actionClass)
  if (!decision) return null

  const reasons = uniqueStrings(
    input.dependencyQuorum.reasons.length > 0
      ? input.dependencyQuorum.reasons
      : [`dependency_quorum_${input.dependencyQuorum.decision}`],
  )

  return {
    source: 'dependency_quorum',
    decision,
    evidenceRefs: reasons.map((reason) => `dependency_quorum:${reason}`),
    blockingReasons: decision === 'repair_only' ? [] : reasons,
    downgradeReasons: decision === 'repair_only' ? reasons : [],
    requiredRepairs: reasons.map(repairActionForReason),
    rollbackTarget:
      decision === 'block' || decision === 'hold' || decision === 'unknown'
        ? 'hold material action until dependency quorum is current'
        : null,
    allowedUntil: defaultAllowedUntil(input.now),
    maxDispatches: decision === 'repair_only' ? 1 : 0,
    maxRuntimeSeconds: decision === 'repair_only' ? 20 * 60 : 0,
    maxNotional: decision === 'allow' ? null : 0,
    confidence: input.dependencyQuorum.decision === 'unknown' ? 'unknown' : 'high',
  }
}

const budgetSignal = (budget: ActionSloBudget | undefined, actionClass: ActionSloBudgetActionClass): DecisionSignal => {
  if (!budget) {
    return {
      source: 'action_slo_budget',
      decision: 'unknown',
      evidenceRefs: [`action_slo_budget:${actionClass}:missing`],
      blockingReasons: ['action_slo_budget_missing'],
      downgradeReasons: [],
      requiredRepairs: ['restore action SLO budget projection'],
      rollbackTarget: 'keep material-action verdicts in shadow mode until action SLO budgets are current',
      allowedUntil: null,
      maxDispatches: 0,
      maxRuntimeSeconds: 0,
      maxNotional: 0,
      confidence: 'unknown',
    }
  }

  const decision = verdictDecisionFromBudget(budget.decision)
  return {
    source: 'action_slo_budget',
    decision,
    evidenceRefs: [budget.budget_id, budget.router_epoch_id, ...budget.evidence_refs],
    blockingReasons: decision === 'repair_only' ? [] : budget.blocked_reasons,
    downgradeReasons:
      decision === 'repair_only'
        ? uniqueStrings([...budget.downgrade_reasons, ...budget.blocked_reasons])
        : budget.downgrade_reasons,
    requiredRepairs: budget.required_repairs,
    rollbackTarget: budget.rollback_target,
    allowedUntil: budget.fresh_until,
    maxDispatches: budget.max_dispatches,
    maxRuntimeSeconds: budget.max_runtime_seconds,
    maxNotional: budget.max_notional,
    confidence: 'high',
  }
}

const clockSignal = (
  clock: ReconciledActionClock | undefined,
  actionClass: ActionSloBudgetActionClass,
): DecisionSignal => {
  if (!clock) {
    return {
      source: 'action_clock',
      decision: 'unknown',
      evidenceRefs: [`action_clock:${clockActionForBudget(actionClass)}:missing`],
      blockingReasons: ['action_clock_missing'],
      downgradeReasons: [],
      requiredRepairs: ['restore reconciled action clock projection'],
      rollbackTarget: 'keep material-action verdicts in shadow mode until action clocks are current',
      allowedUntil: null,
      maxDispatches: 0,
      maxRuntimeSeconds: 0,
      maxNotional: 0,
      confidence: 'unknown',
    }
  }

  const decision = verdictDecisionFromClock(clock.decision)
  return {
    source: 'action_clock',
    decision,
    evidenceRefs: [clock.clock_id, ...clock.evidence_refs],
    blockingReasons: decision === 'repair_only' ? [] : clock.blocking_reason_codes,
    downgradeReasons: decision === 'repair_only' ? clock.blocking_reason_codes : [],
    requiredRepairs: clock.required_repair_actions,
    rollbackTarget: clock.rollback_target,
    allowedUntil: clock.fresh_until,
    maxDispatches: null,
    maxRuntimeSeconds: null,
    maxNotional: null,
    confidence: confidenceFromClock(clock),
  }
}

const sourceRolloutTruthSignal = (
  exchange: SourceRolloutTruthExchange | undefined,
  actionClass: ActionSloBudgetActionClass,
): DecisionSignal | null => {
  if (!exchange) return null
  const receipt = exchange.receipts.find((entry) => entry.action_class === actionClass)
  if (!receipt) return null

  const decision = sourceRolloutTruthVerdictDecision(receipt.action_decision)
  const reasons =
    receipt.blocking_reasons.length > 0
      ? receipt.blocking_reasons
      : receipt.settlement_state === 'converged'
        ? []
        : [receipt.settlement_state]

  return {
    source: 'source_rollout_truth_exchange',
    decision,
    evidenceRefs: uniqueStrings([
      SOURCE_ROLLOUT_TRUTH_EXCHANGE_DESIGN_ARTIFACT,
      exchange.exchange_id,
      receipt.receipt_id,
    ]),
    blockingReasons: decision === 'repair_only' ? [] : reasons,
    downgradeReasons: decision === 'repair_only' ? reasons : [],
    requiredRepairs: reasons.map(repairActionForReason),
    rollbackTarget: receipt.rollback_target,
    allowedUntil: receipt.fresh_until,
    maxDispatches: decision === 'allow' ? null : decision === 'repair_only' ? 1 : 0,
    maxRuntimeSeconds: decision === 'allow' ? null : decision === 'repair_only' ? 20 * 60 : 0,
    maxNotional: decision === 'allow' ? null : 0,
    confidence: decision === 'allow' ? 'high' : receipt.settlement_state === 'unknown' ? 'unknown' : 'medium',
  }
}

const repairWarrantExchangeSignal = (
  exchange: RepairWarrantExchange | undefined,
  actionClass: ActionSloBudgetActionClass,
): DecisionSignal | null => {
  if (!exchange) return null

  const activeWarrants = exchange.active_warrants
  const expiredWarrants = exchange.expired_warrants
  const activeReasons = uniqueStrings(activeWarrants.flatMap((warrant) => warrant.reason_codes))
  const expiredReasons = uniqueStrings(expiredWarrants.flatMap((warrant) => warrant.reason_codes))
  const closureRequirements = uniqueStrings(activeWarrants.flatMap((warrant) => warrant.closure_requirements))
  const firebreak = exchange.schedule_debt_window.firebreak_state === 'observe_only'
  const warrantRefs = uniqueStrings([
    REPAIR_WARRANT_EXCHANGE_DESIGN_ARTIFACT,
    exchange.exchange_id,
    ...activeWarrants.map((warrant) => warrant.warrant_id),
    ...expiredWarrants.map((warrant) => warrant.warrant_id),
  ])
  const base = {
    source: 'repair_warrant_exchange' as const,
    evidenceRefs: warrantRefs,
    rollbackTarget: exchange.rollback_target,
    allowedUntil: exchange.fresh_until,
    maxNotional: 0,
  }

  if (actionClass === 'dispatch_repair') {
    if (expiredWarrants.length > 0 && activeWarrants.length === 0) {
      return {
        ...base,
        decision: 'hold',
        blockingReasons: uniqueStrings(['repair_warrant_expired', ...expiredReasons]),
        downgradeReasons: [],
        requiredRepairs: ['restore watch reliability before admitting bounded repair warrants'],
        maxDispatches: 0,
        maxRuntimeSeconds: 0,
        confidence: 'medium',
      }
    }
    if (activeWarrants.some((warrant) => warrant.admission_state === 'observe_only') || firebreak) {
      return {
        ...base,
        decision: 'repair_only',
        blockingReasons: [],
        downgradeReasons: uniqueStrings([
          ...(firebreak ? ['schedule_debt_firebreak_observe_only'] : []),
          ...activeReasons,
        ]),
        requiredRepairs: closureRequirements,
        maxDispatches: 0,
        maxRuntimeSeconds: 0,
        confidence: 'medium',
      }
    }
    const admittedWarrants = activeWarrants.filter((warrant) => warrant.admission_state === 'admitted')
    if (admittedWarrants.length > 0) {
      return {
        ...base,
        decision: 'allow',
        blockingReasons: [],
        downgradeReasons: [],
        requiredRepairs: closureRequirements,
        maxDispatches: Math.min(...admittedWarrants.map((warrant) => warrant.max_dispatches)),
        maxRuntimeSeconds: Math.min(...admittedWarrants.map((warrant) => warrant.max_runtime_seconds)),
        confidence: 'high',
      }
    }
    return null
  }

  if (actionClass === 'dispatch_normal' && firebreak) {
    return {
      ...base,
      decision: 'repair_only',
      blockingReasons: [],
      downgradeReasons: ['schedule_debt_firebreak_observe_only'],
      requiredRepairs: ['let the schedule debt window clear before normal dispatch'],
      maxDispatches: 0,
      maxRuntimeSeconds: 0,
      confidence: 'medium',
    }
  }

  if (actionClass === 'torghut_observe' && (activeWarrants.length > 0 || expiredWarrants.length > 0)) {
    return {
      ...base,
      decision: 'allow',
      blockingReasons: [],
      downgradeReasons: [],
      requiredRepairs: closureRequirements,
      maxDispatches: null,
      maxRuntimeSeconds: null,
      confidence: 'high',
    }
  }

  if (actionClass === 'paper_canary' && activeWarrants.length > 0) {
    return {
      ...base,
      decision: 'hold',
      blockingReasons: ['repair_warrant_open'],
      downgradeReasons: [],
      requiredRepairs: closureRequirements,
      rollbackTarget: 'keep paper canary shadow-only until the matching repair warrant closes in a fresh epoch',
      maxDispatches: 0,
      maxRuntimeSeconds: 0,
      confidence: 'medium',
    }
  }

  if ((actionClass === 'live_micro_canary' || actionClass === 'live_scale') && activeWarrants.length > 0) {
    return {
      ...base,
      decision: 'block',
      blockingReasons: ['repair_warrant_open'],
      downgradeReasons: [],
      requiredRepairs: closureRequirements,
      rollbackTarget: 'keep live capital closed until paper settlement consumes closed repair warrant evidence',
      maxDispatches: 0,
      maxRuntimeSeconds: 0,
      confidence: 'high',
    }
  }

  return null
}

const contradictionRefsForSignals = (input: {
  actionClass: ActionSloBudgetActionClass
  budget: ActionSloBudget | undefined
  clock: ReconciledActionClock | undefined
}) => {
  if (!input.budget || !input.clock) return []
  const budgetDecision = verdictDecisionFromBudget(input.budget.decision)
  const clockDecision = verdictDecisionFromClock(input.clock.decision)
  if (budgetDecision === clockDecision) return []
  if (budgetDecision === 'allow' || clockDecision === 'allow') {
    return [
      `material_action_contradiction:${input.actionClass}:budget_${budgetDecision}:clock_${clockDecision}:${
        input.budget.budget_id
      }:${input.clock.clock_id}`,
    ]
  }
  return []
}

const strictestSignal = (signals: DecisionSignal[]) =>
  signals.reduce((current, signal) =>
    decisionRank(signal.decision) > decisionRank(current.decision) ? signal : current,
  )

const tightestCap = (values: Array<number | null>) => {
  const numericValues = values.filter((value): value is number => value !== null)
  return numericValues.length > 0 ? Math.min(...numericValues) : null
}

const tightestCaps = (signals: DecisionSignal[]) => ({
  maxDispatches: tightestCap(signals.map((signal) => signal.maxDispatches)),
  maxRuntimeSeconds: tightestCap(signals.map((signal) => signal.maxRuntimeSeconds)),
  maxNotional: tightestCap(signals.map((signal) => signal.maxNotional)),
})

const valueForDecision = <T>(decision: MaterialActionVerdictDecision, value: T | null, blockedValue: T | null) =>
  decision === 'hold' || decision === 'block' || decision === 'contradicted' || decision === 'unknown'
    ? blockedValue
    : value

const buildVerdict = (input: {
  now: Date
  epochId: string
  actionClass: ActionSloBudgetActionClass
  budget: ActionSloBudget | undefined
  clock: ReconciledActionClock | undefined
  dependencyQuorum: DependencyQuorumStatus
  negativeEvidenceRouter: NegativeEvidenceRouterStatus
  controllerWitness: ControlPlaneControllerWitnessQuorum
  sourceRolloutTruthExchange?: SourceRolloutTruthExchange
  repairWarrantExchange?: RepairWarrantExchange
}): MaterialActionVerdict => {
  const budget = budgetSignal(input.budget, input.actionClass)
  const clock = clockSignal(input.clock, input.actionClass)
  const dependency = dependencySignal({
    now: input.now,
    actionClass: input.actionClass,
    dependencyQuorum: input.dependencyQuorum,
  })
  const sourceRolloutTruth = sourceRolloutTruthSignal(input.sourceRolloutTruthExchange, input.actionClass)
  const repairWarrant = repairWarrantExchangeSignal(input.repairWarrantExchange, input.actionClass)
  const signals = [
    ...(repairWarrant && input.actionClass === 'dispatch_repair' ? [repairWarrant] : []),
    budget,
    clock,
    ...(dependency ? [dependency] : []),
    ...(sourceRolloutTruth ? [sourceRolloutTruth] : []),
    ...(repairWarrant && input.actionClass !== 'dispatch_repair' ? [repairWarrant] : []),
  ]
  const strictest = strictestSignal(signals)
  const caps = tightestCaps(signals)
  const contradictionRefs = contradictionRefsForSignals({
    actionClass: input.actionClass,
    budget: input.budget,
    clock: input.clock,
  })
  const allReasons = uniqueStrings([
    ...signals.flatMap((signal) => signal.blockingReasons),
    ...signals.flatMap((signal) => signal.downgradeReasons),
  ])
  const decision = strictest.decision
  const allowedUntil = minIsoTimestamp(
    signals.map((signal) => signal.allowedUntil).filter((value): value is string => Boolean(value)),
    defaultAllowedUntil(input.now),
  )
  const evidenceRefs = uniqueStrings([
    MATERIAL_ACTION_VERDICT_DESIGN_ARTIFACT,
    input.negativeEvidenceRouter.router_epoch_id,
    input.controllerWitness.quorum_id,
    ...signals.flatMap((signal) => signal.evidenceRefs),
    ...contradictionRefs,
  ])
  const verdictId = `material-action-verdict:${input.actionClass}:${hashJson({
    epoch_id: input.epochId,
    action_class: input.actionClass,
    decision,
    reasons: allReasons,
    evidence_refs: evidenceRefs,
  })}`

  return {
    verdict_id: verdictId,
    epoch_id: input.epochId,
    action_class: input.actionClass,
    decision,
    decision_rank: decisionRank(decision),
    confidence: worstConfidence(signals.map((signal) => signal.confidence)),
    allowed_until: allowedUntil,
    max_dispatches: valueForDecision(decision, caps.maxDispatches ?? strictest.maxDispatches ?? null, 0),
    max_runtime_seconds: valueForDecision(decision, caps.maxRuntimeSeconds ?? strictest.maxRuntimeSeconds ?? null, 0),
    max_notional: decision === 'allow' ? (caps.maxNotional ?? strictest.maxNotional ?? 0) : 0,
    blocking_reason_codes:
      decision === 'repair_only'
        ? []
        : uniqueStrings([
            ...signals.flatMap((signal) => signal.blockingReasons),
            ...(decision === 'unknown' ? ['material_action_verdict_unknown'] : []),
          ]),
    downgrade_reason_codes:
      decision === 'repair_only'
        ? uniqueStrings(signals.flatMap((signal) => [...signal.downgradeReasons, ...signal.blockingReasons]))
        : uniqueStrings(signals.flatMap((signal) => signal.downgradeReasons)),
    required_repair_actions: uniqueStrings([
      ...signals.flatMap((signal) => signal.requiredRepairs),
      ...allReasons.map(repairActionForReason),
    ]),
    rollback_target:
      strictest.rollbackTarget ??
      input.budget?.rollback_target ??
      input.clock?.rollback_target ??
      input.controllerWitness.rollback_target ??
      (decision === 'allow' ? null : 'keep verdicts in shadow mode and repair blocking evidence'),
    evidence_refs: evidenceRefs,
    contradiction_refs: contradictionRefs,
  }
}

const buildEpochId = (input: {
  namespace: string
  dependencyQuorum: DependencyQuorumStatus
  negativeEvidenceRouter: NegativeEvidenceRouterStatus
  budgets: ActionSloBudget[]
  clocks: ReconciledActionClock[]
  controllerWitness: ControlPlaneControllerWitnessQuorum
  sourceRolloutTruthExchange?: SourceRolloutTruthExchange
  repairWarrantExchange?: RepairWarrantExchange
}) =>
  `material-action-verdict:${hashJson({
    namespace: input.namespace,
    producer_revision: PRODUCER_REVISION,
    dependency_quorum: {
      decision: input.dependencyQuorum.decision,
      reasons: input.dependencyQuorum.reasons,
    },
    router_epoch_id: input.negativeEvidenceRouter.router_epoch_id,
    budget_ids: input.budgets.map((budget) => budget.budget_id).sort(),
    clock_ids: input.clocks.map((clock) => clock.clock_id).sort(),
    controller_witness_quorum_id: input.controllerWitness.quorum_id,
    source_rollout_truth_exchange_id: input.sourceRolloutTruthExchange?.exchange_id ?? null,
    source_rollout_truth_receipt_ids:
      input.sourceRolloutTruthExchange?.receipts.map((receipt) => receipt.receipt_id).sort() ?? [],
    repair_warrant_exchange_id: input.repairWarrantExchange?.exchange_id ?? null,
    repair_warrant_ids: input.repairWarrantExchange?.active_warrants.map((warrant) => warrant.warrant_id).sort() ?? [],
  })}`

export const buildMaterialActionVerdictEpoch = (input: MaterialActionVerdictInput): MaterialActionVerdictEpoch => {
  const budgetByAction = new Map(input.actionSloBudgets.map((budget) => [budget.action_class, budget]))
  const clockByAction = new Map(input.reconciledActionClocks.map((clock) => [clock.action_class, clock]))
  const actionClasses = uniqueStrings(
    input.actionSloBudgets.map((budget) => budget.action_class),
  ) as ActionSloBudgetActionClass[]
  const epochId = buildEpochId({
    namespace: input.namespace,
    dependencyQuorum: input.dependencyQuorum,
    negativeEvidenceRouter: input.negativeEvidenceRouter,
    budgets: input.actionSloBudgets,
    clocks: input.reconciledActionClocks,
    controllerWitness: input.controllerWitness,
    sourceRolloutTruthExchange: input.sourceRolloutTruthExchange,
    repairWarrantExchange: input.repairWarrantExchange,
  })
  const finalVerdicts = actionClasses.map((actionClass) =>
    buildVerdict({
      now: input.now,
      epochId,
      actionClass,
      budget: budgetByAction.get(actionClass),
      clock: clockByAction.get(clockActionForBudget(actionClass)),
      dependencyQuorum: input.dependencyQuorum,
      negativeEvidenceRouter: input.negativeEvidenceRouter,
      controllerWitness: input.controllerWitness,
      sourceRolloutTruthExchange: input.sourceRolloutTruthExchange,
      repairWarrantExchange: input.repairWarrantExchange,
    }),
  )
  const contradictionRefs = uniqueStrings(finalVerdicts.flatMap((verdict) => verdict.contradiction_refs)).sort()
  const expiresAt = minIsoTimestamp(
    finalVerdicts.map((verdict) => verdict.allowed_until),
    defaultAllowedUntil(input.now),
  )
  const torghutCapitalClock = clockByAction.get('torghut_capital')

  return {
    mode: 'shadow',
    design_artifact: MATERIAL_ACTION_VERDICT_DESIGN_ARTIFACT,
    epoch_id: epochId,
    generated_at: input.now.toISOString(),
    expires_at: expiresAt,
    namespace: input.namespace,
    producer_revision: PRODUCER_REVISION,
    dependency_quorum_ref: `dependency_quorum:${input.dependencyQuorum.decision}:${
      input.dependencyQuorum.reasons.join(',') || 'none'
    }`,
    negative_evidence_router_epoch_ref: input.negativeEvidenceRouter.router_epoch_id,
    action_slo_budget_refs: input.actionSloBudgets.map((budget) => budget.budget_id).sort(),
    action_clock_refs: input.reconciledActionClocks.map((clock) => clock.clock_id).sort(),
    rollout_health_ref: `rollout:${input.rolloutHealth.status}:${input.rolloutHealth.observed_deployments}:${
      input.rolloutHealth.degraded_deployments
    }`,
    controller_witness_ref: input.controllerWitness.quorum_id,
    watch_reliability_ref: `watch:${input.watchReliability.status}:${input.watchReliability.total_events}:${
      input.watchReliability.total_errors
    }:${input.watchReliability.total_restarts}`,
    database_projection_ref: `database:${input.database.status}:${input.database.migration_consistency.status}`,
    empirical_services_ref: `empirical:forecast=${input.empiricalServices.forecast.status}:lean=${
      input.empiricalServices.lean.status
    }:jobs=${input.empiricalServices.jobs.status}`,
    torghut_capital_ref: torghutCapitalClock?.clock_id ?? null,
    contradiction_refs: contradictionRefs,
    final_verdicts: finalVerdicts,
  }
}
