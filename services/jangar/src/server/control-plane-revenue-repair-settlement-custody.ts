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
} from '~/server/control-plane-status-types'
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

export const deriveRevenueRepairReadiness = (status: TorghutConsumerEvidenceStatus) => {
  const topItem = status.revenue_repair_queue?.[0] ?? null
  const businessState =
    status.revenue_repair_business_state ?? (topItem || status.max_notional === '0' ? 'repair_only' : null)
  let revenueReady = status.revenue_repair_ready ?? null
  if (revenueReady === null) {
    revenueReady = ['ready', 'revenue_ready', 'live_ready'].includes(businessState ?? '')
      ? true
      : ['repair_only', 'repair', 'hold'].includes(businessState ?? '')
        ? false
        : null
  }
  return { topRepairQueueItem: topItem, businessState, revenueReady }
}

const isTopAlphaRepair = (item: TorghutRevenueRepairQueueItem | null) => item?.code === 'repair_alpha_readiness'

type AlphaSettlementEvidence = {
  source: 'alpha_readiness_settlement_conveyor' | 'alpha_repair_closure_board' | 'executable_alpha_repair_receipt'
  ref: string | null
  freshUntil: string | null
  status: string | null
  selectedHypothesisId: string | null
  selectedValueGate: string | null
  validationCommand: string | null
  noDeltaReleaseKey: string | null
  noDeltaReleaseState: RevenueRepairSettlementCustody['no_delta_release_state']
  maxNotional: string | null
  capitalRule: string | null
  reasonCodes: string[]
  rollbackTarget: string | null
}

const closureBoardNoDeltaActive = (board: NonNullable<TorghutConsumerEvidenceStatus['alpha_repair_closure_board']>) => {
  const noDeltaState = normalizeReason(board.no_delta_budget_state)
  const marketStatus = normalizeReason(board.settlement_market_status)
  return (
    noDeltaState === 'consumed' ||
    marketStatus === 'pending_no_delta' ||
    marketStatus === 'no_delta' ||
    (board.no_delta_debt_count ?? 0) > 0
  )
}

