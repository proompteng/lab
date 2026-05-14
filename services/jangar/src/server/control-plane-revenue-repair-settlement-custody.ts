import { createHash } from 'node:crypto'

import type {
  ActionSloBudgetActionClass,
  ReadyTruthActionDecision,
  ReadyTruthArbiterMode,
  RevenueRepairSettlementCustody,
  RevenueRepairSettlementCustodyDecision,
  SourceServingContractVerdict,
  SourceServingContractVerdictExchange,
  StageCreditAccount,
  StageCreditLedger,
  TorghutConsumerEvidenceStatus,
  TorghutRevenueRepairQueueItem,
} from '~/data/agents-control-plane'
import type { ControlPlaneRolloutHealth } from '~/server/control-plane-status-types'

export const REVENUE_REPAIR_SETTLEMENT_CUSTODY_DESIGN_ARTIFACT =
  'docs/agents/designs/200-jangar-revenue-repair-settlement-conveyor-and-stage-health-custody-2026-05-14.md'

const SCHEMA_VERSION = 'jangar.revenue-repair-settlement-custody.v1' as const
const DEFAULT_TTL_SECONDS = 60
const ROLLBACK_TARGET = 'JANGAR_REVENUE_REPAIR_SETTLEMENT_CUSTODY_MODE=observe and keep Torghut max_notional=0'
const ZERO_NOTIONAL_VALUES = new Set(['0', '0.0', '0.00', '0.0000'])
const CONVEYOR_ALLOW_STATUSES = new Set(['current', 'ready', 'selected', 'selecting', 'settling'])
const CONVEYOR_HOLD_STATUSES = new Set(['blocked', 'missing', 'observing', 'pending'])

export type BuildRevenueRepairSettlementCustodyInput = {
  now: Date
  namespace: string
  rolloutHealth: ControlPlaneRolloutHealth
  sourceServingContractVerdictExchange: SourceServingContractVerdictExchange
  stageCreditLedger: StageCreditLedger | null
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
}

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const addSeconds = (value: Date, seconds: number) => new Date(value.getTime() + seconds * 1000)

const normalizeReason = (value: string | null | undefined) =>
  value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_') ?? null

const uniqueStrings = (values: Array<string | null | undefined>) => [...new Set(values.filter(Boolean) as string[])]

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

const topRepairQueueItem = (status: TorghutConsumerEvidenceStatus): TorghutRevenueRepairQueueItem | null =>
  status.revenue_repair_queue?.[0] ?? null

const isTopAlphaRepair = (item: TorghutRevenueRepairQueueItem | null) =>
  item?.code === 'repair_alpha_readiness' || item?.reason === 'alpha_readiness_not_promotion_eligible'

const stageAccountFor = (
  stageCreditLedger: StageCreditLedger | null,
  actionClass: ActionSloBudgetActionClass,
): StageCreditAccount | null =>
  stageCreditLedger?.stage_accounts.find((account) => account.action_class === actionClass) ?? null

const sourceVerdictFor = (
  exchange: SourceServingContractVerdictExchange,
  actionClass: ActionSloBudgetActionClass,
): SourceServingContractVerdict | null =>
  exchange.verdicts.find((verdict) => verdict.action_class === actionClass) ?? null

const normalizeDecision = (value: string | null | undefined): ReadyTruthActionDecision | null => {
  const normalized = normalizeReason(value)
  if (normalized === 'allow' || normalized === 'repair_only' || normalized === 'hold' || normalized === 'block') {
    return normalized
  }
  return null
}

const freshUntilFor = (input: BuildRevenueRepairSettlementCustodyInput) => {
  const times = [
    input.torghutConsumerEvidence.fresh_until,
    input.torghutConsumerEvidence.alpha_readiness_settlement_conveyor?.fresh_until,
    input.stageCreditLedger?.fresh_until,
    input.sourceServingContractVerdictExchange.fresh_until,
  ]
    .map((value) => parseTimestampMs(value))
    .filter((value): value is number => Boolean(value && value > input.now.getTime()))

  if (times.length > 0) return new Date(Math.min(...times)).toISOString()
  return addSeconds(input.now, DEFAULT_TTL_SECONDS).toISOString()
}

