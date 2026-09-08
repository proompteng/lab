import { createHash } from 'node:crypto'

import type {
  ActionSloBudgetActionClass,
  AlphaClosureCarry,
  MaterialGateActionDecision,
  MaterialGateDigest,
  MaterialGateDigestDecision,
  MaterialGateDigestReadiness,
  RepairBidAdmissionState,
  WorkflowsReliabilityStatus,
} from '~/server/control-plane-status-types'
import type { TorghutConsumerEvidenceStatus } from '~/server/control-plane-torghut-consumer-evidence'

export const MATERIAL_GATE_DIGEST_DESIGN_ARTIFACT =
  'docs/agents/designs/198-jangar-material-gate-digest-and-alpha-closure-carry-2026-05-14.md'

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

const ZERO_NOTIONAL_TEXT = new Set(['0', '0.0', '0.00', '0.0000'])
const AVAILABLE_NO_DELTA_STATES = new Set(['available', 'open', 'ready', 'remaining', 'unused'])
const REPAIR_ONLY_STATES = new Set(['repair', 'repair_only', 'hold', 'blocked', 'degraded'])

export type BuildMaterialGateDigestInput = {
  now: Date
  namespace: string
  servingReadiness: MaterialGateDigest['serving_readiness']
  businessState: string | null
  revenueReady: boolean | null
  affectedValueGate: string | null
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
  repairBidAdmission: RepairBidAdmissionState
  fullStatusAvailable?: boolean
  producerRevision?: string | null
  rolloutTruthRef?: string | null
  databaseWitnessRef?: string | null
  workflows?: Pick<WorkflowsReliabilityStatus, 'recent_failed_jobs' | 'backoff_limit_exceeded_jobs'> | null
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
  if (ZERO_NOTIONAL_TEXT.has(value)) return true
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed === 0
}

const digestFreshUntil = (input: BuildMaterialGateDigestInput) => {
  const futureTimes = [
    input.torghutConsumerEvidence.fresh_until,
    input.torghutConsumerEvidence.alpha_closure_dividend_slo?.fresh_until,
    input.torghutConsumerEvidence.alpha_repair_closure_board?.fresh_until,
    input.torghutConsumerEvidence.alpha_evidence_foundry?.fresh_until,
    input.repairBidAdmission.fresh_until,
  ]
    .map((value) => parseTimestampMs(value))
    .filter((value): value is number => Boolean(value && value > input.now.getTime()))

  if (futureTimes.length > 0) return new Date(Math.min(...futureTimes)).toISOString()
  return new Date(input.now.getTime() + 60_000).toISOString()
}

const validationRefsForCarry = (input: BuildMaterialGateDigestInput) => {
  const slo = input.torghutConsumerEvidence.alpha_closure_dividend_slo
  if (slo?.validation_commands && slo.validation_commands.length > 0) return slo.validation_commands
  const board = input.torghutConsumerEvidence.alpha_repair_closure_board
  const explicitRefs = board?.validation_commands ?? []
  if (explicitRefs.length > 0) return explicitRefs
  return [`curl -fsS ${input.torghutConsumerEvidence.endpoint} | jq '.alpha_closure_dividend_slo'`]
}

const sourceRefsForCarry = (input: BuildMaterialGateDigestInput) =>
  uniqueStrings([
    input.torghutConsumerEvidence.receipt_id,
    input.torghutConsumerEvidence.alpha_closure_dividend_slo?.slo_id,
    input.torghutConsumerEvidence.alpha_closure_dividend_slo?.source_revenue_repair_ref,
    input.torghutConsumerEvidence.alpha_closure_dividend_slo?.source_board_ref,
    input.torghutConsumerEvidence.alpha_closure_dividend_slo?.source_settlement_market_ref,
    input.torghutConsumerEvidence.alpha_repair_closure_board?.board_id,
    input.torghutConsumerEvidence.alpha_repair_closure_board?.settlement_market_id,
    input.torghutConsumerEvidence.alpha_evidence_foundry?.foundry_id,
    input.torghutConsumerEvidence.repair_bid_settlement_ledger_id,
    ...input.repairBidAdmission.dispatch_tickets.map((ticket) => ticket.ticket_id),
  ])

const launchableRepairTickets = (input: BuildMaterialGateDigestInput) =>
  input.repairBidAdmission.dispatch_tickets.filter(
    (ticket) =>
      ticket.launch_allowed && ticket.target_value_gate === 'routeable_candidate_count' && ticket.max_notional === 0,
  )