const alphaSettlementEvidence = (status: TorghutConsumerEvidenceStatus): AlphaSettlementEvidence | null => {
  const conveyor = status.alpha_readiness_settlement_conveyor ?? null
  if (conveyor) {
    const noDeltaActive = (conveyor.active_no_delta_lease_count ?? 0) > 0 || conveyor.repeat_launch_decision === 'deny'
    return {
      source: 'alpha_readiness_settlement_conveyor',
      ref: conveyor.conveyor_id,
      freshUntil: conveyor.fresh_until,
      status: conveyor.status,
      selectedHypothesisId: conveyor.selected_hypothesis_id,
      selectedValueGate: conveyor.selected_value_gate,
      validationCommand: conveyor.validation_command,
      noDeltaReleaseKey: conveyor.no_delta_release_key,
      noDeltaReleaseState: noDeltaActive ? 'active' : conveyor.no_delta_release_key ? 'clear' : 'missing',
      maxNotional: conveyor.max_notional,
      capitalRule: conveyor.capital_rule,
      reasonCodes: conveyor.reason_codes,
      rollbackTarget: conveyor.rollback_target,
    }
  }

  const closureBoard = status.alpha_repair_closure_board ?? null
  if (closureBoard) {
    const noDeltaActive = closureBoardNoDeltaActive(closureBoard)
    const noDeltaState = normalizeReason(closureBoard.no_delta_budget_state)
    const marketStatus = normalizeReason(closureBoard.settlement_market_status)
    const releaseKey = closureBoard.active_dedupe_key ?? closureBoard.settlement_market_id ?? closureBoard.board_id
    return {
      source: 'alpha_repair_closure_board',
      ref: closureBoard.board_id,
      freshUntil: closureBoard.fresh_until,
      status: closureBoard.status,
      selectedHypothesisId: closureBoard.selected_hypothesis_id,
      selectedValueGate: closureBoard.selected_value_gate,
      validationCommand:
        closureBoard.validation_commands[0] ?? `curl -fsS ${status.endpoint} | jq '.alpha_repair_closure_board'`,
      noDeltaReleaseKey: noDeltaActive ? releaseKey : closureBoard.active_dedupe_key,
      noDeltaReleaseState: noDeltaActive ? 'active' : closureBoard.active_dedupe_key ? 'clear' : 'missing',
      maxNotional: closureBoard.max_notional,
      capitalRule: closureBoard.capital_rule,
      reasonCodes: uniqueStrings([
        ...closureBoard.reason_codes,
        noDeltaActive ? 'active_no_delta_lease' : null,
        noDeltaState === 'consumed' ? 'alpha_closure_no_delta_budget_consumed' : null,
        marketStatus === 'pending_no_delta' || marketStatus === 'no_delta'
          ? `alpha_closure_settlement_market_${marketStatus}`
          : null,
        (closureBoard.no_delta_debt_count ?? 0) > 0 ? 'alpha_closure_no_delta_debt_active' : null,
      ]),
      rollbackTarget: closureBoard.rollback_target,
    }
  }

  const executableReceipts = status.executable_alpha_repair_receipts ?? null
  const selectedReceipt = executableReceipts?.selected_receipt ?? null
  if (!executableReceipts && !selectedReceipt) return null
  return {
    source: 'executable_alpha_repair_receipt',
    ref: selectedReceipt?.receipt_id ?? executableReceipts?.selected_receipt_id ?? null,
    freshUntil: selectedReceipt?.fresh_until ?? executableReceipts?.fresh_until ?? null,
    status: executableReceipts?.status ?? null,
    selectedHypothesisId: selectedReceipt?.hypothesis_id ?? null,
    selectedValueGate: selectedReceipt?.target_value_gate ?? executableReceipts?.target_value_gate ?? null,
    validationCommand:
      selectedReceipt?.validation_commands[0] ??
      `curl -fsS ${status.endpoint} | jq '.executable_alpha_repair_receipts.selected_receipt'`,
    noDeltaReleaseKey: null,
    noDeltaReleaseState: 'missing',
    maxNotional: selectedReceipt?.max_notional ?? executableReceipts?.max_notional ?? null,
    capitalRule: selectedReceipt?.capital_rule ?? executableReceipts?.capital_rule ?? null,
    reasonCodes: [],
    rollbackTarget: selectedReceipt?.rollback_target ?? executableReceipts?.rollback_target ?? null,
  }
}

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
  const settlementEvidence = alphaSettlementEvidence(input.torghutConsumerEvidence)
  const times = [
    input.torghutConsumerEvidence.fresh_until,
    settlementEvidence?.freshUntil,
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
  const settlementEvidence = alphaSettlementEvidence(torghut)
  const topItem = topRepairQueueItem(torghut)
  const { businessState } = deriveRevenueRepairReadiness(torghut)
  const reasons: string[] = []

  if (torghut.status !== 'current') reasons.push(`torghut_consumer_evidence_${torghut.status}`)
  if (businessState !== 'repair_only') {
    reasons.push(`business_state_${businessState ?? 'missing'}`)
  }
  if (!topItem) {
    reasons.push('revenue_repair_top_item_missing')
  } else if (!isTopAlphaRepair(topItem)) {
    reasons.push('revenue_repair_top_item_not_alpha_readiness')
  }
  if (!settlementEvidence) {
    reasons.push('alpha_readiness_settlement_conveyor_missing')
    return uniqueStrings(reasons)
  }
  if (!settlementEvidence.ref) reasons.push(`${settlementEvidence.source}_ref_missing`)
  if (!isFresh(settlementEvidence.freshUntil, input.now)) reasons.push(`${settlementEvidence.source}_stale`)
  if (settlementEvidence.selectedValueGate !== 'routeable_candidate_count') {
    reasons.push(`selected_value_gate_${settlementEvidence.selectedValueGate ?? 'missing'}`)
  }
  if (!isZeroNotional(settlementEvidence.maxNotional)) reasons.push('capital_notional_nonzero')
  if (settlementEvidence.capitalRule && settlementEvidence.capitalRule !== 'zero_notional_repair_only') {
    reasons.push('capital_rule_not_zero_notional_repair_only')
  }
  if (settlementEvidence.noDeltaReleaseState === 'active') {
    reasons.push('active_no_delta_lease')
  }

  const conveyorStatus = settlementEvidence.status ?? 'missing'
  if (
    settlementEvidence.source === 'alpha_readiness_settlement_conveyor' &&
    CONVEYOR_HOLD_STATUSES.has(conveyorStatus)
  ) {
    reasons.push(`alpha_readiness_settlement_conveyor_${conveyorStatus}`)
  } else if (
    settlementEvidence.source === 'alpha_readiness_settlement_conveyor' &&
    !CONVEYOR_ALLOW_STATUSES.has(conveyorStatus)
  ) {
    reasons.push(`alpha_readiness_settlement_conveyor_${conveyorStatus}`)
  }

  return uniqueStrings([...reasons, ...settlementEvidence.reasonCodes])
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
  const settlementEvidence = alphaSettlementEvidence(input.torghutConsumerEvidence)
  const stage = stageHealth(input)
  const rollout = rolloutProof(input)
  const reasonCodes = uniqueStrings([...conveyorReasons(input), ...stage.reasonCodes, ...rollout.reasonCodes]).map(
    (reason) => normalizeReason(reason) ?? reason,
  )
  const decision = decisionFor(reasonCodes)
  const noDeltaReleaseState = settlementEvidence?.noDeltaReleaseState ?? 'missing'
  const evidenceRefs = uniqueStrings([
    input.torghutConsumerEvidence.receipt_id,
    settlementEvidence?.ref,
    ...stage.evidenceRefs,
    ...rollout.evidenceRefs,
  ])
  const custodyId = `revenue-repair-settlement-custody:${input.namespace}:${hashJson({
    consumer_ref: input.torghutConsumerEvidence.receipt_id,
    alpha_settlement_ref: settlementEvidence?.ref ?? null,
    selected_value_gate: settlementEvidence?.selectedValueGate ?? null,
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
      'docs/agents/designs/206-jangar-material-evidence-settlement-spine-and-repair-dispatch-budget-2026-05-14.md',
      'swarm-validation-contract:every-run-cites-governing-requirement',
    ],
    torghut_consumer_evidence_ref: input.torghutConsumerEvidence.receipt_id,
    torghut_conveyor_ref: settlementEvidence?.ref ?? null,
    selected_hypothesis_id: settlementEvidence?.selectedHypothesisId ?? null,
    selected_value_gate:
      settlementEvidence?.selectedValueGate ?? topRepairQueueItem(input.torghutConsumerEvidence)?.value_gate ?? null,
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
    no_delta_release_key: settlementEvidence?.noDeltaReleaseKey ?? null,
    no_delta_release_state: noDeltaReleaseState,
    rollout_proof: {
      source_serving_verdict_ref: rollout.sourceServingVerdictRef,
      source_serving_decision: rollout.sourceDecision,
      rollout_health: input.rolloutHealth.status,
      reason_codes: rollout.reasonCodes,
    },
    validation_command:
      settlementEvidence?.validationCommand ??
      `curl -fsS ${input.torghutConsumerEvidence.endpoint} | jq '.alpha_readiness_settlement_conveyor'`,
    rollback_target: settlementEvidence?.rollbackTarget ?? ROLLBACK_TARGET,
  }
}