const stageHealth = (input: BuildRevenueRepairSettlementCustodyInput) => {
  const account = stageAccountFor(input.stageCreditLedger, 'dispatch_repair')
  if (!input.stageCreditLedger) {
    return {
      dispatchRepairDecision: null,
      reasonCodes: ['stage_credit_ledger_missing'],
      evidenceRefs: [] as string[],
    }
  }
  if (!account) {
    return {
      dispatchRepairDecision: null,
      reasonCodes: ['stage_credit_dispatch_repair_account_missing'],
      evidenceRefs: [input.stageCreditLedger.ledger_id],
    }
  }
  const acceptable = account.decision === 'allow' || account.decision === 'repair_only'
  return {
    dispatchRepairDecision: account.decision,
    reasonCodes: acceptable ? [] : uniqueStrings([`stage_credit_${account.decision}`, ...account.reason_codes]),
    evidenceRefs: uniqueStrings([input.stageCreditLedger.ledger_id, account.account_id, ...account.evidence_refs]),
  }
}

const rolloutProof = (input: BuildRevenueRepairSettlementCustodyInput) => {
  const verdict = sourceVerdictFor(input.sourceServingContractVerdictExchange, 'dispatch_repair')
  const sourceDecision = normalizeDecision(verdict?.decision)
  const reasons = uniqueStrings([
    input.rolloutHealth.status === 'healthy' ? null : `rollout_health_${input.rolloutHealth.status}`,
    !verdict ? 'source_serving_dispatch_repair_verdict_missing' : null,
    verdict && verdict.decision !== 'allow' && verdict.decision !== 'repair_only'
      ? `source_serving_${verdict.decision}`
      : null,
    ...(verdict?.blocking_reason_codes ?? []),
  ])
  return {
    sourceDecision,
    sourceServingVerdictRef: verdict?.verdict_id ?? null,
    reasonCodes: reasons,
    evidenceRefs: uniqueStrings([input.sourceServingContractVerdictExchange.exchange_id, verdict?.verdict_id]),
  }
}

const conveyorReasons = (input: BuildRevenueRepairSettlementCustodyInput) => {
  const torghut = input.torghutConsumerEvidence
  const conveyor = torghut.alpha_readiness_settlement_conveyor ?? null
  const topItem = topRepairQueueItem(torghut)
  const reasons: string[] = []

  if (torghut.status !== 'current') reasons.push(`torghut_consumer_evidence_${torghut.status}`)
  if (torghut.revenue_repair_business_state !== 'repair_only') {
    reasons.push(`business_state_${torghut.revenue_repair_business_state ?? 'missing'}`)
  }
  if (!topItem) {
    reasons.push('revenue_repair_top_item_missing')
  } else if (!isTopAlphaRepair(topItem)) {
    reasons.push('revenue_repair_top_item_not_alpha_readiness')
  }
  if (!conveyor) {
    reasons.push('alpha_readiness_settlement_conveyor_missing')
    return uniqueStrings(reasons)
  }
  if (!conveyor.conveyor_id) reasons.push('alpha_readiness_settlement_conveyor_ref_missing')
  if (!isFresh(conveyor.fresh_until, input.now)) reasons.push('alpha_readiness_settlement_conveyor_stale')
  if (conveyor.selected_value_gate !== 'routeable_candidate_count') {
    reasons.push(`selected_value_gate_${conveyor.selected_value_gate ?? 'missing'}`)
  }
  if (!isZeroNotional(conveyor.max_notional)) reasons.push('capital_notional_nonzero')
  if (conveyor.capital_rule && conveyor.capital_rule !== 'zero_notional_repair_only') {
    reasons.push('capital_rule_not_zero_notional_repair_only')
  }
  if ((conveyor.active_no_delta_lease_count ?? 0) > 0 || conveyor.repeat_launch_decision === 'deny') {
    reasons.push('active_no_delta_lease')
  }

  const conveyorStatus = conveyor.status ?? 'missing'
  if (CONVEYOR_HOLD_STATUSES.has(conveyorStatus)) {
    reasons.push(`alpha_readiness_settlement_conveyor_${conveyorStatus}`)
  } else if (!CONVEYOR_ALLOW_STATUSES.has(conveyorStatus)) {
    reasons.push(`alpha_readiness_settlement_conveyor_${conveyorStatus}`)
  }

  return uniqueStrings([...reasons, ...conveyor.reason_codes])
}