const alphaClosureCarryDecision = (
  input: BuildMaterialGateDigestInput,
): Pick<AlphaClosureCarry, 'decision' | 'reason_codes'> => {
  const slo = input.torghutConsumerEvidence.alpha_closure_dividend_slo
  if (slo) {
    const reasons: string[] = []
    if (!isFresh(slo.fresh_until, input.now)) reasons.push('alpha_closure_dividend_slo_stale')
    if (slo.selected_value_gate !== 'routeable_candidate_count') reasons.push('alpha_closure_wrong_value_gate')
    if (!slo.required_settlement_receipt) reasons.push('alpha_closure_settlement_receipt_missing')
    if (!isZeroNotional(slo.max_notional)) reasons.push('alpha_closure_notional_nonzero')
    if (slo.capital_rule && slo.capital_rule !== 'zero_notional_repair_only') {
      reasons.push('alpha_closure_capital_rule_not_zero_notional')
    }
    if (!slo.active_dedupe_key) {
      reasons.push('alpha_closure_active_dedupe_key_missing')
    } else if (input.repairBidAdmission.active_dedupe_keys.includes(slo.active_dedupe_key)) {
      reasons.push('alpha_closure_dedupe_active')
    }

    const dividendState = normalizeReason(slo.dividend_state)
    if (dividendState === 'invalid') reasons.push('alpha_closure_dividend_slo_invalid')
    if (dividendState === 'stale') reasons.push('alpha_closure_dividend_slo_stale')
    if (dividendState === 'no_delta') reasons.push('alpha_closure_no_delta_active')
    if (!dividendState) reasons.push('alpha_closure_dividend_state_missing')

    const repairTickets = launchableRepairTickets(input)
    if (repairTickets.length === 0) reasons.push('repair_bid_dispatch_ticket_missing')

    const noDeltaState = normalizeReason(slo.no_delta_budget_state)
    const noDeltaDebtCount = slo.no_delta_debt_count ?? 0
    if (!noDeltaState) {
      reasons.push('alpha_closure_no_delta_budget_missing')
    } else if (noDeltaState === 'consumed') {
      reasons.push('alpha_closure_no_delta_budget_consumed')
    } else if (!AVAILABLE_NO_DELTA_STATES.has(noDeltaState)) {
      reasons.push(`alpha_closure_no_delta_budget_${noDeltaState}`)
    }
    if (noDeltaDebtCount > 0) reasons.push('alpha_closure_no_delta_debt_active')

    const reasonCodes = uniqueStrings([...reasons, ...(slo.reason_codes ?? [])])
    if (
      reasonCodes.some((reason) =>
        ['alpha_closure_notional_nonzero', 'alpha_closure_dividend_slo_invalid'].includes(reason),
      )
    ) {
      return { decision: 'block', reason_codes: reasonCodes }
    }
    if (
      reasonCodes.some((reason) =>
        [
          'alpha_closure_dedupe_active',
          'alpha_closure_no_delta_active',
          'alpha_closure_no_delta_budget_consumed',
          'alpha_closure_no_delta_debt_active',
        ].includes(reason),
      )
    ) {
      return { decision: 'deny', reason_codes: reasonCodes }
    }
    if (reasonCodes.length > 0 || dividendState !== 'paid') return { decision: 'hold', reason_codes: reasonCodes }
    return { decision: 'allow', reason_codes: [] }
  }

  const board = input.torghutConsumerEvidence.alpha_repair_closure_board
  if (!board) {
    return { decision: 'hold', reason_codes: ['alpha_closure_carry_missing'] }
  }

  const reasons: string[] = []
  if (!isFresh(board.fresh_until, input.now)) reasons.push('alpha_closure_carry_stale')
  if (board.status && !['selected', 'current', 'ready'].includes(board.status)) {
    reasons.push(`alpha_closure_status_${board.status}`)
  }
  if (board.selected_value_gate !== 'routeable_candidate_count') reasons.push('alpha_closure_wrong_value_gate')
  if (!board.required_settlement_receipt) reasons.push('alpha_closure_settlement_receipt_missing')
  if (!isZeroNotional(board.max_notional)) reasons.push('alpha_closure_notional_nonzero')
  if (board.capital_rule && board.capital_rule !== 'zero_notional_repair_only') {
    reasons.push('alpha_closure_capital_rule_not_zero_notional')
  }
  if (!board.active_dedupe_key) {
    reasons.push('alpha_closure_active_dedupe_key_missing')
  } else if (input.repairBidAdmission.active_dedupe_keys.includes(board.active_dedupe_key)) {
    reasons.push('alpha_closure_dedupe_active')
  }

  const repairTickets = launchableRepairTickets(input)
  if (repairTickets.length === 0) reasons.push('repair_bid_dispatch_ticket_missing')

  const noDeltaState = normalizeReason(board.no_delta_budget_state)
  const noDeltaDebtCount = board.no_delta_debt_count ?? 0
  if (!noDeltaState) {
    reasons.push('alpha_closure_no_delta_budget_missing')
  } else if (noDeltaState === 'consumed') {
    reasons.push('alpha_closure_no_delta_budget_consumed')
  } else if (!AVAILABLE_NO_DELTA_STATES.has(noDeltaState)) {
    reasons.push(`alpha_closure_no_delta_budget_${noDeltaState}`)
  }
  if (noDeltaDebtCount > 0) reasons.push('alpha_closure_no_delta_debt_active')

  const reasonCodes = uniqueStrings([...reasons, ...(board.reason_codes ?? [])])
  if (reasonCodes.some((reason) => reason === 'alpha_closure_notional_nonzero')) {
    return { decision: 'block', reason_codes: reasonCodes }
  }
  if (
    reasonCodes.some((reason) =>
      [
        'alpha_closure_dedupe_active',
        'alpha_closure_no_delta_budget_consumed',
        'alpha_closure_no_delta_debt_active',
      ].includes(reason),
    )
  ) {
    return { decision: 'deny', reason_codes: reasonCodes }
  }
  if (reasonCodes.length > 0) return { decision: 'hold', reason_codes: reasonCodes }
  return { decision: 'allow', reason_codes: [] }
}

const buildAlphaClosureCarry = (input: BuildMaterialGateDigestInput): AlphaClosureCarry => {
  const slo = input.torghutConsumerEvidence.alpha_closure_dividend_slo
  const board = input.torghutConsumerEvidence.alpha_repair_closure_board
  const decision = alphaClosureCarryDecision(input)
  return {
    schema_version: 'jangar.alpha-closure-carry.v1',
    source: 'torghut.consumer-evidence',
    slo_id: slo?.slo_id ?? null,
    dividend_state: slo?.dividend_state ?? null,
    board_id: slo?.source_board_ref ?? board?.board_id ?? null,
    settlement_market_id: slo?.source_settlement_market_ref ?? board?.settlement_market_id ?? null,
    selected_hypothesis_id: slo?.selected_hypothesis_id ?? board?.selected_hypothesis_id ?? null,
    selected_value_gate: slo?.selected_value_gate ?? board?.selected_value_gate ?? null,
    required_settlement_receipt: slo?.required_settlement_receipt ?? board?.required_settlement_receipt ?? null,
    active_dedupe_key: slo?.active_dedupe_key ?? board?.active_dedupe_key ?? null,
    routeable_candidate_count_before: slo?.routeable_candidate_count_before ?? null,
    routeable_candidate_count_after: slo?.routeable_candidate_count_after ?? null,
    measured_delta: slo?.measured_delta ?? null,
    no_delta_budget_state: slo?.no_delta_budget_state ?? board?.no_delta_budget_state ?? null,
    no_delta_debt_count: slo?.no_delta_debt_count ?? board?.no_delta_debt_count ?? null,
    next_allowed_attempt_after: slo?.next_allowed_attempt_after ?? board?.next_allowed_attempt_after ?? null,
    max_notional: slo?.max_notional ?? board?.max_notional ?? null,
    capital_rule: slo?.capital_rule ?? board?.capital_rule ?? null,
    decision: decision.decision,
    reason_codes: decision.reason_codes,
    release_conditions: slo?.release_conditions ?? board?.release_conditions ?? [],
    validation_refs: validationRefsForCarry(input),
    rollback_target:
      slo?.rollback_target ??
      board?.rollback_target ??
      'disable material gate digest enforcement and keep Torghut max_notional=0',
  }
}

const repairOnlyReasons = (input: BuildMaterialGateDigestInput) =>
  uniqueStrings([
    input.businessState && REPAIR_ONLY_STATES.has(input.businessState) ? `business_state_${input.businessState}` : null,
    input.revenueReady === false ? 'revenue_ready_false' : null,
    input.affectedValueGate && input.affectedValueGate !== 'routeable_candidate_count'
      ? `affected_value_gate_${input.affectedValueGate}`
      : null,
  ])

const materialActionReasons = (input: BuildMaterialGateDigestInput, actionClass: ActionSloBudgetActionClass) => {
  const reasons = [...repairOnlyReasons(input)]
  if ((actionClass === 'deploy_widen' || actionClass === 'merge_ready') && input.fullStatusAvailable === false) {
    reasons.push('full_status_unavailable')
  }
  return uniqueStrings(reasons)
}