const decisionFor = (reasons: string[]): RevenueRepairSettlementCustodyDecision => {
  if (
    reasons.some((reason) =>
      [
        'active_no_delta_lease',
        'alpha_readiness_settlement_conveyor_stale',
        'business_state_repair',
        'business_state_ready',
        'business_state_revenue_ready',
        'business_state_live_ready',
        'capital_notional_nonzero',
        'capital_rule_not_zero_notional_repair_only',
        'revenue_repair_top_item_not_alpha_readiness',
      ].includes(reason),
    ) ||
    reasons.some(
      (reason) =>
        reason.startsWith('business_state_') &&
        reason !== 'business_state_repair_only' &&
        reason !== 'business_state_missing',
    )
  ) {
    return 'deny'
  }
  return reasons.length > 0 ? 'hold' : 'allow'
}

export const buildRevenueRepairSettlementCustody = (
  input: BuildRevenueRepairSettlementCustodyInput,
  mode: ReadyTruthArbiterMode = 'shadow',
): RevenueRepairSettlementCustody => {
  const conveyor = input.torghutConsumerEvidence.alpha_readiness_settlement_conveyor ?? null
  const stage = stageHealth(input)
  const rollout = rolloutProof(input)
  const reasonCodes = uniqueStrings([...conveyorReasons(input), ...stage.reasonCodes, ...rollout.reasonCodes]).map(
    (reason) => normalizeReason(reason) ?? reason,
  )
  const decision = decisionFor(reasonCodes)
  const noDeltaReleaseState =
    conveyor && ((conveyor.active_no_delta_lease_count ?? 0) > 0 || conveyor.repeat_launch_decision === 'deny')
      ? 'active'
      : conveyor?.no_delta_release_key
        ? 'clear'
        : 'missing'
  const evidenceRefs = uniqueStrings([
    input.torghutConsumerEvidence.receipt_id,
    conveyor?.conveyor_id,
    ...stage.evidenceRefs,
    ...rollout.evidenceRefs,
  ])
  const custodyId = `revenue-repair-settlement-custody:${input.namespace}:${hashJson({
    consumer_ref: input.torghutConsumerEvidence.receipt_id,
    conveyor_ref: conveyor?.conveyor_id ?? null,
    selected_value_gate: conveyor?.selected_value_gate ?? null,
    decision,
    reasonCodes,
  })}`

  return {
    schema_version: SCHEMA_VERSION,
    mode,
    custody_id: custodyId,
    generated_at: input.now.toISOString(),
    fresh_until: freshUntilFor(input),
    namespace: input.namespace,
    governing_design_refs: [
      REVENUE_REPAIR_SETTLEMENT_CUSTODY_DESIGN_ARTIFACT,
      'docs/torghut/design-system/v6/205-torghut-alpha-readiness-settlement-conveyor-and-routeable-profit-runway-2026-05-14.md',
      'swarm-validation-contract:every-run-cites-governing-requirement',
    ],
    torghut_consumer_evidence_ref: input.torghutConsumerEvidence.receipt_id,
    torghut_conveyor_ref: conveyor?.conveyor_id ?? null,
    selected_hypothesis_id: conveyor?.selected_hypothesis_id ?? null,
    selected_value_gate:
      conveyor?.selected_value_gate ?? topRepairQueueItem(input.torghutConsumerEvidence)?.value_gate ?? null,
    action_class: 'dispatch_repair',
    decision,
    reason_codes: reasonCodes,
    evidence_refs: evidenceRefs,
    stage_health: {
      stage_credit_ledger_ref: input.stageCreditLedger?.ledger_id ?? null,
      dispatch_repair_decision: stage.dispatchRepairDecision,
      retained_failure_debt_refs: input.stageCreditLedger?.retained_failure_debt_refs ?? [],
      reason_codes: stage.reasonCodes,
    },
    no_delta_release_key: conveyor?.no_delta_release_key ?? null,
    no_delta_release_state: noDeltaReleaseState,
    rollout_proof: {
      source_serving_verdict_ref: rollout.sourceServingVerdictRef,
      source_serving_decision: rollout.sourceDecision,
      rollout_health: input.rolloutHealth.status,
      reason_codes: rollout.reasonCodes,
    },
    validation_command:
      conveyor?.validation_command ??
      `curl -fsS ${input.torghutConsumerEvidence.endpoint} | jq '.alpha_readiness_settlement_conveyor'`,
    rollback_target: conveyor?.rollback_target ?? ROLLBACK_TARGET,
  }
}