const actionDecisionFor = (input: BuildMaterialGateDigestInput, carry: AlphaClosureCarry) => {
  const sourceRefs = sourceRefsForCarry(input)
  const validationRefs = carry.validation_refs
  const rollbackTarget =
    carry.rollback_target ?? 'disable material gate digest enforcement and keep Torghut max_notional=0'

  return (actionClass: ActionSloBudgetActionClass): MaterialGateActionDecision => {
    if (actionClass === 'serve_readonly') {
      return {
        action_class: actionClass,
        decision: input.servingReadiness === 'down' ? 'block' : 'allow',
        reason_codes: input.servingReadiness === 'down' ? ['serving_readiness_down'] : [],
        source_refs: uniqueStrings([input.torghutConsumerEvidence.receipt_id]),
        validation_refs: [],
        rollback_target: 'keep Kubernetes readiness probes as the serving-readiness source of truth',
      }
    }

    if (actionClass === 'torghut_observe') {
      const current = input.torghutConsumerEvidence.status === 'current'
      return {
        action_class: actionClass,
        decision: current ? 'allow' : 'hold',
        reason_codes: current ? [] : [`torghut_consumer_evidence_${input.torghutConsumerEvidence.status}`],
        source_refs: uniqueStrings([input.torghutConsumerEvidence.receipt_id]),
        validation_refs: [`curl -fsS ${input.torghutConsumerEvidence.endpoint} | jq '.route_proven_profit_receipt'`],
        rollback_target: 'fall back to Torghut /readyz and keep max_notional=0',
      }
    }

    if (actionClass === 'dispatch_repair') {
      return {
        action_class: actionClass,
        decision: carry.decision,
        reason_codes: carry.reason_codes,
        source_refs: sourceRefs,
        validation_refs: validationRefs,
        rollback_target: rollbackTarget,
      }
    }

    const reasons = materialActionReasons(input, actionClass)
    let decision: MaterialGateDigestDecision = reasons.length > 0 ? 'hold' : 'allow'
    if (actionClass === 'live_micro_canary' || actionClass === 'live_scale') {
      decision = reasons.length > 0 ? 'block' : 'allow'
    }

    return {
      action_class: actionClass,
      decision,
      reason_codes: reasons,
      source_refs: sourceRefs,
      validation_refs: [],
      rollback_target:
        'keep material actions held and require full status plus Torghut repair evidence before widening',
    }
  }
}

const materialReadinessFor = (
  input: BuildMaterialGateDigestInput,
  decisions: MaterialGateActionDecision[],
): MaterialGateDigestReadiness => {
  if (input.servingReadiness === 'down') return 'block'
  if (input.businessState === 'repair_only' || input.revenueReady === false) return 'repair_only'
  if (decisions.some((decision) => decision.decision === 'block')) return 'block'
  if (decisions.some((decision) => decision.decision === 'deny' || decision.decision === 'hold')) return 'hold'
  return 'allow'
}

export const buildMaterialGateDigest = (input: BuildMaterialGateDigestInput): MaterialGateDigest => {
  const carry = buildAlphaClosureCarry(input)
  const buildActionDecision = actionDecisionFor(input, carry)
  const actionDecisions = ACTION_CLASSES.map((actionClass) => buildActionDecision(actionClass))
  const materialReadiness = materialReadinessFor(input, actionDecisions)
  const freshUntil = digestFreshUntil(input)
  const reasonCodes = uniqueStrings([
    ...carry.reason_codes,
    ...actionDecisions.flatMap((decision) => decision.reason_codes),
  ])

  return {
    schema_version: 'jangar.material-gate-digest.v1',
    digest_id: `material-gate-digest:${hashJson({
      generated_at: input.now.toISOString(),
      namespace: input.namespace,
      serving_readiness: input.servingReadiness,
      material_readiness: materialReadiness,
      alpha_closure_carry: carry,
      action_class_decisions: actionDecisions.map((decision) => ({
        action_class: decision.action_class,
        decision: decision.decision,
        reason_codes: decision.reason_codes,
      })),
    })}`,
    generated_at: input.now.toISOString(),
    fresh_until: freshUntil,
    mode: 'observe',
    design_artifact: MATERIAL_GATE_DIGEST_DESIGN_ARTIFACT,
    producer_revision: input.producerRevision ?? null,
    namespace: input.namespace,
    serving_readiness: input.servingReadiness,
    material_readiness: materialReadiness,
    action_class_decisions: actionDecisions,
    alpha_closure_carry: carry,
    alpha_evidence_foundry_ref: input.torghutConsumerEvidence.alpha_evidence_foundry ?? null,
    rollout_truth_ref: input.rolloutTruthRef ?? null,
    database_witness_ref: input.databaseWitnessRef ?? null,
    runner_debt_summary: {
      recent_failed_jobs: input.workflows?.recent_failed_jobs ?? null,
      backoff_limit_exceeded_jobs: input.workflows?.backoff_limit_exceeded_jobs ?? null,
      source: input.workflows ? 'control_plane_workflows' : 'not_collected_on_ready_hot_path',
    },
    reason_codes: reasonCodes,
    rollback_target: 'ignore material_gate_digest consumers and keep existing admission reducers in control',
  }
}
